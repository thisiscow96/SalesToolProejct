-- 매입 출처(시장·출처명)와 매입 거래처(account) 분리
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS source_name VARCHAR(200);

COMMENT ON COLUMN purchase.source_name IS '출처(예: 한국청과·시장명). 매입 거래처(partner_id)와 별도';
