-- 024 (2026-11-21, T-402): 엑셀 업로드 기록 — 같은 파일 두 번 저장 방지 + 업로드 한 건의 건별 결과
--
-- excel_upload: 저장에 성공한 업로드만 한 줄(미리보기·실패는 남기지 않음 — 전부 아니면 전무라 저장된 것이 없음)
--   file_hash  올린 파일 바이트의 SHA-256. (user_id, file_hash) 유일 → 같은 파일 두 번째 저장은 409
--   result     줄별 결과 [{line, id, summary}] — 각 원천 행(매입·매출·수금 …)과 이어 보는 건별 기록
-- audit_log(019·021): "엑셀 업로드 N건" 한 줄을 남기도록 entity_type 'upload' · action 'upload' 추가
--
-- 다시 실행해도 안전: IF NOT EXISTS, 제약은 지우고 같은 정의로 다시 건다(021 과 같은 방식). 기존 행 영향 없음(값 목록을 넓히기만 함).

CREATE TABLE IF NOT EXISTS excel_upload (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES "user"(id),
  kind                VARCHAR(30) NOT NULL,
  file_hash           CHAR(64) NOT NULL,
  file_name           VARCHAR(200),
  row_count           INTEGER NOT NULL CHECK (row_count >= 0),
  amount_total        NUMERIC(16,2),
  result              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by_staff_id INTEGER REFERENCES staff_account(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE excel_upload IS '엑셀 업로드 저장 기록(T-402). 같은 파일(해시) 두 번 저장 방지 · 줄별 결과';
CREATE UNIQUE INDEX IF NOT EXISTS uq_excel_upload_user_hash ON excel_upload (user_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_excel_upload_user_created ON excel_upload (user_id, created_at DESC);

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_type_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN ('account', 'auth', 'staff', 'upload'));
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_chk CHECK (action IN (
  'create', 'update', 'login',
  'suspend', 'resume', 'delete', 'password_reset', 'password_set', 'invite',
  'upload'
));
