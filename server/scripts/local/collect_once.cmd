@echo off
rem T-203 판매툴 경락 단독 수집 1회 — Windows 작업 스케줄러용 래퍼(초안). 지휘 AI 가 C:\SalesToolDB\collect_once.cmd 로 복사해 쓴다.
rem  - 서버·화면을 띄우지 않고 DB 확인 → (없으면 잠깐 켜고) 수집 tick 반복 → 자기가 켠 DB 만 끈다. 자세한 규칙은 server\scripts\collect_once.js 머리말
rem  - API 키 등은 C:\SalesToolDB\local.env 에서 읽는다(이 파일에는 비밀값을 적지 않는다)
rem  - APP 은 판매툴_로컬_시작.cmd(start_local.mjs) 가 쓰는 앱 폴더와 같게 맞춘다
chcp 65001 >nul
setlocal
set "APP=C:\Users\user\Desktop\이건우\개인\SalesTool-wt\garak-int\server"
rem 로컬 영구 DB(pg_local.mjs 와 같은 포트·계정). local.env 에 DATABASE_URL 이 있으면 그 값이 먼저다
if not defined DATABASE_URL set "DATABASE_URL=postgresql://postgres:pw@127.0.0.1:5433/sales_tool"
set "COLLECT_ONCE_PG_DIR=C:/SalesToolDB/data"
set "COLLECT_ONCE_LOG=C:/SalesToolDB/logs/collect_once.log"
if not exist "C:\SalesToolDB\logs" mkdir "C:\SalesToolDB\logs"
cd /d "%APP%" || exit /b 1
node scripts\collect_once.js >> "C:\SalesToolDB\logs\collect_once_console.log" 2>&1
exit /b %ERRORLEVEL%
