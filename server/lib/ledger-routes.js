/**
 * 거래처 원장 · 미수 연령 API (T-104) — 설계 `T-104_원장_설계.md` 5장
 *
 *  GET /api/partners/:id/ledger     거래처 1곳의 받을 돈 장부(매출 + · 반품 − · 수금 − · 환불 지급 +, 행별 잔액 누계)
 *  GET /api/receivables/aging       거래처별 미수를 매출일 기준 0–30 / 31–60 / 61–90 / 91+ 구간으로
 *
 * 원칙
 *  - 모든 쿼리에 user_id 조건(남의 거래처는 404 — T-102 PUT과 같음)
 *  - 금액 합계·누계는 DB NUMERIC으로 계산하고 응답 직전에만 Number로 바꾼다(D-03)
 *  - 날짜는 'YYYY-MM-DD' 문자열(T-116). 수금 날짜는 한국 날짜(뷰에서 AT TIME ZONE 'Asia/Seoul')
 *  - 원장 뷰 partner_ledger_entry · 미수 뷰 receivables_by_partner 는 마이그레이션 012
 *
 * index.js 와 파일을 나눈 이유: T-103(정정)이 같은 시기에 index.js 의 매입·매출 라우트를 고쳐 병합 충돌을 줄이려고.
 */

/** 행이 이보다 많으면 기간을 줄이라고 400 — [가정] 휴대폰 화면·응답 크기 기준, 시드 측정 후 조정 */
const LEDGER_MAX_ROWS = 5000;

/** 연령 구간 — 경계는 설계 T104-RULE-05 (30일째는 30일 이내, 31일째부터 31–60) */
const AGING_BUCKETS = [
  { key: 'd0_30', label: '30일 이내', min: 0, max: 30 },
  { key: 'd31_60', label: '31–60일', min: 31, max: 60 },
  { key: 'd61_90', label: '61–90일', min: 61, max: 90 },
  { key: 'd91p', label: '90일 초과', min: 91, max: null },
];

/**
 * 미수 연령 대상 매출 CTE — 연령 API와 대시보드(T-208)가 같은 정의를 쓴다.
 * 연령 대상 = 취소 안 된 매출 중 미수 > 0 (status='refunded'로 거르지 않음 — F-3). 기준일 = 매출일(RULE-04)
 * 매개변수: $1 user_id · $2 기준일(KST 오늘, 'YYYY-MM-DD') · $3 partner_id(없으면 NULL)
 */
const RECEIVABLE_DUE_CTE = `
        WITH due AS (
          SELECT s.id, s.partner_id, s.sale_date, s.product_id, s.quantity,
                 s.total_amount, s.returned_amount, s.paid_amount,
                 (s.total_amount - s.returned_amount - s.paid_amount) AS due,
                 GREATEST($2::date - s.sale_date, 0)                 AS days
          FROM sale s
          WHERE s.user_id = $1
            AND s.status <> 'cancelled'
            AND s.payment_status IN ('unpaid', 'partial')
            AND s.total_amount - s.returned_amount - s.paid_amount > 0.005
            AND ($3::int IS NULL OR s.partner_id = $3::int)
        )`;

/** 판매 가능한 거래처 유형(index.js SALE_PARTNER_TYPES와 같음). 그 밖(supplier)은 받을 돈 장부가 없다 — RULE-10 */
const RECEIVABLE_PARTNER_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);

const KIND_LABEL = { sale: '매출', return: '반품', receipt: '수금', refund_cash: '환불 지급', sale_cancelled: '취소 매출' };

function validationError(res, field, message) {
  return res.status(400).json({ ok: false, code: 'VALIDATION', field, message });
}

/** '123' 같은 양의 정수 문자열만 받는다. 아니면 null */
function parseId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return n > 0 && n <= 2147483647 ? n : null;
}

/** 'YYYY-MM-DD' 이고 실제 있는 날짜만 받는다. 비어 있으면 undefined, 틀리면 null */
function parseDateParam(raw) {
  if (raw == null || String(raw).trim() === '') return undefined;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return s;
}

const isTrue = (v) => v === '1' || v === 'true';
const num = (v) => (v == null ? null : Number(v));
/** 0.005 미만 잔여(반올림 흔적)는 0으로 */
const money = (v) => {
  const n = Number(v ?? 0);
  return Math.abs(n) < 0.005 ? 0 : n;
};
const fmt = (n) => Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 3 });

function describe(e, allocations) {
  const prod = e.product_name || '상품';
  switch (e.kind) {
    case 'sale':
      return `매출 #${e.ref_id} ${prod} ${fmt(e.quantity)} × ${fmt(e.unit_price)}`;
    case 'sale_cancelled':
      return `취소 매출 #${e.ref_id} ${prod} ${fmt(e.quantity)} × ${fmt(e.unit_price)} (원장 잔액에 넣지 않음)`;
    case 'return':
      return `반품 #${e.ref_id} (매출 #${e.sale_id}) ${prod} ${fmt(e.quantity)} — 미수 차감 ${fmt(e.credit_amount)} / 현금 환불 ${fmt(e.cash_refund_amount)}`;
    case 'receipt': {
      const parts = (allocations || []).map((a) => `매출 #${a.sale_id} ${fmt(a.amount)}`);
      return parts.length ? `수금 (${parts.join(' · ')})` : '수금';
    }
    case 'refund_cash':
      return e.memo ? `환불 지급 (${e.memo})` : '환불 지급';
    default:
      return e.kind;
  }
}

function registerLedgerRoutes(app, { pool, getUserId, kstToday }) {
  // ---------------- 거래처 원장 ----------------
  app.get('/api/partners/:id/ledger', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const partnerId = parseId(req.params.id);
    if (!partnerId) return validationError(res, 'id', '거래처 번호가 올바르지 않습니다.');
    const from = parseDateParam(req.query.from);
    if (from === null) return validationError(res, 'from', '시작일 형식이 올바르지 않습니다(YYYY-MM-DD).');
    const to = parseDateParam(req.query.to);
    if (to === null) return validationError(res, 'to', '종료일 형식이 올바르지 않습니다(YYYY-MM-DD).');
    if (from && to && from > to) return validationError(res, 'from', '시작일이 종료일보다 늦습니다.');
    const includeCancelled = isTrue(req.query.include_cancelled);
    const fromP = from || null;
    const toP = to || null;

    try {
      const pr = await pool.query('SELECT id, name, type FROM account WHERE id = $1 AND user_id = $2', [partnerId, userId]);
      const partner = pr.rows[0];
      if (!partner) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '거래처를 찾을 수 없습니다.' });

      const empty = {
        partner,
        scope: 'receivable',
        from: fromP,
        to: toP,
        opening_balance: 0,
        closing_balance: 0,
        totals: { sales: 0, returns: 0, receipts: 0, refunds: 0 },
        entries: [],
        check: { ledger_balance: 0, sale_based_due: 0, overpaid: 0, diff: 0 },
      };
      // 매입만 하는 거래처는 받을 돈 장부가 없다(매입처 미지급은 T-201)
      if (!RECEIVABLE_PARTNER_TYPES.has(partner.type)) return res.json({ ok: true, data: empty });

      // 요약과 행을 같은 시점의 데이터로 읽는다 — 두 쿼리 사이에 수금이 들어와도 기말 잔액 = 마지막 행 잔액 (T-118 R-10)
      const db = await pool.connect();
      try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

      // 요약: 기초·기말·기간 합계·행 수·전체 기간 대조 — 한 번에 DB에서
      const sum = await db.query(
        `WITH e AS (
           SELECT * FROM partner_ledger_entry WHERE user_id = $1 AND partner_id = $2
         ), inr AS (
           SELECT * FROM e WHERE ($3::date IS NULL OR entry_date >= $3::date) AND ($4::date IS NULL OR entry_date <= $4::date)
         )
         SELECT
           (SELECT COALESCE(SUM(increase - decrease), 0) FROM e WHERE $3::date IS NOT NULL AND entry_date < $3::date) AS opening,
           (SELECT COALESCE(SUM(increase - decrease), 0) FROM e WHERE $4::date IS NULL OR entry_date <= $4::date)      AS closing,
           (SELECT COALESCE(SUM(increase), 0) FROM inr WHERE kind = 'sale')        AS sales,
           (SELECT COALESCE(SUM(decrease), 0) FROM inr WHERE kind = 'return')      AS returns,
           (SELECT COALESCE(SUM(decrease), 0) FROM inr WHERE kind = 'receipt')     AS receipts,
           (SELECT COALESCE(SUM(increase), 0) FROM inr WHERE kind = 'refund_cash') AS refunds,
           (SELECT COUNT(*)::int FROM inr)                                         AS n,
           (SELECT COALESCE(SUM(increase - decrease), 0) FROM e)                   AS ledger_balance,
           (SELECT COALESCE(SUM(GREATEST(total_amount - returned_amount - paid_amount, 0)), 0)
              FROM sale WHERE user_id = $1 AND partner_id = $2 AND status <> 'cancelled') AS sale_based_due,
           -- 돌려줄 돈(013 overpaid_amount: 010 이전 기록의 받은 돈 > 순매출) — 원장에서는 음수 잔액으로 보인다
           (SELECT COALESCE(SUM(overpaid_amount), 0)
              FROM sale WHERE user_id = $1 AND partner_id = $2 AND status <> 'cancelled') AS overpaid`,
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

      // 행별 잔액 = 전체 기간 누계(기간 앞 행 포함) → 기간 안 행만 돌려준다
      const rows = await db.query(
        `WITH ordered AS (
           SELECT e.*,
                  SUM(e.increase - e.decrease) OVER (
                    ORDER BY e.entry_date, e.kind_order, e.entered_at, e.ref_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS balance
           FROM partner_ledger_entry e
           WHERE e.user_id = $1 AND e.partner_id = $2
         )
         SELECT to_char(o.entry_date, 'YYYY-MM-DD') AS date, o.kind, o.kind_order, o.ref_id, o.sale_id,
                pr.name AS product_name, o.quantity, o.unit_price,
                o.increase, o.decrease, o.balance, o.credit_amount, o.cash_refund_amount, o.memo, o.entered_at
         FROM ordered o
         LEFT JOIN product pr ON pr.id = o.product_id
         WHERE ($3::date IS NULL OR o.entry_date >= $3::date)
           AND ($4::date IS NULL OR o.entry_date <= $4::date)
         ORDER BY o.entry_date, o.kind_order, o.entered_at, o.ref_id`,
        [userId, partnerId, fromP, toP]
      );

      // 수금 행의 매출별 배분 내역
      const receiptIds = rows.rows.filter((r) => r.kind === 'receipt').map((r) => r.ref_id);
      const allocByPayment = new Map();
      if (receiptIds.length) {
        const al = await db.query(
          `SELECT pa.payment_id, pa.sale_id, pa.amount
             FROM payment_allocation pa
             JOIN payment p ON p.id = pa.payment_id AND p.user_id = $1
            WHERE pa.payment_id = ANY($2::int[])
            ORDER BY pa.payment_id, pa.sale_id`,
          [userId, receiptIds]
        );
        for (const a of al.rows) {
          if (!allocByPayment.has(a.payment_id)) allocByPayment.set(a.payment_id, []);
          allocByPayment.get(a.payment_id).push({ sale_id: a.sale_id, amount: Number(a.amount) });
        }
      }

      let entries = rows.rows.map((r) => {
        const allocations = r.kind === 'receipt' ? allocByPayment.get(r.ref_id) || [] : undefined;
        const e = {
          date: r.date,
          kind: r.kind,
          kind_label: KIND_LABEL[r.kind],
          ref_id: r.ref_id,
          sale_id: r.sale_id,
          product_name: r.product_name,
          quantity: num(r.quantity),
          unit_price: num(r.unit_price),
          increase: money(r.increase),
          decrease: money(r.decrease),
          balance: money(r.balance),
          memo: r.memo,
          _order: [r.date, r.kind_order, new Date(r.entered_at || 0).getTime(), r.ref_id],
        };
        if (r.kind === 'return') {
          e.credit_amount = money(r.credit_amount);
          e.cash_refund_amount = money(r.cash_refund_amount);
        }
        if (allocations) e.allocations = allocations;
        e.description = describe({ ...e, product_name: r.product_name }, allocations);
        return e;
      });

      // 취소 매출 보기 — 금액 0, 잔액은 바로 앞 행 잔액 그대로(RULE-02)
      if (includeCancelled) {
        const c = await db.query(
          `SELECT s.id, to_char(s.sale_date, 'YYYY-MM-DD') AS date, s.quantity, s.unit_price, s.total_amount, s.memo, s.created_at,
                  pr.name AS product_name
             FROM sale s LEFT JOIN product pr ON pr.id = s.product_id
            WHERE s.user_id = $1 AND s.partner_id = $2 AND s.status = 'cancelled'
              AND ($3::date IS NULL OR s.sale_date >= $3::date) AND ($4::date IS NULL OR s.sale_date <= $4::date)`,
          [userId, partnerId, fromP, toP]
        );
        const cancelled = c.rows.map((r) => {
          const e = {
            date: r.date,
            kind: 'sale_cancelled',
            kind_label: KIND_LABEL.sale_cancelled,
            ref_id: r.id,
            sale_id: r.id,
            product_name: r.product_name,
            quantity: num(r.quantity),
            unit_price: num(r.unit_price),
            cancelled_amount: money(r.total_amount),
            increase: 0,
            decrease: 0,
            balance: 0,
            memo: r.memo,
            _order: [r.date, 1, new Date(r.created_at || 0).getTime(), r.id],
          };
          e.description = describe(e);
          return e;
        });
        const cmp = (a, b) => {
          for (let i = 0; i < 4; i += 1) {
            if (a._order[i] < b._order[i]) return -1;
            if (a._order[i] > b._order[i]) return 1;
          }
          return 0;
        };
        entries = [...entries, ...cancelled].sort(cmp);
        let prev = money(s.opening);
        for (const e of entries) {
          if (e.kind === 'sale_cancelled') e.balance = prev;
          else prev = e.balance;
        }
      }
      for (const e of entries) delete e._order;

      const ledgerBalance = money(s.ledger_balance);
      const saleBasedDue = money(s.sale_based_due);
      res.json({
        ok: true,
        data: {
          partner,
          scope: 'receivable',
          from: fromP,
          to: toP,
          opening_balance: money(s.opening),
          closing_balance: money(s.closing),
          totals: { sales: money(s.sales), returns: money(s.returns), receipts: money(s.receipts), refunds: money(s.refunds) },
          entries,
          // 검증식: 원장 잔액 = 매출별 미수 합 − 돌려줄 돈 (T-219 R-02). 0이 아니면 010 이전 기록 흔적(F-5·F-6)
          check: {
            ledger_balance: ledgerBalance,
            sale_based_due: saleBasedDue,
            overpaid: money(s.overpaid),
            diff: money(Number(s.ledger_balance) - Number(s.sale_based_due) + Number(s.overpaid)),
          },
        },
      });
      } finally {
        await db.query('ROLLBACK').catch(() => {});
        db.release();
      }
    } catch (err) {
      console.error('Partner ledger error:', err);
      res.status(500).json({ ok: false, message: '원장을 불러오지 못했습니다.' });
    }
  });

  // ---------------- 미수 연령 ----------------
  app.get('/api/receivables/aging', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    // 과거 기준일 연령은 지원하지 않는다(설계 O-2) — 조용히 무시하지 않고 알린다
    if (req.query.as_of != null) return validationError(res, 'as_of', '기준일 지정은 지원하지 않습니다(오늘 기준만).');
    const hasPartner = req.query.partner_id != null && String(req.query.partner_id).trim() !== '';
    const partnerId = hasPartner ? parseId(req.query.partner_id) : null;
    if (hasPartner && !partnerId) return validationError(res, 'partner_id', '거래처 번호가 올바르지 않습니다.');
    const hasMin = req.query.min_days != null && String(req.query.min_days).trim() !== '';
    const minS = hasMin ? String(req.query.min_days).trim() : '';
    const minDays = hasMin && /^\d{1,5}$/.test(minS) ? Number(minS) : null;
    if (hasMin && minDays == null) return validationError(res, 'min_days', '경과일 조건은 0 이상의 정수로 입력하세요.');
    const asOf = kstToday();

    try {
      if (partnerId) {
        const pr = await pool.query('SELECT id FROM account WHERE id = $1 AND user_id = $2', [partnerId, userId]);
        if (!pr.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '거래처를 찾을 수 없습니다.' });
      }
      const dueCte = RECEIVABLE_DUE_CTE;
      const r = await pool.query(
        `${dueCte}
         SELECT d.partner_id, a.name AS partner_name, a.type AS partner_type,
                SUM(d.due)                                                        AS total_due,
                COALESCE(SUM(d.due) FILTER (WHERE d.days <= 30), 0)               AS d0_30,
                COALESCE(SUM(d.due) FILTER (WHERE d.days BETWEEN 31 AND 60), 0)   AS d31_60,
                COALESCE(SUM(d.due) FILTER (WHERE d.days BETWEEN 61 AND 90), 0)   AS d61_90,
                COALESCE(SUM(d.due) FILTER (WHERE d.days >= 91), 0)               AS d91p,
                COUNT(*)::int                                                     AS sale_count,
                to_char(MIN(d.sale_date), 'YYYY-MM-DD')                           AS oldest_sale_date,
                MAX(d.days)::int                                                  AS oldest_days,
                (SELECT to_char(MAX((p.paid_at AT TIME ZONE 'Asia/Seoul')::date), 'YYYY-MM-DD')
                   FROM payment p
                  WHERE p.user_id = $1 AND p.partner_id = d.partner_id AND p.entry_kind = 'receive') AS last_receipt_date
         FROM due d
         JOIN account a ON a.id = d.partner_id AND a.user_id = $1
         GROUP BY d.partner_id, a.name, a.type
         HAVING ($4::int IS NULL OR MAX(d.days) >= $4::int)
         ORDER BY d91p DESC, d61_90 DESC, total_due DESC, a.name, d.partner_id`,
        [userId, asOf, partnerId, minDays]
      );
      const keys = ['total_due', 'd0_30', 'd31_60', 'd61_90', 'd91p'];
      const rows = r.rows.map((x) => {
        const o = {
          partner_id: x.partner_id,
          partner_name: x.partner_name,
          partner_type: x.partner_type,
          sale_count: x.sale_count,
          oldest_sale_date: x.oldest_sale_date,
          oldest_days: x.oldest_days,
          last_receipt_date: x.last_receipt_date,
        };
        for (const k of keys) o[k] = money(x[k]);
        return o;
      });
      // 합계도 DB 값(NUMERIC 문자열)을 더하지 않고 다시 집계해 부동소수 오차를 피한다
      const t = await pool.query(
        `${dueCte}
         SELECT COALESCE(SUM(due), 0) AS total_due,
                COALESCE(SUM(due) FILTER (WHERE days <= 30), 0)             AS d0_30,
                COALESCE(SUM(due) FILTER (WHERE days BETWEEN 31 AND 60), 0) AS d31_60,
                COALESCE(SUM(due) FILTER (WHERE days BETWEEN 61 AND 90), 0) AS d61_90,
                COALESCE(SUM(due) FILTER (WHERE days >= 91), 0)             AS d91p
         FROM due
         WHERE partner_id = ANY($4::int[])`,
        [userId, asOf, partnerId, rows.map((x) => x.partner_id)]
      );
      const totals = { partner_count: rows.length };
      for (const k of keys) totals[k] = money(t.rows[0][k]);

      const data = { as_of: asOf, basis: 'sale_date', buckets: AGING_BUCKETS, rows, totals };
      if (partnerId) {
        const sl = await pool.query(
          `${dueCte}
           SELECT d.id AS sale_id, to_char(d.sale_date, 'YYYY-MM-DD') AS sale_date, d.days::int AS days,
                  pr.name AS product_name, d.quantity, d.total_amount, d.returned_amount, d.paid_amount, d.due
           FROM due d LEFT JOIN product pr ON pr.id = d.product_id
           ORDER BY d.sale_date, d.id`,
          [userId, asOf, partnerId]
        );
        data.sales = sl.rows.map((x) => ({
          sale_id: x.sale_id,
          sale_date: x.sale_date,
          days: x.days,
          bucket: (AGING_BUCKETS.find((b) => x.days >= b.min && (b.max == null || x.days <= b.max)) || AGING_BUCKETS[3]).key,
          product_name: x.product_name,
          quantity: num(x.quantity),
          total_amount: money(x.total_amount),
          returned_amount: money(x.returned_amount),
          paid_amount: money(x.paid_amount),
          due: money(x.due),
        }));
      }
      res.json({ ok: true, data });
    } catch (err) {
      console.error('Receivables aging error:', err);
      res.status(500).json({ ok: false, message: '미수 연령을 불러오지 못했습니다.' });
    }
  });
}

module.exports = { registerLedgerRoutes, AGING_BUCKETS, LEDGER_MAX_ROWS, RECEIVABLE_DUE_CTE, RECEIVABLE_PARTNER_TYPES, money };
