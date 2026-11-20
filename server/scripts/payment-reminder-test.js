/**
 * T-214 미수 입금 안내 메일 검사 — 메일 있음(가짜 성공)/없음/실패, 하루 1회, 권한, 이력, 거래처 이메일 칸
 *
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> REMINDER_PORT=<빈 포트> AUTH_SECRET=<32자 이상 테스트값> node scripts/payment-reminder-test.js
 * 이 검사는 서버를 직접 세 번 띄운다(메일 설정 없음 → MAIL_DRY_RUN=fail → MAIL_DRY_RUN=1). 실제 메일은 보내지 않는다:
 *   메일 수단 환경 변수(RESEND_*·BREVO_*·SMTP_*)는 빈 값으로 덮어써서 운영 키가 있어도 쓰이지 않게 한다.
 * 전제: 마이그레이션 001~022(017·020·021 없어도 됨). 테스트 DB 전용 — 회원 A·B(t214a_/t214b_<태그>)·상품을 DB에 직접 만들고
 *       거래는 API로 만든다. 다른 검사의 기대값에 영향을 주지 않게 새 회원 안에서만 움직인다.
 */
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[payment-reminder-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}
const PORT = Number(process.env.REMINDER_PORT || 3599);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 32 ? process.env.AUTH_SECRET : crypto.randomBytes(24).toString('hex');

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
const kst = (d = 0) => new Date(Date.now() + 9 * 3600 * 1000 - d * 86400 * 1000).toISOString().slice(0, 10);
const TODAY = kst();

// ---------- 서버 띄우기·끄기 ----------
let server = null;
async function startServer(mailMode) {
  const env = {
    ...process.env,
    PORT: String(PORT),
    DATABASE_URL: DB_URL,
    AUTH_SECRET: SECRET,
    LOGIN_MAX_FAILS: '1000',
    // 실제 메일 수단은 모두 끈다(빈 값) — 운영 키가 환경에 있어도 쓰이지 않게
    RESEND_API_KEY: '',
    BREVO_API_KEY: '',
    BREVO_FROM: '',
    SMTP_HOST: '',
    SMTP_USER: '',
    SMTP_PASS: '',
    MAIL_DRY_RUN: mailMode || '',
  };
  server = spawn(process.execPath, ['index.js'], { cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await request('GET', '/');
      if (r.status < 500) return;
    } catch {
      /* 아직 */
    }
  }
  throw new Error('서버가 뜨지 않음');
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

async function login(agentNo, password) {
  const r = await request('POST', '/api/auth/login', { agent_no: agentNo, password });
  if (r.status !== 200 || !r.json?.token) throw new Error(`로그인 실패 ${agentNo} status=${r.status}`);
  return r.json.token;
}

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const creds = {};
  const mkUser = async (prefix, name, phone) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const agent = `${prefix}_${tag}`;
    await pool.query(
      `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'active', false)`,
      [name, phone, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
    );
    creds[prefix] = [agent, pw];
  };
  await mkUser('t214a', '김중매', `010-${String(Date.now()).slice(-8, -4)}-${String(Date.now()).slice(-4)}`);
  await mkUser('t214b', '이중매', null);

  try {
    // ---------- 0. 마이그레이션 022 ----------
    const col = await pool.query(
      `SELECT data_type, character_maximum_length, is_nullable FROM information_schema.columns WHERE table_name = 'account' AND column_name = 'email'`
    );
    check('M-01 account.email VARCHAR(255) NULL 허용', col.rows[0]?.character_maximum_length === 255 && col.rows[0]?.is_nullable === 'YES', col.rows[0]);
    const idx = await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'ux_payment_reminder_daily'`);
    check('M-02 하루 1회 부분 유일 인덱스 있음', /UNIQUE/.test(idx.rows[0]?.indexdef || '') && /sent_on/.test(idx.rows[0]?.indexdef || ''), idx.rows[0]);

    // ================= 1단계: 메일 설정 없음 =================
    await startServer('');
    let A = await login(...creds.t214a);
    let B = await login(...creds.t214b);
    let a = (m, p, b) => request(m, p, b, A);
    let b = (m, p, b2) => request(m, p, b2, B);

    // 거래처 이메일 칸
    const sup = await mustOk(await a('POST', '/api/partners', { name: `매입처_${tag}`, type: 'supplier' }), '매입처');
    const c1 = await mustOk(await a('POST', '/api/partners', { name: `C상회_${tag}`, type: 'customer', email: ' c1@example.com ' }), 'C상회');
    check('E-01 거래처 등록에 이메일 저장(앞뒤 공백 제거)', c1.email === 'c1@example.com', c1);
    const c2 = await mustOk(await a('POST', '/api/partners', { name: `D상회_${tag}`, type: 'customer' }), 'D상회');
    check('E-02 이메일 없이 등록 → null', c2.email === null, c2);
    const c3 = await mustOk(await a('POST', '/api/partners', { name: `E청과_${tag}`, type: 'same_market', email: 'e3@example.com' }), 'E청과');
    const c4 = await mustOk(await a('POST', '/api/partners', { name: `미수없음_${tag}`, type: 'customer', email: 'z@example.com' }), '미수없음');
    const badE = await a('POST', '/api/partners', { name: `잘못_${tag}`, type: 'customer', email: 'not-an-email' });
    check('E-03 잘못된 이메일 등록 → 400', badE.status === 400 && /이메일/.test(badE.json?.message || ''), badE);
    const putE = await a('PUT', `/api/partners/${c2.id}`, { email: 'd2@example.com' });
    check('E-04 PUT 으로 이메일 넣기', putE.status === 200 && putE.json.data.email === 'd2@example.com', putE);
    const putE2 = await a('PUT', `/api/partners/${c2.id}`, { email: '' });
    check('E-05 PUT 빈 이메일 → null(지움)', putE2.status === 200 && putE2.json.data.email === null, putE2);
    const list = await mustOk(await a('GET', '/api/partners'), '목록');
    check('E-06 거래처 목록에 email 포함', list.find((x) => x.id === c1.id)?.email === 'c1@example.com');

    // 거래 준비: 매입 → 매출(C상회: 오늘 10만 + 45일 전 3만 + 100일 전 2만, D상회 5만, E청과 1만)
    const mkProd = async (name) => (await pool.query(`INSERT INTO product (name, unit) VALUES ($1, '박스') RETURNING id`, [`${name}_${tag}`])).rows[0].id;
    const p1 = await mkProd('배추');
    const pu = (await mustOk(await a('POST', '/api/purchases', { partner_id: sup.id, product_id: p1, quantity: 1000, unit_price: 100, purchase_date: kst(120) }), '매입')).id;
    const sell = async (partnerId, qty, price, date) =>
      mustOk(
        await a('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: pu, partner_id: partnerId, quantity: qty, unit_price: price, sale_date: date }], credit_confirmed: true }),
        '매출'
      );
    await sell(c1.id, 10, 10000, TODAY);
    await sell(c1.id, 3, 10000, kst(45));
    await sell(c1.id, 2, 10000, kst(100));
    await sell(c2.id, 5, 10000, TODAY);
    await sell(c3.id, 1, 10000, TODAY);

    // 미리보기 (메일 없음)
    const pv0 = await a('GET', `/api/partners/${c1.id}/reminder`);
    const d0 = pv0.json?.data;
    check('N-01 미리보기 200, mail_ready=false + "메일 설정이 아직 없습니다" 안내', pv0.status === 200 && d0.mail_ready === false && /메일 설정이 아직 없습니다/.test(d0.mail_message || ''), pv0);
    check('N-02 미수 합계 15만 · 30일 이내 10만 · 31–60 3만 · 90일 초과 2만 · 3건', d0.receivable.total_due === 150000 && d0.receivable.d0_30 === 100000 && d0.receivable.d31_60 === 30000 && d0.receivable.d61_90 === 0 && d0.receivable.d91p === 20000 && d0.receivable.sale_count === 3, d0.receivable);
    const aging = await mustOk(await a('GET', `/api/receivables/aging?partner_id=${c1.id}`), '미수 연령');
    check('N-03 미리보기 미수 = 미수 연령 API 합계(같은 정의)', aging.rows[0]?.total_due === d0.receivable.total_due && aging.rows[0]?.d91p === d0.receivable.d91p);
    check('N-04 기본 문구: 거래처명·합계·경과별·가장 오래된 거래·계좌 자리·문의(이름 전화)', d0.subject.includes(`C상회_${tag}`) && d0.subject.includes('150,000원') && d0.body.includes('■ 미결제 합계: 150,000원 (3건)') && d0.body.includes('90일 초과 20,000원') && d0.body.includes(`${kst(100)} 거래 (100일 경과)`) && d0.body.includes('[입금 계좌를 적어 주세요]') && /문의: 김중매 010-/.test(d0.body), d0.body);
    check('N-05 받는 주소 = 거래처 이메일, 이력 없음, 오늘 발송 없음', d0.partner.email === 'c1@example.com' && d0.history.length === 0 && d0.sent_today === null && d0.can_send === true, d0);
    const s0 = await a('POST', `/api/partners/${c1.id}/reminder`, { subject: d0.subject, body: d0.body, bank_text: '' });
    check('N-06 메일 설정 없음 발송 → 503 아님, 409 MAIL_NOT_CONFIGURED + 문구 돌려줌', s0.status === 409 && s0.json.code === 'MAIL_NOT_CONFIGURED' && /메일 설정이 아직 없습니다/.test(s0.json.message) && s0.json.data?.body === d0.body.trim(), s0);
    const cnt0 = Number((await pool.query('SELECT COUNT(*) FROM payment_reminder WHERE partner_id = $1', [c1.id])).rows[0].count);
    check('N-07 메일 설정 없음이면 발송 이력 안 생김', cnt0 === 0, cnt0);
    const cp = await a('POST', `/api/partners/${c1.id}/reminder/copy`, { subject: d0.subject, body: d0.body, bank_text: '농협 123-45-678 김중매' });
    check('N-08 문구 복사 기록 → 201 copied, 금액 15만', cp.status === 201 && cp.json.data.result === 'copied' && cp.json.data.amount_due === 150000, cp);
    const cp2 = await a('POST', `/api/partners/${c1.id}/reminder/copy`, { subject: d0.subject, body: d0.body });
    check('N-09 복사는 하루 여러 번 가능(하루 1회에 안 셈)', cp2.status === 201, cp2);
    const pv1 = (await mustOk(await a('GET', `/api/partners/${c1.id}/reminder`), '미리보기2'));
    check('N-10 복사 이력 2건(channel copy, to_email null), 계좌 문구는 다음 기본값으로', pv1.history.length === 2 && pv1.history.every((h) => h.channel === 'copy' && h.result === 'copied' && h.to_email === null) && pv1.bank_text === '농협 123-45-678 김중매' && pv1.body.includes('■ 입금 계좌: 농협 123-45-678 김중매'), pv1);
    await stopServer();

    // ================= 2단계: 메일 실패(MAIL_DRY_RUN=fail) =================
    await startServer('fail');
    A = await login(...creds.t214a);
    a = (m, p, b2) => request(m, p, b2, A);
    const pf = await mustOk(await a('GET', `/api/partners/${c3.id}/reminder`), '미리보기 fail');
    check('X-01 메일 수단 있음(가짜) → mail_ready=true', pf.mail_ready === true && pf.mail_message === null, pf);
    const sf = await a('POST', `/api/partners/${c3.id}/reminder`, { subject: pf.subject, body: pf.body });
    check('X-02 발송 실패 → 502 MAIL_FAILED + 다시 보내기/복사 안내 + 문구', sf.status === 502 && sf.json.code === 'MAIL_FAILED' && /복사/.test(sf.json.message) && !!sf.json.data?.body, sf);
    const rowF = (await pool.query('SELECT result, error, to_email, amount_due FROM payment_reminder WHERE partner_id = $1', [c3.id])).rows;
    check('X-03 실패 이력 1건: result failed · 오류 · 주소 · 금액 1만', rowF.length === 1 && rowF[0].result === 'failed' && /가짜 실패/.test(rowF[0].error) && rowF[0].to_email === 'e3@example.com' && Number(rowF[0].amount_due) === 10000, rowF);
    await stopServer();

    // ================= 3단계: 메일 있음(MAIL_DRY_RUN=1, 가짜 성공) =================
    await startServer('1');
    A = await login(...creds.t214a);
    B = await login(...creds.t214b);
    a = (m, p, b2) => request(m, p, b2, A);
    b = (m, p, b2) => request(m, p, b2, B);

    // 실패는 하루 1회에 세지 않음 → 같은 날 다시 보낼 수 있다
    const p3 = await mustOk(await a('GET', `/api/partners/${c3.id}/reminder`), '미리보기 E');
    check('X-04 실패 뒤 미리보기: 오늘 발송 없음 · 보낼 수 있음 · 이력에 실패 1건', p3.sent_today === null && p3.can_send === true && p3.history[0]?.result === 'failed', p3);
    const s3 = await a('POST', `/api/partners/${c3.id}/reminder`, { subject: p3.subject, body: p3.body });
    check('X-05 실패 뒤 같은 날 재발송 → 201', s3.status === 201 && s3.json.data.result === 'dry_run', s3);

    // 정상 발송 (고친 문구)
    const pv = await mustOk(await a('GET', `/api/partners/${c1.id}/reminder`), '미리보기 C');
    const edited = `${pv.body}\n\n(고친 문구) 이번 주 금요일까지 부탁드립니다.`;
    const s1 = await a('POST', `/api/partners/${c1.id}/reminder`, { subject: '[입금 안내] 고친 제목', body: edited, bank_text: '농협 123-45-678 김중매' });
    check('S-01 메일 발송 → 201, result dry_run, 받는 주소 = 거래처 이메일, 금액 15만', s1.status === 201 && s1.json.ok && s1.json.data.result === 'dry_run' && s1.json.data.to_email === 'c1@example.com' && s1.json.data.amount_due === 150000, s1);
    const row = (await pool.query('SELECT * FROM payment_reminder WHERE id = $1', [s1.json.data.id])).rows[0];
    const me = (await pool.query('SELECT id FROM "user" WHERE agent_no = $1', [creds.t214a[0]])).rows[0];
    check('S-02 이력: 누가(user)·언제(created_at)·누구에게·금액·결과·고친 제목/본문 그대로', row && row.user_id === me.id && row.partner_id === c1.id && row.channel === 'email' && row.to_email === 'c1@example.com' && Number(row.amount_due) === 150000 && row.oldest_days === 100 && row.result === 'dry_run' && row.provider === 'dry_run' && row.subject === '[입금 안내] 고친 제목' && row.body === edited.trim() && !!row.created_at, row);
    check('S-03 이력의 보낸 날 = 한국 날짜 오늘', row && new Date(row.sent_on.getTime() - row.sent_on.getTimezoneOffset() * 60000).toISOString().slice(0, 10) === TODAY, row?.sent_on);

    // 하루 1회
    const s2 = await a('POST', `/api/partners/${c1.id}/reminder`, { subject: 'x', body: 'y' });
    check('L-01 같은 거래처 같은 날 두 번째 → 409 DAILY_LIMIT (언제·누구에게 보냈는지 포함)', s2.status === 409 && s2.json.code === 'DAILY_LIMIT' && s2.json.data?.to_email === 'c1@example.com', s2);
    const pvL = await mustOk(await a('GET', `/api/partners/${c1.id}/reminder`), '미리보기 L');
    check('L-02 미리보기: sent_today 있음 · can_send=false · 이력 맨 위가 방금 보낸 것', pvL.sent_today?.to_email === 'c1@example.com' && pvL.can_send === false && pvL.history[0].result === 'dry_run' && pvL.history.length === 3, pvL);
    const cpL = await a('POST', `/api/partners/${c1.id}/reminder/copy`, { subject: 'x', body: 'y' });
    check('L-03 보낸 뒤에도 문구 복사는 가능', cpL.status === 201, cpL);
    // 다른 거래처는 따로 센다
    const sD = await a('POST', `/api/partners/${c2.id}/reminder`, { to_email: 'd2-new@example.com', subject: 's', body: 'b' });
    check('L-04 다른 거래처는 따로(D상회 오늘 첫 발송 → 201)', sD.status === 201, sD);
    // 날짜가 바뀌면 다시 보낼 수 있다 — 어제 보낸 것으로 바꿔 확인
    await pool.query(`UPDATE payment_reminder SET sent_on = sent_on - 1 WHERE id = $1`, [s1.json.data.id]);
    const sNext = await a('POST', `/api/partners/${c1.id}/reminder`, { subject: '다음 날', body: '다음 날 안내' });
    check('L-05 어제 보낸 거래처 → 오늘 다시 보내기 201', sNext.status === 201, sNext);
    // 동시에 두 번 눌러도 한 건만
    const c5 = await mustOk(await a('POST', '/api/partners', { name: `동시_${tag}`, type: 'customer', email: 'same@example.com' }), '동시');
    await sell(c5.id, 1, 5000, TODAY);
    const both = await Promise.all([1, 2, 3].map(() => a('POST', `/api/partners/${c5.id}/reminder`, { subject: 's', body: 'b' })));
    const n201 = both.filter((r) => r.status === 201).length;
    const n409 = both.filter((r) => r.status === 409 && r.json.code === 'DAILY_LIMIT').length;
    const nRows = Number((await pool.query(`SELECT COUNT(*) FROM payment_reminder WHERE partner_id = $1 AND channel = 'email'`, [c5.id])).rows[0].count);
    check('L-06 동시 3번 → 201 한 번 · 409 두 번 · 이력 1건', n201 === 1 && n409 === 2 && nRows === 1, both.map((r) => r.status));
    // DB 가 직접 막는지(부분 유일 인덱스)
    let dupCode = null;
    try {
      await pool.query(
        `INSERT INTO payment_reminder (user_id, partner_id, sent_on, channel, to_email, amount_due, subject, body, result) VALUES ($1, $2, $3::date, 'email', 'x@example.com', 1, 's', 'b', 'sent')`,
        [me.id, c5.id, TODAY]
      );
    } catch (e) {
      dupCode = e.code;
    }
    check('L-07 DB 에 같은 날 성공 행 직접 넣기 → 23505(유일 인덱스)', dupCode === '23505', dupCode);
    // 보내는 중에 서버가 죽어 'sending' 으로 남은 행: 10분 지나면 다시 보낼 수 있다
    const c6 = await mustOk(await a('POST', '/api/partners', { name: `멈춤_${tag}`, type: 'customer', email: 'stuck@example.com' }), '멈춤');
    await sell(c6.id, 1, 7000, TODAY);
    await pool.query(
      `INSERT INTO payment_reminder (user_id, partner_id, sent_on, channel, to_email, amount_due, subject, body, result, created_at) VALUES ($1, $2, $3::date, 'email', 'stuck@example.com', 7000, 's', 'b', 'sending', NOW() - INTERVAL '11 minutes')`,
      [me.id, c6.id, TODAY]
    );
    const sStuck = await a('POST', `/api/partners/${c6.id}/reminder`, { subject: 's', body: 'b' });
    const stuckRows = (await pool.query(`SELECT result FROM payment_reminder WHERE partner_id = $1 ORDER BY id`, [c6.id])).rows.map((x) => x.result);
    check('L-08 11분 넘게 "보내는 중"인 행 → 실패로 정리하고 새로 발송 201', sStuck.status === 201 && stuckRows.join(',') === 'failed,dry_run', stuckRows);

    // 받는 주소 바꿔 보내며 거래처 정보에 저장
    const c7 = await mustOk(await a('POST', '/api/partners', { name: `주소없음_${tag}`, type: 'wholesaler' }), '주소없음');
    await sell(c7.id, 1, 3000, TODAY);
    const pvNo = await mustOk(await a('GET', `/api/partners/${c7.id}/reminder`), '미리보기 주소없음');
    check('V-01 거래처 이메일 없음 → 미리보기 partner.email null', pvNo.partner.email === null);
    const sNoTo = await a('POST', `/api/partners/${c7.id}/reminder`, { subject: 's', body: 'b' });
    check('V-02 이메일 없이 보내기 → 400 to_email', sNoTo.status === 400 && sNoTo.json.field === 'to_email', sNoTo);
    const sSave = await a('POST', `/api/partners/${c7.id}/reminder`, { to_email: 'new7@example.com', save_email: true, subject: 's', body: 'b' });
    const acc7 = (await pool.query('SELECT email FROM account WHERE id = $1', [c7.id])).rows[0];
    const aud7 = (await pool.query(`SELECT changed_fields FROM audit_log WHERE entity_type = 'account' AND entity_id = $1 AND action = 'update'`, [c7.id])).rows;
    check('V-03 save_email=true → 발송 201 + 거래처 이메일 저장 + 변경 이력(email) 남음', sSave.status === 201 && sSave.json.data.email_saved === true && acc7.email === 'new7@example.com' && aud7.some((r) => (r.changed_fields || []).includes('email')), { s: sSave.json, acc7, aud7 });
    const accD = (await pool.query('SELECT email FROM account WHERE id = $1', [c2.id])).rows[0];
    check('V-04 save_email 없이 다른 주소로 보내면 거래처 이메일은 그대로', accD.email === null, accD);

    // 입력 검증
    const v = async (partnerId, body) => a('POST', `/api/partners/${partnerId}/reminder`, body);
    const c8 = await mustOk(await a('POST', '/api/partners', { name: `검증_${tag}`, type: 'customer', email: 'v@example.com' }), '검증');
    await sell(c8.id, 1, 1000, TODAY);
    const vs = [
      ['V-05 잘못된 받는 주소', { to_email: 'bad@', subject: 's', body: 'b' }, 'to_email'],
      ['V-06 제목 없음', { subject: '  ', body: 'b' }, 'subject'],
      ['V-07 제목 줄바꿈(헤더 주입 방지)', { subject: 'a\nBcc: x@example.com', body: 'b' }, 'subject'],
      ['V-08 본문 없음', { subject: 's', body: '' }, 'body'],
      ['V-09 본문 5000자 초과', { subject: 's', body: 'x'.repeat(5001) }, 'body'],
      ['V-10 계좌 문구 300자 초과', { subject: 's', body: 'b', bank_text: 'x'.repeat(301) }, 'bank_text'],
    ];
    for (const [name, body, field] of vs) {
      const r = await v(c8.id, body);
      check(`${name} → 400 (${field})`, r.status === 400 && r.json.field === field, r);
    }
    const c8rows = Number((await pool.query('SELECT COUNT(*) FROM payment_reminder WHERE partner_id = $1', [c8.id])).rows[0].count);
    check('V-11 검증 실패는 이력을 남기지 않음', c8rows === 0, c8rows);
    const nd = await a('POST', `/api/partners/${c4.id}/reminder`, { subject: 's', body: 'b' });
    check('V-12 미수 없는 거래처 → 400 NO_RECEIVABLE', nd.status === 400 && nd.json.code === 'NO_RECEIVABLE', nd);
    const ndv = await mustOk(await a('GET', `/api/partners/${c4.id}/reminder`), '미리보기 미수없음');
    check('V-13 미수 없는 거래처 미리보기 → 합계 0 · can_send=false', ndv.receivable.total_due === 0 && ndv.can_send === false, ndv.receivable);
    const sp = await a('GET', `/api/partners/${sup.id}/reminder`);
    check('V-14 매입처 → 400 NOT_RECEIVABLE_PARTNER', sp.status === 400 && sp.json.code === 'NOT_RECEIVABLE_PARTNER', sp);
    const badId = await a('GET', `/api/partners/abc/reminder`);
    check('V-15 거래처 번호가 숫자가 아님 → 400', badId.status === 400, badId);

    // 권한
    const g401 = await request('GET', `/api/partners/${c1.id}/reminder`);
    const p401 = await request('POST', `/api/partners/${c1.id}/reminder`, { subject: 's', body: 'b' });
    const c401 = await request('POST', `/api/partners/${c1.id}/reminder/copy`, { subject: 's', body: 'b' });
    check('A-01 로그인 없이 미리보기·발송·복사 → 401', g401.status === 401 && p401.status === 401 && c401.status === 401, [g401.status, p401.status, c401.status]);
    const g404 = await b('GET', `/api/partners/${c8.id}/reminder`);
    const p404 = await b('POST', `/api/partners/${c8.id}/reminder`, { subject: 's', body: 'b', to_email: 'evil@example.com' });
    const cp404 = await b('POST', `/api/partners/${c8.id}/reminder/copy`, { subject: 's', body: 'b' });
    check('A-02 남의 거래처 미리보기·발송·복사 → 404', g404.status === 404 && p404.status === 404 && cp404.status === 404, [g404.status, p404.status, cp404.status]);
    const c8after = Number((await pool.query('SELECT COUNT(*) FROM payment_reminder WHERE partner_id = $1', [c8.id])).rows[0].count);
    check('A-03 남의 시도 뒤에도 이력 0건', c8after === 0, c8after);
    const fake = await request('GET', `/api/partners/${c1.id}/reminder`, null, `${A.slice(0, -4)}abcd`);
    check('A-04 위조 토큰 → 401', fake.status === 401, fake.status);
    const bPv = await b('POST', '/api/partners', { name: `B거래처_${tag}`, type: 'customer' });
    const bHist = await mustOk(await b('GET', `/api/partners/${bPv.json.data.id}/reminder`), 'B 미리보기');
    check('A-05 다른 회원의 계좌 문구는 내 기본값으로 안 옴(bank_text 빈 값)', bHist.bank_text === '' && bHist.history.length === 0, bHist.bank_text);
  } finally {
    await stopServer();
    await pool.end();
  }

  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n[payment-reminder-test] ${results.length - fail} / ${results.length} 통과`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('[payment-reminder-test] 오류:', e);
  await stopServer();
  process.exit(1);
});
