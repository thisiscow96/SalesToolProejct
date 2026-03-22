# server (Backend)

판매툴 **백엔드 API** (Express + PostgreSQL) 디렉터리입니다.

## 필요 환경

- Node.js (이미 설치됨)
- PostgreSQL (로컬 또는 원격 서버)

## 1. PostgreSQL 설치 (로컬에 없을 때)

1. https://www.postgresql.org/download/windows/ 접속
2. Windows용 설치 프로그램 다운로드 후 설치
3. 설치 중 **비밀번호** 설정 (postgres 계정)
4. 포트는 기본 **5432** 로 두면 됨

## 2. DB 생성 (PostgreSQL 설치 후)

pgAdmin 또는 명령줄(psql)에서:

```sql
CREATE DATABASE sales_tool;
```

## 2-1. 스키마 반영 (pgAdmin에서 schema-full.sql 실행)

테이블·타입·뷰를 한 번에 만들려면 **pgAdmin**에서 아래 순서대로 진행합니다.

### 1) pgAdmin 실행 후 DB 선택

- 왼쪽 **브라우저(Browser)** 패널에서 트리 열기:
  - **Servers** → 사용 중인 서버(예: PostgreSQL 18) → **Databases**
- **sales_tool** 데이터베이스를 **한 번 클릭**해서 선택합니다.  
  (아직 없으면 **Databases** 우클릭 → **Create** → **Database** → Name에 `sales_tool` 입력 후 저장)

### 2) Query Tool 열기

- 왼쪽에서 **sales_tool**을 선택한 상태로, 상단 메뉴에서 **Tools** → **Query Tool** 클릭  
  (또는 **sales_tool** 우클릭 → **Query Tool**)
- 오른쪽에 **Query Tool** 창(큰 SQL 입력 창)이 열립니다.  
  이 창에서 실행할 DB가 **sales_tool**로 잡혀 있는지 상단 탭/제목 옆에서 확인합니다.

### 3) schema-full.sql 파일 열기

- Query Tool 창 안에서 메뉴 **File** → **Open** (또는 단축키 **Ctrl + O**)
- 파일 선택 창이 뜨면 프로젝트 폴더로 이동:
  - `C:\Users\gunme\Desktop\건우\프로젝트\3. 판매툴\server`
- **schema-full.sql** 파일을 선택하고 **열기** 클릭
- Query Tool에 스키마 SQL 전체가 붙여 넣어집니다.

### 4) 스크립트 실행

- Query Tool 창이 활성화된 상태에서 **F5** 키를 누르거나,  
  상단 도구 모음의 **실행(▶ 재생 버튼)** 아이콘을 클릭합니다.
- 아래 **Messages / Output** 패널에 `Query returned successfully` 등이 보이면 정상 실행된 것입니다.
- 에러가 나오면 메시지를 확인한 뒤, DB 비밀번호·연결 상태·파일 경로를 다시 확인합니다.

### 5) 적용 여부 확인

- 왼쪽 **Browser**에서 **sales_tool** → **Schemas** → **public** → **Tables** 를 펼치면  
  `user`, `account`, `product` 등 테이블이 보이면 스키마가 반영된 것입니다.

---

**요약**: **pgAdmin** → **sales_tool** 선택 → **Tools** → **Query Tool** → **File** → **Open** → `server/schema-full.sql` 선택 → **F5** 실행.

**관리자(is_admin)**: `user` 테이블에 `is_admin` 컬럼이 있습니다. 관리자로 지정된 사용자만 메인 화면에 **상품 마스터** 탭이 보입니다.  
- 스키마를 처음 적용한 경우: pgAdmin에서 `UPDATE "user" SET is_admin = true WHERE agent_no = '중매인번호';` 로 지정.  
- 이미 스키마를 적용한 DB에 컬럼만 추가하려면: `ALTER TABLE "user" ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;` 실행 후 위 UPDATE로 관리자 지정.

### 2-2. 증분 마이그레이션 (배포 시 자동 스키마 반영)

배포 툴(Railway 등)에서 **push 시 Postgres 스키마까지 자동 반영**하려면 `npm run migrate`를 사용합니다.

- **로컬**: `cd server` 후 `npm run migrate` 실행 → `migrations/` 폴더의 SQL이 순서대로 적용됩니다.
- **Railway**: 서비스 **Settings** → **Start Command**를 `npm run migrate && npm start` 로 설정하면, 배포될 때마다 마이그레이션 실행 후 앱이 시작됩니다.

자세한 내용은 `server/migrations/README.md` 를 참고하세요.

## 3. 서버 설정 및 실행

```cmd
cd "C:\Users\gunme\Desktop\건우\프로젝트\3. 판매툴\server"

npm install
```

`.env` 파일 생성 (`.env.example` 참고):

```
PORT=3000
DATABASE_URL=postgresql://postgres:여기비밀번호@localhost:5432/sales_tool
```

실행:

```cmd
npm start
```

- http://localhost:3000 → 서버 동작 확인
- http://localhost:3000/health → DB 연결 여부 확인 (`db: "connected"` 면 성공)

### 서버 자동/편하게 실행하기

**1) 개발 시 — nodemon (한 번 켜두면 코드 수정 시 자동 재시작)**

```cmd
cd server
npm install
npm run dev
```

- `npm run dev`로 띄우면 **파일 저장할 때마다 서버가 자동으로 재시작**됩니다.
- 터미널 하나만 켜 두고 작업하면 됩니다.

**2) 백그라운드 실행 — pm2 (터미널 닫아도 서버 유지)**

pm2를 쓰면 터미널을 닫아도 서버가 계속 돌아가고, PC 재부팅 후에도 자동 실행을 걸 수 있습니다.

```cmd
npm install -g pm2
cd "C:\Users\gunme\Desktop\건우\프로젝트\3. 판매툴\server"
pm2 start index.js --name sales-tool-server
```

- 서버 중지: `pm2 stop sales-tool-server`
- 다시 시작: `pm2 start sales-tool-server`
- 상태 확인: `pm2 status`
- **재부팅 후에도 자동 실행**하려면 한 번만 실행: `pm2 startup` → 화면 안내대로 명령 실행 후, `pm2 save`

## 4. 실행 및 회원가입 테스트 (서버 + 웹 함께 띄우기)

로그인·회원가입을 확인하려면 **서버**와 **웹**을 둘 다 실행한 뒤, 브라우저에서 회원가입까지 진행하면 됩니다.

### 1) 서버 실행 (첫 번째 터미널)

- **CMD** 또는 **PowerShell**을 연다.
- 프로젝트의 `server` 폴더로 이동한 뒤 서버를 띄운다. (자동 재시작 쓰려면 `npm run dev`)

```cmd
cd "C:\Users\gunme\Desktop\건우\프로젝트\3. 판매툴\server"
npm run dev
```

- `Server listening on http://localhost:3000` 이 보이면 서버가 켜진 것이다.
- 이 터미널은 **그대로 두고** 닫지 않는다.

### 2) 웹 실행 (두 번째 터미널)

- **새 터미널**을 하나 더 연다. (CMD/PowerShell 또 하나)
- 프로젝트의 `web` 폴더로 이동한 뒤 웹 개발 서버를 띄운다.

```cmd
cd "C:\Users\gunme\Desktop\건우\프로젝트\3. 판매툴\web"
npm run dev
```

- `Local: http://localhost:5173/` 이 보이면 웹이 켜진 것이다.
- 이 터미널도 **그대로 두고** 닫지 않는다.

### 3) 브라우저에서 로그인 페이지 열기

- 브라우저(Chrome, Edge 등)를 연다.
- 주소창에 **http://localhost:5173/login** 을 입력하고 **Enter**.
- “판매툴” 로그인 화면이 나오면 정상이다.

### 4) 회원가입 화면으로 이동

- 로그인 화면 아래 **“회원가입”** 링크를 클릭한다.
- 회원가입 폼(상호명, 이메일, 휴대폰, 중매인 번호, 비밀번호 등)이 나오면 준비 완료.

### 5) 입력 후 이메일 / 휴대폰 / 중매인 번호 중복확인

- **이름**: 원하는 이름 입력.
- **이메일**: 이메일 형식에 맞게 입력 후 **“중복확인”** 클릭 → “사용 가능”이 나와야 한다. (형식이 틀리면 “이메일 형식이 올바르지 않습니다.” 표시.)
- **이메일 인증**: 이메일이 “사용 가능”이면 **“인증번호 발송”** 클릭 → 이메일로 6자리 인증번호 발송. **5분 안에** 인증번호 입력 후 **“인증하기”** 클릭 → “이메일 인증 완료”가 나와야 회원가입 가능. (SMTP 미설정 시 서버 콘솔에 인증번호가 출력됨.)
- **휴대폰번호**: 010-1234-5678 형식 등으로 입력 후 **“중복확인”** 클릭 → “사용 가능” 확인. (형식이 틀리면 안내 메시지 표시.)
- **아이디**: 아이디 입력 후 **“중복확인”** 클릭 → “사용 가능” 확인.
- **비밀번호**: 원하는 비밀번호 입력.

이메일·휴대폰·아이디 모두 “사용 가능” + **이메일 인증 완료** + 개인정보약관 동의 후 **회원가입** 버튼이 활성화된다.

### 6) 개인정보약관 동의

- **“개인정보약관 보기”** 버튼을 클릭하면 약관 내용이 펼쳐진다. (다시 클릭하면 접힌다.)
- 아래 **“개인정보약관에 동의합니다 (필수)”** 체크박스를 **반드시 체크**한다.
- 체크하지 않으면 회원가입 버튼을 눌러도 가입되지 않는다.

### 7) 회원가입 실행

- **“회원가입”** 버튼을 클릭한다.
- 성공하면 로그인 페이지로 자동 이동하고, “회원가입이 완료되었습니다. 로그인해 주세요.” 메시지가 보인다.
- 방금 만든 **아이디**와 **비밀번호**로 로그인하면 된다.

---

**한 줄 요약**: 터미널 1 → `cd server` 후 `npm start` / 터미널 2 → `cd web` 후 `npm run dev` → 브라우저에서 http://localhost:5173/login → 회원가입 → 이메일·휴대폰·아이디 중복확인 → 약관 동의 체크 → 회원가입 클릭.

## API

| 경로 | 설명 |
|------|------|
| `GET /` | 서버 상태 |
| `GET /health` | 서버 + PostgreSQL 연결 상태 |
| `POST /api/auth/check-email` | 이메일 중복·형식 확인 |
| `POST /api/auth/check-phone` | 휴대폰 중복·형식 확인 |
| `POST /api/auth/check-login-id` | 아이디 중복 확인 |
| `POST /api/auth/send-email-verification` | 이메일 인증번호 발송 (5분 유효) |
| `POST /api/auth/verify-email-code` | 인증번호 확인 |
| `POST /api/auth/register` | 회원가입 (이메일 인증 필수) |
| `POST /api/auth/login` | 로그인 (body: `{ "login_id", "password" }`) |

**회원 정보 저장**: `user` 테이블에 **id**(자동), **login_id**(아이디), **password_hash**(비밀번호 해시)를 포함해 이름·이메일·휴대폰 등이 모두 저장됩니다. 비밀번호는 bcrypt 해시로만 저장합니다.

**이메일 인증 (실제 발송)**: `.env`에 SMTP를 설정하면 인증번호를 이메일로 발송합니다. 미설정 시 서버 콘솔·화면에 인증번호가 표시됩니다.
- **받는 사람**: 회원가입 시 입력한 이메일(naver, gmail, daum 등 **어떤 주소든**)로 발송됩니다. (`SMTP_FROM`과 무관)
- **SMTP_FROM**: 메일에 표시되는 **발신자 주소**만 정합니다. 서비스 대표 주소 하나(예: your@gmail.com 또는 noreply@도메인)로 두면 됩니다.
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=앱비밀번호
SMTP_FROM=your@gmail.com
```

### 테스트 로그인용 계정 만들기

스키마 적용 후, 비밀번호 해시를 만들어서 `user` 테이블에 넣습니다.

```cmd
cd server
node -e "require('bcrypt').hash('비밀번호', 10).then(h => console.log(h))"
```

나온 해시를 복사한 뒤, pgAdmin 등에서 실행:

```sql
INSERT INTO "user" (name, phone, email, login_id, password_hash, terms_agreed_at, status)
VALUES ('테스트', '01000000000', 'test@test.com', 'test', '여기에_해시_붙여넣기', NOW(), 'active');
```

`login_id` = `test`, 위에서 넣은 비밀번호로 웹 로그인 화면에서 로그인할 수 있습니다.

### 샘플 관리자 + API 스모크 (`admin001`)

```cmd
cd server
npm run seed-admin
npm start
```

다른 터미널에서 (서버가 **최신 코드**로 떠 있어야 `POST /api/purchases` 등이 동작합니다):

```cmd
cd server
npm run smoke
```

- `X-Agent-No: admin001` 으로 매입 → 매출전환 → 수금 → 환불 → 폐기 → 조회까지 한 번에 검증합니다.
- 공급처/판매처가 없으면 스크립트가 DB에 2건 생성합니다. 상품은 `SMOKE-{타임스탬프}` 키로 1건 만듭니다.
- 다른 포트로 띄운 경우: `set SMOKE_API_BASE=http://127.0.0.1:3001` (Windows) 후 `npm run smoke`
- **삭제/수정**용 REST API는 없습니다. 스모크는 생성·조회 위주입니다.

## 다음 단계

- 웹(React)에서 이 서버 API 호출하도록 연동 (로그인 화면 연동 완료)
- 회원가입·이메일 인증 등 추가
