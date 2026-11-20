/**
 * T-401 10장 생산자·원산지·지급 대상 검사 — 설계 `T-401_정산할인상계_설계.md` 10.6 AC-401-40~49 (50은 캡처, 48은 023 전후 비교 증거)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> SETTLE_API_BASE=http://127.0.0.1:<포트> node scripts/producer-origin-test.js
 * 전제: 마이그레이션 001~023, 서버 기동. 테스트 DB 전용 — 새 회원(t401p_<태그>)을 DB에 직접 만들고 거래는 API로 만든다.
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.SETTLE_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[producer-origin-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}

function request(method, p, body, token) {
  const u = new URL(p, BASE);
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
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
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}`);
}
function mustOk(r, what) {
  if (r.status >= 300 || !r.json?.ok) throw new Error(`${what} 실패 status=${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}
const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const n = (v) => Number(v ?? 0);

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  const pw = crypto.randomBytes(12).toString('hex');
  const agent = `t401p_${tag}`;
  const uid = (await q(
    `INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
     VALUES ($1, $2, $3, $4, NOW(), 'active', false) RETURNING id`,
    [`생산자검사 ${tag}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
  ))[0].id;
  const A = (await request('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
  if (!A) throw new Error('주인 로그인 실패');
  const a = (m, p, b) => request(m, p, b, A);
  const staffTok = async (loginId, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    mustOk(await a('POST', '/api/staff', { login_id: loginId, name: `직원${loginId}`, role, temp_password: spw }), `직원 ${loginId}`);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [uid, loginId]);
    return (await request('POST', '/api/auth/login', { agent_no: agent, login_id: loginId, password: spw })).json.token;
  };
  const SI = await staffTok('in1', 'input');
  const SV = await staffTok('vw1', 'view');
  const prod = (await q(`INSERT INTO product (name, unit) VALUES ($1, '박스') RETURNING id`, [`배추_${tag}`]))[0].id;
  const partners = async (tok = A) => Object.fromEntries(mustOk(await request('GET', '/api/partners', null, tok), '거래처').map((p) => [p.id, p]));

  // AC-401-40 enum
  const en = (await q(`SELECT enum_range(NULL::partner_type)::text AS r`))[0].r;
  check('AC-401-40 partner_type 에 producer 있음', /producer/.test(en), en);

  // AC-401-41 생산자 등록·계좌 검사
  const kim = await a('POST', '/api/partners', { name: `김농부_${tag}`, type: 'producer', origin_region: '해남군', bank_name: '농협', bank_account: '301-1234-5678-91', bank_holder: '김농부' });
  const part = await a('POST', '/api/partners', { name: `반쪽_${tag}`, type: 'producer', bank_name: '농협', bank_account: '1234' });
  const letters = await a('POST', '/api/partners', { name: `문자_${tag}`, type: 'producer', bank_name: '농협', bank_account: '12ab-34', bank_holder: '홍' });
  check('AC-401-41 생산자 201(산지·계좌) / 계좌 일부만 400 field=bank_account / 계좌에 문자 400 field=bank_account',
    kim.status === 201 && kim.json.data.type === 'producer' && kim.json.data.origin_region === '해남군' && kim.json.data.bank_account === '301-1234-5678-91'
      && part.status === 400 && part.json.field === 'bank_account' && letters.status === 400 && letters.json.field === 'bank_account',
    { kim: kim.json, part: part.json, letters: letters.json });
  const KIM = kim.json.data.id;
  const SEOUL = mustOk(await a('POST', '/api/partners', { name: `서울청과_${tag}`, type: 'supplier' }), '서울청과').id;
  const S2 = mustOk(await a('POST', '/api/partners', { name: `대아청과_${tag}`, type: 'supplier' }), '대아청과').id;
  const HANARO = mustOk(await a('POST', '/api/partners', { name: `하나로_${tag}`, type: 'customer' }), '하나로').id;
  const CUST = HANARO;

  // AC-401-42 기본 지급 대상 = 제공처, 산지 복사
  const p42 = await a('POST', '/api/purchases', { partner_id: SEOUL, product_id: prod, quantity: 10, unit_price: 1000, purchase_date: TODAY, producer_id: KIM });
  let P = await partners();
  const row42 = (await q(`SELECT payee_partner_id, origin_region, producer_id FROM purchase WHERE id = $1`, [p42.json?.data?.id]))[0];
  check('AC-401-42 생산자만 넣은 매입 → payee=서울청과, 산지 해남군 복사, 서울청과 미지급 10,000·김농부 0',
    p42.status === 201 && row42.payee_partner_id === SEOUL && row42.origin_region === '해남군' && n(P[SEOUL].payable_amount) === 10000 && n(P[KIM].payable_amount) === 0,
    { p42: p42.json, row42, s: P[SEOUL].payable_amount, k: P[KIM].payable_amount });

  // AC-401-43 지급 대상 = 생산자
  const p43 = await a('POST', '/api/purchases', { partner_id: SEOUL, product_id: prod, quantity: 30, unit_price: 1000, purchase_date: TODAY, producer_id: KIM, payee: 'producer' });
  const e1 = await a('POST', '/api/purchases', { partner_id: SEOUL, product_id: prod, quantity: 1, unit_price: 1, purchase_date: TODAY, payee: 'producer' });
  const e2 = await a('POST', '/api/purchases', { partner_id: SEOUL, product_id: prod, quantity: 1, unit_price: 1, purchase_date: TODAY, producer_id: CUST });
  P = await partners();
  const kimLed = mustOk(await a('GET', `/api/partners/${KIM}/payable-ledger`), '김농부 지급 원장');
  check('AC-401-43 payee=producer 30,000 → 김농부 지급 원장 +30,000·서울청과 그대로 10,000 / producer 없이 payee=producer 400 field=payee / customer 를 producer_id 로 400 field=producer_id',
    p43.status === 201 && n(kimLed.closing_balance) === 30000 && n(P[SEOUL].payable_amount) === 10000 && n(P[KIM].payable_amount) === 30000
      && e1.status === 400 && e1.json.field === 'payee' && e2.status === 400 && e2.json.field === 'producer_id',
    { p43: p43.status, kim: kimLed.closing_balance, s: P[SEOUL].payable_amount, e1: e1.json, e2: e2.json });
  const P43 = p43.json.data.id;

  // AC-401-44 김농부 지급 25,000 + 할인 5,000
  const dashBefore = mustOk(await a('GET', '/api/dashboard'), '대시보드 전');
  const py = await a('POST', '/api/supplier-payments', { partner_id: KIM, kind: 'pay', amount: 25000 });
  const pd = await a('POST', '/api/supplier-payments', { partner_id: KIM, kind: 'discount', amount: 5000 });
  P = await partners();
  const dash = mustOk(await a('GET', '/api/dashboard'), '대시보드');
  check('AC-401-44 김농부 지급 25,000 + 할인 5,000 → 김농부 미지급 0, 오늘 현금 지급 +25,000·매입 할인 +5,000, 서울청과 장부 그대로',
    py.status === 201 && pd.status === 201 && n(P[KIM].payable_amount) === 0 && n(P[SEOUL].payable_amount) === 10000
      && n(dash.today.pay_amount) - n(dashBefore.today.pay_amount) === 25000 && n(dash.today.pay_discounts.amount) - n(dashBefore.today.pay_discounts?.amount) === 5000
      && py.json.data.allocations[0].purchase_id === P43,
    { py: py.json, pd: pd.status, P: [P[KIM].payable_amount, P[SEOUL].payable_amount], today: dash.today });

  // AC-401-45 제공처가 대아청과지만 지급 대상이 모두 김농부인 매입만 → 대아청과로 지급 400 NOTHING_TO_PAY
  mustOk(await a('POST', '/api/purchases', { partner_id: S2, product_id: prod, quantity: 5, unit_price: 1000, purchase_date: TODAY, producer_id: KIM, payee: 'producer' }), '대아 매입');
  const n45 = await a('POST', '/api/supplier-payments', { partner_id: S2, kind: 'pay', amount: 100 });
  check('AC-401-45 지급 대상이 모두 생산자인 제공처로 지급 → 400 NOTHING_TO_PAY', n45.status === 400 && n45.json.code === 'NOTHING_TO_PAY', n45.json);

  // AC-401-46 지급 있는 매입: 지급 대상 변경 409, 산지 수정 200
  const c1 = await a('PATCH', `/api/purchases/${P43}`, { reason: '지급 대상 변경', changes: { payee: 'supplier' } });
  const c2 = await a('PATCH', `/api/purchases/${P43}`, { reason: '산지 정정', changes: { origin_region: '영암군' } });
  const corr = await q(`SELECT changed_fields FROM trade_correction WHERE target_type = 'purchase' AND target_id = $1 ORDER BY id DESC LIMIT 1`, [P43]);
  check('AC-401-46 지급 있는 매입 payee 변경 409 PURCHASE_HAS_PAYMENT / 산지 수정 200, 정정 기록에 origin_region',
    c1.status === 409 && c1.json.code === 'PURCHASE_HAS_PAYMENT' && c2.status === 200 && (corr[0]?.changed_fields || []).includes('origin_region'),
    { c1: c1.json, c2: c2.json?.message, corr });

  // AC-401-47 계좌 마스킹
  const PA = await partners(A);
  const PI = await partners(SI);
  const PV = await partners(SV);
  const hist = mustOk(await a('GET', '/api/history?kind=partner&limit=50'), '이력');
  const histKim = hist.filter((h) => h.target_id === KIM);
  const histText = JSON.stringify(histKim);
  check('AC-401-47 주인 전체 계좌, 입력·조회 직원 뒤 4자리(****7891), 이력에도 전체 번호 없음',
    PA[KIM].bank_account === '301-1234-5678-91' && PI[KIM].bank_account === '****7891' && PV[KIM].bank_account === '****7891'
      && histKim.length >= 1 && !histText.includes('301-1234-5678-91') && histText.includes('****7891'),
    { a: PA[KIM].bank_account, i: PI[KIM].bank_account, v: PV[KIM].bank_account, histText: histText.slice(0, 300) });

  // AC-401-49 원산지 따라가기: 김농부 매입분(P43, 영암군)·P42(해남군)에서 FIFO 로 하나로 판매
  const prev = mustOk(await a('GET', `/api/inventory/${prod}/fifo-preview?quantity=15&unit_price=1500&sale_date=${TODAY}`), 'FIFO 미리보기');
  const fs = await a('POST', '/api/sales', { partner_id: HANARO, sale_date: TODAY, items: [{ product_id: prod, quantity: 15, unit_price: 1500 }] });
  const st = mustOk(await a('GET', `/api/sales/statement?partner_id=${HANARO}&from_date=${TODAY}&to_date=${TODAY}`), '명세서');
  const led = mustOk(await a('GET', `/api/partners/${HANARO}/ledger`), '원장');
  const lot0 = prev.allocations?.[0] || {};
  const origins = st.items?.[0]?.origins || [];
  const saleRow = led.entries.find((e) => e.kind === 'sale');
  check('AC-401-49 FIFO 미리보기 로트 생산자·산지, 명세서 품목 줄 origins, 원장 매출 설명 "산지 …"',
    fs.status === 201 && lot0.producer_name === `김농부_${tag}` && lot0.origin_region === '해남군'
      && origins.some((o) => o.producer_name === `김농부_${tag}` && o.origin_region === '해남군')
      && /산지 (해남군|영암군)/.test(saleRow?.description || ''),
    { fs: fs.status, lot0, origins, desc: saleRow?.description });

  await pool.end();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[producer-origin-test] PASS ${pass} / FAIL ${results.length - pass} (총 ${results.length})`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[producer-origin-test] 오류:', e);
  process.exit(1);
});
