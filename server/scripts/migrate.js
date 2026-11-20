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
  // 마이그레이션이 RAISE NOTICE 로 남기는 안내(예: 009 기존 데이터가 제약을 어겨 VALIDATE 건너뜀)를 배포 로그에 보이게
  client.on('notice', (n) => console.log('[migrate] NOTICE', n.message));
  try {
    await client.connect();
  } catch (err) {
    console.error('[migrate] DB 연결 실패:', err.code || err.message, err.message);
    process.exit(1);
  }

  try {
    // 잠금은 파일마다 트랜잭션 잠금(pg_advisory_xact_lock)으로 잡는다. 세션 잠금은 Neon 풀러(PgBouncer)에서
    // 연결이 반납돼도 풀리지 않아 다음 배포의 migrate가 끝없이 기다렸다(2026-11-20 운영 재현, I 검토 R-03·R-04).
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
      // 파일 하나 = 트랜잭션 하나: 중간에 실패하면 그 파일 변경이 모두 취소되고 이력도 남지 않아 고친 뒤 다시 실행할 수 있다 (O-01)
      await client.query('BEGIN');
      try {
        // 다른 배포가 잡고 있으면 오래 기다리지 않고 실패한다(무한 대기 → 서버 미기동 방지)
        await client.query("SET LOCAL lock_timeout = '30s'");
        await client.query("SET LOCAL statement_timeout = '5min'");
        await client.query('SELECT pg_advisory_xact_lock(728470901)');
        // 잠금을 잡는 사이 다른 배포가 먼저 적용했으면 건너뛴다
        const again = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
        if (again.rowCount) {
          await client.query('COMMIT');
          console.log('[migrate] 다른 배포가 먼저 적용함:', name);
          appliedSet.add(name);
          continue;
        }
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`${name}: ${e.message}`);
      }
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
