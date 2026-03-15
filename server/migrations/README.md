# DB 마이그레이션

배포 시 **PostgreSQL 스키마를 자동으로 반영**하려면 증분 마이그레이션을 사용합니다.

## 로컬에서 실행

```bash
cd server
npm run migrate
```

- `migrations/` 폴더의 `*.sql` 파일을 **파일명 순**으로 실행합니다.
- `schema_migrations` 테이블에 적용 이력을 저장하므로, 이미 적용된 파일은 건너뜁니다.
- `DATABASE_URL` 또는 `PG_*` 환경 변수가 있어야 합니다.

## Railway 배포 시 자동 실행

**방법 1: Start Command에 마이그레이션 포함 (권장)**

Railway 프로젝트 → 백엔드 서비스 → **Settings** → **Deploy**:

- **Start Command**: `npm run migrate && npm start`

이렇게 하면 배포될 때마다 먼저 `npm run migrate`가 실행된 뒤 앱이 시작합니다.

**방법 2: Release Command (지원 시)**

- **Release Command**: `npm run migrate`
- **Start Command**: `npm start` (기본)

배포 단계에서 한 번만 마이그레이션을 실행하고, 앱은 그대로 시작합니다.

## 새 마이그레이션 추가 방법

1. `migrations/` 폴더에 새 파일 추가: `002_설명.sql`, `003_설명.sql` … (파일명 순서로 실행됨)
2. 파일 내용은 **증분 변경만** 작성 (예: `ALTER TABLE "user" ADD COLUMN ...`).
3. 배포 후 `npm run migrate`가 새 파일만 적용합니다.

**주의**: 이미 적용된 마이그레이션 파일은 수정하지 마세요. 변경이 필요하면 새 번호로 추가하세요.
