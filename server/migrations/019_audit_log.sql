-- 019 (2026-11-20, T-212): 변경 이력(감사 로그) — 기존 기록이 없는 변경만 담는 공통 표 (기능 제안 P17)
--
-- 이미 있는 기록은 그대로 재사용하고 여기에 다시 쓰지 않는다(이중 기록 금지).
--   매입·매출 수정·취소  → trade_correction (010, T-103)
--   매입처 지급 취소     → supplier_payment.status/cancelled_at/cancel_reason (014, T-201)
--   품목 공용 요청·승인·반려 → product_request (016, T-216)
-- 이 표에 새로 남기는 것: 거래처 등록·수정(전·후 값), 로그인 성공.
-- 조회는 GET /api/history 가 위 기록을 합쳐(UNION) 한 화면으로 보여 준다(server/lib/audit-log.js).
--
-- 다시 실행해도 안전: IF NOT EXISTS / 제약은 이름 확인 후 한 번만. 빈 표 생성이라 기존 데이터 영향 없음.
-- 행은 지우거나 고치지 않는다(추가만). 비밀번호·토큰은 넣지 않는다.

CREATE TABLE IF NOT EXISTS audit_log (
  id             BIGSERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES "user"(id),   -- 이 기록의 주인(바꾼 중매인). 조회는 항상 본인 것만
  entity_type    VARCHAR(30) NOT NULL,                      -- account(거래처) | auth(로그인)
  entity_id      INTEGER,                                   -- 바뀐 행 id (로그인은 NULL)
  action         VARCHAR(20) NOT NULL,                      -- create | update | login
  partner_id     INTEGER,                                   -- 거래처 필터용 (거래처 기록이면 entity_id 와 같음)
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  before_data    JSONB,
  after_data     JSONB,
  note           VARCHAR(200),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE audit_log IS '변경 이력(T-212). 다른 표에 기록이 없는 변경(거래처 등록·수정, 로그인)만. 추가만 하고 지우지 않는다';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_entity_type_chk' AND conrelid = 'audit_log'::regclass) THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN ('account', 'auth'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_action_chk' AND conrelid = 'audit_log'::regclass) THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_chk CHECK (action IN ('create', 'update', 'login'));
  END IF;
END $$;

-- 화면 조회: 본인 + 기간(최근순), 본인 + 거래처
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_partner ON audit_log (user_id, partner_id, created_at DESC) WHERE partner_id IS NOT NULL;
-- 지급 취소 이력 조회(취소된 행만)
CREATE INDEX IF NOT EXISTS idx_supplier_payment_user_cancelled ON supplier_payment (user_id, cancelled_at DESC) WHERE status = 'cancelled';
