/**
 * DATE 열 하루 밀림 점검 (T-116) — API가 돌려준 날짜가 DB에 저장된 날짜(문자열)와 같은지 표로 비교한다.
 *
 * 사용 (로컬 테스트 DB 전용):
 *   DATABASE_URL=postgresql://postgres:pw@127.0.0.1:<포트>/sales_tool \
 *   CHECK_API_BASE=http://127.0.0.1:<서버포트> node scripts/check-date-tz.js [라벨] [결과.json]
 * 먼저 seed-admin · smoke-api-flow 를 한 번 돌려 매입·매출·수금이 있어야 한다. 폐기가 없으면 1건 만든다.
 * 운영 DB 보호: DATABASE_URL 호스트가 localhost/127.0.0.1 이 아니면 바로 끝낸다.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Pool } = require('pg');
const { getPgConfig } = require('../lib/db-config');

const BASE = process.env.CHECK_API_BASE || 'http://127.0.0.1:3000';
const AGENT = process.env.CHECK_AGENT || 'admin001';
const LABEL = process.argv[2] || '';
const OUT = process.argv[3] || '';

function assertLocalDb() {
  const raw = (process.env.DATABASE_URL || '').trim();
  const host = raw ? new URL(raw).hostname : process.env.PG_HOST || 'localhost';
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error('[check-date-tz] 로컬 DB가 아니라서 멈춥니다:', host);
    process.exit(2);
  }
}

let TOKEN = null;
function request(method, pathname, body) {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const rq = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: pathname,
        method,
        headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { _raw: data };
          }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    rq.on('error', reject);
    if (body) rq.write(JSON.stringify(body));
    rq.end();
  });
}

async function main() {
  assertLocalDb();
  const pool = new Pool(getPgConfig());
  const u = await pool.query(`SELECT id FROM "user" WHERE agent_no = $1`, [AGENT]);
  if (!u.rows[0]) throw new Error('사용자 없음 — seed-admin 먼저');
  const userId = u.rows[0].id;

  const login = await request('POST', '/api/auth/login', { agent_no: AGENT, password: process.env.SMOKE_PASSWORD || 'sample' });
  if (!login.json?.token) throw new Error('로그인 실패 ' + login.status);
  TOKEN = login.json.token;

  // DB 저장값은 항상 ::text 로 읽는다 (드라이버 변환과 무관한 기준값)
  const one = async (sql) => (await pool.query(sql, [userId])).rows[0];
  const pu = await one(`SELECT id, product_id, purchase_date::text AS d FROM purchase WHERE user_id = $1 ORDER BY id DESC LIMIT 1`);
  const sa = await one(`SELECT id, partner_id, sale_date::text AS d FROM sale WHERE user_id = $1 ORDER BY id DESC LIMIT 1`);
  const py = await one(
    `SELECT id, paid_at, (paid_at AT TIME ZONE 'Asia/Seoul')::date::text AS kst_d FROM payment WHERE user_id = $1 ORDER BY id DESC LIMIT 1`
  );
  let di = await one(`SELECT id, disposal_date::text AS d FROM disposal WHERE user_id = $1 ORDER BY id DESC LIMIT 1`);
  if (!di && pu) {
    const c = await request('POST', '/api/disposals', { product_id: pu.product_id, quantity: 1, disposal_date: pu.d, reason: 'T-116 점검' });
    if (c.status >= 300) console.warn('폐기 생성 실패', c.status, c.json?.message);
    di = await one(`SELECT id, disposal_date::text AS d FROM disposal WHERE user_id = $1 ORDER BY id DESC LIMIT 1`);
  }

  const rows = [];
  const add = (api, field, db, got, note = '') =>
    rows.push({ api, field, db, api_value: got === undefined ? '(없음)' : got, same: String(got).slice(0, 10) === db && String(got).length === 10, note });

  if (pu) {
    const r = await request('GET', `/api/purchases?from_date=${pu.d}&to_date=${pu.d}`);
    const x = (r.json?.data || []).find((v) => v.id === pu.id);
    add('GET /api/purchases (당일 조회)', 'purchase_date', pu.d, x?.purchase_date, x ? '당일 조회에 포함' : '당일 조회에 없음');
    const inv = await request('GET', '/api/inventory');
    const iv = (inv.json?.data || []).find((v) => v.product_id === pu.product_id || v.id === pu.product_id);
    if (iv) {
      add('GET /api/inventory', 'last_purchase_date', pu.d, iv.last_purchase_date, '같은 상품 최신 매입');
      rows.push({ api: 'GET /api/inventory', field: 'aging_base_date / aging_days', db: '(to_char)', api_value: `${iv.aging_base_date} / ${iv.aging_days}`, same: null, note: '라우트가 이미 문자열 — 참고값' });
    }
  }
  if (sa) {
    const r = await request('GET', `/api/sales?from_date=${sa.d}&to_date=${sa.d}`);
    const x = (r.json?.data || []).find((v) => v.id === sa.id);
    add('GET /api/sales (당일 조회)', 'sale_date', sa.d, x?.sale_date, x ? '당일 조회에 포함' : '당일 조회에 없음');
    const st = await request('GET', `/api/sales/statement?partner_id=${sa.partner_id}&from_date=${sa.d}&to_date=${sa.d}`);
    const lines = st.json?.data?.items || [];
    const sx = Array.isArray(lines) ? lines.find((v) => v.id === sa.id) : null;
    add('GET /api/sales/statement', 'sale_date', sa.d, sx?.sale_date, '라우트에서 ::text');
    const dr = await request('GET', `/api/reports/daily-purchase-sales?from_date=${sa.d}&to_date=${sa.d}`);
    const d0 = (dr.json?.data || [])[0];
    add('GET /api/reports/daily-purchase-sales', 'date', sa.d, d0?.date, `건수 매입 ${d0?.purchase_count ?? '-'} · 매출 ${d0?.sales_count ?? '-'}`);
  }
  if (di) {
    const r = await request('GET', `/api/disposals?from_date=${di.d}&to_date=${di.d}`);
    const x = (r.json?.data || []).find((v) => v.id === di.id);
    add('GET /api/disposals (당일 조회)', 'disposal_date', di.d, x?.disposal_date, x ? '당일 조회에 포함' : '당일 조회에 없음');
  }
  if (py) {
    const r = await request('GET', `/api/payments?from_date=${py.kst_d}&to_date=${py.kst_d}`);
    const x = (r.json?.data || []).find((v) => v.id === py.id);
    rows.push({
      api: 'GET /api/payments (KST 당일 조회)',
      field: 'paid_at (timestamptz)',
      db: py.paid_at.toISOString(),
      api_value: x ? x.paid_at : '(없음)',
      same: x ? new Date(x.paid_at).getTime() === py.paid_at.getTime() : false,
      note: `KST 날짜 ${py.kst_d} 조회에 ${x ? '포함' : '없음'} — timestamptz 는 바꾸지 않음`,
    });
  }
  await pool.end();

  console.log(`\n[check-date-tz] ${LABEL} 서버=${BASE}`);
  console.log('| API | 필드 | DB 저장값 | API 응답값 | 일치 | 비고 |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.api} | ${r.field} | ${r.db} | ${r.api_value} | ${r.same == null ? '-' : r.same ? 'O' : 'X'} | ${r.note} |`);
  const bad = rows.filter((r) => r.same === false).length;
  console.log(`불일치 ${bad}건 / 비교 ${rows.filter((r) => r.same != null).length}건`);
  if (OUT) fs.writeFileSync(path.resolve(OUT), JSON.stringify({ label: LABEL, base: BASE, rows }, null, 2));
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error('[check-date-tz] 오류:', e.message);
  process.exit(1);
});
