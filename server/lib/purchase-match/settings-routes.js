'use strict';
/**
 * T-203 대조 설정 라우트 (설계 4.2, R-103~R-115)
 *  - 품목 매핑(전 회원 공용) = 관리자. 바꾸면 REMAP 작업을 넣어 저장된 경락·매입서 줄의 item_key 를 다시 계산(전환에 쓰인 건은 그대로)
 *  - 품목 연결·법인 연결·허용오차(회원별) = 주인. 조회는 전원
 *  - 설정 변경은 audit_log(entity_type match_setting / market_mapping)
 *  - 허용오차 범위는 DB CHECK 와 같은 값을 먼저 검사해 칸(field)별 문구(4.5)
 */
const queue = require('../auction/queue');
const N = require('./normalize');

const idParam = (s) => (/^\d{1,15}$/.test(String(s || '')) && Number(s) > 0 ? Number(s) : null);
const vErr = (res, field, message, code = 'VALIDATION') => res.status(400).json({ ok: false, code, field, message });
const GRADES = ['SPECIAL', 'HIGH', 'MID', 'LOW', 'OFF', 'NONE'];
const PURCHASABLE = ['supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer'];

const TOL_RULES = [
  ['price_pct_auto', 0, 50, 'num'], ['price_pct_review', 0, 50, 'num'], ['qty_pct_auto', 0, 100, 'num'], ['qty_pct_review', 0, 100, 'num'],
  ['amount_abs_auto', 0, 10000, 'int'], ['date_before_auto', 0, 7, 'int'], ['date_after_auto', 0, 7, 'int'], ['date_before_review', 0, 14, 'int'],
  ['date_after_review', 0, 14, 'int'], ['auto_min_score', 50, 100, 'int'], ['ambiguity_margin', 0, 50, 'int'],
];
const TOL_LABEL = {
  price_pct_auto: '단가 자동 %', price_pct_review: '단가 후보 %', qty_pct_auto: '수량 자동 %', qty_pct_review: '수량 후보 %', amount_abs_auto: '금액 차 자동(원)',
  date_before_auto: '날짜 자동(앞)', date_after_auto: '날짜 자동(뒤)', date_before_review: '날짜 후보(앞)', date_after_review: '날짜 후보(뒤)', auto_min_score: '자동 최소 점수', ambiguity_margin: '1·2위 간격',
};

/** 허용오차 입력 검사 → { values } | { errors } */
function validateTolerance(b, base) {
  const v = { ...base };
  const errors = [];
  for (const [k, lo, hi, kind] of TOL_RULES) {
    if (b[k] === undefined) continue;
    const s = String(b[k]).trim();
    const re = kind === 'int' ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
    if (!re.test(s) || Number(s) < lo || Number(s) > hi) { errors.push({ field: k, code: 'VALIDATION', message: `${TOL_LABEL[k]}은(는) ${lo}~${hi}${kind === 'int' ? ' 정수' : '(소수 2자리)'}로 입력하세요.` }); continue; }
    v[k] = s;
  }
  if (b.auto_convert !== undefined) {
    if (typeof b.auto_convert !== 'boolean') errors.push({ field: 'auto_convert', code: 'VALIDATION', message: '자동 매입 등록은 true/false 입니다.' });
    else v.auto_convert = b.auto_convert;
  }
  // T-203 030 m2 R3 — 식별 근거 없는 유일 후보 자동(U-03). 실 API 경락에만 쓰임
  if (b.auto_unique_no_id !== undefined) {
    if (typeof b.auto_unique_no_id !== 'boolean') errors.push({ field: 'auto_unique_no_id', code: 'VALIDATION', message: '유일 후보 자동 등록은 true/false 입니다.' });
    else v.auto_unique_no_id = b.auto_unique_no_id;
  }
  if (!errors.length) {
    const n = (k) => Number(v[k]);
    if (n('price_pct_auto') > n('price_pct_review')) errors.push({ field: 'price_pct_auto', code: 'VALIDATION', message: '단가 자동 %는 후보 %보다 클 수 없습니다.' });
    if (n('qty_pct_auto') > n('qty_pct_review')) errors.push({ field: 'qty_pct_auto', code: 'VALIDATION', message: '수량 자동 %는 후보 %보다 클 수 없습니다.' });
    if (n('date_before_auto') > n('date_before_review')) errors.push({ field: 'date_before_auto', code: 'VALIDATION', message: '날짜 자동(앞)은 후보(앞)보다 클 수 없습니다.' });
    if (n('date_after_auto') > n('date_after_review')) errors.push({ field: 'date_after_auto', code: 'VALIDATION', message: '날짜 자동(뒤)은 후보(뒤)보다 클 수 없습니다.' });
  }
  return errors.length ? { errors } : { values: v };
}

function registerMatchSettingsRoutes(app, deps) {
  const { pool, getUserIdAndAdmin, recordAudit } = deps;

  async function authOf(req, res) {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) { res.status(401).json({ ok: false, message: '로그인이 필요합니다.' }); return null; }
    return auth;
  }
  async function adminOf(req, res) {
    const auth = await authOf(req, res);
    if (!auth) return null;
    if (!auth.isAdmin) { res.status(403).json({ ok: false, code: 'ADMIN_ONLY', message: '관리자만 할 수 있습니다.' }); return null; }
    return auth;
  }
  const fail = (res, err, msg) => { console.error(`[match-settings] ${msg}:`, err.message); res.status(500).json({ ok: false, message: msg }); };
  const stamp = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace(/[-T:]/g, '');
  async function enqueueRemap(db, userId) {
    const r = await queue.enqueue(db, { job_type: 'REMAP', dedupe_key: `REMAP:${userId}:${stamp()}:${Math.floor(Math.random() * 1e6)}`, params: { reason: 'MAPPING_CHANGED' }, requested_by_user_id: userId });
    return r.id;
  }

  // ---- R-103 품목 매핑 목록 (관리자) ----
  app.get('/api/auction/item-mappings', async (req, res) => {
    if (!(await adminOf(req, res))) return undefined;
    const q = req.query || {};
    const params = [];
    const where = ['true'];
    if (q.item_key) { params.push(String(q.item_key)); where.push(`item_key = $${params.length}`); }
    if (q.active === 'true' || q.active === 'false') { params.push(q.active === 'true'); where.push(`active = $${params.length}`); }
    if (q.q) { params.push(`%${N.normalizeKeyword(q.q).slice(0, 50)}%`); where.push(`(keyword_norm LIKE $${params.length} OR item_key ILIKE $${params.length})`); }
    try {
      const r = await pool.query(`SELECT id, target, source, code_l, code_m, code_s, keyword_norm, item_key, priority, active, valid_from, valid_to, memo, updated_at FROM item_mapping WHERE ${where.join(' AND ')} ORDER BY item_key, priority, id`, params);
      return res.json({ ok: true, data: r.rows.map((x) => ({ ...x, id: Number(x.id) })) });
    } catch (err) { return fail(res, err, '품목 매핑을 불러오지 못했습니다.'); }
  });

  function readMapping(b, partial = false) {
    const out = {};
    if (!partial || b.target !== undefined) {
      const t = String(b.target || 'BOTH').toUpperCase();
      if (!['MARKET', 'DOC', 'BOTH'].includes(t)) return { error: ['target', '대상은 MARKET·DOC·BOTH 입니다.'] };
      out.target = t;
    }
    if (b.source !== undefined) {
      const s = b.source == null || b.source === '' ? null : String(b.source).toUpperCase();
      if (s && !['AT_REALTIME', 'AT_SETTLE', 'GARAK_PRICE', 'MOCK'].includes(s)) return { error: ['source', '소스 값이 올바르지 않습니다.'] };
      out.source = s;
    }
    const hasKw = b.keyword != null && String(b.keyword).trim() !== '';
    const hasCode = b.code_m != null && String(b.code_m).trim() !== '';
    if (!partial || b.keyword !== undefined || b.code_m !== undefined) {
      if (hasKw === hasCode) return { error: ['keyword', '코드(code_m) 또는 키워드 중 하나만 넣으세요.'] };
      out.keyword_norm = hasKw ? N.normalizeKeyword(b.keyword).slice(0, 100) : null;
      out.code_m = hasCode ? String(b.code_m).trim().slice(0, 10) : null;
      out.code_l = hasCode && b.code_l ? String(b.code_l).trim().slice(0, 10) : null;
      out.code_s = hasCode && b.code_s ? String(b.code_s).trim().slice(0, 10) : null;
    }
    if (!partial || b.item_key !== undefined) {
      if (!/^[A-Z0-9]+\.[A-Z0-9_]+$/.test(String(b.item_key || ''))) return { error: ['item_key', '내부 품목(item_key)이 올바르지 않습니다.'] };
      out.item_key = String(b.item_key);
    }
    if (b.priority !== undefined) {
      if (!/^\d{1,4}$/.test(String(b.priority))) return { error: ['priority', '우선순위는 0~9999 정수입니다.'] };
      out.priority = Number(b.priority);
    } else if (!partial) out.priority = 100;
    for (const k of ['valid_from', 'valid_to']) {
      if (b[k] === undefined) continue;
      if (b[k] != null && b[k] !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(b[k]))) return { error: [k, '날짜는 YYYY-MM-DD 입니다.'] };
      out[k] = b[k] || null;
    }
    if (b.memo !== undefined) out.memo = b.memo == null ? null : String(b.memo).slice(0, 200);
    if (b.active !== undefined) {
      if (typeof b.active !== 'boolean') return { error: ['active', 'active 는 true/false 입니다.'] };
      out.active = b.active;
    }
    return { values: out };
  }

  // ---- R-104 매핑 추가 (관리자) ----
  app.post('/api/auction/item-mappings', async (req, res) => {
    const auth = await adminOf(req, res);
    if (!auth) return undefined;
    const m = readMapping(req.body || {});
    if (m.error) return vErr(res, m.error[0], m.error[1]);
    const v = m.values;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const it = await client.query(`SELECT 1 FROM market_item WHERE item_key = $1`, [v.item_key]);
      if (!it.rows[0]) { await client.query('ROLLBACK'); return vErr(res, 'item_key', '없는 내부 품목입니다.'); }
      const r = await client.query(
        `INSERT INTO item_mapping (target, source, code_l, code_m, code_s, keyword_norm, item_key, priority, valid_from, valid_to, memo, updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [v.target, v.source ?? null, v.code_l, v.code_m, v.code_s, v.keyword_norm, v.item_key, v.priority, v.valid_from ?? null, v.valid_to ?? null, v.memo ?? null, auth.userId]
      );
      const jobId = await enqueueRemap(client, auth.userId);
      await recordAudit(client, { userId: auth.userId, entityType: 'market_mapping', entityId: Number(r.rows[0].id), action: 'create', before: null, after: v, note: `품목 매핑 추가 ${v.keyword_norm || v.code_m} → ${v.item_key}` });
      await client.query('COMMIT');
      return res.status(201).json({ ok: true, data: { id: Number(r.rows[0].id), remap_job_id: jobId } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return res.status(409).json({ ok: false, code: 'MAPPING_DUPLICATE', message: '같은 코드·키워드의 활성 매핑이 이미 있습니다.' });
      if (err.code === '23514') return vErr(res, 'keyword', '매핑 값이 규칙에 맞지 않습니다.');
      return fail(res, err, '품목 매핑을 저장하지 못했습니다.');
    } finally { client.release(); }
  });

  // ---- R-105 매핑 수정 (관리자) ----
  app.put('/api/auction/item-mappings/:id', async (req, res) => {
    const auth = await adminOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '매핑을 찾을 수 없습니다.' });
    const m = readMapping(req.body || {}, true);
    if (m.error) return vErr(res, m.error[0], m.error[1]);
    const v = m.values;
    if (!Object.keys(v).length) return vErr(res, 'item_key', '바꿀 내용을 넣으세요.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query(`SELECT * FROM item_mapping WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur.rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '매핑을 찾을 수 없습니다.' }); }
      if (v.item_key) {
        const it = await client.query(`SELECT 1 FROM market_item WHERE item_key = $1`, [v.item_key]);
        if (!it.rows[0]) { await client.query('ROLLBACK'); return vErr(res, 'item_key', '없는 내부 품목입니다.'); }
      }
      const keys = Object.keys(v);
      await client.query(`UPDATE item_mapping SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by_user_id = $${keys.length + 2}, updated_at = NOW() WHERE id = $1`,
        [id, ...keys.map((k) => v[k]), auth.userId]);
      const jobId = await enqueueRemap(client, auth.userId);
      await recordAudit(client, { userId: auth.userId, entityType: 'market_mapping', entityId: id, action: 'update', before: cur.rows[0], after: { ...cur.rows[0], ...v }, note: `품목 매핑 #${id} 수정` });
      await client.query('COMMIT');
      return res.json({ ok: true, data: { id, remap_job_id: jobId } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return res.status(409).json({ ok: false, code: 'MAPPING_DUPLICATE', message: '같은 코드·키워드의 활성 매핑이 이미 있습니다.' });
      if (err.code === '23514') return vErr(res, 'keyword', '매핑 값이 규칙에 맞지 않습니다.');
      return fail(res, err, '품목 매핑을 저장하지 못했습니다.');
    } finally { client.release(); }
  });

  // ---- R-106 매핑 끄기 (관리자, 행은 남김) ----
  app.delete('/api/auction/item-mappings/:id', async (req, res) => {
    const auth = await adminOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '매핑을 찾을 수 없습니다.' });
    try {
      const r = await pool.query(`UPDATE item_mapping SET active = false, updated_by_user_id = $2, updated_at = NOW() WHERE id = $1 RETURNING id`, [id, auth.userId]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '매핑을 찾을 수 없습니다.' });
      const jobId = await enqueueRemap(pool, auth.userId);
      await recordAudit(pool, { userId: auth.userId, entityType: 'market_mapping', entityId: id, action: 'delete', before: { active: true }, after: { active: false }, note: `품목 매핑 #${id} 끔` });
      return res.json({ ok: true, data: { id, active: false, remap_job_id: jobId } });
    } catch (err) { return fail(res, err, '품목 매핑을 끄지 못했습니다.'); }
  });

  // ---- R-107 미매핑 이름 (관리자) ----
  app.get('/api/auction/unmapped', async (req, res) => {
    const auth = await adminOf(req, res);
    if (!auth) return undefined;
    const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date_from || '')) ? req.query.date_from : new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date_to || '')) ? req.query.date_to : today;
    try {
      const r = await pool.query(
        `SELECT 'MARKET' AS origin, item_name_raw, item_m_code AS code_m, item_s_code AS code_s, COUNT(*)::int AS count, MAX(trade_date) AS last_seen
           FROM auction_trade WHERE map_status = 'UNMAPPED' AND trade_date BETWEEN $1 AND $2 GROUP BY 1,2,3,4
         UNION ALL
         SELECT 'DOC', item_name_raw, NULL, NULL, COUNT(*)::int, MAX(trade_date)
           FROM purchase_doc_line WHERE item_key IS NULL AND trade_date BETWEEN $1 AND $2 AND status <> 'REJECTED' GROUP BY 1,2,3,4
         ORDER BY count DESC, item_name_raw`, [from, to]);
      return res.json({ ok: true, data: r.rows });
    } catch (err) { return fail(res, err, '미매핑 목록을 불러오지 못했습니다.'); }
  });

  // ---- R-108 품목 연결 ----
  app.get('/api/auction/product-links', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    try {
      const r = await pool.query(
        `SELECT l.id, l.item_key, l.grade_norm, l.product_id, p.name AS product_name, p.unit AS product_unit, mi.family_name, mi.variety_name
           FROM market_product_link l JOIN product p ON p.id = l.product_id JOIN market_item mi ON mi.item_key = l.item_key
          WHERE l.user_id = $1 ORDER BY mi.sort_order, l.grade_norm NULLS FIRST`, [auth.userId]);
      const s = await pool.query(
        `SELECT mi.item_key, mi.default_product_name, p.id AS product_id, p.name AS product_name, p.unit AS product_unit
           FROM market_item mi
           JOIN LATERAL (SELECT id, name, unit FROM product WHERE owner_user_id IS NULL AND NOT is_system AND lower(btrim(name)) = lower(btrim(mi.default_product_name)) ORDER BY id LIMIT 1) p ON true
          WHERE mi.active AND mi.default_product_name IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM market_product_link l WHERE l.user_id = $1 AND l.item_key = mi.item_key)
          ORDER BY mi.sort_order`, [auth.userId]);
      return res.json({ ok: true, data: r.rows, suggestions: s.rows });
    } catch (err) { return fail(res, err, '품목 연결을 불러오지 못했습니다.'); }
  });

  // ---- R-109 품목 연결 저장 (주인) ----
  app.put('/api/auction/product-links', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const links = (req.body || {}).links;
    if (!Array.isArray(links) || !links.length || links.length > 200) return vErr(res, 'links', '연결을 1~200개 넣으세요.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let saved = 0;
      for (const [i, l] of links.entries()) {
        const key = String((l && l.item_key) || '');
        const grade = l.grade_norm == null || l.grade_norm === '' ? null : String(l.grade_norm).toUpperCase();
        const pid = parseInt(l.product_id, 10);
        // eslint-disable-next-line no-await-in-loop
        const it = await client.query(`SELECT 1 FROM market_item WHERE item_key = $1`, [key]);
        if (!it.rows[0]) { await client.query('ROLLBACK'); return vErr(res, `links[${i}].item_key`, '없는 내부 품목입니다.'); }
        if (grade && !GRADES.includes(grade)) { await client.query('ROLLBACK'); return vErr(res, `links[${i}].grade_norm`, '등급 값이 올바르지 않습니다.'); }
        // eslint-disable-next-line no-await-in-loop
        const p = Number.isFinite(pid) ? await client.query(`SELECT id FROM product WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2) AND NOT is_system`, [pid, auth.userId]) : { rows: [] };
        if (!p.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, code: 'PRODUCT_NOT_FOUND', field: `links[${i}].product_id`, message: '품목을 찾을 수 없습니다(공용 품목·내 개인 품목만).' }); }
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO market_product_link (user_id, item_key, grade_norm, product_id, created_by_staff_id) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, item_key, COALESCE(grade_norm, '*')) DO UPDATE SET product_id = EXCLUDED.product_id, updated_at = NOW()`,
          [auth.userId, key, grade, pid, auth.staffId || null]
        );
        saved += 1;
      }
      await recordAudit(client, { userId: auth.userId, entityType: 'match_setting', entityId: null, action: 'update', before: null, after: { product_links: links.map((l) => `${l.item_key}/${l.grade_norm || '*'}→${l.product_id}`) }, note: `품목 연결 ${saved}건` });
      await client.query('COMMIT');
      return res.json({ ok: true, data: { saved } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err, '품목 연결을 저장하지 못했습니다.');
    } finally { client.release(); }
  });

  // ---- R-110 품목 연결 삭제 (주인) ----
  app.delete('/api/auction/product-links/:id', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' });
    try {
      const r = await pool.query(`DELETE FROM market_product_link WHERE id = $1 AND user_id = $2 RETURNING item_key, grade_norm, product_id`, [id, auth.userId]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '연결을 찾을 수 없습니다.' });
      await recordAudit(pool, { userId: auth.userId, entityType: 'match_setting', entityId: id, action: 'delete', before: r.rows[0], after: { deleted: true }, note: `품목 연결 #${id} 삭제` });
      return res.json({ ok: true, data: { id } });
    } catch (err) { return fail(res, err, '품목 연결을 지우지 못했습니다.'); }
  });

  // ---- R-111 / R-112 법인 연결 ----
  app.get('/api/auction/corp-links', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    try {
      const r = await pool.query(
        `SELECT l.id, l.corp_code, l.partner_id, a.name AS partner_name,
                COALESCE((SELECT name FROM code_master WHERE code_type = 'corp' AND code = l.corp_code), (SELECT corp_name FROM auction_trade WHERE corp_code = l.corp_code ORDER BY id DESC LIMIT 1)) AS corp_name
           FROM market_corp_link l JOIN account a ON a.id = l.partner_id WHERE l.user_id = $1 ORDER BY l.corp_code`, [auth.userId]);
      const known = await pool.query(`SELECT corp_code, MAX(corp_name) AS corp_name, COUNT(*)::int AS trades FROM auction_trade WHERE corp_code IS NOT NULL AND trade_date > CURRENT_DATE - 60 GROUP BY corp_code ORDER BY corp_code`);
      return res.json({ ok: true, data: r.rows, corps: known.rows });
    } catch (err) { return fail(res, err, '법인 연결을 불러오지 못했습니다.'); }
  });
  app.put('/api/auction/corp-links', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const links = (req.body || {}).links;
    if (!Array.isArray(links) || !links.length || links.length > 100) return vErr(res, 'links', '연결을 1~100개 넣으세요.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [i, l] of links.entries()) {
        const code = String((l && l.corp_code) || '').trim();
        if (!/^[A-Za-z0-9_-]{1,10}$/.test(code)) { await client.query('ROLLBACK'); return vErr(res, `links[${i}].corp_code`, '법인 코드가 올바르지 않습니다.'); }
        const pid = parseInt(l.partner_id, 10);
        // eslint-disable-next-line no-await-in-loop
        const a = Number.isFinite(pid) ? await client.query(`SELECT type::text AS type FROM account WHERE id = $1 AND user_id = $2`, [pid, auth.userId]) : { rows: [] };
        if (!a.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, code: 'PARTNER_NOT_FOUND', field: `links[${i}].partner_id`, message: '거래처를 찾을 수 없습니다.' }); }
        if (!PURCHASABLE.includes(a.rows[0].type)) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, code: 'PARTNER_TYPE', field: `links[${i}].partner_id`, message: '매입 가능한 거래처 유형이 아닙니다.' }); }
        // eslint-disable-next-line no-await-in-loop
        await client.query(`DELETE FROM market_corp_link WHERE user_id = $1 AND (corp_code = $2 OR partner_id = $3)`, [auth.userId, code, pid]);
        // eslint-disable-next-line no-await-in-loop
        await client.query(`INSERT INTO market_corp_link (user_id, corp_code, partner_id) VALUES ($1,$2,$3)`, [auth.userId, code, pid]);
      }
      await recordAudit(client, { userId: auth.userId, entityType: 'match_setting', entityId: null, action: 'update', before: null, after: { corp_links: links.map((l) => `${l.corp_code}→${l.partner_id}`) }, note: `법인 연결 ${links.length}건` });
      await client.query('COMMIT');
      return res.json({ ok: true, data: { saved: links.length } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err, '법인 연결을 저장하지 못했습니다.');
    } finally { client.release(); }
  });

  // ---- R-113 허용오차 ----
  app.get('/api/purchase-match/tolerances', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    try {
      const r = await pool.query(`SELECT * FROM match_tolerance WHERE user_id IS NULL OR user_id = $1 ORDER BY user_id NULLS FIRST, item_family NULLS FIRST, item_key NULLS FIRST`, [auth.userId]);
      const def = r.rows.find((x) => x.user_id == null && !x.item_family && !x.item_key) || null;
      const mine = r.rows.find((x) => x.user_id === auth.userId && !x.item_family && !x.item_key) || null;
      return res.json({ ok: true, data: { effective: mine || def, rows: r.rows.filter((x) => x.user_id === auth.userId), defaults: r.rows.filter((x) => x.user_id == null), default_row: def } });
    } catch (err) { return fail(res, err, '허용오차를 불러오지 못했습니다.'); }
  });

  // ---- R-114 허용오차 저장 (주인) — (회원, 범위) 한 행 upsert ----
  app.put('/api/purchase-match/tolerances', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const b = req.body || {};
    const fam = b.item_family == null || b.item_family === '' ? null : String(b.item_family).toUpperCase();
    const key = b.item_key == null || b.item_key === '' ? null : String(b.item_key);
    if (fam && key) return vErr(res, 'item_key', '품목군과 품목 중 하나만 지정하세요.');
    if (fam && !/^[A-Z0-9]{1,20}$/.test(fam)) return vErr(res, 'item_family', '품목군 값이 올바르지 않습니다.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (key) {
        const it = await client.query(`SELECT 1 FROM market_item WHERE item_key = $1`, [key]);
        if (!it.rows[0]) { await client.query('ROLLBACK'); return vErr(res, 'item_key', '없는 내부 품목입니다.'); }
      }
      const cur = await client.query(`SELECT * FROM match_tolerance WHERE user_id = $1 AND item_family IS NOT DISTINCT FROM $2 AND item_key IS NOT DISTINCT FROM $3 FOR UPDATE`, [auth.userId, fam, key]);
      const def = await client.query(`SELECT * FROM match_tolerance WHERE user_id IS NULL AND item_family IS NULL AND item_key IS NULL`);
      const base = cur.rows[0] || def.rows[0];
      const v = validateTolerance(b, base);
      if (v.errors) { await client.query('ROLLBACK'); return res.status(400).json({ ok: false, code: 'VALIDATION', field: v.errors[0].field, message: v.errors[0].message, errors: v.errors }); }
      const x = v.values;
      const cols = ['price_pct_auto', 'price_pct_review', 'qty_pct_auto', 'qty_pct_review', 'amount_abs_auto', 'date_before_auto', 'date_after_auto', 'date_before_review', 'date_after_review', 'auto_convert', 'auto_min_score', 'ambiguity_margin', 'auto_unique_no_id'];
      if (x.auto_unique_no_id == null) x.auto_unique_no_id = true;
      let row;
      if (cur.rows[0]) {
        const r = await client.query(`UPDATE match_tolerance SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_by_staff_id = $${cols.length + 2}, updated_at = NOW() WHERE id = $1 RETURNING *`,
          [cur.rows[0].id, ...cols.map((c) => x[c]), auth.staffId || null]);
        row = r.rows[0];
      } else {
        const r = await client.query(`INSERT INTO match_tolerance (user_id, item_family, item_key, ${cols.join(', ')}, updated_by_staff_id) VALUES ($1,$2,$3,${cols.map((_, i) => `$${i + 4}`).join(',')},$${cols.length + 4}) RETURNING *`,
          [auth.userId, fam, key, ...cols.map((c) => x[c]), auth.staffId || null]);
        row = r.rows[0];
      }
      await recordAudit(client, { userId: auth.userId, entityType: 'match_setting', entityId: row.id, action: cur.rows[0] ? 'update' : 'create',
        before: cur.rows[0] ? Object.fromEntries(cols.map((c) => [c, String(cur.rows[0][c])])) : null, after: Object.fromEntries(cols.map((c) => [c, String(row[c])])), note: `허용오차 ${key || fam || '전체'}` });
      await client.query('COMMIT');
      return res.json({ ok: true, data: row });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23514') return vErr(res, 'price_pct_auto', '허용오차 값이 범위를 벗어났습니다.');
      return fail(res, err, '허용오차를 저장하지 못했습니다.');
    } finally { client.release(); }
  });

  // ---- R-115 허용오차 삭제 (주인 — 기본 행은 403) ----
  app.delete('/api/purchase-match/tolerances/:id', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '허용오차를 찾을 수 없습니다.' });
    try {
      const cur = await pool.query(`SELECT user_id FROM match_tolerance WHERE id = $1`, [id]);
      if (!cur.rows[0] || (cur.rows[0].user_id != null && cur.rows[0].user_id !== auth.userId)) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '허용오차를 찾을 수 없습니다.' });
      if (cur.rows[0].user_id == null) return res.status(403).json({ ok: false, code: 'DEFAULT_ROW', message: '기본 허용오차는 지울 수 없습니다.' });
      await pool.query(`DELETE FROM match_tolerance WHERE id = $1 AND user_id = $2`, [id, auth.userId]);
      await recordAudit(pool, { userId: auth.userId, entityType: 'match_setting', entityId: id, action: 'delete', before: { id }, after: { deleted: true }, note: `허용오차 #${id} 삭제` });
      return res.json({ ok: true, data: { id } });
    } catch (err) { return fail(res, err, '허용오차를 지우지 못했습니다.'); }
  });
}

module.exports = { registerMatchSettingsRoutes, validateTolerance };
