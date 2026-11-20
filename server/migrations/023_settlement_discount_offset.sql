-- 023 (2026-11-21, T-401): 정산 할인·상계 + 생산자·원산지·지급 대상 칸
-- 설계: AI 팀 산출물 T-401_정산할인상계_설계.md 4장(할인·상계)·10.3(생산자·산지·지급 대상)
--
-- 원칙 (009·013·014와 같음)
--  * 기존 데이터는 지우지 않는다. 새 칸은 모두 0·NULL·active 로 시작 → 기존 미수·미지급 값이 변하지 않는다.
--  * 같은 파일을 다시 실행해도 오류가 나지 않는다(IF NOT EXISTS, 제약은 이름·정의로 확인, 뷰는 CREATE OR REPLACE).
--  * migrate.js 는 파일 하나를 트랜잭션 하나로 실행한다 → 이 파일에서 추가한 enum 값 'producer' 는
--    같은 트랜잭션에서 enum 으로 쓸 수 없다. 아래 뷰·조건은 a.type::text IN (...) 처럼 text 로 비교한다.
--
-- 계산 규칙
--   매출 정리액 = 받은 돈(paid_amount) + 할인(discount_amount) + 상계(offset_amount)
--   매출 1건의 미수 = 총액 − 반품액 − 정리액          (현금 환불은 받은 돈에서만 빠진다 — 반품 규칙 B)
--   매입 1건의 미지급 = 총액 − paid_amount            (paid_amount 에 지급·기초 정리·지급 할인·상계 배분이 모두 들어감, 014와 같음)
--   상계 1건 = settlement_offset 1행 + payment(entry_kind=offset) 1행 + supplier_payment(kind=offset) 1행, 같은 offset_id

CREATE OR REPLACE FUNCTION pg_temp.add_con_023(tbl text, con text, def text) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = con AND conrelid = tbl::regclass) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s NOT VALID', tbl, con, def);
  END IF;
  BEGIN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', tbl, con);
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE '[023] % . % : 기존 데이터가 제약을 어겨 VALIDATE 를 건너뜀 (새 행부터 적용)', tbl, con;
  END;
END $$ LANGUAGE plpgsql;

-- 정의가 바뀐 제약을 교체: 이름이 같고 정의에 marker 가 없으면 DROP 후 add_con_023
CREATE OR REPLACE FUNCTION pg_temp.replace_con_023(tbl text, con text, marker text, def text) RETURNS void AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = con AND conrelid = tbl::regclass
             AND pg_get_constraintdef(oid) NOT LIKE '%' || marker || '%') THEN
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', tbl, con);
  END IF;
  PERFORM pg_temp.add_con_023(tbl, con, def);
END $$ LANGUAGE plpgsql;

-- ======================================================================
-- 1. 매출: 할인·상계 칸 (sale.paid_amount 는 "받은 현금"만 — 반품 때 돌려줄 수 있는 돈)
-- ======================================================================
ALTER TABLE sale ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE sale ADD COLUMN IF NOT EXISTS offset_amount   NUMERIC(14, 2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN sale.discount_amount IS '정산 할인(매출 할인) — 취소 안 된 payment(entry_kind=discount) 배분 합. 현금 아님 (T-401)';
COMMENT ON COLUMN sale.offset_amount   IS '상계 — 취소 안 된 payment(entry_kind=offset) 배분 합. 현금 아님 (T-401)';
SELECT pg_temp.add_con_023('sale', 'sale_discount_nonneg', 'CHECK (discount_amount >= 0)');
SELECT pg_temp.add_con_023('sale', 'sale_offset_nonneg',   'CHECK (offset_amount >= 0)');
-- 013 정의(paid ≤ 순매출 + overpaid)에 할인·상계를 더한다. 새 칸이 0이라 기존 행은 모두 통과
SELECT pg_temp.replace_con_023('sale', 'sale_paid_not_over_net', 'discount_amount',
  'CHECK (paid_amount + discount_amount + offset_amount <= total_amount - returned_amount + overpaid_amount)');

ALTER TABLE refund ADD COLUMN IF NOT EXISTS discount_reversed_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN refund.discount_reversed_amount IS '반품 때 되돌린 매출 할인(미수 차감 → 할인 되돌림 → 현금 환불 순서, T-401 3.4)';
SELECT pg_temp.add_con_023('refund', 'refund_discount_reversed_nonneg', 'CHECK (discount_reversed_amount >= 0)');

-- ======================================================================
-- 2. 수금(payment): 종류 discount·offset, 취소 상태
-- ======================================================================
ALTER TABLE payment ADD COLUMN IF NOT EXISTS status        VARCHAR(10) NOT NULL DEFAULT 'active';
ALTER TABLE payment ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(200);
ALTER TABLE payment ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE payment ADD COLUMN IF NOT EXISTS offset_id     INTEGER;
COMMENT ON COLUMN payment.status IS 'active | cancelled — 취소는 할인(discount)·상계(offset)만 (T-401). 현금 수금·환불은 취소 API 없음';
SELECT pg_temp.add_con_023('payment', 'payment_status_valid', $c$CHECK (status IN ('active', 'cancelled'))$c$);
SELECT pg_temp.add_con_023('payment', 'payment_cancel_match', $c$CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))$c$);
SELECT pg_temp.replace_con_023('payment', 'payment_entry_kind_valid', 'discount',
  $c$CHECK (entry_kind IN ('receive', 'refund', 'discount', 'offset'))$c$);
SELECT pg_temp.add_con_023('payment', 'payment_offset_match', $c$CHECK ((entry_kind = 'offset') = (offset_id IS NOT NULL))$c$);
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_id_user ON payment (id, user_id);

-- ======================================================================
-- 3. 상계
-- ======================================================================
CREATE TABLE IF NOT EXISTS settlement_offset (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES "user"(id),
  partner_id    INTEGER NOT NULL,
  amount        NUMERIC(14, 2) NOT NULL,
  offset_at     TIMESTAMPTZ NOT NULL,
  memo          TEXT,
  status        VARCHAR(10) NOT NULL DEFAULT 'active',
  cancelled_at  TIMESTAMPTZ,
  cancel_reason VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlement_offset_amount_pos   CHECK (amount > 0),
  CONSTRAINT settlement_offset_status_valid CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT settlement_offset_cancel_match CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT fk_so_partner_same_user FOREIGN KEY (partner_id, user_id) REFERENCES account (id, user_id)
);
COMMENT ON TABLE settlement_offset IS '상계(T-401): 같은 거래처의 미수와 미지급을 같은 금액만큼 동시에 지운 기록. 수금 쪽 payment(offset)·지급 쪽 supplier_payment(offset)가 offset_id 로 묶인다. 취소는 셋 모두 status=cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS ux_settlement_offset_id_user ON settlement_offset (id, user_id);
CREATE INDEX IF NOT EXISTS idx_settlement_offset_user_at ON settlement_offset (user_id, offset_at);
CREATE INDEX IF NOT EXISTS idx_settlement_offset_user_partner ON settlement_offset (user_id, partner_id, offset_at);

SELECT pg_temp.add_con_023('payment', 'fk_payment_offset_same_user',
  'FOREIGN KEY (offset_id, user_id) REFERENCES settlement_offset (id, user_id) ON DELETE RESTRICT');
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_offset ON payment (offset_id) WHERE offset_id IS NOT NULL;

-- ======================================================================
-- 4. 지급(supplier_payment): 종류 discount·offset
-- ======================================================================
ALTER TABLE supplier_payment ADD COLUMN IF NOT EXISTS offset_id INTEGER;
SELECT pg_temp.replace_con_023('supplier_payment', 'supplier_payment_kind_valid', 'discount',
  $c$CHECK (kind IN ('pay', 'opening', 'discount', 'offset'))$c$);
SELECT pg_temp.add_con_023('supplier_payment', 'supplier_payment_offset_match', $c$CHECK ((kind = 'offset') = (offset_id IS NOT NULL))$c$);
-- 현금이 아닌 종류(기초 정리·할인·상계)는 지급 방법이 없다. 기초 정리는 014부터 method NULL 로 저장 → 기존 행 통과 예상(어기면 NOTICE)
SELECT pg_temp.add_con_023('supplier_payment', 'supplier_payment_noncash_no_method', $c$CHECK (kind = 'pay' OR method IS NULL)$c$);
SELECT pg_temp.add_con_023('supplier_payment', 'fk_supplier_payment_offset_same_user',
  'FOREIGN KEY (offset_id, user_id) REFERENCES settlement_offset (id, user_id) ON DELETE RESTRICT');
CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_payment_offset ON supplier_payment (offset_id) WHERE offset_id IS NOT NULL;

-- ======================================================================
-- 5. (10장) 생산자(출하주) 유형 · 산지 · 입금 계좌 · 매입의 생산자·산지·지급 대상
-- ======================================================================
ALTER TYPE partner_type ADD VALUE IF NOT EXISTS 'producer';

ALTER TABLE account ADD COLUMN IF NOT EXISTS origin_region VARCHAR(100);
ALTER TABLE account ADD COLUMN IF NOT EXISTS bank_name     VARCHAR(50);
ALTER TABLE account ADD COLUMN IF NOT EXISTS bank_account  VARCHAR(50);
ALTER TABLE account ADD COLUMN IF NOT EXISTS bank_holder   VARCHAR(100);
COMMENT ON COLUMN account.origin_region IS '생산자 산지(시·군). location(시장 안 위치)과 다름 (T-401 10장)';
COMMENT ON COLUMN account.bank_account  IS '입금 계좌번호 — 개인정보. 직원·변경 이력에는 뒤 4자리만 (PR-08)';
SELECT pg_temp.add_con_023('account', 'account_bank_account_format', $c$CHECK (bank_account IS NULL OR bank_account ~ '^[0-9-]{4,50}$')$c$);

ALTER TABLE purchase ADD COLUMN IF NOT EXISTS producer_id      INTEGER;
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS origin_region    VARCHAR(100);
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS payee_partner_id INTEGER;
COMMENT ON COLUMN purchase.producer_id      IS '생산자(원산지 거래처, 선택). 유형 검사는 API (T-401 10장)';
COMMENT ON COLUMN purchase.origin_region    IS '이 매입의 산지 스냅숏. 비우면 저장 시 생산자 산지 복사';
COMMENT ON COLUMN purchase.payee_partner_id IS '지급 대상 = 제공처(partner_id, 기본) 또는 생산자(producer_id). 미지급·지급 원장·지급 할인·상계는 이 칸 기준';

-- 기존 매입: 지급 대상 = 제공처 (RQ-14 — 023 전후 미지급 값이 같다)
UPDATE purchase SET payee_partner_id = partner_id WHERE payee_partner_id IS NULL;

-- 지급 대상을 안 넣은 INSERT 는 제공처로, 제공처를 바꾸면(지급 대상이 제공처였던 매입) 지급 대상도 같이 바뀐다 (PR-04)
CREATE OR REPLACE FUNCTION purchase_payee_default() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payee_partner_id IS NULL THEN NEW.payee_partner_id := NEW.partner_id; END IF;
  ELSIF NEW.partner_id IS DISTINCT FROM OLD.partner_id
        AND NEW.payee_partner_id IS NOT DISTINCT FROM OLD.payee_partner_id
        AND OLD.payee_partner_id = OLD.partner_id THEN
    NEW.payee_partner_id := NEW.partner_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_purchase_payee_default ON purchase;
CREATE TRIGGER trg_purchase_payee_default BEFORE INSERT OR UPDATE OF partner_id, payee_partner_id ON purchase
  FOR EACH ROW EXECUTE FUNCTION purchase_payee_default();

ALTER TABLE purchase ALTER COLUMN payee_partner_id SET NOT NULL;
SELECT pg_temp.add_con_023('purchase', 'fk_purchase_producer_same_user',
  'FOREIGN KEY (producer_id, user_id) REFERENCES account (id, user_id)');
SELECT pg_temp.add_con_023('purchase', 'fk_purchase_payee_same_user',
  'FOREIGN KEY (payee_partner_id, user_id) REFERENCES account (id, user_id)');
SELECT pg_temp.add_con_023('purchase', 'purchase_payee_valid',
  'CHECK (payee_partner_id = partner_id OR payee_partner_id = producer_id)');
CREATE INDEX IF NOT EXISTS idx_purchase_user_payee_unpaid ON purchase (user_id, payee_partner_id, purchase_date)
  WHERE payment_status IN ('unpaid', 'partial') AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_purchase_user_producer ON purchase (user_id, producer_id) WHERE producer_id IS NOT NULL;

-- ======================================================================
-- 6. 뷰 (열 이름·타입·순서는 그대로 — CREATE OR REPLACE 조건)
-- ======================================================================
-- 매출 원장: 수금·환불은 취소 안 된 것만, 할인·상계·할인 되돌림 가지 추가
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
SELECT r.user_id, s.partner_id, r.refunded_at, 2, 'return', r.id, r.sale_id,
       s.product_id, r.quantity, s.unit_price,
       0, COALESCE(r.return_amount, COALESCE(r.refund_amount, 0) + COALESCE(r.credit_amount, 0)),
       COALESCE(r.credit_amount, 0), COALESCE(r.refund_amount, 0),
       r.reason, r.created_at
FROM refund r
JOIN sale s ON s.id = r.sale_id AND s.user_id = r.user_id
WHERE s.status <> 'cancelled'
UNION ALL
-- 할인 되돌림 (+): 반품된 물건에 준 할인을 다시 받을 돈으로
SELECT r.user_id, s.partner_id, r.refunded_at, 2, 'discount_reversal', r.id, r.sale_id,
       s.product_id, NULL, NULL,
       r.discount_reversed_amount, 0, NULL, NULL,
       r.reason, r.created_at
FROM refund r
JOIN sale s ON s.id = r.sale_id AND s.user_id = r.user_id
WHERE s.status <> 'cancelled' AND r.discount_reversed_amount > 0
UNION ALL
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 3, 'receipt', p.id, NULL,
       NULL, NULL, NULL,
       0, p.amount, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'receive' AND p.status = 'active'
UNION ALL
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 3, 'discount', p.id, NULL,
       NULL, NULL, NULL,
       0, p.amount, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'discount' AND p.status = 'active'
UNION ALL
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 3, 'offset', p.id, NULL,
       NULL, NULL, NULL,
       0, p.amount, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'offset' AND p.status = 'active'
UNION ALL
SELECT p.user_id, p.partner_id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, 4, 'refund_cash', p.id, NULL,
       NULL, NULL, NULL,
       p.amount, 0, NULL, NULL, p.memo, p.paid_at
FROM payment p
WHERE p.entry_kind = 'refund' AND p.status = 'active';

CREATE OR REPLACE VIEW receivables_by_partner AS
SELECT
  a.user_id,
  a.id   AS partner_id,
  a.name AS partner_name,
  COALESCE(SUM(GREATEST(s.total_amount - s.returned_amount - s.paid_amount - s.discount_amount - s.offset_amount, 0)), 0) AS receivable_amount
FROM account a
LEFT JOIN sale s ON s.partner_id = a.id AND s.user_id = a.user_id
  AND s.payment_status IN ('unpaid', 'partial')
  AND s.status <> 'cancelled'
WHERE a.type::text IN ('customer', 'same_market', 'wholesaler', 'market_wholesaler')
GROUP BY a.user_id, a.id, a.name;

-- 지급 원장: 매입 가지는 지급 대상(payee) 기준 — "돈을 줄 상대"의 장부 (PR-05). 기존 매입은 payee = partner 라 값이 같다
CREATE OR REPLACE VIEW supplier_ledger_entry AS
SELECT pu.user_id,
       pu.payee_partner_id     AS partner_id,
       pu.purchase_date        AS entry_date,
       1                        AS kind_order,
       'purchase'::text         AS kind,
       pu.id                    AS ref_id,
       pu.product_id,
       pu.quantity,
       pu.unit_price,
       pu.total_amount          AS increase,
       0::numeric(14, 2)        AS decrease,
       NULL::text               AS pay_kind,
       NULL::text               AS method,
       pu.memo,
       pu.created_at            AS entered_at
FROM purchase pu
WHERE pu.status = 'active'
UNION ALL
SELECT sp.user_id, sp.partner_id, (sp.paid_at AT TIME ZONE 'Asia/Seoul')::date, 2, 'payment', sp.id,
       NULL, NULL, NULL,
       0::numeric(14, 2), sp.amount, sp.kind::text, sp.method::text, sp.memo, sp.paid_at
FROM supplier_payment sp
WHERE sp.status = 'active';

CREATE OR REPLACE VIEW payables_by_partner AS
SELECT a.user_id,
       a.id   AS partner_id,
       a.name AS partner_name,
       COALESCE(SUM(pu.total_amount - pu.paid_amount), 0) AS payable_amount
FROM account a
LEFT JOIN purchase pu ON pu.payee_partner_id = a.id AND pu.user_id = a.user_id
  AND pu.status = 'active' AND pu.payment_status IN ('unpaid', 'partial')
WHERE a.type::text IN ('supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer')
GROUP BY a.user_id, a.id, a.name;

-- ======================================================================
-- 확인 SQL (사용자가 직접 — 이 파일은 실행하지 않음). 모두 0행이어야 한다
-- ① 매출 할인·상계 유지 칸 = 취소 안 된 배분 합 (할인은 반품 때 되돌린 금액을 뺀다):
--      SELECT s.id, s.discount_amount, s.offset_amount, x.d, x.o FROM sale s
--      LEFT JOIN (SELECT pa.sale_id, SUM(pa.amount) FILTER (WHERE p.entry_kind='discount') - COALESCE((SELECT SUM(r.discount_reversed_amount) FROM refund r WHERE r.sale_id = pa.sale_id), 0) d, SUM(pa.amount) FILTER (WHERE p.entry_kind='offset') o
--                 FROM payment_allocation pa JOIN payment p ON p.id = pa.payment_id AND p.status='active' GROUP BY pa.sale_id) x ON x.sale_id = s.id
--      WHERE s.discount_amount <> COALESCE(x.d,0) OR s.offset_amount <> COALESCE(x.o,0);
-- ② 상계 3행 상태 일치:
--      SELECT so.id FROM settlement_offset so JOIN payment p ON p.offset_id = so.id JOIN supplier_payment sp ON sp.offset_id = so.id
--      WHERE so.status <> p.status OR so.status <> sp.status OR so.amount <> p.amount OR so.amount <> sp.amount;
-- ③ 지급 대상 백필: SELECT id FROM purchase WHERE payee_partner_id IS NULL OR (producer_id IS NULL AND payee_partner_id <> partner_id);
-- ======================================================================
