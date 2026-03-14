-- =============================================================================
-- 판매툴 DB 전체 스키마 (PostgreSQL) — 맨 처음부터 끝까지 한 번에 실행
-- =============================================================================
-- 1. DB 생성: psql 등에서 CREATE DATABASE sales_tool; 실행 후
-- 2. 이 파일 전체를 sales_tool DB에 대해 실행 (pgAdmin Query Tool 또는 psql -f schema-full.sql)
-- 재실행 시 아래 DROP 구문으로 기존 객체 제거 후 CREATE 됨.
-- =============================================================================

-- ---------- 기존 객체 제거 (재실행 시) ----------
DROP VIEW IF EXISTS receivables_by_partner;

DROP TABLE IF EXISTS product_transfers;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS disposals;
DROP TABLE IF EXISTS payment_allocations;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS purchases;
DROP TABLE IF EXISTS product_daily_prices;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS partners;

DROP TYPE IF EXISTS transfer_location_type;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS partner_type;

-- ---------- 타입 정의 ----------
CREATE TYPE partner_type AS ENUM ('supplier', 'customer');
CREATE TYPE payment_status AS ENUM ('paid', 'unpaid', 'partial');
CREATE TYPE transfer_location_type AS ENUM ('supplier', 'inventory', 'customer', 'disposal');

-- ---------- 1. 거래처 (구매처/판매처) ----------
CREATE TABLE partners (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  type       partner_type NOT NULL,
  contact    VARCHAR(100),
  phone      VARCHAR(50),
  address    TEXT,
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 2. 상품 마스터 ----------
CREATE TABLE products (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  unit       VARCHAR(50) NOT NULL DEFAULT 'kg',
  category   VARCHAR(100),
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 2-2. 상품별 일별 단가 ----------
CREATE TABLE product_daily_prices (
  id              SERIAL PRIMARY KEY,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  price_date      DATE NOT NULL,
  purchase_price  NUMERIC(12, 2),
  sale_price      NUMERIC(12, 2),
  memo            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (product_id, price_date)
);
CREATE INDEX idx_product_daily_prices_product_date ON product_daily_prices(product_id, price_date);

-- ---------- 3. 구매 (입고) ----------
CREATE TABLE purchases (
  id            SERIAL PRIMARY KEY,
  partner_id    INTEGER NOT NULL REFERENCES partners(id),
  product_id    INTEGER NOT NULL REFERENCES products(id),
  quantity      NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(12, 2) NOT NULL,
  total_amount  NUMERIC(14, 2) NOT NULL,
  purchase_date DATE NOT NULL,
  memo          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 4. 판매 (출고) ----------
CREATE TABLE sales (
  id             SERIAL PRIMARY KEY,
  partner_id     INTEGER NOT NULL REFERENCES partners(id),
  product_id     INTEGER NOT NULL REFERENCES products(id),
  quantity       NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_price     NUMERIC(12, 2) NOT NULL,
  cost_at_sale   NUMERIC(12, 2),
  total_amount   NUMERIC(14, 2) NOT NULL,
  sale_date      DATE NOT NULL,
  payment_status payment_status NOT NULL DEFAULT 'unpaid',
  paid_amount    NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  memo           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 4-2. 수금 (묶음 결제) ----------
CREATE TABLE payments (
  id         SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  amount     NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_at    DATE NOT NULL,
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 4-3. 수금 배분 ----------
CREATE TABLE payment_allocations (
  id          SERIAL PRIMARY KEY,
  payment_id  INTEGER NOT NULL REFERENCES payments(id),
  sale_id     INTEGER NOT NULL REFERENCES sales(id),
  amount      NUMERIC(14, 2) NOT NULL CHECK (amount > 0)
);
CREATE INDEX idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_sale ON payment_allocations(sale_id);

-- ---------- 5. 폐기 ----------
CREATE TABLE disposals (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id),
  quantity      NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  disposal_date DATE NOT NULL,
  reason        VARCHAR(200),
  memo          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_disposals_product_date ON disposals(product_id, disposal_date);

-- ---------- 6. 재고 (상품당 1행) ----------
CREATE TABLE inventory (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id),
  quantity   NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 7. 상품 이동 이력 (구매/판매/폐기 시 무조건 1건 등록) ----------
CREATE TABLE product_transfers (
  id              SERIAL PRIMARY KEY,
  product_id      INTEGER NOT NULL REFERENCES products(id),
  quantity        NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  from_type       transfer_location_type NOT NULL,
  to_type         transfer_location_type NOT NULL,
  from_partner_id INTEGER REFERENCES partners(id),
  to_partner_id   INTEGER REFERENCES partners(id),
  transferred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purchase_id     INTEGER REFERENCES purchases(id),
  sale_id         INTEGER REFERENCES sales(id),
  disposal_id     INTEGER REFERENCES disposals(id),
  memo            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_product_transfers_product_at ON product_transfers(product_id, transferred_at);
CREATE INDEX idx_product_transfers_from_to ON product_transfers(from_type, to_type);
CREATE INDEX idx_product_transfers_transferred_at ON product_transfers(transferred_at);

-- ---------- 인덱스 (조회/집계) ----------
CREATE INDEX idx_purchases_partner_date ON purchases(partner_id, purchase_date);
CREATE INDEX idx_purchases_product_date ON purchases(product_id, purchase_date);
CREATE INDEX idx_sales_partner_date ON sales(partner_id, sale_date);
CREATE INDEX idx_sales_product_date ON sales(product_id, sale_date);
CREATE INDEX idx_sales_payment_status ON sales(payment_status);

-- ---------- 뷰: 거래처별 미수금 합계 ----------
CREATE OR REPLACE VIEW receivables_by_partner AS
SELECT
  p.id AS partner_id,
  p.name AS partner_name,
  COALESCE(SUM(s.total_amount - s.paid_amount), 0) AS receivable_amount
FROM partners p
LEFT JOIN sales s ON s.partner_id = p.id AND s.payment_status IN ('unpaid', 'partial')
WHERE p.type = 'customer'
GROUP BY p.id, p.name;

-- =============================================================================
-- 끝. 테이블: partners, products, product_daily_prices, purchases, sales,
--            payments, payment_allocations, disposals, inventory, product_transfers
-- 뷰: receivables_by_partner
-- =============================================================================
