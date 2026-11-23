-- 012 거래처 원장 · 미수 연령 (T-104)
-- 원칙
--  * 기존 데이터·제약은 바꾸지 않는다. 뷰만 만들거나 고친다(CREATE OR REPLACE VIEW — 다시 실행해도 오류 없음).
--  * 010(T-111) 적용이 전제: sale.returned_amount, refund.credit_amount 가 있어야 한다.
--  * 새 인덱스 없음 — 원장(거래처 1곳)은 idx_sale_partner_date·idx_payment_partner·idx_refund_sale,
--    연령(미수 매출)은 idx_sale_user_unpaid 로 찾는다(설계 T-104 4.3, EXPLAIN 결과는 보고서).
--  * 011 번호는 T-103(정정)용으로 비워 둔다.

-- ======================================================================
-- 1. 원장 뷰 — 거래처의 받을 돈 장부
--    매출 +total · 반품 −(현금 환불 + 미수 차감) · 수금 −amount · 환불 지급 +amount
--    잔액 = 매출 − 반품액 − 수금 + 환불 지급  (= 매출별 미수 합, 설계 2.3)
--    뷰에는 user_id 조건이 없다 → 읽을 때 꼭 WHERE user_id = ? AND partner_id = ?
-- ======================================================================
CREATE OR REPLACE VIEW partner_ledger_entry AS
-- 1 매출 (+) — 취소 매출 제외
SELECT s.user_id,
       s.partner_id,
       s.sale_date                            AS entry_date,
       1                                       AS kind_order,
       'sale'::text                            AS kind,
       s.id                                    AS ref_id,
       s.id                                    AS sale_id,
       s.product_id,
       s.quantity,
       s.unit_price,
       s.total_amount                          AS increase,
       0::numeric(14, 2)                       AS decrease,
       NULL::numeric(14, 2)                    AS credit_amount,
       NULL::numeric(14, 2)                    AS cash_refund_amount,
       s.memo,
       s.created_at                            AS entered_at
FROM sale s
WHERE s.status <> 'cancelled'
UNION ALL
-- 2 반품 (−V, V = 현금 환불 + 미수 차감) — 취소 매출에 걸린 반품 제외
SELECT r.user_id, s.partner_id, r.refunded_at, 2, 'return', r.id, r.sale_id,
       s.product_id, r.quantity, s.unit_price,
       0, COALESCE(r.refund_amount, 0) + COALESCE(r.credit_amount, 0),
       COALESCE(r.credit_amount, 0), COALESCE(r.refund_amount, 0),
       r.reason, r.created_at
FROM refund r
JOIN sale s ON s.id = r.sale_id AND s.user_id = r.user_id
WHERE s.status <> 'cancelled'
UNION ALL
-- 3 수금 (−) — 날짜는 한국 날짜(서버 TZ와 무관)
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 3, 'receipt', p.id, NULL,
       NULL, NULL, NULL,
       0, p.amount, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'receive'
UNION ALL
-- 4 환불 지급 (+)
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 4, 'refund_cash', p.id, NULL,
       NULL, NULL, NULL,
       p.amount, 0, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'refund';

-- ======================================================================
-- 2. 거래처별 미수 뷰 고침 (010 뷰의 결함)
--    F-2: 판매 가능 유형 4개 모두(SALE_PARTNER_TYPES) — 010은 customer 만 봐서 같은 시장·도매 판매처 미수가 빠졌다
--    F-3: status='refunded' 를 거르지 않는다 — 전량 반품인데 금액 일부만 차감되면 미수가 남는다
--    열 이름·타입·순서는 010과 같다(CREATE OR REPLACE VIEW 조건)
-- ======================================================================
CREATE OR REPLACE VIEW receivables_by_partner AS
SELECT
  a.user_id,
  a.id   AS partner_id,
  a.name AS partner_name,
  COALESCE(SUM(GREATEST(s.total_amount - s.returned_amount - s.paid_amount, 0)), 0) AS receivable_amount
FROM account a
LEFT JOIN sale s ON s.partner_id = a.id AND s.user_id = a.user_id
  AND s.payment_status IN ('unpaid', 'partial')
  AND s.status <> 'cancelled'
WHERE a.type IN ('customer', 'same_market', 'wholesaler', 'market_wholesaler')
GROUP BY a.user_id, a.id, a.name;

-- ======================================================================
-- 확인 SQL (운영 반영 전 사용자가 직접 실행 — 이 파일은 실행하지 않음)
-- ① 원장 잔액 ↔ 매출별 미수 합 차이가 있는 거래처 (010 이전 기록·배분 없는 환불 지급 흔적, 설계 F-5·F-6):
--      SELECT l.user_id, l.partner_id, l.bal, COALESCE(d.due, 0) AS due, l.bal - COALESCE(d.due, 0) AS diff
--      FROM (SELECT user_id, partner_id, SUM(increase - decrease) AS bal FROM partner_ledger_entry GROUP BY 1, 2) l
--      LEFT JOIN (SELECT user_id, partner_id, SUM(GREATEST(total_amount - returned_amount - paid_amount, 0)) AS due
--                 FROM sale WHERE status <> 'cancelled' GROUP BY 1, 2) d USING (user_id, partner_id)
--      WHERE ABS(l.bal - COALESCE(d.due, 0)) > 0.005;
-- ======================================================================
