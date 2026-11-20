/**
 * 매입처 지급(미지급금) · 지급 원장 API (T-201) — 설계 `T-201_지급_설계.md` 5장
 *
 *  POST /api/supplier-payments              지급 등록(수동 배분 · 자동 배분 · 기초 정리)
 *  GET  /api/supplier-payments              지급 목록(기간·매입처·취소 포함)
 *  POST /api/supplier-payments/:id/cancel   지급 취소(배분 행은 남기고 매입 지급액 원복)
 *  GET  /api/partners/:id/payable-ledger    매입처 1곳의 줄 돈 장부(매입 + · 지급 −, 행별 잔액 누계) — T-104 원장 대칭
 *  GET  /api/payables/aging                 매입처별 미지급을 매입일 기준 0–30 / 31–60 / 61–90 / 91+ 구간으로
 *
 * 원칙
 *  - 모든 쿼리에 user_id 조건(남의 매입처·매입·지급은 404 — T-114)
 *  - 금액 비교·합계는 DB NUMERIC(D-03). JS 에서 더하지 않는다. 응답 직전에만 Number
 *  - 잠금 순서(RULE-15): supplier_payment(id 오름차순) → purchase(id 오름차순) → sale → inventory
 *  - 지급 원장 뷰 supplier_ledger_entry · 매입처 미지급 뷰 payables_by_partner 는 마이그레이션 014
 *
 * index.js 와 파일을 나눈 이유: T-216(품목·관리자)이 같은 시기에 index.js 를 고쳐 병합 충돌을 줄이려고.
 */
const { AGING_BUCKETS, LEDGER_MAX_ROWS, money } = require('./ledger-routes');

/** 매입 가능한 거래처 유형(index.js PURCHASE_PARTNER_TYPES 와 같음) — RULE-01 */
const PAYABLE_PARTNER_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market']);
const PAY_METHODS = ['cash', 'transfer', 'bill', 'other'];
/** RULE-10 지급 방법 기본값 [가정 T201-U-6] */
const DEFAULT_PAY_METHOD = 'transfer';
const REASON_MAX = 200;
const MEMO_MAX = 500;
const OPENING_MEMO = '기초 정리';

/**
 * 미지급 연령 대상 매입 CTE — 연령 API와 대시보드가 같은 정의를 쓴다(RULE-13).
 * 대상 = 취소 안 된 매입 중 미지급 > 0. 기준일 = 매입일
 * 매개변수: $1 user_id · $2 기준일(KST 오늘, 'YYYY-MM-DD') · $3 partner_id(없으면 NULL)
 */
const PAYABLE_DUE_CTE = `
        WITH pdue AS (
          SELECT pu.id, pu.partner_id, pu.purchase_date, pu.product_id, pu.quantity,
                 pu.total_amount, pu.paid_amount,
                 (pu.total_amount - pu.paid_amount)        AS due,
                 GREATEST($2::date - pu.purchase_date, 0)  AS days
          FROM purchase pu
          WHERE pu.user_id = $1
            AND pu.status = 'active'
            AND pu.payment_status IN ('unpaid', 'partial')
            AND pu.total_amount - pu.paid_amount > 0
            AND ($3::int IS NULL OR pu.partner_id = $3::int)
        )`;

const KIND_LABEL = {
  purchase: '매입',
  payment: '지급',
  opening: '기초 정리',
  discount: '매입 할인', // T-401
  offset: '상계',
  purchase_cancelled: '취소 매입',
  payment_cancelled: '취소 지급',
};
const METHOD_LABEL = { cash: '현금', transfer: '계좌이체', bill: '어음', other: '기타' };

function payError(httpStatus, code, message, extra) {
  return Object.assign(new Error(message), { httpStatus, payCode: code, extra: extra || undefined });
}

/** 오류 응답 { ok:false, code, message, field?, ...추가 칸 } — T-103 형식에 맞추되 추가 칸은 위로 올린다(detail 에도 같이) */
function sendPayError(res, err, fallback) {
  if (err && err.httpStatus) {
    const body = { ok: false, code: err.payCode, message: err.message };
    if (err.extra) {
      Object.assign(body, err.extra);
      body.detail = err.extra;
    }
    return res.status(err.httpStatus).json(body);
  }
  if (err && err.code === '23514') {
    // CHECK 위반(동시 지급의 최후 방어선 purchase_paid_range 등) — 500 대신 409
    console.error('[supplier-payment check]', err.constraint || '', err.message);
    return res.status(409).json({
      ok: false,
      code: 'DATA_NEEDS_FIX',
      message: '지급액이 매입 금액을 넘게 됩니다. 새로고침 후 다시 시도하세요.',
      detail: err.constraint ? { constraint: err.constraint } : undefined,
    });
  }
  console.error(fallback, err);
  return res.status(500).json({ ok: false, message: fallback });
}

const vErr = (field, message) => payError(400, 'VALIDATION', message, { field });

/** 양의 정수 id. 아니면 null */
function parseId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return n > 0 && n <= 2147483647 ? n : null;
}

/** 금액 — 숫자·문자열 모두 받아 소수 2자리까지의 양수 문자열로(그대로 SQL NUMERIC 에 넘긴다). 틀리면 null */
function parseMoney(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && !Number.isFinite(raw)) return null;
  const s = String(raw).trim().replace(/,/g, '');
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  if (!/[1-9]/.test(s)) return null; // 0 금지
  return s;
}

/** 'YYYY-MM-DD' 실제 날짜만. 비어 있으면 undefined, 틀리면 null */
function parseDateParam(raw) {
  if (raw == null || String(raw).trim() === '') return undefined;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return s;
}

const isTrue = (v) => v === '1' || v === 'true' || v === true;
const num = (v) => (v == null ? null : Number(v));
const fmt = (n) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 3 });

/**
 * 매입 지급 상태 다시 계산(RULE-06) — paid = 0 → unpaid, 0 < paid < total → partial, paid ≥ total → paid(총액 0원 포함)
 * 지급 등록·취소·매입 수정(index.js PATCH)이 같은 함수를 쓴다. 상태가 바뀌는 행만 고친다.
 */
async function syncPurchasePaymentStatus(client, purchaseIds) {
  const ids = (Array.isArray(purchaseIds) ? purchaseIds : [purchaseIds]).filter((x) => x != null);
  if (!ids.length) return;
  await client.query(
    `UPDATE purchase SET payment_status = x.st, updated_at = NOW()
       FROM (SELECT id,
                    CASE WHEN paid_amount >= total_amount THEN 'paid'::payment_status
                         WHEN paid_amount > 0 THEN 'partial'::payment_status
                         ELSE 'unpaid'::payment_status END AS st
               FROM purchase WHERE id = ANY($1::int[])) x
      WHERE purchase.id = x.id AND purchase.payment_status IS DISTINCT FROM x.st`,
    [ids]
  );
}

/** 매입에 걸린(취소 안 된) 지급 목록 — 매입 정정 409 본문용(RULE-07) */
async function activePaymentsOfPurchase(client, userId, purchaseId) {
  const r = await client.query(
    `SELECT sp.id, sp.paid_at, sp.kind, sp.amount, spa.amount AS allocated
       FROM supplier_payment_allocation spa
       JOIN supplier_payment sp ON sp.id = spa.supplier_payment_id AND sp.user_id = spa.user_id
      WHERE spa.purchase_id = $1 AND spa.user_id = $2 AND sp.status = 'active'
      ORDER BY sp.paid_at, sp.id`,
    [purchaseId, userId]
  );
  return r.rows.map((x) => ({ id: x.id, paid_at: x.paid_at, kind: x.kind, amount: money(x.amount), allocated: money(x.allocated) }));
}

/** 매입처의 미지급 합(취소 안 된 매입) — NUMERIC 문자열 */
async function partnerPayable(client, userId, partnerId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(total_amount - paid_amount), 0)::text AS due
       FROM purchase WHERE user_id = $1 AND partner_id = $2 AND status = 'active'`,
    [userId, partnerId]
  );
  return r.rows[0].due;
}

function readBodyCommon(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const partnerId = parseId(b.partner_id);
  if (!partnerId) throw vErr('partner_id', '매입처를 선택하세요.');
  const kind = b.kind == null || b.kind === '' ? 'pay' : String(b.kind);
  // T-401 P-01: discount(지급 할인) 추가. offset 은 상계 등록(/api/offsets)에서만
  if (kind === 'offset') throw vErr('kind', '상계는 상계 등록에서 하세요.');
  if (!['pay', 'opening', 'discount'].includes(kind)) throw vErr('kind', '지급 종류가 올바르지 않습니다.');
  let memo = b.memo == null ? null : String(b.memo).trim();
  if (memo === '') memo = null;
  if (memo && memo.length > MEMO_MAX) throw vErr('memo', `메모는 ${MEMO_MAX}자 이내로 입력하세요.`);
  return { b, partnerId, kind, memo };
}

function registerPayableRoutes(app, { pool, getUserId, kstToday, connectOr503, parsePaidAtInput }) {
  // ---------------- 지급 등록 (W-03) ----------------
  app.post('/api/supplier-payments', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });

    let input;
    try {
      const { b, partnerId, kind, memo } = readBodyCommon(req.body);
      input = { partnerId, kind, memo };
      if (kind === 'opening') {
        // RULE-11 기초 정리 — 금액·배분은 서버가 정한다
        if (b.amount != null && b.amount !== '') throw vErr('amount', '기초 정리는 금액을 넣지 않습니다(기준일까지의 미지급 전부).');
        if (Array.isArray(b.allocations) && b.allocations.length) throw vErr('allocations', '기초 정리는 배분을 넣지 않습니다.');
        const through = parseDateParam(b.through_date);
        if (!through) throw vErr('through_date', '기준일(YYYY-MM-DD)을 입력하세요.');
        input.throughDate = through;
        input.method = null;
      } else {
        const amount = parseMoney(b.amount);
        if (!amount) throw vErr('amount', '지급액은 0보다 큰 금액(소수 2자리까지)으로 입력하세요.');
        input.amount = amount;
        if (b.paid_at == null || String(b.paid_at).trim() === '') {
          input.paidAt = new Date();
        } else {
          const d = parsePaidAtInput(b.paid_at);
          if (!d || Number.isNaN(d.getTime())) throw vErr('paid_at', '지급일시 형식이 올바르지 않습니다.');
          input.paidAt = d;
        }
        if (kind === 'discount') {
          // T-401 P-03: 할인은 현금이 아니라 지급 방법이 없다 — 보내면 조용히 버리지 않고 400
          if (b.method != null && b.method !== '') throw vErr('method', '할인에는 지급 방법이 없습니다.');
          input.method = null;
        } else {
          const method = b.method == null || b.method === '' ? DEFAULT_PAY_METHOD : String(b.method);
          if (!PAY_METHODS.includes(method)) throw vErr('method', '지급 방법이 올바르지 않습니다.');
          input.method = method;
        }
        if (b.allocations != null && !Array.isArray(b.allocations)) throw vErr('allocations', '배분 형식이 올바르지 않습니다.');
        const allocs = Array.isArray(b.allocations) ? b.allocations : [];
        if (allocs.length) {
          const seen = new Set();
          input.allocations = allocs.map((a) => {
            const pid = parseId(a?.purchase_id);
            const am = parseMoney(a?.amount);
            if (!pid || !am) throw vErr('allocations', '배분 행마다 매입 번호와 0보다 큰 금액이 필요합니다.');
            if (seen.has(pid)) throw vErr('allocations', `매입 #${pid} 가 두 번 들어 있습니다. 한 행으로 합쳐 보내세요.`);
            seen.add(pid);
            return { purchase_id: pid, amount: am };
          });
          if (input.allocations.length > 500) throw vErr('allocations', '한 번에 배분할 수 있는 매입은 500건까지입니다.');
        }
      }
    } catch (err) {
      return sendPayError(res, err, '지급 등록에 실패했습니다.');
    }

    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      const pr = await client.query('SELECT id, name, type FROM account WHERE id = $1 AND user_id = $2', [input.partnerId, userId]);
      const partner = pr.rows[0];
      if (!partner) throw payError(404, 'NOT_FOUND', '매입처를 찾을 수 없습니다.');
      if (!PAYABLE_PARTNER_TYPES.has(partner.type)) throw vErr('partner_id', '매입 가능한 거래처(공급·도매 등)에만 지급할 수 있습니다.');

      let plan; // [{ purchase_id, amount(문자열) }]
      let amount;
      let paidAt = input.paidAt;

      if (input.allocations) {
        // ---- 수동 배분: 배분 합 = 지급액(NUMERIC 정확히, RULE-03)
        const sum = await client.query(
          `SELECT (SELECT SUM(x) FROM unnest($1::numeric[]) x) = $2::numeric AS same,
                  (SELECT SUM(x) FROM unnest($1::numeric[]) x)::text AS s`,
          [input.allocations.map((a) => a.amount), input.amount]
        );
        if (!sum.rows[0].same) {
          throw vErr('allocations', `배분 합계(${fmt(sum.rows[0].s)})가 지급액(${fmt(input.amount)})과 같아야 합니다.`);
        }
        const ids = input.allocations.map((a) => a.purchase_id).sort((x, y) => x - y);
        const lk = await client.query(
          `SELECT id, partner_id, status, (total_amount - paid_amount)::text AS due
             FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
          [userId, ids]
        );
        const byId = new Map(lk.rows.map((r) => [r.id, r]));
        const missing = ids.find((id) => !byId.has(id));
        if (missing) throw payError(404, 'NOT_FOUND', `매입 #${missing} 을(를) 찾을 수 없습니다.`, { purchase_id: missing });
        for (const a of input.allocations) {
          const p = byId.get(a.purchase_id);
          if (p.status !== 'active') {
            throw payError(400, 'PURCHASE_NOT_PAYABLE', `매입 #${p.id} 는 취소된 매입이라 지급할 수 없습니다.`, { purchase_id: p.id });
          }
          if (p.partner_id !== input.partnerId) {
            throw payError(400, 'PURCHASE_NOT_PAYABLE', `매입 #${p.id} 는 선택한 매입처의 매입이 아닙니다.`, { purchase_id: p.id });
          }
        }
        // 잠근 뒤 남은 미지급과 비교(DB NUMERIC)
        const over = await client.query(
          `SELECT a.pid, p.due::text AS due
             FROM unnest($1::int[], $2::numeric[]) AS a(pid, amt)
             JOIN (SELECT id, total_amount - paid_amount AS due FROM purchase WHERE id = ANY($1::int[])) p ON p.id = a.pid
            WHERE a.amt > p.due
            ORDER BY a.pid LIMIT 1`,
          [input.allocations.map((a) => a.purchase_id), input.allocations.map((a) => a.amount)]
        );
        if (over.rows[0]) {
          const o = over.rows[0];
          throw payError(400, 'ALLOC_OVER_DUE', `매입 #${o.pid} 의 남은 미지급(${fmt(o.due)})보다 많이 배분할 수 없습니다.`, {
            field: 'allocations',
            purchase_id: o.pid,
            due: money(o.due),
          });
        }
        plan = input.allocations;
        amount = input.amount;
      } else {
        // ---- 자동 배분(RULE-04) · 기초 정리(RULE-11): ① 대상 id 조회(잠금 없음) → ② id 순 잠금 → ③ 잠근 값으로 오래된 순 배분
        const through = input.kind === 'opening' ? input.throughDate : null;
        const c0 = await client.query(
          `SELECT id FROM purchase
            WHERE user_id = $1 AND partner_id = $2 AND status = 'active'
              AND payment_status IN ('unpaid', 'partial') AND total_amount - paid_amount > 0
              AND ($3::date IS NULL OR purchase_date <= $3::date)
            ORDER BY id`,
          [userId, input.partnerId, through]
        );
        const ids = c0.rows.map((r) => r.id);
        if (!ids.length) {
          throw payError(400, 'NOTHING_TO_PAY', through ? `${through}까지 지급할 매입이 없습니다.` : '이 매입처에 지급할 매입이 없습니다.', { max_amount: 0 });
        }
        await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`, [userId, ids]);
        // 잠근 값으로 다시: 아직 대상인 것만, 오래된 순 누계로 배분
        const al = await client.query(
          `WITH t AS (
             SELECT id, purchase_date, (total_amount - paid_amount) AS due
               FROM purchase
              WHERE id = ANY($1::int[]) AND partner_id = $2 AND status = 'active' AND total_amount - paid_amount > 0
           ), c AS (
             SELECT id, due, SUM(due) OVER (ORDER BY purchase_date, id) AS cum FROM t
           )
           SELECT id, due::text AS due,
                  (CASE WHEN $3::numeric IS NULL THEN due
                        ELSE LEAST(due, GREATEST($3::numeric - (cum - due), 0)) END)::text AS amt,
                  (SELECT COALESCE(SUM(due), 0) FROM t)::text AS total_due,
                  ($3::numeric IS NOT NULL AND $3::numeric > (SELECT COALESCE(SUM(due), 0) FROM t)) AS overpay
             FROM c ORDER BY cum, id`,
          [ids, input.partnerId, input.kind === 'opening' ? null : input.amount]
        );
        if (!al.rows.length) throw payError(400, 'NOTHING_TO_PAY', '이 매입처에 지급할 매입이 없습니다.', { max_amount: 0 });
        if (al.rows[0].overpay) {
          const maxAmt = al.rows[0].total_due;
          throw payError(400, 'OVERPAY', input.kind === 'discount' ? `할인액이 미지급 합계(${fmt(maxAmt)})보다 많습니다.` : `지급액이 미지급 합계(${fmt(maxAmt)})보다 많습니다. 선급금은 아직 기록할 수 없습니다.`, {
            field: 'amount',
            max_amount: money(maxAmt),
          });
        }
        plan = al.rows.filter((r) => Number(r.amt) > 0).map((r) => ({ purchase_id: r.id, amount: r.amt }));
        if (input.kind === 'opening') {
          amount = al.rows[0].total_due;
          const ts = await client.query(`SELECT (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul') - interval '1 second' AS t`, [input.throughDate]);
          paidAt = ts.rows[0].t;
        } else {
          amount = input.amount;
        }
      }

      const memo = input.kind === 'opening' ? (input.memo ? `${OPENING_MEMO} — ${input.memo}`.slice(0, MEMO_MAX) : OPENING_MEMO) : input.memo;
      const ins = await client.query(
        `INSERT INTO supplier_payment (user_id, partner_id, amount, paid_at, kind, method, memo)
         VALUES ($1, $2, $3::numeric, $4, $5, $6, $7) RETURNING id`,
        [userId, input.partnerId, amount, paidAt, input.kind, input.method, memo]
      );
      const paymentId = ins.rows[0].id;
      const pids = plan.map((a) => a.purchase_id);
      const amts = plan.map((a) => a.amount);
      await client.query(
        `INSERT INTO supplier_payment_allocation (user_id, supplier_payment_id, purchase_id, amount)
         SELECT $1, $2, a.pid, a.amt FROM unnest($3::int[], $4::numeric[]) AS a(pid, amt)`,
        [userId, paymentId, pids, amts]
      );
      await client.query(
        `UPDATE purchase pu SET paid_amount = pu.paid_amount + a.amt, updated_at = NOW()
           FROM unnest($1::int[], $2::numeric[]) AS a(pid, amt)
          WHERE pu.id = a.pid AND pu.user_id = $3`,
        [pids, amts, userId]
      );
      await syncPurchasePaymentStatus(client, pids);
      const after = await client.query(
        `SELECT id, payment_status, paid_amount::text AS paid_amount FROM purchase WHERE id = ANY($1::int[])`,
        [pids]
      );
      const st = new Map(after.rows.map((r) => [r.id, r]));
      const left = await partnerPayable(client, userId, input.partnerId);
      const head = await client.query('SELECT paid_at, created_at FROM supplier_payment WHERE id = $1', [paymentId]);
      await client.query('COMMIT');
      res.status(201).json({
        ok: true,
        data: {
          id: paymentId,
          kind: input.kind,
          partner_id: input.partnerId,
          partner_name: partner.name,
          amount: money(amount),
          paid_at: head.rows[0].paid_at,
          method: input.method,
          memo,
          allocations: plan.map((a) => ({
            purchase_id: a.purchase_id,
            amount: money(a.amount),
            paid_amount: money(st.get(a.purchase_id)?.paid_amount),
            payment_status: st.get(a.purchase_id)?.payment_status,
          })),
          partner_payable_after: money(left),
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      sendPayError(res, err, '지급 등록에 실패했습니다.');
    } finally {
      client.release();
    }
  });

  // ---------------- 지급 목록 (W-04) ----------------
  app.get('/api/supplier-payments', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const from = parseDateParam(req.query.from_date);
    const to = parseDateParam(req.query.to_date);
    if (from === null) return sendPayError(res, vErr('from_date', '시작일 형식이 올바르지 않습니다(YYYY-MM-DD).'));
    if (to === null) return sendPayError(res, vErr('to_date', '종료일 형식이 올바르지 않습니다(YYYY-MM-DD).'));
    const hasPartner = req.query.partner_id != null && String(req.query.partner_id).trim() !== '';
    const partnerId = hasPartner ? parseId(req.query.partner_id) : null;
    if (hasPartner && !partnerId) return sendPayError(res, vErr('partner_id', '매입처 번호가 올바르지 않습니다.'));
    const includeCancelled = isTrue(req.query.include_cancelled);
    try {
      // 지급일시는 timestamptz — 날짜 필터는 한국 날짜 기준 범위 비교(수금 목록과 같음, D-05)
      const r = await pool.query(
        `SELECT sp.id, sp.paid_at, sp.created_at, sp.amount, sp.kind, sp.method, sp.memo, sp.status, sp.offset_id,
                sp.cancelled_at, sp.cancel_reason, sp.updated_at, sp.partner_id, a.name AS partner_name,
                COALESCE((
                  SELECT json_agg(json_build_object(
                           'purchase_id', spa.purchase_id,
                           'purchase_date', to_char(pu.purchase_date, 'YYYY-MM-DD'),
                           'product_name', p.name,
                           'amount', spa.amount) ORDER BY pu.purchase_date, spa.purchase_id)
                    FROM supplier_payment_allocation spa
                    JOIN purchase pu ON pu.id = spa.purchase_id
                    LEFT JOIN product p ON p.id = pu.product_id
                   WHERE spa.supplier_payment_id = sp.id), '[]'::json) AS allocations
           FROM supplier_payment sp
           JOIN account a ON a.id = sp.partner_id AND a.user_id = sp.user_id
          WHERE sp.user_id = $1
            AND ($2::date IS NULL OR sp.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul'))
            AND ($3::date IS NULL OR sp.paid_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))
            AND ($4::int IS NULL OR sp.partner_id = $4::int)
            AND ($5::boolean OR sp.status = 'active')
          ORDER BY sp.paid_at DESC, sp.id DESC`,
        [userId, from || null, to || null, partnerId, includeCancelled]
      );
      const data = r.rows.map((x) => ({
        ...x,
        amount: money(x.amount),
        allocations: (x.allocations || []).map((a) => ({ ...a, amount: money(a.amount) })),
      }));
      res.json({ ok: true, data });
    } catch (err) {
      sendPayError(res, err, '지급정보를 불러오지 못했습니다.');
    }
  });

  // ---------------- 지급 취소 (W-05) ----------------
  app.post('/api/supplier-payments/:id/cancel', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const id = parseId(req.params.id);
    let reason;
    try {
      if (!id) throw vErr('id', '지급 번호가 올바르지 않습니다.');
      reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
      if (!reason) throw vErr('reason', '취소 사유를 입력하세요.');
      if (reason.length > REASON_MAX) throw vErr('reason', `취소 사유는 ${REASON_MAX}자 이내로 입력하세요.`);
    } catch (err) {
      return sendPayError(res, err, '지급 취소에 실패했습니다.');
    }
    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      const sr = await client.query(
        `SELECT id, partner_id, status, kind, offset_id, (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_epoch_ms
           FROM supplier_payment WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, userId]
      );
      const sp = sr.rows[0];
      if (!sp) throw payError(404, 'NOT_FOUND', '지급을 찾을 수 없습니다.');
      if (sp.status === 'cancelled') throw payError(409, 'ALREADY_CANCELLED', '이미 취소된 지급입니다.');
      // T-401 P-05: 상계 지급 쪽만 취소하면 미수·미지급이 어긋난다 — 상계 취소에서 함께
      if (sp.kind === 'offset') throw payError(409, 'USE_OFFSET_CANCEL', '상계 취소에서 함께 취소하세요.', { offset_id: sp.offset_id });
      const expected = req.body?.expected_updated_at;
      if (expected != null && expected !== '') {
        const exp = Date.parse(String(expected));
        if (!Number.isFinite(exp)) throw vErr('expected_updated_at', 'expected_updated_at 형식이 올바르지 않습니다.');
        if (Math.abs(Math.floor(Number(sp.updated_epoch_ms)) - exp) >= 1) {
          throw payError(409, 'STALE_DATA', '다른 곳에서 먼저 바뀌었습니다. 최신 내용으로 다시 불러온 뒤 시도하세요.');
        }
      }
      const al = await client.query(
        `SELECT purchase_id, amount::text AS amount FROM supplier_payment_allocation
          WHERE supplier_payment_id = $1 AND user_id = $2 ORDER BY purchase_id`,
        [id, userId]
      );
      const pids = al.rows.map((r) => r.purchase_id);
      if (pids.length) {
        await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`, [userId, pids]);
      }
      await client.query(
        `UPDATE supplier_payment SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1, updated_at = NOW() WHERE id = $2`,
        [reason, id]
      );
      if (pids.length) {
        await client.query(
          `UPDATE purchase pu SET paid_amount = pu.paid_amount - a.amt, updated_at = NOW()
             FROM unnest($1::int[], $2::numeric[]) AS a(pid, amt)
            WHERE pu.id = a.pid AND pu.user_id = $3`,
          [pids, al.rows.map((r) => r.amount), userId]
        );
        await syncPurchasePaymentStatus(client, pids);
      }
      const after = pids.length
        ? await client.query(
          `SELECT id, paid_amount::text AS paid_amount, payment_status FROM purchase WHERE id = ANY($1::int[]) ORDER BY id`,
          [pids]
        )
        : { rows: [] };
      const left = await partnerPayable(client, userId, sp.partner_id);
      await client.query('COMMIT');
      res.json({
        ok: true,
        data: {
          id,
          status: 'cancelled',
          cancel_reason: reason,
          purchases: after.rows.map((r) => ({ id: r.id, paid_amount: money(r.paid_amount), payment_status: r.payment_status })),
          partner_payable_after: money(left),
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      sendPayError(res, err, '지급 취소에 실패했습니다.');
    } finally {
      client.release();
    }
  });

  // ---------------- 지급 원장 (W-06) — T-104 원장과 같은 응답 모양 ----------------
  app.get('/api/partners/:id/payable-ledger', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const partnerId = parseId(req.params.id);
    if (!partnerId) return sendPayError(res, vErr('id', '거래처 번호가 올바르지 않습니다.'));
    const from = parseDateParam(req.query.from);
    if (from === null) return sendPayError(res, vErr('from', '시작일 형식이 올바르지 않습니다(YYYY-MM-DD).'));
    const to = parseDateParam(req.query.to);
    if (to === null) return sendPayError(res, vErr('to', '종료일 형식이 올바르지 않습니다(YYYY-MM-DD).'));
    if (from && to && from > to) return sendPayError(res, vErr('from', '시작일이 종료일보다 늦습니다.'));
    const includeCancelled = isTrue(req.query.include_cancelled);
    const fromP = from || null;
    const toP = to || null;

    try {
      const pr = await pool.query('SELECT id, name, type FROM account WHERE id = $1 AND user_id = $2', [partnerId, userId]);
      const partner = pr.rows[0];
      if (!partner) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '거래처를 찾을 수 없습니다.' });

      const empty = {
        partner,
        scope: 'payable',
        from: fromP,
        to: toP,
        opening_balance: 0,
        closing_balance: 0,
        totals: { purchases: 0, payments: 0 },
        entries: [],
        check: { ledger_balance: 0, purchase_based_due: 0, diff: 0 },
      };
      // 판매만 하는 거래처(customer)는 줄 돈 장부가 없다
      if (!PAYABLE_PARTNER_TYPES.has(partner.type)) return res.json({ ok: true, data: empty });

      const db = await pool.connect();
      try {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const sum = await db.query(
          `WITH e AS (
             SELECT * FROM supplier_ledger_entry WHERE user_id = $1 AND partner_id = $2
           ), inr AS (
             SELECT * FROM e WHERE ($3::date IS NULL OR entry_date >= $3::date) AND ($4::date IS NULL OR entry_date <= $4::date)
           )
           SELECT
             (SELECT COALESCE(SUM(increase - decrease), 0) FROM e WHERE $3::date IS NOT NULL AND entry_date < $3::date) AS opening,
             (SELECT COALESCE(SUM(increase - decrease), 0) FROM e WHERE $4::date IS NULL OR entry_date <= $4::date)      AS closing,
             (SELECT COALESCE(SUM(increase), 0) FROM inr WHERE kind = 'purchase') AS purchases,
             (SELECT COALESCE(SUM(decrease), 0) FROM inr WHERE kind = 'payment')  AS payments,
             (SELECT COALESCE(SUM(decrease), 0) FROM inr WHERE kind = 'payment' AND pay_kind = 'pay')      AS cash_payments,
             (SELECT COALESCE(SUM(decrease), 0) FROM inr WHERE kind = 'payment' AND pay_kind = 'discount') AS discounts,
             (SELECT COALESCE(SUM(decrease), 0) FROM inr WHERE kind = 'payment' AND pay_kind = 'offset')   AS offsets,
             (SELECT COUNT(*)::int FROM inr)                                      AS n,
             (SELECT COALESCE(SUM(increase - decrease), 0) FROM e)                AS ledger_balance,
             (SELECT COALESCE(SUM(total_amount - paid_amount), 0)
                FROM purchase WHERE user_id = $1 AND payee_partner_id = $2 AND status = 'active') AS purchase_based_due`,
          [userId, partnerId, fromP, toP]
        );
        const s = sum.rows[0];
        if (s.n > LEDGER_MAX_ROWS) {
          return res.status(400).json({
            ok: false,
            code: 'RANGE_TOO_LARGE',
            field: 'from',
            message: `원장 행이 ${s.n.toLocaleString('ko-KR')}건이라 한 번에 보여 줄 수 없습니다. 기간을 줄여 주세요(최대 ${LEDGER_MAX_ROWS.toLocaleString('ko-KR')}건).`,
          });
        }
        const rows = await db.query(
          `WITH ordered AS (
             SELECT e.*,
                    SUM(e.increase - e.decrease) OVER (
                      ORDER BY e.entry_date, e.kind_order, e.entered_at, e.ref_id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
             FROM supplier_ledger_entry e
             WHERE e.user_id = $1 AND e.partner_id = $2
           )
           SELECT to_char(o.entry_date, 'YYYY-MM-DD') AS date, o.kind, o.kind_order, o.ref_id,
                  pr.name AS product_name, o.quantity, o.unit_price, o.pay_kind, o.method,
                  o.increase, o.decrease, o.balance, o.memo, o.entered_at
           FROM ordered o
           LEFT JOIN product pr ON pr.id = o.product_id
           WHERE ($3::date IS NULL OR o.entry_date >= $3::date)
             AND ($4::date IS NULL OR o.entry_date <= $4::date)
           ORDER BY o.entry_date, o.kind_order, o.entered_at, o.ref_id`,
          [userId, partnerId, fromP, toP]
        );

        // 지급 행의 매입별 배분 — 취소 지급 보기에도 쓰므로 기간 안 지급 전체를 한 번에
        const payIds = rows.rows.filter((r) => r.kind === 'payment').map((r) => r.ref_id);
        let cancelledPays = [];
        if (includeCancelled) {
          const cp = await db.query(
            `SELECT sp.id, to_char((sp.paid_at AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS date, sp.amount, sp.kind, sp.method,
                    sp.memo, sp.paid_at, sp.cancel_reason
               FROM supplier_payment sp
              WHERE sp.user_id = $1 AND sp.partner_id = $2 AND sp.status = 'cancelled'
                AND ($3::date IS NULL OR (sp.paid_at AT TIME ZONE 'Asia/Seoul')::date >= $3::date)
                AND ($4::date IS NULL OR (sp.paid_at AT TIME ZONE 'Asia/Seoul')::date <= $4::date)`,
            [userId, partnerId, fromP, toP]
          );
          cancelledPays = cp.rows;
        }
        const allIds = [...payIds, ...cancelledPays.map((r) => r.id)];
        const allocBy = new Map();
        if (allIds.length) {
          const al = await db.query(
            `SELECT spa.supplier_payment_id AS pid, spa.purchase_id, spa.amount
               FROM supplier_payment_allocation spa
              WHERE spa.user_id = $1 AND spa.supplier_payment_id = ANY($2::int[])
              ORDER BY spa.supplier_payment_id, spa.purchase_id`,
            [userId, allIds]
          );
          for (const a of al.rows) {
            if (!allocBy.has(a.pid)) allocBy.set(a.pid, []);
            allocBy.get(a.pid).push({ purchase_id: a.purchase_id, amount: money(a.amount) });
          }
        }
        const allocText = (list) => (list || []).map((a) => `#${a.purchase_id} ${fmt(a.amount)}`).join(' · ');

        let entries = rows.rows.map((r) => {
          const e = {
            date: r.date,
            kind: r.kind,
            kind_label: r.kind === 'payment' && ['opening', 'discount', 'offset'].includes(r.pay_kind) ? KIND_LABEL[r.pay_kind] : KIND_LABEL[r.kind],
            ref_id: r.ref_id,
            product_name: r.product_name,
            quantity: num(r.quantity),
            unit_price: num(r.unit_price),
            increase: money(r.increase),
            decrease: money(r.decrease),
            balance: money(r.balance),
            memo: r.memo,
            _order: [r.date, r.kind_order, new Date(r.entered_at || 0).getTime(), r.ref_id],
          };
          if (r.kind === 'purchase') {
            e.description = `매입 #${r.ref_id} ${r.product_name || '상품'} ${fmt(r.quantity)} × ${fmt(r.unit_price)}`;
          } else {
            e.pay_kind = r.pay_kind;
            e.method = r.method;
            e.method_label = r.method ? METHOD_LABEL[r.method] || r.method : null;
            e.allocations = allocBy.get(r.ref_id) || [];
            const head = ['opening', 'discount', 'offset'].includes(r.pay_kind) ? KIND_LABEL[r.pay_kind] : `지급${e.method_label ? `(${e.method_label})` : ''}`;
            const t = allocText(e.allocations);
            e.description = t ? `${head} 매입 ${t}` : head;
          }
          return e;
        });

        if (includeCancelled) {
          const cpu = await db.query(
            `SELECT pu.id, to_char(pu.purchase_date, 'YYYY-MM-DD') AS date, pu.quantity, pu.unit_price, pu.total_amount, pu.memo, pu.created_at,
                    pr.name AS product_name
               FROM purchase pu LEFT JOIN product pr ON pr.id = pu.product_id
              WHERE pu.user_id = $1 AND pu.partner_id = $2 AND pu.status = 'cancelled'
                AND ($3::date IS NULL OR pu.purchase_date >= $3::date) AND ($4::date IS NULL OR pu.purchase_date <= $4::date)`,
            [userId, partnerId, fromP, toP]
          );
          const extra = [
            ...cpu.rows.map((r) => ({
              date: r.date,
              kind: 'purchase_cancelled',
              kind_label: KIND_LABEL.purchase_cancelled,
              ref_id: r.id,
              product_name: r.product_name,
              quantity: num(r.quantity),
              unit_price: num(r.unit_price),
              cancelled_amount: money(r.total_amount),
              increase: 0,
              decrease: 0,
              balance: 0,
              memo: r.memo,
              description: `취소 매입 #${r.id} ${r.product_name || '상품'} ${fmt(r.quantity)} × ${fmt(r.unit_price)} (잔액에 넣지 않음)`,
              _order: [r.date, 1, new Date(r.created_at || 0).getTime(), r.id],
            })),
            ...cancelledPays.map((r) => ({
              date: r.date,
              kind: 'payment_cancelled',
              kind_label: KIND_LABEL.payment_cancelled,
              ref_id: r.id,
              pay_kind: r.kind,
              method: r.method,
              cancelled_amount: money(r.amount),
              cancel_reason: r.cancel_reason,
              allocations: allocBy.get(r.id) || [],
              increase: 0,
              decrease: 0,
              balance: 0,
              memo: r.memo,
              description: `취소 ${KIND_LABEL[r.kind] || '지급'} #${r.id} ${fmt(r.amount)} (잔액에 넣지 않음${r.cancel_reason ? ` — ${r.cancel_reason}` : ''})`,
              _order: [r.date, 2, new Date(r.paid_at || 0).getTime(), r.id],
            })),
          ];
          const cmp = (a, b) => {
            for (let i = 0; i < 4; i += 1) {
              if (a._order[i] < b._order[i]) return -1;
              if (a._order[i] > b._order[i]) return 1;
            }
            return 0;
          };
          entries = [...entries, ...extra].sort(cmp);
          let prev = money(s.opening);
          for (const e of entries) {
            if (e.kind === 'purchase_cancelled' || e.kind === 'payment_cancelled') e.balance = prev;
            else prev = e.balance;
          }
        }
        for (const e of entries) delete e._order;

        res.json({
          ok: true,
          data: {
            partner,
            scope: 'payable',
            from: fromP,
            to: toP,
            opening_balance: money(s.opening),
            closing_balance: money(s.closing),
            totals: {
              purchases: money(s.purchases), payments: money(s.payments),
              // T-401: payments(기존, 기초 정리 포함 전부)는 그대로 두고 현금 지급·매입 할인·상계를 따로
              cash_payments: money(s.cash_payments), discounts: money(s.discounts), offsets: money(s.offsets),
            },
            entries,
            // 검증식(설계 2.3): 원장 잔액 = 매입별 미지급 합. 0이 아니면 DB 직접 수정 등 — 관리자 확인
            check: {
              ledger_balance: money(s.ledger_balance),
              purchase_based_due: money(s.purchase_based_due),
              diff: money(Number(s.ledger_balance) - Number(s.purchase_based_due)),
            },
          },
        });
      } finally {
        await db.query('ROLLBACK').catch(() => {});
        db.release();
      }
    } catch (err) {
      sendPayError(res, err, '지급 원장을 불러오지 못했습니다.');
    }
  });

  // ---------------- 미지급 연령 (W-07) ----------------
  app.get('/api/payables/aging', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    if (req.query.as_of != null) return sendPayError(res, vErr('as_of', '기준일 지정은 지원하지 않습니다(오늘 기준만).'));
    const hasPartner = req.query.partner_id != null && String(req.query.partner_id).trim() !== '';
    const partnerId = hasPartner ? parseId(req.query.partner_id) : null;
    if (hasPartner && !partnerId) return sendPayError(res, vErr('partner_id', '거래처 번호가 올바르지 않습니다.'));
    const asOf = kstToday();
    try {
      if (partnerId) {
        const pr = await pool.query('SELECT id FROM account WHERE id = $1 AND user_id = $2', [partnerId, userId]);
        if (!pr.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '거래처를 찾을 수 없습니다.' });
      }
      const r = await pool.query(
        `${PAYABLE_DUE_CTE}
         SELECT d.partner_id, a.name AS partner_name, a.type AS partner_type,
                SUM(d.due)                                                      AS total_due,
                COALESCE(SUM(d.due) FILTER (WHERE d.days <= 30), 0)             AS d0_30,
                COALESCE(SUM(d.due) FILTER (WHERE d.days BETWEEN 31 AND 60), 0) AS d31_60,
                COALESCE(SUM(d.due) FILTER (WHERE d.days BETWEEN 61 AND 90), 0) AS d61_90,
                COALESCE(SUM(d.due) FILTER (WHERE d.days >= 91), 0)             AS d91p,
                COUNT(*)::int                                                   AS purchase_count,
                to_char(MIN(d.purchase_date), 'YYYY-MM-DD')                     AS oldest_purchase_date,
                MAX(d.days)::int                                                AS oldest_days,
                (SELECT to_char(MAX((sp.paid_at AT TIME ZONE 'Asia/Seoul')::date), 'YYYY-MM-DD')
                   FROM supplier_payment sp
                  WHERE sp.user_id = $1 AND sp.partner_id = d.partner_id AND sp.status = 'active' AND sp.kind = 'pay') AS last_payment_date
         FROM pdue d
         JOIN account a ON a.id = d.partner_id AND a.user_id = $1
         GROUP BY d.partner_id, a.name, a.type
         ORDER BY d91p DESC, d61_90 DESC, total_due DESC, a.name, d.partner_id`,
        [userId, asOf, partnerId]
      );
      const keys = ['total_due', 'd0_30', 'd31_60', 'd61_90', 'd91p'];
      const rows = r.rows.map((x) => {
        const o = {
          partner_id: x.partner_id,
          partner_name: x.partner_name,
          partner_type: x.partner_type,
          purchase_count: x.purchase_count,
          oldest_purchase_date: x.oldest_purchase_date,
          oldest_days: x.oldest_days,
          last_payment_date: x.last_payment_date,
        };
        for (const k of keys) o[k] = money(x[k]);
        return o;
      });
      const t = await pool.query(
        `${PAYABLE_DUE_CTE}
         SELECT COALESCE(SUM(due), 0) AS total_due,
                COALESCE(SUM(due) FILTER (WHERE days <= 30), 0)             AS d0_30,
                COALESCE(SUM(due) FILTER (WHERE days BETWEEN 31 AND 60), 0) AS d31_60,
                COALESCE(SUM(due) FILTER (WHERE days BETWEEN 61 AND 90), 0) AS d61_90,
                COALESCE(SUM(due) FILTER (WHERE days >= 91), 0)             AS d91p
         FROM pdue`,
        [userId, asOf, partnerId]
      );
      const totals = { partner_count: rows.length };
      for (const k of keys) totals[k] = money(t.rows[0][k]);
      const data = { as_of: asOf, basis: 'purchase_date', buckets: AGING_BUCKETS, rows, totals };
      if (partnerId) {
        const pl = await pool.query(
          `${PAYABLE_DUE_CTE}
           SELECT d.id AS purchase_id, to_char(d.purchase_date, 'YYYY-MM-DD') AS purchase_date, d.days::int AS days,
                  pr.name AS product_name, d.quantity, d.total_amount, d.paid_amount, d.due
           FROM pdue d LEFT JOIN product pr ON pr.id = d.product_id
           ORDER BY d.purchase_date, d.id`,
          [userId, asOf, partnerId]
        );
        data.purchases = pl.rows.map((x) => ({
          purchase_id: x.purchase_id,
          purchase_date: x.purchase_date,
          days: x.days,
          bucket: (AGING_BUCKETS.find((b) => x.days >= b.min && (b.max == null || x.days <= b.max)) || AGING_BUCKETS[3]).key,
          product_name: x.product_name,
          quantity: num(x.quantity),
          total: money(x.total_amount),
          paid: money(x.paid_amount),
          due: money(x.due),
        }));
      }
      res.json({ ok: true, data });
    } catch (err) {
      sendPayError(res, err, '미지급 연령을 불러오지 못했습니다.');
    }
  });
}

module.exports = {
  registerPayableRoutes,
  syncPurchasePaymentStatus,
  activePaymentsOfPurchase,
  PAYABLE_DUE_CTE,
  PAYABLE_PARTNER_TYPES,
  DEFAULT_PAY_METHOD,
};
