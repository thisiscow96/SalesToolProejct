/**
 * 로그인 토큰(T-101) 회귀·공격 테스트 (T-112, 테스트 담당 C)
 *
 * 실행(server 폴더, 로컬 테스트 DB 전용):
 *   DATABASE_URL=postgresql://postgres:pw@127.0.0.1:<포트>/sales_tool node scripts/auth-regression-test.js
 *   - 마이그레이션이 끝난 DB여야 한다(node scripts/migrate.js).
 *   - 서버(index.js)를 이 스크립트가 직접 띄운다. 포트: AUTH_TEST_PORT(기본 3404)
 *   - AUTH_SECRET 은 실행마다 무작위로 만들어 자식 서버에만 넘기고, 어디에도 출력하지 않는다.
 *   - 결과 JSON: AUTH_TEST_OUT=<경로> 를 주면 그 파일에 쓴다.
 *
 * 범위(그룹):
 *   H 헤더(X-Agent-No)만 바꾼 호출   T 토큰 위조·변조·alg·만료·형식   I 다른 사용자 리소스 접근(IDOR)
 *   L 서버 로그에 비밀번호·토큰이 남는지   S 운영 모드 AUTH_SECRET 시작 거부   E 로그인 실패 응답의 계정 존재 노출
 *   N 보안 보강(T-114, B): 로그인 5회 실패 지연·번호 확인 제한·비밀번호 길이·업로드 비활성/인증 선행/한도
 *   A seed-admin 운영 모드 거부·기존 비밀번호 유지 (T-114, R-01)
 *   (INFO 표시 항목은 관찰만 하고 통과/실패 집계에서 뺀다)
 *
 * T-114(B) 갱신: 메인 서버는 LOGIN_MAX_FAILS=1000 으로 띄운다 — E 그룹이 같은 번호로 여러 번 실패해도
 *   잠기지 않게(응답 시간 비교가 429 로 흐려지지 않게). 시도 제한 자체는 N 그룹이 별도 서버(짧은 잠금 시간)로 검사한다.
 *
 * 운영 DB 보호: DATABASE_URL 호스트가 127.0.0.1/localhost 가 아니면 실행하지 않는다.
 * 기존 코드·데이터는 바꾸지 않는다. 실행마다 접미사가 다른 테스트 사용자·거래처를 새로 만든다.
 */
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..');
const PORT = Number(process.env.AUTH_TEST_PORT) || 3404;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_URL = (process.env.DATABASE_URL || '').trim();

if (!DB_URL) {
  console.error('DATABASE_URL 이 필요합니다(로컬 테스트 DB).');
  process.exit(2);
}
{
  const host = new URL(DB_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    console.error(`로컬 테스트 DB 전용입니다. 호스트 ${host} 에서는 실행하지 않습니다.`);
    process.exit(2);
  }
}

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const SECRET = crypto.randomBytes(32).toString('hex'); // 64자, 출력하지 않음
const PW = {
  victim: `PwV-${crypto.randomBytes(9).toString('hex')}`,
  attacker: `PwA-${crypto.randomBytes(9).toString('hex')}`,
  inactive: `PwI-${crypto.randomBytes(9).toString('hex')}`,
  victim2: `PwW-${crypto.randomBytes(9).toString('hex')}`,
  wrong: `PwX-${crypto.randomBytes(9).toString('hex')}`,
  register: `PwR-${crypto.randomBytes(9).toString('hex')}`,
};
const AGENT = {
  victim: `T112V${RUN}`,
  attacker: `T112A${RUN}`,
  inactive: `T112I${RUN}`,
  victim2: `T112W${RUN}`,
  ghost: `T112G${RUN}`, // 존재하지 않는 번호
};

const results = [];
function record(id, group, name, pass, detail, { info = false } = {}) {
  results.push({ id, group, name, result: info ? 'INFO' : pass ? 'PASS' : 'FAIL', detail });
  const mark = info ? 'ℹ' : pass ? '○' : '×';
  console.log(`${mark} [${id}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- 공통 도구 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (obj) => Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64url');
function sign(secret, headerObj, payloadObj, algo = 'sha256') {
  const data = `${b64u(headerObj)}.${b64u(payloadObj)}`;
  return `${data}.${crypto.createHmac(algo, secret).update(data).digest('base64url')}`;
}

async function call(method, url, { token, headers = {}, body } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const t0 = process.hrtime.bigint();
  const r = await fetch(BASE + url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 본문이 JSON 이 아닐 수 있음 */
  }
  return { status: r.status, json, text, ms };
}

function startServer(env, { port = PORT } = {}) {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = { text: '', code: null, exited: false };
  child.stdout.on('data', (d) => (out.text += d.toString()));
  child.stderr.on('data', (d) => (out.text += d.toString()));
  child.on('exit', (code) => {
    out.code = code;
    out.exited = true;
  });
  return { child, out };
}

async function waitUp(srv, port = PORT, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (srv.out.exited) return false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) return true;
    } catch {
      /* 아직 안 뜸 */
    }
    await sleep(150);
  }
  return false;
}

async function waitExit(srv, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !srv.out.exited) await sleep(100);
  return srv.out.exited;
}

async function stopServer(srv) {
  if (!srv.out.exited) {
    srv.child.kill();
    await waitExit(srv, 5000);
  }
}

// 서버를 띄우지 않을 때 DB 설정 (index.js 와 같은 설정 함수)
process.env.DB_SSL = process.env.DB_SSL || 'false';
const { getPgConfig } = require('../lib/db-config');
const pool = new Pool(getPgConfig());

async function createUser(agentNo, password, { status = 'active', isAdmin = false } = {}) {
  const hash = await bcrypt.hash(password, 10);
  const r = await pool.query(
    `INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
     VALUES ($1, $2, $3, $4, NOW(), $5, $6) RETURNING id`,
    [`T112 ${agentNo}`, `${agentNo.toLowerCase()}@t112.local`, agentNo, hash, status, isAdmin]
  );
  return r.rows[0].id;
}
async function createAccount(userId, name, type) {
  const r = await pool.query(`INSERT INTO account (user_id, name, type) VALUES ($1, $2, $3) RETURNING id`, [userId, name, type]);
  return r.rows[0].id;
}

/** 피해자 데이터 스냅샷 — 공격 전후 비교용 */
async function victimSnapshot(uid) {
  const q = async (sql) => (await pool.query(sql, [uid])).rows;
  const snap = {
    purchase: await q('SELECT id, quantity, total_amount FROM purchase WHERE user_id=$1 ORDER BY id'),
    sale: await q('SELECT id, quantity, total_amount, paid_amount, status FROM sale WHERE user_id=$1 ORDER BY id'),
    payment: await q('SELECT id, amount, entry_kind FROM payment WHERE user_id=$1 ORDER BY id'),
    refund: await q('SELECT id, quantity, refund_amount FROM refund WHERE user_id=$1 ORDER BY id'),
    disposal: await q('SELECT id, quantity FROM disposal WHERE user_id=$1 ORDER BY id'),
    inventory: await q('SELECT product_id, quantity FROM inventory WHERE user_id=$1 ORDER BY product_id'),
    account: await q('SELECT id, name, type FROM account WHERE user_id=$1 ORDER BY id'),
    allocation: await q(
      'SELECT pa.purchase_id, pa.quantity FROM purchase_allocation pa JOIN purchase p ON p.id = pa.purchase_id WHERE p.user_id=$1 ORDER BY pa.purchase_id, pa.quantity'
    ),
    pay_alloc: await q(
      'SELECT pa.sale_id, pa.amount FROM payment_allocation pa JOIN sale s ON s.id = pa.sale_id WHERE s.user_id=$1 ORDER BY pa.sale_id, pa.amount'
    ),
  };
  return JSON.stringify(snap);
}

const idsIn = (resp) => (Array.isArray(resp?.json?.data) ? resp.json.data.map((r) => r.id) : null);

async function main() {
  console.log(`=== T-112/T-114 로그인·보안 회귀·공격 테스트 (실행 ${RUN}) ===`);

  // ---------- S: 운영 모드 시작 거부 (메인 서버를 띄우기 전, 같은 포트 사용) ----------
  {
    const env = { NODE_ENV: 'production', DB_SSL: 'false', DATABASE_URL: DB_URL };
    const s1 = startServer({ ...env, AUTH_SECRET: '' });
    const ex1 = await waitExit(s1);
    record('S-01', 'S', 'NODE_ENV=production + AUTH_SECRET 없음 → 시작 거부(exit 1)', ex1 && s1.out.code === 1 && /AUTH_SECRET/.test(s1.out.text),
      `exit=${s1.out.code}, 메시지=${(s1.out.text.match(/\[auth\][^\n]*/) || [''])[0].trim()}`);
    await stopServer(s1);

    const s2 = startServer({ ...env, AUTH_SECRET: 'x'.repeat(31) });
    const ex2 = await waitExit(s2);
    record('S-02', 'S', 'NODE_ENV=production + AUTH_SECRET 31자 → 시작 거부(exit 1)', ex2 && s2.out.code === 1, `exit=${s2.out.code}`);
    await stopServer(s2);

    const s3 = startServer({ ...env, AUTH_SECRET: crypto.randomBytes(16).toString('hex') }); // 32자
    const up3 = await waitUp(s3);
    record('S-03', 'S', 'NODE_ENV=production + AUTH_SECRET 32자 → 정상 시작', up3, up3 ? '/ 200' : `exit=${s3.out.code}`);
    await stopServer(s3);

    const s4 = startServer({ NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: '' });
    const up4 = await waitUp(s4);
    const warned = /임시 비밀/.test(s4.out.text);
    record('S-04', 'S', '개발 모드 + AUTH_SECRET 없음 → 경고 후 시작(임시 비밀)', up4 && warned, `시작=${up4}, 경고=${warned}`);
    await stopServer(s4);
  }

  // ---------- 준비: 테스트 사용자·거래처 ----------
  const uid = {
    victim: await createUser(AGENT.victim, PW.victim),
    attacker: await createUser(AGENT.attacker, PW.attacker),
    inactive: await createUser(AGENT.inactive, PW.inactive, { status: 'suspended' }),
    victim2: await createUser(AGENT.victim2, PW.victim2),
  };
  const acc = {
    vSup: await createAccount(uid.victim, `T112 피해자 공급처 ${RUN}`, 'supplier'),
    vCus: await createAccount(uid.victim, `T112 피해자 판매처 ${RUN}`, 'customer'),
    aSup: await createAccount(uid.attacker, `T112 공격자 공급처 ${RUN}`, 'supplier'),
    aCus: await createAccount(uid.attacker, `T112 공격자 판매처 ${RUN}`, 'customer'),
  };
  const prodId = (await pool.query(`INSERT INTO product (name, unit) VALUES ($1, 'kg') RETURNING id`, [`T112 상품 ${RUN}`])).rows[0].id;

  const srv = startServer({ NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: SECRET, DB_SSL: 'false', LOGIN_MAX_FAILS: '1000' });
  if (!(await waitUp(srv))) {
    console.error('서버가 뜨지 않았습니다:\n' + srv.out.text.slice(-2000));
    process.exitCode = 2;
    await pool.end();
    return;
  }

  try {
    const login = (agent_no, password) => call('POST', '/api/auth/login', { body: { agent_no, password } });
    const lv = await login(AGENT.victim, PW.victim);
    const la = await login(AGENT.attacker, PW.attacker);
    const lw = await login(AGENT.victim2, PW.victim2);
    if (lv.status !== 200 || la.status !== 200 || lw.status !== 200) throw new Error(`준비 로그인 실패 ${lv.status}/${la.status}/${lw.status}`);
    const tok = { victim: lv.json.token, attacker: la.json.token, victim2: lw.json.token };
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

    // 피해자 거래 만들기: 매입 → 매출 전환 → 일부 수금 → 환불 → 폐기
    const vp = await call('POST', '/api/purchases', {
      token: tok.victim,
      body: { partner_id: acc.vSup, product_id: prodId, quantity: 20, unit_price: 1000, purchase_date: today, memo: `T112-V-${RUN}` },
    });
    const vPurchase = vp.json?.data?.id;
    const vc = await call('POST', '/api/purchases/convert-to-sales', {
      token: tok.victim,
      body: { items: [{ purchase_id: vPurchase, partner_id: acc.vCus, quantity: 10, unit_price: 1500, sale_date: today }] },
    });
    const vSale = vc.json?.data?.[0]?.sale_id;
    const vpay = await call('POST', '/api/payments', {
      token: tok.victim,
      body: { partner_id: acc.vCus, amount: 6000, paid_at: today, allocations: [{ sale_id: vSale, amount: 6000 }] },
    });
    const vrf = await call('POST', `/api/sales/${vSale}/refund`, { token: tok.victim, body: { quantity: 1, refunded_at: today, reason: 'T112' } });
    const vds = await call('POST', '/api/disposals', { token: tok.victim, body: { product_id: prodId, quantity: 1, disposal_date: today, reason: 'T112' } });
    const vDisposal = vds.json?.data?.id;
    const vPayment = vpay.json?.data?.id;
    const prepOk = vp.status === 201 && vc.status === 201 && vpay.status === 201 && vrf.status < 300 && vds.status === 201;
    record('P-00', 'P', '준비: 피해자 매입·매출·수금·환불·폐기 생성(API)', prepOk,
      `매입 ${vp.status}#${vPurchase}, 매출 ${vc.status}#${vSale}, 수금 ${vpay.status}#${vPayment}, 환불 ${vrf.status}, 폐기 ${vds.status}#${vDisposal}`);
    // 공격자 자기 매입(교차 전환 시험용)
    const ap = await call('POST', '/api/purchases', {
      token: tok.attacker,
      body: { partner_id: acc.aSup, product_id: prodId, quantity: 5, unit_price: 1000, purchase_date: today },
    });
    const aPurchase = ap.json?.data?.id;

    // ---------- H: 헤더만 바꾼 호출 ----------
    const xh = { 'X-Agent-No': AGENT.victim };
    const getRoutes = [
      '/api/partners',
      '/api/inventory',
      '/api/purchases?from_date=2000-01-01&to_date=2099-12-31',
      '/api/sales?from_date=2000-01-01&to_date=2099-12-31',
      '/api/payments',
      '/api/disposals',
      `/api/reports/daily-purchase-sales?from_date=${today}&to_date=${today}`,
      `/api/reports/daily-purchase-sales-breakdown?from_date=${today}&to_date=${today}`,
    ];
    for (const [i, u] of getRoutes.entries()) {
      const r = await call('GET', u, { headers: xh });
      record(`H-0${i + 1}`, 'H', `X-Agent-No(피해자)만 → GET ${u.split('?')[0]} 401`, r.status === 401, `status=${r.status}`);
    }
    {
      const before = await victimSnapshot(uid.victim);
      const posts = [
        ['/api/purchases', { partner_id: acc.vSup, product_id: prodId, quantity: 1, unit_price: 1, purchase_date: today }],
        ['/api/purchases/convert-to-sales', { items: [{ purchase_id: vPurchase, partner_id: acc.vCus, quantity: 1, unit_price: 1, sale_date: today }] }],
        ['/api/payments', { partner_id: acc.vCus, amount: 1, paid_at: today, allocations: [{ sale_id: vSale, amount: 1 }] }],
        [`/api/sales/${vSale}/refund`, { quantity: 1, refunded_at: today }],
        ['/api/disposals', { product_id: prodId, quantity: 1, disposal_date: today }],
      ];
      const sts = [];
      for (const [u, b] of posts) sts.push((await call('POST', u, { headers: xh, body: b })).status);
      const after = await victimSnapshot(uid.victim);
      record('H-09', 'H', 'X-Agent-No(피해자)만 → 쓰기 API 5종 401, 피해자 데이터 변화 없음', sts.every((s) => s === 401) && before === after,
        `status=${sts.join('/')}, 데이터 변화=${before !== after}`);
    }
    {
      const r = await call('GET', '/api/partners', { token: tok.attacker, headers: xh });
      const ids = idsIn(r) || [];
      record('H-10', 'H', '공격자 토큰 + X-Agent-No(피해자) → 헤더 무시, 공격자 거래처만', r.status === 200 && !ids.includes(acc.vSup) && !ids.includes(acc.vCus) && ids.includes(acc.aSup),
        `status=${r.status}, ids=${ids.join(',')}`);
    }
    {
      const r = await call('GET', '/api/partners', { headers: { 'X-Agent-No': 'admin001' } });
      record('H-11', 'H', 'X-Agent-No(admin001)만 → 401', r.status === 401, `status=${r.status}`);
    }

    // ---------- T: 토큰 변조·형식 ----------
    const [hV, pV, sV] = tok.victim.split('.');
    const pAtt = JSON.parse(Buffer.from(tok.attacker.split('.')[1], 'base64url').toString());
    const nowSec = Math.floor(Date.now() / 1000);
    const tcases = [
      ['T-01', 'Authorization 없음', { headers: {} }],
      ['T-02', 'Bearer 뒤 빈 값', { headers: { Authorization: 'Bearer ' } }],
      ['T-03', 'Bearer 무작위 문자열', { headers: { Authorization: 'Bearer abc.def' } }],
      ['T-04', '점 3개 아닌 형식(4조각)', { token: `${tok.attacker}.x` }],
      ['T-05', 'base64 아닌 헤더 조각', { token: `@@@.${pV}.${sV}` }],
      ['T-06', '서명 무작위 위조', { token: `${hV}.${pV}.${crypto.randomBytes(32).toString('base64url')}` }],
      ['T-07', '서명 빈 값', { token: `${hV}.${pV}.` }],
      ['T-08', '공격자 토큰 payload sub→피해자 id (서명 그대로)', { token: `${tok.attacker.split('.')[0]}.${b64u({ ...pAtt, sub: String(uid.victim) })}.${tok.attacker.split('.')[2]}` }],
      ['T-09', 'alg=none + 서명 없음', { token: `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ ...pAtt, sub: String(uid.victim) })}.` }],
      ['T-10', 'alg=None(대소문자) + 서명 없음', { token: `${b64u({ alg: 'None', typ: 'JWT' })}.${b64u({ ...pAtt, sub: String(uid.victim) })}.` }],
      ['T-11', 'alg=HS512 (실제 비밀로 HS512 서명)', { token: sign(SECRET, { alg: 'HS512', typ: 'JWT' }, { ...pAtt, sub: String(uid.victim) }, 'sha512') }],
      ['T-12', 'alg=RS256 헤더 + HS256 서명(혼동 공격)', { token: sign(SECRET, { alg: 'RS256', typ: 'JWT' }, { ...pAtt, sub: String(uid.victim) }) }],
      ['T-13', '다른 비밀로 서명(HS256)', { token: sign('y'.repeat(64), { alg: 'HS256', typ: 'JWT' }, { ...pAtt, sub: String(uid.victim) }) }],
      ['T-14', '만료 토큰(실제 비밀, exp=1분 전)', { token: sign(SECRET, { alg: 'HS256', typ: 'JWT' }, { sub: String(uid.victim), agent_no: AGENT.victim, iat: nowSec - 3600, exp: nowSec - 60 }) }],
      ['T-15', 'exp 가 문자열(실제 비밀)', { token: sign(SECRET, { alg: 'HS256', typ: 'JWT' }, { sub: String(uid.victim), iat: nowSec, exp: String(nowSec + 3600) }) }],
      ['T-16', 'exp 없음(실제 비밀)', { token: sign(SECRET, { alg: 'HS256', typ: 'JWT' }, { sub: String(uid.victim), iat: nowSec }) }],
      ['T-17', '없는 사용자 sub=99999999(실제 비밀)', { token: sign(SECRET, { alg: 'HS256', typ: 'JWT' }, { sub: '99999999', iat: nowSec, exp: nowSec + 600 }) }],
      ['T-18', "sub='1 OR 1=1'(실제 비밀) → 500 아닌 401", { token: sign(SECRET, { alg: 'HS256', typ: 'JWT' }, { sub: '1 OR 1=1', iat: nowSec, exp: nowSec + 600 }) }],
      ['T-19', 'Basic 스킴에 토큰', { headers: { Authorization: `Basic ${tok.victim}` } }],
      ['T-20', '서명 끝에 패딩(=) 추가', { token: `${tok.victim}=` }],
      ['T-21', '비활성 계정 sub(실제 비밀로 서명)', { token: sign(SECRET, { alg: 'HS256', typ: 'JWT' }, { sub: String(uid.inactive), iat: nowSec, exp: nowSec + 600 }) }],
    ];
    for (const [id, name, opt] of tcases) {
      const r = await call('GET', '/api/partners', opt);
      record(id, 'T', `${name} → 401`, r.status === 401, `status=${r.status}`);
    }
    {
      const r = await call('GET', '/api/partners', { token: tok.victim });
      const ids = idsIn(r) || [];
      record('T-22', 'T', '정상 토큰(대조군) → 200, 자기 거래처', r.status === 200 && ids.includes(acc.vSup), `status=${r.status}`);
      const r2 = await call('GET', '/api/partners', { headers: { Authorization: `bearer ${tok.victim}` } });
      record('T-23', 'T', "소문자 'bearer' 스킴 → 200(RFC 7235 대소문자 무시, 허용 동작)", r2.status === 200, `status=${r2.status}`, { info: true });
    }
    {
      // 발급 후 계정 비활성화 → 같은 토큰 즉시 401 (DB 재확인)
      const r1 = await call('GET', '/api/partners', { token: tok.victim2 });
      await pool.query(`UPDATE "user" SET status='suspended' WHERE id=$1`, [uid.victim2]);
      const r2 = await call('GET', '/api/partners', { token: tok.victim2 });
      record('T-24', 'T', '발급된 토큰도 계정 비활성화 즉시 401', r1.status === 200 && r2.status === 401, `전 ${r1.status} → 후 ${r2.status}`);
    }
    {
      const r = await call('POST', '/api/products', { token: tok.attacker, body: { name: `T112 무권한 ${RUN}` } });
      record('T-25', 'T', '일반 사용자 토큰으로 관리자 API(POST /api/products) → 403', r.status === 403, `status=${r.status}`);
      const forged = sign('z'.repeat(64), { alg: 'HS256', typ: 'JWT' }, { ...pAtt, is_admin: true });
      const r2 = await call('POST', '/api/products', { token: forged, body: { name: `T112 위조관리자 ${RUN}` } });
      record('T-26', 'T', 'payload 에 is_admin:true 넣은 위조 토큰 → 401', r2.status === 401, `status=${r2.status}`);
    }
    {
      // 실제 TTL 만료: 별도 포트를 쓸 수 없어 짧은 TTL 서버를 잠시 같은 포트로 대신 띄우지 않고, 서명된 만료 토큰(T-14)으로 대신한다.
      // 서버 재시작(같은 AUTH_SECRET) 후 기존 토큰 유지 여부는 마지막에 확인한다.
    }

    // ---------- I: 다른 사용자 리소스 (공격자 토큰 + 피해자 ID) ----------
    const before = await victimSnapshot(uid.victim);
    {
      const r = await call('GET', '/api/purchases?from_date=2000-01-01&to_date=2099-12-31', { token: tok.attacker });
      const ids = idsIn(r) || [];
      record('I-01', 'I', '매입 조회(전체 기간)에 피해자 매입 없음', r.status === 200 && !ids.includes(vPurchase) && ids.includes(aPurchase), `ids=${ids.join(',')}`);
    }
    {
      const r = await call('GET', '/api/sales?from_date=2000-01-01&to_date=2099-12-31', { token: tok.attacker });
      const ids = idsIn(r) || [];
      const r2 = await call('GET', `/api/sales?unpaid_only=1&partner_id=${acc.vCus}`, { token: tok.attacker });
      const r3 = await call('GET', `/api/sales?refundable_only=1`, { token: tok.attacker });
      const leak = [...ids, ...(idsIn(r2) || []), ...(idsIn(r3) || [])].includes(vSale);
      record('I-02', 'I', '매출 조회(전체·미수·환불가능·피해자 partner_id)에 피해자 매출 없음', r.status === 200 && r2.status === 200 && r3.status === 200 && !leak,
        `status=${r.status}/${r2.status}/${r3.status}, 노출=${leak}`);
    }
    {
      const r = await call('GET', `/api/payments?partner_id=${acc.vCus}`, { token: tok.attacker });
      const r2 = await call('GET', '/api/payments', { token: tok.attacker });
      const leak = [...(idsIn(r) || []), ...(idsIn(r2) || [])].includes(vPayment);
      record('I-03', 'I', '수금 조회(피해자 partner_id 포함)에 피해자 수금 없음', r.status === 200 && r2.status === 200 && !leak, `노출=${leak}`);
    }
    {
      const r = await call('GET', '/api/disposals', { token: tok.attacker });
      const leak = (idsIn(r) || []).includes(vDisposal);
      record('I-04', 'I', '폐기 조회에 피해자 폐기 없음', r.status === 200 && !leak, `노출=${leak}`);
    }
    {
      const r = await call('GET', '/api/partners', { token: tok.attacker });
      const ids = idsIn(r) || [];
      record('I-05', 'I', '거래처 조회에 피해자 거래처 없음', r.status === 200 && !ids.includes(acc.vSup) && !ids.includes(acc.vCus), `ids=${ids.join(',')}`);
    }
    {
      const r = await call('GET', '/api/inventory', { token: tok.attacker });
      const rows = r.json?.data || [];
      const row = rows.find((x) => x.product_id === prodId);
      // 공격자 재고는 자기 매입 5 뿐이어야 한다(피해자 재고 20-10-1-1 이 섞이면 안 됨)
      record('I-06', 'I', '재고 조회에 피해자 재고가 섞이지 않음(공격자 수량=5)', r.status === 200 && row && Number(row.quantity) === 5,
        `공격자 재고=${row ? row.quantity : '없음'}, 최근 거래처=${row ? row.last_partner_name : '-'}`);
    }
    {
      const r = await call('GET', `/api/reports/daily-purchase-sales?from_date=${today}&to_date=${today}&partner_id=${acc.vCus}`, { token: tok.attacker });
      const d = r.json?.data?.[0] || {};
      const r2 = await call('GET', `/api/reports/daily-purchase-sales?from_date=${today}&to_date=${today}`, { token: tok.attacker });
      const d2 = r2.json?.data?.[0] || {};
      const ok = r.status === 200 && Number(d.sales_amount) === 0 && Number(d.purchase_amount) === 0 && Number(d2.sales_amount) === 0 && Number(d2.purchase_amount) === 5000;
      record('I-07', 'I', '일별 집계에 피해자 매입·매출 금액이 섞이지 않음', ok,
        `피해자 partner_id 지정 시 매입 ${d.purchase_amount}/매출 ${d.sales_amount}, 전체 매입 ${d2.purchase_amount}/매출 ${d2.sales_amount}`);
    }
    {
      const r = await call('GET', `/api/reports/daily-purchase-sales-breakdown?from_date=${today}&to_date=${today}`, { token: tok.attacker });
      const leak = r.text.includes(`T112 피해자`) || r.text.includes(`T112-V-${RUN}`);
      record('I-08', 'I', '일별 상세 집계에 피해자 거래처·메모 없음', r.status === 200 && !leak, `status=${r.status}, 노출=${leak}`);
    }
    const writeCases = [
      ['I-09', '피해자 공급처로 매입 등록', 'POST', '/api/purchases', { partner_id: acc.vSup, product_id: prodId, quantity: 1, unit_price: 1, purchase_date: today }],
      // I-10·I-11: DEF-T112-03 — 예전 500, T-114 뒤 404(남의 ID 는 '없음'과 같게)
      ['I-10', '피해자 매입을 매출로 전환', 'POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: vPurchase, partner_id: acc.aCus, quantity: 1, unit_price: 1, sale_date: today }] }, 404],
      ['I-11', '자기 매입을 피해자 판매처로 전환', 'POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: aPurchase, partner_id: acc.vCus, quantity: 1, unit_price: 1, sale_date: today }] }, 404],
      ['I-12', '피해자 판매처로 수금 등록(refund 종류)', 'POST', '/api/payments', { partner_id: acc.vCus, amount: 1, paid_at: today, entry_kind: 'refund' }],
      ['I-13', '자기 거래처 수금에 피해자 매출 배분', 'POST', '/api/payments', { partner_id: acc.aCus, amount: 1, paid_at: today, allocations: [{ sale_id: vSale, amount: 1 }] }],
      ['I-14', '피해자 매출 환불', 'POST', `/api/sales/${vSale}/refund`, { quantity: 1, refunded_at: today, reason: 'T112-attack' }],
      ['I-15', '피해자만 재고 있는 수량 폐기(공격자 재고 초과)', 'POST', '/api/disposals', { product_id: prodId, quantity: 7, disposal_date: today }],
    ];
    for (const [id, name, m, u, b, expect] of writeCases) {
      const r = await call(m, u, { token: tok.attacker, body: b });
      const ok = expect ? r.status === expect : r.status >= 400 && r.status < 500;
      record(id, 'I', `${name} → 거절(${expect || '4xx'})`, ok, `status=${r.status} ${r.json?.message || ''}`);
    }
    const after = await victimSnapshot(uid.victim);
    record('I-16', 'I', '공격 시도 전후 피해자 데이터(매입·매출·수금·환불·폐기·재고·거래처·배분) 동일', before === after, before === after ? '동일' : '변경됨');

    // ---------- E: 로그인 실패 메시지·계정 존재 노출 ----------
    {
      const ghost = await login(AGENT.ghost, PW.wrong);
      const wrong = await login(AGENT.victim, PW.wrong);
      const same = ghost.status === wrong.status && ghost.json?.message === wrong.json?.message;
      record('E-01', 'E', '없는 번호 vs 있는 번호+틀린 비밀번호 → 같은 상태·문구', same, `${ghost.status} "${ghost.json?.message}" / ${wrong.status} "${wrong.json?.message}"`);
      const inact = await login(AGENT.inactive, PW.wrong);
      const same2 = inact.status === ghost.status && inact.json?.message === ghost.json?.message;
      record('E-02', 'E', '비활성 계정 + 틀린 비밀번호 → 없는 번호와 같은 응답(비밀번호 확인 전 상태 노출 금지)', same2,
        `비활성 ${inact.status} "${inact.json?.message}" / 없는 번호 ${ghost.status} "${ghost.json?.message}"`);
      const noPw = await login(AGENT.victim, undefined);
      const noPwG = await login(AGENT.ghost, undefined);
      record('E-03', 'E', '비밀번호 누락 → 번호 존재와 무관하게 같은 400', noPw.status === 400 && noPwG.status === 400 && noPw.json?.message === noPwG.json?.message, `${noPw.status}/${noPwG.status}`);
      // 응답 시간 차이(없는 번호는 bcrypt 비교를 건너뜀)
      const tg = [];
      const tw = [];
      for (let i = 0; i < 7; i++) {
        tg.push((await login(AGENT.ghost, PW.wrong)).ms);
        tw.push((await login(AGENT.victim, PW.wrong)).ms);
      }
      const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
      const diff = med(tw) - med(tg);
      record('E-04', 'E', '응답 시간으로 계정 존재 추정 불가(중앙값 차 < 20ms)', diff < 20,
        `없는 번호 중앙값 ${med(tg).toFixed(1)}ms / 있는 번호 ${med(tw).toFixed(1)}ms / 차 ${diff.toFixed(1)}ms`);
      const ca = await call('POST', '/api/auth/check-agent-no', { body: { agent_no: AGENT.victim } });
      const cg = await call('POST', '/api/auth/check-agent-no', { body: { agent_no: AGENT.ghost } });
      record('E-05', 'E', '가입용 중복 확인 API는 로그인 없이 번호 존재 여부를 알려 줌(가입 기능상 의도, 관찰)', true,
        `있는 번호 ${ca.status} ${JSON.stringify(ca.json)} / 없는 번호 ${cg.status} ${JSON.stringify(cg.json)}`, { info: true });
      // 예전 E-06(관찰: 15회 실패에도 잠금 없음)은 T-114 에서 N-01~N-05 판정 케이스로 바뀌었다
      const okInact = await login(AGENT.inactive, PW.inactive);
      record('E-06', 'E', '비활성 계정 + 맞는 비밀번호 → 403(비밀번호를 아는 본인에게만 상태 안내)', okInact.status === 403,
        `${okInact.status} "${okInact.json?.message}"`);
    }

    // ---------- L: 서버 로그 ----------
    await call('POST', '/api/auth/register', {
      body: { name: 'T112', email: `reg-${RUN.toLowerCase()}@t112.local`, agent_no: `T112R${RUN}`, password: PW.register, terms_agreed: true },
    });
    await sleep(300);
    {
      const log = srv.out.text;
      const leaked = Object.entries(PW).filter(([, v]) => log.includes(v)).map(([k]) => k);
      record('L-01', 'L', '서버 로그에 로그인·가입 요청 비밀번호(성공·실패·가입 6종) 없음', leaked.length === 0, leaked.length ? `노출: ${leaked.join(',')}` : `로그 ${log.length}자 검사, 0건`);
      const tLeak = Object.values(tok).filter((t) => log.includes(t) || log.includes(t.split('.')[2])).length;
      record('L-02', 'L', '서버 로그에 발급 토큰·서명 없음', tLeak === 0, `${tLeak}건`);
      record('L-03', 'L', '서버 로그에 AUTH_SECRET 없음', !log.includes(SECRET), log.includes(SECRET) ? '노출' : '0건');
      const loginLines = (log.match(/\[login\][^\n]*/g) || []).length;
      record('L-04', 'L', '로그인 로그는 중매인 번호만 남김(관찰)', true, `[login] 줄 ${loginLines}개`, { info: true });
    }
  } finally {
    await stopServer(srv);
  }

  // ---------- N: 보안 보강(T-114) — 짧은 잠금 시간·작은 한도로 별도 서버 ----------
  {
    const nsrv = startServer({
      NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: SECRET, DB_SSL: 'false',
      LOGIN_MAX_FAILS: '5', LOGIN_LOCK_MINUTES: String(3 / 60), // 5회 실패 → 3초 잠금(운영 기본 15분)
      CHECK_AGENT_MAX: '3', CHECK_AGENT_WINDOW_MINUTES: '1',
    });
    if (!(await waitUp(nsrv))) {
      record('N-00', 'N', 'N 그룹 서버 시작', false, nsrv.out.text.slice(-300));
    } else {
      try {
        const login = (agent_no, password) => call('POST', '/api/auth/login', { body: { agent_no, password } });
        // N-01: 있는 번호 5회 실패 → 6번째는 맞는 비밀번호여도 429 + Retry-After
        const st = [];
        for (let i = 0; i < 5; i++) st.push((await login(AGENT.attacker, `${PW.wrong}${i}`)).status);
        const r6raw = await fetch(BASE + '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_no: AGENT.attacker, password: PW.attacker }),
        });
        const r6 = { status: r6raw.status, retry: r6raw.headers.get('retry-after'), json: await r6raw.json().catch(() => null) };
        record('N-01', 'N', '있는 번호 5회 연속 실패 → 맞는 비밀번호도 429 + Retry-After', st.every((x) => x === 401) && r6.status === 429 && !!r6.retry,
          `실패 ${st.join(',')} → ${r6.status} Retry-After=${r6.retry} "${r6.json?.message}"`);
        // N-02: 없는 번호도 똑같이 막힘(막힘 여부로 계정 존재를 알 수 없음)
        const sg = [];
        for (let i = 0; i < 6; i++) sg.push((await login(AGENT.ghost, PW.wrong)).status);
        record('N-02', 'N', '없는 번호도 5회 실패 뒤 같은 429(계정 존재 노출 없음)', sg.slice(0, 5).every((x) => x === 401) && sg[5] === 429, sg.join(','));
        // N-03: 대소문자만 바꿔도 같은 키
        const lower = await login(AGENT.attacker.toLowerCase(), PW.attacker);
        record('N-03', 'N', '번호 대소문자를 바꿔도 같은 잠금', lower.status === 429, `status=${lower.status}`);
        // N-04: 잠금 시간이 지나면 맞는 비밀번호로 로그인되고, 다음 실패는 다시 401부터
        await sleep(3300);
        const back = await login(AGENT.attacker, PW.attacker);
        const after1 = await login(AGENT.attacker, PW.wrong);
        record('N-04', 'N', '잠금 시간 뒤 정상 로그인 200, 다음 실패는 다시 401', back.status === 200 && after1.status === 401, `${back.status} / ${after1.status}`);
        // N-05: 다른 계정은 영향 없음
        const other = await login(AGENT.victim, PW.victim);
        record('N-05', 'N', '다른 계정 로그인은 영향 없음', other.status === 200, `status=${other.status}`);
        // N-06: check-agent-no 접속 주소당 제한(테스트 한도 3회, 운영 기본 20회/10분)
        const ca = [];
        for (let i = 0; i < 4; i++) ca.push((await call('POST', '/api/auth/check-agent-no', { body: { agent_no: `N${RUN}${i}` } })).status);
        record('N-06', 'N', '번호 중복 확인 한도 초과 → 429', ca.slice(0, 3).every((x) => x === 200) && ca[3] === 429, ca.join(','));
        // N-07~09: 가입 비밀번호 길이 — 서버는 이메일 인증 확인보다 비밀번호 검사를 먼저 한다
        const reg = (agent, password) => call('POST', '/api/auth/register', {
          body: { name: 'T114', email: `${agent.toLowerCase()}@t114.local`, agent_no: agent, password, terms_agreed: true },
        });
        const short = await reg(`T114S${RUN}`, 'Ab1234!');
        record('N-07', 'N', '가입 비밀번호 7자 → 400 "8자 이상"', short.status === 400 && /8자/.test(short.json?.message || ''), `${short.status} "${short.json?.message}"`);
        const long = await reg(`T114L${RUN}`, '가'.repeat(25)); // 75바이트
        record('N-08', 'N', '가입 비밀번호 72바이트 초과(한글 25자) → 400', long.status === 400 && /깁니다/.test(long.json?.message || ''), `${long.status} "${long.json?.message}"`);
        const ok8 = await reg(`T114K${RUN}`, `Ok8-${crypto.randomBytes(2).toString('hex')}`);
        record('N-09', 'N', '가입 비밀번호 8자 → 비밀번호 검사 통과(다음 단계 "이메일 인증" 안내)', ok8.status === 400 && /이메일 인증/.test(ok8.json?.message || ''),
          `${ok8.status} "${ok8.json?.message}"`);
        // N-10: 업로드 경로 기본 꺼짐 → 인증 없이도 본문을 읽지 않고 404
        const up0 = await call('POST', '/api/file-transfer/salesforce/content-version', {});
        record('N-10', 'N', '업로드 경로 기본 꺼짐(ENABLE_SF_UPLOAD 없음) → 404', up0.status === 404, `status=${up0.status}`);
      } finally {
        await stopServer(nsrv);
      }
    }
    // N-11·12: 업로드 켬 + 한도 1MB 서버
    const usrv = startServer({ NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: SECRET, DB_SSL: 'false', ENABLE_SF_UPLOAD: 'true', SF_UPLOAD_MAX_MB: '1' });
    if (await waitUp(usrv)) {
      try {
        const big = new Blob([Buffer.alloc(2 * 1024 * 1024, 0x61)]);
        const fd1 = new FormData();
        fd1.append('file', big, 'big.txt');
        const noAuth = await fetch(BASE + '/api/file-transfer/salesforce/content-version', { method: 'POST', body: fd1 });
        record('N-11', 'N', '업로드 켬 + 로그인 없음 → 파일 받기 전 401', noAuth.status === 401, `status=${noAuth.status}`);
        const la = await call('POST', '/api/auth/login', { body: { agent_no: AGENT.attacker, password: PW.attacker } });
        const fd2 = new FormData();
        fd2.append('file', big, 'big.txt');
        const over = await fetch(BASE + '/api/file-transfer/salesforce/content-version', {
          method: 'POST', body: fd2, headers: { Authorization: `Bearer ${la.json?.token}` },
        });
        record('N-12', 'N', '업로드 켬 + 로그인 + 한도(1MB) 초과 2MB → 413', over.status === 413, `status=${over.status}`);
      } finally {
        await stopServer(usrv);
      }
    } else {
      record('N-11', 'N', '업로드 서버 시작', false, usrv.out.text.slice(-300));
    }
  }

  // ---------- A: seed-admin 운영 안전장치 (T-114, R-01) ----------
  {
    const runSeed = (env) => new Promise((resolve) => {
      const c = spawn(process.execPath, [path.join('scripts', 'seed-admin.js')], {
        cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: DB_URL, DB_SSL: 'false', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      c.stdout.on('data', (d) => (text += d.toString()));
      c.stderr.on('data', (d) => (text += d.toString()));
      c.on('exit', (code) => resolve({ code, text }));
    });
    const p1 = await runSeed({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: '' });
    record('A-01', 'A', 'seed-admin: NODE_ENV=production + SEED_ADMIN_PASSWORD 없음 → 거부(exit 2)', p1.code === 2 && /거부/.test(p1.text),
      `exit=${p1.code} ${p1.text.trim().split('\n')[0]}`);
    const p2 = await runSeed({ NODE_ENV: 'production', SEED_ADMIN_PASSWORD: 'x'.repeat(11) });
    record('A-02', 'A', 'seed-admin: 운영 + 11자 비밀번호 → 거부(exit 2)', p2.code === 2, `exit=${p2.code}`);
    const hashOf = async () => (await pool.query(`SELECT password_hash FROM "user" WHERE agent_no = 'admin001'`)).rows[0]?.password_hash || null;
    const d1 = await runSeed({ NODE_ENV: 'development', SEED_ADMIN_PASSWORD: `Seed1-${crypto.randomBytes(8).toString('hex')}` });
    const h1 = await hashOf();
    const d2 = await runSeed({ NODE_ENV: 'development', SEED_ADMIN_PASSWORD: `Seed2-${crypto.randomBytes(8).toString('hex')}` });
    const h2 = await hashOf();
    record('A-03', 'A', 'seed-admin 재실행: 기존 계정 비밀번호를 덮어쓰지 않음', d1.code === 0 && d2.code === 0 && !!h1 && h1 === h2 && /바꾸지 않았습니다/.test(d2.text),
      `exit=${d1.code}/${d2.code}, 해시 동일=${h1 === h2}`);
    const leaked = /Seed[12]-/.test(d1.text + d2.text + p1.text + p2.text);
    record('A-04', 'A', 'seed-admin 출력에 넣은 비밀번호 없음', !leaked, leaked ? '노출' : '0건');
  }

  // ---------- R: 같은 AUTH_SECRET 으로 재시작 → 기존 토큰 유지, 다른 비밀로 재시작 → 무효 ----------
  {
    const lsrv = startServer({ NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: SECRET, DB_SSL: 'false' });
    await waitUp(lsrv);
    const l = await call('POST', '/api/auth/login', { body: { agent_no: AGENT.attacker, password: PW.attacker } });
    await stopServer(lsrv);
    const s2 = startServer({ NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: SECRET, DB_SSL: 'false' });
    await waitUp(s2);
    const r1 = await call('GET', '/api/partners', { token: l.json?.token });
    await stopServer(s2);
    const s3 = startServer({ NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: crypto.randomBytes(32).toString('hex'), DB_SSL: 'false' });
    await waitUp(s3);
    const r2 = await call('GET', '/api/partners', { token: l.json?.token });
    await stopServer(s3);
    record('R-01', 'R', '같은 AUTH_SECRET 재시작 → 기존 토큰 200, 비밀 교체 → 401', r1.status === 200 && r2.status === 401, `같은 비밀 ${r1.status} / 교체 ${r2.status}`);
    const s4 = startServer({ NODE_ENV: 'development', DATABASE_URL: DB_URL, AUTH_SECRET: SECRET, DB_SSL: 'false', AUTH_TOKEN_TTL_HOURS: String(2 / 3600) });
    await waitUp(s4);
    const l2 = await call('POST', '/api/auth/login', { body: { agent_no: AGENT.attacker, password: PW.attacker } });
    const a1 = await call('GET', '/api/partners', { token: l2.json?.token });
    await sleep(3500);
    const a2 = await call('GET', '/api/partners', { token: l2.json?.token });
    await stopServer(s4);
    record('R-02', 'R', 'TTL 2초 서버: 발급 직후 200 → 3.5초 뒤 401', a1.status === 200 && a2.status === 401, `직후 ${a1.status} / 3.5초 뒤 ${a2.status} (expires_in=${l2.json?.expires_in})`);
  }

  await pool.end();

  const counted = results.filter((r) => r.result !== 'INFO');
  const pass = counted.filter((r) => r.result === 'PASS').length;
  const fail = counted.length - pass;
  const info = results.length - counted.length;
  console.log(`\n=== 결과: 판정 ${counted.length}건 중 통과 ${pass} · 실패 ${fail} (관찰 ${info}건 별도) ===`);
  if (process.env.AUTH_TEST_OUT) {
    fs.writeFileSync(process.env.AUTH_TEST_OUT, JSON.stringify({ run: RUN, at: new Date().toISOString(), total: counted.length, pass, fail, info, results }, null, 2), 'utf8');
  }
  process.exitCode = fail ? 1 : 0;
}

main().catch(async (e) => {
  console.error('테스트 실행 오류:', e);
  process.exitCode = 2;
  await pool.end().catch(() => {});
});
