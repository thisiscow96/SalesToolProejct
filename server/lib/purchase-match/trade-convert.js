'use strict';
/**
 * T-203 경락 조회 → 매입 전환 (A 설계 3절 · R-138 미리보기 · R-139 전환)
 *
 * 경로: 기존 매입서 대조 전환을 재사용한다(PM 결정 16:18, A안).
 *   체크한 경락 건을 (거래처, 경락일)별 매입서 1건(input_kind='AUCTION', 업로드 없음)으로 묶어 줄을 만들고,
 *   같은 트랜잭션에서 convert.convertOne(mode='MANUAL', eventType='CONVERT_FROM_TRADE')으로 매입을 등록한다.
 *   → 매입 등록 규칙·재고 FIFO·직원 권한·created_by_staff_id 는 기존 POST /api/purchases 그대로,
 *     취소는 기존 R-36(매입 취소, 028 트리거가 전환·줄·매입서를 맞춤) / R-130(줄 전환 취소) 그대로.
 * 이중 전환 0:
 *   ① Idempotency-Key(R-139 필수)  ② 회원 advisory lock 'purchase-doc-convert:'+user (매입서 전환과 같은 잠금 → 두 경로가 줄 서서 실행)
 *   ③ 잠근 뒤 활성 전환 재확인  ④ DB ux_pdc_trade_active (user_id, trade_id) WHERE ACTIVE
 * 경락 행은 잠그지 않는다(공용 표 — 수집기 upsert 를 막지 않게, I 검토 4.5). 전환 때 본 revision 을 이벤트 detail 에 남긴다.
 * 건별 결과: 건마다 SAVEPOINT — 실패 건은 매입서·줄·매입을 하나도 남기지 않는다.
 */
const engine = require('./engine');
const convert = require('./convert');
const N = require('./normalize');

const MAX_TRADES = convert.MAX_BATCH; // 200 — 쪽당 최대 건수와 같음

const MSG = {
  NOT_FOUND: '경락 건을 찾을 수 없습니다.',
  WITHDRAWN: '철회된 경락 건은 매입 등록하지 않습니다.',
  UNMAPPED_ITEM: '품목이 매핑되지 않은 경락 건입니다(경락 수집 → 품목 매핑).',
  MOCK_SOURCE: '목업 경락으로는 매입 등록하지 않습니다.',
  NO_PRODUCT_LINK: '판매툴 품목 연결이 없습니다(대조 설정 → 품목 연결).',
  UNIT_CHECK_NEEDED: '단위 환산이 맞지 않아 자동 등록하지 않았습니다. 매입서 대조에서 수동 확정(주인)하세요.',
};
const noCorpMsg = (t) => `법인 ${t.corp_name || t.corp_code || '(없음)'}과 거래처 연결이 없습니다(대조 설정 → 법인 연결).`;

/** trade_ids 검사 → { ids } | { error } (중복 제거, 오름차순 — 잠금·처리 순서 고정) */
function parseTradeIds(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: '전환할 경락 건을 고르세요.' };
  const ids = [];
  for (const x of raw) {
    const s = String(x == null ? '' : x);
    if (!/^\d{1,15}$/.test(s) || Number(s) <= 0) return { error: '경락 건 번호가 올바르지 않습니다.' };
    if (!ids.includes(Number(s))) ids.push(Number(s));
  }
  if (ids.length > MAX_TRADES) return { error: `한 번에 ${MAX_TRADES}건까지 전환할 수 있습니다.` };
  ids.sort((a, b) => a - b);
  return { ids };
}

/** 건별 사전 점검(쓰기 없음) — 미리보기와 전환이 같은 함수를 쓴다 */
async function evaluate(db, userId, ids) {
  const tr = await db.query(
    `SELECT t.*, mi.family_name, mi.variety_name,
            EXISTS (SELECT 1 FROM collect_snapshot s WHERE s.source = 'AT_REALTIME' AND s.market_code = t.market_code AND s.trade_date = t.trade_date
                       AND s.phase = 'FINAL' AND s.status = 'COMPLETE' AND s.is_latest_ok) AS base_final
       FROM auction_trade t LEFT JOIN market_item mi ON mi.item_key = t.item_key
      WHERE t.id = ANY($1::bigint[]) ORDER BY t.id`, [ids]);
  const byId = new Map(tr.rows.map((t) => [Number(t.id), t]));
  // 이 회원의 활성 전환(어느 경로든) — 직접 전환(AUCTION 매입서)이면 ALREADY_CONVERTED, 업로드 매입서 줄이면 TRADE_TAKEN
  const act = await db.query(
    `SELECT c.trade_id, c.purchase_id, c.id AS conversion_id, c.doc_id, c.line_id, l.line_no, d.input_kind
       FROM purchase_doc_conversion c JOIN purchase_doc_line l ON l.id = c.line_id JOIN purchase_doc d ON d.id = c.doc_id
      WHERE c.user_id = $1 AND c.trade_id = ANY($2::bigint[]) AND c.status = 'ACTIVE'`, [userId, ids]);
  const actBy = new Map(act.rows.map((x) => [Number(x.trade_id), x]));
  // 아직 전환 안 된 업로드 매입서 줄의 1순위 후보 → 경고만(직접 전환하면 그 줄은 나중에 TRADE_TAKEN)
  const pend = await db.query(
    `SELECT l.best_trade_id, l.doc_id, l.line_no FROM purchase_doc_line l JOIN purchase_doc d ON d.id = l.doc_id
      WHERE l.user_id = $1 AND l.best_trade_id = ANY($2::bigint[]) AND l.status IN ('PENDING', 'HOLD') AND d.status <> 'CANCELLED' AND d.input_kind <> 'AUCTION'`,
    [userId, ids]);
  const pendBy = new Map();
  for (const x of pend.rows) if (!pendBy.has(Number(x.best_trade_id))) pendBy.set(Number(x.best_trade_id), x);
  const corps = [...new Set(tr.rows.map((t) => t.corp_code).filter(Boolean))];
  const cl = corps.length ? await db.query(
    `SELECT l.corp_code, a.id, a.name FROM market_corp_link l JOIN account a ON a.id = l.partner_id AND a.user_id = l.user_id
      WHERE l.user_id = $1 AND l.corp_code = ANY($2::text[])`, [userId, corps]) : { rows: [] };
  const corpBy = new Map(cl.rows.map((x) => [x.corp_code, { id: x.id, name: x.name }]));
  const productOf = await engine.resolveProductLinks(db, userId);
  const tolRows = await engine.loadTolerances(db, userId);
  const mockOk = engine.allowMockConvert();
  const pnames = new Map();

  const rows = [];
  for (const id of ids) {
    const t = byId.get(id);
    if (!t) { rows.push({ trade_id: id, result: 'NOT_FOUND', code: 'NOT_FOUND', message: MSG.NOT_FOUND }); continue; }
    const base = { trade_id: id, trade_date: t.trade_date, corp_code: t.corp_code, corp_name: t.corp_name, shipment_no: t.shipment_no || null, auction_seq: t.auction_seq,
      item_label: t.family_name ? `${t.family_name} · ${t.variety_name}` : t.item_name_raw };
    const out = (result, message, extra = {}) => ({ ...base, result, code: result, message, ...extra });
    if (t.withdrawn_at) { rows.push(out('WITHDRAWN', MSG.WITHDRAWN)); continue; }
    if (t.map_status !== 'MAPPED' || !t.item_key) { rows.push(out('UNMAPPED_ITEM', MSG.UNMAPPED_ITEM)); continue; }
    if (t.source === 'MOCK' && !mockOk) { rows.push(out('MOCK_SOURCE', MSG.MOCK_SOURCE)); continue; }
    const a = actBy.get(id);
    if (a && a.input_kind === 'AUCTION') {
      rows.push({ ...base, result: 'ALREADY_CONVERTED', purchase_id: a.purchase_id, doc_id: Number(a.doc_id), line_id: Number(a.line_id), conversion_id: Number(a.conversion_id) });
      continue;
    }
    if (a) { rows.push(out('TRADE_TAKEN', `그 경락 건은 매입서 #${a.doc_id}-${a.line_no} 줄에 이미 쓰였습니다.`, { purchase_id: a.purchase_id })); continue; }
    const partner = corpBy.get(t.corp_code);
    if (!partner) { rows.push(out('NO_CORP_LINK', noCorpMsg(t))); continue; }
    const link = productOf(t.item_key, t.grade_norm);
    if (!link) { rows.push(out('NO_PRODUCT_LINK', MSG.NO_PRODUCT_LINK)); continue; }
    const tol = engine.pickTolerance(tolRows, userId, t.item_key);
    // eslint-disable-next-line no-await-in-loop
    const plan = await engine.planPurchase(db, { qty: t.qty, unit_price: t.unit_price, unit_qty_kg: t.unit_qty_kg, amount: t.amount }, { unit: link.unit }, tol);
    if (!plan.ok) { rows.push(out('UNIT_CHECK_NEEDED', MSG.UNIT_CHECK_NEEDED, { detail: { reason: plan.reason, quantity: plan.quantity, unit_price: plan.unit_price, total: plan.total } })); continue; }
    if (!pnames.has(link.product_id)) {
      // eslint-disable-next-line no-await-in-loop
      const p = await db.query(`SELECT name FROM product WHERE id = $1`, [link.product_id]);
      pnames.set(link.product_id, p.rows[0] ? p.rows[0].name : null);
    }
    const warnings = [];
    if (!t.base_final) warnings.push('BASE_NOT_FINAL');
    const pl = pendBy.get(id);
    if (pl) warnings.push('DOC_LINE_PENDING');
    rows.push({ ...base, result: 'WILL_CONVERT', partner, product: { id: link.product_id, name: pnames.get(link.product_id) },
      purchase_date: String(t.trade_date).slice(0, 10), quantity: String(plan.quantity), unit_price: String(plan.unit_price), total: String(plan.total),
      warnings, ...(pl ? { pending_doc_line: { doc_id: Number(pl.doc_id), line_no: pl.line_no } } : {}),
      _t: t, _plan: plan, _tol: tol });
  }
  return rows;
}

const publicRow = (r) => { const { _t, _plan, _tol, ...rest } = r; return rest; }; // eslint-disable-line no-unused-vars

/** R-138 미리보기 — 쓰기·잠금 없음 */
async function previewTrades(db, userId, ids) {
  const rows = await evaluate(db, userId, ids);
  const will = rows.filter((r) => r.result === 'WILL_CONVERT');
  const sum = await db.query(`SELECT COALESCE(SUM(x), 0)::numeric(14,2)::text AS s FROM unnest($1::numeric[]) x`, [will.map((r) => r.total)]);
  return { rows: rows.map(publicRow), summary: { will_convert: will.length, already: rows.filter((r) => r.result === 'ALREADY_CONVERTED').length,
    excluded: rows.length - will.length - rows.filter((r) => r.result === 'ALREADY_CONVERTED').length, total_amount: sum.rows[0].s } };
}

/** R-139 전환 — 바깥 트랜잭션(client) 안. 잠금 → 점검 → 건마다 SAVEPOINT(매입서 없으면 만들고 줄 INSERT → convertOne) → 매입서 재계산 */
async function convertTrades(client, cx, ids) {
  convert.withClient(cx, client);
  await convert.lockConvert(client, cx.userId);
  const rows = await evaluate(client, cx.userId, ids);
  const docs = new Map(); // `${partner}|${date}` → { id, lines }
  const results = [];
  for (const r of rows) {
    if (r.result !== 'WILL_CONVERT') { results.push(publicRow(r)); continue; }
    const t = r._t;
    const date = String(t.trade_date).slice(0, 10);
    const gk = `${r.partner.id}|${date}`;
    const sp = `tcv_${t.id}`;
    // eslint-disable-next-line no-await-in-loop
    await client.query(`SAVEPOINT ${sp}`);
    try {
      let g = docs.get(gk);
      let newDoc = false;
      if (!g) {
        // eslint-disable-next-line no-await-in-loop
        const d = await client.query(
          `INSERT INTO purchase_doc (user_id, input_kind, upload_id, doc_no, doc_date, supplier_partner_id, corp_code, memo, created_by_staff_id)
           VALUES ($1, 'AUCTION', NULL, NULL, $2, $3, $4, '경락 시세 직접 전환', $5) RETURNING id`,
          [cx.userId, date, r.partner.id, t.corp_code, cx.staffId || null]);
        g = { id: Number(d.rows[0].id), lines: 0 };
        newDoc = true;
      }
      const lineNo = g.lines + 1;
      const lineVals = { trade_date: date, corp_code: t.corp_code, item_key: t.item_key, item_name_raw: t.item_name_raw, grade_norm: t.grade_norm, pkg_norm: t.pkg_norm,
        unit_qty_kg: t.unit_qty_kg, qty: t.qty, unit_price: t.unit_price, auction_ref: t.auction_seq, shipment_ref: t.shipment_no };
      // eslint-disable-next-line no-await-in-loop
      const ln = await client.query(
        `INSERT INTO purchase_doc_line (doc_id, user_id, line_no, trade_date, item_name_raw, item_key, grade_raw, grade_norm, pkg_raw, pkg_norm, unit_qty_kg, weight_source,
                                        qty, unit_price, amount, origin_name, shipper_name_masked, auction_ref, buyer_code, product_id, line_fingerprint, shipment_ref,
                                        status, match_result, match_score, best_trade_id, candidate_count, matched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::numeric,$12,$13::numeric,$14::bigint,$15::bigint,$16,$17,$18,$19,$20,$21,$22,'PENDING','EXACT',100,$23,1,NOW())
         RETURNING *`,
        [g.id, cx.userId, lineNo, date, String(t.item_name_raw || t.corp_variety_name || t.item_key).slice(0, 100), t.item_key, t.grade_name ? String(t.grade_name).slice(0, 30) : null,
          t.grade_norm, t.pkg_name ? String(t.pkg_name).slice(0, 50) : null, t.pkg_norm, t.unit_qty_kg, t.weight_source, t.qty, t.unit_price, t.amount,
          t.origin_name, t.shipper_name_masked, t.auction_seq ? String(t.auction_seq).slice(0, 50) : null, t.buyer_code, r.product.id, N.lineFingerprint(lineVals),
          t.shipment_no || null, t.id]);
      const line = ln.rows[0];
      const memo = `경락 #${t.id}${t.shipment_no ? ` · 원표 ${t.shipment_no}` : ''}${t.auction_seq ? ` · 경매 ${t.auction_seq}` : ''}`;
      // eslint-disable-next-line no-await-in-loop
      const c = await convert.convertOne(client, cx, {
        line, trade: { trade_id: Number(t.id), corp_name: t.corp_name, origin_name: t.origin_name, price_diff: 0 }, mode: 'MANUAL', plan: r._plan, tol: r._tol,
        eventType: 'CONVERT_FROM_TRADE', diff: null, warnings: r.warnings, memo,
        extraDetail: { route: 'AUCTION', trade_id: Number(t.id), revision: t.revision, source_modified_at: t.source_modified_at, shipment_no: t.shipment_no || null, auction_seq: t.auction_seq || null },
      });
      if (c.result !== 'CONVERTED') {
        // eslint-disable-next-line no-await-in-loop
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        // eslint-disable-next-line no-await-in-loop
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        const res = publicRow(r);
        if (c.result === 'ALREADY_CONVERTED' || c.result === 'TRADE_TAKEN') {
          results.push({ ...res, result: c.result, code: c.result, message: c.message, purchase_id: c.purchase_id });
        } else {
          results.push({ ...res, result: 'PURCHASE_FAILED', code: 'PURCHASE_FAILED', message: c.message, detail: c.detail });
        }
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      if (newDoc) docs.set(gk, g);
      g.lines = lineNo;
      const { partner, product, quantity, unit_price: up, total, warnings } = r;
      results.push({ trade_id: Number(t.id), result: 'CONVERTED', purchase_id: c.purchase_id, doc_id: g.id, line_id: Number(line.id), conversion_id: c.conversion_id,
        partner, product, purchase_date: date, quantity, unit_price: up, total, warnings });
    } catch (err) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
      throw err;
    }
  }
  for (const g of docs.values()) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(`SELECT purchase_doc_recalc($1)`, [g.id]);
  }
  const ok = results.filter((x) => x.result === 'CONVERTED' || x.result === 'ALREADY_CONVERTED');
  const pids = ok.map((x) => x.purchase_id).filter(Boolean);
  let navigate = null;
  if (pids.length) {
    const d = await client.query(`SELECT MIN(purchase_date)::text AS f, MAX(purchase_date)::text AS t FROM purchase WHERE user_id = $1 AND id = ANY($2::int[])`, [cx.userId, pids]);
    navigate = { tab: 'purchases', from_date: d.rows[0].f, to_date: d.rows[0].t, purchase_ids: pids };
  }
  const converted = results.filter((x) => x.result === 'CONVERTED').length;
  const already = results.filter((x) => x.result === 'ALREADY_CONVERTED').length;
  return { results, summary: { converted, already, failed: results.length - converted - already }, navigate, doc_ids: [...docs.values()].map((g) => g.id) };
}

module.exports = { parseTradeIds, previewTrades, convertTrades, MAX_TRADES };
