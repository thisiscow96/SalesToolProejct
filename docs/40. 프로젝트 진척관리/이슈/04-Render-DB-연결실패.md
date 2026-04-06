# 이슈 4 — Render — DB 연결 실패 (마이그레이션 실패)

**등록날짜:** 2026-03-13

---

- **무슨 이슈였는지 (현상)**  
  Web Service 배포 시 `[migrate] DB 연결 실패:` 후 Exited with status 1.
- **이슈 원인**  
  External Database URL 사용. Render 내부 통신에는 Internal Database URL 필요. 또는 Postgres를 Web Service에 연결하지 않아 `DATABASE_URL` 미주입. Render Postgres SSL URL인데 마이그레이션 스크립트에서 SSL 옵션 미처리.
- **조치 방법**  
  Postgres Info 탭에서 Internal Database URL 복사 후 Web Service Environment에 `DATABASE_URL` 설정. 또는 Connect existing resource로 Postgres 연결해 자동 주입. 마이그레이션 스크립트에서 `render.com` 호스트 또는 `sslmode` 존재 시 `ssl: { rejectUnauthorized: false }` 적용.
- **교훈**  
  PaaS에서 DB 연결 시 Internal vs External URL 구분과 리소스 연결 절차를 문서에 명시할 것.
