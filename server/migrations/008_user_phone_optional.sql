-- 2026-11-20: 가입 본인 확인을 이메일 인증만으로 — 휴대폰번호는 선택 항목
-- 기존 회원의 번호는 그대로 두고, UNIQUE는 유지(값이 있으면 중복 불가, NULL은 여러 개 가능)
ALTER TABLE "user" ALTER COLUMN phone DROP NOT NULL;
