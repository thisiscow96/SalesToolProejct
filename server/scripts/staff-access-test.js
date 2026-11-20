/**
 * T-213 직원 계정·권한 검사 — 인수 조건 AC-01~35(API 부분) + 역할×라우트 전수 표
 *
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> STAFF_TEST_PORT=<빈 포트> AUTH_SECRET=<32자 이상 테스트값> node scripts/staff-access-test.js
 * 서버를 직접 네 번 띄운다(개발·메일 없음 / 운영 모드·메일 없음 / 로그인 제한 3회 / 가짜 메일 발송). 그 포트에 다른 서버를 띄워 두지 않는다.
 * 실제 메일은 보내지 않는다(메일 수단 환경 변수를 빈 값으로 덮어씀, 가짜 발송은 MAIL_DRY_RUN).
 * 전제: 마이그레이션 001~022(021 포함). 테스트 DB 전용 — 주인 A·B(t213a_/t213b_<태그>)를 DB에 직접 만들고 거래는 API로 만든다.
 * 다른 검사의 기대값에 영향을 주지 않게 새 회원 안에서만 움직인다.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const express = require('express');
const access = require('../lib/access');
const authToken = require('../lib/auth-token');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[staff-access-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}
const PORT = Number(process.env.STAFF_TEST_PORT || 3598);
const SECRET = process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32 ? process.env.AUTH_SECRET : crypto.randomBytes(24).toString('hex');
process.env.AUTH_SECRET = SECRET;

function request(method, p, body, token, port = PORT) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = http.request(
      {
        method,
        hostname: '127.0.0.1',
        port,
        path: p,
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
          resolve({ status: res.statusCode, json, headers: res.headers, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
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
  const d = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + d.slice(0, 400)}`);
}
function mustOk(r, what) {
  if (r.status >= 300 || !r.json || r.json.ok === false) throw new Error(`${what} 실패 status=${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data !== undefined ? r.json.data : r.json;
}
const kst = (d = 0) => new Date(Date.now() + 9 * 3600 * 1000 - d * 86400 * 1000).toISOString().slice(0, 10);
const TODAY = kst();

// ---------- 서버 ----------
let server = null;
async function startServer(extra = {}) {
  const env = {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: DB_URL,
    AUTH_SECRET: SECRET,
    LOGIN_MAX_FAILS: '1000',
    RESEND_API_KEY: '',
    BREVO_API_KEY: '',
    BREVO_FROM: '',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    MAIL_DRY_RUN: '',
    ENABLE_SF_UPLOAD: '',
    NODE_ENV: '',
    EXPOSE_DEV_CODE: '',
    STAFF_INPUT_EXTRA: '',
    STAFF_INPUT_CAN_CONFIRM_CREDIT: '',
    ...extra,
  };
  server = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errText = '';
  server.stdout.on('data', () => {});
  server.stderr.on('data', (c) => (errText += c));
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await request('GET', '/');
      if (r.status < 500) return;
    } catch {
      /* 아직 */
    }
  }
  throw new Error('서버가 뜨지 않음 ' + errText.slice(0, 500));
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((resolve) => {
    s.once('exit', resolve);
    s.kill();
    setTimeout(resolve, 3000);
  });
}

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const creds = {};
  const ids = {};
  const mkUser = async (key, name, admin) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const agent = `${key}_${tag}`;
    const r = await pool.query(
      `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
       VALUES ($1, NULL, $2, $3, $4, NOW(), 'active', $5) RETURNING id`,
      [name, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10), admin]
    );
    creds[key] = [agent, pw];
    ids[key] = r.rows[0].id;
  };
  await mkUser('t213a', `A상회_${tag}`, true); // A 는 관리자(AC-15·16)
  await mkUser('t213b', `B상회_${tag}`, false);
  const [aNo, aPw] = creds.t213a;
  const [bNo, bPw] = creds.t213b;
  const A = ids.t213a;
  const B = ids.t213b;
  const prod = (await pool.query(`INSERT INTO product (name, unit) VALUES ($1, '박스') RETURNING id`, [`T213상품_${tag}`])).rows[0].id;

  // ============ 0. 라우트 표 점검 (서버 없이) ============
  {
    const { app, pool: appPool } = require('../index.js');
    const routes = new Set(access.listAppRoutes(app));
    const rules = access.buildRules();
    const ruleSet = new Set(rules.map((r) => `${r[1]} ${r[2]}`));
    const missing = [...routes].filter((x) => !ruleSet.has(x));
    const extra = [...ruleSet].filter((x) => !routes.has(x));
    check(`AC-14 라우트 ${routes.size}개 ↔ 권한 표 ${ruleSet.size}줄: 표에 없는 라우트 0`, missing.length === 0, missing);
    check('AC-14 표에만 있고 라우트가 없는 줄 0', extra.length === 0, extra);
    const fewer = new Set(rules.filter((r) => r[0] !== 'R-30').map((r) => `${r[1]} ${r[2]}`));
    const missing2 = [...routes].filter((x) => !fewer.has(x));
    check('AC-14 규칙 한 줄(R-30)을 지우면 점검이 그 라우트를 잡는다', missing2.length === 1 && missing2[0] === 'POST /api/purchases', missing2);
    for (const nr of ['GET /api/reports/monthly', 'GET /api/partners/:id/reminder', 'POST /api/partners/:id/reminder', 'POST /api/partners/:id/reminder/copy']) {
      check(`AC-14 설계 뒤 라우트도 표에 있음: ${nr}`, ruleSet.has(nr));
    }
    await appPool.end().catch(() => {});
  }

  // ============ AC-13 기본 거부 (미들웨어만, 표에 없는 라우트) ============
  {
    const app = express();
    app.use(express.json());
    const fakeAuth = async (req) => {
      const t = String(req.headers.authorization || '').replace(/^Bearer\s+/, '');
      if (t === 'owner') return { userId: 1, role: 'owner', isAdmin: false };
      if (t === 'input') return { userId: 1, role: 'input', staffId: 9, isAdmin: false };
      return null;
    };
    app.use(access.createAuthorize({ resolveAuth: fakeAuth }));
    app.get('/api/x-test', (req, res) => res.json({ ok: true, who: req.auth && req.auth.role }));
    const srv = await new Promise((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const p = srv.address().port;
    const st = await request('GET', '/api/x-test', null, 'input', p);
    const ow = await request('GET', '/api/x-test', null, 'owner', p);
    const upper = await request('GET', '/API/PURCHASES', null, 'input', p);
    check('AC-13 표에 없는 /api/x-test: 직원 403 ROUTE_NOT_ALLOWED', st.status === 403 && st.json.code === 'ROUTE_NOT_ALLOWED', st);
    check('AC-13 같은 라우트: 주인은 라우트 응답 그대로', ow.status === 200 && ow.json.who === 'owner', ow);
    check('AC-13 대문자 경로(/API/PURCHASES)도 표로 검사(우회 없음 — 매입 목록 허용 규칙 적용)', upper.status === 404, upper);
    srv.close();
  }

  try {
    // ================= 서버 1: 개발 모드, 메일 없음 =================
    await startServer({});
    const login = async (agent_no, password, login_id) => request('POST', '/api/auth/login', login_id ? { agent_no, password, login_id } : { agent_no, password });
    const tokA = (await login(aNo, aPw)).json.token;
    const tokB = (await login(bNo, bPw)).json.token;
    const as = (tok) => (m, p, b) => request(m, p, b, tok);
    const a = as(tokA);
    const b = as(tokB);

    // 거래 준비(주인 A): 매입처 S, 판매처 K(한도 100,000), K2(한도 없음), 매입 100박스×5,000
    const S = mustOk(await a('POST', '/api/partners', { name: `매입처_${tag}`, type: 'supplier' }), '매입처').id;
    const K = mustOk(await a('POST', '/api/partners', { name: `판매처K_${tag}`, type: 'customer', credit_limit: 100000 }), '판매처K').id;
    const K2 = mustOk(await a('POST', '/api/partners', { name: `판매처K2_${tag}`, type: 'customer' }), '판매처K2').id;
    const P0 = mustOk(await a('POST', '/api/purchases', { partner_id: S, product_id: prod, quantity: 100, unit_price: 5000, purchase_date: TODAY }), '매입').id;
    // 주인이 K 에 90,000 판매(미수 90,000)
    const ownerSale = mustOk(await a('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: P0, partner_id: K, quantity: 9, unit_price: 10000, sale_date: TODAY }] }), '주인 판매')[0].sale_id;
    // B 의 데이터
    const BS = mustOk(await b('POST', '/api/partners', { name: `B매입처_${tag}`, type: 'supplier' }), 'B 매입처').id;
    const BP = mustOk(await b('POST', '/api/purchases', { partner_id: BS, product_id: prod, quantity: 5, unit_price: 1000, purchase_date: TODAY }), 'B 매입').id;
    mustOk(await b('POST', '/api/products/personal', { name: `B개인품목_${tag}`, unit: 'kg', request_public: true }), 'B 품목 요청');

    // ---- AC-01 임시 비밀번호로 직원 만들기 ----
    const tempPw = `Tmp-${crypto.randomBytes(6).toString('hex')}`;
    const c1 = await a('POST', '/api/staff', { login_id: 'Ai1', name: '홍길동', role: 'input', temp_password: tempPw });
    const aiId = c1.json && c1.json.data && c1.json.data.id;
    const aiRow = (await pool.query('SELECT * FROM staff_account WHERE id = $1', [aiId])).rows[0];
    check('AC-01 POST /api/staff(임시 비밀번호) 201, active·must_change_password=true, 직원 ID 소문자 저장', c1.status === 201 && aiRow && aiRow.status === 'active' && aiRow.must_change_password === true && aiRow.login_id === 'ai1', c1);
    check('AC-01 응답에 해시·임시 비밀번호 없음', c1.json && !JSON.stringify(c1.json).includes(tempPw) && !('password_hash' in (c1.json.data || {})), c1.json);
    const auditCreate = (await pool.query(`SELECT * FROM audit_log WHERE user_id = $1 AND entity_type = 'staff' AND action = 'create' AND entity_id = $2`, [A, aiId])).rows;
    check('AC-01 audit_log staff/create 1행, 비밀번호 없음', auditCreate.length === 1 && !JSON.stringify(auditCreate[0]).includes(tempPw), auditCreate);
    const viewPw = `View-${crypto.randomBytes(6).toString('hex')}`;
    const c2 = await a('POST', '/api/staff', { login_id: 'av1', name: '김조회', role: 'view', temp_password: viewPw });
    const avId = c2.json.data.id;
    check('AC-01 조회 직원 av 201', c2.status === 201 && c2.json.data.role === 'view', c2);

    // ---- AC-02 첫 로그인 → 비밀번호 변경 강제 ----
    const l1 = await login(aNo, tempPw, 'ai1');
    const payload1 = l1.json && l1.json.token ? JSON.parse(Buffer.from(l1.json.token.split('.')[1], 'base64').toString()) : {};
    check('AC-02 직원 로그인 200, 토큰 sub=주인·act=직원, 응답 user.staff', l1.status === 200 && payload1.sub === String(A) && payload1.act === String(aiId) && l1.json.user.staff.role === 'input', { s: l1.status, payload1 });
    const tOld = l1.json.token;
    const g1 = await request('GET', '/api/purchases', null, tOld);
    check('AC-02 비밀번호 바꾸기 전 GET /api/purchases → 403 PASSWORD_CHANGE_REQUIRED', g1.status === 403 && g1.json.code === 'PASSWORD_CHANGE_REQUIRED', g1);
    const me0 = await request('GET', '/api/me', null, tOld);
    check('AC-02 바꾸기 전에도 GET /api/me 200(must_change_password=true)', me0.status === 200 && me0.json.must_change_password === true && me0.json.role === 'input', me0);
    const pr0 = await request('GET', '/api/products', null, tOld);
    check('AC-02 바꾸기 전 선택 인증(GET /api/products)도 403', pr0.status === 403, pr0.status);

    // ---- AC-03 비밀번호 변경 → 옛 토큰 401, 새 토큰 200 ----
    const aiPw = `Ai-${crypto.randomBytes(8).toString('hex')}`;
    const ch = await request('POST', '/api/me/password', { current_password: tempPw, new_password: aiPw }, tOld);
    const tAi = ch.json && ch.json.token;
    const oldUse = await request('GET', '/api/purchases', null, tOld);
    const newUse = await request('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}`, null, tAi);
    check('AC-03 변경 200 + 새 토큰', ch.status === 200 && !!tAi, ch);
    check('AC-03 옛 토큰 401', oldUse.status === 401, oldUse);
    check('AC-03 새 토큰 200', newUse.status === 200, newUse);
    const wrongCur = await request('POST', '/api/me/password', { current_password: 'nope-nope-1', new_password: 'whatever-123' }, tAi);
    check('AC-03 현재 비밀번호 틀리면 400 WRONG_PASSWORD', wrongCur.status === 400 && wrongCur.json.code === 'WRONG_PASSWORD', wrongCur);
    // av 도 비밀번호를 바꿔 둔다
    const lv = await login(aNo, viewPw, 'av1');
    const avPw = `Av-${crypto.randomBytes(8).toString('hex')}`;
    const tAv = (await request('POST', '/api/me/password', { current_password: viewPw, new_password: avPw }, lv.json.token)).json.token;
    const ai = as(tAi);
    const av = as(tAv);

    // ---- AC-04 입력 직원 매입 등록 ----
    const p1 = await ai('POST', '/api/purchases', { partner_id: S, product_id: prod, quantity: 10, unit_price: 5000, purchase_date: TODAY });
    const P = p1.json && p1.json.data && p1.json.data.id;
    const pRow = P ? (await pool.query('SELECT user_id, created_by_staff_id FROM purchase WHERE id = $1', [P])).rows[0] : null;
    check('AC-04 입력 직원 POST /api/purchases 201, user_id=주인, created_by_staff_id=직원', p1.status === 201 && pRow && pRow.user_id === A && pRow.created_by_staff_id === aiId, { p1, pRow });
    const aList = await a('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}`);
    const seen = (aList.json.data || []).find((r) => r.id === P);
    check('AC-04 주인 매입 목록에 그 행 + created_by_name=홍길동', seen && seen.created_by_name === '홍길동' && seen.created_by_staff_id === aiId, seen);
    const ownRow = (aList.json.data || []).find((r) => r.id === P0);
    check('AC-04 주인이 넣은 행은 created_by_name=null', ownRow && ownRow.created_by_name === null, ownRow);
    const onlyStaff = await a('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}&created_by=staff`);
    check('AC-04 created_by=staff 필터 → 직원 입력만', onlyStaff.status === 200 && onlyStaff.json.data.length === 1 && onlyStaff.json.data[0].id === P, onlyStaff.json);
    const badFilter = await a('GET', '/api/purchases?created_by=x!');
    check('AC-04 created_by 형식 오류 400', badFilter.status === 400, badFilter.status);

    // ---- AC-05 매출 전환·재고 판매·수금 ----
    const cv = await ai('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: P, partner_id: K2, quantity: 2, unit_price: 7000, sale_date: TODAY }] });
    const cvSale = cv.json && cv.json.data && cv.json.data[0] && cv.json.data[0].sale_id;
    const fs1 = await ai('POST', '/api/sales', { partner_id: K2, sale_date: TODAY, items: [{ product_id: prod, quantity: 1, unit_price: 7000 }] });
    const fsSale = fs1.json && fs1.json.data && (fs1.json.data.sales ? fs1.json.data.sales[0].sale_id || fs1.json.data.sales[0].id : null);
    const pay = await ai('POST', '/api/payments', { partner_id: K2, amount: 7000, paid_at: `${TODAY}T10:00`, allocations: [{ sale_id: cvSale, amount: 7000 }] });
    const staffSales = (await pool.query('SELECT id, created_by_staff_id FROM sale WHERE user_id = $1 AND created_by_staff_id = $2', [A, aiId])).rows;
    const staffPay = pay.json && pay.json.data ? (await pool.query('SELECT created_by_staff_id, entry_kind FROM payment WHERE id = $1', [pay.json.data.id])).rows[0] : null;
    check('AC-05 매출 전환 201', cv.status === 201, cv);
    check('AC-05 재고 판매(FIFO) 201', fs1.status === 201, fs1);
    check('AC-05 수금 등록 201', pay.status === 201, pay);
    check('AC-05 매출 2건(전환·재고 판매) created_by_staff_id=직원', staffSales.length === 2, { staffSales, fsSale });
    check('AC-05 수금 created_by_staff_id=직원, entry_kind=receive', staffPay && staffPay.created_by_staff_id === aiId && staffPay.entry_kind === 'receive', staffPay);
    const sList = await a('GET', `/api/sales?from_date=${TODAY}&to_date=${TODAY}`);
    const pyList = await a('GET', `/api/payments?from_date=${TODAY}&to_date=${TODAY}`);
    check('AC-05 매출·수금 목록에 created_by_name', (sList.json.data || []).some((r) => r.id === cvSale && r.created_by_name === '홍길동') && (pyList.json.data || []).some((r) => r.created_by_name === '홍길동'), { s: sList.status, p: pyList.status });

    // ---- 상태 스냅숏 (403 뒤 DB 변화 없음 확인용) ----
    const snap = async () => {
      const q = async (sql) => (await pool.query(sql, [A])).rows[0];
      return JSON.stringify({
        pu: await q(`SELECT COUNT(*) n, SUM(quantity) q, SUM(total_amount) t, string_agg(status::text, ',' ORDER BY id) s FROM purchase WHERE user_id = $1`),
        sa: await q(`SELECT COUNT(*) n, SUM(total_amount) t, SUM(returned_amount) r, string_agg(status::text, ',' ORDER BY id) s FROM sale WHERE user_id = $1`),
        py: await q(`SELECT COUNT(*) n, SUM(amount) t FROM payment WHERE user_id = $1`),
        sp: await q(`SELECT COUNT(*) n FROM supplier_payment WHERE user_id = $1`),
        ac: await q(`SELECT COUNT(*) n, string_agg(name || ':' || COALESCE(credit_limit::text, '-'), ',' ORDER BY id) x FROM account WHERE user_id = $1`),
        di: await q(`SELECT COUNT(*) n FROM disposal WHERE user_id = $1`),
        pr: await q(`SELECT COUNT(*) n FROM product WHERE owner_user_id = $1`),
        rq: await q(`SELECT COUNT(*) n FROM product_request WHERE user_id = $1`),
        tc: await q(`SELECT COUNT(*) n FROM trade_correction WHERE user_id = $1`),
        rf: await q(`SELECT COUNT(*) n FROM refund WHERE user_id = $1`),
        st: await q(`SELECT string_agg(login_id || ':' || role || ':' || status, ',' ORDER BY id) x FROM staff_account WHERE owner_user_id = $1`),
      });
    };

    // ---- AC-06 정정·반품·폐기 403 ----
    const before6 = await snap();
    const forb6 = [
      ['PATCH', `/api/purchases/${P}`, { quantity: 11, reason: '수정' }],
      ['POST', `/api/purchases/${P}/cancel`, { reason: '취소' }],
      ['PATCH', `/api/sales/${cvSale}`, { unit_price: 8000, reason: '수정' }],
      ['POST', `/api/sales/${cvSale}/cancel`, { reason: '취소' }],
      ['POST', `/api/sales/${cvSale}/refund`, { quantity: 1 }],
      ['POST', '/api/disposals', { product_id: prod, quantity: 1, reason: '폐기' }],
    ];
    for (const [m, p, body] of forb6) {
      const r = await ai(m, p, body);
      check(`AC-06 입력 직원 ${m} ${p.replace(/\d+/g, ':id')} → 403 FORBIDDEN_ROLE`, r.status === 403 && r.json.code === 'FORBIDDEN_ROLE', r);
    }
    check('AC-06 DB 변화 없음(행 수·값)', (await snap()) === before6);

    // ---- AC-07 지급·거래처·품목 403 ----
    const forb7 = [
      ['POST', '/api/supplier-payments', { partner_id: S, amount: 1000, paid_at: TODAY, allocations: [] }],
      ['POST', '/api/supplier-payments/1/cancel', { reason: 'x' }],
      ['POST', '/api/partners', { name: `직원거래처_${tag}`, type: 'customer' }],
      ['PUT', `/api/partners/${K}`, { credit_limit: 999999999 }],
      ['POST', '/api/products/personal', { name: `직원품목_${tag}` }],
      ['POST', '/api/products/requests', { product_id: prod }],
      ['POST', `/api/partners/${K}/reminder`, { subject: 'x', body: 'y' }],
      ['POST', `/api/partners/${K}/reminder/copy`, {}],
    ];
    for (const [m, p, body] of forb7) {
      const r = await ai(m, p, body);
      check(`AC-07 입력 직원 ${m} ${p.replace(/\d+/g, ':id')} → 403`, r.status === 403 && r.json.code === 'FORBIDDEN_ROLE', r);
    }
    const remGet = await ai('GET', `/api/partners/${K}/reminder`);
    check('AC-07 입금 안내 미리보기·발송 이력(GET reminder)도 직원 403', remGet.status === 403, remGet.status);
    check('AC-07 DB 변화 없음', (await snap()) === before6);

    // ---- AC-08 환불 수금 403 ----
    const r8 = await ai('POST', '/api/payments', { partner_id: K2, amount: 1000, paid_at: TODAY, entry_kind: 'refund' });
    check('AC-08 entry_kind=refund → 403 FIELD_NOT_ALLOWED(entry_kind)', r8.status === 403 && r8.json.code === 'FIELD_NOT_ALLOWED' && r8.json.field === 'entry_kind', r8);
    const r8b = await ai('POST', '/api/payments', { partner_id: K2, amount: 1000, paid_at: TODAY, entry_kind: 'weird' });
    check('AC-08 entry_kind 다른 값도 403', r8b.status === 403, r8b.status);

    // ---- AC-09 외상 한도 ----
    const over = { items: [{ purchase_id: P0, partner_id: K, quantity: 2, unit_price: 10000, sale_date: TODAY }] };
    const r9a = await ai('POST', '/api/purchases/convert-to-sales', over);
    const r9b = await ai('POST', '/api/purchases/convert-to-sales', { ...over, credit_confirmed: true });
    const r9f = await ai('POST', '/api/sales', { partner_id: K, sale_date: TODAY, credit_confirmed: true, items: [{ product_id: prod, quantity: 2, unit_price: 10000 }] });
    const r9c = await a('POST', '/api/purchases/convert-to-sales', { ...over, credit_confirmed: true });
    check('AC-09 입력 직원 한도 넘김 → 409 CREDIT_LIMIT(저장 안 됨)', r9a.status === 409 && r9a.json.code === 'CREDIT_LIMIT', r9a);
    check('AC-09 credit_confirmed=true → 403 FIELD_NOT_ALLOWED(credit_confirmed)', r9b.status === 403 && r9b.json.field === 'credit_confirmed', r9b);
    check('AC-09 재고 판매도 credit_confirmed=true → 403', r9f.status === 403 && r9f.json.field === 'credit_confirmed', r9f);
    check('AC-09 주인은 같은 요청 + 확인 → 201', r9c.status === 201, r9c);

    // ---- AC-10 조회 직원 GET 전부 (주인과 같은 결과) ----
    const ym = TODAY.slice(0, 7);
    const viewGets = [
      '/api/products', '/api/products/requests', '/api/partners', `/api/partners/${K}/ledger`, '/api/receivables/aging', '/api/dashboard',
      '/api/supplier-payments', `/api/partners/${S}/payable-ledger`, '/api/payables/aging', '/api/inventory',
      `/api/purchases?from_date=${TODAY}&to_date=${TODAY}`, `/api/purchases/last-price?product_id=${prod}`, '/api/purchases/recent-partners',
      `/api/sales?from_date=${TODAY}&to_date=${TODAY}`, `/api/sales/statement?partner_id=${K}&date=${TODAY}`,
      `/api/reports/daily-purchase-sales?from_date=${TODAY}&to_date=${TODAY}`, `/api/reports/daily-purchase-sales-breakdown?from_date=${TODAY}&to_date=${TODAY}`,
      `/api/payments?from_date=${TODAY}&to_date=${TODAY}`, `/api/inventory/${prod}/fifo-preview?quantity=1`, `/api/corrections?target_type=purchase&target_id=${P}`, '/api/disposals',
      `/api/reports/monthly?month=${ym}`, '/api/me',
    ];
    const strip = (j) => JSON.stringify(j, (k, v) => (['generated_at', 'now', 'server_time', 'owner', 'staff', 'role', 'role_label', 'allow', 'is_admin'].includes(k) ? undefined : v));
    for (const p of viewGets) {
      const rv = await av('GET', p);
      const ro = await a('GET', p);
      const same = p === '/api/me' || p === '/api/products/requests' ? rv.status === 200 : strip(rv.json) === strip(ro.json);
      check(`AC-10 조회 직원 GET ${p.split('?')[0].replace(/\/\d+/g, '/:id')} → 200${p === '/api/me' || p === '/api/products/requests' ? '' : ', 주인과 같은 내용'}`, rv.status === 200 && same, { v: rv.status, o: ro.status, vj: strip(rv.json).slice(0, 200), oj: strip(ro.json).slice(0, 200) });
    }

    // ---- AC-11 조회 직원 등록 4종 403 ----
    const before11 = await snap();
    for (const [m, p, body] of [
      ['POST', '/api/purchases', { partner_id: S, product_id: prod, quantity: 1, unit_price: 1, purchase_date: TODAY }],
      ['POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: P, partner_id: K2, quantity: 1, unit_price: 1, sale_date: TODAY }] }],
      ['POST', '/api/sales', { partner_id: K2, items: [{ product_id: prod, quantity: 1, unit_price: 1 }] }],
      ['POST', '/api/payments', { partner_id: K2, amount: 1, paid_at: TODAY, allocations: [] }],
    ]) {
      const r = await av(m, p, body);
      check(`AC-11 조회 직원 ${m} ${p} → 403 FORBIDDEN_ROLE`, r.status === 403 && r.json.code === 'FORBIDDEN_ROLE', r);
    }
    check('AC-11 DB 변화 없음', (await snap()) === before11);

    // ---- AC-12 변경 이력·직원 목록 ----
    for (const [who, f] of [['입력', ai], ['조회', av]]) {
      const h = await f('GET', '/api/history');
      const s = await f('GET', '/api/staff');
      check(`AC-12 ${who} 직원 GET /api/history·/api/staff → 403`, h.status === 403 && s.status === 403, { h: h.status, s: s.status });
    }
    const selfRole = await ai('PATCH', `/api/staff/${aiId}`, { role: 'view' });
    check('AC-12 직원이 자기 역할 바꾸기(PATCH /api/staff/:id) 403', selfRole.status === 403, selfRole.status);

    // ---- AC-15·16 관리자 관계 ----
    const reqs = (await pool.query(`SELECT id FROM product_request WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [B])).rows[0];
    const r15a = await ai('POST', '/api/products', { name: `직원공용_${tag}`, unit: 'kg' });
    const r15b = await ai('POST', `/api/products/requests/${reqs.id}/approve`, {});
    const r15c = await ai('GET', '/api/products/requests');
    const r15d = await a('GET', '/api/products/requests?status=all');
    const meAi = await ai('GET', '/api/me');
    check('AC-15 관리자 주인의 직원: POST /api/products 403', r15a.status === 403, r15a);
    check('AC-15 관리자 주인의 직원: 공용 승인 403', r15b.status === 403, r15b);
    check('AC-15 직원 GET /api/products/requests 200 + 주인 본인 요청만·요청자 칸 없음', r15c.status === 200 && !(r15c.json.data || []).some((x) => x.id === reqs.id) && !(r15c.json.data || []).some((x) => 'requester_name' in x), r15c.json);
    check('AC-15 직원 /api/me is_admin=false', meAi.json.is_admin === false && meAi.json.role === 'input', meAi.json);
    check('AC-16 관리자 주인 A는 전체 요청(B 요청 포함·요청자 이름) 그대로', r15d.status === 200 && (r15d.json.data || []).some((x) => x.id === reqs.id && 'requester_name' in x), r15d.status);
    const r16 = await a('POST', '/api/products', { name: `관리자공용_${tag}`, unit: 'kg' });
    check('AC-16 관리자 주인 A 상품 마스터 등록 그대로(201/200)', r16.status < 300, r16);
    const r16n = await b('POST', '/api/products', { name: `일반공용_${tag}`, unit: 'kg' });
    check('AC-16 관리자 아닌 주인 B: 기존 문구 "관리자만 등록할 수 있습니다." 그대로', r16n.status === 403 && r16n.json.message === '관리자만 등록할 수 있습니다.', r16n);

    // ---- AC-21 다른 주인의 직원 ----
    const r21a = await b('PATCH', `/api/staff/${aiId}`, { name: '해킹' });
    const r21b = await b('DELETE', `/api/staff/${aiId}`);
    const r21c = await b('POST', `/api/staff/${aiId}/suspend`);
    const r21d = await b('GET', '/api/staff');
    const aiAfter = (await pool.query('SELECT name, status FROM staff_account WHERE id = $1', [aiId])).rows[0];
    check('AC-21 B가 A 직원 PATCH/DELETE/suspend → 404', r21a.status === 404 && r21b.status === 404 && r21c.status === 404, [r21a.status, r21b.status, r21c.status]);
    check('AC-21 B 직원 목록에 A 직원 없음, A 직원 변화 없음', r21d.status === 200 && r21d.json.data.length === 0 && aiAfter.name === '홍길동' && aiAfter.status === 'active', { r21d: r21d.json, aiAfter });

    // ---- AC-22 직원이 B 데이터 ----
    const r22a = await ai('GET', `/api/partners/${BS}/payable-ledger`);
    const r22b = await ai('POST', '/api/purchases', { partner_id: BS, product_id: prod, quantity: 1, unit_price: 1, purchase_date: TODAY });
    const r22c = await ai('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: BP, partner_id: K2, quantity: 1, unit_price: 1, sale_date: TODAY }] });
    const r22d = await ai('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}`);
    check('AC-22 직원이 B 거래처 원장 → 404', r22a.status === 404, r22a.status);
    check('AC-22 직원이 B 거래처로 매입 → 400', r22b.status === 400, r22b.status);
    check('AC-22 직원이 B 매입 전환 → 404', r22c.status === 404, r22c.status);
    check('AC-22 직원 매입 목록은 A 범위만(B 매입 없음)', r22d.status === 200 && !(r22d.json.data || []).some((x) => x.id === BP), r22d.status);

    // ---- AC-29 역할 변경 즉시 반영 ----
    const r29a = await av('POST', '/api/purchases', { partner_id: S, product_id: prod, quantity: 1, unit_price: 100, purchase_date: TODAY });
    const ch29 = await a('PATCH', `/api/staff/${avId}`, { role: 'input' });
    const r29b = await av('POST', '/api/purchases', { partner_id: S, product_id: prod, quantity: 1, unit_price: 100, purchase_date: TODAY });
    check('AC-29 view→input 바꾸면 같은 토큰으로 매입 201(재로그인 없이)', r29a.status === 403 && ch29.status === 200 && r29b.status === 201, [r29a.status, ch29.status, r29b.status]);
    await a('PATCH', `/api/staff/${avId}`, { role: 'view' });

    // ---- AC-17·18 정지·되살리기 ----
    const s17 = await a('POST', `/api/staff/${aiId}/suspend`);
    const u17 = await ai('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}`);
    const l17ok = await login(aNo, aiPw, 'ai1');
    const l17bad = await login(aNo, 'wrong-password-1', 'ai1');
    check('AC-17 정지 200 → 받은 토큰 401', s17.status === 200 && s17.json.data.status === 'suspended' && u17.status === 401, [s17.status, u17.status]);
    check('AC-17 정지 직원 맞는 비밀번호 → 403 "정지된 직원 계정입니다."', l17ok.status === 403 && l17ok.json.message === '정지된 직원 계정입니다.', l17ok);
    check('AC-17 정지 직원 틀린 비밀번호 → 일반 401', l17bad.status === 401 && /직원 ID 또는 비밀번호/.test(l17bad.json.message), l17bad);
    const s17b = await a('POST', `/api/staff/${aiId}/suspend`);
    check('AC-17 이미 정지 → 409 INVALID_STATE', s17b.status === 409, s17b.status);
    const r18 = await a('POST', `/api/staff/${aiId}/resume`);
    const l18 = await login(aNo, aiPw, 'ai1');
    check('AC-18 되살리기 200 → 로그인 200', r18.status === 200 && l18.status === 200, [r18.status, l18.status]);
    const tAi2 = l18.json.token;

    // ---- 비밀번호 재설정(RULE-16) ----
    const newTemp = `Rst-${crypto.randomBytes(6).toString('hex')}`;
    const rs = await a('POST', `/api/staff/${aiId}/reset-password`, { temp_password: newTemp });
    const rsOld = await request('GET', '/api/me', null, tAi2);
    const rsLogin = await login(aNo, newTemp, 'ai1');
    check('RULE-16 재설정 200 → 기존 토큰 401 → 새 임시 비밀번호 로그인 + 변경 강제', rs.status === 200 && rsOld.status === 401 && rsLogin.status === 200 && rsLogin.json.user.staff.must_change_password === true, [rs.status, rsOld.status, rsLogin.status]);
    const aiPw2 = `Ai2-${crypto.randomBytes(8).toString('hex')}`;
    const tAi3 = (await request('POST', '/api/me/password', { current_password: newTemp, new_password: aiPw2 }, rsLogin.json.token)).json.token;

    // ---- AC-20 주인 정지 ----
    await pool.query(`UPDATE "user" SET status = 'suspended' WHERE id = $1`, [A]);
    const r20a = await request('GET', '/api/me', null, tAi3);
    const r20b = await login(aNo, aiPw2, 'ai1');
    await pool.query(`UPDATE "user" SET status = 'active' WHERE id = $1`, [A]);
    check('AC-20 주인 정지 → 직원 토큰 401', r20a.status === 401, r20a.status);
    check('AC-20 주인 정지 → 직원 로그인(맞는 비밀번호) 403 "중매인 계정이 사용 중지되었습니다."', r20b.status === 403 && /중매인 계정이 사용 중지/.test(r20b.json.message), r20b);

    // ---- AC-24 응답 문구·시간 ----
    const invRes = await a('POST', '/api/staff', { login_id: 'inv', name: '초대직원', role: 'view', email: `inv_${tag}@test.local` });
    const cases = [
      ['없는 직원 ID', { agent_no: aNo, login_id: 'nobody', password: 'xxxxxxxx1' }],
      ['초대 중 직원', { agent_no: aNo, login_id: 'inv', password: 'xxxxxxxx1' }],
      ['없는 중매인 번호', { agent_no: `zz_${tag}`, login_id: 'ai1', password: 'xxxxxxxx1' }],
      ['틀린 비밀번호', { agent_no: aNo, login_id: 'ai1', password: 'xxxxxxxx1' }],
    ];
    const msgs = new Set();
    const med = {};
    for (const [nm, body] of cases) {
      const times = [];
      let last;
      for (let i = 0; i < 5; i += 1) {
        last = await request('POST', '/api/auth/login', body);
        times.push(last.ms);
      }
      times.sort((x, y) => x - y);
      med[nm] = times[2];
      msgs.add(`${last.status}|${last.json && last.json.message}`);
    }
    const t0 = Date.now();
    await bcrypt.compare('x', await bcrypt.hash('y', 10));
    const bc = Math.max(20, (Date.now() - t0) / 2);
    const vals = Object.values(med);
    check('AC-24 네 경우 모두 같은 401 문구', msgs.size === 1 && [...msgs][0].startsWith('401|'), [...msgs]);
    check(`AC-24 응답 시간 중앙값 차이 < bcrypt 1회(${bc.toFixed(0)}ms)`, Math.max(...vals) - Math.min(...vals) < bc, med);

    // ---- AC-25 초대(개발 환경, 메일 없음) ----
    const inv = invRes.json;
    check('AC-25 이메일 초대 201 invited + dev_code(개발 환경)', invRes.status === 201 && inv.data.status === 'invited' && /^\d{6}$/.test(inv.dev_code || ''), inv);
    const invRow = (await pool.query(`SELECT invite_code_hash FROM staff_account WHERE id = $1`, [inv.data.id])).rows[0];
    check('AC-25 초대 코드는 평문 저장 안 함(bcrypt 해시)', invRow.invite_code_hash && invRow.invite_code_hash !== inv.dev_code && invRow.invite_code_hash.startsWith('$2'), null);
    const invPw = `Inv-${crypto.randomBytes(8).toString('hex')}`;
    const sp = await request('POST', '/api/auth/staff/setup-password', { agent_no: aNo, login_id: 'inv', code: inv.dev_code, new_password: invPw });
    const invAfter = (await pool.query(`SELECT status, invite_code_hash FROM staff_account WHERE id = $1`, [inv.data.id])).rows[0];
    const invLogin = await login(aNo, invPw, 'inv');
    check('AC-25 setup-password 200 → active·코드 NULL → 로그인 200', sp.status === 200 && invAfter.status === 'active' && invAfter.invite_code_hash === null && invLogin.status === 200, { sp, invAfter, l: invLogin.status });
    const spAgain = await request('POST', '/api/auth/staff/setup-password', { agent_no: aNo, login_id: 'inv', code: inv.dev_code, new_password: invPw });
    check('AC-25 같은 코드 다시 쓰기 → 400(이미 active)', spAgain.status === 400, spAgain.status);

    // ---- AC-26 초대 코드 5회 오입력 ----
    const inv2 = (await a('POST', '/api/staff', { login_id: 'inv2', name: '초대둘', role: 'input', email: `inv2_${tag}@test.local` })).json;
    let last26;
    for (let i = 0; i < 5; i += 1) {
      const wrong = inv2.dev_code === '000000' ? '111111' : '000000';
      last26 = await request('POST', '/api/auth/staff/setup-password', { agent_no: aNo, login_id: 'inv2', code: wrong, new_password: 'abcdefgh1' });
    }
    const right26 = await request('POST', '/api/auth/staff/setup-password', { agent_no: aNo, login_id: 'inv2', code: inv2.dev_code, new_password: 'abcdefgh1' });
    check('AC-26 틀린 코드 5회째 → 코드 무효 안내', last26.status === 400 && /5회/.test(last26.json.message), last26);
    check('AC-26 무효 뒤 맞는 코드도 실패', right26.status === 400, right26);
    const rsnd = await a('POST', `/api/staff/${inv2.data.id}/resend-invite`);
    const ok26 = await request('POST', '/api/auth/staff/setup-password', { agent_no: aNo, login_id: 'inv2', code: rsnd.json.dev_code, new_password: 'abcdefgh1' });
    check('AC-26 resend-invite 뒤 새 코드로 성공', rsnd.status === 200 && ok26.status === 200, [rsnd.status, ok26.status]);

    // ---- AC-28 상한·중복·형식 ----
    const dup = await a('POST', '/api/staff', { login_id: 'AI1', name: '중복', role: 'view', temp_password: 'abcdefgh1' });
    const badId = await a('POST', '/api/staff', { login_id: 'A!', name: '형식', role: 'view', temp_password: 'abcdefgh1' });
    const badRole = await a('POST', '/api/staff', { login_id: 'okid', name: '역할', role: 'admin', temp_password: 'abcdefgh1' });
    const noWay = await a('POST', '/api/staff', { login_id: 'okid', name: '방식없음', role: 'view' });
    const shortPw = await a('POST', '/api/staff', { login_id: 'okid', name: '짧은비번', role: 'view', temp_password: 'abc' });
    check('AC-28 같은 ID(대소문자만 다름) → 409 LOGIN_ID_TAKEN', dup.status === 409 && dup.json.code === 'LOGIN_ID_TAKEN', dup);
    check('AC-28 형식 위반 A! → 400 VALIDATION', badId.status === 400 && badId.json.code === 'VALIDATION' && badId.json.field === 'login_id', badId);
    check('AC-28 역할 admin → 400', badRole.status === 400 && badRole.json.field === 'role', badRole);
    check('AC-28 임시 비밀번호·이메일 둘 다 없음 → 400', noWay.status === 400, noWay);
    check('AC-28 임시 비밀번호 8자 미만 → 400', shortPw.status === 400 && shortPw.json.field === 'temp_password', shortPw);
    const cur = (await pool.query(`SELECT COUNT(*)::int n FROM staff_account WHERE owner_user_id = $1 AND status <> 'deleted'`, [A])).rows[0].n;
    for (let i = cur; i < 10; i += 1) mustOk(await a('POST', '/api/staff', { login_id: `fill${i}`, name: `채움${i}`, role: 'view', temp_password: 'abcdefgh1' }), `채움${i}`);
    const lim = await a('POST', '/api/staff', { login_id: 'eleven', name: '열한번째', role: 'view', temp_password: 'abcdefgh1' });
    check('AC-28 11번째 → 400 STAFF_LIMIT', lim.status === 400 && lim.json.code === 'STAFF_LIMIT', lim);
    const list28 = await a('GET', '/api/staff');
    check('AC-28 직원 목록 10명 + limit·mail_ready 칸, 해시 없음', list28.status === 200 && list28.json.data.length === 10 && list28.json.limit === 10 && !JSON.stringify(list28.json).includes('$2b$'), list28.json.data.length);

    // ---- AC-19 삭제 ----
    const del = await a('DELETE', `/api/staff/${aiId}`);
    const delRow = (await pool.query(`SELECT status, email, password_hash, deleted_at FROM staff_account WHERE id = $1`, [aiId])).rows[0];
    const delLogin = await login(aNo, aiPw2, 'ai1');
    const reuse = await a('POST', '/api/staff', { login_id: 'ai1', name: '새홍길동', role: 'input', temp_password: 'abcdefgh1' });
    const afterDelList = await a('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}`);
    const pAfter = (afterDelList.json.data || []).find((r) => r.id === P);
    check('AC-19 삭제 200, 행 유지·status=deleted·email/password_hash NULL', del.status === 200 && delRow.status === 'deleted' && delRow.email === null && delRow.password_hash === null && delRow.deleted_at, delRow);
    check('AC-19 삭제된 직원 로그인 → 일반 401', delLogin.status === 401, delLogin.status);
    check('AC-19 같은 ID ai 로 새 직원 201(상한 10명이라 삭제 1명 뒤 자리 생김)', reuse.status === 201, reuse);
    check('AC-19 삭제된 직원이 넣은 매입 입력자 = "홍길동(삭제됨)"', pAfter && pAfter.created_by_name === '홍길동(삭제됨)', pAfter);
    const del2 = await a('DELETE', `/api/staff/${aiId}`);
    check('AC-19 삭제된 직원 다시 삭제 → 404', del2.status === 404, del2.status);

    // ---- AC-30 변경 이력 ----
    const hAll = await a('GET', '/api/history?limit=200');
    const hEntry = await a('GET', '/api/history?kind=staff_entry&limit=200');
    const hStaff = await a('GET', '/api/history?kind=staff&limit=200');
    const hLogin = await a('GET', '/api/history?kind=login&limit=200');
    const staffLogins = (hLogin.json.data || []).filter((x) => x.actor === 'staff');
    const entryTypes = new Set((hEntry.json.data || []).map((x) => x.target_type));
    const staffActs = new Set((hStaff.json.data || []).map((x) => x.reason));
    check('AC-30 직원 로그인 행 actor=staff·actor_name', staffLogins.length > 0 && staffLogins.every((x) => x.actor_name), staffLogins.slice(0, 2));
    check('AC-30 직원 입력 갈래(staff_entry): 매입·매출·수금', entryTypes.has('purchase') && entryTypes.has('sale') && entryTypes.has('payment'), [...entryTypes]);
    check('AC-30 직원 관리 행: 추가·정지·되살리기·재설정·삭제', ['직원 추가(임시 비밀번호)', '직원 정지', '직원 되살리기', '직원 임시 비밀번호 재설정', '직원 삭제'].every((x) => staffActs.has(x)), [...staffActs]);
    const allText = JSON.stringify(hAll.json);
    check('AC-30 이력 어디에도 비밀번호·코드·해시 없음', ![tempPw, aiPw, aiPw2, newTemp, viewPw, avPw, inv.dev_code].some((x) => x && allText.includes(x)) && !allText.includes('$2b$'), null);
    const hActor = await a('GET', `/api/history?actor=${avId}&limit=50`);
    check('AC-30 actor=<직원 id> 필터 → 그 직원 행만', hActor.status === 200 && (hActor.json.data || []).length > 0 && hActor.json.data.every((x) => x.actor_staff_id === avId), hActor.json.data && hActor.json.data.length);
    const hBad = await a('GET', '/api/history?actor=x');
    check('AC-30 actor 형식 오류 400', hBad.status === 400, hBad.status);

    // ---- AC-31 021 이전 모양의 주인 토큰 ----
    const oldShape = authToken.signToken(SECRET, { userId: A, agentNo: aNo }, 3600);
    const oldPayload = JSON.parse(Buffer.from(oldShape.split('.')[1], 'base64').toString());
    const r31 = await request('GET', '/api/me', null, oldShape);
    check('AC-31 act 없는(021 이전 모양) 주인 토큰 → 주인으로 200', !('act' in oldPayload) && r31.status === 200 && r31.json.role === 'owner', r31.json);
    const forged = authToken.signToken('x'.repeat(40), { userId: A, agentNo: aNo, staffId: 1, credVersion: '0' }, 3600);
    check('AC-31 다른 비밀로 만든 직원 토큰 401', (await request('GET', '/api/me', null, forged)).status === 401);
    const wrongAct = authToken.signToken(SECRET, { userId: B, agentNo: bNo, staffId: avId, credVersion: '0' }, 3600);
    check('AC-31 다른 주인 sub + A 직원 act 토큰 → 401', (await request('GET', '/api/me', null, wrongAct)).status === 401);

    // ---- AC-32·33 파일 전송 404 순서·선택 인증 ----
    const r32 = await request('POST', '/api/file-transfer/salesforce/content-version');
    const r32s = await av('POST', '/api/file-transfer/salesforce/content-version');
    check('AC-32 ENABLE_SF_UPLOAD 없음: 토큰 없이 → 404(N-10 그대로)', r32.status === 404, r32.status);
    check('AC-32 직원 토큰으로도 404(기능 꺼짐이 먼저)', r32s.status === 404, r32s.status);
    // A 개인 품목 하나
    mustOk(await a('POST', '/api/products/personal', { name: `A개인품목_${tag}`, unit: 'kg' }), 'A 개인 품목');
    const pubOnly = await request('GET', '/api/products');
    const viaStaff = await av('GET', '/api/products');
    const hasPersonal = (r) => (r.json.data || []).some((x) => x.name === `A개인품목_${tag}`);
    check('AC-33 토큰 없이 GET /api/products → 공용만 200', pubOnly.status === 200 && !hasPersonal(pubOnly), pubOnly.status);
    check('AC-33 직원 토큰 → A 개인 품목 포함 200', viaStaff.status === 200 && hasPersonal(viaStaff), viaStaff.status);
    const badTok = await request('GET', '/api/products', null, 'garbage.token.x');
    check('AC-33 잘못된 토큰도 공용 목록 200(예전 동작)', badTok.status === 200, badTok.status);

    // ---- 기타: 401 문구·없는 경로 ----
    const r401 = await request('GET', '/api/purchases');
    check('RULE-21 토큰 없이 보호 라우트 → 401 "로그인이 필요합니다."(기존 문구)', r401.status === 401 && r401.json.message === '로그인이 필요합니다.', r401.json);
    const r404 = await request('GET', '/api/nope-route');
    check('없는 경로 + 토큰 없음 → 404(예전과 같음)', r404.status === 404, r404.status);
    const r404s = await av('GET', '/api/nope-route');
    check('없는 경로 + 직원 토큰 → 403 ROUTE_NOT_ALLOWED(기본 거부)', r404s.status === 403 && r404s.json.code === 'ROUTE_NOT_ALLOWED', r404s.status);
    const ownerPw = await a('POST', '/api/me/password', { current_password: 'wrong-xx-1', new_password: 'abcdefgh1' });
    check('R-45 주인 비밀번호 변경: 현재 비밀번호 틀리면 400', ownerPw.status === 400, ownerPw.status);

    // ---- 역할×라우트 전수 표 (직원 입력/조회 × 모든 로그인 필요 규칙) ----
    const rules = access.buildRules().filter((r) => Array.isArray(r[3]) && r[0] !== 'R-43');
    let matrixFail = [];
    const tInput = (await login(aNo, 'abcdefgh1', 'ai1')).json.token; // 새 ai(임시 비밀번호) → 변경
    const tIn = (await request('POST', '/api/me/password', { current_password: 'abcdefgh1', new_password: 'abcdefgh2' }, tInput)).json.token;
    for (const [rid, method, p, allow] of rules) {
      const url = p.replace(':productId', String(prod)).replace(':saleId', '999999999').replace(':id', '999999999');
      for (const [role, tok] of [['input', tIn], ['view', tAv]]) {
        // 쓰기 허용 규칙은 실제로 쓰지 않도록 본문 없이 보낸다(검증 400/404 = 통과로 봄)
        const r = await request(method, url, method === 'GET' ? null : {}, tok);
        const allowed = allow.includes(role);
        const denied = r.status === 403 && (r.json.code === 'FORBIDDEN_ROLE' || r.json.code === 'ROUTE_NOT_ALLOWED');
        if (allowed === denied) matrixFail.push(`${rid} ${role} ${method} ${p} → ${r.status} ${r.json && r.json.code}`);
      }
    }
    check(`역할×라우트 전수 ${rules.length}규칙×2역할: 표대로 허용/403`, matrixFail.length === 0, matrixFail);

    // ---- AC-34 확인 SQL ----
    const q1 = await pool.query(`SELECT 'purchase' t, p.id FROM purchase p JOIN staff_account s ON s.id = p.created_by_staff_id WHERE s.owner_user_id <> p.user_id
      UNION ALL SELECT 'sale', x.id FROM sale x JOIN staff_account s ON s.id = x.created_by_staff_id WHERE s.owner_user_id <> x.user_id
      UNION ALL SELECT 'payment', y.id FROM payment y JOIN staff_account s ON s.id = y.created_by_staff_id WHERE s.owner_user_id <> y.user_id`);
    const q2 = await pool.query(`SELECT id FROM payment WHERE created_by_staff_id IS NOT NULL AND entry_kind <> 'receive'`);
    const q3 = await pool.query(`SELECT id FROM staff_account WHERE status = 'deleted' AND (password_hash IS NOT NULL OR email IS NOT NULL OR invite_code_hash IS NOT NULL)`);
    check('AC-34 확인 SQL ①②③ 모두 0행', q1.rowCount === 0 && q2.rowCount === 0 && q3.rowCount === 0, [q1.rowCount, q2.rowCount, q3.rowCount]);
    let fkBlocked = false;
    try {
      await pool.query(`INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, created_by_staff_id)
                        VALUES ($1, $2, $3, 1, 1, 1, CURRENT_DATE, $4)`, [B, BS, prod, avId]);
    } catch (e) {
      fkBlocked = e.code === '23503';
    }
    check('AC-34 복합 FK: B 매입에 A 직원 id 넣기 → DB가 거부(23503)', fkBlocked);
    await stopServer();

    // ================= 서버 2: 운영 모드, 메일 없음 (AC-27) =================
    await startServer({ NODE_ENV: 'production', DB_SSL: 'false' }); // 로컬 DB 는 SSL 없음
    const tokA2 = (await login(aNo, aPw)).json.token;
    const r27 = await request('POST', '/api/staff', { login_id: 'mailinv', name: '메일초대', role: 'view', email: `m_${tag}@test.local` }, tokA2);
    const row27 = (await pool.query(`SELECT 1 FROM staff_account WHERE owner_user_id = $1 AND login_id = 'mailinv'`, [A])).rowCount;
    check('AC-27 운영·메일 미설정 이메일 초대 → 400 MAIL_NOT_CONFIGURED, 행 없음', r27.status === 400 && r27.json.code === 'MAIL_NOT_CONFIGURED' && row27 === 0, r27);
    await a('DELETE', '/api/staff/0').catch(() => {});
    const fillDel = (await pool.query(`SELECT id FROM staff_account WHERE owner_user_id = $1 AND login_id = 'fill9' AND status <> 'deleted'`, [A])).rows[0];
    if (fillDel) await request('DELETE', `/api/staff/${fillDel.id}`, null, tokA2);
    const r27b = await request('POST', '/api/staff', { login_id: 'tmpprod', name: '임시', role: 'view', temp_password: 'abcdefgh1' }, tokA2);
    check('AC-27 운영에서도 임시 비밀번호 방식은 201', r27b.status === 201, r27b);
    await stopServer();

    // ================= 서버 3: 로그인 제한 3회 (AC-23) =================
    await startServer({ LOGIN_MAX_FAILS: '3' });
    for (let i = 0; i < 3; i += 1) await login(aNo, 'bad-pass-xx1', 'tmpprod');
    const l23 = await login(aNo, 'abcdefgh1', 'tmpprod');
    const l23o = await login(aNo, aPw);
    check('AC-23 직원 틀린 비밀번호 3회 → 맞는 비밀번호도 429 + Retry-After', l23.status === 429 && !!l23.headers['retry-after'], l23);
    check('AC-23 같은 시간 주인 A 본인 로그인 200(키 분리)', l23o.status === 200, l23o.status);
    const sp23 = await request('POST', '/api/auth/staff/setup-password', { agent_no: aNo, login_id: 'tmpprod', code: '123456', new_password: 'abcdefgh1' });
    check('AC-23 잠긴 직원 키로 초대 코드 설정도 429(키 공유)', sp23.status === 429, sp23.status);
    await stopServer();

    // ================= 서버 4: 가짜 메일 발송 =================
    await startServer({ MAIL_DRY_RUN: '1' });
    const tokA4 = (await login(aNo, aPw)).json.token;
    const del4 = (await pool.query(`SELECT id FROM staff_account WHERE owner_user_id = $1 AND login_id = 'fill8' AND status <> 'deleted'`, [A])).rows[0];
    if (del4) await request('DELETE', `/api/staff/${del4.id}`, null, tokA4);
    const r4 = await request('POST', '/api/staff', { login_id: 'mailok', name: '메일됨', role: 'input', email: `ok_${tag}@test.local` }, tokA4);
    check('RULE-12 메일 설정됨(가짜 발송) → 201 invited, mail_sent=true, dev_code 없음', r4.status === 201 && r4.json.mail_sent === true && !r4.json.dev_code && r4.json.data.status === 'invited', r4.json);
    await stopServer();
  } finally {
    await stopServer();
    await pool.end();
  }

  // ---------- 요약 ----------
  const pass = results.filter((r) => r.ok).length;
  const acIds = new Set(results.map((r) => (r.name.match(/^AC-\d+/) || [])[0]).filter(Boolean));
  console.log(`\n결과: ${pass} / ${results.length} 통과 · 다룬 인수 조건 ${acIds.size}개(${[...acIds].sort((x, y) => Number(x.slice(3)) - Number(y.slice(3))).join(', ')})`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[staff-access-test] 중단:', err.message);
  await stopServer();
  process.exit(1);
});
