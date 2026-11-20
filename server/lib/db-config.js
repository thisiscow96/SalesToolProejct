/**
 * PostgreSQL 접속 설정 (서버·마이그레이션·스크립트 공용)
 *
 * 무료 Postgres(Neon · Supabase · Render 등)는 대부분 SSL이 필수다.
 * - DATABASE_URL 의 ?sslmode=require 가 있으면 SSL 사용 (Neon·Supabase 기본 URL에 포함됨)
 * - DB_SSL=true/false 로 강제 지정 가능
 * - 그 밖에는 NODE_ENV=production 이거나 알려진 관리형 호스트면 SSL 사용
 * 서버리스 DB(Neon)는 쉬다가 깨어날 때 첫 연결이 몇 초 걸리므로 연결 대기 시간을 넉넉히 둔다.
 */
const { types } = require('pg');

/**
 * DATE(OID 1082)는 'YYYY-MM-DD' 문자열 그대로 받는다 (T-116).
 * pg 기본값은 DATE를 "Node 프로세스 시간대의 자정" JS Date로 바꾸고, JSON으로 나갈 때 UTC ISO로 바뀐다.
 * 그래서 서버 TZ=Asia/Seoul이면 2026-11-20이 "2026-11-19T15:00:00.000Z"(하루 이름)로 나갔다.
 * 이 파일을 불러오는 서버·마이그레이션·스크립트 모두에 적용된다. timestamptz(1184)는 그대로 둔다.
 */
const PG_DATE_OID = 1082;
types.setTypeParser(PG_DATE_OID, (v) => v);

const MANAGED_HOSTS = /(render\.com|neon\.tech|supabase\.(co|com)|pooler\.|aivencloud\.com|cockroachlabs\.cloud)/i;

function sslFor(hostname, sslMode) {
  const forced = (process.env.DB_SSL || '').trim().toLowerCase();
  if (forced === 'true' || forced === '1') return { rejectUnauthorized: false };
  if (forced === 'false' || forced === '0') return undefined;
  if (sslMode && sslMode !== 'disable') return { rejectUnauthorized: false };
  if (process.env.NODE_ENV === 'production' || MANAGED_HOSTS.test(hostname || '')) return { rejectUnauthorized: false };
  return undefined;
}

function getPgConfig({ pool = false } = {}) {
  const raw = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  const poolOpts = pool
    ? {
        max: Number(process.env.DB_POOL_MAX) || 5, // 무료 DB 연결 수 한도 고려
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 15000, // 서버리스 DB 깨어나는 시간
        keepAlive: true,
      }
    : { connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 15000 };

  if (raw && (raw.startsWith('postgres://') || raw.startsWith('postgresql://'))) {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: (u.pathname || '/').slice(1) || undefined,
      ssl: sslFor(u.hostname, u.searchParams.get('sslmode')),
      ...poolOpts,
    };
  }
  if (raw) {
    console.warn('[DB] DATABASE_URL이 postgres:// 또는 postgresql:// 로 시작하지 않습니다. Postgres 연결 정보만 넣어 주세요.');
  }
  return {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD != null ? String(process.env.PG_PASSWORD) : undefined,
    database: process.env.PG_DATABASE || 'sales_tool',
    ssl: sslFor(process.env.PG_HOST, null),
    ...poolOpts,
  };
}

module.exports = { getPgConfig };
