-- 판매툴 DB 스키마 (PostgreSQL)
-- 실행: psql 또는 pgAdmin에서 sales_tool DB 선택 후 실행

-- 거래처 타입
CREATE TYPE partner_type AS ENUM ('supplier', 'customer');

-- 결제 상태
CREATE TYPE payment_status AS ENUM ('paid', 'unpaid', 'partial');

-- 이동 구간 타입 (어디에서 어디로)
CREATE TYPE transfer_location_type AS ENUM ('supplier', 'inventory', 'customer', 'disposal');

-- 1. 거래처 (구매처/판매처)
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

-- 2. 상품 마스터 (한정된 품목만, 단가는 일별 테이블에서 관리)
CREATE TABLE products (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  unit       VARCHAR(50) NOT NULL DEFAULT 'kg',
  category   VARCHAR(100),
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2-2. 상품별 일별 단가 (그날 경매/시세 — 금액 들쑥날쑥)
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

-- 3. 구매 (입고)
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

-- 4. 판매 (출고) — 손해 판매 시 unit_price < cost_at_sale. paid_amount는 수금 배분 시 갱신
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

-- 4-2. 수금 (묶음 결제 — 한 번에 받은 금액)
CREATE TABLE payments (
  id         SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  amount     NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_at    DATE NOT NULL,
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4-3. 수금 배분 (한 수금을 여러 판매 건에 나눠 배분)
CREATE TABLE payment_allocations (
  id          SERIAL PRIMARY KEY,
  payment_id  INTEGER NOT NULL REFERENCES payments(id),
  sale_id     INTEGER NOT NULL REFERENCES sales(id),
  amount      NUMERIC(14, 2) NOT NULL CHECK (amount > 0)
);
CREATE INDEX idx_payment_allocations_payment ON payment_allocations(payment_id);
CREATE INDEX idx_payment_allocations_sale ON payment_allocations(sale_id);

-- 5. 폐기 (재고 감소, 매출 없음)
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

-- 6. 재고 (상품당 1행. 구매↑ / 판매·폐기↓)
CREATE TABLE inventory (
  id         SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL UNIQUE REFERENCES products(id),
  quantity   NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. 상품 이동 이력 (product_transfers) — 구매/판매/폐기 시 무조건 1건 등록. 몇 시에 어디→어디 추적
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
-- 규칙: 구매 → (구매처→재고), 판매 → (재고→거래처), 폐기 → (재고→폐기). purchase_id/sale_id/disposal_id 중 하나만 채움
CREATE INDEX idx_product_transfers_product_at ON product_transfers(product_id, transferred_at);
CREATE INDEX idx_product_transfers_from_to ON product_transfers(from_type, to_type);
CREATE INDEX idx_product_transfers_transferred_at ON product_transfers(transferred_at);

-- 인덱스 (조회/집계용)
CREATE INDEX idx_purchases_partner_date ON purchases(partner_id, purchase_date);
CREATE INDEX idx_purchases_product_date ON purchases(product_id, purchase_date);
CREATE INDEX idx_sales_partner_date ON sales(partner_id, sale_date);
CREATE INDEX idx_sales_product_date ON sales(product_id, sale_date);
CREATE INDEX idx_sales_payment_status ON sales(payment_status);

-- 거래처별 미수금 합계 뷰 (paid_amount = allocations 합계로 유지한다고 가정)
CREATE OR REPLACE VIEW receivables_by_partner AS
SELECT
  p.id AS partner_id,
  p.name AS partner_name,
  COALESCE(SUM(s.total_amount - s.paid_amount), 0) AS receivable_amount
FROM partners p
LEFT JOIN sales s ON s.partner_id = p.id AND s.payment_status IN ('unpaid', 'partial')
WHERE p.type = 'customer'
GROUP BY p.id, p.name;
