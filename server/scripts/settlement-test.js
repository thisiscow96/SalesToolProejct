/**
 * T-401 정산 할인·상계 검사 — 설계 `T-401_정산할인상계_설계.md` 6장 AC-401-01~26 (화면 27~29는 캡처, 30은 실증 스크립트)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> SETTLE_API_BASE=http://127.0.0.1:<포트> node scripts/settlement-test.js
 * 전제: 마이그레이션 001~023, 서버 기동. 테스트 DB 전용 — 새 회원(t401_<태그>)을 DB에 직접 만들고 거래는 API로 만든다.
 *       다른 검사의 기대값에 영향을 주지 않게 새 회원 안에서만 움직인다.
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.SETTLE_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[settlement-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}`);
}
function mustOk(r, what) {
  if (r.status >= 300 || !r.json?.ok) throw new Error(`${what} 실패 status=${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data;
}
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const TODAY = kstToday();
const MONTH = TODAY.slice(0, 7);
const n = (v) => Number(v ?? 0);

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  // ---------- 준비: 회원 A(주인), 직원(입력·조회), 상품 ----------
  const pw = crypto.randomBytes(12).toString('hex');
  const agent = `t401_${tag}`;
  const uid = (await q(
    `INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
     VALUES ($1, $2, $3, $4, NOW(), 'active', false) RETURNING id`,
    [`정산검사 ${tag}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
  ))[0].id;
  const lr = await request('POST', '/api/auth/login', { agent_no: agent, password: pw });
  const A = lr.json?.token;
  if (!A) throw new Error('주인 로그인 실패 ' + lr.status);
  const a = (m, p, b) => request(m, p, b, A);

  const staffTok = async (loginId, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    mustOk(await a('POST', '/api/staff', { login_id: loginId, name: `직원${loginId}`, role, temp_password: spw }), `직원 ${loginId}`);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [uid, loginId]);
    const r = await request('POST', '/api/auth/login', { agent_no: agent, login_id: loginId, password: spw });
    if (!r.json?.token) throw new Error(`직원 로그인 실패 ${loginId} ${r.status}`);
    return r.json.token;
  };
  const SI = await staffTok('in1', 'input');
  const SV = await staffTok('vw1', 'view');

  const prod = (await q(`SELECT id FROM product WHERE owner_user_id IS NULL ORDER BY id LIMIT 1`).catch(() => q(`SELECT id FROM product ORDER BY id LIMIT 1`)))[0]?.id
    || (await q(`SELECT id FROM product ORDER BY id LIMIT 1`))[0].id;

  const mkP = async (name, type) => mustOk(await a('POST', '/api/partners', { name: `${name}_${tag}`, type }), name).id;
  const SEOUL = await mkP('서울청과', 'supplier');
  const BUNONG = await mkP('부농', 'same_market');
  const HANARO = await mkP('하나로', 'customer');
  const HANARO2 = await mkP('하나로2', 'customer');

  const buy = async (partner, qty, price) => mustOk(await a('POST', '/api/purchases', { partner_id: partner, product_id: prod, quantity: qty, unit_price: price, purchase_date: TODAY }), '매입').id;
  const sell = async (pid, partner, qty, price) => mustOk(await a('POST', '/api/purchases/convert-to-sales', {
    items: [{ purchase_id: pid, partner_id: partner, quantity: qty, unit_price: price, sale_date: TODAY }], credit_confirmed: true,
  }), '판매')[0].sale_id;
  const saleRow = async (id) => (await q(`SELECT paid_amount, discount_amount, offset_amount, returned_amount, payment_status::text AS ps, total_amount FROM sale WHERE id = $1`, [id]))[0];
  const ledger = async (pid) => mustOk(await a('GET', `/api/partners/${pid}/ledger`), '원장');
  const payLedger = async (pid) => mustOk(await a('GET', `/api/partners/${pid}/payable-ledger`), '지급 원장');
  const partners = async () => Object.fromEntries(mustOk(await a('GET', '/api/partners'), '거래처').map((p) => [p.id, p]));

  const P1 = await buy(SEOUL, 100, 1000); // 서울청과 100,000
  const S_H = await sell(P1, HANARO, 50, 1600); // 하나로 80,000
  const S_B = await sell(P1, BUNONG, 40, 1500); // 부농 60,000
  const P_B = await buy(BUNONG, 20, 1200); // 부농에게 줄 돈 24,000

  // ================= US-1 수금 할인 =================
  const rc = await a('POST', '/api/payments', { partner_id: HANARO, amount: 76000, paid_at: TODAY, allocations: [{ sale_id: S_H, amount: 76000 }] });
  const dc = await a('POST', '/api/payments', { partner_id: HANARO, amount: 4000, paid_at: TODAY, entry_kind: 'discount', allocations: [{ sale_id: S_H, amount: 4000 }] });
  let s = await saleRow(S_H);
  const salesList = mustOk(await a('GET', `/api/sales?partner_id=${HANARO}`), '매출 목록');
  check('AC-401-01 할인 201, paid 76,000·discount 4,000·paid 상태·목록 미수 0',
    rc.status === 201 && dc.status === 201 && dc.json.data.entry_kind === 'discount' && n(s.paid_amount) === 76000 && n(s.discount_amount) === 4000
      && s.ps === 'paid' && n(salesList.find((x) => x.id === S_H)?.unpaid_amount) === 0, { rc: rc.status, dc: dc.json, s });
  const DISC_ID = dc.json.data.id;

  const dash = mustOk(await a('GET', '/api/dashboard'), '대시보드');
  const mon = mustOk(await a('GET', `/api/reports/monthly?month=${MONTH}`), '월 정산');
  const recvOnly = mustOk(await a('GET', `/api/payments?entry_kind=receive&partner_id=${HANARO}`), '수금 목록');
  check('AC-401-02 오늘 수금·월 수금 = 76,000(할인 미포함), 대시보드 discounts 4,000, 월 sale_discounts 4,000, receive 필터',
    n(dash.today.receipts.amount) === 76000 && n(dash.today.discounts.amount) === 4000 && n(mon.receipts.amount) === 76000
      && n(mon.sale_discounts.amount) === 4000 && recvOnly.length === 1 && recvOnly[0].entry_kind === 'receive',
    { today: dash.today, m: mon?.receipts, md: mon?.sale_discounts, recvOnly: recvOnly.length });

  // AC-401-03 남은 미수보다 큰 할인
  const P2 = await buy(SEOUL, 10, 100);
  const S3 = await sell(P2, HANARO2, 3, 1000); // 3,000
  const over = await a('POST', '/api/payments', { partner_id: HANARO2, amount: 3001, paid_at: TODAY, entry_kind: 'discount', allocations: [{ sale_id: S3, amount: 3001 }] });
  check('AC-401-03 남은 미수(3,000) 넘는 할인 400·저장 없음', over.status === 400 && /남은 미수\(3,000\)/.test(over.json?.message || '') && n((await saleRow(S3)).discount_amount) === 0, over.json);

  // AC-401-04 종류 검사
  const cntBefore = n((await q(`SELECT COUNT(*) c FROM payment WHERE user_id = $1`, [uid]))[0].c);
  const foo = await a('POST', '/api/payments', { partner_id: HANARO2, amount: 100, paid_at: TODAY, entry_kind: 'foo', allocations: [{ sale_id: S3, amount: 100 }] });
  const off = await a('POST', '/api/payments', { partner_id: HANARO2, amount: 100, paid_at: TODAY, entry_kind: 'offset', allocations: [{ sale_id: S3, amount: 100 }] });
  const none = await a('POST', '/api/payments', { partner_id: HANARO2, amount: 100, paid_at: TODAY, allocations: [{ sale_id: S3, amount: 100 }] });
  const cntAfter = n((await q(`SELECT COUNT(*) c FROM payment WHERE user_id = $1`, [uid]))[0].c);
  check('AC-401-04 foo·offset 400 VALIDATION field=entry_kind 저장 없음, 종류 없음 → receive',
    foo.status === 400 && foo.json.field === 'entry_kind' && off.status === 400 && off.json.field === 'entry_kind'
      && none.status === 201 && none.json.data.entry_kind === 'receive' && cntAfter === cntBefore + 1, { foo: foo.json, off: off.json, none: none.json });

  // AC-401-05 배분 없음
  const noAl = await a('POST', '/api/payments', { partner_id: HANARO2, amount: 100, paid_at: TODAY, entry_kind: 'discount' });
  check('AC-401-05 할인 배분 없음 → 400', noAl.status === 400 && /배분/.test(noAl.json?.message || ''), noAl.json);

  // AC-401-06 할인 취소
  const cancel = await a('POST', `/api/payments/${DISC_ID}/cancel`, { reason: '잘못 입력' });
  s = await saleRow(S_H);
  let led = await ledger(HANARO);
  const ledC = mustOk(await a('GET', `/api/partners/${HANARO}/ledger?include_cancelled=1`), '원장 취소 보기');
  check('AC-401-06 할인 취소 200 → discount 0, 미수 4,000, partial, 원장 할인 행 없음·취소 보기 0원 행·잔액 4,000',
    cancel.status === 200 && n(s.discount_amount) === 0 && s.ps === 'partial' && n(led.closing_balance) === 4000
      && !led.entries.some((e) => e.kind === 'discount') && ledC.entries.some((e) => e.kind === 'discount_cancelled' && e.increase === 0 && e.decrease === 0 && e.cancelled_amount === 4000),
    { cancel: cancel.json, s, bal: led.closing_balance });

  // AC-401-07 취소 불가
  const recvId = rc.json.data.id;
  const c1 = await a('POST', `/api/payments/${recvId}/cancel`, { reason: 'x' });
  const c2 = await a('POST', `/api/payments/${DISC_ID}/cancel`, { reason: 'x' });
  const c3 = await a('POST', `/api/payments/${DISC_ID}/cancel`, {});
  check('AC-401-07 현금 수금 409 NOT_CANCELLABLE / 이미 취소 409 ALREADY_CANCELLED / 사유 없음 400',
    c1.status === 409 && c1.json.code === 'NOT_CANCELLABLE' && c2.status === 409 && c2.json.code === 'ALREADY_CANCELLED' && c3.status === 400 && c3.json.field === 'reason',
    [c1.json, c2.json, c3.json]);
  // 다시 할인 4,000 (이후 반품 검사용)
  const dc2 = mustOk(await a('POST', '/api/payments', { partner_id: HANARO, amount: 4000, paid_at: TODAY, entry_kind: 'discount', allocations: [{ sale_id: S_H, amount: 4000 }] }), '할인 재등록');

  // ================= US-2 지급 할인 =================
  const pay = await a('POST', '/api/supplier-payments', { partner_id: SEOUL, kind: 'pay', amount: 95000 + 1000, paid_at: TODAY });
  const pd = await a('POST', '/api/supplier-payments', { partner_id: SEOUL, kind: 'discount', amount: 5000, paid_at: TODAY });
  let P = await partners();
  const dash2 = mustOk(await a('GET', '/api/dashboard'), '대시보드2');
  const mon2 = mustOk(await a('GET', `/api/reports/monthly?month=${MONTH}`), '월 정산2');
  const p1Status = (await q(`SELECT payment_status::text ps FROM purchase WHERE id = $1`, [P1]))[0].ps;
  // 서울청과 매입 = 100,000 + 1,000(P2) → 현금 96,000 + 할인 5,000
  check('AC-401-08 지급 96,000 + 할인 5,000(자동 배분) → 서울청과 미지급 0, 매입 paid, 현금 지급 96,000·할인 5,000',
    pay.status === 201 && pd.status === 201 && pd.json.data.method === null && n(P[SEOUL].payable_amount) === 0 && p1Status === 'paid'
      && n(dash2.today.pay_amount) === 96000 && n(dash2.today.pay_discounts.amount) === 5000
      && n(mon2.payments.amount) === 96000 && n(mon2.payments.discount_amount) === 5000,
    { pay: pay.status, pd: pd.json, payable: P[SEOUL].payable_amount, today: dash2.today, m: mon2.payments });
  const PD_ID = pd.json.data.id;

  const m1 = await a('POST', '/api/supplier-payments', { partner_id: BUNONG, kind: 'discount', amount: 100, method: 'cash' });
  const m2 = await a('POST', '/api/supplier-payments', { partner_id: BUNONG, kind: 'discount', amount: 99999999 });
  const m3 = await a('POST', '/api/supplier-payments', { partner_id: BUNONG, kind: 'offset', amount: 100 });
  check('AC-401-09 할인+method 400 field=method / 미지급보다 큰 할인 400 OVERPAY / kind offset 400',
    m1.status === 400 && m1.json.field === 'method' && m2.status === 400 && m2.json.code === 'OVERPAY' && m3.status === 400 && m3.json.field === 'kind',
    [m1.json, m2.json, m3.json]);

  const profitBefore = mon2.profit.profit;
  const pc = await a('POST', `/api/supplier-payments/${PD_ID}/cancel`, { reason: '검사' });
  P = await partners();
  const mon3 = mustOk(await a('GET', `/api/reports/monthly?month=${MONTH}`), '월 정산3');
  check('AC-401-10 지급 할인 취소 200 → 미지급 5,000, 원가·이익은 할인 전후 같음',
    pc.status === 200 && n(P[SEOUL].payable_amount) === 5000 && mon3.profit.profit === profitBefore && mon3.profit.cost === mon2.profit.cost,
    { pc: pc.json, payable: P[SEOUL].payable_amount, p: [profitBefore, mon3.profit.profit] });
  mustOk(await a('POST', '/api/supplier-payments', { partner_id: SEOUL, kind: 'discount', amount: 5000, paid_at: TODAY }), '지급 할인 재등록');

  // ================= US-3 상계 =================
  const ofs = await a('POST', '/api/offsets', { partner_id: BUNONG, amount: 24000, memo: '검사 상계' });
  const OFS = ofs.json?.data;
  led = await ledger(BUNONG);
  let pled = await payLedger(BUNONG);
  P = await partners();
  const pair = OFS ? await q(`SELECT (SELECT offset_id FROM payment WHERE id = $1) a, (SELECT offset_id FROM supplier_payment WHERE id = $2) b`, [OFS.payment_id, OFS.supplier_payment_id]) : [{}];
  check('AC-401-11 상계 201 → 매출 원장 36,000·지급 원장 0·payable 0, 양쪽 같은 offset_id',
    ofs.status === 201 && n(led.closing_balance) === 36000 && n(pled.closing_balance) === 0 && n(P[BUNONG].payable_amount) === 0
      && pair[0].a === OFS.id && pair[0].b === OFS.id && OFS.receivable_after === 36000 && OFS.payable_after === 0,
    { ofs: ofs.json, bal: led.closing_balance, pbal: pled.closing_balance });

  const dash3 = mustOk(await a('GET', '/api/dashboard'), '대시보드3');
  const mon4 = mustOk(await a('GET', `/api/reports/monthly?month=${MONTH}`), '월 정산4');
  check('AC-401-12 상계는 현금 수금·지급 합에 없음, offsets 24,000',
    n(dash3.today.receipts.amount) === n(dash.today.receipts.amount) + 100 && n(dash3.today.pay_amount) === 96000
      && n(dash3.today.offsets.amount) === 24000 && n(mon4.offsets.amount) === 24000 && n(mon4.payments.offset_amount) === 24000,
    { today: dash3.today, mo: mon4.offsets });

  const o1 = await a('POST', '/api/offsets', { partner_id: HANARO, amount: 100 });
  const o2 = await a('POST', '/api/offsets', { partner_id: SEOUL, amount: 100 });
  // 상계 한도 검사용: 부농에게 다시 매입 24,000 → 최대 상계 24,000
  const P_B2 = await buy(BUNONG, 20, 1200);
  const o3 = await a('POST', '/api/offsets', { partner_id: BUNONG, amount: 24001 });
  check('AC-401-13 customer·supplier 400 field=partner_id / 24,001 → 400 OFFSET_OVER max 24,000',
    o1.status === 400 && o1.json.field === 'partner_id' && o2.status === 400 && o2.json.field === 'partner_id'
      && o3.status === 400 && o3.json.code === 'OFFSET_OVER' && o3.json.max_amount === 24000, [o1.json, o2.json, o3.json]);

  const oc = await a('POST', `/api/offsets/${OFS.id}/cancel`, { reason: '검사 취소' });
  led = await ledger(BUNONG);
  P = await partners();
  const st3 = (await q(`SELECT (SELECT status FROM settlement_offset WHERE id = $1) a, (SELECT status FROM payment WHERE offset_id = $1) b, (SELECT status FROM supplier_payment WHERE offset_id = $1) c`, [OFS.id]))[0];
  check('AC-401-14 상계 취소 200 → 미수 60,000·미지급 48,000(재매입 포함) 복귀, 세 행 cancelled',
    oc.status === 200 && n(led.closing_balance) === 60000 && n(P[BUNONG].payable_amount) === 48000 && st3.a === 'cancelled' && st3.b === 'cancelled' && st3.c === 'cancelled',
    { oc: oc.json, bal: led.closing_balance, payable: P[BUNONG].payable_amount, st3 });

  // 다시 상계 24,000 (이후 검사용)
  const OFS2 = mustOk(await a('POST', '/api/offsets', { partner_id: BUNONG, amount: 24000, purchase_allocations: [{ purchase_id: P_B, amount: 24000 }] }), '상계 재등록');
  const b1 = await a('POST', `/api/payments/${OFS2.payment_id}/cancel`, { reason: 'x' });
  const b2 = await a('POST', `/api/supplier-payments/${OFS2.supplier_payment_id}/cancel`, { reason: 'x' });
  led = await ledger(BUNONG);
  check('AC-401-15 상계 한쪽만 취소 → 둘 다 409 USE_OFFSET_CANCEL, 값 변화 없음',
    b1.status === 409 && b1.json.code === 'USE_OFFSET_CANCEL' && b2.status === 409 && b2.json.code === 'USE_OFFSET_CANCEL' && n(led.closing_balance) === 36000,
    [b1.json, b2.json, led.closing_balance]);

  // ================= US-4 기존 규칙과의 관계 =================
  const rf = await a('POST', `/api/sales/${S_H}/refund`, { quantity: 50, refunded_at: TODAY, reason: '전량 반품' });
  s = await saleRow(S_H);
  led = await ledger(HANARO);
  check('AC-401-16 할인 매출 전량 반품 → 미수 차감 0·할인 되돌림 4,000·현금 환불 76,000, 원장 0, discount 0, paid 0',
    rf.status === 201 && rf.json.data.credit_amount === 0 && rf.json.data.discount_reversed_amount === 4000 && rf.json.data.refund_amount === 76000
      && n(led.closing_balance) === 0 && n(s.discount_amount) === 0 && n(s.paid_amount) === 0 && led.check.diff === 0
      && led.entries.some((e) => e.kind === 'discount_reversal' && e.increase === 4000),
    { rf: rf.json, s, bal: led.closing_balance, check: led.check });

  // AC-401-17 상계 걸린 부농 매출 반품: 미수 36,000 → 40개 중 전량(60,000) 반품이면 credit 36,000 + 상계분 24,000 → 409
  const rb = await a('POST', `/api/sales/${S_B}/refund`, { quantity: 40, refunded_at: TODAY, reason: '반품' });
  s = await saleRow(S_B);
  check('AC-401-17 상계분까지 닿는 반품 → 409 SALE_OFFSET_SETTLED, 저장 없음',
    rb.status === 409 && rb.json.code === 'SALE_OFFSET_SETTLED' && n(s.returned_amount) === 0 && n(s.offset_amount) === 24000, { rb: rb.json, s });

  // AC-401-18 할인 후 취소한 매출은 수정·취소 가능, 할인 살아 있으면 409
  const P3 = await buy(SEOUL, 10, 100);
  const S4 = await sell(P3, HANARO2, 5, 1000);
  const d4 = mustOk(await a('POST', '/api/payments', { partner_id: HANARO2, amount: 500, paid_at: TODAY, entry_kind: 'discount', allocations: [{ sale_id: S4, amount: 500 }] }), '할인 S4');
  const e1 = await a('PATCH', `/api/sales/${S4}`, { changes: { quantity: 4 }, reason: '수량 정정' });
  mustOk(await a('POST', `/api/payments/${d4.id}/cancel`, { reason: '할인 취소' }), '할인 S4 취소');
  const e2 = await a('PATCH', `/api/sales/${S4}`, { changes: { quantity: 4 }, reason: '수량 정정' });
  const e3 = await a('POST', `/api/sales/${S4}/cancel`, { reason: '매출 취소' });
  check('AC-401-18 할인 있으면 수정 409 SALE_HAS_PAYMENT, 할인 취소 뒤 수정·취소 200',
    e1.status === 409 && e1.json.code === 'SALE_HAS_PAYMENT' && e2.status === 200 && e3.status === 200, [e1.json, e2.status, e2.json?.message, e3.status, e3.json?.message]);

  // AC-401-19 권한
  const si = (m, p, b) => request(m, p, b, SI);
  const sv = (m, p, b) => request(m, p, b, SV);
  const f1 = await si('POST', '/api/payments', { partner_id: HANARO2, amount: 100, paid_at: TODAY, entry_kind: 'discount', allocations: [{ sale_id: S3, amount: 100 }] });
  const f2 = await si('POST', `/api/payments/${DISC_ID}/cancel`, { reason: 'x' });
  const f3 = await si('POST', '/api/offsets', { partner_id: BUNONG, amount: 1 });
  const f4 = await si('POST', `/api/offsets/${OFS2.id}/cancel`, { reason: 'x' });
  const f5 = await sv('GET', '/api/offsets');
  const meI = await si('GET', '/api/me');
  const meA = await a('GET', '/api/me');
  check('AC-401-19 입력 직원: 할인 403 FIELD_NOT_ALLOWED / 할인 취소·상계 등록·취소 403, 조회 직원 GET /api/offsets 200, 할인 버튼 ui 주인만',
    f1.status === 403 && f1.json.code === 'FIELD_NOT_ALLOWED' && f1.json.field === 'entry_kind'
      && [f2, f3, f4].every((x) => x.status === 403) && f5.status === 200 && f5.json.data.length >= 1
      && !(meI.json.allow || []).includes('payment.discount') && (meA.json.allow || []).includes('payment.discount')
      && (meA.json.allow || []).includes('offset.create'),
    { f1: f1.json, f2: f2.status, f3: f3.status, f4: f4.status, f5: f5.status, allowI: meI.json?.allow, allowA: meA.json?.allow });

  // AC-401-21 DB CHECK
  let e21a = null; let e21b = null;
  try { await q(`UPDATE sale SET discount_amount = total_amount + 1 WHERE id = $1`, [S3]); } catch (e) { e21a = e.code; }
  try { await q(`INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind) VALUES ($1, $2, 1, NOW(), 'x')`, [uid, HANARO2]); } catch (e) { e21b = e.code; }
  check('AC-401-21 정리액 > 순매출 UPDATE / entry_kind x INSERT → 23514', e21a === '23514' && e21b === '23514', [e21a, e21b]);

  // AC-401-22 매출 원장
  led = await ledger(BUNONG);
  const ofsRow = led.entries.find((e) => e.kind === 'offset');
  check('AC-401-22 매출 원장 상계 행·배분 내역·요약 offsets, ledger_balance = sale_based_due',
    ofsRow && ofsRow.kind_label === '상계' && ofsRow.decrease === 24000 && ofsRow.allocations?.[0]?.sale_id === S_B
      && led.totals.offsets === 24000 && led.check.ledger_balance === led.check.sale_based_due,
    { ofsRow, totals: led.totals, check: led.check });
  // AC-401-23 지급 원장
  const pls = await payLedger(SEOUL);
  pled = await payLedger(BUNONG);
  check('AC-401-23 지급 원장 "매입 할인"·"상계" 라벨, 잔액 = 미지급(서울청과)·24,000(부농 재매입)',
    pls.entries.some((e) => e.kind_label === '매입 할인' && e.decrease === 5000) && n(pls.closing_balance) === n((await partners())[SEOUL].payable_amount)
      && pled.entries.some((e) => e.kind_label === '상계' && e.decrease === 24000) && n(pled.closing_balance) === 24000
      && pls.totals.discounts === 5000 && pled.totals.offsets === 24000,
    { s: pls.entries.map((e) => e.kind_label), b: pled.entries.map((e) => e.kind_label), sb: pls.closing_balance, bb: pled.closing_balance });

  // AC-401-24 외상 한도: 부농 한도 50,000, 미수 36,000 → 새 판매 10,000(46,000) 경고 없음
  mustOk(await a('PUT', `/api/partners/${BUNONG}`, { credit_limit: 50000 }), '한도');
  const P4 = await buy(SEOUL, 10, 500);
  const ns = await a('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: P4, partner_id: BUNONG, quantity: 10, unit_price: 1000, sale_date: TODAY }] });
  check('AC-401-24 상계 반영 미수 36,000 + 10,000 = 46,000 ≤ 한도 50,000 → 201, 경고 없음',
    ns.status === 201 && !ns.json.credit_warnings, ns.json);

  // AC-401-25 월 정산: 이익 − 할인 + 되돌림, 미수 항등식
  const m5 = mustOk(await a('GET', `/api/reports/monthly?month=${MONTH}`), '월 정산5');
  const expPAD = Math.round((m5.profit.profit - m5.sale_discounts.amount + m5.discount_reversals.amount) * 100) / 100;
  const rvDelta = m5.balances.receivable.closing - m5.balances.receivable.opening;
  const rvExp = m5.sales.amount - m5.returns.amount - m5.receipts.amount - m5.sale_discounts.amount - m5.offsets.amount + m5.refund_payments.amount + m5.discount_reversals.amount;
  const pvDelta = m5.balances.payable.closing - m5.balances.payable.opening;
  const pvExp = m5.purchases.amount - m5.payments.amount - m5.payments.opening_amount - m5.payments.discount_amount - m5.payments.offset_amount;
  check('AC-401-25 profit_after_discount = 이익 − 매출 할인 + 할인 되돌림, 미수·미지급 항등식',
    m5.profit.profit_after_discount === expPAD && Math.abs(rvDelta - rvExp) < 0.005 && Math.abs(pvDelta - pvExp) < 0.005,
    { pad: [m5.profit.profit_after_discount, expPAD], rv: [rvDelta, rvExp], pv: [pvDelta, pvExp] });

  // AC-401-26 변경 이력
  const hist = mustOk(await a('GET', '/api/history?limit=200'), '이력');
  const kinds = new Set(hist.map((h) => h.kind));
  const hd = mustOk(await a('GET', '/api/history?kind=discount&limit=50'), '이력 할인');
  check('AC-401-26 이력: 할인 등록·할인 취소·상계 등록·상계 취소 행, kind 필터',
    kinds.has('discount') && kinds.has('offset') && kinds.has('offset_cancel')
      && hist.some((h) => h.kind === 'payment_cancel' && h.source === 'payment_cancel') && hd.length >= 3 && hd.every((h) => h.kind === 'discount'),
    { kinds: [...kinds] });

  // 확인 SQL (023 머리말 ①②): 유지 칸 = 취소 안 된 배분 합, 상계 3행 상태 일치
  const chk1 = await q(`SELECT s.id FROM sale s
      LEFT JOIN (SELECT pa.sale_id, SUM(pa.amount) FILTER (WHERE p.entry_kind='discount') - COALESCE((SELECT SUM(r.discount_reversed_amount) FROM refund r WHERE r.sale_id = pa.sale_id), 0) d, SUM(pa.amount) FILTER (WHERE p.entry_kind='offset') o
                 FROM payment_allocation pa JOIN payment p ON p.id = pa.payment_id AND p.status='active' GROUP BY pa.sale_id) x ON x.sale_id = s.id
      WHERE s.user_id = $1 AND (s.discount_amount <> COALESCE(x.d,0) OR s.offset_amount <> COALESCE(x.o,0))`, [uid]);
  const chk2 = await q(`SELECT so.id FROM settlement_offset so JOIN payment p ON p.offset_id = so.id JOIN supplier_payment sp ON sp.offset_id = so.id
      WHERE so.user_id = $1 AND (so.status <> p.status OR so.status <> sp.status OR so.amount <> p.amount OR so.amount <> sp.amount)`, [uid]);
  check('확인 SQL ①②: 할인·상계 유지 칸 = 배분 합, 상계 3행 일치 (0행)', chk1.length === 0 && chk2.length === 0, { chk1, chk2 });
  void P_B2;

  await pool.end();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[settlement-test] PASS ${pass} / FAIL ${results.length - pass} (총 ${results.length})`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[settlement-test] 오류:', e);
  process.exit(1);
});
