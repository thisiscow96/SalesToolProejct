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

### Salesforce (파일 전송 테스트 — `POST /api/file-transfer/salesforce/content-version`)

백엔드가 Salesforce에 파일을 올리려면 **아래 둘 중 하나**를 선택합니다.

**방법 A — 액세스 토큰 + 인스턴스 URL (권장, Password flow 실패 시)**

| 변수명 | 설명 |
|--------|------|
| `SF_ACCESS_TOKEN` | OAuth 응답의 `access_token` 전체. **Render Environment에만 입력**, Git·문서에 절대 넣지 말 것. 만료 시 갱신 필요. |
| `SF_INSTANCE_URL` | OAuth 응답의 `instance_url`과 동일. **끝에 `/` 없이** `https://` 로 시작. |

**현재 연동 예시(개발자 오그)** — 토큰은 별도 발급 후 Render에만 저장:

| 변수명 | 값 (예시·비밀이 아닌 URL만 기재) |
|--------|----------------------------------|
| `SF_INSTANCE_URL` | `https://orgfarm-a1ac1996fc-dev-ed.develop.my.salesforce.com` |

**방법 B — Username–Password OAuth (토큰 미사용 시)**

| 변수명 | 설명 |
|--------|------|
| `SF_TOKEN_URL` | 예: `https://login.salesforce.com/services/oauth2/token` (샌드박스·My Domain이면 해당 호스트) |
| `SF_CLIENT_ID` | Connected App Consumer Key |
| `SF_CLIENT_SECRET` | Connected App Consumer Secret |
| `SF_USERNAME` | Salesforce 로그인 사용자명 |
| `SF_PASSWORD` | 비밀번호만 |
| `SF_SECURITY_TOKEN` | (필요 시) 보안 토큰 — 코드에서 비밀번호 뒤에 이어붙임 |

`SF_ACCESS_TOKEN`과 `SF_INSTANCE_URL`이 **둘 다** 설정되어 있으면 방법 B는 사용하지 않습니다.

설정 후 **Render → Manual Deploy** 로 서비스를 다시 배포하면 반영됩니다.

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
| Render (Salesforce 파일 전송) | `SF_ACCESS_TOKEN` + `SF_INSTANCE_URL` **또는** Password flow(`SF_TOKEN_URL` 등) | 토큰은 대시보드에만. 상세는 위 **Salesforce** 절 |
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
