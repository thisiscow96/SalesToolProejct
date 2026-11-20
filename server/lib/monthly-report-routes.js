/**
 * 월 정산 보고서 (T-215, 기능 제안 P20)
 *
 *  GET /api/reports/monthly?month=YYYY-MM
 *    한 달의 매입·매출·반품·폐기·수금·지급 합계, 매출 이익·이익률, 월초·월말 미수·미지급 잔액,
 *    거래처별 상위(매출·매입), 전월 대비를 한 번에 돌려준다. 저장값은 바꾸지 않는다(조회만).
 *
 * 숫자는 이미 있는 화면과 같은 규칙으로 센다(합계가 각 화면과 맞아야 한다 — scripts/monthly-report-test.js 가 대조):
 *  - 매입   = 매입일이 그 달인 매입 중 취소 안 된 것(status='active')                — 일별 매입·매출(T-202)·대시보드와 같음
 *  - 매출   = 매출일이 그 달인 매출 중 취소 안 된 것(status<>'cancelled'), 반품 빼지 않은 총액 — 일별 보고서와 같음
 *  - 반품   = 반품일(refunded_at)이 그 달인 반품 중 취소 안 된 매출에 걸린 것, 금액 = 반품액 V — 거래처 원장(012·013) 반품 행과 같음
 *  - 폐기   = 폐기일이 그 달인 폐기. 손실 금액은 [가정] 추정 원가(아래 DISPOSAL_COST_NOTE) — 폐기에는 단가가 없다
 *  - 수금   = 수금(entry_kind='receive') 중 수금일시의 한국 날짜가 그 달                — 대시보드·원장 수금 행과 같음
 *  - 환불 지급 = payment entry_kind='refund' 중 한국 날짜가 그 달                       — 원장 환불 지급 행과 같음
 *  - 지급   = 취소 안 된 지급 중 kind='pay', 지급일시 한국 날짜가 그 달 (기초 정리 kind='opening'은 따로) — 대시보드 지급과 같음
 *  - 이익   = T-202 일별 이익과 같은 식: 원가 = 그 달 매출에 배분된 매입(purchase_allocation 수량 × 매입 단가),
 *             이익 = 원가가 있는 매출액 − 원가. 배분 없는 매출은 cost_missing_count 로 세고 이익에서 뺀다.
 *             FIFO 판매(T-205)도 배분을 남기므로 같은 식에 들어간다. 이익률 = 이익 ÷ 원가가 있는 매출액.
 *  - 미수 잔액 = 거래처 원장 뷰(partner_ledger_entry)의 증가−감소 누계(기준일까지). 월초 = 전달 말일 기준, 월말 = 그 달 말일 기준
 *  - 미지급 잔액 = 지급 원장 뷰(supplier_ledger_entry)의 누계(기준일까지, 기초 정리 포함)
 *    → 월말 − 월초 = 매출 − 반품 − 수금 + 환불 지급 (미수) / 매입 − 지급 − 기초 정리 (미지급)  이 식이 항상 맞는다.
 *
 * 원칙: 모든 집계에 user_id = 토큰 사용자. 금액은 DB NUMERIC 으로 더하고 응답 직전에만 Number.
 *       현재·전월 두 번의 집계를 같은 시점 데이터로 읽으려고 REPEATABLE READ 읽기 전용 트랜잭션 하나에서 실행한다.
 * 새 테이블·뷰·인덱스 없음(마이그레이션 020 불필요) — 기존 idx_*_user_date·idx_payment_user_paid_at·idx_supplier_payment_user_paid_at 사용.
 */
const { money } = require('./ledger-routes');

const TOP_N = 5;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DISPOSAL_COST_NOTE =
  '[가정] 폐기 손실 = 폐기 수량 × 그 품목의 폐기일까지 취소 안 된 매입 평균 단가(수량 가중). 폐기에는 단가가 없어 추정값이다. 그 전에 매입이 없으면 "원가 모름"으로 센다.';

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM' → { month, from, to, prev:{month, from, to} }. 틀리면 null */
function monthRange(raw) {
  const m = MONTH_RE.exec(String(raw ?? '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12) return null;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const py = mo === 1 ? y - 1 : y;
  const pm = mo === 1 ? 12 : mo - 1;
  const plast = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return {
    month: `${y}-${pad2(mo)}`,
    from: `${y}-${pad2(mo)}-01`,
    to: `${y}-${pad2(mo)}-${pad2(last)}`,
    prev: { month: `${py}-${pad2(pm)}`, from: `${py}-${pad2(pm)}-01`, to: `${py}-${pad2(pm)}-${pad2(plast)}` },
  };
}

/*
 * 한 달 합계 — 매개변수: $1 user_id · $2 월 첫날 · $3 월 말일 (모두 'YYYY-MM-DD', 한국 날짜)
 * 수금·지급 시각 비교는 대시보드와 같은 범위식([첫날 00:00 KST, 다음 달 첫날 00:00 KST))이라 idx_*_paid_at 을 쓴다.
 */
const SUMMARY_SQL = `
WITH
alc AS (
  SELECT pa.sale_id, ROUND(SUM(pa.quantity * pu.unit_price), 2) AS cost
  FROM purchase_allocation pa
  JOIN purchase pu ON pu.id = pa.purchase_id AND pu.user_id = pa.user_id
  WHERE pa.user_id = $1
    AND pa.sale_id IN (SELECT sa.id FROM sale sa WHERE sa.user_id = $1 AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date)
  GROUP BY pa.sale_id
),
sl AS (
  SELECT sa.id, sa.partner_id, sa.total_amount, alc.cost, (alc.sale_id IS NOT NULL) AS costed
  FROM sale sa
  LEFT JOIN alc ON alc.sale_id = sa.id
  WHERE sa.user_id = $1 AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date AND sa.status <> 'cancelled'
),
dsp AS (
  SELECT d.id, d.quantity, avgp.avg_price,
         CASE WHEN avgp.avg_price IS NULL THEN NULL ELSE ROUND(d.quantity * avgp.avg_price, 2) END AS cost
  FROM disposal d
  LEFT JOIN LATERAL (
    SELECT SUM(pu.total_amount) / NULLIF(SUM(pu.quantity), 0) AS avg_price
    FROM purchase pu
    WHERE pu.user_id = d.user_id AND pu.product_id = d.product_id AND pu.status = 'active'
      AND pu.purchase_date <= d.disposal_date
  ) avgp ON true
  WHERE d.user_id = $1 AND d.disposal_date >= $2::date AND d.disposal_date <= $3::date
)
SELECT
  (SELECT json_build_object('amount', COALESCE(SUM(pu.total_amount), 0), 'count', COUNT(*))
     FROM purchase pu
    WHERE pu.user_id = $1 AND pu.purchase_date >= $2::date AND pu.purchase_date <= $3::date AND pu.status = 'active') AS purchases,
  (SELECT json_build_object('amount', COALESCE(SUM(total_amount), 0), 'count', COUNT(*),
                            'cost', COALESCE(SUM(cost), 0),
                            'costed_sales', COALESCE(SUM(total_amount) FILTER (WHERE costed), 0),
                            'cost_missing_count', COUNT(*) FILTER (WHERE NOT costed))
     FROM sl) AS sales,
  (SELECT json_build_object(
            'amount', COALESCE(SUM(COALESCE(r.return_amount, COALESCE(r.refund_amount, 0) + COALESCE(r.credit_amount, 0))), 0),
            'cash_refund', COALESCE(SUM(COALESCE(r.refund_amount, 0)), 0),
            'credit', COALESCE(SUM(COALESCE(r.credit_amount, 0)), 0),
            'count', COUNT(*))
     FROM refund r
     JOIN sale s ON s.id = r.sale_id AND s.user_id = r.user_id AND s.status <> 'cancelled'
    WHERE r.user_id = $1 AND r.refunded_at >= $2::date AND r.refunded_at <= $3::date) AS returns,
  (SELECT json_build_object('count', COUNT(*),
                            'cost', COALESCE(SUM(cost), 0),
                            'cost_missing_count', COUNT(*) FILTER (WHERE cost IS NULL))
     FROM dsp) AS disposals,
  (SELECT json_build_object('amount', COALESCE(SUM(py.amount), 0), 'count', COUNT(*))
     FROM payment py
    WHERE py.user_id = $1 AND py.entry_kind = 'receive'
      AND py.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND py.paid_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')) AS receipts,
  (SELECT json_build_object('amount', COALESCE(SUM(py.amount), 0), 'count', COUNT(*))
     FROM payment py
    WHERE py.user_id = $1 AND py.entry_kind = 'refund'
      AND py.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND py.paid_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')) AS refund_payments,
  (SELECT json_build_object(
            'amount', COALESCE(SUM(sp.amount) FILTER (WHERE sp.kind = 'pay'), 0),
            'count', COUNT(*) FILTER (WHERE sp.kind = 'pay'),
            'opening_amount', COALESCE(SUM(sp.amount) FILTER (WHERE sp.kind = 'opening'), 0),
            'opening_count', COUNT(*) FILTER (WHERE sp.kind = 'opening'))
     FROM supplier_payment sp
    WHERE sp.user_id = $1 AND sp.status = 'active'
      AND sp.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND sp.paid_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')) AS pays,
  (SELECT json_build_object(
            'opening', COALESCE(SUM(increase - decrease) FILTER (WHERE entry_date < $2::date), 0),
            'closing', COALESCE(SUM(increase - decrease), 0))
     FROM partner_ledger_entry WHERE user_id = $1 AND entry_date <= $3::date) AS receivable,
  (SELECT json_build_object(
            'opening', COALESCE(SUM(increase - decrease) FILTER (WHERE entry_date < $2::date), 0),
            'closing', COALESCE(SUM(increase - decrease), 0))
     FROM supplier_ledger_entry WHERE user_id = $1 AND entry_date <= $3::date) AS payable,
  (SELECT CASE WHEN SUM(total_amount) FILTER (WHERE costed) > 0
               THEN ROUND((SUM(total_amount) FILTER (WHERE costed) - COALESCE(SUM(cost), 0)) * 100
                          / SUM(total_amount) FILTER (WHERE costed), 1) END
     FROM sl) AS margin_pct`;

/* 거래처별 상위 — 매출처(매출액·원가 있는 매출의 이익)와 매입처(매입액). $1 user · $2 첫날 · $3 말일 · $4 상위 N */
const TOP_SQL = `
WITH alc AS (
  SELECT pa.sale_id, ROUND(SUM(pa.quantity * pu.unit_price), 2) AS cost
  FROM purchase_allocation pa
  JOIN purchase pu ON pu.id = pa.purchase_id AND pu.user_id = pa.user_id
  WHERE pa.user_id = $1
    AND pa.sale_id IN (SELECT sa.id FROM sale sa WHERE sa.user_id = $1 AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date)
  GROUP BY pa.sale_id
)
SELECT
  (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
     SELECT sa.partner_id, a.name AS partner_name, a.type AS partner_type,
            SUM(sa.total_amount) AS amount, COUNT(*)::int AS count,
            SUM(sa.total_amount) FILTER (WHERE alc.sale_id IS NOT NULL) - COALESCE(SUM(alc.cost), 0) AS profit,
            COUNT(*) FILTER (WHERE alc.sale_id IS NULL)::int AS cost_missing_count
       FROM sale sa
       JOIN account a ON a.id = sa.partner_id AND a.user_id = $1
       LEFT JOIN alc ON alc.sale_id = sa.id
      WHERE sa.user_id = $1 AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date AND sa.status <> 'cancelled'
      GROUP BY sa.partner_id, a.name, a.type
      ORDER BY amount DESC, a.name, sa.partner_id
      LIMIT $4) t) AS sales_partners,
  (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
     SELECT pu.partner_id, a.name AS partner_name, a.type AS partner_type,
            SUM(pu.total_amount) AS amount, COUNT(*)::int AS count
       FROM purchase pu
       JOIN account a ON a.id = pu.partner_id AND a.user_id = $1
      WHERE pu.user_id = $1 AND pu.purchase_date >= $2::date AND pu.purchase_date <= $3::date AND pu.status = 'active'
      GROUP BY pu.partner_id, a.name, a.type
      ORDER BY amount DESC, a.name, pu.partner_id
      LIMIT $4) t) AS purchase_partners`;

const ac = (o) => ({ amount: money(o?.amount), count: Number(o?.count || 0) });

/** DB 한 행 → 응답 모양. 이익·순매출은 NUMERIC 문자열을 그대로 더하지 않도록 DB 값(json 숫자)을 2자리로 맞춘다 */
function shapeSummary(x) {
  const sales = x.sales || {};
  const cost = money(sales.cost);
  const costedSales = money(sales.costed_sales);
  const r2 = (n) => Math.round(n * 100) / 100;
  const returns = x.returns || {};
  const pays = x.pays || {};
  const rv = x.receivable || {};
  const pv = x.payable || {};
  return {
    purchases: ac(x.purchases),
    sales: ac(sales),
    returns: {
      amount: money(returns.amount),
      count: Number(returns.count || 0),
      cash_refund: money(returns.cash_refund),
      credit: money(returns.credit),
    },
    net_sales: money(r2(money(sales.amount) - money(returns.amount))),
    disposals: {
      count: Number(x.disposals?.count || 0),
      cost_estimate: money(x.disposals?.cost),
      cost_missing_count: Number(x.disposals?.cost_missing_count || 0),
    },
    receipts: ac(x.receipts),
    refund_payments: ac(x.refund_payments),
    payments: {
      amount: money(pays.amount),
      count: Number(pays.count || 0),
      opening_amount: money(pays.opening_amount),
      opening_count: Number(pays.opening_count || 0),
    },
    profit: {
      cost,
      costed_sales: costedSales,
      profit: money(r2(costedSales - cost)),
      margin_pct: x.margin_pct == null ? null : Number(x.margin_pct),
      cost_missing_count: Number(sales.cost_missing_count || 0),
    },
    balances: {
      receivable: { opening: money(rv.opening), closing: money(rv.closing) },
      payable: { opening: money(pv.opening), closing: money(pv.closing) },
    },
  };
}

/** 전월 대비 — 차이와 증감률(전월 0 이면 null) */
function compare(cur, prev) {
  const pick = (s) => ({
    purchases: s.purchases.amount,
    sales: s.sales.amount,
    returns: s.returns.amount,
    net_sales: s.net_sales,
    disposal_cost: s.disposals.cost_estimate,
    receipts: s.receipts.amount,
    payments: s.payments.amount,
    profit: s.profit.profit,
    receivable_closing: s.balances.receivable.closing,
    payable_closing: s.balances.payable.closing,
  });
  const a = pick(cur);
  const b = pick(prev);
  const out = {};
  for (const k of Object.keys(a)) {
    const diff = Math.round((a[k] - b[k]) * 100) / 100;
    out[k] = { current: a[k], previous: b[k], diff: money(diff), pct: b[k] ? Math.round((diff / Math.abs(b[k])) * 1000) / 10 : null };
  }
  out.margin_pct = {
    current: cur.profit.margin_pct,
    previous: prev.profit.margin_pct,
    diff: cur.profit.margin_pct == null || prev.profit.margin_pct == null
      ? null : Math.round((cur.profit.margin_pct - prev.profit.margin_pct) * 10) / 10,
    pct: null,
  };
  return out;
}

function registerMonthlyReportRoutes(app, { pool, getUserId, kstToday }) {
  app.get('/api/reports/monthly', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const range = monthRange(req.query.month);
    if (!range) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'month', message: '월을 YYYY-MM 형식으로 고르세요.' });
    }
    const today = kstToday();
    const thisMonth = today.slice(0, 7);
    if (range.month > thisMonth) {
      return res.status(400).json({ ok: false, code: 'FUTURE_MONTH', field: 'month', message: '아직 오지 않은 달은 볼 수 없습니다.' });
    }
    const db = await pool.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const cur = await db.query(SUMMARY_SQL, [userId, range.from, range.to]);
      const prev = await db.query(SUMMARY_SQL, [userId, range.prev.from, range.prev.to]);
      const top = await db.query(TOP_SQL, [userId, range.from, range.to, TOP_N]);
      await db.query('COMMIT');
      const curS = shapeSummary(cur.rows[0]);
      const prevS = shapeSummary(prev.rows[0]);
      const t = top.rows[0] || {};
      res.json({
        ok: true,
        data: {
          month: range.month,
          from: range.from,
          to: range.to,
          is_current_month: range.month === thisMonth,
          generated_on: today,
          ...curS,
          top: {
            sales_partners: (t.sales_partners || []).map((p) => ({
              partner_id: p.partner_id,
              partner_name: p.partner_name,
              partner_type: p.partner_type,
              amount: money(p.amount),
              count: p.count,
              profit: money(p.profit),
              cost_missing_count: p.cost_missing_count,
            })),
            purchase_partners: (t.purchase_partners || []).map((p) => ({
              partner_id: p.partner_id,
              partner_name: p.partner_name,
              partner_type: p.partner_type,
              amount: money(p.amount),
              count: p.count,
            })),
          },
          previous: { month: range.prev.month, from: range.prev.from, to: range.prev.to, ...prevS },
          change: compare(curS, prevS),
          notes: { disposal_cost: DISPOSAL_COST_NOTE, top_n: TOP_N },
        },
      });
    } catch (err) {
      try { await db.query('ROLLBACK'); } catch { /* 무시 */ }
      console.error('Monthly report error:', err);
      res.status(500).json({ ok: false, message: '월 정산 보고서를 불러오지 못했습니다.' });
    } finally {
      db.release();
    }
  });
}

module.exports = { registerMonthlyReportRoutes, monthRange, TOP_N, DISPOSAL_COST_NOTE };
