-- 로컬용 샘플 관리자 계정 (비밀번호: sample)
-- pgAdmin에서 sales_tool DB 선택 후 Query Tool로 이 파일 실행.
-- user 테이블에 agent_no, is_admin 컬럼이 있어야 함. 없으면 먼저 schema-full.sql 또는 npm run migrate 실행.

INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
VALUES (
  'Sample Admin',
  '01000000000',
  'admin@sample.local',
  'admin001',
  '$2b$10$3wz61bRejBi1rQAxCrBOdeKZf5Im6jrJ6oIiz0jVVkEglN0iuJ7BO',
  NOW(),
  'active',
  true
)
ON CONFLICT (agent_no) DO UPDATE SET
  name = EXCLUDED.name,
  password_hash = EXCLUDED.password_hash,
  is_admin = true,
  updated_at = NOW();

-- terms_agreement는 새 사용자인 경우에만 넣기 (기존 사용자면 무시)
INSERT INTO terms_agreement (user_id, terms_type, agreed_at)
SELECT id, 'privacy', NOW()
  FROM "user"
 WHERE agent_no = 'admin001'
   AND NOT EXISTS (SELECT 1 FROM terms_agreement WHERE user_id = "user".id AND terms_type = 'privacy');
