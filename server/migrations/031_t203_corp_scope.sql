-- 031 T-203 수집 대상 법인 한정(AUCTION_CORP_CODES) — B 20261125-1506. 026~030 은 고치지 않는다
--
-- 목적: 법인 한정 수집(예: 한국청과 11000105 만)으로 끝난 스냅샷을 "그날 전체 수집 완료"로 잘못 보지 않게
--       스냅샷에 그 수집이 어떤 법인 범위였는지 남긴다.
--   corp_scope NULL         = 법인 조건 없이 전체 수집(기존 행 전부 — 의미 그대로)
--   corp_scope '11000105'   = 그 법인만. 여러 개면 정렬해 쉼표로 잇는다('11000101,11000105')
-- 쓰는 곳: 스케줄러 hasFinalOk·수동 동기화 ALREADY_COMPLETE(현재 설정 범위를 덮는 스냅샷만 완료로 봄),
--          대조 기준 준비(매입서 법인이 범위 밖이면 기준 데이터 준비 전), 수집 현황 API(관리자만)
-- 원칙: 칸 추가만(NULL 허용, 기본값 없음 → 표 재작성 없음, 즉시 끝남). 기존 행·기존 테스트 기대값 변경 없음. 재실행 안전.
--       migrate.js 가 파일 하나를 트랜잭션 하나로 감싼다 → BEGIN/COMMIT 없음.

ALTER TABLE collect_snapshot ADD COLUMN IF NOT EXISTS corp_scope VARCHAR(200);
COMMENT ON COLUMN collect_snapshot.corp_scope IS 'T-203 수집 대상 법인 범위(AUCTION_CORP_CODES 정렬·쉼표). NULL = 전체 법인. 법인 한정 스냅샷은 그 범위 안에서만 완결';
