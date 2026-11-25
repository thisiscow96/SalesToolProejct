'use strict';
/**
 * T-203 경락 정규화·저장 (D 0.2·0.4·5.6, 설계 1.2 ②)
 *  - FIELD_MAP 결과(문자열) → 품목 매핑(코드 → 키워드 최장 일치) · 등급 · 포장 · 단위 중량(SOURCE/RULE/UNKNOWN) · 출하자 마스킹 · 자연키
 *  - auction_trade upsert: 같은 (source, source_row_key) 를 다시 받아도 값이 같으면 아무것도 바뀌지 않는다(멱등).
 *    값이 바뀌면 이전 값을 auction_trade_history 에 남기고 revision+1. FINAL 에서 사라진 건은 withdrawn_at(지우지 않음).
 *  - 금액(amount = ROUND(qty × unit_price)), 총중량, kg 단가(HALF_UP 2자리)는 SQL NUMERIC 으로 계산한다(AC-35).
 */
const crypto = require('crypto');
const N = require('../purchase-match/normalize');
const { maskName } = require('./mask');

/** 매핑 표를 한 번에 읽는다(한 작업 안에서 재사용) */
async function loadMappingContext(db, { target = 'MARKET', on = null } = {}) {
  const day = on || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const targets = target === 'DOC' ? ['DOC', 'BOTH'] : ['MARKET', 'BOTH'];
  const m = await db.query(
    `SELECT id, source, code_l, code_m, code_s, keyword_norm, item_key, priority, action
       FROM item_mapping
      WHERE active AND target = ANY($1::text[])
        AND (valid_from IS NULL OR valid_from <= $2::date) AND (valid_to IS NULL OR valid_to >= $2::date)
      ORDER BY priority, id`,
    [targets, day]
  );
  const g = await db.query('SELECT alias_norm, grade_norm FROM grade_alias');
  const p = await db.query('SELECT item_key, pkg_norm, unit_qty_kg FROM pack_weight_rule WHERE active ORDER BY priority, id');
  const items = await db.query('SELECT item_key FROM market_item WHERE active');
  return {
    codeRules: m.rows.filter((r) => r.code_m),
    keywordRules: m.rows.filter((r) => r.keyword_norm),
    grades: new Map(g.rows.map((r) => [r.alias_norm, r.grade_norm])),
    packRules: p.rows,
    activeItems: new Set(items.rows.map((r) => r.item_key)),
  };
}

/**
 * 원천 품목 → { item_key, map_status } (코드 우선, 없으면 키워드)
 *  T-203 실 API(A 2.3): realFormat(실 API 행 — source AT_REALTIME 이거나 출하번호가 있는 실형식 행)은 **코드 규칙만**
 *  (source 'AT_REALTIME' 규칙으로 찾음). 키워드 대체 없음 — '피망(단고추)'·'생고추잎'이 키워드 '고추'에 걸려 PEPPER._ 가 되던 문제(R-02).
 *  코드 규칙이 IGNORE(030) 면 item_key 없이 IGNORED(행은 보관, 대조 후보·기본 목록 제외)
 */
function mapItemFull(ctx, { source, l, m, s, name, parentName, realFormat = false }) {
  const byCode = m ? N.matchCode({ source: realFormat ? 'AT_REALTIME' : source, l, m, s }, ctx.codeRules) : null;
  if (byCode && byCode.action === 'IGNORE') return { item_key: null, map_status: 'IGNORED' };
  if (byCode && byCode.item_key && ctx.activeItems.has(byCode.item_key)) return { item_key: byCode.item_key, map_status: 'MAPPED' };
  if (realFormat) return { item_key: null, map_status: 'UNMAPPED' };
  const byKw = N.matchKeyword(N.nameCandidates(name, parentName), ctx.keywordRules);
  if (byKw && ctx.activeItems.has(byKw.item_key)) return { item_key: byKw.item_key, map_status: 'MAPPED' };
  return { item_key: null, map_status: 'UNMAPPED' };
}
/** 예전 호출용 — item_key 만 */
function mapItem(ctx, args) { return mapItemFull(ctx, args).item_key; }

/** 단위 중량: 원천 단위수량+단위명 → SOURCE, 없으면 pack_weight_rule → RULE, 그것도 없으면 UNKNOWN */
function resolveWeight(ctx, { unitQty, unitName, pkgName, itemKey, pkgNorm }) {
  let kg = null;
  const un = String(unitName || '').trim();
  if (unitQty != null && unitQty !== '' && /^\d+(\.\d+)?$/.test(String(unitQty))) {
    if (/^(kg|키로|킬로|킬로그램)$/i.test(un)) kg = N.decimalDiv(String(unitQty), 1, 3);
    else if (/^(g|그램)$/i.test(un)) kg = N.decimalDiv(String(unitQty), 1000, 3);
  }
  if (!kg) kg = N.parseSpec(un).kg || N.parseSpec(pkgName).kg;
  if (kg && Number(kg) > 0) return { kg, source: 'SOURCE' };
  const rule = ctx.packRules.find((r) => r.item_key === itemKey && r.pkg_norm === pkgNorm)
    || ctx.packRules.find((r) => r.item_key == null && r.pkg_norm === pkgNorm);
  if (rule) return { kg: String(rule.unit_qty_kg), source: 'RULE' };
  return { kg: null, source: 'UNKNOWN' };
}

function ymd(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}
/** 원천 낙찰일시(KST 표기, 시간대 없음) → ISO +09:00 */
function kstTimestamp(s) {
  const t = String(s || '').trim();
  const m = t.match(/^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2})(?::?(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+09:00`;
}

/**
 * 원천 행 묶음(한 작업 전체) → 정규화 행. 단가 비정수·음수, 수량 누락 → 오류(BAD_RESPONSE — 그 작업은 저장 0건)
 * @returns { rows, errors[] }
 */
function normalizeItems(ctx, adapter, rawItems, { source, marketCode }) {
  const rows = [];
  const errors = [];
  const seqByKey = new Map();
  const realSource = source === 'AT_REALTIME';
  rawItems.forEach((item, idx) => {
    const f = adapter.toNormalized(item);
    const tradeDate = ymd(f.trade_date);
    const won = N.readWon(f.unit_price);
    const q = N.readQty(f.qty);
    if (!tradeDate) errors.push({ idx, field: 'trade_date', message: '거래정산일자 없음' });
    if (won.error || won.value == null) errors.push({ idx, field: 'unit_price', message: `낙찰가가 원 단위 정수가 아님(${f.unit_price})` });
    if (q.error || q.value == null) errors.push({ idx, field: 'qty', message: `수량 없음·형식 오류(${f.qty})` });
    // 실 API 행(실 소스이거나 출하번호가 있는 실형식): 자연키 값이 모두 있어야 한다(A N-7 · I B-2). 해시 키로 넘기지 않음
    const realFormat = realSource || f.shipment_no != null || f.corp_item_code != null || f.source_modified_at != null; // 옛 목업(D_mock)엔 셋 다 없음
    const mkt = f.market_code || marketCode;
    if (realFormat) {
      const miss = [['whsl_mrkt_cd', mkt], ['corp_cd', f.corp_code], ['spm_no', f.shipment_no], ['auctn_seq', f.source_id]].filter(([, v]) => v == null || v === '').map(([k]) => k);
      if (miss.length) errors.push({ idx, field: 'source_row_key', message: `자연키 값 없음(${miss.join('·')})` });
    }
    if (errors.length && errors[errors.length - 1].idx === idx) return;
    const mapped = mapItemFull(ctx, { source, l: f.item_l_code, m: f.item_m_code, s: f.item_s_code, name: f.item_name_raw, parentName: f.item_m_name, realFormat });
    const itemKey = mapped.item_key;
    const pkgNorm = N.normalizePkg(f.pkg_name);
    const w = resolveWeight(ctx, { unitQty: f.unit_qty, unitName: f.unit_name, pkgName: f.pkg_name, itemKey, pkgNorm });
    const row = {
      source,
      trade_date: tradeDate,
      auction_at: kstTimestamp(f.auction_at),
      market_code: f.market_code || marketCode,
      market_name: f.market_name,
      corp_code: f.corp_code, corp_name: f.corp_name,
      item_l_code: f.item_l_code, item_m_code: f.item_m_code, item_s_code: f.item_s_code,
      item_name_raw: f.item_name_raw,
      item_key: itemKey,
      map_status: mapped.map_status,
      grade_code: f.grade_code, grade_name: f.grade_name, grade_norm: N.normalizeGrade(f.grade_name, ctx.grades),
      pkg_code: f.pkg_code, pkg_name: f.pkg_name, pkg_norm: pkgNorm,
      size_code: f.size_code, size_name: f.size_name,
      unit_code: f.unit_code, unit_name: f.unit_name,
      unit_qty_kg: w.kg, weight_source: w.source,
      qty: q.value, unit_price: won.value,
      origin_code: f.origin_code, origin_name: f.origin_name,
      shipper_name_masked: maskName(f.shipper_name),
      buyer_code: f.buyer_code,
      auction_seq: f.source_id,
      // T-203 030 칸(실 API 만 값이 있음 — 목업 옛 형식은 모두 null)
      shipment_no: f.shipment_no, trade_type: f.trade_type,
      corp_item_code: f.corp_item_code, corp_item_name: f.corp_item_name, corp_variety_name: f.corp_variety_name,
      item_l_name: f.item_l_name, item_m_name: f.item_m_name,
      source_modified_at: kstTimestamp(f.source_modified_at),
      real_format: realFormat,
    };
    // 자연키 — 실 API: 시장|정산일|법인|출하번호|경매순번(원문 문자열, 앞자리 0 유지 — 030 CHECK auction_trade_at_natural_key 와 같은 모양)
    //         목업 옛 형식(D 5.6): 원천 건 번호가 있으면 그 값, 없으면 값 조합 해시 + 같은 조합 순번
    if (realFormat) row.source_row_key = [row.market_code, tradeDate, row.corp_code, row.shipment_no, row.auction_seq].join('|').slice(0, 200);
    else if (f.source_id) row.source_row_key = String(f.source_id).slice(0, 200);
    else {
      const nat = [tradeDate, row.auction_at, row.market_code, row.corp_code, row.item_s_code, row.grade_code, row.pkg_code, row.size_code,
        f.unit_qty, row.origin_code, row.unit_price, row.qty, row.buyer_code].map((v) => v ?? '').join('|');
      const seq = (seqByKey.get(nat) || 0) + 1;
      seqByKey.set(nat, seq);
      row.source_row_key = crypto.createHash('sha256').update(`${nat}|${seq}`).digest('hex');
    }
    row.content_hash = contentHash(row);
    rows.push(row);
  });
  return { rows, errors };
}

const HASH_FIELDS = ['trade_date', 'auction_at', 'market_code', 'market_name', 'corp_code', 'corp_name', 'item_l_code', 'item_m_code', 'item_s_code',
  'item_name_raw', 'item_key', 'grade_code', 'grade_name', 'grade_norm', 'pkg_code', 'pkg_name', 'pkg_norm', 'size_code', 'size_name', 'unit_code',
  'unit_name', 'unit_qty_kg', 'weight_source', 'qty', 'unit_price', 'origin_code', 'origin_name', 'shipper_name_masked', 'buyer_code', 'auction_seq'];
// 030 새 칸 — 실형식 행에만 해시에 넣는다(목업·기존 행의 해시가 바뀌어 배포 직후 전부 '정정'으로 잡히지 않게).
// source_modified_at 은 넣지 않음(재적재 시각만 바뀐 건 정정 아님 — A 3.5)
const HASH_FIELDS_REAL = ['shipment_no', 'trade_type', 'corp_item_code', 'corp_item_name', 'corp_variety_name', 'item_l_name', 'item_m_name', 'map_status'];
function contentHash(row) {
  const fields = row.real_format ? [...HASH_FIELDS, ...HASH_FIELDS_REAL] : HASH_FIELDS;
  return crypto.createHash('sha256').update(JSON.stringify(fields.map((k) => row[k] ?? null))).digest('hex');
}

/**
 * 한 작업 안 같은 키 정리(I B-3 · R-03) — 원천 수정일시가 가장 늦은 1행만(같으면 뒤에 온 행). upsert 가 21000 으로 실패하지 않게
 * @returns { rows, dropped }
 */
function dedupeRows(rows) {
  const byKey = new Map();
  let dropped = 0;
  for (const r of rows) {
    const prev = byKey.get(r.source_row_key);
    if (prev) {
      dropped += 1;
      if (prev.source_modified_at && r.source_modified_at && Date.parse(r.source_modified_at) < Date.parse(prev.source_modified_at)) continue;
    }
    byKey.set(r.source_row_key, r);
  }
  return { rows: [...byKey.values()], dropped };
}

const COLS = ['source', 'source_row_key', 'trade_date', 'auction_at', 'market_code', 'market_name', 'corp_code', 'corp_name', 'item_l_code', 'item_m_code',
  'item_s_code', 'item_name_raw', 'item_key', 'map_status', 'grade_code', 'grade_name', 'grade_norm', 'pkg_code', 'pkg_name', 'pkg_norm', 'size_code',
  'size_name', 'unit_code', 'unit_name', 'unit_qty_kg', 'weight_source', 'qty', 'unit_price', 'origin_code', 'origin_name', 'shipper_name_masked',
  'buyer_code', 'auction_seq', 'content_hash',
  'shipment_no', 'trade_type', 'corp_item_code', 'corp_item_name', 'corp_variety_name', 'item_l_name', 'item_m_name', 'source_modified_at'];
const RECORD_TYPES = {
  trade_date: 'date', auction_at: 'timestamptz', source_modified_at: 'timestamptz', unit_qty_kg: 'numeric', qty: 'numeric', unit_price: 'bigint',
};
const recordDef = COLS.map((c) => `${c} ${RECORD_TYPES[c] || 'text'}`).join(', ');

/**
 * 정규화 행 upsert (트랜잭션 안 client). 변경 건은 history 에 이전 값.
 * @returns { inserted, updated, unchanged, unmapped, changedIds[] }
 */
async function upsertTrades(client, rows, { snapshotId, rawRef }) {
  if (!rows.length) return { inserted: 0, updated: 0, unchanged: 0, unmapped: 0, changedIds: [] };
  const payload = JSON.stringify(rows.map((r) => Object.fromEntries(COLS.map((c) => [c, r[c] ?? null]))));
  // ① 값이 바뀔 건의 이전 값 보존
  await client.query(
    `INSERT INTO auction_trade_history (trade_id, revision, old_values, content_hash, snapshot_id)
     SELECT t.id, t.revision,
            to_jsonb(t) - ARRAY['id','created_at','updated_at','first_seen_at','last_seen_at','raw_ref','snapshot_id','content_hash'],
            t.content_hash, $2
       FROM jsonb_to_recordset($1::jsonb) AS r(${recordDef})
       JOIN auction_trade t ON t.source = r.source AND t.source_row_key = r.source_row_key
      WHERE t.content_hash <> r.content_hash
        AND NOT (r.source_modified_at IS NOT NULL AND t.source_modified_at IS NOT NULL AND r.source_modified_at < t.source_modified_at)
     ON CONFLICT (trade_id, revision) DO NOTHING`,
    [payload, snapshotId]
  );
  const ins = await client.query(
    `INSERT INTO auction_trade (${COLS.join(', ')}, weight_kg, price_per_kg, amount, snapshot_id, raw_ref)
     SELECT ${COLS.map((c) => `r.${c}`).join(', ')},
            CASE WHEN r.unit_qty_kg IS NULL THEN NULL ELSE ROUND(r.qty * r.unit_qty_kg, 3) END,
            CASE WHEN r.unit_qty_kg IS NULL THEN NULL ELSE ROUND(r.unit_price::numeric / r.unit_qty_kg, 2) END,
            ROUND(r.qty * r.unit_price)::bigint,
            $2, $3
       FROM jsonb_to_recordset($1::jsonb) AS r(${recordDef})
     ON CONFLICT (source, source_row_key) DO UPDATE SET
       ${COLS.filter((c) => c !== 'source' && c !== 'source_row_key').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
       weight_kg = EXCLUDED.weight_kg, price_per_kg = EXCLUDED.price_per_kg, amount = EXCLUDED.amount,
       snapshot_id = EXCLUDED.snapshot_id, raw_ref = EXCLUDED.raw_ref,
       revision = auction_trade.revision + 1, withdrawn_at = NULL, last_seen_at = NOW(), updated_at = NOW()
     WHERE auction_trade.content_hash <> EXCLUDED.content_hash
       -- 옛 응답으로 덮지 않기(A 3.5 · I R-05): 들어온 원천 수정일시가 저장된 값보다 이르면 그대로 둔다(STALE_ROW)
       AND NOT (EXCLUDED.source_modified_at IS NOT NULL AND auction_trade.source_modified_at IS NOT NULL
                AND EXCLUDED.source_modified_at < auction_trade.source_modified_at)
     RETURNING id, (xmax = 0) AS inserted`,
    [payload, snapshotId, rawRef ?? null]
  );
  const inserted = ins.rows.filter((r) => r.inserted).length;
  const changedIds = ins.rows.filter((r) => !r.inserted).map((r) => r.id);
  // ③ 같은 값으로 다시 본 건 — 마지막으로 본 시각만(사라졌다 다시 나온 건은 철회 표시도 지움)
  const same = await client.query(
    `UPDATE auction_trade t SET last_seen_at = NOW(), withdrawn_at = NULL,
            source_modified_at = GREATEST(t.source_modified_at, r.source_modified_at)
       FROM jsonb_to_recordset($1::jsonb) AS r(${recordDef})
      WHERE t.source = r.source AND t.source_row_key = r.source_row_key AND t.content_hash = r.content_hash
        AND t.last_seen_at < NOW()`,
    [payload]
  );
  // 옛 응답(값이 다른데 원천 수정일시가 저장 값보다 이름) — 값은 그대로, 본 것으로만 표시(철회로 잡히지 않게)하고 건수를 센다
  const stale = await client.query(
    `UPDATE auction_trade t SET last_seen_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS r(${recordDef})
      WHERE t.source = r.source AND t.source_row_key = r.source_row_key AND t.content_hash <> r.content_hash
        AND r.source_modified_at IS NOT NULL AND t.source_modified_at IS NOT NULL AND r.source_modified_at < t.source_modified_at
        AND t.last_seen_at < NOW()`,
    [payload]
  );
  const unmapped = rows.filter((r) => r.map_status === 'UNMAPPED').length;
  const ignored = rows.filter((r) => r.map_status === 'IGNORED').length;
  return { inserted, updated: changedIds.length, unchanged: same.rowCount, unmapped, ignored, stale: stale.rowCount, changedIds };
}

/** FINAL 수집에서 보이지 않은 이전 건 → withdrawn_at (같은 트랜잭션의 NOW() 보다 이전에 본 건) */
async function markWithdrawn(client, { source, marketCode, tradeDate, combos = null, corps = null }) {
  // 중분류별로 나눠 부른 작업은 이번에 부른 (대분류, 중분류) 안에서만 철회 판정(I B-6 · R-04). combos 없으면 날짜 전체(목업·기존)
  // 법인 한정 수집(AUCTION_CORP_CODES)이면 그 법인 행만 철회 판정 — 범위 밖 법인의 이미 저장된 행은 건드리지 않는다
  const ls = combos && combos.length ? combos.map((c) => c.itemL) : null;
  const ms = combos && combos.length ? combos.map((c) => c.itemM) : null;
  const r = await client.query(
    `UPDATE auction_trade SET withdrawn_at = NOW(), updated_at = NOW()
      WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND withdrawn_at IS NULL AND last_seen_at < NOW()
        AND ($4::text[] IS NULL OR (item_l_code, item_m_code) IN (SELECT * FROM unnest($4::text[], $5::text[])))
        AND ($6::text[] IS NULL OR corp_code = ANY($6::text[]))
      RETURNING id`,
    [source, marketCode, tradeDate, ls, ms, corps && corps.length ? corps : null]
  );
  return r.rows.map((x) => x.id);
}

/** 전환에 쓰인 경락 건이 바뀌거나 철회되면 그 줄에 경고 BASE_REVISED (자동으로 고치지 않음 — D 4.3) */
async function flagRevisedConversions(client, tradeIds) {
  if (!tradeIds.length) return 0;
  const r = await client.query(
    `UPDATE purchase_doc_line l
        SET warning_flags = array_append(l.warning_flags, 'BASE_REVISED'), updated_at = NOW()
       FROM purchase_doc_conversion c
      WHERE c.line_id = l.id AND c.status = 'ACTIVE' AND c.trade_id = ANY($1::bigint[])
        AND NOT ('BASE_REVISED' = ANY(l.warning_flags))`,
    [tradeIds]
  );
  return r.rowCount;
}

/** REMAP — 매핑을 바꾼 뒤 저장된 경락·매입서 줄의 item_key 다시 계산. 활성 전환에 쓰인 경락 건·전환된 줄은 건드리지 않는다 */
async function remapStored(client, { dateFrom = null } = {}) {
  const ctx = await loadMappingContext(client, { target: 'MARKET' });
  const t = await client.query(
    `SELECT t.id, t.source, t.item_l_code, t.item_m_code, t.item_s_code, t.item_name_raw, t.item_key, t.pkg_norm, t.map_status, t.shipment_no
       FROM auction_trade t
      WHERE ($1::date IS NULL OR t.trade_date >= $1::date) AND t.withdrawn_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.trade_id = t.id AND c.status = 'ACTIVE')`,
    [dateFrom]
  );
  let changed = 0;
  const names = await client.query(`SELECT code, name FROM code_master WHERE code_type = 'item_m'`);
  const mName = new Map(names.rows.map((r) => [r.code, r.name]));
  // 표준코드를 아직 받지 않았으면 같은 중분류 코드로 이미 매핑된 건의 품목군 이름(예: 11 → 고추)을 중분류명으로 쓴다
  const fam = await client.query(
    `SELECT DISTINCT ON (t.item_m_code) t.item_m_code, mi.family_name
       FROM auction_trade t JOIN market_item mi ON mi.item_key = t.item_key
      WHERE t.item_m_code IS NOT NULL AND right(t.item_key, 2) <> '._' -- 품종까지 정해진 건만(품종 모름으로 매핑된 건이 스스로를 근거로 삼지 않게)
      GROUP BY t.item_m_code, mi.family_name ORDER BY t.item_m_code, COUNT(*) DESC`
  );
  for (const r of fam.rows) if (!mName.has(r.item_m_code)) mName.set(r.item_m_code, r.family_name);
  for (const row of t.rows) {
    const mp = mapItemFull(ctx, { source: row.source, l: row.item_l_code, m: row.item_m_code, s: row.item_s_code, name: row.item_name_raw, parentName: mName.get(row.item_m_code) || null,
      realFormat: row.source === 'AT_REALTIME' || row.shipment_no != null });
    const key = mp.item_key;
    if ((key || null) !== (row.item_key || null) || mp.map_status !== row.map_status) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`UPDATE auction_trade SET item_key = $2, map_status = $3, updated_at = NOW() WHERE id = $1`, [row.id, key, mp.map_status]);
      changed += 1;
    }
  }
  const dctx = await loadMappingContext(client, { target: 'DOC' });
  // 매입서 줄: id 순으로 잠그되 대조·전환이 잡고 있는 줄은 건너뜀(SKIP LOCKED) → 화면 작업을 기다리게 하지 않음. 바뀐 줄은 version + 1 (I 검토 D-10)
  const total = await client.query(`SELECT COUNT(*)::int AS n FROM purchase_doc_line WHERE status IN ('PENDING','HOLD','CANCELLED','REJECTED')`);
  const l = await client.query(
    `SELECT id, item_name_raw, item_key FROM purchase_doc_line WHERE status IN ('PENDING','HOLD','CANCELLED','REJECTED') ORDER BY id FOR UPDATE SKIP LOCKED`
  );
  let lines = 0;
  for (const row of l.rows) {
    const k = N.matchKeyword(N.nameCandidates(row.item_name_raw), dctx.keywordRules);
    const key = k && dctx.activeItems.has(k.item_key) ? k.item_key : null;
    if ((key || null) !== (row.item_key || null)) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(`UPDATE purchase_doc_line SET item_key = $2, version = version + 1, updated_at = NOW() WHERE id = $1`, [row.id, key]);
      lines += 1;
    }
  }
  return { trades_changed: changed, lines_changed: lines, lines_skipped: Math.max(total.rows[0].n - l.rowCount, 0), scanned: t.rowCount };
}

module.exports = {
  loadMappingContext, mapItem, mapItemFull, dedupeRows, resolveWeight, normalizeItems, upsertTrades, markWithdrawn, flagRevisedConversions, remapStored,
  contentHash, kstTimestamp, ymd,
};
