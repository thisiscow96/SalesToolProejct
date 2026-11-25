-- 032 T-203: 원표번호 검색 인덱스 + 경락 조회 → 매입 전환(기존 매입서 경로 재사용, input_kind='AUCTION')
-- 근거: 산출물/A_원표검색_정렬_매입전환_설계.md 3.1·3.6(D-1~D-4), 산출물/I_전환_DB검토.md 2.3·I_032_draft.sql ①, PM 결정 16:18(A안 — I 초안 ②~④ 제외)
--
-- 무엇을
--  ① 원표번호(auction_trade.shipment_no) 검색용 B-tree 1개 (I 초안 ① 그대로). 서버는 앞자리 0 을 무시한 정확 일치를
--     `t.shipment_no = ANY(<0 을 붙인 후보 목록>)` 으로 풀어 이 인덱스를 그대로 탄다(lib/auction/trade-query.js).
--  ② 매입서 종류에 'AUCTION'(경락 조회에서 직접 전환할 때 서버가 만드는 매입서) 추가 — 업로드 파일 없음(D-1·D-2)
--  ③ 대조 이력 종류에 'CONVERT_FROM_TRADE' 추가(D-3)
-- 이중 전환 0: 기존 ux_pdc_trade_active (user_id, trade_id) WHERE ACTIVE 가 매입서 경로·직접 전환 경로를 함께 막는다(두 경로 모두 줄이 있으므로 line_id NULL 행은 생기지 않음).
-- 재실행 안전: IF NOT EXISTS / pg_get_constraintdef 확인. migrate.js 가 파일 하나를 트랜잭션으로 감싼다. 기존 행 값은 바뀌지 않는다(CHECK 를 넓히기만 함).

-- ① 원표번호 검색
CREATE INDEX IF NOT EXISTS idx_auction_trade_shipment ON auction_trade (shipment_no varchar_pattern_ops, trade_date)
  WHERE shipment_no IS NOT NULL;

-- ② 매입서 종류 AUCTION
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_doc_kind_chk' AND pg_get_constraintdef(oid) LIKE '%AUCTION%') THEN
    ALTER TABLE purchase_doc DROP CONSTRAINT IF EXISTS purchase_doc_kind_chk;
    ALTER TABLE purchase_doc ADD CONSTRAINT purchase_doc_kind_chk CHECK (input_kind IN ('EXCEL', 'CSV', 'MANUAL', 'AUCTION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_doc_upload_need' AND pg_get_constraintdef(oid) LIKE '%AUCTION%') THEN
    ALTER TABLE purchase_doc DROP CONSTRAINT IF EXISTS purchase_doc_upload_need;
    ALTER TABLE purchase_doc ADD CONSTRAINT purchase_doc_upload_need CHECK ((input_kind IN ('MANUAL', 'AUCTION')) = (upload_id IS NULL));
  END IF;
END $$;
COMMENT ON COLUMN purchase_doc.input_kind IS 'EXCEL·CSV=파일 업로드, MANUAL=화면 입력, AUCTION=T-203 032 경락 조회에서 체크한 건을 서버가 (거래처, 경락일)별로 묶어 만든 매입서(업로드 없음)';

-- ③ 대조 이력 종류 CONVERT_FROM_TRADE
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pme_type_chk' AND pg_get_constraintdef(oid) LIKE '%CONVERT_FROM_TRADE%') THEN
    ALTER TABLE purchase_match_event DROP CONSTRAINT IF EXISTS pme_type_chk;
    ALTER TABLE purchase_match_event ADD CONSTRAINT pme_type_chk CHECK (event_type IN ('UPLOAD', 'MANUAL_INPUT', 'MATCH', 'AUTO_CONVERT', 'CONVERT', 'MANUAL_CONFIRM', 'FORCE_CONFIRM',
      'REJECT', 'CANCEL', 'CANCEL_VIA_PURCHASE', 'REMATCH', 'LINE_EDIT', 'DOC_CANCEL', 'CONVERT_FROM_TRADE'));
  END IF;
END $$;

-- 되돌리기 (AUCTION 매입서·CONVERT_FROM_TRADE 이력이 하나도 없을 때만)
--   DROP INDEX IF EXISTS idx_auction_trade_shipment;
--   ALTER TABLE purchase_doc DROP CONSTRAINT purchase_doc_kind_chk, ADD CONSTRAINT purchase_doc_kind_chk CHECK (input_kind IN ('EXCEL', 'CSV', 'MANUAL'));
--   ALTER TABLE purchase_doc DROP CONSTRAINT purchase_doc_upload_need, ADD CONSTRAINT purchase_doc_upload_need CHECK ((input_kind = 'MANUAL') = (upload_id IS NULL));
--   ALTER TABLE purchase_match_event DROP CONSTRAINT pme_type_chk, ADD CONSTRAINT pme_type_chk CHECK (event_type IN (027 의 원래 13개));
