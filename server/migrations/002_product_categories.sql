-- 상품 마스터: 대분류/중분류/소분류/상품키 컬럼 추가
ALTER TABLE product ADD COLUMN IF NOT EXISTS category_large VARCHAR(100);
ALTER TABLE product ADD COLUMN IF NOT EXISTS category_mid VARCHAR(100);
ALTER TABLE product ADD COLUMN IF NOT EXISTS category_small VARCHAR(100);
ALTER TABLE product ADD COLUMN IF NOT EXISTS product_key VARCHAR(100);

COMMENT ON COLUMN product.category_large IS '대분류';
COMMENT ON COLUMN product.category_mid IS '중분류';
COMMENT ON COLUMN product.category_small IS '소분류';
COMMENT ON COLUMN product.product_key IS '상품 키';
