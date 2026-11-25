-- 029 T-203 후속(2026-11-25): 운영(무료 DB) 경락 보관 기간 AUCTION_TRADE_KEEP_DAYS 용 인덱스. 026·027·028 은 고치지 않는다
-- 목적: PURGE_RAW 가 오래된 경락을 지울 때
--   ① "매입서 근거로 쓰인 경락인가"(줄 최적 후보·후보·매입전환·대조 이력) 확인이 표 전체를 훑지 않게
--   ② 경락을 지울 때 외래키 검사(후보·전환·줄 → 경락)가 행마다 표 전체를 훑지 않게
--   ③ 아무도 안 가리키는 옛 스냅샷을 찾을 때(경락·이전 값 이력·품목별 가격 → 스냅샷) 표 전체를 훑지 않게
-- 재실행 안전: IF NOT EXISTS. migrate.js 가 트랜잭션으로 감싼다(CONCURRENTLY 안 씀).
-- 영향: 기존 데이터 변경 없음. 인덱스 생성 중 해당 표 쓰기를 잠깐 막는다.
-- 이력 표 auction_trade_history(trade_id) 는 UNIQUE (trade_id, revision) 이 이미 있다.

CREATE INDEX IF NOT EXISTS idx_pdl_best_trade   ON purchase_doc_line (best_trade_id)         WHERE best_trade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pmc_trade        ON purchase_match_candidate (trade_id);
CREATE INDEX IF NOT EXISTS idx_pdc_trade        ON purchase_doc_conversion (trade_id)        WHERE trade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pme_trade        ON purchase_match_event (trade_id)           WHERE trade_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_auction_trade_snapshot ON auction_trade (snapshot_id);
CREATE INDEX IF NOT EXISTS idx_ath_snapshot     ON auction_trade_history (snapshot_id)       WHERE snapshot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mpd_snapshot     ON market_price_daily (snapshot_id)          WHERE snapshot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mpd_price_date   ON market_price_daily (price_date);

-- 되돌리기(필요할 때만 수동 실행):
--   DROP INDEX IF EXISTS idx_pdl_best_trade, idx_pmc_trade, idx_pdc_trade, idx_pme_trade,
--                        idx_auction_trade_snapshot, idx_ath_snapshot, idx_mpd_snapshot, idx_mpd_price_date;
