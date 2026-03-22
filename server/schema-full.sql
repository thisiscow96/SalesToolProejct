-- =============================================================================
-- 판매툴 DB 전체 스키마 (PostgreSQL) — 맨 처음부터 끝까지 한 번에 실행
-- =============================================================================
-- 1. DB 생성: psql 등에서 CREATE DATABASE sales_tool; 실행 후
-- 2. 이 파일 전체를 sales_tool DB에 대해 실행 (pgAdmin Query Tool 또는 psql -f schema-full.sql)
-- 재실행 시 아래 DROP 구문으로 기존 객체 제거 후 CREATE 됨.
-- =============================================================================

-- ---------- 기존 객체 제거 (재실행 시) ----------
-- 뷰
DROP VIEW IF EXISTS receivables_by_partner;

-- 테이블 (단수명 — 현재 스키마)
DROP TABLE IF EXISTS product_transfer;
DROP TABLE IF EXISTS purchase_allocation;
DROP TABLE IF EXISTS refund;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS disposal;
DROP TABLE IF EXISTS payment_allocation;
DROP TABLE IF EXISTS payment;
DROP TABLE IF EXISTS sale;
DROP TABLE IF EXISTS purchase;
DROP TABLE IF EXISTS product_daily_price;
DROP TABLE IF EXISTS product;
DROP TABLE IF EXISTS account;
DROP TABLE IF EXISTS terms_agreement;
DROP TABLE IF EXISTS email_verification;
DROP TABLE IF EXISTS "user";

-- 테이블 (과거 복수명 — 기존 DB 마이그레이션 시 제거)
DROP TABLE IF EXISTS product_transfers;
DROP TABLE IF EXISTS disposals;
DROP TABLE IF EXISTS payment_allocations;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS purchases;
DROP TABLE IF EXISTS product_daily_prices;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS partners;
DROP TABLE IF EXISTS terms_agreements;
DROP TABLE IF EXISTS email_verifications;
DROP TABLE IF EXISTS users;

-- 시퀀스
DROP SEQUENCE IF EXISTS user_user_key_seq;
DROP SEQUENCE IF EXISTS users_user_key_seq;

-- 타입 (테이블 제거 후 삭제 가능)
DROP TYPE IF EXISTS transfer_action;
DROP TYPE IF EXISTS transfer_location_type;
DROP TYPE IF EXISTS payment_status;
DROP TYPE IF EXISTS partner_type;
DROP TYPE IF EXISTS user_status;

-- ---------- 타입 정의 ----------
CREATE TYPE user_status AS ENUM ('active', 'suspended', 'withdrawn');
CREATE TYPE partner_type AS ENUM ('supplier', 'customer', 'same_market', 'wholesaler', 'market_wholesaler');
CREATE TYPE payment_status AS ENUM ('paid', 'unpaid', 'partial');
CREATE TYPE transfer_location_type AS ENUM ('supplier', 'inventory', 'customer', 'disposal');
CREATE TYPE transfer_action AS ENUM ('purchase', 'sale', 'refund', 'disposal');

-- ---------- 0. 회원 (가입·이메일인증·약관동의) ----------
CREATE SEQUENCE user_user_key_seq START 1;

CREATE TABLE "user" (
  id                SERIAL PRIMARY KEY,
  user_key          VARCHAR(10) NOT NULL UNIQUE DEFAULT ('GK' || LPAD(nextval('user_user_key_seq')::text, 6, '0')),
  name              VARCHAR(100) NOT NULL,
  phone             VARCHAR(20) NOT NULL UNIQUE,
  email             VARCHAR(255) NOT NULL UNIQUE,
  agent_no          VARCHAR(50) NOT NULL UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  email_verified_at TIMESTAMPTZ,
  terms_agreed_at   TIMESTAMPTZ NOT NULL,
  status            user_status NOT NULL DEFAULT 'active',
  is_admin          BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE email_verification (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  user_id     INTEGER REFERENCES "user"(id),
  code        VARCHAR(20) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_email_verification_email ON email_verification(email);
CREATE INDEX idx_email_verification_expires ON email_verification(expires_at);

CREATE TABLE terms_agreement (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  terms_type VARCHAR(50) NOT NULL,
  agreed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version    VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_terms_agreement_user ON terms_agreement(user_id);

-- ---------- 1. 거래처 (구매처/판매처) — 회원별 소유 ----------
CREATE TABLE account (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  name       VARCHAR(200) NOT NULL,
  type       partner_type NOT NULL,
  contact    VARCHAR(100),
  phone      VARCHAR(50),
  address    TEXT,
  location   VARCHAR(200),
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_account_user ON account(user_id);

-- ---------- 2. 상품 마스터 ----------
CREATE TABLE product (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(200) NOT NULL,
  unit           VARCHAR(50) NOT NULL DEFAULT 'kg',
  category       VARCHAR(100),
  category_large VARCHAR(100),
  category_mid   VARCHAR(100),
  category_small VARCHAR(100),
  product_key    VARCHAR(100),
  memo           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- 2-2. 상품별 일별 단가 — 회원별(금액은 생성한 회원만) ----------
CREATE TABLE product_daily_price (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES "user"(id),
  product_id      INTEGER NOT NULL REFERENCES product(id),
  price_date      DATE NOT NULL,
  purchase_price  NUMERIC(12, 2),
  sale_price      NUMERIC(12, 2),
  memo            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, product_id, price_date)
);
CREATE INDEX idx_product_daily_price_user_product_date ON product_daily_price(user_id, product_id, price_date);

-- ---------- 3. 구매 (입고) — 회원별 금액 데이터 ----------
CREATE TABLE purchase (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES "user"(id),
  partner_id    INTEGER NOT NULL REFERENCES account(id),
  product_id    INTEGER NOT NULL REFERENCES product(id),
  quantity      NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(12, 2) NOT NULL,
  total_amount  NUMERIC(14, 2) NOT NULL,
  purchase_date DATE NOT NULL,
  memo          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_purchase_user ON purchase(user_id);

-- ---------- 4. 판매 (출고) — 회원별 금액 데이터 ----------
CREATE TABLE sale (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES "user"(id),
  partner_id     INTEGER NOT NULL REFERENCES account(id),
  product_id     INTEGER NOT NULL REFERENCES product(id),
  quantity       NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  unit_price     NUMERIC(12, 2) NOT NULL,
  cost_at_sale   NUMERIC(12, 2),
  total_amount   NUMERIC(14, 2) NOT NULL,
  sale_date      DATE NOT NULL,
  payment_status payment_status NOT NULL DEFAULT 'unpaid',
  paid_amount    NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  status         VARCHAR(20) NOT NULL DEFAULT 'active',
  memo           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sale_user ON sale(user_id);

-- ---------- 3-2. 매입-매출 연결 (한 매출이 어떤 매입에서 소진되었는지) ----------
CREATE TABLE purchase_allocation (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES "user"(id),
  purchase_id INTEGER NOT NULL REFERENCES purchase(id) ON DELETE RESTRICT,
  sale_id     INTEGER NOT NULL REFERENCES sale(id) ON DELETE RESTRICT,
  quantity    NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_purchase_allocation_purchase ON purchase_allocation(purchase_id);
CREATE INDEX idx_purchase_allocation_sale ON purchase_allocation(sale_id);
CREATE INDEX idx_purchase_allocation_user ON purchase_allocation(user_id);

-- ---------- 4-1. 환불 (반품 수량·환불금) ----------
CREATE TABLE refund (
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
CREATE INDEX idx_refund_user ON refund(user_id);
CREATE INDEX idx_refund_sale ON refund(sale_id);

-- ---------- 4-2. 수금 (묶음 결제) — 회원별 ----------
CREATE TABLE payment (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  partner_id INTEGER NOT NULL REFERENCES account(id),
  amount     NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_at    TIMESTAMPTZ NOT NULL,
  entry_kind VARCHAR(20) NOT NULL DEFAULT 'receive',
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_payment_user ON payment(user_id);

-- ---------- 4-3. 수금 배분 ----------
CREATE TABLE payment_allocation (
  id          SERIAL PRIMARY KEY,
  payment_id  INTEGER NOT NULL REFERENCES payment(id),
  sale_id     INTEGER NOT NULL REFERENCES sale(id),
  amount      NUMERIC(14, 2) NOT NULL CHECK (amount > 0)
);
CREATE INDEX idx_payment_allocation_payment ON payment_allocation(payment_id);
CREATE INDEX idx_payment_allocation_sale ON payment_allocation(sale_id);

-- ---------- 5. 폐기 — 회원별 ----------
CREATE TABLE disposal (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES "user"(id),
  product_id    INTEGER NOT NULL REFERENCES product(id),
  quantity      NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  disposal_date DATE NOT NULL,
  reason        VARCHAR(200),
  memo          TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_disposal_user ON disposal(user_id);
CREATE INDEX idx_disposal_product_date ON disposal(product_id, disposal_date);

-- ---------- 6. 재고 (회원별·상품당 1행) ----------
CREATE TABLE inventory (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  quantity   NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);
CREATE INDEX idx_inventory_user ON inventory(user_id);

-- ---------- 7. 상품 이동 이력 — 회원별 ----------
CREATE TABLE product_transfer (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES "user"(id),
  product_id      INTEGER NOT NULL REFERENCES product(id),
  quantity        NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  action_type     transfer_action NOT NULL DEFAULT 'purchase',
  from_type       transfer_location_type NOT NULL,
  to_type         transfer_location_type NOT NULL,
  from_partner_id INTEGER REFERENCES account(id),
  to_partner_id   INTEGER REFERENCES account(id),
  before_location VARCHAR(300),
  after_location  VARCHAR(300),
  transferred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purchase_id     INTEGER REFERENCES purchase(id),
  sale_id         INTEGER REFERENCES sale(id),
  disposal_id     INTEGER REFERENCES disposal(id),
  refund_id       INTEGER REFERENCES refund(id),
  memo            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_product_transfer_user ON product_transfer(user_id);
CREATE INDEX idx_product_transfer_product_at ON product_transfer(product_id, transferred_at);
CREATE INDEX idx_product_transfer_from_to ON product_transfer(from_type, to_type);
CREATE INDEX idx_product_transfer_transferred_at ON product_transfer(transferred_at);

-- ---------- 인덱스 (조회/집계) ----------
CREATE INDEX idx_purchase_partner_date ON purchase(partner_id, purchase_date);
CREATE INDEX idx_purchase_product_date ON purchase(product_id, purchase_date);
CREATE INDEX idx_sale_partner_date ON sale(partner_id, sale_date);
CREATE INDEX idx_sale_product_date ON sale(product_id, sale_date);
CREATE INDEX idx_sale_payment_status ON sale(payment_status);

-- ---------- 뷰: 거래처별 미수금 합계 (회원별로 조회 시 user_id 조건 사용) ----------
CREATE OR REPLACE VIEW receivables_by_partner AS
SELECT
  a.user_id,
  a.id AS partner_id,
  a.name AS partner_name,
  COALESCE(SUM(s.total_amount - s.paid_amount), 0) AS receivable_amount
FROM account a
LEFT JOIN sale s ON s.partner_id = a.id AND s.payment_status IN ('unpaid', 'partial') AND s.user_id = a.user_id
WHERE a.type = 'customer'
GROUP BY a.user_id, a.id, a.name;

-- =============================================================================
-- 끝. 테이블: user, account, product, product_daily_price, purchase, sale,
--            purchase_allocation, refund, payment, payment_allocation, disposal, inventory, product_transfer
-- 뷰: receivables_by_partner
-- =============================================================================
