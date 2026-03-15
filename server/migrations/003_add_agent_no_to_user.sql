-- user 테이블에 agent_no가 없을 때만 추가 (예: 예전 스키마로 만든 DB)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'agent_no'
  ) THEN
    ALTER TABLE "user" ADD COLUMN agent_no VARCHAR(50);
    UPDATE "user" SET agent_no = 'GK' || LPAD(id::text, 6, '0') WHERE agent_no IS NULL;
    ALTER TABLE "user" ALTER COLUMN agent_no SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS user_agent_no_key ON "user"(agent_no);
  END IF;
END $$;
