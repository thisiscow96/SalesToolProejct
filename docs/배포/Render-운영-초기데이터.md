# Render 운영 DB — 초기 데이터(선택)

운영 PostgreSQL에 **샘플 관리자 계정**만 넣고 싶을 때 사용합니다.  
기본값은 **중매인 번호 `admin001` / 비밀번호 `sample`** 이므로, 실서비스 전에 **반드시 비밀번호 변경** 또는 계정 정책에 맞게 수정하세요.

## Shell 없이 실행 (Shell 업그레이드 불필요)

Render 무료 플랜 등에서 **Shell** 사용 시 유료 업그레이드를 요구하는 경우, 아래로 동일하게 마이그레이션·시드를 실행할 수 있습니다.

### A. GitHub Actions (권장)

1. GitHub 레포지토리 → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**
2. Name: **`DATABASE_URL`** — Value: Render **[Dashboard](https://dashboard.render.com) → Postgres DB 선택 → DB 상세 페이지**에서  
   - **오른쪽 위 `Connect`** 를 누르면 **Internal URL / External URL** 이 함께 나옵니다. **GitHub Actions·로컬 PC**처럼 Render 밖에서 붙을 때는 **`External` 쪽 URL** 을 복사합니다.  
   - 또는 같은 페이지의 **Info** 탭에서 **External connections**(공개 접속) 블록의 URL을 복사합니다.  
   - Web Service **Environment** 의 `DATABASE_URL` 은 종종 **Internal** 이라, 시크릿에는 반드시 Postgres 화면의 **External** 을 쓰는 것이 안전합니다.
3. **Actions** 탭 → 워크플로 **「Seed oper database (Render)」** → **Run workflow** — 최초에는 `run_seed_admin`·`run_migrate`·`run_seed` 모두 켠 뒤 실행(이미 시드했으면 시드만 끄고 마이그레이션만 등으로 조정)

워크플로 파일: `.github/workflows/seed-oper-database.yml`

### B. 로컬 PC 터미널

1. 위와 동일한 `DATABASE_URL`을 Render 대시보드에서 **한 번만** 복사합니다(파일·커밋에 넣지 말 것).
2. 예 (PowerShell):

```powershell
cd server
$env:DATABASE_URL="postgresql://..."  # 실제 URL로 교체
$env:NODE_ENV="production"
npm install
npm run migrate
npm run seed-oper-april-flow-2026
```

## 1. Render Shell에서 1회 실행

1. Render Dashboard → **해당 Web Service** → **Shell** (또는 **Connect** → SSH/Shell).
2. 저장소가 이미 체크아웃된 상태에서 `server` 디렉터리로 이동한 뒤:

```bash
cd server
npm install
npm run seed-admin
```

`DATABASE_URL`은 Render가 Web Service에 이미 주입한 값을 사용합니다(별도 입력 불필요).

## 2. 기대 결과

- 콘솔에 `샘플 관리자 계정이 준비되었습니다` 및 로그인 안내가 출력됩니다.
- 프론트에서 **중매인 번호 `admin001`**, **비밀번호 `sample`** 으로 로그인해 **상품 마스터** 등 관리자 기능을 쓸 수 있습니다.

## 3. 주의

- 이미 `admin001` 이 있으면 **이름·해시·관리자 플래그만 갱신**됩니다(`seed-admin.js`의 `ON CONFLICT`).
- 로컬 대용량 시드(`seed-sample-local` 등)는 데이터량이 많아 **운영에는 권장하지 않습니다.**

## 4. 매출 전환 테스트용 매입 1건(선택)

**매입정보 → 선택 매출 전환** 을 시험하려면, 잔여 수량이 있는 매입이 필요합니다. 아래 스크립트는 **할당 없는 매입 1건**만 넣으며, 같은 마커가 이미 있으면 **스킵**합니다.

```bash
cd server
npm install
npm run seed-convert-sample
```

- 대상 사용자: `SAMPLE_AGENT_NO` (기본 `admin001`). `npm run seed-admin` 후 실행하는 것을 권장합니다.
- 생성 내용: 매입처·상품·매입 50단위 등(메모 `prod-convert-sample-v1`).

## 5. 일별 매입·매출 화면용 샘플 (2026-04-01 ~ 04-06, admin001 전용)

**일별 매입·매출** 탭에서 날짜별 집계를 확인하려면, 동일 기간에 매입·매출이 있어야 합니다. 아래는 **`admin001` 사용자 데이터만** 삽입합니다(다른 중매인 번호에는 보이지 않음). 이미 같은 마커로 4월 1일 매입이 있으면 **전체 스킵**합니다.

```bash
cd server
npm install
npm run seed-april-daily-2026
```

- 대상: `SAMPLE_AGENT_NO` (기본 `admin001`). `npm run seed-admin` 선행 권장.
- 기간: **2026-04-01 ~ 2026-04-06** 하루씩 매입 1건 + 매출 1건(메모 `prod-april-daily-2026-v1`).

## 6. 운영 데모용 대량 플로우(2026-04-01 ~ 04-06, admin001 전용)

매입·매출(흑자·매입연결)·미수·폐기를 **각 약 100건** 넣어 대시보드·탭·미수 화면을 채울 때 사용합니다. 매입 **출처**는 모두 **한국청과**(`source_name`), 매입/매출 거래처는 스크립트 내 풀을 순환합니다. 이미 `prod-april-flow-2026-v1:purchase:0` 매입이 있으면 **전체 스킵**합니다.

```bash
cd server
npm install
npm run seed-oper-april-flow-2026
```

- 대상: `SAMPLE_AGENT_NO` (기본 `admin001`). **`npm run migrate`** 로 `purchase.source_name` 컬럼(007)이 적용된 뒤 실행하세요.
- 거래처 목록을 바꾸려면 `server/scripts/seed-oper-april-flow-2026.js` 상단의 `SUPPLIERS` / `CUSTOMERS` 배열만 수정하면 됩니다.
