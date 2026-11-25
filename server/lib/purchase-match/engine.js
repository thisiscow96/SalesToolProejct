'use strict';
/**
 * T-203 매입서 대조 엔진 (설계 3.1~3.5) — engine_version 'm1'
 *
 * matchLines(client, cx, { lineIds, trigger, autoConvert })  — 바깥 트랜잭션(client) 안에서 부른다
 *  1. 줄 잠금(FOR UPDATE, id 순) — CONVERTED 줄은 건너뜀(skipped)
 *  2. 줄마다 허용오차 고르기: (회원,품목) → (회원,품목군) → (회원,전체) → (기본,품목) → (기본,품목군) → (기본,전체)
 *  3. 후보 찾기 — 줄 전체를 한 SQL 로. 비교값(단가 차 %·kg 단가·수량 차·금액 차·날짜 차)은 SQL NUMERIC 으로 계산
 *  4. 점수·판정(score.js) + 같은 매입서 안 결정적 배정 → 후보 0 이면 사유(진단 SQL 한 번)
 *  5. 줄 상태: EXACT+전환 가능+자동 → 같은 트랜잭션에서 매입전환 / EXACT 그 밖 → PENDING(사유) / PARTIAL·UNMATCHED → HOLD
 *  6. 후보 상위 5건·실행 기록(tolerance_snapshot)·이력(purchase_match_event)·헤더 재계산
 */
const { ENGINE_VERSION, scoreCandidate, assignWithinDoc } = require('./score');
const N = require('./normalize');

const TOL_FIELDS = ['price_pct_auto', 'price_pct_review', 'qty_pct_auto', 'qty_pct_review', 'amount_abs_auto', 'date_before_auto', 'date_after_auto',
  'date_before_review', 'date_after_review', 'auto_convert', 'auto_min_score', 'ambiguity_margin'];

// 목업 경락으로 자동 전환 — 테스트 DB 전용. 운영(NODE_ENV=production)에서는 값이 있어도 끈다
const allowMockConvert = (env = process.env) => env.NODE_ENV !== 'production' && String(env.ALLOW_MOCK_CONVERT || '').toLowerCase() === 'true';

async function loadTolerances(db, userId) {
  const r = await db.query(`SELECT * FROM match_tolerance WHERE user_id IS NULL OR user_id = $1`, [userId]);
  return r.rows;
}
/** 허용오차 한 행 고르기 */
function pickTolerance(rows, userId, itemKey) {
  const fam = N.familyOf(itemKey);
  const order = [
    (r) => r.user_id === userId && r.item_key && r.item_key === itemKey,
    (r) => r.user_id === userId && r.item_family && r.item_family === fam,
    (r) => r.user_id === userId && !r.item_key && !r.item_family,
    (r) => r.user_id == null && r.item_key && r.item_key === itemKey,
    (r) => r.user_id == null && r.item_family && r.item_family === fam,
    (r) => r.user_id == null && !r.item_key && !r.item_family,
  ];
  for (const f of order) {
    const hit = rows.find(f);
    if (hit) return hit;
  }
  return { id: null, price_pct_auto: 0, price_pct_review: 10, qty_pct_auto: 0, qty_pct_review: 20, amount_abs_auto: 0, date_before_auto: 1, date_after_auto: 0,
    date_before_review: 3, date_after_review: 1, auto_convert: true, auto_min_score: 85, ambiguity_margin: 10 };
}
const tolView = (t) => ({ id: t.id, scope: t.item_key ? { item_key: t.item_key } : t.item_family ? { item_family: t.item_family } : 'ALL', is_default: t.user_id == null,
  ...Object.fromEntries(TOL_FIELDS.map((k) => [k, typeof t[k] === 'boolean' ? t[k] : Number(t[k])])) });

/** 판매툴 품목 연결(등급 행 우선 → 등급 NULL 행) */
async function resolveProductLinks(db, userId) {
  const r = await db.query(
    `SELECT l.item_key, l.grade_norm, l.product_id, p.unit FROM market_product_link l JOIN product p ON p.id = l.product_id
      WHERE l.user_id = $1 AND (p.owner_user_id IS NULL OR p.owner_user_id = $1) AND NOT p.is_system`,
    [userId]
  );
  return (itemKey, grade) => {
    if (!itemKey) return null;
    return r.rows.find((x) => x.item_key === itemKey && x.grade_norm && x.grade_norm === grade)
      || r.rows.find((x) => x.item_key === itemKey && x.grade_norm == null) || null;
  };
}

const CAND_SQL = `
WITH tol AS (
  SELECT * FROM unnest($2::bigint[], $3::int[], $4::int[]) AS x(line_id, db, da)
)
SELECT l.id AS line_id, t.id AS trade_id, t.source, t.trade_date, t.auction_at, t.corp_code, t.corp_name, t.item_key, t.item_name_raw, t.grade_norm,
       t.pkg_norm, t.pkg_name, t.unit_qty_kg, t.qty, t.unit_price, t.amount, t.price_per_kg, t.origin_name, t.buyer_code, t.auction_seq, t.market_code, t.revision,
       (t.trade_date - l.trade_date)::int AS date_diff,
       (t.item_key = l.item_key) AS same_item,
       (right(t.item_key, 2) = '._' OR right(l.item_key, 2) = '._') AS variety_unknown_one,
       (l.grade_norm IS NOT NULL AND t.grade_norm = l.grade_norm) AS same_grade,
       (l.grade_norm IS NULL AND t.grade_norm IS NULL) AS grade_both_null,
       ((l.grade_norm IS NULL) <> (t.grade_norm IS NULL)) AS grade_one_null,
       (l.unit_qty_kg IS NOT NULL AND t.unit_qty_kg IS NOT NULL) AS kg_known_both,
       COALESCE(l.unit_qty_kg = t.unit_qty_kg, false) AS same_kg,
       (l.pkg_norm IS NOT DISTINCT FROM t.pkg_norm) AS same_pkg,
       CASE WHEN l.auction_ref IS NOT NULL AND t.auction_seq = l.auction_ref THEN 'AUCTION'
            WHEN COALESCE(l.buyer_code, $5) IS NOT NULL AND t.buyer_code = COALESCE(l.buyer_code, $5) THEN 'BUYER' END AS ident,
       (d.corp_code IS NOT NULL AND t.corp_code = d.corp_code) AS corp_same,
       COALESCE(CASE WHEN l.unit_qty_kg IS NOT NULL AND t.unit_qty_kg IS NOT NULL AND l.unit_qty_kg <> t.unit_qty_kg
            THEN ROUND(ABS(l.unit_price::numeric / l.unit_qty_kg - t.unit_price::numeric / t.unit_qty_kg) * 100 / NULLIF(t.unit_price::numeric / t.unit_qty_kg, 0), 2)
            ELSE ROUND(ABS(l.unit_price - t.unit_price)::numeric * 100 / NULLIF(t.unit_price, 0)::numeric, 2) END, 100) AS price_diff_pct,
       COALESCE(CASE WHEN l.unit_qty_kg IS NOT NULL AND t.unit_qty_kg IS NOT NULL AND l.unit_qty_kg <> t.unit_qty_kg
            THEN ROUND(ABS(l.qty * l.unit_qty_kg - t.qty * t.unit_qty_kg) * 100 / NULLIF(t.qty * t.unit_qty_kg, 0), 2)
            ELSE ROUND(ABS(l.qty - t.qty) * 100 / NULLIF(t.qty, 0), 2) END, 100) AS qty_diff_pct,
       sign(CASE WHEN l.unit_qty_kg IS NOT NULL AND t.unit_qty_kg IS NOT NULL AND l.unit_qty_kg <> t.unit_qty_kg
            THEN l.qty * l.unit_qty_kg - t.qty * t.unit_qty_kg ELSE l.qty - t.qty END)::int AS qty_cmp,
       CASE WHEN t.unit_qty_kg IS NULL THEN NULL ELSE ROUND(t.unit_price::numeric / t.unit_qty_kg, 2) END AS trade_price_per_kg,
       CASE WHEN l.unit_qty_kg IS NULL THEN NULL ELSE ROUND(l.unit_price::numeric / l.unit_qty_kg, 2) END AS line_price_per_kg,
       (l.unit_price - t.unit_price) AS price_diff,
       (l.qty - t.qty) AS qty_diff,
       (l.amount - t.amount) AS amount_diff,
       EXISTS (SELECT 1 FROM collect_snapshot s WHERE s.source = 'AT_REALTIME' AND s.market_code = t.market_code AND s.trade_date = t.trade_date
                  AND s.phase = 'FINAL' AND s.status = 'COMPLETE' AND s.is_latest_ok) AS base_final
  FROM purchase_doc_line l
  JOIN purchase_doc d ON d.id = l.doc_id
  JOIN tol ON tol.line_id = l.id
  JOIN auction_trade t
    ON t.trade_date BETWEEN l.trade_date - tol.db AND l.trade_date + tol.da
   AND t.withdrawn_at IS NULL AND t.map_status = 'MAPPED'
   AND split_part(t.item_key, '.', 1) = split_part(l.item_key, '.', 1)
   AND (t.item_key = l.item_key OR right(t.item_key, 2) = '._' OR right(l.item_key, 2) = '._')
   AND (l.auction_ref IS NULL OR t.auction_seq IS NULL OR t.auction_seq = l.auction_ref)
   AND (COALESCE(l.buyer_code, $5) IS NULL OR t.buyer_code IS NULL OR t.buyer_code = COALESCE(l.buyer_code, $5))
   AND (d.corp_code IS NULL OR t.corp_code IS NULL OR t.corp_code = d.corp_code)
 WHERE l.user_id = $1 AND l.id = ANY($2::bigint[]) AND l.item_key IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.user_id = $1 AND c.trade_id = t.id AND c.status = 'ACTIVE' AND c.line_id <> l.id)
 ORDER BY l.id, t.id`;

/** 후보가 0 인 줄의 사유 — 같은 날짜 범위에서 조건을 하나씩 더해 어디서 0 이 되는지 */
const DIAG_SQL = `
WITH tol AS (SELECT * FROM unnest($2::bigint[], $3::int[], $4::int[]) AS x(line_id, db, da))
SELECT l.id AS line_id,
       bool_or(t.item_key = l.item_key OR right(t.item_key, 2) = '._' OR right(l.item_key, 2) = '._') AS any_variety,
       bool_or((t.item_key = l.item_key OR right(t.item_key, 2) = '._' OR right(l.item_key, 2) = '._')
               AND (d.corp_code IS NULL OR t.corp_code IS NULL OR t.corp_code = d.corp_code)) AS any_corp,
       bool_or((t.item_key = l.item_key OR right(t.item_key, 2) = '._' OR right(l.item_key, 2) = '._')
               AND (d.corp_code IS NULL OR t.corp_code IS NULL OR t.corp_code = d.corp_code)
               AND (l.auction_ref IS NULL OR t.auction_seq IS NULL OR t.auction_seq = l.auction_ref)
               AND (COALESCE(l.buyer_code, $5) IS NULL OR t.buyer_code IS NULL OR t.buyer_code = COALESCE(l.buyer_code, $5))) AS any_ident
  FROM purchase_doc_line l
  JOIN purchase_doc d ON d.id = l.doc_id
  JOIN tol ON tol.line_id = l.id
  JOIN auction_trade t ON t.trade_date BETWEEN l.trade_date - tol.db AND l.trade_date + tol.da
   AND t.withdrawn_at IS NULL AND t.map_status = 'MAPPED' AND split_part(t.item_key, '.', 1) = split_part(l.item_key, '.', 1)
 WHERE l.user_id = $1 AND l.id = ANY($2::bigint[])
 GROUP BY l.id`;

const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** 기준 데이터 준비 상태 — 줄의 자동 날짜 범위(오늘까지)에 정상 스냅샷이 없는 날이 있으면 BASE_NOT_READY, 정상이 EMPTY 뿐이면 NO_BASE_DATA */
async function baseReadiness(db, lines, tolOf, market) {
  const need = new Set();
  const today = kstToday();
  for (const l of lines) {
    const t = tolOf(l);
    for (let i = -Number(t.date_before_auto); i <= Number(t.date_after_auto); i += 1) {
      const d = addDays(l.trade_date, i);
      if (d <= today) need.add(d);
    }
  }
  if (!need.size) return () => 'BASE_NOT_READY';
  const r = await db.query(
    `SELECT trade_date, status FROM collect_snapshot WHERE source = 'AT_REALTIME' AND market_code = $1 AND trade_date = ANY($2::date[]) AND is_latest_ok`,
    [market, [...need]]
  );
  const ok = new Map(r.rows.map((x) => [x.trade_date, x.status]));
  return (l) => {
    const t = tolOf(l);
    const days = [];
    for (let i = -Number(t.date_before_auto); i <= Number(t.date_after_auto); i += 1) {
      const d = addDays(l.trade_date, i);
      if (d <= today) days.push(d);
    }
    // 자동 범위 안에 정상 수집(COMPLETE)이 있는 날이 있으면 기준 데이터는 있다 → 사유는 다른 데서
    if (days.some((d) => ok.get(d) === 'COMPLETE')) return null;
    // 거래일 자체를 아직 못 받았으면(또는 범위 전부 없음) 기준 데이터 준비 전
    if (!days.length || !ok.has(l.trade_date) || days.every((d) => !ok.has(d))) return 'BASE_NOT_READY';
    // 거래일은 받았는데 비었거나 휴장 — 원인 모를 빈 데이터(경락 없음과 구분)
    return 'NO_BASE_DATA';
  };
}

/**
 * 매입 한 건으로 옮길 수량·단가 계획 (설계 3.6 단위 환산) — SQL NUMERIC
 * @returns { quantity, unit_price, total, amount_diff, ok, reason }
 */
async function planPurchase(db, line, product, tol) {
  const W = N.productUnitKg(product && product.unit);
  const kg = line.unit_qty_kg == null ? null : String(line.unit_qty_kg);
  const r = await db.query(
    `WITH x AS (SELECT $1::numeric AS q, $2::numeric AS p, $3::numeric AS kg, $4::numeric AS w, $5::numeric AS amt)
     SELECT CASE WHEN w IS NULL OR kg IS NULL OR w = kg THEN q ELSE ROUND(q * kg / w, 3) END AS quantity,
            CASE WHEN w IS NULL OR kg IS NULL OR w = kg THEN ROUND(p, 2) ELSE ROUND(p * w / kg, 2) END AS unit_price,
            CASE WHEN w IS NULL OR kg IS NULL OR w = kg THEN true ELSE (q * kg / w) = ROUND(q * kg / w, 3) END AS qty_exact
       FROM x`,
    [String(line.qty), String(line.unit_price), kg, W, String(line.amount)]
  );
  const p = r.rows[0];
  const t = await db.query(`SELECT ROUND($1::numeric * $2::numeric, 2) AS total, (ROUND($1::numeric * $2::numeric, 2) - $3::numeric) AS diff, ABS(ROUND($1::numeric * $2::numeric, 2) - $3::numeric) <= $4::numeric AS within`,
    [p.quantity, p.unit_price, String(line.amount), String(tol ? tol.amount_abs_auto : 0)]);
  let reason = null;
  if (W && !kg) reason = 'WEIGHT_UNKNOWN';
  else if (!p.qty_exact) reason = 'UNIT_ROUNDING';
  else if (!t.rows[0].within) reason = W && kg && W !== kg ? 'UNIT_ROUNDING' : 'AMOUNT_CALC_DIFF';
  return { quantity: p.quantity, unit_price: p.unit_price, total: t.rows[0].total, amount_diff: t.rows[0].diff, ok: !reason, reason, unit_kg: W, line_kg: kg };
}

/**
 * 줄 행 + 매입서 헤더 읽기(잠금)
 *   잠금 순서(I 검토 D-01·D-02, 028 트리거와 같음): 회원 advisory(부르는 쪽) → 매입서 FOR UPDATE(id 순) → 줄 FOR UPDATE(id 순)
 *   doc_status 는 매입서를 잠근 뒤 읽은 값이라 R-131 매입서 취소와 엇갈리지 않는다.
 */
async function lockLines(client, userId, lineIds) {
  await client.query(
    `SELECT id FROM purchase_doc
      WHERE user_id = $1 AND id IN (SELECT doc_id FROM purchase_doc_line WHERE user_id = $1 AND id = ANY($2::bigint[]))
      ORDER BY id FOR UPDATE`,
    [userId, lineIds]
  );
  const r = await client.query(
    `SELECT l.*, d.corp_code AS doc_corp_code, d.supplier_partner_id, d.status AS doc_status, d.doc_no
       FROM purchase_doc_line l JOIN purchase_doc d ON d.id = l.doc_id AND d.user_id = l.user_id
      WHERE l.user_id = $1 AND l.id = ANY($2::bigint[]) ORDER BY l.id FOR UPDATE OF l`,
    [userId, lineIds]
  );
  return r.rows;
}

/**
 * 대조 실행
 * @param cx { userId, staffId, actorKind:'OWNER'|'STAFF'|'SYSTEM', agentNo, convertCtx }   convertCtx = convert.js 가 매입 등록에 쓰는 문맥
 * @param opts { lineIds, trigger, autoConvert, statuses, eventType }
 * @returns { runIds, lines:[{ id, doc_id, line_no, status, match_result, score, reason_codes, warning_flags, candidate_count, purchase_id, conversion_id, best_trade_id }], skipped:[], summary }
 */
async function matchLines(client, cx, opts) {
  const { userId } = cx;
  const statuses = opts.statuses || ['PENDING', 'HOLD', 'CANCELLED', 'REJECTED'];
  const all = await lockLines(client, userId, opts.lineIds);
  const skipped = all.filter((l) => !statuses.includes(l.status) || l.doc_status === 'CANCELLED').map((l) => ({ id: Number(l.id), status: l.status, reason: l.doc_status === 'CANCELLED' ? 'DOC_CANCELLED' : l.status === 'CONVERTED' ? 'LINE_CONVERTED' : 'NOT_MATCHABLE' }));
  const lines = all.filter((l) => statuses.includes(l.status) && l.doc_status !== 'CANCELLED');
  const summary = { exact: 0, partial: 0, unmatched: 0, auto_converted: 0 };
  if (!lines.length) return { runIds: [], lines: [], skipped, summary };

  const tolRows = await loadTolerances(client, userId);
  const tolOf = (l) => pickTolerance(tolRows, userId, l.item_key);
  const productOf = await resolveProductLinks(client, userId);
  const agent = await client.query(`SELECT agent_no FROM "user" WHERE id = $1`, [userId]);
  const buyer = cx.useAgentNo === false ? null : (agent.rows[0] && agent.rows[0].agent_no ? String(agent.rows[0].agent_no).trim() || null : null);
  const market = process.env.AUCTION_MARKET_CODE || '110001';

  // 다른 매입서에 같은 줄(지문)
  const fp = await client.query(
    `SELECT l.id, EXISTS (SELECT 1 FROM purchase_doc_line o JOIN purchase_doc od ON od.id = o.doc_id
                           WHERE o.user_id = l.user_id AND o.line_fingerprint = l.line_fingerprint AND o.doc_id <> l.doc_id AND od.status <> 'CANCELLED'
                             AND o.status <> 'REJECTED') AS dup
       FROM purchase_doc_line l WHERE l.id = ANY($1::bigint[])`,
    [lines.map((l) => l.id)]
  );
  const dupOf = new Map(fp.rows.map((x) => [String(x.id), x.dup]));

  const ids = lines.map((l) => l.id);
  const dbs = lines.map((l) => Number(tolOf(l).date_before_review));
  const das = lines.map((l) => Number(tolOf(l).date_after_review));
  const cand = await client.query(CAND_SQL, [userId, ids, dbs, das, buyer]);
  const byLine = new Map();
  for (const c of cand.rows) {
    const k = String(c.line_id);
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(c);
  }

  // 점수
  const scoredByLine = new Map();
  for (const l of lines) {
    const tol = tolOf(l);
    const lineCtx = { amount_calc_diff: l.amount_calc_diff, dup_other_doc: dupOf.get(String(l.id)), doc_corp_null: !l.doc_corp_code };
    const list = (byLine.get(String(l.id)) || []).map((c) => ({ ...c, ...scoreCandidate(c, lineCtx, tol) }));
    scoredByLine.set(String(l.id), list);
  }
  // 같은 매입서 안 배정
  const decisions = new Map();
  const byDoc = new Map();
  for (const l of lines) {
    const k = String(l.doc_id);
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k).push(l);
  }
  for (const [, group] of byDoc) {
    const tol = tolOf(group[0]);
    // 줄마다 허용오차가 다를 수 있으나 배정 순서는 점수로만 정한다 — 판정은 줄 자기 허용오차로 다시
    const assigned = assignWithinDoc(group.map((l) => ({ line_id: l.id, line_no: l.line_no, scored: scoredByLine.get(String(l.id)) })), tol);
    for (const l of group) decisions.set(String(l.id), assigned.get(String(l.id)));
  }

  // 후보 0 줄의 사유
  const zero = lines.filter((l) => l.item_key && !(scoredByLine.get(String(l.id)) || []).length);
  let diag = new Map();
  if (zero.length) {
    const d = await client.query(DIAG_SQL, [userId, zero.map((l) => l.id), zero.map((l) => Number(tolOf(l).date_before_review)), zero.map((l) => Number(tolOf(l).date_after_review)), buyer]);
    diag = new Map(d.rows.map((x) => [String(x.line_id), x]));
  }
  const readiness = await baseReadiness(client, lines.filter((l) => l.item_key), tolOf, market);

  // 실행 기록 — 매입서마다 한 건
  const runOf = new Map();
  for (const [docId, group] of byDoc) {
    const used = new Map();
    for (const l of group) { const t = tolOf(l); used.set(String(t.id), tolView(t)); }
    // eslint-disable-next-line no-await-in-loop
    const run = await client.query(
      `INSERT INTO purchase_match_run (user_id, doc_id, trigger, engine_version, tolerance_snapshot, line_count, actor_staff_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING id`,
      [userId, docId, opts.trigger, ENGINE_VERSION, JSON.stringify({ tolerances: [...used.values()], line_tolerance: Object.fromEntries(group.map((l) => [String(l.id), tolOf(l).id])) }),
        group.length, cx.staffId || null]
    );
    runOf.set(docId, Number(run.rows[0].id));
  }

  const convert = require('./convert'); // eslint-disable-line global-require
  const out = [];
  for (const l of lines) {
    const tol = tolOf(l);
    const runId = runOf.get(String(l.doc_id));
    const d = decisions.get(String(l.id)) || { result: 'UNMATCHED', score: null, best: null, reasons: [], ranked: [] };
    const reasons = [...d.reasons];
    const warnings = new Set((l.warning_flags || []).filter((w) => ['BASE_REVISED'].includes(w)));
    if (d.taken) warnings.add('CANDIDATE_TAKEN');
    if (Number(l.amount_calc_diff) !== 0) warnings.add('AMOUNT_CALC_DIFF');
    if (dupOf.get(String(l.id))) warnings.add('DUP_LINE_OTHER_DOC');
    if (!l.grade_norm && l.grade_raw) warnings.add('GRADE_UNKNOWN');
    if (l.weight_source === 'UNKNOWN') warnings.add('WEIGHT_UNKNOWN');
    let result = d.result;
    if (!l.item_key) { result = 'UNMATCHED'; reasons.splice(0, reasons.length, 'ITEM_UNMAPPED'); }
    else if (!d.ranked.length) {
      result = 'UNMATCHED';
      const base = readiness(l);
      const g = diag.get(String(l.id));
      let why;
      if (d.taken) why = 'ALL_CANDIDATES_TAKEN';
      else if (!g) why = base || 'NO_TRADE_IN_DATE_RANGE';
      else if (!g.any_variety) why = 'NO_TRADE_SAME_VARIETY';
      else if (!g.any_corp) why = 'CORP_MISMATCH';
      else if (!g.any_ident) why = 'BUYER_MISMATCH';
      else why = 'ALL_CANDIDATES_TAKEN';
      reasons.splice(0, reasons.length, why);
    }
    for (const f of (d.best && d.best.flags) || []) if (['UNIT_CONVERTED', 'PRICE_OUT', 'QTY_OUT', 'QTY_PARTIAL', 'GRADE_DIFF'].includes(f)) warnings.add(f);
    // 품목 연결
    let productId = l.product_id;
    let product = null;
    if (productId) {
      // eslint-disable-next-line no-await-in-loop
      const p = await client.query(`SELECT id, unit FROM product WHERE id = $1`, [productId]);
      product = p.rows[0] || null;
    } else {
      const link = productOf(l.item_key, l.grade_norm);
      if (link) { productId = link.product_id; product = { id: link.product_id, unit: link.unit }; }
    }
    let status;
    let conv = null;
    let convertible = false;
    if (result === 'EXACT') {
      const blockers = [];
      if (!productId) blockers.push('NO_PRODUCT_LINK');
      if (!d.best.base_final) blockers.push('BASE_NOT_FINAL');
      if (d.best.source === 'MOCK' && !allowMockConvert()) blockers.push('MOCK_SOURCE');
      let plan = null;
      if (productId) {
        // eslint-disable-next-line no-await-in-loop
        plan = await planPurchase(client, l, product, tol);
        if (!plan.ok) blockers.push(plan.reason);
      }
      if (blockers.length) { status = 'PENDING'; reasons.push(...blockers); }
      else if (opts.autoConvert !== false && tol.auto_convert && opts.autoConvert) {
        status = 'PENDING';
        convertible = true;
        conv = { plan, productId };
      } else { status = 'PENDING'; convertible = true; }
    } else status = 'HOLD';
    if (result === 'EXACT') summary.exact += 1; else if (result === 'PARTIAL') summary.partial += 1; else summary.unmatched += 1;

    // 줄 갱신(대조 결과)
    // eslint-disable-next-line no-await-in-loop
    const up = await client.query(
      `UPDATE purchase_doc_line SET status = $2, match_result = $3, match_score = $4, best_trade_id = $5, candidate_count = $6,
              reason_codes = $7::text[], warning_flags = $8::text[], last_run_id = $9, matched_at = NOW(),
              product_id = COALESCE(product_id, $10), rejected_at = NULL, reject_reason = CASE WHEN status = 'REJECTED' THEN NULL ELSE reject_reason END,
              version = version + 1, updated_at = NOW()
        WHERE id = $1 RETURNING version`,
      [l.id, status, result, d.score, d.best ? d.best.trade_id : null, d.ranked.length, reasons, [...warnings], runId, opts.persistProduct === false ? null : productId]
    );
    l.version = up.rows[0].version;
    // 후보 상위 5
    const top = d.ranked.slice(0, 5);
    for (let i = 0; i < top.length; i += 1) {
      const c = top[i];
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO purchase_match_candidate (run_id, user_id, line_id, trade_id, rank, score, strict_pass, breakdown, price_diff, price_diff_pct, qty_diff, amount_diff, date_diff, flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::text[]) ON CONFLICT (run_id, line_id, trade_id) DO NOTHING`,
        [runId, userId, l.id, c.trade_id, i + 1, c.score, c.strict, JSON.stringify({ ...c.breakdown, ident: c.ident || null, base_final: c.base_final, source: c.source }),
          c.price_diff, c.price_diff_pct, c.qty_diff, c.amount_diff, c.date_diff, c.flags]
      );
    }
    // eslint-disable-next-line no-await-in-loop
    await client.query(
      `INSERT INTO purchase_match_event (user_id, doc_id, line_id, event_type, from_status, to_status, match_result, score, trade_id, run_id, reason, detail, actor_kind, actor_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`,
      [userId, l.doc_id, l.id, opts.eventType || (opts.trigger === 'UPLOAD' ? 'MATCH' : 'REMATCH'), l.status, status, result, d.score, d.best ? d.best.trade_id : null, runId,
        reasons.join(',').slice(0, 200) || null,
        JSON.stringify({ engine_version: ENGINE_VERSION, tolerance: tolView(tol), flags: d.best ? d.best.flags : [], warnings: [...warnings],
          candidates_top3: d.ranked.slice(0, 3).map((c) => ({ trade_id: Number(c.trade_id), score: c.score, strict: c.strict })) }),
        cx.actorKind, cx.actorKind === 'STAFF' ? cx.staffId : null]
    );
    const row = { id: Number(l.id), doc_id: Number(l.doc_id), line_no: l.line_no, status, match_result: result, score: d.score, reason_codes: reasons, warning_flags: [...warnings],
      candidate_count: d.ranked.length, best_trade_id: d.best ? Number(d.best.trade_id) : null, convertible };
    if (conv) {
      // eslint-disable-next-line no-await-in-loop
      const r = await convert.convertOne(client, cx, {
        line: { ...l, product_id: productId, status: 'PENDING', match_result: result, match_score: d.score }, trade: d.best, mode: 'AUTO', plan: conv.plan, tol,
        eventType: 'AUTO_CONVERT', diff: diffOf(l, d.best),
      });
      if (r.result === 'CONVERTED') {
        summary.auto_converted += 1;
        Object.assign(row, { status: 'CONVERTED', purchase_id: r.purchase_id, conversion_id: r.conversion_id, convertible: false });
      } else {
        row.convert_error = { code: r.code || r.result, message: r.message };
        // eslint-disable-next-line no-await-in-loop
        await client.query(`UPDATE purchase_doc_line SET reason_codes = array_append(reason_codes, $2) WHERE id = $1`, [l.id, r.code || r.result]);
        row.reason_codes = [...reasons, r.code || r.result];
        row.convertible = false;
      }
    }
    out.push(row);
  }
  const docIds = [...byDoc.keys()];
  for (const docId of docIds) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(`SELECT purchase_doc_recalc($1)`, [docId]);
    // eslint-disable-next-line no-await-in-loop
    const s = await client.query(
      `UPDATE purchase_match_run SET exact_count = $2, partial_count = $3, unmatched_count = $4, auto_converted = $5, finished_at = NOW() WHERE id = $1`,
      [runOf.get(docId), out.filter((x) => String(x.doc_id) === docId && x.match_result === 'EXACT').length,
        out.filter((x) => String(x.doc_id) === docId && x.match_result === 'PARTIAL').length,
        out.filter((x) => String(x.doc_id) === docId && x.match_result === 'UNMATCHED').length,
        out.filter((x) => String(x.doc_id) === docId && x.status === 'CONVERTED').length]
    );
    void s;
  }
  return { runIds: [...runOf.values()], lines: out, skipped, summary };
}

/** 매입서 줄 ↔ 경락 건 차이(화면·이력용) */
function diffOf(line, trade) {
  if (!trade) return null;
  return {
    price: Number(trade.price_diff), price_pct: trade.price_diff_pct != null ? String(trade.price_diff_pct) : null,
    qty: trade.qty_diff != null ? String(trade.qty_diff) : null, amount: trade.amount_diff != null ? String(trade.amount_diff) : null, date: trade.date_diff,
  };
}

/** 한 경락 건이 그 줄에 대해 지금 strict 인지 다시 계산(수동 확정) — 같은 SQL 로 그 건 하나만 */
async function evaluatePair(client, cx, line, tradeId) {
  const tolRows = await loadTolerances(client, cx.userId);
  const tol = pickTolerance(tolRows, cx.userId, line.item_key);
  const agent = await client.query(`SELECT agent_no FROM "user" WHERE id = $1`, [cx.userId]);
  const buyer = agent.rows[0] && agent.rows[0].agent_no ? String(agent.rows[0].agent_no).trim() || null : null;
  const r = await client.query(CAND_SQL, [cx.userId, [line.id], [Number(tol.date_before_review)], [Number(tol.date_after_review)], buyer]);
  const c = r.rows.find((x) => String(x.trade_id) === String(tradeId));
  const fp = await client.query(
    `SELECT EXISTS (SELECT 1 FROM purchase_doc_line o JOIN purchase_doc od ON od.id = o.doc_id WHERE o.user_id = $1 AND o.line_fingerprint = $2 AND o.doc_id <> $3
                     AND od.status <> 'CANCELLED' AND o.status <> 'REJECTED') AS dup`,
    [cx.userId, line.line_fingerprint, line.doc_id]
  );
  if (!c) return { tol, candidate: null };
  const s = scoreCandidate(c, { amount_calc_diff: line.amount_calc_diff, dup_other_doc: fp.rows[0].dup, doc_corp_null: !line.doc_corp_code }, tol);
  return { tol, candidate: { ...c, ...s } };
}

module.exports = { matchLines, pickTolerance, loadTolerances, planPurchase, lockLines, evaluatePair, diffOf, tolView, resolveProductLinks, ENGINE_VERSION };
