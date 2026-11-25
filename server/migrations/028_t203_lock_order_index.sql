-- 028 T-203 DB 검토 반영(I 검토 2026-11-25 초안 → B 확정). 026·027 은 고치지 않는다
-- 목적: ① 매입 취소 트리거의 잠금 순서를 "매입서 → 줄"로 (대조·전환과 같은 순서 → 교착 제거, I 검토 D-03)
--       ② PURGE_RAW 가 원천 로그를 지울 때 경락 raw_ref ON DELETE SET NULL 이 표 전체를 훑지 않게 인덱스 (D-04)
--       ③ 같은 칸 순서의 중복 인덱스 정리 (D-08)
-- 재실행 안전: IF NOT EXISTS / IF EXISTS / CREATE OR REPLACE. migrate.js 가 트랜잭션으로 감싼다.
-- 영향: 기존 데이터 변경 없음. 인덱스 생성은 표 쓰기를 잠깐 막는다(경락 30만 행 기준 수 초 — 지금 규모에서는 1초 미만).

-- ① 트리거: 줄을 바꾸기 전에 매입서 행을 먼저 잠근다
CREATE OR REPLACE FUNCTION purchase_doc_on_purchase_cancel() RETURNS trigger AS $$
DECLARE
  v_doc BIGINT;
  v_conv BIGINT;
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled' AND NEW.purchase_doc_line_id IS NOT NULL THEN
    SELECT doc_id INTO v_doc FROM purchase_doc_line WHERE id = NEW.purchase_doc_line_id;
    PERFORM 1 FROM purchase_doc WHERE id = v_doc FOR UPDATE;            -- 028: 매입서 먼저(대조 R-124·전환·취소 R-131 과 같은 순서)
    UPDATE purchase_doc_conversion
       SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = COALESCE(NEW.cancel_reason, '매입 취소')
     WHERE purchase_id = NEW.id AND status = 'ACTIVE'
     RETURNING id INTO v_conv;
    v_doc := NULL;
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

-- ② 원천 로그 삭제 → 경락 raw_ref SET NULL 이 인덱스를 타게
CREATE INDEX IF NOT EXISTS idx_auction_trade_raw_ref ON auction_trade (raw_ref) WHERE raw_ref IS NOT NULL;

-- ③ ux_pdl_doc_line(doc_id, line_no) UNIQUE 와 같은 인덱스
DROP INDEX IF EXISTS idx_pdl_doc;

-- 되돌리기(필요할 때만 수동 실행):
--   DROP INDEX IF EXISTS idx_auction_trade_raw_ref;
--   CREATE INDEX IF NOT EXISTS idx_pdl_doc ON purchase_doc_line (doc_id, line_no);
--   027_purchase_doc_match.sql 10절의 purchase_doc_on_purchase_cancel() 정의를 다시 실행(CREATE OR REPLACE)
