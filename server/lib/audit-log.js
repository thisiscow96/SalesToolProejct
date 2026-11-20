'use strict';
/**
 * T-212 변경 이력(감사 로그) — 기록 헬퍼 + 조회 API
 *
 * 기록: recordAudit(db, {...}) 한 줄. 라우트에서 바뀐 직후(같은 트랜잭션 안) 부른다.
 *   - 트랜잭션 안(client)이면 SAVEPOINT 로 감싸 기록 실패가 업무 저장을 되돌리지 않게 한다(경고 로그만).
 *     (019 적용 전 서버가 먼저 배포돼도 거래처 수정·로그인이 막히지 않게 — 보고서 "설계 판단")
 *   - 수정(update)인데 실제로 바뀐 값이 없으면 남기지 않는다.
 *
 * 조회: GET /api/history  (로그인 필수, 항상 본인 기록만)
 *   from_date, to_date  YYYY-MM-DD (KST, 둘 다 선택)
 *   kind                correction | cancel | payment_cancel | product_request | partner | login (선택, 없으면 전체)
 *   partner_id          거래처(선택) — 본인 거래처가 아니면 결과 0건
 *   limit, offset       T-211 방식(list-query). 지정하지 않으면 50건 첫 쪽
 * 응답: { ok, data:[{ source, source_id, kind, occurred_at, target_type, target_id, target_label,
 *                     partner_id, partner_name, actor, reason, changes:[{field,before,after}] }], total, limit, offset }
 *
 * 재사용하는 기존 기록(이중 기록 없음):
 *   trade_correction(010) 매입·매출 수정·취소 / supplier_payment(014) 지급 취소 / product_request(016) 품목 요청·승인·반려
 *   audit_log(019) 거래처 등록·수정, 로그인 성공
 */
const { parseListOptions, runList } = require('./list-query');

const KINDS = ['correction', 'cancel', 'payment_cancel', 'product_request', 'partner', 'login'];
const SKIP_FIELDS = new Set(['id', 'user_id', 'created_at', 'updated_at']);

function same(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/** before/after 에서 바뀐 열 이름 (id·user_id·시각 열 제외). before 가 없으면(등록) after 의 값 있는 열 */
function diffFields(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = [];
  for (const k of keys) {
    if (SKIP_FIELDS.has(k)) continue;
    const b = before ? before[k] : undefined;
    const a = after ? after[k] : undefined;
    if (!before) {
      if (a != null && a !== '') out.push(k);
    } else if (after && k in after && !same(b, a)) {
      out.push(k);
    }
  }
  return out;
}

function pick(obj, fields) {
  if (!obj) return null;
  const o = {};
  fields.forEach((k) => {
    o[k] = obj[k] === undefined ? null : obj[k];
  });
  return o;
}

function isPool(db) {
  return db && typeof db.totalCount === 'number';
}

/**
 * 감사 기록 한 줄.
 * @param db  pg Pool(트랜잭션 밖) 또는 BEGIN 한 client(트랜잭션 안)
 * @param r   { userId, entityType:'account'|'auth', entityId, action:'create'|'update'|'login', partnerId, before, after, note }
 * @returns  true(기록) | false(바뀐 값 없음·실패)
 */
async function recordAudit(db, r) {
  let fields = [];
  let before = null;
  let after = null;
  if (r.action !== 'login') {
    fields = diffFields(r.before, r.after);
    if (fields.length === 0) return false;
    before = r.before ? pick(r.before, fields) : null;
    after = pick(r.after, fields);
  }
  const sql = `INSERT INTO audit_log (user_id, entity_type, entity_id, action, partner_id, changed_fields, before_data, after_data, note)
               VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8::jsonb, $9)`;
  const params = [
    r.userId, r.entityType, r.entityId ?? null, r.action, r.partnerId ?? null, fields,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
    r.note ? String(r.note).slice(0, 200) : null,
  ];
  if (isPool(db)) {
    try {
      await db.query(sql, params);
      return true;
    } catch (err) {
      console.warn('[audit] 기록 실패(업무는 계속):', err.code || '', err.message);
      return false;
    }
  }
  await db.query('SAVEPOINT audit_log_sp');
  try {
    await db.query(sql, params);
    await db.query('RELEASE SAVEPOINT audit_log_sp');
    return true;
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT audit_log_sp').catch(() => {});
    console.warn('[audit] 기록 실패(업무는 계속):', err.code || '', err.message);
    return false;
  }
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
function validYmd(s) {
  if (!YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * 합친 이력 SQL. $1 = 본인 user_id. 모든 갈래가 user_id = $1 로 걸러진다(남의 이력 차단).
 * 열: source, source_id, kind, occurred_at, target_type, target_id, target_label, partner_id, actor,
 *     reason, changed_fields, before_data, after_data
 */
const UNION_SQL = `
  SELECT 'trade_correction'::text AS source, tc.id::bigint AS source_id,
         CASE WHEN tc.action = 'cancel' THEN 'cancel' ELSE 'correction' END AS kind,
         tc.created_at AS occurred_at, tc.target_type::text AS target_type, tc.target_id,
         COALESCE(pp.name, sp.name) AS target_label,
         COALESCE(pu.partner_id, s.partner_id) AS partner_id,
         'self'::text AS actor, tc.reason::text AS reason,
         tc.changed_fields, tc.before_data, tc.after_data
    FROM trade_correction tc
    LEFT JOIN purchase pu ON tc.target_type = 'purchase' AND pu.id = tc.target_id AND pu.user_id = tc.user_id
    LEFT JOIN product pp ON pp.id = pu.product_id
    LEFT JOIN sale s ON tc.target_type = 'sale' AND s.id = tc.target_id AND s.user_id = tc.user_id
    LEFT JOIN product sp ON sp.id = s.product_id
   WHERE tc.user_id = $1
  UNION ALL
  SELECT 'supplier_payment', spay.id::bigint, 'payment_cancel', spay.cancelled_at, 'supplier_payment', spay.id,
         CASE WHEN spay.kind = 'opening' THEN '기초 정리 ' ELSE '' END || to_char(spay.amount, 'FM999,999,999,990') || '원',
         spay.partner_id, 'self', spay.cancel_reason::text,
         ARRAY['status']::text[],
         jsonb_build_object('status', 'active', 'amount', spay.amount, 'paid_at', spay.paid_at),
         jsonb_build_object('status', 'cancelled')
    FROM supplier_payment spay
   WHERE spay.user_id = $1 AND spay.status = 'cancelled' AND spay.cancelled_at IS NOT NULL
  UNION ALL
  SELECT 'product_request', pr.id::bigint, 'product_request', pr.created_at, 'product', pr.product_id,
         prod.name, NULL::int, 'self', pr.note,
         ARRAY['status']::text[], NULL::jsonb, jsonb_build_object('status', 'pending')
    FROM product_request pr
    LEFT JOIN product prod ON prod.id = pr.product_id
   WHERE pr.user_id = $1
  UNION ALL
  SELECT 'product_request_review', pr.id::bigint, 'product_request', pr.reviewed_at, 'product', pr.product_id,
         prod.name, NULL::int, CASE WHEN pr.reviewed_by = $1 THEN 'self' ELSE 'admin' END, pr.reject_reason,
         ARRAY['status']::text[], jsonb_build_object('status', 'pending'), jsonb_build_object('status', pr.status)
    FROM product_request pr
    LEFT JOIN product prod ON prod.id = pr.product_id
   WHERE (pr.user_id = $1 OR pr.reviewed_by = $1) AND pr.reviewed_at IS NOT NULL AND pr.status IN ('approved', 'rejected')
  UNION ALL
  SELECT 'audit_log', al.id, CASE WHEN al.entity_type = 'auth' THEN 'login' ELSE 'partner' END, al.created_at,
         al.entity_type::text, al.entity_id,
         CASE WHEN al.entity_type = 'auth' THEN '로그인' ELSE COALESCE(acc.name, al.after_data->>'name') END,
         al.partner_id, 'self',
         CASE WHEN al.action = 'create' THEN '등록' WHEN al.action = 'update' THEN '수정' ELSE al.note END,
         al.changed_fields, al.before_data, al.after_data
    FROM audit_log al
    LEFT JOIN account acc ON acc.id = al.partner_id AND acc.user_id = al.user_id
   WHERE al.user_id = $1`;

/** 화면에 내보내는 모양: 바뀐 열마다 전·후 값 (정정의 _row 같은 내부 값은 뺀다) */
function toChanges(row) {
  const fields = Array.isArray(row.changed_fields) ? row.changed_fields : [];
  const b = row.before_data || {};
  const a = row.after_data || {};
  return fields
    .filter((f) => !String(f).startsWith('_'))
    .map((f) => ({ field: f, before: b[f] === undefined ? null : b[f], after: a[f] === undefined ? null : a[f] }));
}

function registerAuditRoutes(app, { pool, getUserId }) {
  app.get('/api/history', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const q = req.query || {};
    const opts = parseListOptions({ limit: q.limit, offset: q.offset });
    if (opts.error) return res.status(400).json(opts.error);
    if (!opts.paged) {
      opts.paged = true;
      opts.limit = 50;
    }
    const from = String(q.from_date || '').trim();
    const to = String(q.to_date || '').trim();
    if (from && !validYmd(from)) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'from_date', message: '시작일 형식이 올바르지 않습니다(YYYY-MM-DD).' });
    if (to && !validYmd(to)) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'to_date', message: '종료일 형식이 올바르지 않습니다(YYYY-MM-DD).' });
    if (from && to && from > to) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'from_date', message: '시작일이 종료일보다 늦습니다.' });
    const kind = String(q.kind || '').trim();
    if (kind && !KINDS.includes(kind)) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'kind', message: '종류가 올바르지 않습니다.' });
    let partnerId = null;
    if (q.partner_id != null && String(q.partner_id).trim() !== '') {
      const s = String(q.partner_id).trim();
      if (!/^\d{1,9}$/.test(s) || Number(s) <= 0) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'partner_id', message: '거래처 번호가 올바르지 않습니다.' });
      partnerId = Number(s);
    }

    const params = [userId];
    const where = [];
    if (from) {
      params.push(from);
      where.push(`h.occurred_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'Asia/Seoul'`);
    }
    if (to) {
      params.push(to);
      where.push(`h.occurred_at < (($${params.length}::date + 1))::timestamp AT TIME ZONE 'Asia/Seoul'`);
    }
    if (kind) {
      params.push(kind);
      where.push(`h.kind = $${params.length}`);
    }
    if (partnerId) {
      params.push(partnerId);
      where.push(`h.partner_id = $${params.length}`);
    }
    const base = `SELECT h.*, a.name AS partner_name
                    FROM (${UNION_SQL}) h
                    LEFT JOIN account a ON a.id = h.partner_id AND a.user_id = $1
                   ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    try {
      const out = await runList(pool, base, params, ' ORDER BY h.occurred_at DESC, h.source, h.source_id DESC', opts);
      out.data = out.data.map((r) => ({
        source: r.source,
        source_id: Number(r.source_id),
        kind: r.kind,
        occurred_at: r.occurred_at,
        target_type: r.target_type,
        target_id: r.target_id,
        target_label: r.target_label,
        partner_id: r.partner_id,
        partner_name: r.partner_name,
        actor: r.actor,
        reason: r.reason,
        changes: toChanges(r),
      }));
      res.json(out);
    } catch (err) {
      console.error('GET history error:', err);
      res.status(500).json({ ok: false, message: '변경 이력을 불러오지 못했습니다.' });
    }
  });
}

module.exports = { recordAudit, registerAuditRoutes, diffFields, KINDS };
