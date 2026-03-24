-- 상품키 자동 발번: P00001 형태
CREATE SEQUENCE IF NOT EXISTS product_key_seq START 1;

DO $$
DECLARE
  max_n INTEGER;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(product_key FROM '[0-9]+$') AS INTEGER)), 0)
    INTO max_n
  FROM product
  WHERE product_key ~ '^P[0-9]+$';

  PERFORM setval('product_key_seq', GREATEST(max_n, 1), max_n > 0);
END $$;

ALTER TABLE product
  ALTER COLUMN product_key SET DEFAULT ('P' || LPAD(nextval('product_key_seq')::text, 5, '0'));

UPDATE product
SET product_key = ('P' || LPAD(nextval('product_key_seq')::text, 5, '0'))
WHERE product_key IS NULL OR BTRIM(product_key) = '';
