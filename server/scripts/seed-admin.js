/**
 * 로컬용 샘플 관리자 계정 생성
 * - 실행: server 폴더에서 node scripts/seed-admin.js
 * - 로그인: 중매인 번호 admin001 / 비밀번호 sample (로컬·개발만)
 *
 * 운영 안전장치 (T-114, D 리뷰 R-01 ①②)
 * - NODE_ENV=production 이면 SEED_ADMIN_PASSWORD(12자 이상)가 없으면 거부한다 — 공개 저장소에 적힌 'sample' 로
 *   운영 관리자 계정이 만들어지지 않게.
 * - 이미 있는 계정(같은 agent_no)의 비밀번호는 덮어쓰지 않는다 — 배포마다 다시 실행돼도 바꾼 비밀번호가 되돌아가지 않게.
 *   (이름·관리자 권한만 맞춘다)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// 접속 설정은 서버와 같은 lib/db-config.js — 예전 자체 설정은 NODE_ENV=production 이 아니면 SSL 없이 붙어
// sslmode=require 인 Neon·Supabase URL에서 실패했다 (O-03)
const { getPgConfig } = require('../lib/db-config');
function getPoolConfig() {
  return getPgConfig();
}

const SAMPLE = {
  name: 'Sample Admin',
  phone: '01000000000',
  email: 'admin@sample.local',
  agent_no: 'admin001',
  password: 'sample',
};

const SEED_MIN_PROD_PASSWORD = 12;
const IS_PROD = process.env.NODE_ENV === 'production';

/** 이번 실행에 쓸 비밀번호. 운영인데 조건이 맞지 않으면 null (값은 출력하지 않는다) */
function resolvePassword() {
  const fromEnv = process.env.SEED_ADMIN_PASSWORD;
  if (IS_PROD) {
    if (!fromEnv || [...fromEnv].length < SEED_MIN_PROD_PASSWORD) return null;
    return fromEnv;
  }
  return fromEnv || SAMPLE.password;
}

async function run() {
  const password = resolvePassword();
  if (password === null) {
    console.error(`[seed-admin] 거부: NODE_ENV=production 에서는 SEED_ADMIN_PASSWORD(${SEED_MIN_PROD_PASSWORD}자 이상)를 환경 변수로 넣어야 합니다.`);
    process.exit(2);
  }
  const pool = new Pool(getPoolConfig());
  try {
    const hash = await bcrypt.hash(password, 10);
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
           is_admin = true,
           updated_at = NOW()
         RETURNING id, user_key, name, agent_no, is_admin, (xmax = 0) AS inserted`,
        params
      );
      const row = r.rows[0];
      if (!row) throw new Error('INSERT/UPDATE returned no row');
      await client.query(
        `INSERT INTO terms_agreement (user_id, terms_type, agreed_at)
         SELECT $1, 'privacy', NOW() WHERE NOT EXISTS (SELECT 1 FROM terms_agreement WHERE user_id = $1 AND terms_type = 'privacy')`,
        [row.id]
      ).catch(() => {});
      console.log(row.inserted
        ? '[seed-admin] 관리자 계정을 새로 만들었습니다.'
        : '[seed-admin] 이미 있는 관리자 계정입니다 — 비밀번호는 바꾸지 않았습니다.');
      if (!IS_PROD && row.inserted && !process.env.SEED_ADMIN_PASSWORD) {
        console.log('');
        console.log('  로그인: 중매인 번호 = admin001 / 비밀번호 = sample (로컬 전용)');
        console.log('  (로컬 프론트 http://localhost:5173 로그인 화면에서 사용)');
        console.log('');
      }
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
