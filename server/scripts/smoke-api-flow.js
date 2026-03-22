/**
 * 로컬 API 스모크 테스트 (admin001 / X-Agent-No)
 * - server 폴더에서: node scripts/smoke-api-flow.js
 * - 전제: npm run seed-admin, DB 마이그레이션, 서버 기동 (PORT 기본 3000)
 */
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const AGENT = 'admin001';
const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const PORT = new URL(BASE).port || 3000;
const HOST = new URL(BASE).hostname;

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

function request(method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: HOST,
      port: PORT,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-No': AGENT,
        ...extraHeaders,
      },
    };
    const req = http.request(opts, (res) => {
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
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function requestNoAuth(method, pathname) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: HOST, port: PORT, path: pathname, method, headers: { 'Content-Type': 'application/json' } };
    const req = http.request(opts, (res) => {
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
    });
    req.on('error', reject);
    req.end();
  });
}

async function ensureAccountsAndProduct(pool, userId, tag) {
  const sup = await pool.query(
    `SELECT id FROM account WHERE user_id = $1 AND type = 'supplier' LIMIT 1`,
    [userId]
  );
  let supplierId = sup.rows[0]?.id;
  if (!supplierId) {
    const r = await pool.query(
      `INSERT INTO account (user_id, name, type) VALUES ($1, $2, 'supplier') RETURNING id`,
      [userId, `스모크-공급-${tag}`]
    );
    supplierId = r.rows[0].id;
    console.log('[smoke] 공급처 account 생성:', supplierId);
  }
  const cust = await pool.query(
    `SELECT id FROM account WHERE user_id = $1 AND type = 'customer' LIMIT 1`,
    [userId]
  );
  let customerId = cust.rows[0]?.id;
  if (!customerId) {
    const r = await pool.query(
      `INSERT INTO account (user_id, name, type) VALUES ($1, $2, 'customer') RETURNING id`,
      [userId, `스모크-판매-${tag}`]
    );
    customerId = r.rows[0].id;
    console.log('[smoke] 판매처 account 생성:', customerId);
  }
  let prod = await pool.query(`SELECT id FROM product WHERE product_key = $1 LIMIT 1`, [`SMOKE-${tag}`]);
  let productId = prod.rows[0]?.id;
  if (!productId) {
    const r = await pool.query(
      `INSERT INTO product (name, unit, product_key, memo) VALUES ($1, 'kg', $2, $3) RETURNING id`,
      [`스모크상품-${tag}`, `SMOKE-${tag}`, `smoke-api-flow ${tag}`]
    );
    productId = r.rows[0].id;
    console.log('[smoke] product 직접 INSERT (관리자 API 없이):', productId);
  }
  return { supplierId, customerId, productId };
}

async function main() {
  const tag = String(Date.now());
  const pool = new Pool(getPoolConfig());

  const u = await pool.query(`SELECT id, is_admin FROM "user" WHERE agent_no = $1 AND status = 'active'`, [AGENT]);
  if (!u.rows[0]) {
    console.error('[smoke] 실패: agent_no', AGENT, '사용자 없음. npm run seed-admin 실행 후 다시 시도하세요.');
    process.exit(1);
  }
  const userId = u.rows[0].id;
  if (!u.rows[0].is_admin) console.warn('[smoke] 경고: is_admin=false — 상품 API POST는 실패할 수 있음');

  const { supplierId, customerId, productId } = await ensureAccountsAndProduct(pool, userId, tag);
  await pool.end();

  console.log('\n=== HTTP 호출 시작 ===\n');

  let h = await requestNoAuth('GET', '/health');
  console.log('GET /health', h.status, h.json?.ok, h.json?.db);
  if (h.status !== 200 || !h.json?.ok) {
    console.error('[smoke] 서버가 응답하지 않습니다. server 폴더에서 npm start 후 재실행하세요.');
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);

  let r = await request('GET', '/api/partners');
  console.log('GET /api/partners', r.status, 'count=', r.json?.data?.length);
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));

  r = await request('GET', '/api/inventory');
  console.log('GET /api/inventory', r.status, 'count=', r.json?.data?.length);

  r = await request('POST', '/api/purchases', {
    partner_id: supplierId,
    product_id: productId,
    quantity: 100,
    unit_price: 100,
    purchase_date: today,
    memo: `SMOKE-P-${tag}`,
  });
  console.log('POST /api/purchases', r.status, r.json);
  if (r.status !== 201) throw new Error('매입 실패');
  const purchaseId = r.json.data.id;

  r = await request('GET', `/api/purchases?from_date=${today}&to_date=${today}`);
  console.log('GET /api/purchases', r.status, 'rows=', r.json?.data?.length);
  const pu = r.json.data.find((x) => x.id === purchaseId);
  console.log('  → 해당 매입 remaining_qty=', pu?.remaining_qty, 'allocated=', pu?.allocated_qty);

  r = await request('POST', '/api/purchases/convert-to-sales', {
    items: [
      {
        purchase_id: purchaseId,
        partner_id: customerId,
        quantity: 40,
        unit_price: 200,
        sale_date: today,
        memo: `SMOKE-S-${tag}`,
      },
    ],
  });
  console.log('POST convert-to-sales', r.status, r.json);
  if (r.status !== 201) throw new Error('매출전환 실패');
  const saleId = r.json.data[0].sale_id;

  r = await request('GET', `/api/sales?from_date=${today}&to_date=${today}`);
  console.log('GET /api/sales', r.status, 'sale=', r.json?.data?.find((s) => s.id === saleId)?.id);

  const saleRow = r.json.data.find((s) => s.id === saleId);
  const payAmount = Number(saleRow.total_amount);

  r = await request('POST', '/api/payments', {
    partner_id: customerId,
    amount: payAmount,
    paid_at: today,
    entry_kind: 'receive',
    allocations: [{ sale_id: saleId, amount: payAmount }],
  });
  console.log('POST /api/payments', r.status, r.json);
  if (r.status !== 201) throw new Error('수금 실패');

  r = await request('GET', `/api/payments?from_date=${today}&to_date=${today}`);
  console.log('GET /api/payments', r.status, 'last amount=', r.json?.data?.[0]?.amount);

  r = await request('POST', `/api/sales/${saleId}/refund`, {
    quantity: 5,
    refunded_at: today,
    reason: 'smoke-refund',
    refund_amount: 0,
  });
  console.log('POST refund', r.status, r.json);
  if (r.status !== 201) throw new Error('환불 실패');

  r = await request('GET', `/api/sales?from_date=${today}&to_date=${today}`);
  const afterRefund = r.json.data.find((s) => s.id === saleId);
  console.log('GET /api/sales (환불 후) refunded_qty=', afterRefund?.refunded_qty);

  r = await request('POST', '/api/disposals', {
    product_id: productId,
    quantity: 1,
    disposal_date: today,
    reason: 'smoke-disposal',
  });
  console.log('POST /api/disposals', r.status, r.json);
  if (r.status !== 201) throw new Error('폐기 실패');

  r = await request('GET', `/api/disposals?from_date=${today}&to_date=${today}`);
  console.log('GET /api/disposals', r.status, 'rows=', r.json?.data?.length);

  r = await request('GET', '/api/inventory');
  const inv = r.json.data.find((i) => i.product_id === productId);
  console.log('GET /api/inventory (해당 상품)', inv?.quantity);

  console.log('\n=== 스모크 성공 ===');
  console.log('참고: REST API에 매입/매출/수금 "삭제" 엔드포인트는 없습니다. 수정도 동일.');
  console.log('태그:', tag, '(memo/product_key로 스모크 데이터 식별 가능)');
}

main().catch((e) => {
  console.error('[smoke] 오류:', e.message);
  process.exit(1);
});
