/**
 * T-216 개인 품목·공용 등록 요청 검사 (권한 · 승격 · 중복 · 동시성 · 016 재실행)
 * 사용: server 폴더에서
 *   DATABASE_URL=<테스트 DB> PRODUCT_REQ_API_BASE=http://127.0.0.1:<포트> node scripts/product-request-test.js
 * 전제: 마이그레이션 001~016, seed-admin(admin001/sample 또는 SMOKE_PASSWORD), 서버 기동.
 * 테스트 DB 전용 — 중매인 B·C 를 DB에 직접 만들고(비밀번호는 실행마다 임의값) 품목·거래처·매입을 새로 등록한다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.PRODUCT_REQ_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[product-request-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}

function request(method, p, body, token) {
  const u = new URL(p, BASE);
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
function check(id, name, cond, detail) {
  results.push({ id, name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${id} ${name}${cond ? '' : ' — ' + detail}`);
}
async function login(agentNo, password) {
  const r = await request('POST', '/api/auth/login', { agent_no: agentNo, password });
  if (r.status !== 200 || !r.json?.token) throw new Error(`로그인 실패 ${agentNo} status=${r.status}`);
  return r.json.token;
}
function mustOk(r, what) {
  if (r.status >= 300 || !r.json?.ok) throw new Error(`${what} 실패 status=${r.status} ${r.json?.message || ''}`);
  return r.json.data;
}
const ids = (rows) => new Set((rows || []).map((x) => x.id));

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const admin = await login('admin001', process.env.SMOKE_PASSWORD || 'sample');
  const mkUser = async (suffix) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const agent = `t216_${suffix}_${tag}`;
    await pool.query(
      `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
       VALUES ($1, NULL, $2, $3, $4, NOW(), 'active', false)`,
      [`T216 ${suffix}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
    );
    return login(agent, pw);
  };
  const B = await mkUser('b');
  const C = await mkUser('c');
  const partnerB = mustOk(await request('POST', '/api/partners', { name: `T216-PB-${tag}`, type: 'supplier' }, B), '거래처 B');
  const partnerC = mustOk(await request('POST', '/api/partners', { name: `T216-PC-${tag}`, type: 'supplier' }, C), '거래처 C');
  const buy = (token, partner, productId, date = '2026-10-05') =>
    request('POST', '/api/purchases', { partner_id: partner.id, product_id: productId, quantity: 2, unit_price: 1000, purchase_date: date }, token);
  const list = async (token, q = '') => (await request('GET', `/api/products${q}`, null, token)).json?.data || [];

  // ── 1. 개인 품목 만들기와 보이는 범위 ──
  let r = await request('POST', '/api/products/personal', { name: `T216-망고-${tag}`, unit: 'box' });
  check('PR-01', '토큰 없이 개인 품목 추가 → 401', r.status === 401, `status=${r.status}`);
  r = await request('POST', '/api/products/personal', { name: '   ' }, B);
  check('PR-02', '빈 품목명 → 400', r.status === 400, `status=${r.status}`);
  r = await request('POST', '/api/products/personal', { name: `T216-망고-${tag}`, unit: 'box' }, B);
  const mango = r.json?.data;
  check('PR-03', 'B 개인 품목 추가 → 201·is_personal', r.status === 201 && mango?.is_personal === true && !!mango.product_key, `status=${r.status} ${JSON.stringify(r.json)}`);
  check('PR-04', 'B 목록에 내 개인 품목이 보인다', ids(await list(B)).has(mango.id), '없음');
  check('PR-05', 'C 목록에 B 개인 품목이 안 보인다', !ids(await list(C)).has(mango.id), '보임');
  check('PR-06', '토큰 없는 목록(공용만)에 안 보인다', !ids(await list(null)).has(mango.id), '보임');
  check('PR-07', '관리자 상품 마스터(scope=public)에 안 보인다', !ids(await list(admin, '?scope=public')).has(mango.id), '보임');
  check('PR-08', '관리자 일반 목록에도 남의 개인 품목은 안 보인다', !ids(await list(admin)).has(mango.id), '보임');
  check('PR-09', 'B scope=personal 은 개인 품목만', (await list(B, '?scope=personal')).every((p) => p.is_personal), '공용 섞임');
  r = await request('GET', `/api/products?name=${encodeURIComponent('망고-' + tag)}`, null, C);
  check('PR-10', 'C 이름 검색으로도 B 개인 품목이 안 나온다', r.status === 200 && r.json.data.length === 0, `n=${r.json?.data?.length}`);

  // ── 2. 남의 개인 품목 사용 금지 ──
  r = await buy(B, partnerB, mango.id);
  const purchaseB = r.json?.data;
  check('PR-11', 'B 가 자기 개인 품목으로 매입 → 201', r.status === 201, `status=${r.status} ${r.json?.message}`);
  r = await buy(C, partnerC, mango.id);
  check('PR-12', 'C 가 B 개인 품목으로 매입 → 400(없음과 같게)', r.status === 400, `status=${r.status}`);
  const pubApple = mustOk(await request('POST', '/api/products', { name: `T216-사과-${tag}`, unit: 'kg' }, admin), '공용 사과');
  const pc = mustOk(await buy(C, partnerC, pubApple.id), 'C 공용 매입');
  const pcId = pc?.id ?? pc?.purchase_id;
  r = await request('PATCH', `/api/purchases/${pcId}`, { reason: 'T216 권한 검사', changes: { product_id: mango.id } }, C);
  check('PR-13', 'C 가 매입 정정으로 품목을 B 개인 품목으로 바꾸기 → 400 상품 없음', r.status === 400 && /상품을 찾을 수 없습니다/.test(r.json?.message || ''), `status=${r.status} ${r.json?.message}`);
  r = await request('POST', '/api/products/requests', { product_id: mango.id }, C);
  check('PR-14', 'C 가 B 개인 품목을 공용 요청 → 404', r.status === 404, `status=${r.status}`);
  r = await request('POST', '/api/products/requests', { product_id: pubApple.id }, B);
  check('PR-15', '공용 품목을 요청 → 404', r.status === 404, `status=${r.status}`);
  const invC = (await request('GET', '/api/inventory', null, C)).json?.data || [];
  check('PR-16', 'C 재고에 B 개인 품목 없음', !invC.some((x) => x.product_id === mango.id), '있음');

  // ── 3. 이름 중복 규칙 ──
  r = await request('POST', '/api/products/personal', { name: `  t216-망고-${tag.toUpperCase()}  ` }, B);
  check('PR-17', '같은 중매인 같은 이름(대소문자·공백만 다름) → 409 DUPLICATE_PERSONAL', r.status === 409 && r.json?.code === 'DUPLICATE_PERSONAL', `status=${r.status} ${r.json?.code}`);
  r = await request('POST', '/api/products/personal', { name: `T216-망고-${tag}`, unit: 'kg' }, C);
  const mangoC = r.json?.data;
  check('PR-18', '다른 중매인은 같은 이름 개인 품목 가능 → 201', r.status === 201 && mangoC?.id !== mango.id, `status=${r.status}`);
  r = await request('POST', '/api/products/personal', { name: `  t216-사과-${tag.toUpperCase()}   ` }, B);
  const dupNameOk = r.status === 409 && r.json?.code === 'DUPLICATE_PUBLIC' && r.json?.product?.id === pubApple.id;
  check('PR-19', '공용과 같은 이름(공백·대소문자 차이) → 409 DUPLICATE_PUBLIC + 공용 품목 안내', dupNameOk, `status=${r.status} ${JSON.stringify(r.json)}`);
  const [c1, c2] = await Promise.all([
    request('POST', '/api/products/personal', { name: `T216-동시-${tag}` }, B),
    request('POST', '/api/products/personal', { name: `T216-동시-${tag}` }, B),
  ]);
  const st = [c1.status, c2.status].sort();
  check('PR-20', '같은 이름 동시 추가 2건 → 201 하나·409 하나', st[0] === 201 && st[1] === 409, `status=${st}`);

  // ── 4. 요청 → 승인(승격) ──
  r = await request('POST', '/api/products/requests', { product_id: mango.id, note: '자주 들어옴' }, B);
  const reqMango = r.json?.data;
  check('PR-21', 'B 공용 등록 요청 → 201 pending', r.status === 201 && reqMango?.status === 'pending', `status=${r.status}`);
  r = await request('POST', '/api/products/requests', { product_id: mango.id }, B);
  check('PR-22', '같은 품목 두 번 요청 → 409 ALREADY_PENDING', r.status === 409 && r.json?.code === 'ALREADY_PENDING', `status=${r.status}`);
  const bList = (await list(B)).find((p) => p.id === mango.id);
  check('PR-23', 'B 목록에 요청 상태 pending 표시', bList?.request_status === 'pending', `${bList?.request_status}`);
  r = await request('POST', `/api/products/requests/${reqMango.id}/approve`, {}, B);
  check('PR-24', '중매인이 승인 → 403', r.status === 403, `status=${r.status}`);
  r = await request('POST', `/api/products/requests/${reqMango.id}/reject`, { reason: 'x' }, C);
  check('PR-25', '중매인이 반려 → 403', r.status === 403, `status=${r.status}`);
  r = await request('GET', '/api/products/requests', null, C);
  check('PR-26', 'C 요청 목록에 B 요청 없음', r.status === 200 && !r.json.data.some((x) => x.id === reqMango.id), `status=${r.status}`);
  r = await request('GET', '/api/products/requests', null, B);
  const bReq = r.json?.data?.find((x) => x.id === reqMango.id);
  check('PR-27', 'B 요청 목록에 내 요청 있음(관리자 전용 열 없음)', !!bReq && bReq.requester_agent_no === undefined, JSON.stringify(bReq));
  r = await request('GET', '/api/products/requests', null, admin);
  const aReq = r.json?.data?.find((x) => x.id === reqMango.id);
  check('PR-28', '관리자 대기 목록에 요청·매입 건수 1', !!aReq && aReq.purchase_count === 1 && aReq.duplicate_public_id === null, JSON.stringify(aReq));
  r = await request('POST', '/api/products/requests/abc/approve', {}, admin);
  check('PR-29', '잘못된 요청 번호 → 400', r.status === 400, `status=${r.status}`);
  r = await request('POST', `/api/products/requests/${reqMango.id}/approve`, { category_large: '과일' }, admin);
  check('PR-30', '관리자 승인 → 200·공용으로 승격·같은 id', r.status === 200 && r.json?.data?.id === mango.id && r.json.data.is_personal === false && r.json.data.category_large === '과일', `status=${r.status} ${JSON.stringify(r.json)}`);
  const purB = (await request('GET', '/api/purchases?from_date=2026-10-01&to_date=2026-10-31', null, B)).json?.data || [];
  const linked = purB.find((x) => x.product_id === mango.id);
  check('PR-31', '승격 뒤 B 의 기존 매입이 같은 품목에 그대로 연결', !!linked && linked.product_name === `T216-망고-${tag}`, JSON.stringify(purB.slice(0, 2)));
  const invB = (await request('GET', '/api/inventory', null, B)).json?.data || [];
  check('PR-32', '승격 뒤 B 재고 그대로(2)', invB.some((x) => x.product_id === mango.id && Number(x.quantity) === 2), JSON.stringify(invB.filter((x) => x.product_id === mango.id)));
  check('PR-33', '승격 뒤 C·토큰 없는 목록에도 보인다', ids(await list(C)).has(mango.id) && ids(await list(null)).has(mango.id), '안 보임');
  r = await buy(C, partnerC, mango.id);
  check('PR-34', '승격 뒤 C 도 그 품목으로 매입 → 201', r.status === 201, `status=${r.status}`);
  const cOwn = (await list(C, '?scope=personal')).find((p) => p.id === mangoC.id);
  check('PR-35', '승격 뒤 C 의 같은 이름 개인 품목은 그대로 개인', !!cOwn && cOwn.is_personal === true, JSON.stringify(cOwn));
  r = await request('POST', `/api/products/requests/${reqMango.id}/approve`, {}, admin);
  check('PR-36', '이미 승인한 요청 다시 승인 → 409 NOT_PENDING', r.status === 409 && r.json?.code === 'NOT_PENDING', `status=${r.status}`);
  r = await request('POST', '/api/products/personal', { name: `T216-망고-${tag}` }, B);
  check('PR-37', '승격된 이름으로 다시 개인 품목 → 409 DUPLICATE_PUBLIC', r.status === 409 && r.json?.code === 'DUPLICATE_PUBLIC', `status=${r.status} ${r.json?.code}`);

  // ── 5. 반려 ──
  r = await request('POST', '/api/products/personal', { name: `T216-두리안-${tag}`, request_public: true, note: '한 번 써 봄' }, B);
  const durian = r.json?.data;
  const reqDurian = r.json?.request;
  check('PR-38', '추가와 동시에 요청(request_public) → 201 + pending 요청', r.status === 201 && reqDurian?.status === 'pending' && durian?.request_status === 'pending', `status=${r.status}`);
  r = await request('POST', `/api/products/requests/${reqDurian.id}/reject`, { reason: '  ' }, admin);
  check('PR-39', '사유 없이 반려 → 400', r.status === 400, `status=${r.status}`);
  r = await request('POST', `/api/products/requests/${reqDurian.id}/reject`, { reason: '취급 품목 아님' }, admin);
  check('PR-40', '관리자 반려 → 200 rejected', r.status === 200 && r.json?.data?.status === 'rejected', `status=${r.status}`);
  const bDurian = (await list(B)).find((p) => p.id === durian.id);
  check('PR-41', '반려 뒤 B 에게는 개인 품목으로 남고 반려 사유가 보인다', bDurian?.is_personal === true && bDurian.request_status === 'rejected' && bDurian.request_reject_reason === '취급 품목 아님', JSON.stringify(bDurian));
  r = await buy(B, partnerB, durian.id);
  check('PR-42', '반려 뒤에도 B 는 개인 품목으로 매입 가능', r.status === 201, `status=${r.status}`);
  check('PR-43', '반려된 품목은 C 에게 안 보인다', !ids(await list(C)).has(durian.id), '보임');
  r = await request('POST', '/api/products/requests', { product_id: durian.id }, B);
  check('PR-44', '반려 뒤 다시 요청 가능 → 201', r.status === 201, `status=${r.status}`);

  // ── 6. 승인 시 공용 이름 중복 ──
  r = await request('POST', '/api/products/personal', { name: `T216-참외-${tag}`, request_public: true }, B);
  const reqMelon = r.json?.request;
  mustOk(await request('POST', '/api/products', { name: `T216-참외-${tag}`, unit: 'kg' }, admin), '공용 참외');
  r = await request('GET', '/api/products/requests', null, admin);
  const melonRow = r.json?.data?.find((x) => x.id === reqMelon.id);
  check('PR-45', '관리자 목록에 "같은 이름 공용 있음"(duplicate_public_id) 표시', !!melonRow?.duplicate_public_id, JSON.stringify(melonRow));
  r = await request('POST', `/api/products/requests/${reqMelon.id}/approve`, {}, admin);
  check('PR-46', '같은 이름 공용이 있으면 승인 → 409 DUPLICATE_PUBLIC', r.status === 409 && r.json?.code === 'DUPLICATE_PUBLIC', `status=${r.status} ${r.json?.code}`);
  r = await request('POST', `/api/products/requests/${reqMelon.id}/approve`, { name: `T216-참외(성주)-${tag}` }, admin);
  check('PR-47', '관리자가 이름을 다듬어 승인 → 200·새 이름 공용', r.status === 200 && r.json?.data?.name === `T216-참외(성주)-${tag}` && r.json.data.is_personal === false, `status=${r.status}`);

  // ── 7. DB 제약·016 재실행 ──
  let dbErr = null;
  try {
    await pool.query(`INSERT INTO product_request (product_id, user_id, status) VALUES ($1, (SELECT id FROM "user" WHERE agent_no='admin001'), 'rejected')`, [durian.id]);
  } catch (e) { dbErr = e.code; }
  check('PR-48', 'DB: 사유 없는 rejected 행은 CHECK 로 막힘(23514)', dbErr === '23514', `code=${dbErr}`);
  dbErr = null;
  try {
    await pool.query(`INSERT INTO product_request (product_id, user_id) SELECT $1, owner_user_id FROM product WHERE id = $1`, [durian.id]);
  } catch (e) { dbErr = e.code; }
  check('PR-49', 'DB: 같은 품목 대기 요청 2건은 유일 인덱스로 막힘(23505)', dbErr === '23505', `code=${dbErr}`);
  const sql016 = fs.readFileSync(path.join(__dirname, '..', 'migrations', '016_personal_product_request.sql'), 'utf8');
  dbErr = null;
  try { await pool.query(sql016); } catch (e) { dbErr = e.message; }
  check('PR-50', '016 다시 실행해도 오류 없음', dbErr === null, dbErr);

  await pool.end();
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n[product-request-test] ${pass}/${results.length} 통과`);
  if (process.env.PRODUCT_REQ_OUT) fs.writeFileSync(process.env.PRODUCT_REQ_OUT, JSON.stringify({ pass, total: results.length, results }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('[product-request-test] 오류:', e.message);
  process.exit(1);
});
