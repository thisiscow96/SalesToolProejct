-- 016 (2026-11-20, T-216): 중매인 개인 품목 + 공용 등록 요청 (기능 제안 P21)
--  - product.owner_user_id : NULL = 공용 품목(모두에게 보임), 값 = 그 중매인만 보고 쓰는 개인 품목
--  - product_request       : 개인 품목을 공용으로 올려 달라는 요청 (대기 → 승인 | 반려)
--  승인은 같은 product 행의 owner_user_id 를 NULL 로 바꾸는 "승격"이라 기존 매입·매출·재고 연결(product_id)은 그대로 남는다.
--
-- 다시 실행해도 안전: IF NOT EXISTS, 제약은 이름으로 확인 후 한 번만 추가.
-- 적용 시간: 열 추가(기본값 없음 → 재작성 없음) + 빈 표·인덱스 생성. 기존 product 행은 모두 공용(NULL)으로 남는다.

ALTER TABLE product ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES "user"(id);
COMMENT ON COLUMN product.owner_user_id IS 'NULL=공용 품목, 값=그 중매인의 개인 품목(본인만 조회·사용). 승인 시 NULL 로 승격 (T-216)';

-- 개인 품목 목록 조회용 + 같은 중매인 안에서 개인 품목 이름 중복 금지(공백·대소문자 무시)
CREATE INDEX IF NOT EXISTS idx_product_owner ON product (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_personal_name
  ON product (owner_user_id, lower(btrim(name))) WHERE owner_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_request (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES product(id),
  user_id       INTEGER NOT NULL REFERENCES "user"(id),        -- 요청한 중매인
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  note          TEXT,                                          -- 요청 메모(중매인)
  reject_reason TEXT,                                          -- 반려 사유(관리자)
  reviewed_by   INTEGER REFERENCES "user"(id),
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE product_request IS '개인 품목 → 공용 품목 등록 요청 (T-216). 승인 = product.owner_user_id 를 NULL 로';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_request_status_chk' AND conrelid = 'product_request'::regclass) THEN
    ALTER TABLE product_request ADD CONSTRAINT product_request_status_chk CHECK (status IN ('pending', 'approved', 'rejected'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_request_reject_reason_chk' AND conrelid = 'product_request'::regclass) THEN
    ALTER TABLE product_request ADD CONSTRAINT product_request_reject_reason_chk
      CHECK (status <> 'rejected' OR (reject_reason IS NOT NULL AND btrim(reject_reason) <> ''));
  END IF;
END $$;

-- 한 품목에 대기 중인 요청은 하나만 (반려 후 다시 요청은 가능)
CREATE UNIQUE INDEX IF NOT EXISTS uq_product_request_pending ON product_request (product_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_product_request_status_created ON product_request (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_product_request_user ON product_request (user_id, created_at DESC);
