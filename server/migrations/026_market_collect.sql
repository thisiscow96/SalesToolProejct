-- 026 (2026-11-24, T-203): 경락 데이터 수집 — 표준코드 · 내부 품목·매핑 · 등급·포장 규칙 · 휴장일 · 작업 큐 · 서킷 상태
--                           · 원천 응답 로그 · 수집 스냅샷 · 정규화 경락 · 품목별 가격(보조)
-- 설계: AI 팀 산출물 A_설계서.md 2장 (D_수집아키텍처.md 0·3·4절의 표 이름·필드를 따름)
--
-- 원칙 (009·014·023·025와 같음)
--  * 경락·가격·코드는 공공데이터라 전 회원 공용 → user_id 칸이 없다. 회원별 값(품목 연결·허용오차)은 027.
--  * 새 표만 만든다. 기존 표·뷰·데이터 영향 없음.
--  * 다시 실행해도 오류가 나지 않는다(IF NOT EXISTS, 시드는 ON CONFLICT DO NOTHING, 함수는 CREATE OR REPLACE).
--  * migrate.js 가 파일 하나를 트랜잭션 하나로 감싼다 → BEGIN/COMMIT 을 쓰지 않는다.
--  * 금액(원)은 BIGINT 정수. kg 단가처럼 비교용 계산값만 NUMERIC. 부동소수(real/double) 칸 없음.
--  * API 키(serviceKey)는 어떤 칸에도 저장하지 않는다(ext_raw_response CHECK).

-- ======================================================================
-- 1. 표준코드 (aT 표준코드 API 15141818 katCode — 주 1회 + 첫 수집 때 받아 둠)
-- ======================================================================
CREATE TABLE IF NOT EXISTS code_master (
  code_type   VARCHAR(20)  NOT NULL,
  code        VARCHAR(20)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  parent_code VARCHAR(20),
  extra       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  fetched_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (code_type, code),
  CONSTRAINT code_master_type_chk CHECK (code_type IN ('market', 'corp', 'item_l', 'item_m', 'item_s', 'grade', 'pkg', 'size', 'unit', 'origin'))
);
COMMENT ON TABLE code_master IS 'T-203 aT 표준코드(도매시장·법인·품목 대/중/소·등급·포장·크기·단위·산지). 수집 작업 CODE_SYNC 가 upsert';

-- ======================================================================
-- 2. 내부 품목(품종) — 고추·파프리카 세부. 확장은 행 추가만
--    item_key = '<FAMILY>.<VARIETY>'. VARIETY '_' = 품종 모름(품목만 앎) → 매칭에서 부분일치까지만
-- ======================================================================
CREATE TABLE IF NOT EXISTS market_item (
  item_key             VARCHAR(40)  PRIMARY KEY,
  family               VARCHAR(20)  NOT NULL,
  family_name          VARCHAR(30)  NOT NULL,
  variety_name         VARCHAR(50)  NOT NULL,
  default_product_name VARCHAR(200),
  sort_order           INTEGER      NOT NULL DEFAULT 0,
  active               BOOLEAN      NOT NULL DEFAULT true,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT market_item_key_format CHECK (item_key ~ '^[A-Z0-9]+\.([A-Z0-9_]+)$'),
  CONSTRAINT market_item_family_match CHECK (split_part(item_key, '.', 1) = family)
);
COMMENT ON TABLE market_item IS 'T-203 내부 품목·품종(고추·파프리카 …). default_product_name = 회원 품목 연결을 추천할 때 찾을 공용 품목 이름';

INSERT INTO market_item (item_key, family, family_name, variety_name, default_product_name, sort_order) VALUES
  ('PEPPER._',          'PEPPER',  '고추',     '고추(품종 모름)', NULL,            100),
  ('PEPPER.CHEONGYANG', 'PEPPER',  '고추',     '청양고추',        '청양고추',      110),
  ('PEPPER.KKWARI',     'PEPPER',  '고추',     '꽈리고추',        '꽈리고추',      120),
  ('PEPPER.OI',         'PEPPER',  '고추',     '오이고추',        '오이고추',      130),
  ('PEPPER.GENERAL',    'PEPPER',  '고추',     '일반고추(풋고추)', '풋고추',       140),
  ('PEPPER.RED',        'PEPPER',  '고추',     '홍고추',          '홍고추',        150),
  ('PAPRIKA._',         'PAPRIKA', '파프리카', '파프리카(색 모름)', NULL,          200),
  ('PAPRIKA.RED',       'PAPRIKA', '파프리카', '빨강 파프리카',   '빨강 파프리카', 210),
  ('PAPRIKA.YELLOW',    'PAPRIKA', '파프리카', '노랑 파프리카',   '노랑 파프리카', 220),
  ('PAPRIKA.ORANGE',    'PAPRIKA', '파프리카', '주황 파프리카',   '주황 파프리카', 230)
ON CONFLICT (item_key) DO NOTHING;

-- ======================================================================
-- 3. 품목 매핑 — ① 코드 매핑(원천 대/중/소 코드) ② 키워드 매핑(원천 품목명·매입서 품목명). 코드가 우선
--    keyword_norm = 공백 제거 + 소문자 (서버 normalizeKeyword() 와 같은 규칙, CHECK 로 강제)
-- ======================================================================
CREATE TABLE IF NOT EXISTS item_mapping (
  id                 BIGSERIAL    PRIMARY KEY,
  target             VARCHAR(10)  NOT NULL DEFAULT 'BOTH',
  source             VARCHAR(20),
  code_l             VARCHAR(10),
  code_m             VARCHAR(10),
  code_s             VARCHAR(10),
  keyword_norm       VARCHAR(100),
  item_key           VARCHAR(40)  NOT NULL REFERENCES market_item(item_key),
  priority           INTEGER      NOT NULL DEFAULT 100,
  active             BOOLEAN      NOT NULL DEFAULT true,
  valid_from         DATE,
  valid_to           DATE,
  memo               VARCHAR(200),
  updated_by_user_id INTEGER      REFERENCES "user"(id),
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT item_mapping_target_chk  CHECK (target IN ('MARKET', 'DOC', 'BOTH')),
  CONSTRAINT item_mapping_source_chk  CHECK (source IS NULL OR source IN ('AT_REALTIME', 'AT_SETTLE', 'GARAK_PRICE', 'MOCK')),
  CONSTRAINT item_mapping_one_kind    CHECK ((code_m IS NOT NULL) <> (keyword_norm IS NOT NULL)),
  CONSTRAINT item_mapping_kw_norm     CHECK (keyword_norm IS NULL OR (keyword_norm = lower(regexp_replace(keyword_norm, '\s', '', 'g')) AND length(keyword_norm) > 0)),
  CONSTRAINT item_mapping_valid_range CHECK (valid_from IS NULL OR valid_to IS NULL OR valid_from <= valid_to)
);
COMMENT ON TABLE item_mapping IS 'T-203 원천 코드·품목명 → 내부 품목(item_key). 같은 키 여러 행이면 priority 작은 것 우선. 바꾸면 REMAP 작업으로 경락 행 재계산';
CREATE UNIQUE INDEX IF NOT EXISTS ux_item_mapping_code ON item_mapping
  (COALESCE(source, '*'), COALESCE(code_l, '*'), code_m, COALESCE(code_s, '*'))
  WHERE active AND code_m IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_item_mapping_keyword ON item_mapping
  (target, COALESCE(source, '*'), keyword_norm)
  WHERE active AND keyword_norm IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_item_mapping_item ON item_mapping (item_key);

-- 키워드 시드 (코드 매핑은 표준코드 확인 뒤 B①가 관리자 화면/시드로 넣는다 — 코드 값 [가정] 금지)
-- 긴 키워드가 먼저 맞게 priority 를 작게: '홍청양'(홍고추 쪽, U-07) < '청양'
INSERT INTO item_mapping (target, keyword_norm, item_key, priority, memo) VALUES
  ('BOTH', '청양고추',     'PEPPER.CHEONGYANG', 50,  '시드'),
  ('BOTH', '청양풋고추',   'PEPPER.CHEONGYANG', 50,  '시드'),
  ('BOTH', '청량고추',     'PEPPER.CHEONGYANG', 60,  '시드 — 흔한 오기'),
  ('BOTH', '청양',         'PEPPER.CHEONGYANG', 90,  '시드'),
  ('BOTH', '꽈리고추',     'PEPPER.KKWARI',     50,  '시드'),
  ('BOTH', '꽈리',         'PEPPER.KKWARI',     90,  '시드'),
  ('BOTH', '오이고추',     'PEPPER.OI',         50,  '시드'),
  ('BOTH', '오이맛고추',   'PEPPER.OI',         50,  '시드'),
  ('BOTH', '풋고추',       'PEPPER.GENERAL',    70,  '시드'),
  ('BOTH', '일반고추',     'PEPPER.GENERAL',    50,  '시드'),
  ('BOTH', '녹광',         'PEPPER.GENERAL',    80,  '시드 — 품종명'),
  ('BOTH', '홍고추',       'PEPPER.RED',        50,  '시드'),
  ('BOTH', '붉은고추',     'PEPPER.RED',        60,  '시드'),
  ('BOTH', '홍청양',       'PEPPER.RED',        40,  '시드 — U-07 사용자 확인(청양 홍을 홍고추로 볼지)'),
  ('BOTH', '고추',         'PEPPER._',          900, '시드 — 품종 모름'),
  ('BOTH', '빨강파프리카', 'PAPRIKA.RED',       50,  '시드'),
  ('BOTH', '적파프리카',   'PAPRIKA.RED',       50,  '시드'),
  ('BOTH', '레드파프리카', 'PAPRIKA.RED',       50,  '시드'),
  ('BOTH', '홍파프리카',   'PAPRIKA.RED',       50,  '시드'),
  ('BOTH', '노랑파프리카', 'PAPRIKA.YELLOW',    50,  '시드'),
  ('BOTH', '황파프리카',   'PAPRIKA.YELLOW',    50,  '시드'),
  ('BOTH', '옐로파프리카', 'PAPRIKA.YELLOW',    50,  '시드'),
  ('BOTH', '주황파프리카', 'PAPRIKA.ORANGE',    50,  '시드'),
  ('BOTH', '오렌지파프리카', 'PAPRIKA.ORANGE',  50,  '시드'),
  ('BOTH', '등색파프리카', 'PAPRIKA.ORANGE',    50,  '시드'),
  ('BOTH', '파프리카',     'PAPRIKA._',         900, '시드 — 색 모름')
ON CONFLICT DO NOTHING;

-- ======================================================================
-- 4. 등급 정규화 — 원천 grd_cd 명칭·매입서 표기 → grade_norm
-- ======================================================================
CREATE TABLE IF NOT EXISTS grade_alias (
  alias_norm VARCHAR(30) PRIMARY KEY,
  grade_norm VARCHAR(10) NOT NULL,
  memo       VARCHAR(100),
  CONSTRAINT grade_alias_norm_chk CHECK (grade_norm IN ('SPECIAL', 'HIGH', 'MID', 'LOW', 'OFF', 'NONE')),
  CONSTRAINT grade_alias_alias_chk CHECK (alias_norm = lower(regexp_replace(alias_norm, '\s', '', 'g')))
);
COMMENT ON TABLE grade_alias IS 'T-203 등급 표기 → 특(SPECIAL)/상(HIGH)/중(MID)/하(LOW)/등외(OFF)/무등급(NONE). "1등·2등" 같은 숫자 등급은 U-08 확인 후 추가';
INSERT INTO grade_alias (alias_norm, grade_norm) VALUES
  ('특', 'SPECIAL'), ('특품', 'SPECIAL'), ('특등', 'SPECIAL'),
  ('상', 'HIGH'), ('상품', 'HIGH'),
  ('중', 'MID'), ('중품', 'MID'), ('보통', 'MID'),
  ('하', 'LOW'), ('하품', 'LOW'),
  ('등외', 'OFF'), ('등외품', 'OFF'),
  ('무등급', 'NONE')
ON CONFLICT (alias_norm) DO NOTHING;

-- ======================================================================
-- 5. 포장 기본 중량 규칙 — 원천·매입서에 단위 중량이 없을 때만 씀(weight_source='RULE'). 시드 없음(U-09)
-- ======================================================================
CREATE TABLE IF NOT EXISTS pack_weight_rule (
  id          SERIAL       PRIMARY KEY,
  item_key    VARCHAR(40)  REFERENCES market_item(item_key),
  pkg_norm    VARCHAR(20)  NOT NULL,
  unit_qty_kg NUMERIC(10, 3) NOT NULL,
  priority    INTEGER      NOT NULL DEFAULT 100,
  active      BOOLEAN      NOT NULL DEFAULT true,
  memo        VARCHAR(200),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT pack_weight_rule_kg_pos CHECK (unit_qty_kg > 0),
  CONSTRAINT pack_weight_rule_pkg_chk CHECK (pkg_norm IN ('BOX', 'NET', 'BAG', 'KG', 'EA', 'ETC'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pack_weight_rule ON pack_weight_rule (COALESCE(item_key, '*'), pkg_norm) WHERE active;

-- ======================================================================
-- 6. 시장 달력(휴장일) · 수집 일정 — D 3.3·5.3. 휴장일은 관리자가 등록(요일 규칙으로 추정하지 않음)
-- ======================================================================
CREATE TABLE IF NOT EXISTS market_calendar (
  market_code        VARCHAR(10)  NOT NULL,
  cal_date           DATE         NOT NULL,
  kind               VARCHAR(10)  NOT NULL DEFAULT 'HOLIDAY',
  note               VARCHAR(100),
  updated_by_user_id INTEGER      REFERENCES "user"(id),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (market_code, cal_date),
  CONSTRAINT market_calendar_kind_chk CHECK (kind IN ('HOLIDAY', 'SPECIAL'))
);
COMMENT ON TABLE market_calendar IS 'T-203 도매시장 휴장일(HOLIDAY)·특별 운영일(SPECIAL). HOLIDAY 날은 수집 안 하고 스냅샷 HOLIDAY';

CREATE TABLE IF NOT EXISTS collect_schedule (
  job_type   VARCHAR(20)  NOT NULL,
  source     VARCHAR(20)  NOT NULL,
  cron_text  VARCHAR(100) NOT NULL,
  active     BOOLEAN      NOT NULL DEFAULT true,
  note       VARCHAR(200),
  updated_by_user_id INTEGER REFERENCES "user"(id),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (job_type, source),
  CONSTRAINT collect_schedule_type_chk   CHECK (job_type IN ('COLLECT_INTRADAY', 'COLLECT_FINAL', 'SETTLE_VERIFY', 'CODE_SYNC', 'PURGE_RAW')),
  CONSTRAINT collect_schedule_source_chk CHECK (source IN ('AT_REALTIME', 'AT_SETTLE', 'AT_CODE', 'GARAK_PRICE', 'MOCK', 'ALL'))
);
COMMENT ON TABLE collect_schedule IS 'T-203 수집 슬롯(KST, cron 5필드). 시드 시각은 D 4.1 [가정] — 경매 시간표 확인 후 관리자가 조정';
INSERT INTO collect_schedule (job_type, source, cron_text, note) VALUES
  ('COLLECT_INTRADAY', 'AT_REALTIME', '0 * * * *',  '[가정] 1시간 간격 — 경매 시간대만 남기도록 조정'),
  ('COLLECT_FINAL',    'AT_REALTIME', '0 11,16 * * *', '[가정] 전일 확정 11:00, 재시도 16:00'),
  ('SETTLE_VERIFY',    'AT_SETTLE',   '0 12 * * *', '[가정] 전일 정산정보로 누락 검증'),
  ('CODE_SYNC',        'AT_CODE',     '0 6 * * 1',  '[가정] 매주 월 06:00'),
  ('PURGE_RAW',        'ALL',         '0 4 * * *',  '원천 로그·멱등 키·오래된 후보 정리')
ON CONFLICT (job_type, source) DO NOTHING;

-- ======================================================================
-- 7. 작업 큐 (Postgres 큐 — FOR UPDATE SKIP LOCKED). D 3.3 그대로 + REMATCH(매입서 자동 재대조)
--    dedupe_key 전체 유일: 슬롯 단위 키(예 COLLECT:AT_REALTIME:110001:2026-11-24:INTRADAY:2026112414),
--    수동은 MANUAL:{user}:{YYYYMMDDHHmm} 접미 → 같은 분 연타는 1건. 같은 날짜 동시 실행은 advisory lock 이 막음(D 3.4)
--    재시도 = status QUEUED + run_after 미룸(별도 상태 없음). 최대 시도 넘으면 DEAD
-- ======================================================================
CREATE TABLE IF NOT EXISTS collect_job (
  id                    BIGSERIAL    PRIMARY KEY,
  job_type              VARCHAR(20)  NOT NULL,
  source                VARCHAR(20),
  market_code           VARCHAR(10),
  trade_date            DATE,
  phase                 VARCHAR(10),
  params                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key            VARCHAR(120) NOT NULL,
  status                VARCHAR(12)  NOT NULL DEFAULT 'QUEUED',
  attempts              SMALLINT     NOT NULL DEFAULT 0,
  max_attempts          SMALLINT     NOT NULL DEFAULT 5,
  run_after             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  locked_by             VARCHAR(60),
  locked_at             TIMESTAMPTZ,
  result                JSONB        NOT NULL DEFAULT '{}'::jsonb,
  last_error            VARCHAR(500),
  last_error_kind       VARCHAR(20),
  requested_by          VARCHAR(10)  NOT NULL DEFAULT 'SYSTEM',
  requested_by_user_id  INTEGER      REFERENCES "user"(id),
  requested_by_staff_id INTEGER      REFERENCES staff_account(id),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  CONSTRAINT collect_job_type_chk    CHECK (job_type IN ('COLLECT', 'CODE_SYNC', 'REMAP', 'PURGE_RAW', 'SETTLE_VERIFY', 'REMATCH')),
  CONSTRAINT collect_job_status_chk  CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'DEAD', 'CANCELLED')),
  CONSTRAINT collect_job_source_chk  CHECK (source IS NULL OR source IN ('AT_REALTIME', 'AT_SETTLE', 'AT_CODE', 'GARAK_PRICE', 'MOCK')),
  CONSTRAINT collect_job_phase_chk   CHECK (phase IS NULL OR phase IN ('INTRADAY', 'FINAL')),
  CONSTRAINT collect_job_attempt_chk CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT collect_job_by_chk      CHECK (requested_by IN ('SYSTEM', 'USER') AND ((requested_by = 'USER') = (requested_by_user_id IS NOT NULL))),
  CONSTRAINT collect_job_running_lock CHECK (status <> 'RUNNING' OR (locked_by IS NOT NULL AND locked_at IS NOT NULL)),
  CONSTRAINT collect_job_finished_match CHECK ((status IN ('DONE', 'FAILED', 'DEAD', 'CANCELLED')) = (finished_at IS NOT NULL)),
  CONSTRAINT collect_job_collect_need CHECK (job_type <> 'COLLECT' OR (source IS NOT NULL AND market_code IS NOT NULL AND trade_date IS NOT NULL AND phase IS NOT NULL))
);
COMMENT ON TABLE collect_job IS 'T-203 수집·재매핑·정리·누락검증·재대조 작업 큐(D 3.3). 워커가 FOR UPDATE SKIP LOCKED 로 가져감';
CREATE UNIQUE INDEX IF NOT EXISTS ux_collect_job_dedupe ON collect_job (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_collect_job_pick ON collect_job (run_after, id) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS idx_collect_job_running ON collect_job (locked_at) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS idx_collect_job_date ON collect_job (source, trade_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_collect_job_user ON collect_job (requested_by_user_id, created_at DESC) WHERE requested_by_user_id IS NOT NULL;

-- ======================================================================
-- 8. 서킷브레이커 상태 (소스별 1행, DB 에 둠 — 재시작·여러 인스턴스에서 같은 상태). D 4.4
--    AUTH_ERROR → disabled(사람이 해제), QUOTA → disabled_until 다음 날 00:10 KST
-- ======================================================================
CREATE TABLE IF NOT EXISTS ext_circuit_state (
  source               VARCHAR(20) PRIMARY KEY,
  state                VARCHAR(10) NOT NULL DEFAULT 'CLOSED',
  consecutive_failures INTEGER     NOT NULL DEFAULT 0,
  opened_at            TIMESTAMPTZ,
  next_probe_at        TIMESTAMPTZ,
  cooldown_sec         INTEGER     NOT NULL DEFAULT 600,
  disabled_reason      VARCHAR(20),
  disabled_until       TIMESTAMPTZ,
  last_error_kind      VARCHAR(20),
  last_success_at      TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ext_circuit_source_chk   CHECK (source IN ('AT_REALTIME', 'AT_SETTLE', 'AT_CODE', 'GARAK_PRICE', 'MOCK')),
  CONSTRAINT ext_circuit_state_chk    CHECK (state IN ('CLOSED', 'OPEN', 'HALF_OPEN')),
  CONSTRAINT ext_circuit_open_match   CHECK (state = 'CLOSED' OR (opened_at IS NOT NULL AND next_probe_at IS NOT NULL)),
  CONSTRAINT ext_circuit_fail_nonneg  CHECK (consecutive_failures >= 0),
  CONSTRAINT ext_circuit_cooldown_chk CHECK (cooldown_sec BETWEEN 60 AND 3600),
  CONSTRAINT ext_circuit_disabled_chk CHECK (disabled_reason IS NULL OR disabled_reason IN ('AUTH_ERROR', 'QUOTA', 'MANUAL'))
);
INSERT INTO ext_circuit_state (source) VALUES ('AT_REALTIME'), ('AT_SETTLE'), ('AT_CODE'), ('GARAK_PRICE'), ('MOCK')
ON CONFLICT (source) DO NOTHING;

-- ======================================================================
-- 9. 원천 응답 로그 (페이지마다 1행, 별도 연결로 저장 — 수집이 롤백돼도 원인 보존). D 3.3
--    보존: 정상 90일 · 오류 30일(PURGE_RAW). serviceKey 값은 '****' 로 바꾼 URL 만 저장(CHECK)
-- ======================================================================
CREATE TABLE IF NOT EXISTS ext_raw_response (
  id                 BIGSERIAL   PRIMARY KEY,
  job_id             BIGINT      REFERENCES collect_job(id) ON DELETE SET NULL,
  source             VARCHAR(20) NOT NULL,
  request_url_masked TEXT,
  request_params     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  page_no            INTEGER,
  http_status        INTEGER,
  kind               VARCHAR(20) NOT NULL,
  body               TEXT,
  body_truncated     BOOLEAN     NOT NULL DEFAULT false,
  body_hash          CHAR(64),
  row_count          INTEGER,
  duration_ms        INTEGER,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ext_raw_source_chk CHECK (source IN ('AT_REALTIME', 'AT_SETTLE', 'AT_CODE', 'GARAK_PRICE', 'MOCK')),
  CONSTRAINT ext_raw_kind_chk   CHECK (kind IN ('OK', 'EMPTY', 'AUTH_ERROR', 'QUOTA', 'RATE_LIMIT', 'SERVER_ERROR', 'TIMEOUT', 'BAD_RESPONSE')),
  CONSTRAINT ext_raw_url_masked CHECK (request_url_masked IS NULL OR request_url_masked !~* 'servicekey=[^*&]'),
  CONSTRAINT ext_raw_no_key     CHECK (NOT (request_params ?| ARRAY['serviceKey', 'ServiceKey', 'service_key', 'apiKey']))
);
COMMENT ON TABLE ext_raw_response IS 'T-203 외부 API 원천 응답(페이지 단위). 출하자 실명이 원천에 있으면 body 에만 남고 화면·API 로는 내보내지 않음(관리자 R-100 만)';
CREATE INDEX IF NOT EXISTS idx_ext_raw_job ON ext_raw_response (job_id, page_no);
CREATE INDEX IF NOT EXISTS idx_ext_raw_fetched ON ext_raw_response (fetched_at, kind);

-- ======================================================================
-- 10. 수집 스냅샷 (소스·시장·거래일·단계별 수집 결과). D 3.3
--     is_latest_ok = 이 (소스, 시장, 거래일)의 마지막 정상 결과(COMPLETE·EMPTY·HOLIDAY) — 조회 폴백·대조 기준
--     자동 매입전환은 phase FINAL + status COMPLETE 인 날만(D 5.4)
-- ======================================================================
CREATE TABLE IF NOT EXISTS collect_snapshot (
  id             BIGSERIAL   PRIMARY KEY,
  source         VARCHAR(20) NOT NULL,
  market_code    VARCHAR(10) NOT NULL,
  trade_date     DATE        NOT NULL,
  phase          VARCHAR(10) NOT NULL,
  job_id         BIGINT      REFERENCES collect_job(id) ON DELETE SET NULL,
  status         VARCHAR(12) NOT NULL DEFAULT 'RUNNING',
  total_count    INTEGER     NOT NULL DEFAULT 0,
  fetched_count  INTEGER     NOT NULL DEFAULT 0,
  pages          INTEGER     NOT NULL DEFAULT 0,
  inserted       INTEGER     NOT NULL DEFAULT 0,
  updated        INTEGER     NOT NULL DEFAULT 0,
  unchanged      INTEGER     NOT NULL DEFAULT 0,
  unmapped       INTEGER     NOT NULL DEFAULT 0,
  withdrawn      INTEGER     NOT NULL DEFAULT 0,
  content_hash   CHAR(64),
  verify_warning TEXT,
  error_kind     VARCHAR(20),
  error_message  VARCHAR(500),
  is_latest_ok   BOOLEAN     NOT NULL DEFAULT false,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  CONSTRAINT collect_snapshot_source_chk CHECK (source IN ('AT_REALTIME', 'AT_SETTLE', 'GARAK_PRICE', 'MOCK')),
  CONSTRAINT collect_snapshot_phase_chk  CHECK (phase IN ('INTRADAY', 'FINAL')),
  CONSTRAINT collect_snapshot_status_chk CHECK (status IN ('RUNNING', 'COMPLETE', 'PARTIAL', 'FAILED', 'EMPTY', 'HOLIDAY', 'NOT_YET')),
  CONSTRAINT collect_snapshot_ok_chk     CHECK (NOT is_latest_ok OR status IN ('COMPLETE', 'EMPTY', 'HOLIDAY')),
  CONSTRAINT collect_snapshot_done_chk   CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CONSTRAINT collect_snapshot_counts     CHECK (total_count >= 0 AND fetched_count >= 0 AND pages >= 0 AND inserted >= 0 AND updated >= 0
                                                AND unchanged >= 0 AND unmapped >= 0 AND withdrawn >= 0)
);
COMMENT ON TABLE collect_snapshot IS 'T-203 수집 결과. 대조는 is_latest_ok 행으로 "기준 데이터 있음"을 판단. NOT_YET·PARTIAL·FAILED·RUNNING 만 있는 날 = BASE_NOT_READY';
CREATE UNIQUE INDEX IF NOT EXISTS ux_collect_snapshot_latest_ok ON collect_snapshot (source, market_code, trade_date) WHERE is_latest_ok;
CREATE INDEX IF NOT EXISTS idx_collect_snapshot_date ON collect_snapshot (trade_date DESC, source, phase);

-- ======================================================================
-- 11. 정규화 경락 (건별). D 0.2 표 + 내부 품목(item_key)·등급 정규화·중량 근거
--     product_id 대신 item_key 를 둔다 — 판매툴 품목은 회원별 개인 품목(T-216)이 있어 공용 표에 둘 수 없음.
--     회원 품목 연결은 027 market_product_link.  값이 바뀌면 이전 값은 auction_trade_history(D 4.3)
-- ======================================================================
CREATE TABLE IF NOT EXISTS auction_trade (
  id                  BIGSERIAL     PRIMARY KEY,
  source              VARCHAR(20)   NOT NULL,
  source_row_key      VARCHAR(200)  NOT NULL,
  trade_date          DATE          NOT NULL,
  auction_at          TIMESTAMPTZ,
  market_code         VARCHAR(10)   NOT NULL,
  market_name         VARCHAR(50),
  corp_code           VARCHAR(10),
  corp_name           VARCHAR(50),
  item_l_code         VARCHAR(10),
  item_m_code         VARCHAR(10),
  item_s_code         VARCHAR(10),
  item_name_raw       VARCHAR(100),
  item_key            VARCHAR(40)   REFERENCES market_item(item_key),
  map_status          VARCHAR(10)   NOT NULL DEFAULT 'UNMAPPED',
  grade_code          VARCHAR(10),
  grade_name          VARCHAR(30),
  grade_norm          VARCHAR(10),
  pkg_code            VARCHAR(10),
  pkg_name            VARCHAR(30),
  pkg_norm            VARCHAR(20),
  size_code           VARCHAR(10),
  size_name           VARCHAR(30),
  unit_code           VARCHAR(10),
  unit_name           VARCHAR(30),
  unit_qty_kg         NUMERIC(10, 3),
  weight_source       VARCHAR(8)    NOT NULL DEFAULT 'UNKNOWN',
  qty                 NUMERIC(12, 3) NOT NULL,
  weight_kg           NUMERIC(14, 3),
  unit_price          BIGINT        NOT NULL,
  price_per_kg        NUMERIC(14, 2),
  amount              BIGINT        NOT NULL,
  origin_code         VARCHAR(10),
  origin_name         VARCHAR(50),
  shipper_name_masked VARCHAR(50),
  buyer_code          VARCHAR(20),
  auction_seq         VARCHAR(50),
  snapshot_id         BIGINT        NOT NULL REFERENCES collect_snapshot(id),
  raw_ref             BIGINT        REFERENCES ext_raw_response(id) ON DELETE SET NULL,
  content_hash        CHAR(64)      NOT NULL,
  revision            INTEGER       NOT NULL DEFAULT 1,
  withdrawn_at        TIMESTAMPTZ,
  first_seen_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_seen_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT auction_trade_source_chk  CHECK (source IN ('AT_REALTIME', 'AT_SETTLE', 'GARAK_PRICE', 'MOCK')),
  CONSTRAINT auction_trade_map_chk     CHECK (map_status IN ('MAPPED', 'UNMAPPED', 'IGNORED')),
  CONSTRAINT auction_trade_map_match   CHECK ((map_status = 'MAPPED') = (item_key IS NOT NULL)),
  CONSTRAINT auction_trade_grade_chk   CHECK (grade_norm IS NULL OR grade_norm IN ('SPECIAL', 'HIGH', 'MID', 'LOW', 'OFF', 'NONE')),
  CONSTRAINT auction_trade_pkg_chk     CHECK (pkg_norm IS NULL OR pkg_norm IN ('BOX', 'NET', 'BAG', 'KG', 'EA', 'ETC')),
  CONSTRAINT auction_trade_weight_chk  CHECK (weight_source IN ('SOURCE', 'RULE', 'UNKNOWN')),
  CONSTRAINT auction_trade_weight_need CHECK ((weight_source = 'UNKNOWN') = (unit_qty_kg IS NULL)),
  CONSTRAINT auction_trade_qty_pos     CHECK (qty > 0),
  CONSTRAINT auction_trade_kg_pos      CHECK (unit_qty_kg IS NULL OR unit_qty_kg > 0),
  CONSTRAINT auction_trade_money_chk   CHECK (unit_price >= 0 AND amount >= 0),
  CONSTRAINT auction_trade_revision    CHECK (revision >= 1)
);
COMMENT ON TABLE auction_trade IS 'T-203 정규화 경락(건별, 전 회원 공용). (source, source_row_key) upsert(D 5.6). 값이 바뀌면 revision+1·이전 값 auction_trade_history, 원천에서 사라지면 withdrawn_at(지우지 않음)';
COMMENT ON COLUMN auction_trade.unit_price IS '단위(상자 등)당 낙찰가 — 원 정수. 원장 금액은 unit_price × qty';
COMMENT ON COLUMN auction_trade.price_per_kg IS '비교용 kg 단가(소수 둘째 자리, HALF_UP). 원장 금액에 쓰지 않음';
CREATE UNIQUE INDEX IF NOT EXISTS ux_auction_trade_source_key ON auction_trade (source, source_row_key);
CREATE INDEX IF NOT EXISTS idx_auction_trade_match ON auction_trade (trade_date, item_key, grade_norm) WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_auction_trade_codes ON auction_trade (trade_date, item_m_code, item_s_code);
CREATE INDEX IF NOT EXISTS idx_auction_trade_corp ON auction_trade (corp_code, trade_date);
CREATE INDEX IF NOT EXISTS idx_auction_trade_buyer ON auction_trade (buyer_code, trade_date) WHERE buyer_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auction_trade_seq ON auction_trade (auction_seq) WHERE auction_seq IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auction_trade_unmapped ON auction_trade (trade_date) WHERE map_status = 'UNMAPPED';

CREATE TABLE IF NOT EXISTS auction_trade_history (
  id           BIGSERIAL   PRIMARY KEY,
  trade_id     BIGINT      NOT NULL REFERENCES auction_trade(id),
  revision     INTEGER     NOT NULL,
  old_values   JSONB       NOT NULL,
  content_hash CHAR(64)    NOT NULL,
  snapshot_id  BIGINT      REFERENCES collect_snapshot(id),
  replaced_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ux_auction_trade_history UNIQUE (trade_id, revision)
);
COMMENT ON TABLE auction_trade_history IS 'T-203 경락 값이 정정되기 전 값(revision 별). 매입전환에 쓰인 건이 바뀌면 줄에 BASE_REVISED 경고';

-- ======================================================================
-- 12. 품목별 가격(보조 소스 — 가락 주요품목 가격 15004517: 품목·등급별 평균가·전일 대비. 건별 매칭에는 쓰지 않음)
-- ======================================================================
CREATE TABLE IF NOT EXISTS market_price_daily (
  id            BIGSERIAL     PRIMARY KEY,
  source        VARCHAR(20)   NOT NULL DEFAULT 'GARAK_PRICE',
  price_date    DATE          NOT NULL,
  item_name_raw VARCHAR(100)  NOT NULL,
  item_key      VARCHAR(40)   REFERENCES market_item(item_key),
  grade_name    VARCHAR(30)   NOT NULL DEFAULT '',
  grade_norm    VARCHAR(10),
  unit_name     VARCHAR(30)   NOT NULL DEFAULT '',
  unit_qty_kg   NUMERIC(10, 3),
  avg_price     BIGINT,
  prev_price    BIGINT,
  snapshot_id   BIGINT        REFERENCES collect_snapshot(id),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT market_price_daily_source_chk CHECK (source IN ('GARAK_PRICE', 'MOCK')),
  CONSTRAINT market_price_daily_money CHECK ((avg_price IS NULL OR avg_price >= 0) AND (prev_price IS NULL OR prev_price >= 0)),
  CONSTRAINT market_price_daily_grade CHECK (grade_norm IS NULL OR grade_norm IN ('SPECIAL', 'HIGH', 'MID', 'LOW', 'OFF', 'NONE'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_market_price_daily ON market_price_daily (source, price_date, item_name_raw, grade_name, unit_name);
CREATE INDEX IF NOT EXISTS idx_market_price_daily_item ON market_price_daily (item_key, price_date DESC);

-- 확인 SQL (I·C 검토용 — 이 파일은 실행하지 않음). 모두 0행이어야 한다
-- ① RUNNING 인데 10분 넘게 잠긴 작업(회수 대상): SELECT id FROM collect_job WHERE status = 'RUNNING' AND locked_at < NOW() - INTERVAL '10 minutes';
-- ② 같은 날 정상 스냅샷 2건:   SELECT source, market_code, trade_date FROM collect_snapshot WHERE is_latest_ok GROUP BY 1,2,3 HAVING COUNT(*) > 1;
-- ③ 원천 로그에 키:            SELECT id FROM ext_raw_response WHERE body ~* 'serviceKey=[^&"]{10,}';
