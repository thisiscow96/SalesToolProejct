# Render 운영 DB — 초기 데이터(선택)

운영 PostgreSQL에 **샘플 관리자 계정**만 넣고 싶을 때 사용합니다.  
기본값은 **중매인 번호 `admin001` / 비밀번호 `sample`** 이므로, 실서비스 전에 **반드시 비밀번호 변경** 또는 계정 정책에 맞게 수정하세요.

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
- 트랜잭션·거래 샘플 데이터는 로컬 전용 스크립트(`seed-sample-*`)를 운영에 그대로 돌리지 마세요. 필요하면 별도 검토 후 실행합니다.
