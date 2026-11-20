-- 015: 재고 기준 판매(선입선출 자동 배분) — T-205
-- 1) 뷰 inventory_lot_available: 매입 로트별 "판매 가능 수량"
--    유효 로트 = 같은 회원·상품의 active 매입 중 잔량(매입 수량 − 배분 합) > 0.
--    로트 합(T)이 재고(I)보다 크면 차이(유령 수량 G = T − I, 폐기 등으로 이미 사라진 수량)를
--    가장 오래된 로트부터 뺀다. 재고현황 경과일(T-209)과 같은 가정이라 판매 뒤 경과일이 맞는다.
-- 2) sale.entry_mode: 매출을 만든 방법(convert = 매입 지정 전환, fifo = 재고 기준 판매). 계산에는 쓰지 않는다.
-- 다시 실행해도 오류 없이 같은 결과(CREATE OR REPLACE · IF NOT EXISTS · 제약 존재 확인).

CREATE OR REPLACE VIEW inventory_lot_available AS
WITH lots AS (
  SELECT pu.user_id, pu.product_id, pu.id AS purchase_id, pu.purchase_date, pu.unit_price,
         pu.partner_id, pu.source_name,
         pu.quantity - COALESCE(al.q, 0) AS remain
  FROM purchase pu
  LEFT JOIN LATERAL (
    SELECT SUM(pa.quantity) AS q FROM purchase_allocation pa WHERE pa.purchase_id = pu.id
  ) al ON true
  WHERE pu.status = 'active' AND pu.quantity - COALESCE(al.q, 0) > 0
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

COMMENT ON VIEW inventory_lot_available IS
  'T-205 FIFO 유효 로트: 매입 잔량 − (로트 합 − 재고)를 오래된 로트부터 뺀 판매 가능 수량(available). 재고현황 경과일(T-209)과 같은 가정';

ALTER TABLE sale ADD COLUMN IF NOT EXISTS entry_mode VARCHAR(10) NOT NULL DEFAULT 'convert';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sale_entry_mode_valid') THEN
    ALTER TABLE sale ADD CONSTRAINT sale_entry_mode_valid CHECK (entry_mode IN ('convert', 'fifo'));
  END IF;
END $$;

COMMENT ON COLUMN sale.entry_mode IS 'T-205 매출을 만든 방법: convert(매입 지정 전환) / fifo(재고 기준 판매, 오래된 매입부터 자동 배분)';
