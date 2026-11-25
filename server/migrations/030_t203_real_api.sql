-- 030 T-203 실 API 전환 (B 20261125-1327 — I 20261125-1310 초안 + A 20261125-1319 7절 추가 3건). 026·027·028·029 는 고치지 않는다
-- 근거: 실데이터 가락 2026-11-24 고추·파프리카·피망 2,009행 실측(산출물/I_실API_DB.md, 재현 I_실API_재현/01~05)
--
-- 목적
--  ① 실 API(katRealTime2/trades2) 응답에 있는데 경락 표에 칸이 없는 값 보관:
--     출하번호(spm_no)·매매방법(trd_se)·법인 품목코드·이름(corp_gds_*)·대/중분류 이름·원천 수정일시(mdfcn_dt)
--  ② 실데이터 자연키를 DB 가 지키게: auctn_seq 는 법인마다 뜻이 달라(농협가락·동화·한국청과는 출하 건 안 순번 10·20·…)
--     auctn_seq 단독 1,025행·법인까지 넣어도 1,021행 중복 → (시장, 정산일, 법인, 출하번호, 경매순번) 은 0 중복
--  ③ item_mapping 에 "제외(IGNORE)" 규칙을 둘 수 있게: 지금은 item_key NOT NULL 이라 고추잎·건고추·피망을
--     "매핑 안 함"으로 적을 방법이 없고, 키워드 '고추'(시드)에 걸려 PEPPER._(품종 모름)로 들어가 모든 고추 줄의 후보가 된다
--  (분류 코드 매핑 시드는 별도 초안 I_030_seed_draft.sql — 결정 필요 항목이 있어 마이그레이션에서 뺌)
--
-- 원칙: 칸 추가·제약 완화 + 새 행에만 걸리는 CHECK(기존 행은 shipment_no NULL 이라 통과). 기존 행·기존 테스트 기대값 변경 없음. 재실행 안전(IF NOT EXISTS / 존재 확인 DO 블록 / ON CONFLICT).
--       migrate.js 가 파일 하나를 트랜잭션 하나로 감싼다 → BEGIN/COMMIT 없음. CHECK 추가 때 auction_trade 전체를 한 번 읽어 검사한다(73만 행 1초 미만 — 03 실측), 수집 시간대는 피해서 배포.
-- 영향: auction_trade 칸 8개 추가(모두 NULL 허용, 기본값 없음 → 표 재작성 없음, 즉시 끝남).
--       item_mapping.item_key NOT NULL 해제 + action 칸(기본 'MAP') — 기존 26행은 모두 'MAP' 이고 item_key 가 있어 새 CHECK 통과.

-- ======================================================================
-- ① 경락 표 칸 추가
-- ======================================================================
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS shipment_no        VARCHAR(20);   -- spm_no (실측 4~15자리, 법인마다 체계 다름 → 문자열 그대로, 앞자리 0 보존)
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS trade_type         VARCHAR(20);   -- trd_se 원문 (실측 '경매' 1,968 · '정가수의' 41)
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS corp_item_code     VARCHAR(20);   -- corp_gds_cd (법인 자체 품목코드, 실측 최대 12자)
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS corp_item_name     VARCHAR(50);   -- corp_gds_item_nm (예: 생고추·피망)
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS corp_variety_name  VARCHAR(50);   -- corp_gds_vrty_nm (예: 오이맛고추·홍피망) — 매입서 품목명 대조 보조
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS item_l_name        VARCHAR(50);   -- gds_lclsf_nm
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS item_m_name        VARCHAR(50);   -- gds_mclsf_nm
ALTER TABLE auction_trade ADD COLUMN IF NOT EXISTS source_modified_at TIMESTAMPTZ;   -- mdfcn_dt (KST 표기 → +09:00). 명세 밖 칸. 실측상 aT 적재 배치 시각(약 20분 간격)
COMMENT ON COLUMN auction_trade.shipment_no IS 'T-203 030: 출하번호(spm_no). 실 API 자연키 일부 — (market_code, trade_date, corp_code, shipment_no, auction_seq)';
COMMENT ON COLUMN auction_trade.auction_seq IS 'T-203: 경매순번(auctn_seq) 원문 문자열. 법인마다 뜻이 다름(서울청과·중앙청과=하루 유일 번호, 농협가락·동화·한국청과=출하 건 안 순번). 숫자로 바꾸지 말 것(앞자리 0)';
COMMENT ON COLUMN auction_trade.source_modified_at IS 'T-203 030: 원천 수정일시(mdfcn_dt). 더 오래된 값으로 덮어쓰지 않는 기준. content_hash 에는 넣지 않음';
COMMENT ON COLUMN auction_trade.trade_type IS 'T-203 030: 매매방법(trd_se) 원문 — 경매·정가수의 등. 대조 조건에는 쓰지 않고 화면 표시·분석용';

-- ======================================================================
-- ② 실 API 자연키 — DB 가 중복을 막는다(코드가 source_row_key 를 잘못 만들어도 같은 경락이 두 행 되지 않게)
--    방법: 별도 유일 인덱스 대신 CHECK "source_row_key = 시장|정산일|법인|출하번호|경매순번" → 기존 ux_auction_trade_source_key 가
--    곧 자연키 유일. (유일 인덱스를 따로 두면 365일 73만 행에서 60.6MB·행당 87B 더 듦 — 04 실측)
--    날짜는 to_char 로 고정(DateStyle 영향 없음). || 는 NULL 이면 NULL → 법인·순번 NOT NULL 을 같이 요구
--    MOCK·기존 행은 shipment_no 가 NULL 이라 대상 아님
-- ======================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'auction_trade_at_natural_key') THEN
    ALTER TABLE auction_trade ADD CONSTRAINT auction_trade_at_natural_key CHECK (
      source <> 'AT_REALTIME' OR shipment_no IS NULL
      OR (corp_code IS NOT NULL AND auction_seq IS NOT NULL
          AND source_row_key = market_code || '|' || to_char(trade_date, 'YYYY-MM-DD') || '|' || corp_code || '|' || shipment_no || '|' || auction_seq));
  END IF;
END $$;

-- ======================================================================
-- ③ item_mapping: 제외(IGNORE) 규칙
--    action = 'MAP'    → item_key 필수 (지금과 같음)
--    action = 'IGNORE' → item_key 없음. 정규화는 map_status = 'IGNORED'(경락 화면 기본 목록·대조 후보에서 빠짐, 행은 보관)
-- ======================================================================
ALTER TABLE item_mapping ADD COLUMN IF NOT EXISTS action VARCHAR(10) NOT NULL DEFAULT 'MAP';
ALTER TABLE item_mapping ALTER COLUMN item_key DROP NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_mapping_action_chk') THEN
    ALTER TABLE item_mapping ADD CONSTRAINT item_mapping_action_chk CHECK (action IN ('MAP', 'IGNORE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_mapping_action_key') THEN
    ALTER TABLE item_mapping ADD CONSTRAINT item_mapping_action_key CHECK ((action = 'MAP') = (item_key IS NOT NULL));
  END IF;
  -- 제외는 코드 규칙에만(키워드 제외는 매입서 줄 품목명까지 막아 버려 위험)
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'item_mapping_ignore_code_only') THEN
    ALTER TABLE item_mapping ADD CONSTRAINT item_mapping_ignore_code_only CHECK (action = 'MAP' OR code_m IS NOT NULL);
  END IF;
END $$;
COMMENT ON COLUMN item_mapping.action IS 'T-203 030: MAP=item_key 로 매핑, IGNORE=수집은 하되 IGNORED(대조 후보 제외). IGNORE 는 코드 규칙만';

-- ======================================================================
-- ④ (A 7-4) 매입서 줄 출하번호 — m2 R1 식별 근거(출하번호+경매번호). 업로드 양식 선택 칸 "출하번호"
-- ======================================================================
ALTER TABLE purchase_doc_line ADD COLUMN IF NOT EXISTS shipment_ref VARCHAR(20);
COMMENT ON COLUMN purchase_doc_line.shipment_ref IS 'T-203 030: 매입서에 적힌 출하번호(선택). 실 API 경락 shipment_no 와 같으면 경매번호와 함께 식별 근거(m2 R1)';

-- ======================================================================
-- ⑤ (A 7-5) 유일 후보 자동 스위치 — m2 R3(식별 근거 없는 줄도 후보가 정확히 1건이면 자동). 기본 켬 = U-03 기본값
-- ======================================================================
ALTER TABLE match_tolerance ADD COLUMN IF NOT EXISTS auto_unique_no_id BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN match_tolerance.auto_unique_no_id IS 'T-203 030: 실 API 경락에 식별 근거(경매번호·낙찰자)가 없을 때 유일 후보를 자동 전환할지(m2 R3). U-03 기본값 = true';

-- ======================================================================
-- ⑥ (A 7-6) 법인 5곳 + 순번 성격 — code_master(corp).extra.seq_daily_unique
--    true = 경매순번이 하루 안에서 유일(서울청과·중앙청과), false = 출하 건 안 순번(농협가락·동화·한국청과) — 실측 I 01
--    이미 CODE_SYNC 로 받은 행이 있으면 이름은 두고 extra 에 키만 더한다(재실행 안전)
-- ======================================================================
INSERT INTO code_master (code_type, code, name, parent_code, extra) VALUES
  ('corp', '11000101', '서울청과㈜',   '110001', '{"seq_daily_unique": true}'::jsonb),
  ('corp', '11000102', '농협가락(공)', '110001', '{"seq_daily_unique": false}'::jsonb),
  ('corp', '11000103', '㈜중앙청과',   '110001', '{"seq_daily_unique": true}'::jsonb),
  ('corp', '11000104', '동화청과㈜',   '110001', '{"seq_daily_unique": false}'::jsonb),
  ('corp', '11000105', '한국청과㈜',   '110001', '{"seq_daily_unique": false}'::jsonb)
ON CONFLICT (code_type, code) DO UPDATE
  SET extra = code_master.extra || jsonb_build_object('seq_daily_unique', (EXCLUDED.extra->>'seq_daily_unique')::boolean)
  WHERE NOT (code_master.extra ? 'seq_daily_unique');

-- ======================================================================
-- ⑦ 분류 코드 매핑 시드는 이 파일에 넣지 않는다 → server/scripts/seed-at-realtime-mapping.sql
--    이유: A_DDL/constraints.js 가 item_mapping 26행을 기대하고, U-07b·19·20·21·22a 가 사용자 결정 대기(A 8절)
-- ======================================================================

-- 확인 SQL (모두 0행이어야)
-- ① 실 API 자연키 중복: SELECT market_code, trade_date, corp_code, shipment_no, auction_seq FROM auction_trade WHERE source='AT_REALTIME' AND shipment_no IS NOT NULL GROUP BY 1,2,3,4,5 HAVING COUNT(*)>1;
-- ② 제외 규칙인데 품목 있음: SELECT id FROM item_mapping WHERE (action='MAP') <> (item_key IS NOT NULL);

-- 되돌리기(필요할 때만 수동 — IGNORE 행이 있으면 먼저 지워야 NOT NULL 복구 가능):
--   DELETE FROM item_mapping WHERE action = 'IGNORE';
--   ALTER TABLE item_mapping DROP CONSTRAINT IF EXISTS item_mapping_ignore_code_only, DROP CONSTRAINT IF EXISTS item_mapping_action_key,
--                            DROP CONSTRAINT IF EXISTS item_mapping_action_chk, DROP COLUMN IF EXISTS action;
--   ALTER TABLE item_mapping ALTER COLUMN item_key SET NOT NULL;
--   ALTER TABLE auction_trade DROP CONSTRAINT IF EXISTS auction_trade_at_natural_key;
--   ALTER TABLE auction_trade DROP COLUMN IF EXISTS shipment_no, DROP COLUMN IF EXISTS trade_type, DROP COLUMN IF EXISTS corp_item_code,
--     DROP COLUMN IF EXISTS corp_item_name, DROP COLUMN IF EXISTS corp_variety_name, DROP COLUMN IF EXISTS item_l_name,
--     DROP COLUMN IF EXISTS item_m_name, DROP COLUMN IF EXISTS source_modified_at;
--   ALTER TABLE purchase_doc_line DROP COLUMN IF EXISTS shipment_ref;
--   ALTER TABLE match_tolerance DROP COLUMN IF EXISTS auto_unique_no_id;
--   UPDATE code_master SET extra = extra - 'seq_daily_unique' WHERE code_type = 'corp';
