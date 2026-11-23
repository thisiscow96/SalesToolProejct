#!/bin/bash
# T-302 화면 조작 결함 재현 — 전부 실행. 종료 코드 0 = 기대대로(고쳐짐), 1 = 결함 재현, 2 = 스크립트 오류
# 전제: 로컬 테스트 DB + 서버(PORT=3000) + vite(5506, localhost). 운영 주소 금지(lib.cjs 가 막음)
# 사용: bash run_all.sh            (1366 폭)   /   W=390 bash run_all.sh   (휴대폰 폭)
# B 가 고친 뒤: 모든 줄이 rc=0 이면 통과. D07·P01·P02·D16 은 여러 화면을 한 번에 본다.
# T-404(B): C 증거 폴더에서 web/e2e/t302 로 옮김. D18(품목 추가)·D19(직원 비밀번호 화면)는 B 가 추가(C302-21·22).
# playwright-core 위치는 PLAYWRIGHT_CORE 로 바꿀 수 있다(기본 C:/Users/user/pgtest/node_modules/playwright-core). D12 는 하루 3번까지.
cd "$(dirname "$0")"
export WEB=${WEB:-http://localhost:5506}
for f in D*.cjs P*.cjs; do
  node "$f" > "results/${f%.cjs}_${W:-1366}.log" 2>&1; rc=$?
  echo "rc=$rc  $f"
done
