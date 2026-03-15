# 환경 변수 설정

환경별로 설정하는 변수 목록입니다. **실제 비밀번호·API 키는 문서에 넣지 말고**, 각 서비스 대시보드에서만 입력하세요.

---

## 1. 로컬 (개발용)

### 백엔드 — `server/.env`

| 변수명 | 설명 | 예시 값 (실제 값은 직접 입력) |
|--------|------|------------------------------|
| `PORT` | 서버 포트 | `3000` |
| `DATABASE_URL` | PostgreSQL 연결 URL | `postgresql://postgres:비밀번호@localhost:5432/sales_tool` |
| `SMTP_HOST` | Gmail SMTP (로컬에서 메일 테스트 시) | `smtp.gmail.com` |
| `SMTP_PORT` | SMTP 포트 | `587` 또는 `465` |
| `SMTP_USER` | Gmail 주소 | `your@gmail.com` |
| `SMTP_PASS` | Gmail 앱 비밀번호 | (16자리 앱 비밀번호) |
| `SMTP_FROM` | 발신 이메일 | `your@gmail.com` |
| `RESEND_API_KEY` | (선택) Resend 사용 시 | `re_xxxx...` |
| `RESEND_FROM` | (선택) Resend 발신 주소 | `onboarding@resend.dev` 또는 `noreply@garaksalestool.com`(도메인 인증 시) |

- 로컬에서는 `.env` 파일만 사용. **Git에 커밋하지 말 것** (`.gitignore`에 포함됨).

---

## 2. Render (백엔드 + DB)

### Web Service — Environment

| 변수명 | 설명 | 설정 방법 |
|--------|------|-----------|
| `DATABASE_URL` | Postgres 연결 URL | Postgres 서비스 **Info** → **Internal Database URL** 복사 후 붙여넣기. 또는 **Connect existing resource** 로 Postgres 연결 시 자동 주입. |
| `PORT` | (선택) Render가 지정할 수 있음 | 보통 생략 가능 |
| `RESEND_API_KEY` | Resend API 키 | https://resend.com → API Keys에서 생성 후 복사 |
| `RESEND_FROM` | Resend 발신 주소 | 테스트: `onboarding@resend.dev`. 실서비스: Resend에 도메인 인증 후 `noreply@garaksalestool.com` |
| `SMTP_HOST` | (선택) 로컬용 SMTP 대비 | Render에서는 SMTP 막혀 있어 사용 안 함. Resend 사용 권장. |
| `SMTP_PORT` | (선택) | `587` |
| `SMTP_USER` | (선택) | Gmail 주소 |
| `SMTP_PASS` | (선택) | Gmail 앱 비밀번호 |
| `SMTP_FROM` | (선택) | 발신 이메일 |

- **반드시** `DATABASE_URL`(Internal), `RESEND_API_KEY`, `RESEND_FROM` 설정.
- Root Directory: `server`, Start Command: `npm run migrate && npm start`.

### Postgres 서비스

- Render가 자동으로 `DATABASE_URL`(Internal/External) 제공. Web Service에는 **Internal Database URL** 을 쓰거나, 리소스 연결로 자동 주입.

---

## 3. Vercel (프론트엔드)

### Project — Settings — Environment Variables

| 변수명 | 설명 | 예시 값 |
|--------|------|---------|
| `VITE_API_URL` | 백엔드 API 기준 URL (끝에 `/` 없이) | 커스텀 도메인 사용 시: `https://garaksalestool.com` / 미사용 시: `https://salestoolproejct.onrender.com` |

- 설정 후 **Redeploy** 해야 빌드에 반영됨.
- `garaksalestool.com` 으로 접속할 때 API도 같은 도메인으로 쓰려면 `VITE_API_URL` = `https://garaksalestool.com` 로 두면 됨.
- `vercel.json` 에서 `/api` rewrite 로 같은 URL 쓰는 경우, rewrite만 맞춰도 동작하지만 `VITE_API_URL` 이 있으면 클라이언트가 직접 해당 URL로 요청함.

---

## 4. 요약

| 환경 | 필수 변수 | 비고 |
|------|-----------|------|
| 로컬 (server) | `DATABASE_URL`, (이메일 테스트 시 SMTP_* 또는 RESEND_*) | `server/.env` |
| Render (Web Service) | `DATABASE_URL`, `RESEND_API_KEY`, `RESEND_FROM` | Internal URL 사용. 실서비스 시 `RESEND_FROM` = `noreply@garaksalestool.com` |
| Vercel | `VITE_API_URL` | 커스텀 도메인 사용 시 `https://garaksalestool.com`, Redeploy 필요 |

실제 비밀번호·API 키·DB URL은 위 예시가 아닌 **본인 계정에서 발급·복사한 값**을 각 서비스에 직접 입력하세요.

---

## 5. garaksalestool.com (프로덕션 도메인) 기준 정리

- **사이트 접속**: Vercel에 도메인 연결 완료 시 `https://garaksalestool.com` 으로 접속.
- **가비아 DNS** (총 4개):
  - **Vercel용 1개**: A `@` → `216.198.79.1` (사이트 연결)
  - **Resend용 3개**: MX `send`, TXT `send`(SPF), TXT `resend._domainkey`(DKIM) — Resend Domains에서 추가한 도메인에 나오는 값 그대로 입력.
- **환경 변수 (도메인 반영)**:
  - **Vercel** `VITE_API_URL` = `https://garaksalestool.com` → API도 같은 도메인으로 요청.
  - **Render** `RESEND_FROM` = `noreply@garaksalestool.com` → Resend에서 garaksalestool.com 도메인 인증(Verify) 완료 후 설정 후 Redeploy.
