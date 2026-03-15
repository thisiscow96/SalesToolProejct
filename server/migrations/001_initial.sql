-- 초기 스키마 (한 번만 적용됨, IF NOT EXISTS로 재실행 시 오류 방지)
DO $$ BEGIN
  CREATE TYPE user_status AS ENUM ('active', 'suspended', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE partner_type AS ENUM ('supplier', 'customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM ('paid', 'unpaid', 'partial');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE transfer_location_type AS ENUM ('supplier', 'inventory', 'customer', 'disposal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS user_user_key_seq START 1;

CREATE TABLE IF NOT EXISTS "user" (
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

CREATE TABLE IF NOT EXISTS email_verification (
  id          SERIAL PRIMARY KEY,
  email       VARCHAR(255) NOT NULL,
  user_id     INTEGER REFERENCES "user"(id),
  code        VARCHAR(20) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_verification_email ON email_verification(email);
CREATE INDEX IF NOT EXISTS idx_email_verification_expires ON email_verification(expires_at);

CREATE TABLE IF NOT EXISTS terms_agreement (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  terms_type VARCHAR(50) NOT NULL,
  agreed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version    VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_terms_agreement_user ON terms_agreement(user_id);

CREATE TABLE IF NOT EXISTS account (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  name       VARCHAR(200) NOT NULL,
  type       partner_type NOT NULL,
  contact    VARCHAR(100),
  phone      VARCHAR(50),
  address    TEXT,
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_user ON account(user_id);

CREATE TABLE IF NOT EXISTS product (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(200) NOT NULL,
  unit       VARCHAR(50) NOT NULL DEFAULT 'kg',
  category   VARCHAR(100),
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS product_daily_price (
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
CREATE INDEX IF NOT EXISTS idx_product_daily_price_user_product_date ON product_daily_price(user_id, product_id, price_date);

CREATE TABLE IF NOT EXISTS purchase (
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
CREATE INDEX IF NOT EXISTS idx_purchase_user ON purchase(user_id);

CREATE TABLE IF NOT EXISTS sale (
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
  memo           TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sale_user ON sale(user_id);

CREATE TABLE IF NOT EXISTS payment (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  partner_id INTEGER NOT NULL REFERENCES account(id),
  amount     NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
  paid_at    DATE NOT NULL,
  memo       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payment_user ON payment(user_id);

CREATE TABLE IF NOT EXISTS payment_allocation (
  id          SERIAL PRIMARY KEY,
  payment_id  INTEGER NOT NULL REFERENCES payment(id),
  sale_id     INTEGER NOT NULL REFERENCES sale(id),
  amount      NUMERIC(14, 2) NOT NULL CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS idx_payment_allocation_payment ON payment_allocation(payment_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocation_sale ON payment_allocation(sale_id);

CREATE TABLE IF NOT EXISTS disposal (
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
CREATE INDEX IF NOT EXISTS idx_disposal_user ON disposal(user_id);
CREATE INDEX IF NOT EXISTS idx_disposal_product_date ON disposal(product_id, disposal_date);

CREATE TABLE IF NOT EXISTS inventory (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES "user"(id),
  product_id INTEGER NOT NULL REFERENCES product(id),
  quantity   NUMERIC(12, 3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_user ON inventory(user_id);

CREATE TABLE IF NOT EXISTS product_transfer (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES "user"(id),
  product_id      INTEGER NOT NULL REFERENCES product(id),
  quantity        NUMERIC(12, 3) NOT NULL CHECK (quantity > 0),
  from_type       transfer_location_type NOT NULL,
  to_type         transfer_location_type NOT NULL,
  from_partner_id INTEGER REFERENCES account(id),
  to_partner_id   INTEGER REFERENCES account(id),
  transferred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  purchase_id     INTEGER REFERENCES purchase(id),
  sale_id         INTEGER REFERENCES sale(id),
  disposal_id     INTEGER REFERENCES disposal(id),
  memo            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_product_transfer_user ON product_transfer(user_id);
CREATE INDEX IF NOT EXISTS idx_product_transfer_product_at ON product_transfer(product_id, transferred_at);
CREATE INDEX IF NOT EXISTS idx_product_transfer_from_to ON product_transfer(from_type, to_type);
CREATE INDEX IF NOT EXISTS idx_product_transfer_transferred_at ON product_transfer(transferred_at);

CREATE INDEX IF NOT EXISTS idx_purchase_partner_date ON purchase(partner_id, purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchase_product_date ON purchase(product_id, purchase_date);
CREATE INDEX IF NOT EXISTS idx_sale_partner_date ON sale(partner_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_sale_product_date ON sale(product_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_sale_payment_status ON sale(payment_status);

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
