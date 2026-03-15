/**
 * 로컬용 샘플 관리자 계정 생성
 * - 실행: server 폴더에서 node scripts/seed-admin.js
 * - 로그인: 중매인 번호 admin001 / 비밀번호 sample
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

function getPoolConfig() {
  const raw = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  if (raw && (raw.startsWith('postgres://') || raw.startsWith('postgresql://'))) {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: u.username || undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: u.pathname ? u.pathname.slice(1).replace(/\?.*$/, '') : undefined,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    };
  }
  return {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD != null ? String(process.env.PG_PASSWORD) : undefined,
    database: process.env.PG_DATABASE || 'sales_tool',
  };
}

const SAMPLE = {
  name: 'Sample Admin',
  phone: '01000000000',
  email: 'admin@sample.local',
  agent_no: 'admin001',
  password: 'sample',
};

async function run() {
  const pool = new Pool(getPoolConfig());
  try {
    const hash = await bcrypt.hash(SAMPLE.password, 10);
    const client = await pool.connect();
    try {
      const hasLoginId = await client.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'user' AND column_name = 'login_id'`
      );
      const useLoginId = hasLoginId.rows.length > 0;
      const cols = useLoginId
        ? 'name, phone, email, agent_no, login_id, password_hash, terms_agreed_at, status, is_admin'
        : 'name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin';
      const vals = useLoginId ? '$1, $2, $3, $4, $5, $6' : '$1, $2, $3, $4, $5';
      const params = useLoginId
        ? [SAMPLE.name, SAMPLE.phone, SAMPLE.email, SAMPLE.agent_no, SAMPLE.agent_no, hash]
        : [SAMPLE.name, SAMPLE.phone, SAMPLE.email, SAMPLE.agent_no, hash];
      const r = await client.query(
        `INSERT INTO "user" (${cols}) VALUES (${vals}, NOW(), 'active', true)
         ON CONFLICT (agent_no) DO UPDATE SET
           name = EXCLUDED.name,
           password_hash = EXCLUDED.password_hash,
           is_admin = true,
           updated_at = NOW()
         RETURNING id, user_key, name, agent_no, is_admin`,
        params
      );
      const row = r.rows[0];
      if (!row) throw new Error('INSERT/UPDATE returned no row');
      await client.query(
        `INSERT INTO terms_agreement (user_id, terms_type, agreed_at)
         SELECT $1, 'privacy', NOW() WHERE NOT EXISTS (SELECT 1 FROM terms_agreement WHERE user_id = $1 AND terms_type = 'privacy')`,
        [row.id]
      ).catch(() => {});
      console.log('[seed-admin] 샘플 관리자 계정이 준비되었습니다.');
      console.log('');
      console.log('  로그인: 중매인 번호 = admin001 / 비밀번호 = sample');
      console.log('  (로컬 프론트 http://localhost:5173 로그인 화면에서 사용)');
      console.log('');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[seed-admin] 오류:', err.message);
    if (err.code === '42P01') console.error('  → user 테이블이 없습니다. 먼저 schema-full.sql 또는 npm run migrate 를 실행하세요.');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
