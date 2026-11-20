/**
 * T-212 변경 이력(감사 로그) 검사 — GET /api/history + audit_log(019) 기록
 * 확인: 기록 생성(로그인·거래처 등록·수정·매입 수정·매입 취소·지급 취소·품목 요청·반려) · 전·후 값 ·
 *       값이 같은 수정은 기록 안 함 · 권한(401, 남의 이력·남의 거래처 필터 0건) · 필터(기간·종류·거래처) ·
 *       잘못된 값 400 · 페이지(limit·offset·total, 이어 붙이면 전체와 같음) · 기록 실패가 업무 저장을 막지 않음
 * 사용: server 폴더에서
 *   DATABASE_URL=<테스트 DB> HISTORY_API_BASE=http://127.0.0.1:<포트> node scripts/audit-history-test.js
 * 전제: 마이그레이션 001~016 + 019, seed-admin(admin001/sample 또는 SMOKE_PASSWORD), 서버 기동.
 * 테스트 DB 전용 — 회원 3명을 DB에 직접 만든다(비밀번호는 실행마다 무작위, 기록 안 함).
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.HISTORY_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[audit-history-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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
function check(id, name, cond, detail = '') {
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
const kstDate = (offsetDays = 0) => new Date(Date.now() + 9 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const TODAY = kstDate(0);
  const YESTERDAY = kstDate(-1);
  const admin = await login('admin001', process.env.SMOKE_PASSWORD || 'sample');
  const mkUser = async (suffix) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const agent = `t212_${suffix}_${tag}`;
    const r = await pool.query(
      `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
       VALUES ($1, NULL, $2, $3, $4, NOW(), 'active', false) RETURNING id`,
      [`T212 ${suffix}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
    );
    return { id: r.rows[0].id, agent, pw };
  };
  const ua = await mkUser('a');
  const ub = await mkUser('b');
  const uc = await mkUser('c');
  const A = await login(ua.agent, ua.pw);
  const B = await login(ub.agent, ub.pw);
  const hist = (token, q = '') => request('GET', `/api/history${q}`, null, token);
  const all = async (token, q = '') => {
    const r = await hist(token, `?limit=200${q}`);
    return r.json?.data || [];
  };

  // ---------- 권한 ----------
  let r = await hist(null);
  check('AH-01', '토큰 없음 → 401', r.status === 401, `status=${r.status}`);

  // ---------- 로그인 기록 ----------
  let rows = await all(A);
  const loginsA = rows.filter((x) => x.kind === 'login');
  check('AH-02', '로그인 성공 → login 기록 1건, 전·후 값 없음', loginsA.length === 1 && loginsA[0].changes.length === 0 && loginsA[0].actor === 'self', JSON.stringify(loginsA));
  const failed = await request('POST', '/api/auth/login', { agent_no: ua.agent, password: 'wrong-password' });
  rows = await all(A);
  check('AH-03', '로그인 실패는 기록 안 함(비밀번호 등 남기지 않음)', failed.status === 401 && rows.filter((x) => x.kind === 'login').length === 1);
  const raw = (await pool.query('SELECT before_data, after_data, note FROM audit_log WHERE user_id = $1 AND entity_type = $2', [ua.id, 'auth'])).rows;
  check('AH-04', 'audit_log 로그인 행에 비밀번호·토큰 없음', raw.length === 1 && raw[0].before_data == null && raw[0].after_data == null && !/pw|token|password/i.test(String(raw[0].note)));

  // ---------- 거래처 등록·수정 ----------
  const K = mustOk(await request('POST', '/api/partners', { name: `T212-K농산-${tag}`, type: 'supplier', phone: '010-1111-2222' }, A), '거래처 K');
  const G = mustOk(await request('POST', '/api/partners', { name: `T212-가락상회-${tag}`, type: 'customer' }, A), '거래처 G');
  const KB = mustOk(await request('POST', '/api/partners', { name: `T212-B농산-${tag}`, type: 'supplier' }, B), '거래처 B');
  rows = await all(A, '&kind=partner');
  const kCreate = rows.find((x) => x.partner_id === K.id);
  check('AH-05', '거래처 등록 → partner 기록, 이름·유형·전화 값(전 값 없음)',
    kCreate && kCreate.reason === '등록' && kCreate.partner_name === K.name &&
      ['name', 'type', 'phone'].every((f) => kCreate.changes.some((c) => c.field === f && c.before == null)) &&
      kCreate.changes.find((c) => c.field === 'name').after === K.name,
    JSON.stringify(kCreate));
  mustOk(await request('PUT', `/api/partners/${K.id}`, { phone: '010-3333-4444', memo: '오전 거래' }, A), '거래처 수정');
  rows = await all(A, '&kind=partner');
  const kUpd = rows.find((x) => x.partner_id === K.id && x.reason === '수정');
  const ph = kUpd?.changes.find((c) => c.field === 'phone');
  const memo = kUpd?.changes.find((c) => c.field === 'memo');
  check('AH-06', '거래처 수정 → 전화 전·후 값, 비고(없음→값), 바뀐 열만',
    kUpd && kUpd.changes.length === 2 && ph && /1111/.test(ph.before) && /3333/.test(ph.after) && memo && memo.before == null && memo.after === '오전 거래',
    JSON.stringify(kUpd));
  const before = rows.length;
  mustOk(await request('PUT', `/api/partners/${K.id}`, { memo: '오전 거래' }, A), '같은 값 수정');
  rows = await all(A, '&kind=partner');
  check('AH-07', '값이 같은 수정은 기록 안 함', rows.length === before, `${before} → ${rows.length}`);
  r = await request('PUT', `/api/partners/${KB.id}`, { memo: '남의 것' }, A);
  check('AH-08', '남의 거래처 수정 404 + 기록 없음', r.status === 404 && (await all(A)).every((x) => x.partner_id !== KB.id));

  // ---------- 매입 수정(정정)·취소 — 기존 trade_correction 재사용 ----------
  const product = mustOk(await request('POST', '/api/products', { name: `T212-배추-${tag}`, unit: 'kg' }, admin), '상품');
  const buy = async (price) =>
    mustOk(await request('POST', '/api/purchases', { partner_id: K.id, product_id: product.id, quantity: 10, unit_price: price, purchase_date: TODAY }, A), '매입');
  const p1 = await buy(1000);
  const p2 = await buy(2000);
  r = await request('PATCH', `/api/purchases/${p1.id}`, { reason: '단가 오타', changes: { unit_price: 1200 } }, A);
  mustOk(r, '매입 단가 수정');
  rows = await all(A, '&kind=correction');
  const corr = rows.find((x) => x.target_type === 'purchase' && x.target_id === p1.id);
  const up = corr?.changes.find((c) => c.field === 'unit_price');
  check('AH-09', '매입 단가 수정 → correction, 단가 1000→1200, 사유, 거래처·품목 표시, _row 같은 내부 값 숨김',
    corr && up && Number(up.before) === 1000 && Number(up.after) === 1200 && corr.reason === '단가 오타' &&
      corr.partner_id === K.id && corr.partner_name === K.name && /배추/.test(corr.target_label) && corr.changes.every((c) => !c.field.startsWith('_')),
    JSON.stringify(corr));
  mustOk(await request('POST', `/api/purchases/${p2.id}/cancel`, { reason: '중복 입력' }, A), '매입 취소');
  rows = await all(A, '&kind=cancel');
  const canc = rows.find((x) => x.target_id === p2.id);
  check('AH-10', '매입 취소 → cancel, 상태 정상→취소, 사유',
    canc && canc.reason === '중복 입력' && canc.changes.some((c) => c.field === 'status' && c.before === 'active' && c.after === 'cancelled'),
    JSON.stringify(canc));

  // ---------- 지급 취소 — 기존 supplier_payment 재사용 ----------
  const pay = mustOk(
    await request('POST', '/api/supplier-payments', { partner_id: K.id, amount: 5000, paid_at: `${TODAY}T10:00`, method: 'transfer', allocations: [{ purchase_id: p1.id, amount: 5000 }] }, A),
    '지급'
  );
  rows = await all(A, '&kind=payment_cancel');
  check('AH-11', '취소 전 지급은 이력에 없음', rows.length === 0);
  mustOk(await request('POST', `/api/supplier-payments/${pay.id}/cancel`, { reason: '금액 오입력' }, A), '지급 취소');
  rows = await all(A, '&kind=payment_cancel');
  check('AH-12', '지급 취소 → payment_cancel, 금액·사유·거래처',
    rows.length === 1 && rows[0].reason === '금액 오입력' && rows[0].partner_id === K.id &&
      Number(rows[0].changes.length) === 1 && rows[0].changes[0].after === 'cancelled',
    JSON.stringify(rows));

  // ---------- 품목 공용 요청·반려 — 기존 product_request 재사용 ----------
  const mango = mustOk(await request('POST', '/api/products/personal', { name: `T212-망고-${tag}`, unit: 'box' }, A), '개인 품목');
  const req1 = mustOk(await request('POST', '/api/products/requests', { product_id: mango.id, note: '공용으로' }, A), '요청');
  mustOk(await request('POST', `/api/products/requests/${req1.id}/reject`, { reason: '이미 비슷한 품목 있음' }, admin), '반려');
  rows = await all(A, '&kind=product_request');
  const reqRow = rows.find((x) => x.source === 'product_request');
  const revRow = rows.find((x) => x.source === 'product_request_review');
  check('AH-13', '품목 요청 → 요청 1건 + 반려 1건(관리자, 반려 사유, 대기→반려)',
    rows.length === 2 && reqRow && reqRow.reason === '공용으로' && revRow && revRow.actor === 'admin' &&
      revRow.reason === '이미 비슷한 품목 있음' && revRow.changes[0].before === 'pending' && revRow.changes[0].after === 'rejected',
    JSON.stringify(rows));
  const adminRows = await all(admin, '&kind=product_request');
  check('AH-14', '관리자는 자기가 한 반려를 "본인"으로 봄(요청 원본 행은 안 보임)',
    adminRows.some((x) => x.source === 'product_request_review' && x.source_id === req1.id && x.actor === 'self') &&
      !adminRows.some((x) => x.source === 'product_request' && x.source_id === req1.id));

  // ---------- 권한: 남의 이력 ----------
  const rowsB = await all(B);
  check('AH-15', 'B 이력에는 B 로그인·B 거래처만(A 기록 0건)',
    rowsB.length === 2 && rowsB.every((x) => x.kind === 'login' || x.partner_id === KB.id), JSON.stringify(rowsB.map((x) => [x.kind, x.partner_id])));
  r = await hist(A, `?partner_id=${KB.id}`);
  check('AH-16', 'A가 B 거래처로 필터 → 0건', r.status === 200 && r.json.total === 0);
  r = await hist(B, `?partner_id=${K.id}`);
  check('AH-17', 'B가 A 거래처로 필터 → 0건', r.status === 200 && r.json.total === 0);

  // ---------- 필터 ----------
  r = await hist(A, `?partner_id=${K.id}&limit=200`);
  const kinds = new Set(r.json.data.map((x) => x.kind));
  check('AH-18', '거래처 필터 → 그 거래처 기록만(등록·수정·정정·취소·지급 취소)',
    r.json.data.every((x) => x.partner_id === K.id) && ['partner', 'correction', 'cancel', 'payment_cancel'].every((k) => kinds.has(k)), [...kinds].join(','));
  r = await hist(A, `?partner_id=${G.id}`);
  check('AH-19', '다른 거래처(G) → G 등록 1건만', r.json.total === 1 && r.json.data[0].partner_id === G.id);
  r = await hist(A, `?from_date=${TODAY}&to_date=${TODAY}`);
  const totalToday = r.json.total;
  const totalAll = (await hist(A)).json.total;
  check('AH-20', '오늘 기간 → 전체와 같은 건수(전부 오늘 생성)', totalToday === totalAll && totalAll >= 9, `${totalToday}/${totalAll}`);
  r = await hist(A, `?from_date=${YESTERDAY}&to_date=${YESTERDAY}`);
  check('AH-21', '어제 기간 → 0건', r.status === 200 && r.json.total === 0);
  // KST 경계: 어제 23:59:59 KST(=UTC 14:59:59) 행은 어제에, 오늘 00:00 KST 행은 오늘에
  await pool.query(
    `INSERT INTO audit_log (user_id, entity_type, action, note, created_at) VALUES
       ($1, 'auth', 'login', '경계-어제', ($2::date + time '23:59:59') AT TIME ZONE 'Asia/Seoul'),
       ($1, 'auth', 'login', '경계-오늘', ($3::date + time '00:00:00') AT TIME ZONE 'Asia/Seoul')`,
    [ua.id, YESTERDAY, TODAY]
  );
  r = await hist(A, `?from_date=${YESTERDAY}&to_date=${YESTERDAY}`);
  const r2 = await hist(A, `?from_date=${TODAY}&to_date=${TODAY}&kind=login`);
  check('AH-22', 'KST 날짜 경계(23:59:59 → 어제, 00:00 → 오늘)',
    r.json.total === 1 && r.json.data[0].reason === '경계-어제' && r2.json.data.some((x) => x.reason === '경계-오늘'),
    `${r.json.total} ${JSON.stringify(r2.json.data.map((x) => x.reason))}`);
  const bad = [
    ['from_date=2026-13-01', 'from_date'],
    ['to_date=20261120', 'to_date'],
    [`from_date=${TODAY}&to_date=${YESTERDAY}`, 'from_date'],
    ['kind=delete', 'kind'],
    ['partner_id=abc', 'partner_id'],
    ['partner_id=0', 'partner_id'],
    ['limit=201', 'limit'],
    ['offset=-1', 'offset'],
    ["kind=login'%20OR%201=1--", 'kind'],
  ];
  let badOk = true;
  for (const [q, field] of bad) {
    const x = await hist(A, `?${q}`);
    if (x.status !== 400 || x.json?.field !== field) {
      badOk = false;
      console.log('   잘못된 값', q, x.status, x.json?.field);
    }
  }
  check('AH-23', `잘못된 값 ${bad.length}종 → 400(field 표시)`, badOk);

  // ---------- 페이지 ----------
  const C = await login(uc.agent, uc.pw);
  await pool.query(
    `INSERT INTO audit_log (user_id, entity_type, action, note, created_at)
     SELECT $1, 'auth', 'login', '로그인', NOW() - (g || ' minutes')::interval FROM generate_series(1, 119) g`,
    [uc.id]
  );
  r = await hist(C);
  check('AH-24', '기본(파라미터 없음) → 50건 첫 쪽 + total 120', r.json.data.length === 50 && r.json.total === 120 && r.json.limit === 50 && r.json.offset === 0, `${r.json.data.length}/${r.json.total}`);
  const p1r = (await hist(C, '?limit=50&offset=0')).json;
  const p2r = (await hist(C, '?limit=50&offset=50')).json;
  const p3r = (await hist(C, '?limit=50&offset=100')).json;
  const joined = [...p1r.data, ...p2r.data, ...p3r.data];
  const whole = (await hist(C, '?limit=200')).json.data;
  check('AH-25', '50·50·20 쪽, 이어 붙인 순서 = 전체 순서, 중복 없음',
    p1r.data.length === 50 && p2r.data.length === 50 && p3r.data.length === 20 &&
      joined.map((x) => x.source_id).join() === whole.map((x) => x.source_id).join() && new Set(joined.map((x) => x.source_id)).size === 120);
  const sorted = whole.every((x, i) => i === 0 || new Date(whole[i - 1].occurred_at) >= new Date(x.occurred_at));
  check('AH-26', '최근 순 정렬', sorted);
  r = await hist(C, '?limit=50&offset=500');
  check('AH-27', '범위 밖 offset → 빈 목록 + total 120', r.status === 200 && r.json.data.length === 0 && r.json.total === 120);
  r = await hist(C, '?kind=login&limit=10&offset=10');
  check('AH-28', '필터 + 페이지 함께', r.json.data.length === 10 && r.json.total === 120);

  // ---------- 기록 실패가 업무 저장을 막지 않음 ----------
  await pool.query(`ALTER TABLE audit_log ADD CONSTRAINT t212_block_test CHECK (note IS DISTINCT FROM '수정' AND entity_type <> 'account') NOT VALID`);
  try {
    r = await request('PUT', `/api/partners/${G.id}`, { memo: '기록 실패 시험' }, A);
    const g = (await pool.query('SELECT memo FROM account WHERE id = $1', [G.id])).rows[0];
    const n = Number((await pool.query(`SELECT COUNT(*) FROM audit_log WHERE partner_id = $1 AND action = 'update'`, [G.id])).rows[0].count);
    check('AH-29', '감사 기록 INSERT 실패 → 거래처 수정은 저장(200), 기록만 빠짐', r.status === 200 && g.memo === '기록 실패 시험' && n === 0, `status=${r.status} memo=${g.memo} n=${n}`);
  } finally {
    await pool.query('ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS t212_block_test');
  }

  await pool.end();
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n[audit-history-test] PASS ${results.length - fail} / FAIL ${fail} (총 ${results.length})`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('[audit-history-test] 오류:', e.message);
  process.exit(1);
});
