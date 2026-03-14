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

## API

| 경로 | 설명 |
|------|------|
| `GET /` | 서버 상태 |
| `GET /health` | 서버 + PostgreSQL 연결 상태 |

## 다음 단계

- 테이블 설계 (사용자, 주문, 상품 등) 후 마이그레이션/스키마 적용
- 로그인·인증 API 추가
- 웹(React)에서 이 서버 API 호출하도록 연동
