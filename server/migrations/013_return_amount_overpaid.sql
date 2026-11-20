-- 013 (2026-11-20, T-219): DB 검토(T-118) 지적 R-01·R-02·R-05 고침
--  R-05  010 이후 옛 코드가 만든 반품(credit_amount IS NULL) 따라잡기 백필을 마이그레이션으로 — 수동 스크립트 단계 없앰
--        뒤이어 refund.credit_amount DEFAULT 0, NOT NULL (지금 코드는 항상 값을 넣는다)
--  R-02  refund.return_amount(반품액 V)를 따로 저장 — 원장 반품 행은 V만 빼고, 초과 수금 반환분은 환불 지급(+) 행에만 나타나게
--  R-01  010 이전 "환불 없이 반품"한 완납 매출(받은 돈 > 순매출)의 초과분을 sale.overpaid_amount("돌려줄 돈")로 표시하고
--        CHECK 를 paid ≤ 순매출 + overpaid 로 바꾼다 → 그 매출의 메모·판매일 수정·상태 재계산이 더는 23514(500)로 막히지 않는다.
--        새 거래는 overpaid 가 0이라 규칙은 그대로(받은 돈 ≤ 순매출). 돈 기록(payment·paid_amount·refund_amount)은 고치지 않는다.
--
-- 다시 실행해도 안전: 백필은 NULL 인 행만, 제약은 정의를 보고 한 번만 바꾼다, 뷰는 CREATE OR REPLACE.
-- 적용 시간: 행 단위 UPDATE 는 반품이 있는 매출·NULL 반품만 건드린다. ALTER 는 열 추가(DEFAULT 상수 → 테이블 재작성 없음, PG11+).

-- ======================================================================
-- 1. R-01 준비: 옛 제약을 먼저 풀어 둔다 (백필이 반품액을 늘리면 받은 돈 > 순매출 행이 생길 수 있음 — 같은 트랜잭션에서 아래 3에서 다시 건다)
-- ======================================================================
ALTER TABLE sale ADD COLUMN IF NOT EXISTS overpaid_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN sale.overpaid_amount IS '010 이전 기록에서 받은 돈이 순매출을 넘은 금액(돌려줄 돈). 새 거래는 0. 반품 API의 초과분 환불 때 0이 된다 (T-219 R-01)';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_paid_not_over_net' AND conrelid = 'sale'::regclass
             AND pg_get_constraintdef(oid) NOT LIKE '%overpaid_amount%') THEN
    ALTER TABLE sale DROP CONSTRAINT sale_paid_not_over_net;
  END IF;
END $$;

-- ======================================================================
-- 2. R-05 따라잡기 백필 (scripts/backfill-010-returns.sql 과 같은 SQL) — NULL 인 행만, 다시 실행하면 0행
-- ======================================================================
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

ALTER TABLE refund ALTER COLUMN credit_amount SET DEFAULT 0;
ALTER TABLE refund ALTER COLUMN credit_amount SET NOT NULL;

-- ======================================================================
-- 3. R-01 돌려줄 돈 표시 + 제약 다시 걸기
-- ======================================================================
-- 받은 돈 > 순매출 인 매출만. overpaid 가 이미 맞으면 건드리지 않는다(재실행 0행)
UPDATE sale
SET overpaid_amount = paid_amount - (total_amount - returned_amount),
    updated_at = NOW()
WHERE paid_amount > total_amount - returned_amount
  AND overpaid_amount IS DISTINCT FROM paid_amount - (total_amount - returned_amount);

-- 미수 상태를 새 식으로 (반품이 있고 상태가 다른 매출만 — 010과 같은 식)
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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_overpaid_nonneg' AND conrelid = 'sale'::regclass) THEN
    ALTER TABLE sale ADD CONSTRAINT sale_overpaid_nonneg CHECK (overpaid_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_paid_not_over_net' AND conrelid = 'sale'::regclass) THEN
    -- 받은 돈 ≤ 순매출 + 돌려줄 돈. 위 UPDATE 로 모든 행이 맞으므로 바로 VALID 로 건다(NOT VALID 없음)
    ALTER TABLE sale ADD CONSTRAINT sale_paid_not_over_net CHECK (paid_amount <= total_amount - returned_amount + overpaid_amount);
  END IF;
END $$;

-- ======================================================================
-- 4. R-02 반품액 V 를 반품 행에 저장
-- ======================================================================
-- NULL 허용: 배포가 겹치는 동안 012 코드가 return_amount 없이 넣은 반품은 뷰에서 (환불 + 미수 차감)으로 읽는다(초과분이 없는 일반 반품은 같은 값)
ALTER TABLE refund ADD COLUMN IF NOT EXISTS return_amount NUMERIC(14, 2);
COMMENT ON COLUMN refund.return_amount IS '반품 금액 V(매출 차감액). refund_amount(현금) + credit_amount(미수 차감)와 다를 수 있다: 010 이전 초과 수금을 함께 돌려준 반품 (T-219 R-02)';

-- 백필 ① 기본값: V = 현금 환불 + 미수 차감
UPDATE refund SET return_amount = COALESCE(refund_amount, 0) + credit_amount
WHERE return_amount IS NULL;

-- 백필 ② 초과분을 함께 돌려준 반품 고치기: 매출의 반품 행 합이 sale.returned_amount 보다 크면 그 차이가 초과분이다.
--   초과분 반환은 매출마다 한 번(그 뒤 받은 돈 ≤ 순매출)이고 그때 미수 차감은 0이다 → 미수 차감 0 이고 현금 ≥ 차이인 가장 앞 반품 행에서 뺀다.
--   (010 백필에서 "옛 환불금 > 수량×단가"인 반품도 같은 모양 — 같은 방식으로 V = 수량×단가가 된다)
WITH d AS (
  SELECT s.id AS sale_id, SUM(r.return_amount) - s.returned_amount AS diff
  FROM sale s JOIN refund r ON r.sale_id = s.id
  GROUP BY s.id, s.returned_amount
  HAVING SUM(r.return_amount) - s.returned_amount > 0.005
), pick AS (
  SELECT DISTINCT ON (r.sale_id) r.id, d.diff
  FROM refund r JOIN d ON d.sale_id = r.sale_id
  WHERE r.credit_amount = 0 AND COALESCE(r.refund_amount, 0) >= d.diff
  ORDER BY r.sale_id, r.id
)
UPDATE refund r SET return_amount = r.return_amount - pick.diff
FROM pick WHERE r.id = pick.id;

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*) INTO n FROM (
    SELECT s.id FROM sale s JOIN refund r ON r.sale_id = s.id
    GROUP BY s.id, s.returned_amount
    HAVING ABS(SUM(r.return_amount) - s.returned_amount) > 0.005) x;
  IF n > 0 THEN
    RAISE NOTICE '[013] 반품 행 합(return_amount) ≠ sale.returned_amount 인 매출 %건 — 아래 확인 SQL ① 로 보고 정리 필요(원장 차이로 보임)', n;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_return_amount_nonneg' AND conrelid = 'refund'::regclass) THEN
    ALTER TABLE refund ADD CONSTRAINT refund_return_amount_nonneg CHECK (return_amount >= 0);
  END IF;
END $$;

-- ======================================================================
-- 5. 원장 뷰 — 반품 행 decrease = 반품액 V (012 정의에서 이 한 곳만 바뀜, 열 이름·타입·순서 같음)
-- ======================================================================
CREATE OR REPLACE VIEW partner_ledger_entry AS
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
-- 반품 (−V). V 가 없는 행(배포 겹침)은 현금 환불 + 미수 차감
SELECT r.user_id, s.partner_id, r.refunded_at, 2, 'return', r.id, r.sale_id,
       s.product_id, r.quantity, s.unit_price,
       0, COALESCE(r.return_amount, COALESCE(r.refund_amount, 0) + COALESCE(r.credit_amount, 0)),
       COALESCE(r.credit_amount, 0), COALESCE(r.refund_amount, 0),
       r.reason, r.created_at
FROM refund r
JOIN sale s ON s.id = r.sale_id AND s.user_id = r.user_id
WHERE s.status <> 'cancelled'
UNION ALL
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 3, 'receipt', p.id, NULL,
       NULL, NULL, NULL,
       0, p.amount, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'receive'
UNION ALL
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 4, 'refund_cash', p.id, NULL,
       NULL, NULL, NULL,
       p.amount, 0, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'refund';

-- ======================================================================
-- 확인 SQL (사용자가 직접 — 이 파일은 실행하지 않음)
-- ① 반품 행 합 ≠ 반품액 누계:  SELECT s.id, s.returned_amount, SUM(r.return_amount) FROM sale s JOIN refund r ON r.sale_id = s.id
--      GROUP BY s.id HAVING ABS(SUM(r.return_amount) - s.returned_amount) > 0.005;
-- ② 돌려줄 돈이 남은 매출:     SELECT id, partner_id, total_amount, returned_amount, paid_amount, overpaid_amount, status FROM sale WHERE overpaid_amount > 0;
-- ③ NULL 반품 0건:              SELECT COUNT(*) FROM refund WHERE credit_amount IS NULL;   (NOT NULL 이라 항상 0)
-- ======================================================================
