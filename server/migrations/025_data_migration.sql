-- 025 (2026-11-21, T-403): 데이터 이관(마이그레이션) — 이관 묶음 · 기초 미수/미지급 · 이관 재고 · 이관 기록
-- 설계: AI 팀 산출물 T-403_데이터이관_설계.md 4장
--
-- 원칙 (009·013·014·023과 같음)
--  * 기존 데이터는 지우지 않는다. 새 칸은 NULL·'normal'·false 로 시작 → 기존 미수·미지급·재고·원장 값이 변하지 않는다.
--  * 같은 파일을 다시 실행해도 오류가 나지 않는다(IF NOT EXISTS, 제약은 이름·정의로 확인, 뷰는 CREATE OR REPLACE).
--
-- 저장 위치
--   기초 미수   → sale     (entry_mode='opening', 시스템 품목 "이관 기초 잔액", 수량 1)  — 미수·연령·원장·한도·수금 배분이 그대로 맞는다
--   기초 미지급 → purchase (entry_kind='opening_ap', 시스템 품목, 재고·로트 제외)
--   이관 재고   → purchase (entry_kind='opening_stock', 실제 품목·수량·원가 단가·입고일, total_amount=paid_amount=0 → 상태 paid) + inventory 증가 — 줄 돈 원장에서 제외
--   과거 거래·기준일 이전 폐기 → migration_history (기록 전용, 잔액·재고 영향 없음)
--   기준일 이후 폐기 → disposal (기존 폐기 API 그대로, migration_batch_id 표시)

-- ======================================================================
-- 1. 이관 묶음 · 올린 파일 · 이관 기록
-- ======================================================================
CREATE TABLE IF NOT EXISTS migration_batch (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES "user"(id),
  cutover_date    DATE NOT NULL,
  status          VARCHAR(12) NOT NULL DEFAULT 'draft',
  memo            VARCHAR(200),
  counts          JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings        JSONB NOT NULL DEFAULT '[]'::jsonb,
  restore         JSONB NOT NULL DEFAULT '{}'::jsonb,
  saved_at        TIMESTAMPTZ,
  rolled_back_at  TIMESTAMPTZ,
  rollback_reason VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT migration_batch_status_chk CHECK (status IN ('draft', 'saved', 'rolled_back')),
  CONSTRAINT migration_batch_rollback_match CHECK ((status = 'rolled_back') = (rolled_back_at IS NOT NULL)),
  CONSTRAINT migration_batch_saved_match CHECK (status = 'draft' OR saved_at IS NOT NULL)
);
COMMENT ON TABLE migration_batch IS 'T-403 데이터 이관 묶음: 기준일 1개 + 올린 파일 + 저장 결과. draft(검증 중)·saved(저장됨)·rolled_back(되돌림)';
CREATE INDEX IF NOT EXISTS idx_migration_batch_user_created ON migration_batch (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS migration_batch_file (
  id           BIGSERIAL PRIMARY KEY,
  batch_id     BIGINT NOT NULL REFERENCES migration_batch(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES "user"(id),
  kind         VARCHAR(20) NOT NULL,
  file_hash    CHAR(64) NOT NULL,
  file_name    VARCHAR(200),
  row_count    INTEGER NOT NULL CHECK (row_count >= 0),
  amount_total NUMERIC(16,2),
  qty_total    NUMERIC(16,3),
  rows         JSONB NOT NULL DEFAULT '[]'::jsonb,
  result       JSONB,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT migration_batch_file_kind_chk CHECK (kind IN ('partner', 'product', 'opening_ar', 'opening_ap', 'opening_stock', 'history', 'disposal'))
);
COMMENT ON TABLE migration_batch_file IS 'T-403 이관 묶음에 올린 파일(대상별 1개). rows = 읽은 줄(대조 리포트의 "파일 합" 원천)';
CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_batch_file_kind ON migration_batch_file (batch_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS uq_migration_batch_file_hash ON migration_batch_file (user_id, file_hash) WHERE active;

CREATE TABLE IF NOT EXISTS migration_history (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES "user"(id),
  batch_id     BIGINT NOT NULL REFERENCES migration_batch(id) ON DELETE CASCADE,
  kind         VARCHAR(20) NOT NULL,
  txn_date     DATE NOT NULL,
  partner_id   INTEGER REFERENCES account(id),
  partner_name VARCHAR(100),
  product_id   INTEGER REFERENCES product(id),
  product_name VARCHAR(100),
  quantity     NUMERIC(14,3),
  unit_price   NUMERIC(14,2),
  amount       NUMERIC(16,2) NOT NULL DEFAULT 0,
  cost_amount  NUMERIC(16,2),
  external_ref VARCHAR(50),
  memo         TEXT,
  line_no      INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT migration_history_kind_chk CHECK (kind IN ('purchase', 'sale', 'receipt', 'supplier_payment', 'disposal')),
  CONSTRAINT migration_history_amount_chk CHECK (amount >= 0)
);
COMMENT ON TABLE migration_history IS 'T-403 이관 기록(참고): 과거 거래·기준일 이전 폐기. 미수·미지급·재고·원장에 영향 없음';
CREATE INDEX IF NOT EXISTS idx_migration_history_user_date ON migration_history (user_id, txn_date);
CREATE INDEX IF NOT EXISTS idx_migration_history_batch ON migration_history (batch_id);

-- ======================================================================
-- 2. 기존 표에 칸 추가
-- ======================================================================
ALTER TABLE account  ADD COLUMN IF NOT EXISTS external_code VARCHAR(50);
ALTER TABLE account  ADD COLUMN IF NOT EXISTS migration_batch_id BIGINT;
ALTER TABLE product  ADD COLUMN IF NOT EXISTS external_code VARCHAR(50);
ALTER TABLE product  ADD COLUMN IF NOT EXISTS migration_batch_id BIGINT;
ALTER TABLE product  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS entry_kind VARCHAR(15) NOT NULL DEFAULT 'normal';
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS migration_batch_id BIGINT;
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS external_ref VARCHAR(50);
ALTER TABLE sale     ADD COLUMN IF NOT EXISTS migration_batch_id BIGINT;
ALTER TABLE sale     ADD COLUMN IF NOT EXISTS external_ref VARCHAR(50);
ALTER TABLE disposal ADD COLUMN IF NOT EXISTS migration_batch_id BIGINT;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['account', 'product', 'purchase', 'sale', 'disposal'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_' || t || '_migration_batch') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (migration_batch_id) REFERENCES migration_batch(id) ON DELETE RESTRICT',
                     t, 'fk_' || t || '_migration_batch');
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (migration_batch_id) WHERE migration_batch_id IS NOT NULL',
                   'idx_' || t || '_migration_batch', t);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_entry_kind_valid') THEN
    ALTER TABLE purchase ADD CONSTRAINT purchase_entry_kind_valid CHECK (entry_kind IN ('normal', 'opening_ap', 'opening_stock'));
  END IF;
  -- sale.entry_mode 에 opening 허용 (015 의 제약을 같은 이름으로 다시)
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_entry_mode_valid'
             AND pg_get_constraintdef(oid) NOT LIKE '%opening%') THEN
    ALTER TABLE sale DROP CONSTRAINT sale_entry_mode_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_entry_mode_valid') THEN
    ALTER TABLE sale ADD CONSTRAINT sale_entry_mode_valid CHECK (entry_mode IN ('convert', 'fifo', 'opening'));
  END IF;
END $$;

COMMENT ON COLUMN purchase.entry_kind IS 'T-403 normal(일반 매입) / opening_ap(이관 기초 미지급 — 재고 없음) / opening_stock(이관 재고 로트 — 지급 완료, 줄 돈 원장 제외)';
COMMENT ON COLUMN sale.entry_mode IS 'T-205 convert / fifo, T-403 opening(이관 기초 미수 — 재고 없음, 매출 합계 제외)';
COMMENT ON COLUMN product.is_system IS 'T-403 시스템 품목("이관 기초 잔액") — 품목 목록·선택창에 안 보임';

CREATE UNIQUE INDEX IF NOT EXISTS uq_account_user_external_code ON account (user_id, external_code) WHERE external_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_owner_external_code ON product (COALESCE(owner_user_id, 0), external_code) WHERE external_code IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_opening_ref ON purchase (user_id, external_ref)
  WHERE entry_kind <> 'normal' AND external_ref IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_opening_ref ON sale (user_id, external_ref)
  WHERE entry_mode = 'opening' AND external_ref IS NOT NULL AND status <> 'cancelled';

-- 시스템 품목 1행 (없을 때만). id 를 큰 고정값(2,000,000,000)으로 둔다 — 새 DB 에서 025 가 품목보다 먼저 돌아도
-- "id 가 가장 작은 공용 품목"을 쓰는 기존 스크립트·화면 정렬이 시스템 품목을 고르지 않게. 시퀀스는 건드리지 않는다(일반 품목 id 는 계속 작은 수)
-- product_key 도 고정값(PSYS-MIG) — generateProductKey 의 ^P[0-9]+$ 계산에 끼지 않는다
INSERT INTO product (id, name, unit, memo, is_system, owner_user_id, category_large, product_key)
SELECT 2000000000, '이관 기초 잔액', '건', 'T-403 데이터 이관 — 기초 미수·미지급 행 전용(품목 목록에 안 보임)', true, NULL, '이관', 'PSYS-MIG'
WHERE NOT EXISTS (SELECT 1 FROM product WHERE is_system);

-- ======================================================================
-- 3. 변경 이력(019) 값 목록 넓힘 — 024 와 같은 방식
-- ======================================================================
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_type_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN ('account', 'auth', 'staff', 'upload', 'migration'));
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_chk CHECK (action IN (
  'create', 'update', 'login',
  'suspend', 'resume', 'delete', 'password_reset', 'password_set', 'invite',
  'upload', 'migrate', 'rollback'
));

-- ======================================================================
-- 4. 뷰 — 023 최신 정의 그대로 + 가지 조건만. 칸은 늘리지 않는다(옛 마이그레이션 012·014·015 를 다시 실행하는 회귀 검사가
--    CREATE OR REPLACE 로 칸 수가 줄면 실패하므로 — 설계 4.4 의 is_opening 칸은 원장 라우트에서 매출·매입을 조인해 계산)
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
SELECT r.user_id, s.partner_id, r.refunded_at, 2, 'return', r.id, r.sale_id,
       s.product_id, r.quantity, s.unit_price,
       0, COALESCE(r.return_amount, COALESCE(r.refund_amount, 0) + COALESCE(r.credit_amount, 0)),
       COALESCE(r.credit_amount, 0), COALESCE(r.refund_amount, 0),
       r.reason, r.created_at
FROM refund r
JOIN sale s ON s.id = r.sale_id AND s.user_id = r.user_id
WHERE s.status <> 'cancelled'
UNION ALL
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

-- 줄 돈 원장: 이관 재고(opening_stock)는 돈이 아니므로 뺀다. 기초 미지급(opening_ap)은 "이관 기초"로 들어간다
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
WHERE pu.status = 'active' AND pu.entry_kind <> 'opening_stock'
UNION ALL
SELECT sp.user_id, sp.partner_id, (sp.paid_at AT TIME ZONE 'Asia/Seoul')::date, 2, 'payment', sp.id,
       NULL, NULL, NULL,
       0::numeric(14, 2), sp.amount, sp.kind::text, sp.method::text, sp.memo, sp.paid_at
FROM supplier_payment sp
WHERE sp.status = 'active';

-- 재고 로트: 기초 미지급(opening_ap)은 물건이 없으므로 로트가 아니다. 이관 재고(opening_stock)는 로트
CREATE OR REPLACE VIEW inventory_lot_available AS
WITH lots AS (
  SELECT pu.user_id, pu.product_id, pu.id AS purchase_id, pu.purchase_date, pu.unit_price,
         pu.partner_id, pu.source_name,
         pu.quantity - COALESCE(al.q, 0) AS remain
  FROM purchase pu
  LEFT JOIN LATERAL (
    SELECT SUM(pa.quantity) AS q FROM purchase_allocation pa WHERE pa.purchase_id = pu.id
  ) al ON true
  WHERE pu.status = 'active' AND pu.entry_kind <> 'opening_ap' AND pu.quantity - COALESCE(al.q, 0) > 0
), o AS (
  SELECT l.*,
         SUM(l.remain) OVER (PARTITION BY l.user_id, l.product_id ORDER BY l.purchase_date, l.purchase_id) - l.remain AS before_old,
         SUM(l.remain) OVER (PARTITION BY l.user_id, l.product_id) AS lot_total
  FROM lots l
)
SELECT o.user_id, o.product_id, o.purchase_id, o.purchase_date, o.unit_price, o.partner_id, o.source_name,
       o.remain,
       o.lot_total,
       COALESCE(i.quantity, 0) AS inventory_qty,
       GREATEST(0, o.lot_total - COALESCE(i.quantity, 0)) AS ghost_qty,
       GREATEST(0, LEAST(o.remain,
         o.before_old + o.remain - GREATEST(0, o.lot_total - COALESCE(i.quantity, 0)))) AS available
FROM o
LEFT JOIN inventory i ON i.user_id = o.user_id AND i.product_id = o.product_id;
