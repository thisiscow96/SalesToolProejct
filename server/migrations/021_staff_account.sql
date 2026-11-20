-- 021 (2026-11-20, T-213): 직원 계정·권한(입력 전용 / 조회 전용) — 기능 제안 P18
--
-- 설계: 작업 폴더 산출물/T-213_직원계정_설계.md 4장.
--  - 직원은 "user" 표가 아니라 새 표 staff_account 에 둔다. 데이터 주인은 언제나 owner_user_id(주인).
--  - 매입·매출·수금 행에 created_by_staff_id(직원이 넣었을 때만), audit_log 에 actor_staff_id(직원 로그인·비밀번호 설정).
--  - 복합 FK (staff_id, user_id) → staff_account(id, owner_user_id): 다른 주인의 직원 id 는 DB 가 받지 않는다.
--  - 019 audit_log CHECK 를 넓힌다(entity_type 'staff', 직원 관리 동작).
--
-- 번호: 022(T-214)가 먼저 적용된 DB 에 나중에 적용해도 된다. migrate.js 는 적용 이력을 파일 이름으로 보고,
--       이 파일은 022 의 표·열을 쓰지 않는다.
-- 다시 실행해도 안전: IF NOT EXISTS / 제약은 이름 확인 후 한 번만 / CHECK 는 DROP IF EXISTS → ADD.
-- 기존 행은 새 칸이 모두 NULL(= 주인이 넣음) — 백필 없음, 기본값 없는 NULL 칸 추가라 표 다시 쓰기 없음.
-- migrate.js 가 파일마다 BEGIN/COMMIT 으로 감싸므로 여기서 트랜잭션을 따로 열지 않는다.

CREATE TABLE IF NOT EXISTS staff_account (
  id                     SERIAL PRIMARY KEY,
  owner_user_id          INTEGER NOT NULL REFERENCES "user"(id),
  login_id               VARCHAR(30)  NOT NULL,                  -- 직원 ID (주인 안에서 유일, 소문자로 저장)
  name                   VARCHAR(50)  NOT NULL,                  -- 화면·이력에 보일 이름
  role                   VARCHAR(10)  NOT NULL,                  -- input | view
  email                  VARCHAR(255),                           -- 초대 메일용(선택). 삭제 시 NULL
  password_hash          VARCHAR(255),                           -- NULL = 초대 중(비밀번호 없음) 또는 삭제
  must_change_password   BOOLEAN      NOT NULL DEFAULT false,
  status                 VARCHAR(10)  NOT NULL DEFAULT 'invited',-- invited | active | suspended | deleted
  invite_code_hash       VARCHAR(255),                           -- 초대 코드 bcrypt 해시(평문 저장 안 함)
  invite_expires_at      TIMESTAMPTZ,
  invite_fail_count      SMALLINT     NOT NULL DEFAULT 0,
  credentials_changed_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),    -- 토큰의 cv 와 다르면 그 토큰은 무효
  last_login_at          TIMESTAMPTZ,
  suspended_at           TIMESTAMPTZ,
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE staff_account IS '중매인(주인) 아래 직원 계정(T-213). 데이터 주인은 owner_user_id. 삭제는 status=deleted(행 유지, 비밀값 지움)';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_role_valid' AND conrelid = 'staff_account'::regclass) THEN
    ALTER TABLE staff_account ADD CONSTRAINT staff_role_valid CHECK (role IN ('input', 'view'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_status_valid' AND conrelid = 'staff_account'::regclass) THEN
    ALTER TABLE staff_account ADD CONSTRAINT staff_status_valid CHECK (status IN ('invited', 'active', 'suspended', 'deleted'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_login_id_format' AND conrelid = 'staff_account'::regclass) THEN
    ALTER TABLE staff_account ADD CONSTRAINT staff_login_id_format CHECK (login_id ~ '^[a-z0-9_.]{3,30}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_active_has_pw' AND conrelid = 'staff_account'::regclass) THEN
    ALTER TABLE staff_account ADD CONSTRAINT staff_active_has_pw CHECK (status NOT IN ('active', 'suspended') OR password_hash IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_deleted_match' AND conrelid = 'staff_account'::regclass) THEN
    ALTER TABLE staff_account ADD CONSTRAINT staff_deleted_match CHECK ((status = 'deleted') = (deleted_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_deleted_no_secret' AND conrelid = 'staff_account'::regclass) THEN
    ALTER TABLE staff_account ADD CONSTRAINT staff_deleted_no_secret
      CHECK (status <> 'deleted' OR (password_hash IS NULL AND email IS NULL AND invite_code_hash IS NULL));
  END IF;
END $$;

-- 같은 주인 안에서 직원 ID 유일 (삭제된 것은 빼서 같은 ID 를 다시 쓸 수 있게)
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_owner_login ON staff_account (owner_user_id, login_id) WHERE status <> 'deleted';
-- 업무 표가 "같은 주인의 직원"만 가리키게 하는 복합 FK 대상
CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_id_owner ON staff_account (id, owner_user_id);
CREATE INDEX IF NOT EXISTS idx_staff_owner ON staff_account (owner_user_id, status);

-- 행위자 칸
ALTER TABLE purchase  ADD COLUMN IF NOT EXISTS created_by_staff_id INTEGER;
ALTER TABLE sale      ADD COLUMN IF NOT EXISTS created_by_staff_id INTEGER;
ALTER TABLE payment   ADD COLUMN IF NOT EXISTS created_by_staff_id INTEGER;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_staff_id INTEGER;

-- 복합 FK: NULL(주인이 넣음)은 검사하지 않는다(MATCH SIMPLE). 직원 행은 지우지 않으므로 ON DELETE 없음
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_staff_same_owner') THEN
    ALTER TABLE purchase ADD CONSTRAINT fk_purchase_staff_same_owner
      FOREIGN KEY (created_by_staff_id, user_id) REFERENCES staff_account (id, owner_user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_sale_staff_same_owner') THEN
    ALTER TABLE sale ADD CONSTRAINT fk_sale_staff_same_owner
      FOREIGN KEY (created_by_staff_id, user_id) REFERENCES staff_account (id, owner_user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_payment_staff_same_owner') THEN
    ALTER TABLE payment ADD CONSTRAINT fk_payment_staff_same_owner
      FOREIGN KEY (created_by_staff_id, user_id) REFERENCES staff_account (id, owner_user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_audit_log_actor_same_owner') THEN
    ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_actor_same_owner
      FOREIGN KEY (actor_staff_id, user_id) REFERENCES staff_account (id, owner_user_id);
  END IF;
END $$;

-- "직원이 넣은 것" 필터·이력 갈래용 (직원 입력 행만 담는 부분 인덱스)
CREATE INDEX IF NOT EXISTS idx_purchase_staff ON purchase (user_id, created_by_staff_id, created_at DESC) WHERE created_by_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sale_staff     ON sale     (user_id, created_by_staff_id, created_at DESC) WHERE created_by_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payment_staff  ON payment  (user_id, created_by_staff_id, created_at DESC) WHERE created_by_staff_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (user_id, actor_staff_id, created_at DESC) WHERE actor_staff_id IS NOT NULL;

-- 019 audit_log CHECK 확장 (기존 행은 모두 새 CHECK 안에 있다)
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_type_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN ('account', 'auth', 'staff'));
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_chk CHECK (action IN (
  'create', 'update', 'login',
  'suspend', 'resume', 'delete', 'password_reset', 'password_set', 'invite'
));

-- 확인 SQL (I 검토용, 모두 0행이어야 함)
-- ① 직원 행위자가 다른 주인의 직원인 행 (복합 FK 로 원천 차단)
--   SELECT 'purchase' t, p.id FROM purchase p JOIN staff_account s ON s.id = p.created_by_staff_id WHERE s.owner_user_id <> p.user_id
--   UNION ALL SELECT 'sale', x.id FROM sale x JOIN staff_account s ON s.id = x.created_by_staff_id WHERE s.owner_user_id <> x.user_id
--   UNION ALL SELECT 'payment', y.id FROM payment y JOIN staff_account s ON s.id = y.created_by_staff_id WHERE s.owner_user_id <> y.user_id;
-- ② 직원이 넣을 수 없는 수금 종류(환불)가 직원 이름으로 남은 행
--   SELECT id FROM payment WHERE created_by_staff_id IS NOT NULL AND entry_kind <> 'receive';
-- ③ 삭제된 직원에 비밀값이 남은 행
--   SELECT id FROM staff_account WHERE status = 'deleted' AND (password_hash IS NOT NULL OR email IS NOT NULL OR invite_code_hash IS NOT NULL);
