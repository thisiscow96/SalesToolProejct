/**
 * T-207 거래처 외상 한도 경고 검사 — 한도 없음 / 이하 / 경계(같음) / 초과 / 확인 후 저장 / 권한
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> CREDIT_API_BASE=http://127.0.0.1:<포트> node scripts/credit-limit-test.js
 * 전제: 마이그레이션 001~018(017 없어도 됨), 서버 기동. 테스트 DB 전용 — 회원 A·B(t207a_/t207b_<태그>)·상품을 DB에 직접 만들고
 *       거래는 API로 만든다. 다른 검사의 기대값에 영향을 주지 않게 새 회원 안에서만 움직인다.
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.CREDIT_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[credit-limit-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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
          try {
            json = JSON.parse(raw);
          } catch {
            /* JSON 아님 */
          }
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
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
}
async function mustOk(r, what) {
  if (r.status >= 300 || !r.json?.ok) throw new Error(`${what} 실패 status=${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}
async function login(agentNo, password) {
  const r = await request('POST', '/api/auth/login', { agent_no: agentNo, password });
  if (r.status !== 200 || !r.json?.token) throw new Error(`로그인 실패 ${agentNo} status=${r.status}`);
  return r.json.token;
}
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const TODAY = kstToday();

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const mkUser = async (prefix) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const agent = `${prefix}_${tag}`;
    await pool.query(
      `INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
       VALUES ($1, $2, $3, $4, NOW(), 'active', false)`,
      [`한도검사 ${prefix}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
    );
    return login(agent, pw);
  };
  const A = await mkUser('t207a');
  const B = await mkUser('t207b');
  const api = (tok) => (m, p, b) => request(m, p, b, tok);
  const a = api(A);
  const b = api(B);

  // ---------- 0. 마이그레이션 018 ----------
  const col = await pool.query(
    `SELECT data_type, numeric_precision, numeric_scale, is_nullable FROM information_schema.columns
      WHERE table_name = 'account' AND column_name = 'credit_limit'`
  );
  check('M-01 account.credit_limit 열 NUMERIC(14,2) NULL 허용', col.rows[0]?.numeric_precision === 14 && col.rows[0]?.numeric_scale === 2 && col.rows[0]?.is_nullable === 'YES', col.rows[0]);
  const neg = await pool.query(`UPDATE account SET credit_limit = -1 WHERE false`).then(() => null);
  void neg;
  let chk = null;
  try {
    await pool.query(`INSERT INTO account (user_id, name, type, credit_limit) SELECT id, 'neg_${tag}', 'customer', -1 FROM "user" WHERE agent_no = $1`, [`t207a_${tag}`]);
  } catch (e) {
    chk = e.code;
  }
  check('M-02 음수 한도는 DB CHECK(23514)로 막힘', chk === '23514', chk);

  // ---------- 1. 거래처 한도 입력·검증 ----------
  const sup = await mustOk(await a('POST', '/api/partners', { name: `매입처_${tag}`, type: 'supplier' }), '매입처');
  const noLim = await mustOk(await a('POST', '/api/partners', { name: `한도없음_${tag}`, type: 'customer' }), '한도없음');
  check('P-01 한도 안 넣고 등록 → credit_limit null', noLim.credit_limit === null, noLim);
  const lim = await mustOk(await a('POST', '/api/partners', { name: `한도만원_${tag}`, type: 'customer', credit_limit: '10,000' }), '한도 1만');
  check('P-02 콤마 넣은 한도 "10,000" → 10000 저장', Number(lim.credit_limit) === 10000, lim);
  const zero = await mustOk(await a('POST', '/api/partners', { name: `외상없음_${tag}`, type: 'same_market', credit_limit: 0 }), '한도 0');
  check('P-03 한도 0(외상 없음) 저장', Number(zero.credit_limit) === 0, zero);
  const big = await mustOk(await a('POST', '/api/partners', { name: `한도큼_${tag}`, type: 'customer', credit_limit: '' }), '빈 한도');
  check('P-04 빈 문자열 한도 → null(한도 없음)', big.credit_limit === null, big);
  for (const [i, bad] of [['abc', 'abc'], ['-5', -5], ['1.234', '1.234'], ['13자리', '1234567890123']].entries()) {
    const r = await a('POST', '/api/partners', { name: `bad${i}_${tag}`, type: 'customer', credit_limit: bad[1] });
    check(`P-05.${i + 1} 잘못된 한도(${bad[0]}) → 400`, r.status === 400 && /외상 한도/.test(r.json?.message || ''), r);
  }
  const put1 = await a('PUT', `/api/partners/${big.id}`, { credit_limit: 50000 });
  check('P-06 PUT 으로 한도 넣기 → 50000', put1.status === 200 && Number(put1.json.data.credit_limit) === 50000, put1);
  const put2 = await a('PUT', `/api/partners/${big.id}`, { credit_limit: null });
  check('P-07 PUT credit_limit null → 한도 없앰', put2.status === 200 && put2.json.data.credit_limit === null, put2);
  const put3 = await a('PUT', `/api/partners/${big.id}`, { memo: '메모만' });
  check('P-08 다른 칸만 고치면 한도는 그대로(null)', put3.status === 200 && put3.json.data.credit_limit === null, put3);
  const list = await mustOk(await a('GET', '/api/partners'), '목록');
  check('P-09 거래처 목록에 credit_limit 포함', Number(list.find((x) => x.id === lim.id)?.credit_limit) === 10000 && list.find((x) => x.id === noLim.id)?.credit_limit === null);

  // ---------- 권한 ----------
  const pb = await b('PUT', `/api/partners/${lim.id}`, { credit_limit: 1 });
  check('S-01 남의 거래처 한도 수정 → 404', pb.status === 404, pb);
  const after = await pool.query('SELECT credit_limit FROM account WHERE id = $1', [lim.id]);
  check('S-02 남의 수정 시도 후에도 한도 그대로 10000', Number(after.rows[0].credit_limit) === 10000);
  const un = await request('PUT', `/api/partners/${lim.id}`, { credit_limit: 1 });
  check('S-03 로그인 없이 한도 수정 → 401', un.status === 401, un);
  const bl = await b('GET', `/api/partners/${lim.id}/ledger`);
  check('S-04 남의 거래처 원장(한도 포함) → 404', bl.status === 404, bl);

  // ---------- 2. 재고 준비 ----------
  const mkProd = async (name) => (await pool.query(`INSERT INTO product (name, unit) VALUES ($1, '박스') RETURNING id`, [`${name}_${tag}`])).rows[0].id;
  const p1 = await mkProd('배추');
  const p2 = await mkProd('무');
  const buy = async (productId, qty) =>
    (await mustOk(await a('POST', '/api/purchases', { partner_id: sup.id, product_id: productId, quantity: qty, unit_price: 100, purchase_date: TODAY }), '매입')).id;
  const pu1 = await buy(p1, 1000);
  await buy(p2, 1000);
  const salesOf = async (pid) => Number((await pool.query('SELECT COUNT(*) FROM sale WHERE partner_id = $1', [pid])).rows[0].count);
  const invOf = async (prod) => Number((await pool.query('SELECT quantity FROM inventory WHERE product_id = $1', [prod])).rows[0].quantity);
  const conv = (partnerId, qty, price, extra = {}) =>
    a('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: pu1, partner_id: partnerId, quantity: qty, unit_price: price, sale_date: TODAY }], ...extra });

  // ---------- 3. 한도 없음 ----------
  const c0 = await conv(noLim.id, 100, 1000);
  check('C-01 한도 없는 거래처: 큰 매출(10만)도 경고 없이 201', c0.status === 201 && !c0.json.credit_warnings, c0);

  // ---------- 4. 한도 이하·경계·초과 (매출 전환) ----------
  const c1 = await conv(lim.id, 5, 1000);
  check('C-02 한도 1만, 미수 5천 → 경고 없이 201', c1.status === 201 && !c1.json.credit_warnings, c1);
  const c2 = await conv(lim.id, 5, 1000);
  check('C-03 경계: 미수 = 한도(1만) → 넘지 않음, 201', c2.status === 201 && !c2.json.credit_warnings, c2);
  const before = await salesOf(lim.id);
  const invBefore = await invOf(p1);
  const c3 = await conv(lim.id, 1, 0.01);
  const w3 = c3.json?.detail?.credit_warnings?.[0];
  check('C-04 경계+0.01원: 409 CREDIT_LIMIT', c3.status === 409 && c3.json.code === 'CREDIT_LIMIT', c3);
  check('C-05 경고 내용: 한도 10000 · 전 10000 · 후 10000.01 · 초과 0.01', w3 && w3.credit_limit === 10000 && w3.receivable_before === 10000 && w3.receivable_after === 10000.01 && w3.over_amount === 0.01 && w3.partner_id === lim.id, w3);
  check('C-06 409면 저장 안 됨(매출 수 그대로·재고 그대로)', (await salesOf(lim.id)) === before && (await invOf(p1)) === invBefore);
  check('C-07 안내 문구에 거래처 이름·초과 금액', /한도만원_/.test(c3.json?.message || '') && /초과/.test(c3.json?.message || ''), c3.json?.message);
  const c4 = await conv(lim.id, 1, 0.01, { credit_confirmed: true });
  check('C-08 확인 후 저장(credit_confirmed=true) → 201 + credit_warnings', c4.status === 201 && c4.json.credit_warnings?.[0]?.over_amount === 0.01, c4);
  check('C-09 확인 저장 후 매출 1건 늘어남', (await salesOf(lim.id)) === before + 1);

  // 여러 거래처 한 번에: 넘는 곳만 경고
  const c5 = await a('POST', '/api/purchases/convert-to-sales', {
    items: [
      { purchase_id: pu1, partner_id: noLim.id, quantity: 1, unit_price: 500, sale_date: TODAY },
      { purchase_id: pu1, partner_id: zero.id, quantity: 1, unit_price: 500, sale_date: TODAY },
    ],
  });
  check('C-10 한도 0(외상 없음) 거래처에 판매 → 409, 경고는 그 거래처 1곳만', c5.status === 409 && c5.json.detail.credit_warnings.length === 1 && c5.json.detail.credit_warnings[0].partner_id === zero.id, c5);
  check('C-11 한 행이라도 경고면 전체 저장 안 됨(한도 없음 거래처 매출도 안 생김)', (await salesOf(noLim.id)) === 1);

  // ---------- 5. 재고 기준 판매(FIFO) ----------
  const fifoBody = (qty, price, extra = {}) => ({ partner_id: lim.id, sale_date: TODAY, items: [{ product_id: p2, quantity: qty, unit_price: price }], ...extra });
  const f1 = await a('POST', '/api/sales', fifoBody(2, 1000));
  check('F-01 재고 판매로 한도 넘김 → 409 CREDIT_LIMIT', f1.status === 409 && f1.json.code === 'CREDIT_LIMIT' && f1.json.detail.credit_warnings[0].receivable_after === 12000.01, f1);
  const inv2 = await invOf(p2);
  check('F-02 409면 재고 그대로(1000)', inv2 === 1000, inv2);
  const f2 = await a('POST', '/api/sales', fifoBody(2, 1000, { credit_confirmed: true }));
  check('F-03 확인 후 저장 → 201 + credit_warnings', f2.status === 201 && f2.json.credit_warnings?.length === 1, f2);
  const fifoSaleId = f2.json?.data?.sales?.[0]?.sale_id;

  // ---------- 6. 수금 후 한도 안으로 ----------
  const lead = await pool.query(`SELECT id, total_amount FROM sale WHERE partner_id = $1 AND status <> 'cancelled' ORDER BY id`, [lim.id]);
  const firstSale = lead.rows[0];
  await mustOk(
    await a('POST', '/api/payments', { partner_id: lim.id, amount: 5000, paid_at: TODAY, allocations: [{ sale_id: firstSale.id, amount: 5000 }] }),
    '수금'
  );
  // 지금 미수 = 12000.01 − 5000 = 7000.01 → 2999.99 더 팔면 정확히 1만
  const c6 = await conv(lim.id, 1, 2999.99);
  check('R-01 수금 뒤 미수가 줄어 한도 안 판매(미수 = 한도) → 201', c6.status === 201 && !c6.json.credit_warnings, c6);

  // ---------- 7. 매출 수정(T-103) ----------
  // 지금 미수 10000 = 한도. 메모만 고치기(미수 안 늘어남)
  const e1 = await a('PATCH', `/api/sales/${fifoSaleId}`, { reason: '메모 정정', changes: { memo: '메모만' } });
  check('E-01 메모만 고침(미수 그대로) → 200, 경고 없음', e1.status === 200 && !e1.json.credit_warnings, e1);
  const e2 = await a('PATCH', `/api/sales/${fifoSaleId}`, { reason: '수량 늘림', changes: { quantity: 3 } });
  check('E-02 수량 늘려 미수 증가(+1000) → 409 CREDIT_LIMIT', e2.status === 409 && e2.json.code === 'CREDIT_LIMIT' && e2.json.detail.credit_warnings[0].added_amount === 1000, e2);
  const q = await pool.query('SELECT quantity FROM sale WHERE id = $1', [fifoSaleId]);
  check('E-03 409면 수량 그대로(2)', Number(q.rows[0].quantity) === 2);
  const e3 = await a('PATCH', `/api/sales/${fifoSaleId}`, { reason: '수량 늘림', changes: { quantity: 3 }, credit_confirmed: true });
  check('E-04 확인 후 수정 → 200 + credit_warnings', e3.status === 200 && e3.json.credit_warnings?.[0]?.over_amount === 1000, e3);
  const e4 = await a('PATCH', `/api/sales/${fifoSaleId}`, { reason: '수량 줄임', changes: { quantity: 2.5 } });
  check('E-05 이미 넘은 거래처라도 미수가 줄면 경고 없음 → 200', e4.status === 200 && !e4.json.credit_warnings, e4);
  // 판매처를 한도 0 거래처로 바꾸기
  const noLimSale = (await pool.query(`SELECT id FROM sale WHERE partner_id = $1 ORDER BY id LIMIT 1`, [noLim.id])).rows[0].id;
  const e5 = await a('PATCH', `/api/sales/${noLimSale}`, { reason: '판매처 정정', changes: { partner_id: zero.id } });
  check('E-06 판매처를 한도 0 거래처로 바꿈 → 409(새 판매처 기준)', e5.status === 409 && e5.json.detail.credit_warnings[0].partner_id === zero.id, e5);
  const e6 = await b('PATCH', `/api/sales/${fifoSaleId}`, { reason: 'x', changes: { quantity: 9 }, credit_confirmed: true });
  check('S-05 남의 매출 수정(확인 플래그 붙여도) → 404', e6.status === 404, e6);

  // ---------- 8. 원장 · 대시보드 ----------
  const led = await mustOk(await a('GET', `/api/partners/${lim.id}/ledger`), '원장');
  check('L-01 원장 credit: 한도 10000 · 사용 10500 · 사용률 105% · over', led.credit && led.credit.credit_limit === 10000 && led.credit.receivable === 10500 && led.credit.usage_pct === 105 && led.credit.over === true && led.credit.over_amount === 500, led.credit);
  check('L-02 원장 partner 모양은 그대로(credit_limit 키 없음)', led.partner && !('credit_limit' in led.partner), led.partner);
  const led0 = await mustOk(await a('GET', `/api/partners/${noLim.id}/ledger`), '원장0');
  check('L-03 한도 없는 거래처 원장 credit = null', led0.credit === null, led0.credit);
  const ledZ = await mustOk(await a('GET', `/api/partners/${zero.id}/ledger`), '원장Z');
  check('L-04 한도 0·미수 0 → usage_pct null, over false', ledZ.credit && ledZ.credit.usage_pct === null && ledZ.credit.over === false, ledZ.credit);
  const ledS = await mustOk(await a('GET', `/api/partners/${sup.id}/ledger`), '원장S');
  check('L-05 매입처(받을 돈 장부 없음) credit = null', ledS.credit === null, ledS.credit);

  const dash = await mustOk(await a('GET', '/api/dashboard'), '대시보드');
  const ol = dash.over_limit_partners;
  check('D-01 대시보드 한도 넘은 거래처 1곳(한도만원)', ol && ol.count === 1 && ol.items[0].partner_id === lim.id && ol.items[0].over_amount === 500, ol);
  // 한도를 올리면 사라진다
  await mustOk(await a('PUT', `/api/partners/${lim.id}`, { credit_limit: 20000 }), '한도 올림');
  const dash2 = await mustOk(await a('GET', '/api/dashboard'), '대시보드2');
  check('D-02 한도 올린 뒤 대시보드 0곳', dash2.over_limit_partners.count === 0 && dash2.over_limit_partners.items.length === 0, dash2.over_limit_partners);
  await mustOk(await a('PUT', `/api/partners/${lim.id}`, { credit_limit: 10000 }), '한도 되돌림');
  const dashB = await mustOk(await b('GET', '/api/dashboard'), '대시보드B');
  check('S-06 다른 회원 대시보드에는 남의 한도 초과 거래처가 안 보임', dashB.over_limit_partners.count === 0, dashB.over_limit_partners);

  await pool.end();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[credit-limit-test] ${pass}/${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('[credit-limit-test] 오류:', e);
  process.exit(1);
});
