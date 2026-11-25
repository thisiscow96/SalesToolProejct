-- 033 T-203: 경매 직후 수집 — 정산일 하루 상태(완료 감지) + 일정(창 10분 폴링·01:00 고정 배치·02:00 창 종료·06:00 확인)
-- 근거: 산출물/A_경매직후수집_설계.md 2절(하루 상태·수치)·2.3(기존 슬롯과의 관계)·3절(01:00)·7절(033), 실측 1일(정산일 2026-11-24 낙찰 21:25~01:21)
--
-- 무엇을
--  ① collect_day_state — 정산일 D × 소스 × 시장 × 법인 범위마다 1행. WAITING → LIVE → SETTLED → CONFIRMED (+ NO_TRADE · HOLIDAY)
--     폴링 결과 저장 트랜잭션 안에서 서버(worker.updateDayState)가 갱신한다. 판정 시계 = last_change_at(호출 단위 totalCount 또는 max(mdfcn_dt)가 바뀐 마지막 시각)
--  ② collect_schedule job_type 에 COLLECT_NIGHTLY(01:00 고정 배치)·COLLECT_WINDOW_END(02:00 창 종료) 추가, 새 행 2개
--  ③ 기본 행 cron 변경 — INTRADAY 매시 → 창 안 10분(21~23시·0~1시), FINAL 11·16시 → 06·11시.
--     관리자가 화면에서 바꾼 행(updated_by_user_id 있음)은 건드리지 않는다.
-- 재실행 안전: IF NOT EXISTS / ON CONFLICT DO NOTHING / pg_get_constraintdef 확인 / UPDATE 는 같은 값으로 다시 써도 결과 같음. 기존 행 값 중 바뀌는 것은 ③의 기본 행 cron·note 뿐.

-- ① 정산일 하루 상태
CREATE TABLE IF NOT EXISTS collect_day_state (
  id              BIGSERIAL    PRIMARY KEY,
  source          VARCHAR(20)  NOT NULL,
  market_code     VARCHAR(10)  NOT NULL,
  trade_date      DATE         NOT NULL,
  corp_scope      VARCHAR(200) NOT NULL DEFAULT '',   -- '' = 전체 법인, 아니면 AUCTION_CORP_CODES 정렬 값(예 '11000105')
  state           VARCHAR(12)  NOT NULL,
  first_row_at    TIMESTAMPTZ,                        -- 처음 비어 있지 않은 응답을 받은 시각(LIVE 시작)
  last_change_at  TIMESTAMPTZ,                        -- 판정 시계: 호출 단위 건수·max(mdfcn_dt)가 마지막으로 바뀐 시각
  last_totals     JSONB,                              -- {"11000105 12-05": 186, ...} 호출 단위별 totalCount
  last_max_mdfcn  TIMESTAMPTZ,                        -- 받은 행의 원천 수정일시 최댓값
  last_rows       INTEGER,
  last_polled_at  TIMESTAMPTZ,                        -- 마지막 성공 수집(폴링·배치·수동) 시각 — 실패한 수집은 바꾸지 않음
  last_job_id     BIGINT,
  polls           INTEGER      NOT NULL DEFAULT 0,
  settled_at      TIMESTAMPTZ,
  settle_reason   VARCHAR(20),                        -- NO_CHANGE(무변화 판정) · WINDOW_END(02:00 창 종료)
  confirmed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT collect_day_state_state_chk  CHECK (state IN ('WAITING', 'LIVE', 'SETTLED', 'CONFIRMED', 'NO_TRADE', 'HOLIDAY')),
  CONSTRAINT collect_day_state_reason_chk CHECK (settle_reason IS NULL OR settle_reason IN ('NO_CHANGE', 'WINDOW_END')),
  CONSTRAINT collect_day_state_settled_chk CHECK (state NOT IN ('SETTLED', 'CONFIRMED') OR settled_at IS NOT NULL OR confirmed_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_collect_day_state ON collect_day_state (source, market_code, trade_date, corp_scope);
COMMENT ON TABLE collect_day_state IS 'T-203 033 정산일 하루 수집 상태(경매 진행 중·완료 판정·확정). 창 D-1 21:00~D 02:00 10분 폴링, 40분 무변화 → SETTLED + FINAL, D 06:00 확인 FINAL → CONFIRMED';

-- ② 일정 종류 확장
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collect_schedule_type_chk' AND pg_get_constraintdef(oid) LIKE '%COLLECT_NIGHTLY%') THEN
    ALTER TABLE collect_schedule DROP CONSTRAINT IF EXISTS collect_schedule_type_chk;
    ALTER TABLE collect_schedule ADD CONSTRAINT collect_schedule_type_chk
      CHECK (job_type IN ('COLLECT_INTRADAY', 'COLLECT_FINAL', 'COLLECT_NIGHTLY', 'COLLECT_WINDOW_END', 'SETTLE_VERIFY', 'CODE_SYNC', 'PURGE_RAW'));
  END IF;
END $$;

INSERT INTO collect_schedule (job_type, source, cron_text, note) VALUES
  ('COLLECT_NIGHTLY',    'AT_REALTIME', '0 1 * * *', '01:00 고정 배치(사용자 지정) — 진행 중이면 INTRADAY, 완료 판정 뒤면 FINAL 로 1회'),
  ('COLLECT_WINDOW_END', 'AT_REALTIME', '0 2 * * *', '02:00 창 종료 — 아직 진행 중이면 완료(WINDOW_END)+FINAL, 계속 빈 응답이면 거래 없음(호출 0)')
ON CONFLICT (job_type, source) DO NOTHING;

-- ③ 기본 행 cron (사용자가 바꾼 행 제외)
UPDATE collect_schedule SET cron_text = '*/10 21-23,0-1 * * *',
       note = '경매 창(D-1 21:00~D 02:00) 10분 폴링 — 정산일 = settleDateOf(21시 경계), 완료 판정 뒤 멈춤', updated_at = NOW()
 WHERE job_type = 'COLLECT_INTRADAY' AND source = 'AT_REALTIME' AND updated_by_user_id IS NULL AND cron_text IS DISTINCT FROM '*/10 21-23,0-1 * * *';
UPDATE collect_schedule SET cron_text = '0 6,11 * * *',
       note = '06:00 확인 수집(FINAL, COMPLETE 면 CONFIRMED), 11:00 은 06:00 실패 때 재시도', updated_at = NOW()
 WHERE job_type = 'COLLECT_FINAL' AND source = 'AT_REALTIME' AND updated_by_user_id IS NULL AND cron_text IS DISTINCT FROM '0 6,11 * * *';
