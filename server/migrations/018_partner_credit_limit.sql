-- 018 (2026-11-20, T-207): 거래처 외상 한도 (기능 제안 P12)
--  - account.credit_limit : 이 거래처에 외상(미수)으로 둘 수 있는 최대 금액. NULL = 한도 없음(기본, 기존 거래처 모두)
--  - 0 은 "외상 없음" — 미수가 조금이라도 생기면 경고한다
--  - 판매(매출 전환·재고 판매)·매출 수정 저장 후 미수 > 한도이면 서버가 409 CREDIT_LIMIT 로 알리고,
--    사용자가 확인(credit_confirmed=true)하면 저장한다(막지 않음 — 경고 후 저장). 미수 = receivables_by_partner 뷰(012)
--  - 017 번호는 T-211(목록 검색·페이지)용으로 비워 둔다
--
-- 다시 실행해도 안전: IF NOT EXISTS, 제약은 이름으로 확인 후 한 번만 추가.
-- 적용 시간: 기본값 없는 NULL 열 추가(표 재작성 없음) + CHECK 추가(기존 행 모두 NULL 이라 바로 통과).

ALTER TABLE account ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(14, 2);
COMMENT ON COLUMN account.credit_limit IS '외상 한도(원). NULL=한도 없음, 0=외상 없음. 저장 후 미수가 넘으면 경고(T-207)';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_credit_limit_chk' AND conrelid = 'account'::regclass) THEN
    ALTER TABLE account ADD CONSTRAINT account_credit_limit_chk CHECK (credit_limit IS NULL OR credit_limit >= 0);
  END IF;
END $$;
