/**
 * T-210 최근 매입 단가·최근 거래처 API 검사
 * - GET /api/purchases/last-price?product_id&partner_id
 * - GET /api/purchases/recent-partners
 * 사용: server 폴더에서
 *   DATABASE_URL=<테스트 DB> LAST_PRICE_API_BASE=http://127.0.0.1:<포트> node scripts/last-price-test.js
 * 전제: 마이그레이션 001~009, seed-admin(admin001/sample 또는 SMOKE_PASSWORD), 서버 기동.
 * 테스트 DB 전용 — 두 번째 회원(t210_other_<태그>)을 DB에 직접 만들고 거래처·상품·매입을 새로 등록한다.
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.LAST_PRICE_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[last-price-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}

function request(method, path, body, token) {
  const u = new URL(path, BASE);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* 본문이 JSON이 아님 */ }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? '' : detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + detail}`);
}

async function login(agentNo, password) {
  const r = await request('POST', '/api/auth/login', { agent_no: agentNo, password });
  if (r.status !== 200 || !r.json?.token) throw new Error(`로그인 실패 ${agentNo} status=${r.status}`);
  return r.json.token;
}

async function mustOk(r, what) {
  if (r.status >= 300 || !r.json?.ok) throw new Error(`${what} 실패 status=${r.status} ${r.json?.message || ''}`);
  return r.json.data;
}

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const tokenA = await login('admin001', process.env.SMOKE_PASSWORD || 'sample');

  // 두 번째 회원 B — 테스트 DB에 직접 만든다(가입 절차의 이메일 인증을 건너뜀). 비밀번호는 실행마다 임의값
  const pwB = crypto.randomBytes(12).toString('hex');
  const agentB = `t210_other_${tag}`;
  await pool.query(
    `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
     VALUES ($1, NULL, $2, $3, $4, NOW(), 'active', false)`,
    ['T210 Other', `${agentB}@test.local`, agentB, await bcrypt.hash(pwB, 10)]
  );
  const tokenB = await login(agentB, pwB);

  // A의 데이터: 거래처 P1·P2·P3(매입처), 상품 X·Y
  const mkPartner = async (token, name) =>
    mustOk(await request('POST', '/api/partners', { name, type: 'supplier' }, token), `거래처 ${name}`);
  const p1 = await mkPartner(tokenA, `T210-P1-${tag}`);
  const p2 = await mkPartner(tokenA, `T210-P2-${tag}`);
  const p3 = await mkPartner(tokenA, `T210-P3-${tag}`);
  const mkProduct = async (name) =>
    mustOk(await request('POST', '/api/products', { name, unit: 'kg' }, tokenA), `상품 ${name}`);
  const x = await mkProduct(`T210-X-${tag}`);
  const y = await mkProduct(`T210-Y-${tag}`);
  const buy = async (token, partner, product, qty, price, date) =>
    mustOk(
      await request('POST', '/api/purchases', { partner_id: partner.id, product_id: product.id, quantity: qty, unit_price: price, purchase_date: date }, token),
      `매입 ${date}`
    );
  // 과거 날짜를 쓴다(스모크·시나리오가 만든 오늘 매입과 섞이지 않게). 같은 날 두 건이면 나중 등록(id 큰 것)이 최근
  await buy(tokenA, p1, x, 5, 10000, '2026-10-10');
  await buy(tokenA, p1, x, 3, 12000, '2026-10-18');
  await buy(tokenA, p1, x, 4, 12500, '2026-10-18');
  await buy(tokenA, p2, x, 7, 11000, '2026-10-19');

  // B의 데이터: B 거래처 Q1, 같은 상품 X를 다른 단가로
  const q1 = await mkPartner(tokenB, `T210-Q1-${tag}`);
  await buy(tokenB, q1, x, 1, 99000, '2026-10-20');

  const lp = (token, productId, partnerId) =>
    request('GET', `/api/purchases/last-price?product_id=${encodeURIComponent(productId)}${partnerId != null ? `&partner_id=${encodeURIComponent(partnerId)}` : ''}`, null, token);

  // 1) 같은 상품+거래처 — 같은 날 두 건 중 나중 등록
  let r = await lp(tokenA, x.id, p1.id);
  check('A: X+P1 → 12,500원·2026-10-18·수량 4·scope=partner',
    r.status === 200 && r.json.data?.unit_price === 12500 && r.json.data?.purchase_date === '2026-10-18' && r.json.data?.quantity === 4 && r.json.data?.scope === 'partner',
    JSON.stringify(r.json));
  // 2) 상품만 — 전체 거래처 중 최근(P2)
  r = await lp(tokenA, x.id);
  check('A: X만 → 11,000원·2026-10-19·P2·scope=product',
    r.status === 200 && r.json.data?.unit_price === 11000 && r.json.data?.purchase_date === '2026-10-19' && r.json.data?.partner_id === p2.id && r.json.data?.scope === 'product',
    JSON.stringify(r.json));
  // 3) 그 거래처 기록이 없으면 상품 기준으로 대신
  r = await lp(tokenA, x.id, p3.id);
  check('A: X+P3(기록 없음) → 상품 기준 11,000원·scope=product',
    r.status === 200 && r.json.data?.unit_price === 11000 && r.json.data?.scope === 'product', JSON.stringify(r.json));
  // 4) 매입 기록 없는 상품
  r = await lp(tokenA, y.id, p1.id);
  check('A: Y(기록 없음) → data null', r.status === 200 && r.json.ok === true && r.json.data === null, JSON.stringify(r.json));

  // 5) 권한 — B는 A의 매입을 볼 수 없다
  r = await lp(tokenB, x.id);
  check('B: X → B 자기 매입 99,000원만(A 단가 노출 없음)',
    r.status === 200 && r.json.data?.unit_price === 99000 && r.json.data?.partner_id === q1.id, JSON.stringify(r.json));
  r = await lp(tokenB, x.id, p1.id);
  check('B: X + A의 거래처 P1 → A 기록 대신 B 자기 기록(scope=product)만',
    r.status === 200 && r.json.data?.unit_price === 99000 && r.json.data?.scope === 'product', JSON.stringify(r.json));
  r = await lp(tokenB, y.id, p1.id);
  check('B: Y + A의 거래처 P1 → data null', r.status === 200 && r.json.data === null, JSON.stringify(r.json));
  r = await lp(tokenA, x.id, q1.id);
  check('A: X + B의 거래처 Q1 → B 단가(99,000) 노출 없음',
    r.status === 200 && r.json.data?.unit_price !== 99000 && r.json.data?.scope === 'product', JSON.stringify(r.json));

  // 6) 인증·입력 검증
  r = await lp(null, x.id);
  check('토큰 없음 → 401', r.status === 401, `status=${r.status}`);
  r = await request('GET', '/api/purchases/last-price', null, tokenA);
  check('product_id 없음 → 400', r.status === 400, `status=${r.status}`);
  for (const bad of ['abc', '0', '-1', '1 OR 1=1', '1;DROP TABLE purchase', '99999999999']) {
    r = await lp(tokenA, bad);
    check(`product_id=${bad} → 400`, r.status === 400, `status=${r.status}`);
  }
  r = await lp(tokenA, x.id, 'abc');
  check('partner_id=abc → 400', r.status === 400, `status=${r.status}`);
  r = await lp(tokenA, 2147480000);
  check('없는 상품 id → data null', r.status === 200 && r.json.data === null, JSON.stringify(r.json));

  // 7) 최근 거래처
  r = await request('GET', '/api/purchases/recent-partners', null, tokenA);
  const listA = r.json?.data || [];
  const idx = (id) => listA.findIndex((p) => p.partner_id === id);
  check('A 최근 거래처: P2(10-19)가 P1(10-18)보다 위, P1 건수 3, P3(매입 없음) 제외, B 거래처 제외',
    r.status === 200 && idx(p2.id) >= 0 && idx(p1.id) > idx(p2.id) && listA[idx(p1.id)].cnt === 3 && idx(p3.id) === -1 && idx(q1.id) === -1,
    JSON.stringify(listA.slice(0, 6)));
  r = await request('GET', '/api/purchases/recent-partners', null, tokenB);
  check('B 최근 거래처: Q1 하나만', r.status === 200 && r.json.data.length === 1 && r.json.data[0].partner_id === q1.id, JSON.stringify(r.json));
  r = await request('GET', '/api/purchases/recent-partners');
  check('최근 거래처 토큰 없음 → 401', r.status === 401, `status=${r.status}`);

  // 8) 인덱스 사용 가능 여부 — 데이터가 적으면 플래너가 순차 스캔을 고르므로 seqscan을 끄고 계획을 본다
  const c = await pool.connect();
  try {
    await c.query('SET enable_seqscan = off');
    const plan = (await c.query(
      `EXPLAIN SELECT pu.unit_price FROM purchase pu WHERE pu.user_id = 1 AND pu.product_id = $1 ORDER BY pu.purchase_date DESC, pu.id DESC LIMIT 1`,
      [x.id]
    )).rows.map((row) => row['QUERY PLAN']).join('\n');
    console.log(plan);
    check('last-price 쿼리가 idx_purchase_user_product_date 사용', plan.includes('idx_purchase_user_product_date'), plan);
  } finally {
    c.release();
  }
  await pool.end();

  const failed = results.filter((x2) => !x2.ok);
  console.log(`\n통과 ${results.length - failed.length} / ${results.length}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('[last-price-test] 오류:', e.message);
  process.exit(1);
});
