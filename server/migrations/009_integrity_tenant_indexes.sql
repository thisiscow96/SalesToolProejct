-- 009 (2026-11-20, DB 점검): 무결성 CHECK · 회원 간 교차 참조 차단 · 이메일 대소문자 중복 차단 · 조회 인덱스 정리
-- 점검 보고서: AI 팀 산출물 db_점검.md (D-02, D-07, D-08, D-09, 인덱스 I-01)
--
-- 원칙
--  * 기존 데이터는 지우거나 고치지 않는다. 제약은 NOT VALID 로 먼저 걸어 "새로 쓰는 행"부터 막고,
--    기존 행이 모두 맞으면 VALIDATE 까지 한다. 기존 행이 어기면 VALIDATE 를 건너뛰고 NOTICE 로 알린다
--    (운영 DB에서 위반 행을 확인·정리한 뒤 `ALTER TABLE ... VALIDATE CONSTRAINT ...` 를 따로 실행).
--  * 같은 파일을 다시 실행해도 오류가 나지 않게 이름이 있으면 건너뛴다.

-- 제약을 NOT VALID 로 추가하고, 가능하면 VALIDATE 하는 도우미 (이 마이그레이션 안에서만 쓰고 지운다)
CREATE OR REPLACE FUNCTION pg_temp.add_con(tbl text, con text, def text) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = con AND conrelid = tbl::regclass) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s NOT VALID', tbl, con, def);
  END IF;
  BEGIN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', tbl, con);
  EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    RAISE NOTICE '[009] % . % : 기존 데이터가 제약을 어겨 VALIDATE 를 건너뜀 (새 행부터 적용). 위반 행 확인 후 VALIDATE 필요', tbl, con;
  END;
END $$ LANGUAGE plpgsql;

-- ---------- D-08 금액·상태 CHECK ----------
SELECT pg_temp.add_con('purchase', 'purchase_unit_price_nonneg', 'CHECK (unit_price >= 0)');
SELECT pg_temp.add_con('purchase', 'purchase_total_amount_nonneg', 'CHECK (total_amount >= 0)');
SELECT pg_temp.add_con('sale', 'sale_unit_price_nonneg', 'CHECK (unit_price >= 0)');
SELECT pg_temp.add_con('sale', 'sale_total_amount_nonneg', 'CHECK (total_amount >= 0)');
SELECT pg_temp.add_con('sale', 'sale_status_valid', $c$CHECK (status IN ('active', 'refunded', 'cancelled'))$c$);
-- D-02 과수금: 한 매출에 배분된 수금이 매출액을 넘지 않게 (화면도 같은 규칙으로 막고 있음)
SELECT pg_temp.add_con('sale', 'sale_paid_not_over_total', 'CHECK (paid_amount <= total_amount)');
SELECT pg_temp.add_con('payment', 'payment_entry_kind_valid', $c$CHECK (entry_kind IN ('receive', 'refund'))$c$);
SELECT pg_temp.add_con('product_daily_price', 'pdp_prices_nonneg',
  'CHECK ((purchase_price IS NULL OR purchase_price >= 0) AND (sale_price IS NULL OR sale_price >= 0))');

-- ---------- D-07 회원(중매인) 간 교차 참조 차단: (id, user_id) 복합 FK ----------
-- 코드가 거래처·매입·매출을 user_id 로 확인하고 있지만, DB 차원에서도 다른 회원의 행을 가리키지 못하게 한다.
CREATE UNIQUE INDEX IF NOT EXISTS ux_account_id_user ON account (id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_id_user ON purchase (id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sale_id_user ON sale (id, user_id);

SELECT pg_temp.add_con('purchase', 'fk_purchase_partner_same_user',
  'FOREIGN KEY (partner_id, user_id) REFERENCES account (id, user_id)');
SELECT pg_temp.add_con('sale', 'fk_sale_partner_same_user',
  'FOREIGN KEY (partner_id, user_id) REFERENCES account (id, user_id)');
SELECT pg_temp.add_con('payment', 'fk_payment_partner_same_user',
  'FOREIGN KEY (partner_id, user_id) REFERENCES account (id, user_id)');
SELECT pg_temp.add_con('purchase_allocation', 'fk_pa_purchase_same_user',
  'FOREIGN KEY (purchase_id, user_id) REFERENCES purchase (id, user_id)');
SELECT pg_temp.add_con('purchase_allocation', 'fk_pa_sale_same_user',
  'FOREIGN KEY (sale_id, user_id) REFERENCES sale (id, user_id)');
SELECT pg_temp.add_con('refund', 'fk_refund_sale_same_user',
  'FOREIGN KEY (sale_id, user_id) REFERENCES sale (id, user_id)');

-- ---------- D-09 이메일 대소문자만 다른 중복 가입 차단 ----------
-- 기존에 대소문자만 다른 중복이 있으면 회원 데이터를 임의로 고치지 않고 인덱스를 만들지 않는다(NOTICE).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'ux_user_email_lower') THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT LOWER(email) FROM "user" GROUP BY LOWER(email) HAVING COUNT(*) > 1) THEN
    RAISE NOTICE '[009] 대소문자만 다른 이메일 중복 회원이 있어 ux_user_email_lower 를 만들지 않음. 확인 SQL: SELECT LOWER(email), COUNT(*) FROM "user" GROUP BY 1 HAVING COUNT(*) > 1';
  ELSE
    CREATE UNIQUE INDEX ux_user_email_lower ON "user" (LOWER(email));
  END IF;
END $$;

-- ---------- I-01 조회 인덱스: 모든 목록·보고서 조회가 "user_id + 날짜 범위" ----------
CREATE INDEX IF NOT EXISTS idx_purchase_user_date ON purchase (user_id, purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchase_user_product_date ON purchase (user_id, product_id, purchase_date DESC); -- 재고현황 "마지막 매입"
CREATE INDEX IF NOT EXISTS idx_sale_user_date ON sale (user_id, sale_date);
CREATE INDEX IF NOT EXISTS idx_payment_user_paid_at ON payment (user_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_disposal_user_date ON disposal (user_id, disposal_date);
CREATE INDEX IF NOT EXISTS idx_payment_partner ON payment (partner_id);

-- user_id 단독 인덱스는 위 복합 인덱스(user_id 가 맨 앞)가 대신하므로 지워 저장 공간(Neon 무료 0.5~1GB)을 아낀다.
DROP INDEX IF EXISTS idx_purchase_user;
DROP INDEX IF EXISTS idx_sale_user;
DROP INDEX IF EXISTS idx_payment_user;
DROP INDEX IF EXISTS idx_disposal_user;
-- sale.payment_status 단독 인덱스: 값 3종뿐이라 선택도가 낮고 조회는 항상 user_id 와 함께 → 미수 조회용 부분 인덱스로 교체
DROP INDEX IF EXISTS idx_sale_payment_status;
CREATE INDEX IF NOT EXISTS idx_sale_user_unpaid ON sale (user_id, partner_id) WHERE payment_status IN ('unpaid', 'partial');
