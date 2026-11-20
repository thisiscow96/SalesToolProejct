-- 014 (2026-11-20, T-201): 매입처 지급(미지급금) · 지급 원장
-- 설계: AI 팀 산출물 T-201_지급_설계.md 4장(DB)
--
-- 원칙 (009·010·013과 같음)
--  * 기존 데이터는 지우지 않는다. 돈 기록(payment·sale)은 건드리지 않는다.
--  * 같은 파일을 다시 실행해도 오류가 나지 않는다(IF NOT EXISTS, 제약은 이름으로 확인, 뷰는 CREATE OR REPLACE).
--  * purchase 의 새 CHECK 는 NOT VALID 로 먼저 걸고, 기존 행이 맞으면 VALIDATE. 어기면 NOTICE 만 남기고 새 행부터 적용.
--
-- 계산 규칙
--   매입 1건의 미지급 = total_amount − paid_amount (취소 안 된 매입만)
--   매입처 지급 원장 잔액 = Σ매입(total, 취소 제외) − Σ지급(amount, 취소 제외)  (= 매입별 미지급 합, 설계 2.3)
--   paid_amount 는 취소 안 된 지급 배분 합을 API(지급 등록·취소)가 같은 트랜잭션에서 유지한다.
--
-- 적용 시간: purchase 에 열 2개 추가(DEFAULT 상수 → 테이블 재작성 없음, PG11+). 백필은 총액 0원 매입만.

CREATE OR REPLACE FUNCTION pg_temp.add_con_014(tbl text, con text, def text) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = con AND conrelid = tbl::regclass) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s NOT VALID', tbl, con, def);
  END IF;
  BEGIN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', tbl, con);
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE '[014] % . % : 기존 데이터가 제약을 어겨 VALIDATE 를 건너뜀 (새 행부터 적용). 아래 확인 SQL로 위반 행 확인 필요', tbl, con;
  END;
END $$ LANGUAGE plpgsql;

-- ======================================================================
-- 4.1 purchase 칸 — 지급액(유지 칸)·지급 상태
-- ======================================================================
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS payment_status payment_status NOT NULL DEFAULT 'unpaid';
COMMENT ON COLUMN purchase.paid_amount IS '취소 안 된 매입처 지급(supplier_payment) 배분 합. 지급 등록·취소 API가 유지 (T-201)';
COMMENT ON COLUMN purchase.payment_status IS 'unpaid: 지급 0 / partial: 0 < 지급 < 총액 / paid: 지급 = 총액(총액 0원 매입 포함) (T-201 RULE-06)';

-- 백필: 총액 0원(이하) 매입은 줄 돈이 없으므로 paid. 다시 실행하면 0행
UPDATE purchase SET payment_status = 'paid'::payment_status
WHERE total_amount <= 0 AND paid_amount = 0 AND payment_status <> 'paid'::payment_status;

SELECT pg_temp.add_con_014('purchase', 'purchase_paid_range', $c$CHECK (paid_amount >= 0 AND paid_amount <= GREATEST(total_amount, 0))$c$);

-- ======================================================================
-- 4.2 매입처 지급
-- ======================================================================
CREATE TABLE IF NOT EXISTS supplier_payment (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES "user"(id),
  partner_id    INTEGER NOT NULL,
  amount        NUMERIC(14, 2) NOT NULL,
  paid_at       TIMESTAMPTZ NOT NULL,
  kind          VARCHAR(10) NOT NULL DEFAULT 'pay',
  method        VARCHAR(10),
  memo          TEXT,
  status        VARCHAR(10) NOT NULL DEFAULT 'active',
  cancelled_at  TIMESTAMPTZ,
  cancel_reason VARCHAR(200),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supplier_payment_amount_pos   CHECK (amount > 0),
  CONSTRAINT supplier_payment_kind_valid   CHECK (kind IN ('pay', 'opening')),
  CONSTRAINT supplier_payment_method_valid CHECK (method IS NULL OR method IN ('cash', 'transfer', 'bill', 'other')),
  CONSTRAINT supplier_payment_status_valid CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT supplier_payment_cancel_match CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT fk_sp_partner_same_user FOREIGN KEY (partner_id, user_id) REFERENCES account (id, user_id)
);
COMMENT ON TABLE supplier_payment IS '매입처에 준 돈(T-201). kind=pay 지급 / opening 기초 정리(014 이전 매입 정리). 취소는 status=cancelled(행은 지우지 않음)';
CREATE UNIQUE INDEX IF NOT EXISTS ux_supplier_payment_id_user ON supplier_payment (id, user_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payment_user_paid_at ON supplier_payment (user_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_supplier_payment_partner ON supplier_payment (user_id, partner_id);

-- ======================================================================
-- 4.3 지급 배분 (지급 1건 → 매입 N건)
-- ======================================================================
CREATE TABLE IF NOT EXISTS supplier_payment_allocation (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES "user"(id),
  supplier_payment_id INTEGER NOT NULL,
  purchase_id         INTEGER NOT NULL,
  amount              NUMERIC(14, 2) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT supplier_payment_allocation_amount_pos CHECK (amount > 0),
  CONSTRAINT fk_spa_payment_same_user  FOREIGN KEY (supplier_payment_id, user_id) REFERENCES supplier_payment (id, user_id) ON DELETE RESTRICT,
  CONSTRAINT fk_spa_purchase_same_user FOREIGN KEY (purchase_id, user_id) REFERENCES purchase (id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ux_spa_payment_purchase UNIQUE (supplier_payment_id, purchase_id)
);
CREATE INDEX IF NOT EXISTS idx_spa_purchase ON supplier_payment_allocation (purchase_id);

-- 미지급 매입 찾기(지급 대상·연령·대시보드) — 취소 안 된 미지급·일부 매입만
CREATE INDEX IF NOT EXISTS idx_purchase_user_unpaid ON purchase (user_id, partner_id, purchase_date)
  WHERE payment_status IN ('unpaid', 'partial') AND status = 'active';

-- ======================================================================
-- 4.4 뷰 — 지급 원장(partner_ledger_entry 대칭) · 매입처별 미지급
--   뷰에는 user_id 조건이 없다 → 읽을 때 꼭 WHERE user_id = ? AND partner_id = ?
-- ======================================================================
CREATE OR REPLACE VIEW supplier_ledger_entry AS
-- 1 매입 (+) — 취소 매입 제외
SELECT pu.user_id,
       pu.partner_id,
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
-- 2 지급 (−) — 기초 정리 포함, 취소 지급 제외. 날짜는 한국 날짜
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
LEFT JOIN purchase pu ON pu.partner_id = a.id AND pu.user_id = a.user_id
  AND pu.status = 'active' AND pu.payment_status IN ('unpaid', 'partial')
WHERE a.type IN ('supplier', 'wholesaler', 'market_wholesaler', 'same_market')
GROUP BY a.user_id, a.id, a.name;

-- ======================================================================
-- 확인 SQL (사용자·I가 직접 — 이 파일은 실행하지 않음). 모두 0행이어야 한다 (설계 4.5, AC-28)
-- ① 유지 칸 = 배분 합:
--      SELECT pu.id, pu.paid_amount, COALESCE(x.s, 0) AS alloc_sum FROM purchase pu
--      LEFT JOIN (SELECT spa.purchase_id, SUM(spa.amount) s FROM supplier_payment_allocation spa
--                 JOIN supplier_payment sp ON sp.id = spa.supplier_payment_id AND sp.status = 'active'
--                 GROUP BY spa.purchase_id) x ON x.purchase_id = pu.id
--      WHERE pu.paid_amount <> COALESCE(x.s, 0);
-- ② 지급액 = 배분 합:
--      SELECT sp.id FROM supplier_payment sp LEFT JOIN supplier_payment_allocation spa ON spa.supplier_payment_id = sp.id
--      GROUP BY sp.id, sp.amount HAVING sp.amount <> COALESCE(SUM(spa.amount), 0);
-- ③ 취소된 매입에 걸린 활성 지급 배분:
--      SELECT spa.* FROM supplier_payment_allocation spa
--      JOIN supplier_payment sp ON sp.id = spa.supplier_payment_id AND sp.status = 'active'
--      JOIN purchase pu ON pu.id = spa.purchase_id AND pu.status = 'cancelled';
-- ④ purchase_paid_range 를 VALIDATE 하지 못했다는 NOTICE 가 나왔다면 위반 행:
--      SELECT id, total_amount, paid_amount FROM purchase WHERE NOT (paid_amount >= 0 AND paid_amount <= GREATEST(total_amount, 0));
-- ======================================================================
