#!/usr/bin/env node
/**
 * T-203 실 API 분류 코드 매핑 시드 실행 — scripts/seed-at-realtime-mapping.sql (재실행 안전)
 * 사용: DATABASE_URL=... node scripts/seed-at-realtime-mapping.js
 * 030 마이그레이션 뒤에 실행. 사용자 결정(U-07b·19·20·21·22a) 전 기본값은 A 권고안
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

(async () => {
  const url = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL 없음'); process.exit(1); }
  const ssl = String(process.env.DB_SSL || '').toLowerCase() === 'false' ? false : (/localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false });
  const c = new Client({ connectionString: url, ssl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(fs.readFileSync(path.join(__dirname, 'seed-at-realtime-mapping.sql'), 'utf8'));
    await c.query('COMMIT');
    const r = await c.query(`SELECT action, COUNT(*)::int n FROM item_mapping WHERE memo LIKE 'AT 시드:%' GROUP BY action ORDER BY action`);
    console.log('[seed-at-mapping] 완료', r.rows.map((x) => `${x.action} ${x.n}`).join(' · '));
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('[seed-at-mapping] 실패', e.message);
    process.exitCode = 1;
  } finally { await c.end(); }
})();
