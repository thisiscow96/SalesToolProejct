/**
 * 증분 DB 마이그레이션 실행
 * - migrations/ 폴더의 *.sql 파일을 파일명 순으로 실행
 * - schema_migrations 테이블에 적용 이력 저장, 이미 적용된 건 건너뜀
 * - 배포 시: npm run migrate && npm start 또는 Railway Release Command에 npm run migrate
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

// 접속 설정은 서버와 같은 lib/db-config.js (Neon·Supabase SSL 포함)
const { getPgConfig } = require('../lib/db-config');
function getConfig() {
  return getPgConfig();
}

async function run() {
  const migrationsDir = path.join(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('[migrate] migrations/ 폴더가 없습니다. 건너뜁니다.');
    process.exit(0);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[migrate] 적용할 마이그레이션 파일이 없습니다.');
    process.exit(0);
  }

  const config = getConfig();
  if (!config.database) {
    console.warn('[migrate] DATABASE_URL 또는 PG_DATABASE가 없습니다. 마이그레이션을 건너뜁니다.');
    process.exit(0);
  }

  const client = new Client(config);
  try {
    await client.connect();
  } catch (err) {
    console.error('[migrate] DB 연결 실패:', err.code || err.message, err.message);
    process.exit(1);
  }

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await client.query('SELECT name FROM schema_migrations');
    const appliedSet = new Set(applied.rows.map((r) => r.name));

    for (const file of files) {
      const name = file;
      if (appliedSet.has(name)) {
        console.log('[migrate] 건너뜀:', name);
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8').trim();
      if (!sql) {
        console.log('[migrate] 빈 파일 건너뜀:', name);
        appliedSet.add(name);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        continue;
      }

      console.log('[migrate] 적용 중:', name);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      appliedSet.add(name);
      console.log('[migrate] 완료:', name);
    }
  } catch (err) {
    console.error('[migrate] 오류:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }

  console.log('[migrate] 마이그레이션 완료.');
}

run();
