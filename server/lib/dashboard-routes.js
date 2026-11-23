/**
 * 첫 화면 대시보드 "오늘" (T-208)
 *
 *  GET /api/dashboard   로그인한 회원의 ① 오늘 매입·매출·수금 합계와 건수 ② 총미수 + 연령 구간
 *                       ③ 오래된 재고 상위 5 ④ 미수 많은 거래처 상위 5 — 한 번의 SQL로 돌려준다
 *
 * 숫자는 다른 화면과 같은 규칙으로 센다(합계가 각 목록·원장과 맞아야 한다):
 *  - 오늘 매입 = 매입일이 오늘인 매입 중 취소 안 된 것(status='active') — 일별 매입·매출 보고서와 같음
 *  - 오늘 매출 = 매출일이 오늘인 매출 중 취소 안 된 것(status<>'cancelled') — 일별 보고서와 같음(반품은 빼지 않은 총액)
 *  - 오늘 수금 = 수금(entry_kind='receive') 중 수금일시의 한국 날짜가 오늘 — 수금정보 목록·원장 수금 행과 같음. 환불 지급은 넣지 않는다
 *  - 미수·연령 = 미수 연령 API(T-104)와 같은 CTE(RECEIVABLE_DUE_CTE)를 그대로 쓴다
 *  - 오래된 재고 = 재고현황 API(T-209)와 같은 경과일 계산(남은 재고 중 가장 오래된 매입일 기준)
 *
 * 원칙: 모든 집계에 user_id = 토큰 사용자. 금액은 DB NUMERIC으로 더하고 응답 직전에만 Number.
 */
const { AGING_BUCKETS, RECEIVABLE_DUE_CTE, money } = require('./ledger-routes');
const { overLimitPartners } = require('./credit-limit'); // T-207 한도 넘은 거래처

/*
 * T-201 오늘 지급·총 미지급 — 위 SQL 과 같은 매개변수($1 user_id · $2 오늘 · $6 상위 N)
 *  - 오늘 지급 = 취소 안 된 지급 중 kind='pay'(기초 정리 제외), 지급일시 한국 날짜가 오늘 — 지급정보 목록과 같은 범위 비교
 *  - 미지급 = 미지급 연령 API(payable-routes PAYABLE_DUE_CTE)와 같은 정의: 취소 안 된 매입 중 total − paid > 0
 */
const PAYABLE_SELECT = `,
  (SELECT json_build_object('amount', COALESCE(SUM(sp.amount), 0), 'count', COUNT(*))
     FROM supplier_payment sp
    WHERE sp.user_id = $1 AND sp.status = 'active' AND sp.kind = 'pay'
      AND sp.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND sp.paid_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))                 AS pays,
  (SELECT json_build_object('total', COALESCE(SUM(pu.total_amount - pu.paid_amount), 0),
                            'purchase_count', COUNT(*),
                            'partner_count', COUNT(DISTINCT pu.payee_partner_id))
     FROM purchase pu
    WHERE pu.user_id = $1 AND pu.status = 'active' AND pu.payment_status IN ('unpaid', 'partial')
      AND pu.total_amount - pu.paid_amount > 0)                                                 AS payable,
  (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
     SELECT pu.payee_partner_id AS partner_id, a.name AS partner_name, a.type AS partner_type, -- T-401 PR-05 지급 대상 기준
            SUM(pu.total_amount - pu.paid_amount) AS total_due, COUNT(*)::int AS purchase_count,
            MAX(GREATEST($2::date - pu.purchase_date, 0))::int AS oldest_days
       FROM purchase pu JOIN account a ON a.id = pu.payee_partner_id AND a.user_id = $1
      WHERE pu.user_id = $1 AND pu.status = 'active' AND pu.payment_status IN ('unpaid', 'partial')
        AND pu.total_amount - pu.paid_amount > 0
      GROUP BY pu.payee_partner_id, a.name, a.type
      ORDER BY total_due DESC, a.name, pu.payee_partner_id
      LIMIT $6) t)                                                                              AS payable_top,
  EXISTS (SELECT 1 FROM supplier_payment sp WHERE sp.user_id = $1)                              AS has_supplier_payment`;


/**
 * 재고 경과일 기준 — 재고현황 화면(Main.jsx TabReorder)의 T-209 기준 [가정]과 같은 값.
 * 화면 상수와 따로 있으므로 바꿀 때 두 곳을 함께 바꾼다(보고서 "설계 변경 제안" 참고).
 */
const STALE_WARN_DAYS = 3;
const STALE_DANGER_DAYS = 7;
const TOP_N = 5;

/*
 * 매개변수: $1 user_id · $2 오늘(KST 'YYYY-MM-DD') · $3 NULL(연령 CTE의 partner_id 자리) · $4 경과일 주의 기준 · $5 경고 기준 · $6 상위 N
 * 오래된 재고 부분(inv)은 server/index.js GET /api/inventory 의 경과일 계산과 같은 식이다.
 * 두 곳이 어긋나면 scripts/dashboard-test.js 의 "재고현황과 같은 경과일" 검사가 실패한다.
 */
const DASHBOARD_SQL = `${RECEIVABLE_DUE_CTE},
  agg AS (
    SELECT d.partner_id,
           SUM(d.due)                                                      AS total_due,
           COALESCE(SUM(d.due) FILTER (WHERE d.days <= 30), 0)             AS d0_30,
           COALESCE(SUM(d.due) FILTER (WHERE d.days BETWEEN 31 AND 60), 0) AS d31_60,
           COALESCE(SUM(d.due) FILTER (WHERE d.days BETWEEN 61 AND 90), 0) AS d61_90,
           COALESCE(SUM(d.due) FILTER (WHERE d.days >= 91), 0)             AS d91p,
           COUNT(*)::int                                                   AS sale_count,
           MAX(d.days)::int                                                AS oldest_days
    FROM due d
    GROUP BY d.partner_id
  ),
  agg_named AS (
    SELECT g.*, a.name AS partner_name, a.type AS partner_type
    FROM agg g
    JOIN account a ON a.id = g.partner_id AND a.user_id = $1
  ),
  inv AS (
    SELECT i.product_id, p.name AS product_name, p.unit, i.quantity,
           to_char(COALESCE(op.oldest_date, lp.purchase_date), 'YYYY-MM-DD') AS aging_base_date,
           ($2::date - COALESCE(op.oldest_date, lp.purchase_date))::int       AS aging_days
    FROM inventory i
    JOIN product p ON p.id = i.product_id
    LEFT JOIN LATERAL (
      SELECT pu.purchase_date
      FROM purchase pu
      WHERE pu.user_id = i.user_id AND pu.product_id = i.product_id AND pu.status = 'active'
      ORDER BY pu.purchase_date DESC, pu.created_at DESC NULLS LAST, pu.id DESC
      LIMIT 1
    ) lp ON true
    LEFT JOIN LATERAL (
      SELECT MIN(lot.purchase_date) AS oldest_date
      FROM (
        SELECT pu.purchase_date,
               SUM(pu.quantity - COALESCE(al.q, 0))
                 OVER (ORDER BY pu.purchase_date DESC, pu.id DESC) AS cum_newest,
               (pu.quantity - COALESCE(al.q, 0)) AS remain
        FROM purchase pu
        LEFT JOIN (
          SELECT pa.purchase_id, SUM(pa.quantity) AS q
          FROM purchase_allocation pa
          WHERE pa.user_id = i.user_id
          GROUP BY pa.purchase_id
        ) al ON al.purchase_id = pu.id
        WHERE pu.user_id = i.user_id AND pu.product_id = i.product_id AND pu.status = 'active'
          AND pu.quantity - COALESCE(al.q, 0) > 0
      ) lot
      WHERE lot.cum_newest - lot.remain < i.quantity
    ) op ON true
    WHERE i.user_id = $1 AND i.quantity > 0
  )
SELECT
  (SELECT json_build_object('amount', COALESCE(SUM(pu.total_amount), 0), 'count', COUNT(*))
     FROM purchase pu
    WHERE pu.user_id = $1 AND pu.purchase_date = $2::date AND pu.status = 'active' AND pu.entry_kind = 'normal')            AS purchases,
  (SELECT json_build_object('amount', COALESCE(SUM(sa.total_amount), 0), 'count', COUNT(*))
     FROM sale sa
    WHERE sa.user_id = $1 AND sa.sale_date = $2::date AND sa.status <> 'cancelled' AND sa.entry_mode <> 'opening')           AS sales,
  (SELECT json_build_object('amount', COALESCE(SUM(py.amount), 0), 'count', COUNT(*))
     FROM payment py
    WHERE py.user_id = $1 AND py.entry_kind = 'receive'
      AND py.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND py.paid_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))                 AS receipts,
  -- T-401 오늘 매출 할인·매입 할인·상계 (현금이 아니라 위 수금·지급에는 들어가지 않는다)
  (SELECT json_build_object('amount', COALESCE(SUM(py.amount), 0), 'count', COUNT(*))
     FROM payment py
    WHERE py.user_id = $1 AND py.entry_kind = 'discount' AND py.status = 'active'
      AND py.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND py.paid_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))                 AS discounts,
  (SELECT json_build_object('amount', COALESCE(SUM(sp.amount), 0), 'count', COUNT(*))
     FROM supplier_payment sp
    WHERE sp.user_id = $1 AND sp.kind = 'discount' AND sp.status = 'active'
      AND sp.paid_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND sp.paid_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))                 AS pay_discounts,
  (SELECT json_build_object('amount', COALESCE(SUM(so.amount), 0), 'count', COUNT(*))
     FROM settlement_offset so
    WHERE so.user_id = $1 AND so.status = 'active'
      AND so.offset_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
      AND so.offset_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul'))                AS offsets,
  (SELECT json_build_object(
            'total_due', COALESCE(SUM(total_due), 0),
            'd0_30',     COALESCE(SUM(d0_30), 0),
            'd31_60',    COALESCE(SUM(d31_60), 0),
            'd61_90',    COALESCE(SUM(d61_90), 0),
            'd91p',      COALESCE(SUM(d91p), 0),
            'partner_count', COUNT(*),
            'sale_count',    COALESCE(SUM(sale_count), 0))
     FROM agg_named)                                                                            AS receivables,
  (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
     SELECT partner_id, partner_name, partner_type, total_due, d0_30, d31_60, d61_90, d91p, sale_count, oldest_days
       FROM agg_named
      ORDER BY total_due DESC, partner_name, partner_id
      LIMIT $6) t)                                                                              AS top_partners,
  (SELECT json_build_object(
            'warn_count',   COUNT(*) FILTER (WHERE aging_days >= $4 AND aging_days < $5),
            'danger_count', COUNT(*) FILTER (WHERE aging_days >= $5),
            'product_count', COUNT(*))
     FROM inv)                                                                                  AS stock,
  (SELECT COALESCE(json_agg(t), '[]'::json) FROM (
     SELECT product_id, product_name, unit, quantity, aging_base_date, aging_days
       FROM inv
      WHERE aging_days >= $4
      ORDER BY aging_days DESC, quantity DESC, product_name, product_id
      LIMIT $6) t)                                                                              AS stale_items
  ${PAYABLE_SELECT}`;

const amountCount = (o) => ({ amount: money(o?.amount), count: Number(o?.count || 0) });

function registerDashboardRoutes(app, { pool, getUserId, kstToday }) {
  app.get('/api/dashboard', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const asOf = kstToday();
    try {
      const [r, overLimit] = await Promise.all([
        pool.query(DASHBOARD_SQL, [userId, asOf, null, STALE_WARN_DAYS, STALE_DANGER_DAYS, TOP_N]),
        overLimitPartners(pool, userId, TOP_N),
      ]);
      const x = r.rows[0];
      const rv = x.receivables || {};
      const level = (days) => (days >= STALE_DANGER_DAYS ? 'danger' : 'warn');
      res.json({
        ok: true,
        data: {
          as_of: asOf,
          today: {
            purchases: amountCount(x.purchases),
            sales: amountCount(x.sales),
            receipts: amountCount(x.receipts),
            // T-201 오늘 지급(기초 정리 제외)
            payments: amountCount(x.pays),
            pay_amount: money(x.pays?.amount),
            pay_count: Number(x.pays?.count || 0),
            // T-401 현금이 아닌 정리(할인·상계) — 0이면 화면이 숨긴다
            discounts: amountCount(x.discounts),
            pay_discounts: amountCount(x.pay_discounts),
            offsets: amountCount(x.offsets),
          },
          // T-201 총 미지급 + 미지급 많은 매입처 상위 5. has_any_payment=false 면 화면이 "기초 정리" 안내를 보인다(U-1)
          payable: {
            total: money(x.payable?.total),
            purchase_count: Number(x.payable?.purchase_count || 0),
            partner_count: Number(x.payable?.partner_count || 0),
            has_any_payment: Boolean(x.has_supplier_payment),
            top: (x.payable_top || []).map((p) => ({
              partner_id: p.partner_id,
              partner_name: p.partner_name,
              partner_type: p.partner_type,
              total_due: money(p.total_due),
              purchase_count: p.purchase_count,
              oldest_days: p.oldest_days,
            })),
          },
          receivables: {
            basis: 'sale_date',
            buckets: AGING_BUCKETS,
            total_due: money(rv.total_due),
            d0_30: money(rv.d0_30),
            d31_60: money(rv.d31_60),
            d61_90: money(rv.d61_90),
            d91p: money(rv.d91p),
            partner_count: Number(rv.partner_count || 0),
            sale_count: Number(rv.sale_count || 0),
          },
          top_receivable_partners: (x.top_partners || []).map((p) => ({
            partner_id: p.partner_id,
            partner_name: p.partner_name,
            partner_type: p.partner_type,
            total_due: money(p.total_due),
            d0_30: money(p.d0_30),
            d31_60: money(p.d31_60),
            d61_90: money(p.d61_90),
            d91p: money(p.d91p),
            sale_count: p.sale_count,
            oldest_days: p.oldest_days,
          })),
          // T-207 외상 한도를 넘은 거래처(넘은 금액 큰 순 상위 5, count 는 전체 곳 수)
          over_limit_partners: overLimit,
          stale_inventory: {
            warn_days: STALE_WARN_DAYS,
            danger_days: STALE_DANGER_DAYS,
            warn_count: Number(x.stock?.warn_count || 0),
            danger_count: Number(x.stock?.danger_count || 0),
            product_count: Number(x.stock?.product_count || 0),
            items: (x.stale_items || []).map((it) => ({
              product_id: it.product_id,
              product_name: it.product_name,
              unit: it.unit,
              quantity: Number(it.quantity),
              aging_base_date: it.aging_base_date,
              aging_days: it.aging_days,
              level: level(it.aging_days),
            })),
          },
        },
      });
    } catch (err) {
      console.error('Dashboard error:', err);
      res.status(500).json({ ok: false, message: '오늘 현황을 불러오지 못했습니다.' });
    }
  });
}

module.exports = { registerDashboardRoutes, STALE_WARN_DAYS, STALE_DANGER_DAYS, TOP_N, DASHBOARD_SQL_FOR_TEST: DASHBOARD_SQL };
