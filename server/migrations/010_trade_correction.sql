-- 010 (2026-11-20, T-103 W-01 + T-108 선택지 B / T-111): 매입·매출 정정(취소) 준비 + 반품 = 미수 먼저 차감, 넘친 돈만 환불
-- 설계: AI 팀 산출물 T-103_정정_설계.md 5장(DB)·10장(선택지 B)
--
-- 원칙 (009와 같음)
--  * 기존 데이터는 지우지 않는다. 돈 기록(payment·paid_amount)은 고치지 않는다.
--  * 제약은 NOT VALID 로 먼저 걸고, 기존 행이 맞으면 VALIDATE. 어기면 NOTICE 만 남기고 새 행부터 적용.
--  * 같은 파일을 다시 실행해도 오류가 나지 않는다(이름이 있으면 건너뜀, 백필은 한 번만 적용되는 조건으로).
--  * enum 새 값은 이 파일 안에서 쓰지 않는다(같은 트랜잭션에서 추가한 enum 값은 사용할 수 없음 — PostgreSQL ALTER TYPE Notes).
--
-- 선택지 B 계산 규칙 (서버 POST /api/sales/:id/refund 와 같은 식)
--   순매출 N = total_amount − returned_amount,  미수 = N − paid_amount (항상 0 이상: CHECK)
--   반품 금액 V → 미수 차감(credit) = MIN(V, 반품 전 미수), 현금 환불(refund_amount) = V − credit
--   sale.returned_amount = 그 매출 반품들의 (refund_amount + credit_amount) 합   (010 이후 행 기준)

CREATE OR REPLACE FUNCTION pg_temp.add_con_010(tbl text, con text, def text) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = con AND conrelid = tbl::regclass) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s NOT VALID', tbl, con, def);
  END IF;
  BEGIN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', tbl, con);
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE '[010] % . % : 기존 데이터가 제약을 어겨 VALIDATE 를 건너뜀 (새 행부터 적용). 아래 확인 SQL로 위반 행 확인 후 VALIDATE 필요', tbl, con;
  END;
END $$ LANGUAGE plpgsql;

-- ======================================================================
-- 5.1 정정(취소) 컬럼 — 매입 상태, 취소 시점·사유
-- ======================================================================
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(200);
ALTER TABLE sale ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE sale ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(200);

SELECT pg_temp.add_con_010('purchase', 'purchase_status_valid', $c$CHECK (status IN ('active', 'cancelled'))$c$);
SELECT pg_temp.add_con_010('purchase', 'purchase_cancelled_at_match', $c$CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))$c$);
-- 운영 DB에 cancelled_at 없이 status='cancelled'인 매출이 있으면 VALIDATE 건너뜀(NOTICE) — 확인 SQL ①
SELECT pg_temp.add_con_010('sale', 'sale_cancelled_at_match', $c$CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))$c$);

-- ======================================================================
-- 5.2 이동 이력 enum — 취소·정정 (이 파일 안에서는 INSERT 하지 않음)
-- ======================================================================
ALTER TYPE transfer_action ADD VALUE IF NOT EXISTS 'purchase_cancel';
ALTER TYPE transfer_action ADD VALUE IF NOT EXISTS 'sale_cancel';
ALTER TYPE transfer_action ADD VALUE IF NOT EXISTS 'correction';

-- ======================================================================
-- 5.3 정정 이력 테이블 (API W-02~W-08 은 다음 단계에서 씀)
-- ======================================================================
CREATE TABLE IF NOT EXISTS trade_correction (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES "user"(id),
  target_type    VARCHAR(20) NOT NULL,
  target_id      INTEGER NOT NULL,
  action         VARCHAR(10) NOT NULL,
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  before_data    JSONB NOT NULL,
  after_data     JSONB NOT NULL,
  reason         VARCHAR(200) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trade_correction_target_type_valid CHECK (target_type IN ('purchase', 'sale')),
  CONSTRAINT trade_correction_action_valid CHECK (action IN ('update', 'cancel')),
  CONSTRAINT trade_correction_reason_not_blank CHECK (length(btrim(reason)) > 0)
);
CREATE INDEX IF NOT EXISTS idx_trade_correction_target ON trade_correction (user_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_trade_correction_user_created ON trade_correction (user_id, created_at);

-- ======================================================================
-- T-108 선택지 B — 반품액(매출 차감)과 미수 차감분
-- ======================================================================
ALTER TABLE sale ADD COLUMN IF NOT EXISTS returned_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
-- credit_amount: NULL = 010 이전에 만든 반품(아직 백필 안 됨). 백필 뒤 NOT NULL DEFAULT 0 으로 바꾼다.
ALTER TABLE refund ADD COLUMN IF NOT EXISTS credit_amount NUMERIC(14, 2);

-- ---------- 백필: 010 이전 반품(credit_amount IS NULL)만 한 번 반영 ----------
-- 이전 반품은 반품 금액을 따로 저장하지 않았으므로 V = ROUND(반품 수량 × 매출 단가, 2) 로 본다(매출 총액을 넘지 않게).
-- 돈 기록(refund_amount·payment·paid_amount)은 고치지 않는다. 미수 차감분 = V − 이미 기록된 환불금(음수면 0).
-- 다시 실행하면 credit_amount IS NULL 인 행이 없어 아무것도 바뀌지 않는다.
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

-- credit_amount 에는 일부러 DEFAULT·NOT NULL 을 걸지 않는다.
--   새 코드는 항상 값을 넣는다. 010 적용 뒤 새 코드 배포 전까지 옛 코드(42f5919 이전)가 만든 반품은 NULL 로 남고,
--   새 코드 배포 직후 아래 "따라잡기 백필"(이 파일 백필 두 문장 + 상태 재계산과 같은 SQL)을 한 번 더 실행하면 반영된다.
--   (DEFAULT 0 이면 옛 코드가 만든 반품이 '이미 반영됨'처럼 보여 반품액이 빠진다 — 2026-11-20 로컬 재현으로 확인)

-- 미수 상태(파생값)를 새 식으로 다시 계산 — 반품이 있는 매출만 (돈 금액은 그대로)
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

SELECT pg_temp.add_con_010('sale', 'sale_returned_amount_range', 'CHECK (returned_amount >= 0 AND returned_amount <= total_amount)');
-- 받은 돈은 순매출(총액 − 반품액)을 넘지 않는다 — 넘친 돈은 환불로 돌려준다(선택지 B). 위반 행은 확인 SQL ②
SELECT pg_temp.add_con_010('sale', 'sale_paid_not_over_net', 'CHECK (paid_amount <= total_amount - returned_amount)');
SELECT pg_temp.add_con_010('refund', 'refund_credit_amount_nonneg', 'CHECK (credit_amount >= 0)');

-- ======================================================================
-- 5.4 미수 뷰 — 취소·전부 반품 제외 + 새 미수식 (코드는 아직 안 씀, T-104가 쓸 때 틀리지 않게)
-- ======================================================================
CREATE OR REPLACE VIEW receivables_by_partner AS
SELECT
  a.user_id,
  a.id AS partner_id,
  a.name AS partner_name,
  COALESCE(SUM(GREATEST(s.total_amount - s.returned_amount - s.paid_amount, 0)), 0) AS receivable_amount
FROM account a
LEFT JOIN sale s ON s.partner_id = a.id AND s.user_id = a.user_id
  AND s.payment_status IN ('unpaid', 'partial')
  AND s.status NOT IN ('cancelled', 'refunded')
WHERE a.type = 'customer'
GROUP BY a.user_id, a.id, a.name;

-- ======================================================================
-- 적용 전·후 확인 SQL (운영 반영 전 사용자가 직접 실행 — 이 파일은 실행하지 않음)
-- ① 취소 상태인데 취소 시점이 없는 매출:   SELECT id FROM sale WHERE status = 'cancelled' AND cancelled_at IS NULL;
-- ② 받은 돈 > 순매출 (VALIDATE 건너뛴 경우): SELECT id, total_amount, returned_amount, paid_amount FROM sale
--      WHERE paid_amount > total_amount - returned_amount;
-- ③ 받은 적 없는 돈을 환불로 기록한 매출 (재현 R2 흔적, 돈 기록은 사람이 판단해 정리):
--      SELECT s.id, COALESCE(pa.recv, 0) AS received, rf.cash AS refunded_cash
--      FROM sale s
--      JOIN (SELECT sale_id, SUM(COALESCE(refund_amount, 0)) AS cash FROM refund GROUP BY sale_id) rf ON rf.sale_id = s.id
--      LEFT JOIN (SELECT sale_id, SUM(amount) AS recv FROM payment_allocation GROUP BY sale_id) pa ON pa.sale_id = s.id
--      WHERE rf.cash > COALESCE(pa.recv, 0) + 0.005;
-- ④ 반품액 합 대조 (010 이후 반품만 정확히 일치, 이전 반품은 수량×단가 추정):
--      SELECT s.id, s.returned_amount, SUM(COALESCE(r.refund_amount,0) + r.credit_amount) AS by_refund
--      FROM sale s JOIN refund r ON r.sale_id = s.id GROUP BY s.id HAVING ABS(s.returned_amount - SUM(COALESCE(r.refund_amount,0) + r.credit_amount)) > 0.005;
