/**
 * T-211 목록 검색·페이지 나누기 검사
 * 대상: GET /api/purchases · /api/sales · /api/payments · /api/inventory · /api/disposals
 *   q(텍스트 검색) · partner_id(거래처) · limit/offset(페이지) · total(총건수)
 * 확인: 하위 호환(파라미터 없으면 예전 모양) · 경계(첫·마지막·범위 밖 쪽, 잘못된 값 400) · 총건수 = 전체 행 수 ·
 *       회원 격리(남의 거래처·검색어로 남의 행이 안 나옴) · 401 · LIKE 특수문자(% _)를 글자 그대로 찾기 · 기간 필터와 함께
 * 사용: server 폴더에서
 *   DATABASE_URL=<테스트 DB> LIST_API_BASE=http://127.0.0.1:<포트> node scripts/list-search-test.js
 * 전제: 마이그레이션 001~016, seed-admin(admin001/sample 또는 SMOKE_PASSWORD), 서버 기동.
 * 테스트 DB 전용 — 회원 2명(t211_a_<태그>, t211_b_<태그>)을 DB에 직접 만들고 거래처·상품·거래를 새로 등록한다.
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.LIST_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[list-search-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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
          try { json = JSON.parse(raw); } catch { /* JSON 아님 */ }
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
const qs = (o) => new URLSearchParams(o).toString();
const kst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400000).toISOString().slice(0, 10);
const ids = (rows) => rows.map((r) => r.id);

async function makeUser(pool, prefix, tag) {
  const pw = crypto.randomBytes(12).toString('hex');
  const agent = `${prefix}_${tag}`;
  await pool.query(
    `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
     VALUES ($1, NULL, $2, $3, $4, NOW(), 'active', false)`,
    [`검사${prefix}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
  );
  return login(agent, pw);
}

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const admin = await login('admin001', process.env.SMOKE_PASSWORD || 'sample');
  const A = await makeUser(pool, 't211_a', tag);
  const B = await makeUser(pool, 't211_b', tag);
  const call = (method, p, body, t) => request(method, p, body, t);

  // 공용 상품 3개(관리자) — 이름에 태그를 넣어 다른 검사 데이터와 섞이지 않게
  const prod = async (name) => mustOk(await call('POST', '/api/products', { name: `${name}${tag}`, unit: 'kg' }, admin), '상품 등록');
  const cabbage = await prod('배추');
  const radish = await prod('무');
  const pct = await prod('특가100%_'); // LIKE 특수문자 검사용

  const partner = async (t, name, type) => mustOk(await call('POST', '/api/partners', { name: `${name}${tag}`, type }, t), '거래처 등록');
  const K = await partner(A, 'K농산', 'supplier');
  const H = await partner(A, '한국청과', 'wholesaler');
  const G = await partner(A, '가락상회', 'customer');
  const BK = await partner(B, 'B전용농산', 'supplier');

  // ---- A 매입 120건: K 배추 70건(오늘), H 무 49건(오늘), H 특가 1건(어제, 메모 '50%_할인')
  const buy = async (t, p, pr, qty, date, memo) =>
    mustOk(await call('POST', '/api/purchases', { partner_id: p.id, product_id: pr.id, quantity: qty, unit_price: 1000, purchase_date: date, memo }, t), '매입 등록');
  for (let i = 0; i < 70; i++) await buy(A, K, cabbage, 10, kst(), i === 7 ? `냉장보관${tag}` : null);
  for (let i = 0; i < 49; i++) await buy(A, H, radish, 10, kst(), null);
  await buy(A, H, pct, 5, kst(1), '50%_할인');
  // B 매입 3건(배추) — A 검색에 섞이면 안 됨
  for (let i = 0; i < 3; i++) await buy(B, BK, cabbage, 1, kst(), `냉장보관${tag}`);

  const P = (q, t = A) => call('GET', `/api/purchases?${qs(q)}`, null, t);
  const range = { from_date: kst(1), to_date: kst() };

  // 1) 하위 호환: 파라미터 없으면 total 없이 전체
  let r = await P(range);
  check('매입 하위호환 — 페이지 파라미터 없으면 전체 120건·total 없음', r.status === 200 && r.json.data.length === 120 && r.json.total === undefined, `status=${r.status} n=${r.json?.data?.length} total=${r.json?.total}`);
  const allIds = ids(r.json.data);

  // 2) 페이지: 50·50·20, 겹침 없음, 순서 = 전체 목록 순서
  const p1 = await P({ ...range, limit: 50, offset: 0 });
  const p2 = await P({ ...range, limit: 50, offset: 50 });
  const p3 = await P({ ...range, limit: 50, offset: 100 });
  check('매입 페이지 1쪽 50건·total 120', p1.json.data.length === 50 && p1.json.total === 120 && p1.json.limit === 50 && p1.json.offset === 0, JSON.stringify({ n: p1.json.data.length, t: p1.json.total }));
  check('매입 페이지 3쪽 20건(마지막 쪽 경계)', p3.json.data.length === 20 && p3.json.total === 120, `n=${p3.json.data.length}`);
  const joined = [...ids(p1.json.data), ...ids(p2.json.data), ...ids(p3.json.data)];
  check('매입 페이지 이어 붙이면 전체 목록과 같은 순서·중복 없음', JSON.stringify(joined) === JSON.stringify(allIds) && new Set(joined).size === 120, 'mismatch');
  r = await P({ ...range, limit: 50, offset: 500 });
  check('매입 범위 밖 offset → 빈 목록 + total 유지', r.status === 200 && r.json.data.length === 0 && r.json.total === 120, `n=${r.json?.data?.length} t=${r.json?.total}`);
  r = await P({ ...range, offset: 0 });
  check('offset만 주면 기본 50건', r.json.data.length === 50 && r.json.limit === 50, `n=${r.json?.data?.length}`);
  r = await P({ ...range, limit: 1 });
  check('limit 1 경계', r.json.data.length === 1 && r.json.total === 120, `n=${r.json?.data?.length}`);
  r = await P({ ...range, limit: 200 });
  check('limit 200(최대) 허용', r.status === 200 && r.json.data.length === 120, `status=${r.status}`);

  // 3) 잘못된 값
  for (const [k, v] of [['limit', '0'], ['limit', '201'], ['limit', 'abc'], ['limit', '-1'], ['offset', '-5'], ['offset', '1.5'], ['offset', '9999999']]) {
    r = await P({ ...range, [k]: v });
    check(`잘못된 ${k}=${v} → 400 VALIDATION`, r.status === 400 && r.json?.code === 'VALIDATION' && r.json?.field === k, `status=${r.status} ${JSON.stringify(r.json)}`);
  }
  r = await P({ ...range, q: 'x'.repeat(101) });
  check('검색어 101자 → 400', r.status === 400 && r.json?.field === 'q', `status=${r.status}`);
  r = await P({ ...range, q: 'x'.repeat(100) });
  check('검색어 100자 → 200(0건)', r.status === 200 && r.json.data.length === 0, `status=${r.status}`);

  // 4) 거래처 + 검색 + 총건수
  r = await P({ ...range, partner_id: K.id, limit: 50 });
  check('매입 거래처 K → total 70, 모두 K', r.json.total === 70 && r.json.data.every((x) => x.partner_id === K.id), `t=${r.json.total}`);
  r = await P({ ...range, q: `무${tag}`, limit: 50 });
  check('매입 품목 검색(무) → total 49', r.json.total === 49 && r.json.data.every((x) => x.product_id === radish.id), `t=${r.json.total}`);
  r = await P({ ...range, q: `냉장보관${tag}` });
  check('매입 메모 검색 → 1건(B 회원의 같은 메모 3건은 안 나옴)', r.json.data.length === 1 && r.json.data[0].partner_id === K.id, `n=${r.json.data.length}`);
  r = await P({ ...range, q: `한국청과${tag}`.toUpperCase() });
  check('매입 거래처 이름 검색(대소문자 무시) → 50건', r.json.data.length === 50, `n=${r.json.data.length}`);
  r = await P({ ...range, q: '%' });
  check('LIKE 특수문자 % 는 글자 그대로 — 이름·메모에 %가 있는 1건만', r.json.data.length === 1 && r.json.data[0].product_id === pct.id, `n=${r.json.data.length}`);
  r = await P({ ...range, q: '_' });
  check('LIKE 특수문자 _ 는 글자 그대로 — 1건만', r.json.data.length === 1, `n=${r.json.data.length}`);
  r = await P({ from_date: kst(), to_date: kst(), q: '%' });
  check('기간 필터와 함께(오늘만) → 어제 매입은 검색돼도 제외', r.json.data.length === 0, `n=${r.json.data.length}`);
  r = await P({ ...range, partner_id: BK.id });
  check('남의 거래처 id → 0건(남의 매입 안 보임)', r.status === 200 && r.json.data.length === 0, `status=${r.status} n=${r.json?.data?.length}`);
  r = await P({ ...range, partner_id: 'abc' });
  check('매입 partner_id 형식 오류 → 400(기존 규칙 유지)', r.status === 400, `status=${r.status}`);
  r = await call('GET', `/api/purchases?${qs({ ...range, limit: 50 })}`, null, null);
  check('토큰 없음 → 401', r.status === 401, `status=${r.status}`);
  r = await P({ ...range, q: `배추${tag}`, limit: 50 }, B);
  check('B 회원 검색 → 자기 3건만(total 3)', r.json.total === 3, `t=${r.json.total}`);
  r = await P({ unpaid_only: 1, partner_id: H.id, limit: 10, offset: 40 });
  check('미지급만(unpaid_only) + 페이지 → H 50건 중 41~50', r.json.total === 50 && r.json.data.length === 10, `t=${r.json.total} n=${r.json.data.length}`);

  // ---- 매출: FIFO 판매 3건(G) — 메모 검색
  const sell = async (pr, qty, memo) =>
    mustOk(await call('POST', '/api/sales', { partner_id: G.id, sale_date: kst(), memo, items: [{ product_id: pr.id, quantity: qty, unit_price: 2000 }] }, A), '판매');
  const s1 = (await sell(cabbage, 5, `단골${tag}`)).sales[0];
  await sell(cabbage, 5, null);
  await sell(radish, 5, null);
  const S = (q, t = A) => call('GET', `/api/sales?${qs(q)}`, null, t);
  r = await S({ from_date: kst(), to_date: kst() });
  check('매출 하위호환 — 3건·total 없음', r.json.data.length === 3 && r.json.total === undefined, `n=${r.json.data.length}`);
  r = await S({ from_date: kst(), to_date: kst(), limit: 2 });
  check('매출 페이지 2건·total 3', r.json.data.length === 2 && r.json.total === 3, `n=${r.json.data.length} t=${r.json.total}`);
  r = await S({ from_date: kst(), to_date: kst(), q: `단골${tag}` });
  check('매출 메모 검색 → 1건', r.json.data.length === 1 && r.json.data[0].id === s1.sale_id, `n=${r.json.data.length}`);
  r = await S({ from_date: kst(), to_date: kst(), q: `배추${tag}`, limit: 50 });
  check('매출 품목 검색 → total 2', r.json.total === 2, `t=${r.json.total}`);
  r = await S({ unpaid_only: 1, q: `무${tag}` });
  check('매출 미수만 + 검색 → 1건', r.json.data.length === 1, `n=${r.json.data.length}`);
  r = await S({ from_date: kst(), to_date: kst(), q: `단골${tag}` }, B);
  check('매출 B 회원 → A 매출 안 보임', r.json.data.length === 0, `n=${r.json.data.length}`);
  r = await S({ limit: 'x' });
  check('매출 잘못된 limit → 400', r.status === 400, `status=${r.status}`);

  // ---- 수금 2건(메모 하나)
  const sales = (await S({ unpaid_only: 1 })).json.data;
  await mustOk(await call('POST', '/api/payments', { partner_id: G.id, amount: 1000, paid_at: kst(), memo: `계좌${tag}`, allocations: [{ sale_id: sales[0].id, amount: 1000 }] }, A), '수금');
  await mustOk(await call('POST', '/api/payments', { partner_id: G.id, amount: 500, paid_at: kst(), allocations: [{ sale_id: sales[0].id, amount: 500 }] }, A), '수금');
  const PY = (q, t = A) => call('GET', `/api/payments?${qs(q)}`, null, t);
  r = await PY({ from_date: kst(), to_date: kst() });
  check('수금 하위호환 — 2건·total 없음', r.json.data.length === 2 && r.json.total === undefined, `n=${r.json.data.length}`);
  r = await PY({ from_date: kst(), to_date: kst(), q: `계좌${tag}`, limit: 50 });
  check('수금 메모 검색 → total 1', r.json.total === 1 && r.json.data.length === 1, `t=${r.json.total}`);
  r = await PY({ from_date: kst(), to_date: kst(), q: `가락상회${tag}`, limit: 1, offset: 1 });
  check('수금 거래처 이름 검색 + 2쪽 → total 2, 1건', r.json.total === 2 && r.json.data.length === 1, `t=${r.json.total}`);
  r = await PY({ q: `계좌${tag}` }, B);
  check('수금 B 회원 → 0건', r.json.data.length === 0, `n=${r.json.data.length}`);

  // ---- 폐기 2건
  await mustOk(await call('POST', '/api/disposals', { product_id: cabbage.id, quantity: 1, disposal_date: kst(), reason: '시듦', memo: `창고A${tag}` }, A), '폐기');
  await mustOk(await call('POST', '/api/disposals', { product_id: radish.id, quantity: 1, disposal_date: kst(), reason: '파손' }, A), '폐기');
  const D = (q, t = A) => call('GET', `/api/disposals?${qs(q)}`, null, t);
  r = await D({ from_date: kst(), to_date: kst() });
  check('폐기 하위호환 — 2건·total 없음', r.json.data.length === 2 && r.json.total === undefined, `n=${r.json.data.length}`);
  r = await D({ from_date: kst(), to_date: kst(), q: '파손', limit: 50 });
  check('폐기 사유 검색 → total 1', r.json.total === 1, `t=${r.json.total}`);
  r = await D({ from_date: kst(), to_date: kst(), q: `창고A${tag}` });
  check('폐기 메모 검색 → 1건', r.json.data.length === 1, `n=${r.json.data.length}`);
  r = await D({ from_date: kst(), to_date: kst(), q: '파손' }, B);
  check('폐기 B 회원 → 0건', r.json.data.length === 0, `n=${r.json.data.length}`);

  // ---- 재고: A는 배추·무·특가 3품목
  const I = (q, t = A) => call('GET', `/api/inventory${Object.keys(q).length ? '?' + qs(q) : ''}`, null, t);
  r = await I({});
  const invAll = r.json.data;
  check('재고 하위호환 — 3품목·total 없음', invAll.length === 3 && r.json.total === undefined, `n=${invAll.length}`);
  r = await I({ q: `무${tag}` });
  check('재고 품목 검색 → 1건', r.json.data.length === 1 && r.json.data[0].product_id === radish.id, `n=${r.json.data.length}`);
  r = await I({ partner_id: H.id });
  check('재고 최근 매입 거래처 H → 무·특가 2건', r.json.data.length === 2, `n=${r.json.data.length}`);
  r = await I({ limit: 2, offset: 2 });
  check('재고 페이지 2쪽 → 1건·total 3', r.json.data.length === 1 && r.json.total === 3, `n=${r.json.data.length} t=${r.json.total}`);
  r = await I({ partner_id: '0' });
  check('재고 partner_id 0 → 400', r.status === 400, `status=${r.status}`);
  r = await I({ q: `무${tag}` }, B);
  check('재고 B 회원 → A 재고 안 보임', r.json.data.length === 0, `n=${r.json.data.length}`);

  // ---- SQL 인젝션 모양 검색어 — 오류 없이 0건
  r = await P({ ...range, q: `'; DROP TABLE purchase; --` });
  check('인젝션 모양 검색어 → 200·0건', r.status === 200 && r.json.data.length === 0, `status=${r.status}`);

  await pool.end();
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n[list-search-test] PASS ${results.length - fail} / FAIL ${fail} (총 ${results.length})`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('[list-search-test] 오류:', e);
  process.exit(1);
});
