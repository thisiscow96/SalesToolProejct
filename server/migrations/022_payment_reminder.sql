-- 022 (2026-11-20, T-214): 미수 입금 안내 메일 (기능 제안 P19)
--  - account.email        : 판매처에 입금 안내를 보낼 이메일. NULL = 없음(기존 거래처 모두)
--  - payment_reminder     : 입금 안내 발송 이력 — 누가(user_id)·언제(created_at)·누구에게(partner_id, to_email)·금액(amount_due)·결과(result)
--      channel = email(메일 발송) | copy(메일 설정이 없거나 직접 보내려고 문구만 복사)
--      result  = sending(보내는 중) | sent(발송됨) | dry_run(가짜 발송, 테스트) | failed(실패) | copied(문구 복사)
--  - 같은 거래처 하루 1회: 한국 날짜(sent_on) 기준, 메일 발송이 성공했거나 보내는 중인 행은 하루 한 줄만(부분 유일 인덱스).
--    실패(failed)·복사(copied)는 제한에 세지 않는다(다시 보낼 수 있어야 하므로).
--  - 020·021 번호는 다른 작업용으로 비워 둔다
--
-- 다시 실행해도 안전: IF NOT EXISTS, 제약은 이름 확인 후 한 번만. 빈 표·NULL 열 추가라 기존 데이터 영향 없음.
-- 행은 지우지 않는다(이력). 본문(body)에는 화면에서 보낸 문구 그대로를 남긴다(비밀번호·토큰 없음).

ALTER TABLE account ADD COLUMN IF NOT EXISTS email VARCHAR(255);
COMMENT ON COLUMN account.email IS '입금 안내 메일 받는 주소(T-214). NULL=없음';

CREATE TABLE IF NOT EXISTS payment_reminder (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES "user"(id),
  partner_id   INTEGER NOT NULL REFERENCES account(id),
  sent_on      DATE NOT NULL,                       -- 한국 날짜(하루 1회 제한 기준)
  channel      VARCHAR(10) NOT NULL,                -- email | copy
  to_email     VARCHAR(255),                        -- copy 는 NULL 가능
  amount_due   NUMERIC(14, 2) NOT NULL,             -- 보낼 때의 미수 합계(서버 계산)
  oldest_days  INTEGER,                             -- 가장 오래된 미결제 매출 경과일
  subject      VARCHAR(200) NOT NULL,
  body         TEXT NOT NULL,
  bank_text    VARCHAR(300),                        -- 입금 계좌 안내(다음 안내 때 기본값으로 다시 씀)
  result       VARCHAR(10) NOT NULL,
  provider     VARCHAR(20),                         -- resend | brevo | smtp | dry_run
  error        VARCHAR(500),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
COMMENT ON TABLE payment_reminder IS '미수 입금 안내 발송 이력(T-214). 거래처 하루 1회(메일 성공·보내는 중), 추가·결과 갱신만';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_reminder_channel_chk' AND conrelid = 'payment_reminder'::regclass) THEN
    ALTER TABLE payment_reminder ADD CONSTRAINT payment_reminder_channel_chk CHECK (channel IN ('email', 'copy'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_reminder_result_chk' AND conrelid = 'payment_reminder'::regclass) THEN
    ALTER TABLE payment_reminder ADD CONSTRAINT payment_reminder_result_chk CHECK (result IN ('sending', 'sent', 'dry_run', 'failed', 'copied'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_reminder_amount_chk' AND conrelid = 'payment_reminder'::regclass) THEN
    ALTER TABLE payment_reminder ADD CONSTRAINT payment_reminder_amount_chk CHECK (amount_due >= 0);
  END IF;
END $$;

-- 하루 1회: 동시에 두 번 눌러도 한 건만 들어간다
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_reminder_daily
  ON payment_reminder (user_id, partner_id, sent_on)
  WHERE channel = 'email' AND result IN ('sending', 'sent', 'dry_run');
-- 원장 모달의 최근 이력
CREATE INDEX IF NOT EXISTS idx_payment_reminder_user_partner ON payment_reminder (user_id, partner_id, created_at DESC);
