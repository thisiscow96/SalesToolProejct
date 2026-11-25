#!/bin/bash
# T-203 새 화면 실서버 e2e 전부 — 종료 코드 0 = 기대대로, 1 = 실패(결함), 2 = 스크립트 오류
# 전제: 로컬 테스트 DB(마이그레이션 001~027 + seed-admin·sample·transactions) + 서버(AUCTION_SOURCE_MODE=mock, AUCTION_MOCK_CONTROL=true, ALLOW_MOCK_CONVERT=true)
#       + vite(프록시 → 서버). 먼저 setup.cjs 를 한 번 돌린다(새 DB 권장 — 시나리오가 목업 경락을 소비함).
# 사용: WEB=http://localhost:5182 DATABASE_URL=<로컬> COLLECT_TRIGGER_TOKEN=<서버와 같음> bash run_all.sh   (W=390 이면 휴대폰 폭)
# defects/D*.cjs 는 결함 재현(rc 1 = 아직 재현됨, rc 0 = 고쳐짐)
cd "$(dirname "$0")"
export WEB=${WEB:-http://localhost:5182}
mkdir -p results
for f in S0*.cjs; do
  node "$f" > "results/${f%.cjs}_${W:-1366}.log" 2>&1; rc=$?
  echo "rc=$rc  $f  $(grep '^== ' "results/${f%.cjs}_${W:-1366}.log" | tail -1)"
done
if [ -z "$SKIP_DEFECTS" ]; then
  for f in defects/D*.cjs; do
    b=$(basename "$f" .cjs); node "$f" > "results/${b}.log" 2>&1; rc=$?
    echo "rc=$rc  $f  $(grep '"actual"' "results/${b}.log" | head -1)"
  done
fi
