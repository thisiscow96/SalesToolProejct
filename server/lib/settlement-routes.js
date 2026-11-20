'use strict';
/**
 * 정산 할인 취소 · 상계 API (T-401) — 설계 `T-401_정산할인상계_설계.md` 3.2·3.5
 *
 *  POST /api/payments/:id/cancel   매출 할인(entry_kind=discount) 취소 — 주인만(R-58)
 *  POST /api/offsets               상계 등록 — 같은 거래처의 미수와 미지급을 같은 금액만큼 동시에 지움(R-59)
 *  POST /api/offsets/:id/cancel    상계 취소 — 상계·수금 쪽·지급 쪽 세 행을 함께 취소(R-60)
 *  GET  /api/offsets               상계 목록(R-61, 전원 조회)
 *
 * 원칙
 *  - 모든 쿼리에 user_id 조건(남의 기록은 404)
 *  - 금액은 원 단위 소수 2자리 → 센트 정수로 계산한다
 *  - 잠금 순서(O-04): 상계 행 → 매출 id 오름차순 → 매입 id 오름차순 (다른 라우트는 한쪽만 잠가 교착 없음)
 *  - 수금 쪽 할인·상계는 sale.paid_amount(받은 현금)를 건드리지 않는다: sale.discount_amount / sale.offset_amount
 *  - 지급 쪽 상계는 purchase.paid_amount 에 들어간다(지급·기초 정리·할인과 같음, 설계 2.4)
 */

/** 상계 가능한 유형 = 매입·판매를 함께 하는 유형(SALE ∩ PURCHASE) — O-01 */
const OFFSET_PARTNER_TYPES = new Set(['same_market', 'wholesaler', 'market_wholesaler']);
const REASON_MAX = 200;
const MEMO_MAX = 500;

function sErr(httpStatus, code, message, extra) {
  return Object.assign(new Error(message), { httpStatus, sCode: code, extra: extra || undefined });
}
function vErr(field, message) {
  return sErr(400, 'VALIDATION', message, { field });
}
function sendSErr(res, err, fallback) {
  if (err && err.httpStatus) {
    const body = { ok: false, code: err.sCode, message: err.message };
    if (err.extra) {
      Object.assign(body, err.extra);
      body.detail = err.extra;
    }
    return res.status(err.httpStatus).json(body);
  }
  if (err && err.code === '23514') {
    console.error('[settlement check]', err.constraint || '', err.message);
    return res.status(409).json({ ok: false, code: 'DATA_NEEDS_FIX', message: '정리액이 남은 금액을 넘게 됩니다. 새로고침 후 다시 시도하세요.' });
  }
  console.error(fallback, err);
  return res.status(500).json({ ok: false, message: fallback });
}

function parseId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n > 0 ? n : null;
}
/** 금액 → 센트 정수. 0보다 크고 소수 2자리까지만 */
function toCents(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return null;
  const c = Math.round(Number(s) * 100);
  return c > 0 ? c : null;
}
const c2s = (c) => (c / 100).toFixed(2);
const money = (v) => Number(v);
const fmt = (c) => (c / 100).toLocaleString('ko-KR');

function readReason(body) {
  const r = body?.reason != null ? String(body.reason).trim() : '';
  if (!r) throw vErr('reason', '취소 사유를 입력하세요.');
  if (r.length > REASON_MAX) throw vErr('reason', `취소 사유는 ${REASON_MAX}자 이내로 입력하세요.`);
  return r;
}
function checkExpected(body, epochMs) {
  const expected = body?.expected_updated_at;
  if (expected == null || expected === '') return;
  const exp = Date.parse(String(expected));
  if (!Number.isFinite(exp)) throw vErr('expected_updated_at', 'expected_updated_at 형식이 올바르지 않습니다.');
  if (Math.abs(Math.floor(Number(epochMs)) - exp) >= 1) {
    throw sErr(409, 'STALE_DATA', '다른 곳에서 먼저 바뀌었습니다. 최신 내용으로 다시 불러온 뒤 시도하세요.');
  }
}
function readAllocs(raw, idKey, field) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) throw vErr(field, '배분 형식이 올바르지 않습니다.');
  if (!raw.length) return null;
  if (raw.length > 500) throw vErr(field, '한 번에 배분할 수 있는 건은 500건까지입니다.');
  const seen = new Set();
  return raw.map((a) => {
    const id = parseId(a?.[idKey]);
    const c = toCents(a?.amount);
    if (!id || !c) throw vErr(field, '배분 행마다 번호와 0보다 큰 금액(소수 2자리까지)이 필요합니다.');
    if (seen.has(id)) throw vErr(field, `#${id} 가 두 번 들어 있습니다. 한 행으로 합쳐 보내세요.`);
    seen.add(id);
    return { id, cents: c };
  });
}

/** 오래된 순 자동 배분 — rows: [{id, due_cents}] (이미 날짜·id 순) */
function autoPlan(rows, cents) {
  const plan = [];
  let left = cents;
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(left, r.due_cents);
    if (take > 0) plan.push({ id: r.id, cents: take });
    left -= take;
  }
  return plan;
}

async function partnerReceivableCents(client, userId, partnerId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(GREATEST(total_amount - returned_amount - paid_amount - discount_amount - offset_amount, 0)), 0)::text AS due
       FROM sale WHERE user_id = $1 AND partner_id = $2 AND status <> 'cancelled'`,
    [userId, partnerId]
  );
  return Math.round(Number(r.rows[0].due) * 100);
}
async function partnerPayableCents(client, userId, partnerId) {
  const r = await client.query(
    `SELECT COALESCE(SUM(total_amount - paid_amount), 0)::text AS due
       FROM purchase WHERE user_id = $1 AND payee_partner_id = $2 AND status = 'active'`,
    [userId, partnerId]
  );
  return Math.round(Number(r.rows[0].due) * 100);
}

function registerSettlementRoutes(app, deps) {
  const { pool, getUserId, connectOr503, parsePaidAtInput, syncSalePaymentStatus, syncPurchasePaymentStatus, staffIdOf } = deps;

  // ---------------- 매출 할인 취소 (R-58, 3.2) ----------------
  app.post('/api/payments/:id/cancel', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const id = parseId(req.params.id);
    let reason;
    try {
      if (!id) throw vErr('id', '수금 번호가 올바르지 않습니다.');
      reason = readReason(req.body);
    } catch (err) {
      return sendSErr(res, err, '할인 취소에 실패했습니다.');
    }
    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      const pr = await client.query(
        `SELECT id, partner_id, entry_kind, status, offset_id, amount::text AS amount,
                (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_epoch_ms
           FROM payment WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, userId]
      );
      const p = pr.rows[0];
      if (!p) throw sErr(404, 'NOT_FOUND', '수금 기록을 찾을 수 없습니다.');
      if (p.entry_kind === 'offset') throw sErr(409, 'USE_OFFSET_CANCEL', '상계 취소에서 함께 취소하세요.', { offset_id: p.offset_id });
      if (p.entry_kind !== 'discount') throw sErr(409, 'NOT_CANCELLABLE', '현금 수금·환불은 취소할 수 없습니다.');
      if (p.status === 'cancelled') throw sErr(409, 'ALREADY_CANCELLED', '이미 취소된 할인입니다.');
      checkExpected(req.body, p.updated_epoch_ms);
      const al = await client.query(
        `SELECT sale_id, amount::text AS amount FROM payment_allocation WHERE payment_id = $1 ORDER BY sale_id`,
        [id]
      );
      const sids = al.rows.map((r) => r.sale_id);
      if (sids.length) {
        await client.query(`SELECT id FROM sale WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`, [userId, sids]);
        await client.query(
          `UPDATE sale s SET discount_amount = s.discount_amount - a.amt, updated_at = NOW()
             FROM unnest($1::int[], $2::numeric[]) AS a(sid, amt)
            WHERE s.id = a.sid AND s.user_id = $3`,
          [sids, al.rows.map((r) => r.amount), userId]
        );
        for (const sid of sids) await syncSalePaymentStatus(client, sid);
      }
      await client.query(
        `UPDATE payment SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1, updated_at = NOW() WHERE id = $2`,
        [reason, id]
      );
      const after = sids.length
        ? await client.query(
          `SELECT id, discount_amount::text AS discount_amount, payment_status,
                  GREATEST(total_amount - returned_amount - paid_amount - discount_amount - offset_amount, 0)::text AS unpaid_amount
             FROM sale WHERE id = ANY($1::int[]) ORDER BY id`,
          [sids]
        )
        : { rows: [] };
      await client.query('COMMIT');
      res.json({
        ok: true,
        data: {
          id,
          status: 'cancelled',
          cancel_reason: reason,
          sales: after.rows.map((r) => ({
            id: r.id, discount_amount: money(r.discount_amount), unpaid_amount: money(r.unpaid_amount), payment_status: r.payment_status,
          })),
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      sendSErr(res, err, '할인 취소에 실패했습니다.');
    } finally {
      client.release();
    }
  });

  // ---------------- 상계 등록 (R-59, 3.5) ----------------
  app.post('/api/offsets', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    let input;
    try {
      const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
      const partnerId = parseId(b.partner_id);
      if (!partnerId) throw vErr('partner_id', '거래처를 선택하세요.');
      const cents = toCents(b.amount);
      if (!cents) throw vErr('amount', '상계 금액은 0보다 큰 금액(소수 2자리까지)으로 입력하세요.');
      let offsetAt = new Date();
      if (b.offset_at != null && String(b.offset_at).trim() !== '') {
        const d = parsePaidAtInput(b.offset_at);
        if (!d || Number.isNaN(d.getTime())) throw vErr('offset_at', '상계 일시 형식이 올바르지 않습니다.');
        offsetAt = d;
      }
      let memo = b.memo == null ? null : String(b.memo).trim();
      if (memo === '') memo = null;
      if (memo && memo.length > MEMO_MAX) throw vErr('memo', `메모는 ${MEMO_MAX}자 이내로 입력하세요.`);
      const saleAllocs = readAllocs(b.sale_allocations, 'sale_id', 'sale_allocations');
      const purAllocs = readAllocs(b.purchase_allocations, 'purchase_id', 'purchase_allocations');
      for (const [list, field] of [[saleAllocs, 'sale_allocations'], [purAllocs, 'purchase_allocations']]) {
        if (list && list.reduce((s, a) => s + a.cents, 0) !== cents) {
          throw vErr(field, `배분 합계가 상계 금액(${fmt(cents)})과 같아야 합니다.`);
        }
      }
      input = { partnerId, cents, offsetAt, memo, saleAllocs, purAllocs };
    } catch (err) {
      return sendSErr(res, err, '상계 등록에 실패했습니다.');
    }

    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      const ar = await client.query('SELECT id, name, type::text AS type FROM account WHERE id = $1 AND user_id = $2', [input.partnerId, userId]);
      const partner = ar.rows[0];
      if (!partner) throw sErr(404, 'NOT_FOUND', '거래처를 찾을 수 없습니다.');
      if (!OFFSET_PARTNER_TYPES.has(partner.type)) {
        throw vErr('partner_id', '상계는 매입·판매를 함께 하는 거래처(같은 시장·도매상·시장도매인)만 할 수 있습니다.');
      }

      // ① 매출 잠금(id 순) — 미수가 남은 매출, 또는 수동 배분에 적은 매출
      const sIds0 = input.saleAllocs
        ? input.saleAllocs.map((a) => a.id)
        : (await client.query(
          `SELECT id FROM sale WHERE user_id = $1 AND partner_id = $2 AND status <> 'cancelled'
              AND total_amount - returned_amount - paid_amount - discount_amount - offset_amount > 0 ORDER BY id`,
          [userId, input.partnerId]
        )).rows.map((r) => r.id);
      const sl = sIds0.length
        ? await client.query(
          `SELECT id, partner_id, status, sale_date,
                  (total_amount - returned_amount - paid_amount - discount_amount - offset_amount)::text AS due
             FROM sale WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
          [userId, [...sIds0].sort((x, y) => x - y)]
        )
        : { rows: [] };
      // ② 매입 잠금(id 순) — 지급 대상이 이 거래처인 미지급 매입
      const pIds0 = input.purAllocs
        ? input.purAllocs.map((a) => a.id)
        : (await client.query(
          `SELECT id FROM purchase WHERE user_id = $1 AND payee_partner_id = $2 AND status = 'active'
              AND total_amount - paid_amount > 0 ORDER BY id`,
          [userId, input.partnerId]
        )).rows.map((r) => r.id);
      const pl = pIds0.length
        ? await client.query(
          `SELECT id, payee_partner_id, status, purchase_date, (total_amount - paid_amount)::text AS due
             FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
          [userId, [...pIds0].sort((x, y) => x - y)]
        )
        : { rows: [] };

      const sById = new Map(sl.rows.map((r) => [r.id, { ...r, due_cents: Math.round(Number(r.due) * 100) }]));
      const pById = new Map(pl.rows.map((r) => [r.id, { ...r, due_cents: Math.round(Number(r.due) * 100) }]));

      let salePlan;
      let purPlan;
      if (input.saleAllocs) {
        for (const a of input.saleAllocs) {
          const s = sById.get(a.id);
          if (!s) throw sErr(404, 'NOT_FOUND', `매출 #${a.id} 을(를) 찾을 수 없습니다.`, { sale_id: a.id });
          if (s.partner_id !== input.partnerId) throw vErr('sale_allocations', `매출 #${a.id} 는 선택한 거래처와 맞지 않습니다.`);
          if (s.status === 'cancelled') throw vErr('sale_allocations', `매출 #${a.id} 는 취소된 매출입니다.`);
          if (a.cents > s.due_cents) throw vErr('sale_allocations', `매출 #${a.id} 의 남은 미수(${fmt(Math.max(0, s.due_cents))})보다 많이 배분할 수 없습니다.`);
        }
        salePlan = input.saleAllocs;
      }
      if (input.purAllocs) {
        for (const a of input.purAllocs) {
          const p = pById.get(a.id);
          if (!p) throw sErr(404, 'NOT_FOUND', `매입 #${a.id} 을(를) 찾을 수 없습니다.`, { purchase_id: a.id });
          if (p.payee_partner_id !== input.partnerId) throw vErr('purchase_allocations', `매입 #${a.id} 는 선택한 거래처에 줄 돈이 아닙니다.`);
          if (p.status !== 'active') throw vErr('purchase_allocations', `매입 #${a.id} 는 취소된 매입입니다.`);
          if (a.cents > p.due_cents) throw vErr('purchase_allocations', `매입 #${a.id} 의 남은 미지급(${fmt(Math.max(0, p.due_cents))})보다 많이 배분할 수 없습니다.`);
        }
        purPlan = input.purAllocs;
      }

      // ③ 최대 상계액 = MIN(미수 합, 미지급 합) — 잠근 값으로 (O-02)
      const recvCents = await partnerReceivableCents(client, userId, input.partnerId);
      const payCents = await partnerPayableCents(client, userId, input.partnerId);
      const maxCents = Math.min(recvCents, payCents);
      if (input.cents > maxCents) {
        throw sErr(400, 'OFFSET_OVER', `상계 금액은 받을 돈(${fmt(recvCents)})과 줄 돈(${fmt(payCents)}) 중 작은 금액(${fmt(maxCents)})까지입니다.`, {
          field: 'amount', max_amount: maxCents / 100, receivable: recvCents / 100, payable: payCents / 100,
        });
      }
      if (!salePlan) {
        const rows = [...sById.values()].filter((r) => r.due_cents > 0)
          .sort((x, y) => String(x.sale_date).localeCompare(String(y.sale_date)) || x.id - y.id);
        salePlan = autoPlan(rows, input.cents);
      }
      if (!purPlan) {
        const rows = [...pById.values()].filter((r) => r.due_cents > 0)
          .sort((x, y) => String(x.purchase_date).localeCompare(String(y.purchase_date)) || x.id - y.id);
        purPlan = autoPlan(rows, input.cents);
      }

      // ④ 저장 — 상계 1행 + 수금 쪽 1행 + 지급 쪽 1행
      const so = await client.query(
        `INSERT INTO settlement_offset (user_id, partner_id, amount, offset_at, memo)
         VALUES ($1, $2, $3::numeric, $4, $5) RETURNING id`,
        [userId, input.partnerId, c2s(input.cents), input.offsetAt, input.memo]
      );
      const offsetId = so.rows[0].id;
      const memoText = input.memo ? `상계 #${offsetId} — ${input.memo}`.slice(0, MEMO_MAX) : `상계 #${offsetId}`;
      const pay = await client.query(
        `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo, offset_id, created_by_staff_id)
         VALUES ($1, $2, $3::numeric, $4, 'offset', $5, $6, $7) RETURNING id`,
        [userId, input.partnerId, c2s(input.cents), input.offsetAt, memoText, offsetId, staffIdOf ? staffIdOf(req) : null]
      );
      const paymentId = pay.rows[0].id;
      const sIds = salePlan.map((a) => a.id);
      const sAmts = salePlan.map((a) => c2s(a.cents));
      await client.query(
        `INSERT INTO payment_allocation (payment_id, sale_id, amount) SELECT $1, a.sid, a.amt FROM unnest($2::int[], $3::numeric[]) AS a(sid, amt)`,
        [paymentId, sIds, sAmts]
      );
      await client.query(
        `UPDATE sale s SET offset_amount = s.offset_amount + a.amt, updated_at = NOW()
           FROM unnest($1::int[], $2::numeric[]) AS a(sid, amt) WHERE s.id = a.sid AND s.user_id = $3`,
        [sIds, sAmts, userId]
      );
      for (const sid of sIds) await syncSalePaymentStatus(client, sid);

      const sp = await client.query(
        `INSERT INTO supplier_payment (user_id, partner_id, amount, paid_at, kind, method, memo, offset_id)
         VALUES ($1, $2, $3::numeric, $4, 'offset', NULL, $5, $6) RETURNING id`,
        [userId, input.partnerId, c2s(input.cents), input.offsetAt, memoText, offsetId]
      );
      const spId = sp.rows[0].id;
      const pIds = purPlan.map((a) => a.id);
      const pAmts = purPlan.map((a) => c2s(a.cents));
      await client.query(
        `INSERT INTO supplier_payment_allocation (user_id, supplier_payment_id, purchase_id, amount)
         SELECT $1, $2, a.pid, a.amt FROM unnest($3::int[], $4::numeric[]) AS a(pid, amt)`,
        [userId, spId, pIds, pAmts]
      );
      await client.query(
        `UPDATE purchase pu SET paid_amount = pu.paid_amount + a.amt, updated_at = NOW()
           FROM unnest($1::int[], $2::numeric[]) AS a(pid, amt) WHERE pu.id = a.pid AND pu.user_id = $3`,
        [pIds, pAmts, userId]
      );
      await syncPurchasePaymentStatus(client, pIds);

      const recvAfter = await partnerReceivableCents(client, userId, input.partnerId);
      const payAfter = await partnerPayableCents(client, userId, input.partnerId);
      await client.query('COMMIT');
      res.status(201).json({
        ok: true,
        data: {
          id: offsetId,
          partner_id: input.partnerId,
          partner_name: partner.name,
          amount: input.cents / 100,
          offset_at: input.offsetAt,
          memo: input.memo,
          payment_id: paymentId,
          supplier_payment_id: spId,
          sale_allocations: salePlan.map((a) => ({ sale_id: a.id, amount: a.cents / 100 })),
          purchase_allocations: purPlan.map((a) => ({ purchase_id: a.id, amount: a.cents / 100 })),
          receivable_after: recvAfter / 100,
          payable_after: payAfter / 100,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      sendSErr(res, err, '상계 등록에 실패했습니다.');
    } finally {
      client.release();
    }
  });

  // ---------------- 상계 취소 (R-60) ----------------
  app.post('/api/offsets/:id/cancel', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const id = parseId(req.params.id);
    let reason;
    try {
      if (!id) throw vErr('id', '상계 번호가 올바르지 않습니다.');
      reason = readReason(req.body);
    } catch (err) {
      return sendSErr(res, err, '상계 취소에 실패했습니다.');
    }
    const client = await connectOr503(res);
    if (!client) return;
    try {
      await client.query('BEGIN');
      const or = await client.query(
        `SELECT id, partner_id, status, (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_epoch_ms
           FROM settlement_offset WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [id, userId]
      );
      const so = or.rows[0];
      if (!so) throw sErr(404, 'NOT_FOUND', '상계를 찾을 수 없습니다.');
      if (so.status === 'cancelled') throw sErr(409, 'ALREADY_CANCELLED', '이미 취소된 상계입니다.');
      checkExpected(req.body, so.updated_epoch_ms);
      const pay = await client.query(`SELECT id FROM payment WHERE offset_id = $1 AND user_id = $2 FOR UPDATE`, [id, userId]);
      const spay = await client.query(`SELECT id FROM supplier_payment WHERE offset_id = $1 AND user_id = $2 FOR UPDATE`, [id, userId]);
      const paymentId = pay.rows[0]?.id;
      const spId = spay.rows[0]?.id;
      const sal = paymentId
        ? (await client.query(`SELECT sale_id, amount::text AS amount FROM payment_allocation WHERE payment_id = $1 ORDER BY sale_id`, [paymentId])).rows
        : [];
      const pal = spId
        ? (await client.query(
          `SELECT purchase_id, amount::text AS amount FROM supplier_payment_allocation WHERE supplier_payment_id = $1 AND user_id = $2 ORDER BY purchase_id`,
          [spId, userId]
        )).rows
        : [];
      const sIds = sal.map((r) => r.sale_id);
      const pIds = pal.map((r) => r.purchase_id);
      if (sIds.length) await client.query(`SELECT id FROM sale WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`, [userId, sIds]);
      if (pIds.length) await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`, [userId, pIds]);
      if (sIds.length) {
        await client.query(
          `UPDATE sale s SET offset_amount = s.offset_amount - a.amt, updated_at = NOW()
             FROM unnest($1::int[], $2::numeric[]) AS a(sid, amt) WHERE s.id = a.sid AND s.user_id = $3`,
          [sIds, sal.map((r) => r.amount), userId]
        );
        for (const sid of sIds) await syncSalePaymentStatus(client, sid);
      }
      if (pIds.length) {
        await client.query(
          `UPDATE purchase pu SET paid_amount = pu.paid_amount - a.amt, updated_at = NOW()
             FROM unnest($1::int[], $2::numeric[]) AS a(pid, amt) WHERE pu.id = a.pid AND pu.user_id = $3`,
          [pIds, pal.map((r) => r.amount), userId]
        );
        await syncPurchasePaymentStatus(client, pIds);
      }
      const now = await client.query('SELECT NOW() AS t');
      const t = now.rows[0].t;
      await client.query(`UPDATE settlement_offset SET status = 'cancelled', cancelled_at = $1, cancel_reason = $2, updated_at = $1 WHERE id = $3`, [t, reason, id]);
      await client.query(`UPDATE payment SET status = 'cancelled', cancelled_at = $1, cancel_reason = $2, updated_at = $1 WHERE offset_id = $3 AND user_id = $4`, [t, reason, id, userId]);
      await client.query(`UPDATE supplier_payment SET status = 'cancelled', cancelled_at = $1, cancel_reason = $2, updated_at = $1 WHERE offset_id = $3 AND user_id = $4`, [t, reason, id, userId]);
      const recvAfter = await partnerReceivableCents(client, userId, so.partner_id);
      const payAfter = await partnerPayableCents(client, userId, so.partner_id);
      await client.query('COMMIT');
      res.json({
        ok: true,
        data: { id, status: 'cancelled', cancel_reason: reason, payment_id: paymentId || null, supplier_payment_id: spId || null,
          receivable_after: recvAfter / 100, payable_after: payAfter / 100 },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      sendSErr(res, err, '상계 취소에 실패했습니다.');
    } finally {
      client.release();
    }
  });

  // ---------------- 상계 목록 (R-61) ----------------
  app.get('/api/offsets', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const from = req.query.from_date ? String(req.query.from_date) : null;
    const to = req.query.to_date ? String(req.query.to_date) : null;
    if (from && !dateRe.test(from)) return sendSErr(res, vErr('from_date', '시작일 형식이 올바르지 않습니다(YYYY-MM-DD).'));
    if (to && !dateRe.test(to)) return sendSErr(res, vErr('to_date', '종료일 형식이 올바르지 않습니다(YYYY-MM-DD).'));
    const hasPartner = req.query.partner_id != null && String(req.query.partner_id).trim() !== '';
    const partnerId = hasPartner ? parseId(req.query.partner_id) : null;
    if (hasPartner && !partnerId) return sendSErr(res, vErr('partner_id', '거래처 번호가 올바르지 않습니다.'));
    try {
      const r = await pool.query(
        `SELECT so.id, so.partner_id, a.name AS partner_name, so.amount, so.offset_at, so.memo, so.status,
                so.cancelled_at, so.cancel_reason, so.created_at, so.updated_at,
                p.id AS payment_id, sp.id AS supplier_payment_id,
                COALESCE((SELECT json_agg(json_build_object('sale_id', pa.sale_id, 'amount', pa.amount) ORDER BY pa.sale_id)
                            FROM payment_allocation pa WHERE pa.payment_id = p.id), '[]'::json) AS sale_allocations,
                COALESCE((SELECT json_agg(json_build_object('purchase_id', spa.purchase_id, 'amount', spa.amount) ORDER BY spa.purchase_id)
                            FROM supplier_payment_allocation spa WHERE spa.supplier_payment_id = sp.id), '[]'::json) AS purchase_allocations
           FROM settlement_offset so
           JOIN account a ON a.id = so.partner_id AND a.user_id = so.user_id
           LEFT JOIN payment p ON p.offset_id = so.id AND p.user_id = so.user_id
           LEFT JOIN supplier_payment sp ON sp.offset_id = so.id AND sp.user_id = so.user_id
          WHERE so.user_id = $1
            AND ($2::date IS NULL OR so.offset_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul'))
            AND ($3::date IS NULL OR so.offset_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))
            AND ($4::int IS NULL OR so.partner_id = $4::int)
          ORDER BY so.offset_at DESC, so.id DESC
          LIMIT 500`,
        [userId, from, to, partnerId]
      );
      res.json({
        ok: true,
        data: r.rows.map((x) => ({
          ...x,
          amount: money(x.amount),
          sale_allocations: (x.sale_allocations || []).map((v) => ({ ...v, amount: money(v.amount) })),
          purchase_allocations: (x.purchase_allocations || []).map((v) => ({ ...v, amount: money(v.amount) })),
        })),
      });
    } catch (err) {
      sendSErr(res, err, '상계 목록을 불러오지 못했습니다.');
    }
  });
}

module.exports = { registerSettlementRoutes, OFFSET_PARTNER_TYPES };
