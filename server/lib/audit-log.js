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
 *   purchase_match_event(027) 매입서 업로드·대조·매입전환·확정·취소(T-203) — kind 'purchase_match'
 *
 * T-213 직원(021):
 *   - audit_log.actor_staff_id: 직원 로그인·직원 비밀번호 설정의 실제 행위자. 직원 관리(entity_type 'staff')는 주인이 한 일이라 NULL
 *   - 직원이 등록한 매입·매출·수금은 원천 행(created_by_staff_id)에서 읽어 kind 'staff_entry' 로 보여 준다(이중 기록 없음)
 *   - 응답 행에 actor('self'|'staff'|'admin')·actor_name(직원 이름, 삭제된 직원은 "(삭제됨)")
 *   - 필터 actor=owner|staff|<직원 id>
 */
const { parseListOptions, runList } = require('./list-query');

const KINDS = ['correction', 'cancel', 'payment_cancel', 'product_request', 'partner', 'login', 'staff', 'staff_entry',
  'discount', 'offset', 'offset_cancel', // T-401 정산 할인·상계
  'excel_upload', // T-402 엑셀 업로드 한 줄(건별은 원천 행)
  'data_migration', // T-403 데이터 이관 저장·되돌림
  'purchase_match']; // T-203 매입서 대조·매입전환(purchase_match_event) + 대조 설정·경락 수집 조작(audit_log)
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
 * @param r   { userId, entityType:'account'|'auth'|'staff', entityId, action, partnerId, before, after, note, actorStaffId }
 *            actorStaffId: 직원이 한 일이면 직원 id(T-213). 없으면 열 자체를 쓰지 않는다(021 전 DB 에서도 기록되게)
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
  const withActor = r.actorStaffId != null;
  const sql = `INSERT INTO audit_log (user_id, entity_type, entity_id, action, partner_id, changed_fields, before_data, after_data, note${withActor ? ', actor_staff_id' : ''})
               VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8::jsonb, $9${withActor ? ', $10' : ''})`;
  const params = [
    r.userId, r.entityType, r.entityId ?? null, r.action, r.partnerId ?? null, fields,
    before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
    r.note ? String(r.note).slice(0, 200) : null,
  ];
  if (withActor) params.push(r.actorStaffId);
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
         tc.changed_fields, tc.before_data, tc.after_data, NULL::int AS actor_staff_id
    FROM trade_correction tc
    LEFT JOIN purchase pu ON tc.target_type = 'purchase' AND pu.id = tc.target_id AND pu.user_id = tc.user_id
    LEFT JOIN product pp ON pp.id = pu.product_id
    LEFT JOIN sale s ON tc.target_type = 'sale' AND s.id = tc.target_id AND s.user_id = tc.user_id
    LEFT JOIN product sp ON sp.id = s.product_id
   WHERE tc.user_id = $1
  UNION ALL
  SELECT 'supplier_payment', spay.id::bigint, 'payment_cancel', spay.cancelled_at, 'supplier_payment', spay.id,
         CASE WHEN spay.kind = 'opening' THEN '기초 정리 ' WHEN spay.kind = 'discount' THEN '매입 할인 ' ELSE '' END || to_char(spay.amount, 'FM999,999,999,990') || '원',
         spay.partner_id, 'self', spay.cancel_reason::text,
         ARRAY['status']::text[],
         jsonb_build_object('status', 'active', 'amount', spay.amount, 'paid_at', spay.paid_at),
         jsonb_build_object('status', 'cancelled'), NULL::int
    FROM supplier_payment spay
   WHERE spay.user_id = $1 AND spay.status = 'cancelled' AND spay.cancelled_at IS NOT NULL AND spay.kind <> 'offset' -- 상계는 offset_cancel 한 줄로
  UNION ALL
  -- T-401 매출 할인 등록·취소, 상계 등록·취소 (원천 행에서 읽는다 — 이중 기록 없음)
  SELECT 'payment', py.id::bigint, 'discount', py.created_at, 'payment', py.id,
         '매출 할인 ' || to_char(py.amount, 'FM999,999,999,990') || '원', py.partner_id, 'self', py.memo,
         ARRAY['amount']::text[], NULL::jsonb, jsonb_build_object('amount', py.amount, 'paid_at', py.paid_at), NULL::int
    FROM payment py
   WHERE py.user_id = $1 AND py.entry_kind = 'discount'
  UNION ALL
  SELECT 'payment_cancel', py.id::bigint, 'payment_cancel', py.cancelled_at, 'payment', py.id,
         '매출 할인 ' || to_char(py.amount, 'FM999,999,999,990') || '원', py.partner_id, 'self', py.cancel_reason::text,
         ARRAY['status']::text[], jsonb_build_object('status', 'active', 'amount', py.amount, 'paid_at', py.paid_at),
         jsonb_build_object('status', 'cancelled'), NULL::int
    FROM payment py
   WHERE py.user_id = $1 AND py.entry_kind = 'discount' AND py.status = 'cancelled' AND py.cancelled_at IS NOT NULL
  UNION ALL
  SELECT 'settlement_offset', so.id::bigint, 'offset', so.created_at, 'settlement_offset', so.id,
         '상계 ' || to_char(so.amount, 'FM999,999,999,990') || '원 (미수·미지급 동시 차감)', so.partner_id, 'self', so.memo,
         ARRAY['amount']::text[], NULL::jsonb, jsonb_build_object('amount', so.amount, 'offset_at', so.offset_at), NULL::int
    FROM settlement_offset so
   WHERE so.user_id = $1
  UNION ALL
  SELECT 'settlement_offset_cancel', so.id::bigint, 'offset_cancel', so.cancelled_at, 'settlement_offset', so.id,
         '상계 ' || to_char(so.amount, 'FM999,999,999,990') || '원', so.partner_id, 'self', so.cancel_reason::text,
         ARRAY['status']::text[], jsonb_build_object('status', 'active', 'amount', so.amount),
         jsonb_build_object('status', 'cancelled'), NULL::int
    FROM settlement_offset so
   WHERE so.user_id = $1 AND so.status = 'cancelled' AND so.cancelled_at IS NOT NULL
  UNION ALL
  SELECT 'product_request', pr.id::bigint, 'product_request', pr.created_at, 'product', pr.product_id,
         prod.name, NULL::int, 'self', pr.note,
         ARRAY['status']::text[], NULL::jsonb, jsonb_build_object('status', 'pending'), NULL::int
    FROM product_request pr
    LEFT JOIN product prod ON prod.id = pr.product_id
   WHERE pr.user_id = $1
  UNION ALL
  SELECT 'product_request_review', pr.id::bigint, 'product_request', pr.reviewed_at, 'product', pr.product_id,
         prod.name, NULL::int, CASE WHEN pr.reviewed_by = $1 THEN 'self' ELSE 'admin' END, pr.reject_reason,
         ARRAY['status']::text[], jsonb_build_object('status', 'pending'), jsonb_build_object('status', pr.status), NULL::int
    FROM product_request pr
    LEFT JOIN product prod ON prod.id = pr.product_id
   WHERE (pr.user_id = $1 OR pr.reviewed_by = $1) AND pr.reviewed_at IS NOT NULL AND pr.status IN ('approved', 'rejected')
  UNION ALL
  SELECT 'audit_log', al.id,
         CASE WHEN al.entity_type = 'auth' THEN 'login' WHEN al.entity_type = 'staff' THEN 'staff'
              WHEN al.entity_type = 'upload' THEN 'excel_upload' WHEN al.entity_type = 'migration' THEN 'data_migration'
              WHEN al.entity_type IN ('purchase_doc', 'match_setting', 'market_mapping', 'market_sync') THEN 'purchase_match' ELSE 'partner' END, al.created_at,
         al.entity_type::text, al.entity_id,
         CASE WHEN al.entity_type = 'auth' THEN '로그인'
              WHEN al.entity_type = 'staff' THEN COALESCE(st.name, al.after_data->>'name', al.before_data->>'name')
              WHEN al.entity_type IN ('upload', 'migration', 'purchase_doc', 'match_setting', 'market_mapping', 'market_sync') THEN al.note
              ELSE COALESCE(acc.name, al.after_data->>'name') END,
         al.partner_id, CASE WHEN al.actor_staff_id IS NULL THEN 'self' ELSE 'staff' END,
         CASE WHEN al.entity_type IN ('staff', 'upload', 'migration', 'purchase_doc', 'match_setting', 'market_mapping', 'market_sync') THEN al.note
              WHEN al.action = 'create' THEN '등록' WHEN al.action = 'update' THEN '수정' ELSE al.note END,
         al.changed_fields, al.before_data, al.after_data, al.actor_staff_id
    FROM audit_log al
    LEFT JOIN account acc ON acc.id = al.partner_id AND acc.user_id = al.user_id
    LEFT JOIN staff_account st ON al.entity_type = 'staff' AND st.id = al.entity_id AND st.owner_user_id = al.user_id
   WHERE al.user_id = $1
  UNION ALL
  SELECT 'purchase', pu.id::bigint, 'staff_entry', pu.created_at, 'purchase', pu.id, pp.name, pu.partner_id, 'staff', '매입 등록',
         ARRAY['total_amount']::text[], NULL::jsonb, jsonb_build_object('total_amount', pu.total_amount, 'quantity', pu.quantity), pu.created_by_staff_id
    FROM purchase pu LEFT JOIN product pp ON pp.id = pu.product_id
   WHERE pu.user_id = $1 AND pu.created_by_staff_id IS NOT NULL
  UNION ALL
  SELECT 'sale', s.id::bigint, 'staff_entry', s.created_at, 'sale', s.id, sp.name, s.partner_id, 'staff', '매출 등록',
         ARRAY['total_amount']::text[], NULL::jsonb, jsonb_build_object('total_amount', s.total_amount, 'quantity', s.quantity), s.created_by_staff_id
    FROM sale s LEFT JOIN product sp ON sp.id = s.product_id
   WHERE s.user_id = $1 AND s.created_by_staff_id IS NOT NULL
  UNION ALL
  SELECT 'payment', py.id::bigint, 'staff_entry', py.created_at, 'payment', py.id,
         '수금 ' || to_char(py.amount, 'FM999,999,999,990') || '원', py.partner_id, 'staff', '수금 등록',
         ARRAY['amount']::text[], NULL::jsonb, jsonb_build_object('amount', py.amount), py.created_by_staff_id
    FROM payment py
   WHERE py.user_id = $1 AND py.created_by_staff_id IS NOT NULL
  UNION ALL
  -- T-203 매입서 대조·매입전환 사건(추가만 하는 이력 표 — 이중 기록 없음)
  SELECT 'purchase_match_event', e.id::bigint, 'purchase_match', e.created_at, 'purchase_doc', e.doc_id,
         COALESCE(pd.doc_no, '매입서 #' || e.doc_id::text) || COALESCE('-' || pl.line_no::text, '') || ' ' ||
           CASE e.event_type WHEN 'UPLOAD' THEN '업로드' WHEN 'MANUAL_INPUT' THEN '직접 입력' WHEN 'MATCH' THEN '대조' WHEN 'REMATCH' THEN '재대조'
                WHEN 'AUTO_CONVERT' THEN '자동 매입 등록' WHEN 'CONVERT' THEN '매입 등록' WHEN 'MANUAL_CONFIRM' THEN '수동 확정' WHEN 'FORCE_CONFIRM' THEN '강제 확정'
                WHEN 'REJECT' THEN '매입 아님' WHEN 'CANCEL' THEN '전환 취소' WHEN 'CANCEL_VIA_PURCHASE' THEN '매입 취소로 전환 취소' WHEN 'LINE_EDIT' THEN '줄 수정'
                WHEN 'DOC_CANCEL' THEN '매입서 취소' ELSE e.event_type END,
         pd.supplier_partner_id, CASE WHEN e.actor_kind = 'STAFF' THEN 'staff' WHEN e.actor_kind = 'SYSTEM' THEN 'admin' ELSE 'self' END, e.reason::text,
         ARRAY['status']::text[], jsonb_build_object('status', e.from_status),
         jsonb_build_object('status', e.to_status, 'match_result', e.match_result, 'score', e.score, 'purchase_id', e.purchase_id, 'trade_id', e.trade_id,
                            'tolerance', e.detail->'tolerance', 'diff', e.detail->'diff'), e.actor_staff_id
    FROM purchase_match_event e
    LEFT JOIN purchase_doc pd ON pd.id = e.doc_id AND pd.user_id = e.user_id
    LEFT JOIN purchase_doc_line pl ON pl.id = e.line_id AND pl.user_id = e.user_id
   WHERE e.user_id = $1 AND e.event_type NOT IN ('MATCH', 'REMATCH')`;

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

    const actorQ = String(q.actor || '').trim();
    if (actorQ && actorQ !== 'owner' && actorQ !== 'staff' && !/^\d{1,9}$/.test(actorQ)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'actor', message: '행위자 조건이 올바르지 않습니다(owner|staff|직원 번호).' });
    }

    const params = [userId];
    const where = [];
    if (actorQ === 'owner') where.push('h.actor_staff_id IS NULL');
    else if (actorQ === 'staff') where.push('h.actor_staff_id IS NOT NULL');
    else if (actorQ) {
      params.push(Number(actorQ));
      where.push(`h.actor_staff_id = $${params.length}`);
    }
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
    const base = `SELECT h.*, a.name AS partner_name,
                         CASE WHEN st.id IS NULL THEN NULL WHEN st.status = 'deleted' THEN st.name || '(삭제됨)' ELSE st.name END AS actor_name
                    FROM (${UNION_SQL}) h
                    LEFT JOIN account a ON a.id = h.partner_id AND a.user_id = $1
                    LEFT JOIN staff_account st ON st.id = h.actor_staff_id AND st.owner_user_id = $1
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
        actor_staff_id: r.actor_staff_id,
        actor_name: r.actor_name,
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
