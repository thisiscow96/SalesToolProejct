-- 매입-매출 연결(purchase_allocation), 환불(refund), 이동 사유/위치(product_transfer), 거래처 위치·유형 확장, sale.status, payment.entry_kind
-- PostgreSQL. 기존 DB에 한 번 적용.

-- partner_type 확장 (이미 있으면 duplicate_object 무시)
DO $$ BEGIN
  ALTER TYPE partner_type ADD VALUE 'same_market';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE partner_type ADD VALUE 'wholesaler';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE partner_type ADD VALUE 'market_wholesaler';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE transfer_action AS ENUM ('purchase', 'sale', 'refund', 'disposal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE account ADD COLUMN IF NOT EXISTS location VARCHAR(200);

ALTER TABLE sale ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

ALTER TABLE payment ADD COLUMN IF NOT EXISTS entry_kind VARCHAR(20) NOT NULL DEFAULT 'receive';
UPDATE payment SET entry_kind = 'receive' WHERE entry_kind IS NULL OR entry_kind = '';

CREATE TABLE IF NOT EXISTS purchase_allocation (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES "user"(id),
  purchase_id INTEGER NOT NULL REFERENCES purchase(id) ON DELETE RESTRICT,
  sale_id     INTEGER NOT NULL REFERENCES sale(id) ON DELETE RESTRICT,
  quantity    NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchase_allocation_purchase ON purchase_allocation(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchase_allocation_sale ON purchase_allocation(sale_id);
CREATE INDEX IF NOT EXISTS idx_purchase_allocation_user ON purchase_allocation(user_id);

CREATE TABLE IF NOT EXISTS refund (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES "user"(id),
  sale_id        INTEGER NOT NULL REFERENCES sale(id) ON DELETE RESTRICT,
  quantity       NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  refund_amount  NUMERIC(14, 2),
  reason         TEXT,
  refunded_at    DATE NOT NULL,
  memo           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT refund_amount_nonneg CHECK (refund_amount IS NULL OR refund_amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_refund_user ON refund(user_id);
CREATE INDEX IF NOT EXISTS idx_refund_sale ON refund(sale_id);

ALTER TABLE product_transfer ADD COLUMN IF NOT EXISTS action_type transfer_action;
UPDATE product_transfer SET action_type = 'purchase' WHERE action_type IS NULL;
ALTER TABLE product_transfer ALTER COLUMN action_type SET DEFAULT 'purchase';
ALTER TABLE product_transfer ALTER COLUMN action_type SET NOT NULL;

ALTER TABLE product_transfer ADD COLUMN IF NOT EXISTS before_location VARCHAR(300);
ALTER TABLE product_transfer ADD COLUMN IF NOT EXISTS after_location VARCHAR(300);
ALTER TABLE product_transfer ADD COLUMN IF NOT EXISTS refund_id INTEGER REFERENCES refund(id);
