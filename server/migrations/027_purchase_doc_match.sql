-- 027 (2026-11-24, T-203): 매입서 대조·매입전환 — 회원별 품목·법인 연결 · 허용오차 · 매입서 헤더/상세 · 대조 실행/후보
--                           · 매입전환 · 대조 이력(감사) · 요청 멱등 키 · purchase 연결 칸 · 매입 취소 동기화 트리거
-- 설계: AI 팀 산출물 A_설계서.md 2·3장
--
-- 원칙 (009·014·023·025와 같음)
--  * 기존 데이터는 지우거나 고치지 않는다. 기존 표 변경은 purchase 에 NULL 칸 1개 + 부분 유일 인덱스 + 트리거 1개,
--    audit_log CHECK 값 목록 넓히기뿐 → 기존 매입·미지급·재고·FIFO·원장 값이 변하지 않는다(새 칸은 모두 NULL).
--  * 같은 파일을 다시 실행해도 오류가 나지 않는다(IF NOT EXISTS, 제약은 이름 확인, 함수·트리거는 CREATE OR REPLACE/DROP IF EXISTS).
--  * migrate.js 가 파일 하나를 트랜잭션 하나로 감싼다 → BEGIN/COMMIT 을 쓰지 않는다.
--  * 금액(원)은 BIGINT 정수. purchase 표(NUMERIC(14,2))에 넣을 때는 문자열로 넘겨 DB 가 계산한다(JS 부동소수 계산 금지).
--  * 회원 간 교차 참조는 (id, user_id) 복합 FK 로 DB 가 막는다(009 D-07 과 같은 방식).

-- ======================================================================
-- 1. 회원별 연결 — 내부 품목(item_key[, 등급]) → 판매툴 품목 / 법인 코드 → 제공처 거래처
-- ======================================================================
CREATE TABLE IF NOT EXISTS market_product_link (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES "user"(id),
  item_key    VARCHAR(40) NOT NULL REFERENCES market_item(item_key),
  grade_norm  VARCHAR(10),
  product_id  INTEGER     NOT NULL REFERENCES product(id),
  created_by_staff_id INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT market_product_link_grade_chk CHECK (grade_norm IS NULL OR grade_norm IN ('SPECIAL', 'HIGH', 'MID', 'LOW', 'OFF', 'NONE')),
  CONSTRAINT fk_mpl_staff_same_owner FOREIGN KEY (created_by_staff_id, user_id) REFERENCES staff_account (id, owner_user_id)
);
COMMENT ON TABLE market_product_link IS 'T-203 회원별: 내부 품목(+등급) → 매입전환 때 쓸 판매툴 품목. 등급 행이 있으면 등급 행 우선, 없으면 등급 NULL 행. 품목은 공용 또는 본인 개인 품목만(API 검사)';
CREATE UNIQUE INDEX IF NOT EXISTS ux_market_product_link ON market_product_link (user_id, item_key, COALESCE(grade_norm, '*'));

CREATE TABLE IF NOT EXISTS market_corp_link (
  id          SERIAL      PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES "user"(id),
  corp_code   VARCHAR(10) NOT NULL,
  partner_id  INTEGER     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_mcl_partner_same_user FOREIGN KEY (partner_id, user_id) REFERENCES account (id, user_id)
);
COMMENT ON TABLE market_corp_link IS 'T-203 회원별: 도매시장법인 코드(경락 corp_code) ↔ 내 거래처(제공처, 예: 서울청과). 매입서 제공처 → 법인 코드를 찾는 데 씀';
CREATE UNIQUE INDEX IF NOT EXISTS ux_market_corp_link_code ON market_corp_link (user_id, corp_code);
CREATE UNIQUE INDEX IF NOT EXISTS ux_market_corp_link_partner ON market_corp_link (user_id, partner_id);

-- ======================================================================
-- 2. 허용오차 — user_id NULL = 시스템 기본(1행 필수), 회원 행이 있으면 그 행. 품목군/품목별 행이 더 좁은 범위로 우선
--    auto_* = 자동 전환(완전일치) 기준, review_* = 후보로 보여 줄(부분일치) 범위
-- ======================================================================
CREATE TABLE IF NOT EXISTS match_tolerance (
  id                SERIAL       PRIMARY KEY,
  user_id           INTEGER      REFERENCES "user"(id),
  item_family       VARCHAR(20),
  item_key          VARCHAR(40)  REFERENCES market_item(item_key),
  price_pct_auto    NUMERIC(5, 2) NOT NULL,
  price_pct_review  NUMERIC(5, 2) NOT NULL,
  qty_pct_auto      NUMERIC(5, 2) NOT NULL,
  qty_pct_review    NUMERIC(5, 2) NOT NULL,
  amount_abs_auto   BIGINT       NOT NULL,
  date_before_auto  SMALLINT     NOT NULL,
  date_after_auto   SMALLINT     NOT NULL,
  date_before_review SMALLINT    NOT NULL,
  date_after_review SMALLINT     NOT NULL,
  auto_convert      BOOLEAN      NOT NULL,
  auto_min_score    SMALLINT     NOT NULL,
  ambiguity_margin  SMALLINT     NOT NULL,
  updated_by_staff_id INTEGER,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT match_tol_scope_one   CHECK (item_family IS NULL OR item_key IS NULL),
  CONSTRAINT match_tol_family_chk  CHECK (item_family IS NULL OR item_family ~ '^[A-Z0-9]+$'),
  CONSTRAINT match_tol_price       CHECK (price_pct_auto >= 0 AND price_pct_auto <= price_pct_review AND price_pct_review <= 50),
  CONSTRAINT match_tol_qty         CHECK (qty_pct_auto >= 0 AND qty_pct_auto <= qty_pct_review AND qty_pct_review <= 100),
  CONSTRAINT match_tol_amount      CHECK (amount_abs_auto >= 0 AND amount_abs_auto <= 10000),
  CONSTRAINT match_tol_date        CHECK (date_before_auto BETWEEN 0 AND 7 AND date_after_auto BETWEEN 0 AND 7
                                          AND date_before_review BETWEEN date_before_auto AND 14
                                          AND date_after_review BETWEEN date_after_auto AND 14),
  CONSTRAINT match_tol_score       CHECK (auto_min_score BETWEEN 50 AND 100 AND ambiguity_margin BETWEEN 0 AND 50),
  CONSTRAINT fk_match_tol_staff_same_owner FOREIGN KEY (updated_by_staff_id, user_id) REFERENCES staff_account (id, owner_user_id)
);
COMMENT ON TABLE match_tolerance IS 'T-203 대조 허용오차. 적용 순서: (회원, 품목) → (회원, 품목군) → (회원, 전체) → (기본, 품목) → (기본, 품목군) → (기본, 전체). 대조 실행마다 쓴 값을 purchase_match_run.tolerance_snapshot 에 남김';
CREATE UNIQUE INDEX IF NOT EXISTS ux_match_tolerance_scope ON match_tolerance (COALESCE(user_id, 0), COALESCE(item_family, '*'), COALESCE(item_key, '*'));

-- 시스템 기본값 [가정 — U-01 사용자 확인]: 매입서 단가 = 낙찰가가 원칙이라 자동 전환은 단가·수량 정확 일치,
-- 경락일 = 매입서 거래일 또는 그 전날(밤 경매 → 다음 날 정산). 후보는 단가 ±10%, 수량 ±20%, 날짜 −3~+1일까지 보여 줌
INSERT INTO match_tolerance (user_id, item_family, item_key,
  price_pct_auto, price_pct_review, qty_pct_auto, qty_pct_review, amount_abs_auto,
  date_before_auto, date_after_auto, date_before_review, date_after_review,
  auto_convert, auto_min_score, ambiguity_margin)
SELECT NULL, NULL, NULL, 0, 10, 0, 20, 0, 1, 0, 3, 1, true, 85, 10
WHERE NOT EXISTS (SELECT 1 FROM match_tolerance WHERE user_id IS NULL AND item_family IS NULL AND item_key IS NULL);

-- ======================================================================
-- 3. 매입서 헤더 — 업로드 1건에서 (매입서 번호 | 거래일+제공처) 묶음마다 1행. 파일 기록은 excel_upload(024, kind='purchase_doc') 재사용
-- ======================================================================
CREATE TABLE IF NOT EXISTS purchase_doc (
  id                  BIGSERIAL    PRIMARY KEY,
  user_id             INTEGER      NOT NULL REFERENCES "user"(id),
  input_kind          VARCHAR(10)  NOT NULL,
  upload_id           BIGINT       REFERENCES excel_upload(id),
  doc_no              VARCHAR(50),
  doc_date            DATE         NOT NULL,
  supplier_partner_id INTEGER      NOT NULL,
  corp_code           VARCHAR(10),
  status              VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
  line_count          INTEGER      NOT NULL DEFAULT 0,
  amount_total        BIGINT       NOT NULL DEFAULT 0,
  converted_count     INTEGER      NOT NULL DEFAULT 0,
  pending_count       INTEGER      NOT NULL DEFAULT 0,
  hold_count          INTEGER      NOT NULL DEFAULT 0,
  rejected_count      INTEGER      NOT NULL DEFAULT 0,
  cancelled_count     INTEGER      NOT NULL DEFAULT 0,
  memo                VARCHAR(200),
  created_by_staff_id INTEGER,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       VARCHAR(200),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT purchase_doc_kind_chk    CHECK (input_kind IN ('EXCEL', 'CSV', 'MANUAL')),
  CONSTRAINT purchase_doc_upload_need CHECK ((input_kind = 'MANUAL') = (upload_id IS NULL)),
  CONSTRAINT purchase_doc_status_chk  CHECK (status IN ('PENDING', 'HOLD', 'PARTIAL_CONVERTED', 'CONVERTED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT purchase_doc_cancel_match CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT purchase_doc_counts_chk  CHECK (line_count >= 0 AND amount_total >= 0 AND converted_count >= 0 AND pending_count >= 0
                                             AND hold_count >= 0 AND rejected_count >= 0 AND cancelled_count >= 0
                                             AND converted_count + pending_count + hold_count + rejected_count + cancelled_count = line_count),
  CONSTRAINT fk_pdoc_partner_same_user FOREIGN KEY (supplier_partner_id, user_id) REFERENCES account (id, user_id),
  CONSTRAINT fk_pdoc_staff_same_owner  FOREIGN KEY (created_by_staff_id, user_id) REFERENCES staff_account (id, owner_user_id)
);
COMMENT ON TABLE purchase_doc IS 'T-203 매입서 헤더. status 는 줄 상태에서 purchase_doc_recalc() 가 계산(직접 UPDATE 금지, CANCELLED 만 API 가 설정)';
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_doc_id_user ON purchase_doc (id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_doc_no ON purchase_doc (user_id, supplier_partner_id, doc_no)
  WHERE doc_no IS NOT NULL AND status <> 'CANCELLED';
CREATE INDEX IF NOT EXISTS idx_purchase_doc_user_date ON purchase_doc (user_id, doc_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_purchase_doc_user_open ON purchase_doc (user_id, status) WHERE status IN ('PENDING', 'HOLD', 'PARTIAL_CONVERTED');
CREATE INDEX IF NOT EXISTS idx_purchase_doc_upload ON purchase_doc (upload_id) WHERE upload_id IS NOT NULL;

-- ======================================================================
-- 4. 매입서 상세(줄)
-- ======================================================================
CREATE TABLE IF NOT EXISTS purchase_doc_line (
  id                  BIGSERIAL     PRIMARY KEY,
  doc_id              BIGINT        NOT NULL,
  user_id             INTEGER       NOT NULL REFERENCES "user"(id),
  line_no             INTEGER       NOT NULL,
  source_line_no      INTEGER,
  trade_date          DATE          NOT NULL,
  arrival_date        DATE,
  item_name_raw       VARCHAR(100)  NOT NULL,
  item_key            VARCHAR(40)   REFERENCES market_item(item_key),
  grade_raw           VARCHAR(30),
  grade_norm          VARCHAR(10),
  pkg_raw             VARCHAR(50),
  pkg_norm            VARCHAR(20),
  unit_qty_kg         NUMERIC(10, 3),
  weight_source       VARCHAR(8)    NOT NULL DEFAULT 'UNKNOWN',
  qty                 NUMERIC(12, 3) NOT NULL,
  unit_price          BIGINT        NOT NULL,
  amount              BIGINT        NOT NULL,
  amount_calc_diff    BIGINT        GENERATED ALWAYS AS (amount - ROUND(qty * unit_price)::bigint) STORED,
  origin_name         VARCHAR(50),
  shipper_name_masked VARCHAR(50),
  auction_ref         VARCHAR(50),
  buyer_code          VARCHAR(20),
  product_id          INTEGER       REFERENCES product(id),
  line_fingerprint    CHAR(64)      NOT NULL,
  status              VARCHAR(12)   NOT NULL DEFAULT 'PENDING',
  match_result        VARCHAR(10),
  match_score         SMALLINT,
  best_trade_id       BIGINT        REFERENCES auction_trade(id),
  candidate_count     INTEGER,
  reason_codes        TEXT[]        NOT NULL DEFAULT '{}',
  warning_flags       TEXT[]        NOT NULL DEFAULT '{}',
  last_run_id         BIGINT,
  matched_at          TIMESTAMPTZ,
  version             INTEGER       NOT NULL DEFAULT 1,
  rejected_at         TIMESTAMPTZ,
  reject_reason       VARCHAR(200),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_pdl_doc_same_user   FOREIGN KEY (doc_id, user_id) REFERENCES purchase_doc (id, user_id) ON DELETE RESTRICT,
  CONSTRAINT ux_pdl_doc_line        UNIQUE (doc_id, line_no),
  CONSTRAINT pdl_status_chk         CHECK (status IN ('PENDING', 'HOLD', 'CONVERTED', 'REJECTED', 'CANCELLED')),
  CONSTRAINT pdl_match_chk          CHECK (match_result IS NULL OR match_result IN ('EXACT', 'PARTIAL', 'UNMATCHED')),
  CONSTRAINT pdl_match_score_chk    CHECK (match_score IS NULL OR match_score BETWEEN 0 AND 100),
  CONSTRAINT pdl_converted_matched  CHECK (status <> 'CONVERTED' OR match_result IS NOT NULL),
  CONSTRAINT pdl_reject_match       CHECK ((status = 'REJECTED') = (rejected_at IS NOT NULL)),
  CONSTRAINT pdl_grade_chk          CHECK (grade_norm IS NULL OR grade_norm IN ('SPECIAL', 'HIGH', 'MID', 'LOW', 'OFF', 'NONE')),
  CONSTRAINT pdl_pkg_chk            CHECK (pkg_norm IS NULL OR pkg_norm IN ('BOX', 'NET', 'BAG', 'KG', 'EA', 'ETC')),
  CONSTRAINT pdl_weight_chk         CHECK (weight_source IN ('SOURCE', 'RULE', 'UNKNOWN') AND ((weight_source = 'UNKNOWN') = (unit_qty_kg IS NULL))),
  CONSTRAINT pdl_qty_pos            CHECK (qty > 0),
  CONSTRAINT pdl_kg_pos             CHECK (unit_qty_kg IS NULL OR unit_qty_kg > 0),
  CONSTRAINT pdl_money_chk          CHECK (unit_price >= 0 AND amount >= 0),
  CONSTRAINT pdl_version_pos        CHECK (version >= 1),
  CONSTRAINT pdl_dates_chk          CHECK (arrival_date IS NULL OR arrival_date >= trade_date - 7)
);
COMMENT ON TABLE purchase_doc_line IS 'T-203 매입서 줄. status: PENDING(대조 전·전환 가능) HOLD(검토 대기) CONVERTED REJECTED(매입 아님) CANCELLED(전환 취소). match_result 는 마지막 대조 결과';
COMMENT ON COLUMN purchase_doc_line.amount_calc_diff IS '매입서 금액 − ROUND(수량×단가). 0 이 아니면 경고 AMOUNT_CALC_DIFF';
COMMENT ON COLUMN purchase_doc_line.line_fingerprint IS 'SHA-256(거래일|법인코드|item_key 또는 품목명|등급|포장|kg|수량|단가|경매번호) — 다른 매입서에 같은 줄이 있으면 경고 DUP_LINE_OTHER_DOC';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdl_id_user ON purchase_doc_line (id, user_id);
CREATE INDEX IF NOT EXISTS idx_pdl_user_open ON purchase_doc_line (user_id, status, trade_date) WHERE status IN ('PENDING', 'HOLD', 'CANCELLED');
CREATE INDEX IF NOT EXISTS idx_pdl_user_match ON purchase_doc_line (user_id, trade_date, item_key);
CREATE INDEX IF NOT EXISTS idx_pdl_fingerprint ON purchase_doc_line (user_id, line_fingerprint);
CREATE INDEX IF NOT EXISTS idx_pdl_doc ON purchase_doc_line (doc_id, line_no);

-- ======================================================================
-- 5. 대조 실행 · 후보(줄마다 상위 5건)
-- ======================================================================
CREATE TABLE IF NOT EXISTS purchase_match_run (
  id                 BIGSERIAL    PRIMARY KEY,
  user_id            INTEGER      NOT NULL REFERENCES "user"(id),
  doc_id             BIGINT,
  trigger            VARCHAR(16)  NOT NULL,
  engine_version     VARCHAR(20)  NOT NULL,
  tolerance_snapshot JSONB        NOT NULL,
  line_count         INTEGER      NOT NULL DEFAULT 0,
  exact_count        INTEGER      NOT NULL DEFAULT 0,
  partial_count      INTEGER      NOT NULL DEFAULT 0,
  unmatched_count    INTEGER      NOT NULL DEFAULT 0,
  auto_converted     INTEGER      NOT NULL DEFAULT 0,
  actor_staff_id     INTEGER,
  started_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  CONSTRAINT pmr_trigger_chk CHECK (trigger IN ('UPLOAD', 'MANUAL', 'REMATCH_LINE', 'AUTO_AFTER_SYNC', 'LINE_EDIT')),
  CONSTRAINT fk_pmr_doc_same_user FOREIGN KEY (doc_id, user_id) REFERENCES purchase_doc (id, user_id),
  CONSTRAINT fk_pmr_staff_same_owner FOREIGN KEY (actor_staff_id, user_id) REFERENCES staff_account (id, owner_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pmr_id_user ON purchase_match_run (id, user_id);
CREATE INDEX IF NOT EXISTS idx_pmr_doc ON purchase_match_run (doc_id, started_at DESC);

CREATE TABLE IF NOT EXISTS purchase_match_candidate (
  id             BIGSERIAL     PRIMARY KEY,
  run_id         BIGINT        NOT NULL,
  user_id        INTEGER       NOT NULL REFERENCES "user"(id),
  line_id        BIGINT        NOT NULL,
  trade_id       BIGINT        NOT NULL REFERENCES auction_trade(id),
  rank           SMALLINT      NOT NULL,
  score          SMALLINT      NOT NULL,
  strict_pass    BOOLEAN       NOT NULL,
  breakdown      JSONB         NOT NULL,
  price_diff     BIGINT,
  price_diff_pct NUMERIC(7, 2),
  qty_diff       NUMERIC(12, 3),
  amount_diff    BIGINT,
  date_diff      SMALLINT,
  flags          TEXT[]        NOT NULL DEFAULT '{}',
  CONSTRAINT fk_pmc_run_same_user  FOREIGN KEY (run_id, user_id) REFERENCES purchase_match_run (id, user_id) ON DELETE CASCADE,
  CONSTRAINT fk_pmc_line_same_user FOREIGN KEY (line_id, user_id) REFERENCES purchase_doc_line (id, user_id),
  CONSTRAINT ux_pmc_run_line_trade UNIQUE (run_id, line_id, trade_id),
  CONSTRAINT pmc_rank_chk  CHECK (rank BETWEEN 1 AND 5),
  CONSTRAINT pmc_score_chk CHECK (score BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS idx_pmc_line_run ON purchase_match_candidate (line_id, run_id, rank);

-- ======================================================================
-- 6. 매입전환 — 줄 1개 ↔ 활성 매입 1건(부분 유일). 같은 경락 건을 같은 회원의 두 줄이 동시에 쓰지 못함
-- ======================================================================
CREATE TABLE IF NOT EXISTS purchase_doc_conversion (
  id                    BIGSERIAL     PRIMARY KEY,
  user_id               INTEGER       NOT NULL REFERENCES "user"(id),
  doc_id                BIGINT        NOT NULL,
  line_id               BIGINT        NOT NULL,
  trade_id              BIGINT        REFERENCES auction_trade(id),
  purchase_id           INTEGER,
  mode                  VARCHAR(8)    NOT NULL,
  status                VARCHAR(10)   NOT NULL DEFAULT 'ACTIVE',
  match_result          VARCHAR(10),
  match_score           SMALLINT,
  doc_amount            BIGINT        NOT NULL,
  purchase_total        NUMERIC(14, 2),
  amount_diff           NUMERIC(14, 2),
  price_diff            BIGINT,
  purchase_qty          NUMERIC(12, 3),
  purchase_unit_price   NUMERIC(12, 2),
  warning_flags         TEXT[]        NOT NULL DEFAULT '{}',
  approve_reason        VARCHAR(200),
  idempotency_key       VARCHAR(80),
  actor_staff_id        INTEGER,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  cancelled_at          TIMESTAMPTZ,
  cancel_reason         VARCHAR(200),
  cancelled_by_staff_id INTEGER,
  CONSTRAINT fk_pdc_doc_same_user      FOREIGN KEY (doc_id, user_id) REFERENCES purchase_doc (id, user_id),
  CONSTRAINT fk_pdc_line_same_user     FOREIGN KEY (line_id, user_id) REFERENCES purchase_doc_line (id, user_id),
  CONSTRAINT fk_pdc_purchase_same_user FOREIGN KEY (purchase_id, user_id) REFERENCES purchase (id, user_id),
  CONSTRAINT fk_pdc_staff_same_owner   FOREIGN KEY (actor_staff_id, user_id) REFERENCES staff_account (id, owner_user_id),
  CONSTRAINT fk_pdc_cstaff_same_owner  FOREIGN KEY (cancelled_by_staff_id, user_id) REFERENCES staff_account (id, owner_user_id),
  CONSTRAINT pdc_mode_chk      CHECK (mode IN ('AUTO', 'MANUAL', 'FORCED')),
  CONSTRAINT pdc_status_chk    CHECK (status IN ('ACTIVE', 'CANCELLED')),
  CONSTRAINT pdc_cancel_match  CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
  CONSTRAINT pdc_active_has_purchase CHECK (status <> 'ACTIVE' OR purchase_id IS NOT NULL),
  CONSTRAINT pdc_forced_reason CHECK (mode <> 'FORCED' OR length(btrim(COALESCE(approve_reason, ''))) >= 2),
  CONSTRAINT pdc_auto_has_trade CHECK (mode <> 'AUTO' OR (trade_id IS NOT NULL AND match_result = 'EXACT')),
  CONSTRAINT pdc_money_chk     CHECK (doc_amount >= 0)
);
COMMENT ON TABLE purchase_doc_conversion IS 'T-203 매입전환 기록(취소해도 행은 남김). AUTO=완전일치 자동, MANUAL=사람 확정(허용오차 안), FORCED=허용오차 밖·근거 없음을 주인이 사유와 함께 확정';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdc_line_active ON purchase_doc_conversion (line_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdc_trade_active ON purchase_doc_conversion (user_id, trade_id) WHERE status = 'ACTIVE' AND trade_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pdc_purchase ON purchase_doc_conversion (purchase_id) WHERE purchase_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pdc_doc ON purchase_doc_conversion (doc_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pdc_user_created ON purchase_doc_conversion (user_id, created_at DESC);

-- ======================================================================
-- 7. 대조 이력(감사) — 추가만. 수정·삭제는 트리거가 막는다
-- ======================================================================
CREATE TABLE IF NOT EXISTS purchase_match_event (
  id              BIGSERIAL     PRIMARY KEY,
  user_id         INTEGER       NOT NULL REFERENCES "user"(id),
  doc_id          BIGINT        NOT NULL,
  line_id         BIGINT,
  event_type      VARCHAR(20)   NOT NULL,
  from_status     VARCHAR(20),
  to_status       VARCHAR(20),
  match_result    VARCHAR(10),
  score           SMALLINT,
  trade_id        BIGINT,
  purchase_id     INTEGER,
  conversion_id   BIGINT,
  run_id          BIGINT,
  reason          VARCHAR(200),
  detail          JSONB         NOT NULL DEFAULT '{}'::jsonb,
  actor_kind      VARCHAR(6)    NOT NULL,
  actor_staff_id  INTEGER,
  idempotency_key VARCHAR(80),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT pme_type_chk  CHECK (event_type IN ('UPLOAD', 'MANUAL_INPUT', 'MATCH', 'AUTO_CONVERT', 'CONVERT', 'MANUAL_CONFIRM', 'FORCE_CONFIRM',
                                                 'REJECT', 'CANCEL', 'CANCEL_VIA_PURCHASE', 'REMATCH', 'LINE_EDIT', 'DOC_CANCEL')),
  CONSTRAINT pme_actor_chk CHECK (actor_kind IN ('OWNER', 'STAFF', 'SYSTEM') AND ((actor_kind = 'STAFF') = (actor_staff_id IS NOT NULL))),
  CONSTRAINT fk_pme_doc_same_user   FOREIGN KEY (doc_id, user_id) REFERENCES purchase_doc (id, user_id),
  CONSTRAINT fk_pme_staff_same_owner FOREIGN KEY (actor_staff_id, user_id) REFERENCES staff_account (id, owner_user_id)
);
COMMENT ON TABLE purchase_match_event IS 'T-203 매입서 대조·전환 이력. 누가(actor)·언제·무엇을(event)·점수·사유·쓴 허용오차(detail.tolerance)·차액(detail.diff). 추가만';
CREATE INDEX IF NOT EXISTS idx_pme_user_created ON purchase_match_event (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pme_doc ON purchase_match_event (doc_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pme_line ON purchase_match_event (line_id, created_at) WHERE line_id IS NOT NULL;

CREATE OR REPLACE FUNCTION purchase_match_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'purchase_match_event 는 추가만 할 수 있습니다 (T-203)';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_pme_append_only ON purchase_match_event;
CREATE TRIGGER trg_pme_append_only BEFORE UPDATE OR DELETE ON purchase_match_event
  FOR EACH ROW EXECUTE FUNCTION purchase_match_event_append_only();

-- ======================================================================
-- 8. 요청 멱등 키 — 같은 키 재요청은 저장된 응답을 그대로 돌려준다. 업무 저장과 같은 트랜잭션에서 INSERT·응답 저장
--    (동시에 같은 키가 오면 뒤 요청의 INSERT 가 앞 트랜잭션 COMMIT 까지 기다린 뒤 충돌 → 저장된 응답 재생)
-- ======================================================================
CREATE TABLE IF NOT EXISTS api_idempotency (
  user_id      INTEGER      NOT NULL REFERENCES "user"(id),
  idem_key     VARCHAR(80)  NOT NULL,
  route        VARCHAR(80)  NOT NULL,
  request_hash CHAR(64)     NOT NULL,
  status_code  SMALLINT,
  response     JSONB,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, idem_key),
  CONSTRAINT api_idem_key_format CHECK (idem_key ~ '^[A-Za-z0-9_-]{8,80}$'),
  CONSTRAINT api_idem_done_match CHECK ((response IS NULL) = (completed_at IS NULL))
);
COMMENT ON TABLE api_idempotency IS 'T-203 Idempotency-Key 기록(7일 보관 — PURGE_RAW 작업이 함께 정리). 같은 키·다른 본문 = 422 IDEMPOTENCY_KEY_REUSED';
CREATE INDEX IF NOT EXISTS idx_api_idempotency_created ON api_idempotency (created_at);

-- ======================================================================
-- 9. 기존 purchase 연결 칸 — 어느 매입서 줄에서 만들어졌는지. 활성 매입 1건만(부분 유일 = 이중 매입 마지막 방어선)
--    기본값 없는 NULL 칸 추가 → 표 다시 쓰기 없음, 기존 행 모두 NULL(영향 없음). 뷰 칸 수는 바꾸지 않는다(025 주의 사항)
-- ======================================================================
ALTER TABLE purchase ADD COLUMN IF NOT EXISTS purchase_doc_line_id BIGINT;
COMMENT ON COLUMN purchase.purchase_doc_line_id IS 'T-203 매입서 줄에서 매입전환으로 만든 매입이면 그 줄 id. 직접 입력 매입은 NULL';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_purchase_doc_line_same_user') THEN
    ALTER TABLE purchase ADD CONSTRAINT fk_purchase_doc_line_same_user
      FOREIGN KEY (purchase_doc_line_id, user_id) REFERENCES purchase_doc_line (id, user_id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_doc_line_active ON purchase (purchase_doc_line_id)
  WHERE purchase_doc_line_id IS NOT NULL AND status = 'active';

-- ======================================================================
-- 10. 헤더 상태 재계산 · 매입 취소 동기화
-- ======================================================================
CREATE OR REPLACE FUNCTION purchase_doc_recalc(p_doc_id BIGINT) RETURNS VARCHAR AS $$
DECLARE
  c RECORD;
  cur VARCHAR(20);
  nxt VARCHAR(20);
BEGIN
  SELECT status INTO cur FROM purchase_doc WHERE id = p_doc_id FOR UPDATE;
  IF cur IS NULL THEN RETURN NULL; END IF;
  SELECT COUNT(*)::int                                        AS total,
         COUNT(*) FILTER (WHERE status = 'CONVERTED')::int    AS conv,
         COUNT(*) FILTER (WHERE status = 'PENDING')::int      AS pend,
         COUNT(*) FILTER (WHERE status = 'HOLD')::int         AS hold,
         COUNT(*) FILTER (WHERE status = 'REJECTED')::int     AS rej,
         COUNT(*) FILTER (WHERE status = 'CANCELLED')::int    AS canc,
         COALESCE(SUM(amount), 0)::bigint                     AS amt
    INTO c FROM purchase_doc_line WHERE doc_id = p_doc_id;
  IF cur = 'CANCELLED' THEN
    nxt := 'CANCELLED';
  ELSE
    nxt := CASE
      WHEN c.total > 0 AND c.rej = c.total           THEN 'REJECTED'
      WHEN c.conv > 0 AND c.pend + c.hold + c.canc = 0 THEN 'CONVERTED'
      WHEN c.conv > 0                                THEN 'PARTIAL_CONVERTED'
      WHEN c.hold + c.canc > 0                       THEN 'HOLD'
      ELSE 'PENDING'
    END;
  END IF;
  UPDATE purchase_doc
     SET status = nxt, line_count = c.total, amount_total = c.amt,
         converted_count = c.conv, pending_count = c.pend, hold_count = c.hold,
         rejected_count = c.rej, cancelled_count = c.canc, updated_at = NOW()
   WHERE id = p_doc_id;
  RETURN nxt;
END $$ LANGUAGE plpgsql;
COMMENT ON FUNCTION purchase_doc_recalc(BIGINT) IS 'T-203 줄 상태 → 헤더 상태·건수. 줄을 바꾼 트랜잭션 끝에서 호출';

-- 매입정보 화면의 기존 매입 취소(POST /api/purchases/:id/cancel, T-103)로 전환 매입이 취소돼도 매입서 쪽이 맞게 따라간다.
-- 이 기능의 취소 API(R-130)는 SET LOCAL app.pdoc_cancel_route = 'on' 을 걸고 자기 이력(CANCEL)을 남기므로 트리거는 이력을 쓰지 않는다.
CREATE OR REPLACE FUNCTION purchase_doc_on_purchase_cancel() RETURNS trigger AS $$
DECLARE
  v_doc BIGINT;
  v_conv BIGINT;
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.purchase_doc_line_id IS NOT NULL THEN
    UPDATE purchase_doc_conversion
       SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = COALESCE(NEW.cancel_reason, '매입 취소')
     WHERE purchase_id = NEW.id AND status = 'ACTIVE'
     RETURNING id INTO v_conv;
    UPDATE purchase_doc_line
       SET status = 'CANCELLED', version = version + 1, updated_at = NOW()
     WHERE id = NEW.purchase_doc_line_id AND status = 'CONVERTED'
     RETURNING doc_id INTO v_doc;
    IF v_doc IS NOT NULL THEN
      PERFORM purchase_doc_recalc(v_doc);
      IF COALESCE(current_setting('app.pdoc_cancel_route', true), '') <> 'on' THEN
        INSERT INTO purchase_match_event (user_id, doc_id, line_id, event_type, from_status, to_status, purchase_id, conversion_id, reason, actor_kind)
        VALUES (NEW.user_id, v_doc, NEW.purchase_doc_line_id, 'CANCEL_VIA_PURCHASE', 'CONVERTED', 'CANCELLED', NEW.id, v_conv,
                LEFT(COALESCE(NEW.cancel_reason, '매입정보에서 매입 취소'), 200), 'SYSTEM');
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_purchase_doc_cancel_sync ON purchase;
CREATE TRIGGER trg_purchase_doc_cancel_sync AFTER UPDATE OF status ON purchase
  FOR EACH ROW WHEN (NEW.purchase_doc_line_id IS NOT NULL)
  EXECUTE FUNCTION purchase_doc_on_purchase_cancel();

-- ======================================================================
-- 11. audit_log 값 목록 넓히기 (025 정의 + 새 값. 기존 행은 모두 새 CHECK 안에 있다)
--     매입서 업로드 한 줄(entity_type purchase_doc, action upload) · 허용오차/연결 설정(match_setting) · 품목 매핑(market_mapping) · 수동 수집(market_sync)
-- ======================================================================
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_type_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_entity_type_chk CHECK (entity_type IN (
  'account', 'auth', 'staff', 'upload', 'migration',
  'purchase_doc', 'match_setting', 'market_mapping', 'market_sync'));
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_chk;
ALTER TABLE audit_log ADD  CONSTRAINT audit_log_action_chk CHECK (action IN (
  'create', 'update', 'login',
  'suspend', 'resume', 'delete', 'password_reset', 'password_set', 'invite',
  'upload', 'migrate', 'rollback',
  'cancel', 'sync'));

-- 확인 SQL (I·C 검토용 — 이 파일은 실행하지 않음). 모두 0행이어야 한다 (AC-30)
-- ① 한 줄에 활성 매입 2건:  SELECT purchase_doc_line_id FROM purchase WHERE purchase_doc_line_id IS NOT NULL AND status='active' GROUP BY 1 HAVING COUNT(*) > 1;
-- ② 전환 기록과 매입 상태 불일치:
--    SELECT c.id FROM purchase_doc_conversion c JOIN purchase p ON p.id = c.purchase_id
--     WHERE (c.status = 'ACTIVE') <> (p.status = 'active');
-- ③ CONVERTED 줄인데 활성 전환 없음: SELECT l.id FROM purchase_doc_line l WHERE l.status='CONVERTED'
--     AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.line_id = l.id AND c.status='ACTIVE');
-- ④ 헤더 건수 불일치: SELECT d.id FROM purchase_doc d JOIN (SELECT doc_id, COUNT(*) n FROM purchase_doc_line GROUP BY 1) x ON x.doc_id = d.id WHERE x.n <> d.line_count;
