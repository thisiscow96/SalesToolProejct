-- (2026-11-20 T-219) 013 마이그레이션이 이 백필을 포함한다 — 013 적용 뒤에는 실행할 필요가 없다(credit_amount NOT NULL 이라 대상 0건).
-- 010 따라잡기 백필 (T-111) — 010 적용 뒤 새 코드 배포 전까지 옛 코드가 만든 반품(credit_amount IS NULL)을 반품 규칙 B 값으로 반영한다.
-- 언제: 새 코드(반품 규칙 B) 배포 직후 한 번. 다시 실행해도 안전(NULL 인 행이 없으면 아무것도 바뀌지 않음).
-- 실행: psql "<DB URL>" -1 -f server/scripts/backfill-010-returns.sql   (-1 = 한 트랜잭션)
-- 돈 기록(refund_amount·payment·paid_amount)은 고치지 않는다. 010 마이그레이션의 백필 부분과 같은 SQL.

WITH legacy AS (
  SELECT r.sale_id, SUM(ROUND(r.quantity * s.unit_price, 2)) AS v
  FROM refund r
  JOIN sale s ON s.id = r.sale_id
  WHERE r.credit_amount IS NULL
  GROUP BY r.sale_id
)
UPDATE sale s
SET returned_amount = LEAST(s.total_amount, s.returned_amount + legacy.v),
    updated_at = NOW()
FROM legacy
WHERE s.id = legacy.sale_id;

UPDATE refund r
SET credit_amount = GREATEST(0, ROUND(r.quantity * s.unit_price, 2) - COALESCE(r.refund_amount, 0))
FROM sale s
WHERE s.id = r.sale_id AND r.credit_amount IS NULL;

UPDATE sale SET payment_status =
  CASE
    WHEN paid_amount >= total_amount - returned_amount THEN 'paid'::payment_status
    WHEN paid_amount > 0 THEN 'partial'::payment_status
    ELSE 'unpaid'::payment_status
  END
WHERE returned_amount > 0
  AND payment_status IS DISTINCT FROM (
    CASE
      WHEN paid_amount >= total_amount - returned_amount THEN 'paid'::payment_status
      WHEN paid_amount > 0 THEN 'partial'::payment_status
      ELSE 'unpaid'::payment_status
    END);

-- 확인: 남은 NULL 0건이어야 함
SELECT COUNT(*) AS refund_credit_null FROM refund WHERE credit_amount IS NULL;
