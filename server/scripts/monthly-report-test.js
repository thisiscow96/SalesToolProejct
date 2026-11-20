/**
 * T-215 월 정산 보고서 GET /api/reports/monthly 검사
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> MONTHLY_API_BASE=http://127.0.0.1:<포트> node scripts/monthly-report-test.js
 * 전제: 마이그레이션(001~016·019), seed-admin(admin001 — 상품 등록용, 비밀번호 SMOKE_PASSWORD 또는 sample), 서버 기동.
 * 테스트 DB 전용 — 회원 A·B(t215a_/t215b_<태그>)를 DB에 직접 만들고, 거래는 모두 API로 만든다.
 *
 * 달: 이번 달(KST) = M, 지난달 = T(보고서 대상), 지지난달 = P(전월 대비). 어느 날 돌려도 같은 기대값이 나온다.
 * 검사
 *  1) 손계산 기대값 — 매입·매출·반품·폐기·수금·지급·이익·이익률·미수/미지급 잔액·상위 거래처·전월 대비
 *  2) 다른 화면과 일치 — 일별 매입·매출(T-202) 합, 거래처 원장(T-104)·지급 원장(T-201) 잔액 합, 대시보드 총미수·총미지급,
 *     수금·지급 목록 합, 잔액 증감식(월말 − 월초 = 매출 − 반품 − 수금 + 환불 지급)
 *  3) 월 경계·KST — 1일 00:00 KST 수금은 그 달, 전달 말일 23:59 KST 는 전달
 *  4) 권한 — 401, 다른 회원 거래가 섞이지 않음, 잘못된 월·미래 월 400
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const { monthRange } = require('../lib/monthly-report-routes');

const BASE = process.env.MONTHLY_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[monthly-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
}
async function mustOk(r, what) {
  if (r.status >= 300 || !r.json?.ok) throw new Error(`${what} 실패 status=${r.status} ${r.json?.message || ''}`);
  return r.json.data;
}
async function login(agentNo, password) {
  const r = await request('POST', '/api/auth/login', { agent_no: agentNo, password });
  if (r.status !== 200 || !r.json?.token) throw new Error(`로그인 실패 ${agentNo} status=${r.status}`);
  return r.json.token;
}

const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const sum = (arr, f) => arr.reduce((s, x) => s + Number(f(x)), 0);
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const TODAY = kstToday();
const M = monthRange(TODAY.slice(0, 7)); // 이번 달
const T = monthRange(M.prev.month); //       보고서 대상(지난달)
const P = monthRange(T.prev.month); //       전월(지지난달)
const day = (r, d) => `${r.month}-${String(d).padStart(2, '0')}`;
const lastDay = (r) => r.to;

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const admin = await login('admin001', process.env.SMOKE_PASSWORD || 'sample');

  const mkUser = async (prefix) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const agent = `${prefix}_${tag}`;
    await pool.query(
      `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
       VALUES ($1, NULL, $2, $3, $4, NOW(), 'active', false)`,
      [agent, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
    );
    return login(agent, pw);
  };
  const A = await mkUser('t215a');
  const B = await mkUser('t215b');
  const report = (token, month) => request('GET', `/api/reports/monthly?month=${encodeURIComponent(month)}`, null, token);

  // ---------- 0. 빈 데이터·권한·입력 ----------
  let r = await report(A, T.month);
  let d = r.json?.data;
  check(
    'E-01 거래 없는 회원: 200, 모든 합계 0, 이익률 null, 상위 빈 배열, 대상 기간 = 지난달 1일~말일',
    r.status === 200 && d.month === T.month && d.from === T.from && d.to === T.to && d.is_current_month === false &&
      d.purchases.amount === 0 && d.sales.amount === 0 && d.returns.amount === 0 && d.receipts.amount === 0 &&
      d.payments.amount === 0 && d.profit.profit === 0 && d.profit.margin_pct === null &&
      d.balances.receivable.closing === 0 && d.top.sales_partners.length === 0 && d.previous.month === P.month,
    d
  );
  r = await request('GET', `/api/reports/monthly?month=${T.month}`, null, null);
  check('E-02 토큰 없음 → 401', r.status === 401, r.status);
  r = await request('GET', `/api/reports/monthly?month=${T.month}`, null, 'not-a-token');
  check('E-03 위조 토큰 → 401', r.status === 401, r.status);
  const bad = ['', '2026-13', '2026-00', '2026-1', '26-01', 'abc', "2026-01' OR 1=1--", '1999-12', '2026-01-01'];
  const badRes = [];
  for (const b of bad) badRes.push((await report(A, b)).status);
  check(`E-04 잘못된 월 ${bad.length}종 → 모두 400`, badRes.every((s) => s === 400), badRes);
  const next = monthRange(M.to.slice(0, 4) + '-' + M.to.slice(5, 7)); // M 자신
  const nextMonth = M.month.slice(5) === '12' ? `${Number(M.month.slice(0, 4)) + 1}-01` : `${M.month.slice(0, 4)}-${String(Number(M.month.slice(5)) + 1).padStart(2, '0')}`;
  r = await report(A, nextMonth);
  check('E-05 다음 달(미래) → 400 FUTURE_MONTH', r.status === 400 && r.json?.code === 'FUTURE_MONTH', r.json);
  r = await report(A, next.month);
  check('E-06 이번 달 → 200, is_current_month=true', r.status === 200 && r.json.data.is_current_month === true, r.json?.data?.is_current_month);

  // ---------- 1. 월 계산(단위) ----------
  const jan = monthRange('2026-01');
  const feb28 = monthRange('2027-02');
  const feb29 = monthRange('2028-02');
  check(
    'U-01 1월의 전월 = 전년 12월, 2월 말일(평년 28·윤년 29), 4월 30일',
    jan.prev.month === '2025-12' && jan.prev.to === '2025-12-31' && feb28.to === '2027-02-28' && feb29.to === '2028-02-29' &&
      monthRange('2026-04').to === '2026-04-30' && monthRange('2026-03').prev.to === '2026-02-28',
    { jan, feb28: feb28.to, feb29: feb29.to }
  );

  // ---------- 2. 시나리오 (회원 A) ----------
  const mkProduct = async (name) => mustOk(await request('POST', '/api/products', { name: `T215-${name}-${tag}`, unit: 'kg' }, admin), `상품 ${name}`);
  const mkPartner = async (token, name, type) => mustOk(await request('POST', '/api/partners', { name: `${name}-${tag}`, type }, token), `거래처 ${name}`);
  const buy = async (token, partner, product, qty, price, date) => {
    const p = await mustOk(
      await request('POST', '/api/purchases', { partner_id: partner.id, product_id: product.id, quantity: qty, unit_price: price, purchase_date: date }, token),
      `매입 ${date}`
    );
    return p.id || p.purchase_id || (p[0] && p[0].id);
  };
  const convert = async (token, lot, partner, qty, price, date) => {
    const x = await mustOk(
      await request('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: lot, partner_id: partner.id, quantity: qty, unit_price: price, sale_date: date }] }, token),
      `매출 ${date}`
    );
    return x[0].sale_id;
  };
  const receive = async (partner, amount, paidAt, saleId) =>
    mustOk(await request('POST', '/api/payments', { partner_id: partner.id, amount, paid_at: paidAt, entry_kind: 'receive', allocations: [{ sale_id: saleId, amount }] }, A), `수금 ${paidAt}`);
  const ret = async (saleId, qty, date) =>
    mustOk(await request('POST', `/api/sales/${saleId}/refund`, { quantity: qty, refunded_at: date, reason: '테스트 반품' }, A), `반품 ${date}`);
  const pay = async (partner, amount, paidAt) =>
    mustOk(await request('POST', '/api/supplier-payments', { partner_id: partner.id, amount, paid_at: paidAt, method: 'transfer' }, A), `지급 ${paidAt}`);

  const S1 = await mkPartner(A, 'S1농장', 'supplier');
  const S2 = await mkPartner(A, 'S2농장', 'supplier');
  const C1 = await mkPartner(A, 'C1상회', 'customer');
  const C2 = await mkPartner(A, 'C2도매', 'wholesaler');
  const X = await mkProduct('X');
  const Y = await mkProduct('Y');

  // 전월 P: 매입 1,000 · 매출 400 · 수금 150(말일 23:59 KST 50 포함) · 지급 300
  const lotP = await buy(A, S1, X, 100, 10, day(P, 10));
  const sP = await convert(A, lotP, C1, 20, 20, day(P, 20));
  await receive(C1, 100, `${day(P, 25)}T10:00`, sP);
  await receive(C1, 50, `${lastDay(P)}T23:59`, sP); // 전달 말일 23:59 KST → P
  await pay(S1, 300, `${day(P, 26)}T09:00`);

  // 대상 달 T
  const lotT1 = await buy(A, S1, X, 50, 12, day(T, 1)); //   600
  const lotY = await buy(A, S2, Y, 10, 100, day(T, 5)); //   1,000
  const lotCancel = await buy(A, S2, Y, 5, 100, day(T, 6)); // 500 → 취소
  await mustOk(await request('POST', `/api/purchases/${lotCancel}/cancel`, { reason: '오입력' }, A), '매입 취소');
  const s1 = await convert(A, lotP, C1, 10, 25, day(T, 3)); //    250, 원가 100
  const fifo = await mustOk( //                                     2,400, 원가 70×10 + 10×12 = 820
    await request('POST', '/api/sales', { partner_id: C2.id, sale_date: day(T, 10), items: [{ product_id: X.id, quantity: 80, unit_price: 30 }] }, A),
    'FIFO 판매'
  );
  const fifoSaleId = fifo.sales?.[0]?.id ?? fifo.sales?.[0]?.sale_id ?? fifo[0]?.sale_id ?? fifo.items?.[0]?.sale_id;
  const sY = await convert(A, lotY, C2, 3, 150, day(T, 12)); //    450, 원가 300
  const sCancel = await convert(A, lotT1, C1, 1, 25, day(T, 13)); // 취소
  await mustOk(await request('POST', `/api/sales/${sCancel}/cancel`, { reason: '거래 취소' }, A), '매출 취소');
  const sPaid = await convert(A, lotT1, C1, 2, 25, day(T, 16)); //  50, 원가 24
  await receive(C1, 100, `${T.from}T00:00`, sP); //                 1일 00:00 KST → T
  await receive(C1, 50, `${day(T, 16)}T12:00`, sPaid);
  await ret(sY, 1, day(T, 15)); //                                 외상 반품 150(미수 차감)
  const rf = await ret(sPaid, 1, day(T, 17)); //                   수금된 매출 반품 25 → 현금 환불 25
  await mustOk(await request('POST', '/api/disposals', { product_id: Y.id, quantity: 2, disposal_date: day(T, 20), reason: '상함' }, A), '폐기 Y');
  await mustOk(await request('POST', '/api/disposals', { product_id: X.id, quantity: 1, disposal_date: day(T, 20), reason: '상함' }, A), '폐기 X');
  await pay(S1, 200, `${day(T, 7)}T09:00`);
  await pay(S2, 400, `${day(T, 28)}T09:00`);
  const pc = await pay(S1, 100, `${day(T, 8)}T09:00`);
  await mustOk(await request('POST', `/api/supplier-payments/${pc.id}/cancel`, { reason: '오입력' }, A), '지급 취소');
  await receive(C2, 1000, `${lastDay(T)}T23:50`, fifoSaleId); //   말일 23:50 KST → T
  // 이번 달 M: 1일 00:10 KST 수금 50 → T 아님
  await receive(C1, 50, `${M.from}T00:10`, s1);
  check('S-00 준비: FIFO 판매 id 확인, 반품 현금 환불 25', !!fifoSaleId && Number(rf?.refund_amount) === 25, { fifo, rf });

  // 회원 B: 같은 달 자기 거래 — A 보고서에 섞이면 안 된다
  const SB = await mkPartner(B, 'B농장', 'supplier');
  const CB = await mkPartner(B, 'B상회', 'customer');
  const ZB = await mkProduct('ZB');
  const lotB = await buy(B, SB, ZB, 10, 1000, day(T, 2));
  await convert(B, lotB, CB, 3, 7777, day(T, 4));

  r = await report(A, T.month);
  d = r.json?.data;

  // ---------- 3. 손계산 기대값 ----------
  check('H-01 매입 1,600원 2건 (600 + 1,000, 취소 500 제외)', d.purchases.amount === 1600 && d.purchases.count === 2, d.purchases);
  check('H-02 매출 3,150원 4건 (250 + 2,400 FIFO + 450 + 50, 취소 매출 제외, 반품 빼지 않은 총액)', d.sales.amount === 3150 && d.sales.count === 4, d.sales);
  check(
    'H-03 반품 175원 2건 = 외상 반품 150(미수 차감) + 현금 환불 25, 순매출 2,975',
    d.returns.amount === 175 && d.returns.count === 2 && d.returns.credit === 150 && d.returns.cash_refund === 25 && d.net_sales === 2975,
    { returns: d.returns, net: d.net_sales }
  );
  check(
    'H-04 이익(T-202 방식·FIFO 원가 포함): 원가 1,244 = 100 + 820 + 300 + 24, 이익 1,906, 이익률 60.5%, 원가 모름 0',
    d.profit.cost === 1244 && d.profit.costed_sales === 3150 && d.profit.profit === 1906 && d.profit.margin_pct === 60.5 && d.profit.cost_missing_count === 0,
    d.profit
  );
  check(
    'H-05 폐기 2건, 추정 손실 210.67 = Y 2×100 + X 1×(1,600÷150)',
    d.disposals.count === 2 && d.disposals.cost_estimate === 210.67 && d.disposals.cost_missing_count === 0,
    d.disposals
  );
  check(
    'H-06 수금 1,150원 3건 (1일 00:00 KST 100 + 50 + 말일 23:50 KST 1,000; 전달 말일 23:59·다음 달 1일 00:10 제외), 환불 지급 25원 1건',
    d.receipts.amount === 1150 && d.receipts.count === 3 && d.refund_payments.amount === 25 && d.refund_payments.count === 1,
    { receipts: d.receipts, refund: d.refund_payments }
  );
  check('H-07 지급 600원 2건 (200 + 400, 취소 100 제외), 기초 정리 0', d.payments.amount === 600 && d.payments.count === 2 && d.payments.opening_amount === 0, d.payments);
  check(
    'H-08 미수 잔액 월초 250(= 400 − 150) → 월말 2,100, 미지급 월초 700(= 1,000 − 300) → 월말 1,700',
    d.balances.receivable.opening === 250 && d.balances.receivable.closing === 2100 &&
      d.balances.payable.opening === 700 && d.balances.payable.closing === 1700,
    d.balances
  );
  const sp = d.top.sales_partners;
  const pp = d.top.purchase_partners;
  check(
    'H-09 매출 상위 = C2 2,850(2건, 이익 1,730) · C1 300(2건, 이익 176), 매입 상위 = S2 1,000 · S1 600',
    sp.length === 2 && sp[0].partner_id === C2.id && sp[0].amount === 2850 && sp[0].count === 2 && sp[0].profit === 1730 &&
      sp[1].partner_id === C1.id && sp[1].amount === 300 && sp[1].count === 2 && sp[1].profit === 176 &&
      pp.length === 2 && pp[0].partner_id === S2.id && pp[0].amount === 1000 && pp[1].partner_id === S1.id && pp[1].amount === 600,
    { sp, pp }
  );
  const pv = d.previous;
  check(
    'H-10 전월: 매입 1,000 · 매출 400 · 수금 150(2건) · 지급 300 · 이익 200(50%) · 미수 월말 250 · 미지급 월말 700',
    pv.month === P.month && pv.purchases.amount === 1000 && pv.sales.amount === 400 && pv.receipts.amount === 150 && pv.receipts.count === 2 &&
      pv.payments.amount === 300 && pv.profit.profit === 200 && pv.profit.margin_pct === 50 &&
      pv.balances.receivable.closing === 250 && pv.balances.payable.closing === 700,
    pv
  );
  const ch = d.change;
  check(
    'H-11 전월 대비: 매출 +2,750(+687.5%), 매입 +600(+60%), 이익 +1,706, 이익률 +10.5%p, 반품 전월 0 → 증감률 null',
    ch.sales.diff === 2750 && ch.sales.pct === 687.5 && ch.purchases.diff === 600 && ch.purchases.pct === 60 &&
      ch.profit.diff === 1706 && ch.margin_pct.diff === 10.5 && ch.returns.pct === null && ch.returns.diff === 175,
    ch
  );

  // ---------- 4. 다른 화면과 일치 ----------
  const rv = d.balances.receivable;
  const pb = d.balances.payable;
  check(
    'X-01 미수 증감식: 월말 − 월초 = 매출 − 반품 − 수금 + 환불 지급',
    eq(rv.closing - rv.opening, d.sales.amount - d.returns.amount - d.receipts.amount + d.refund_payments.amount),
    { rv, s: d.sales.amount, ret: d.returns.amount, rc: d.receipts.amount, rf: d.refund_payments.amount }
  );
  check(
    'X-02 미지급 증감식: 월말 − 월초 = 매입 − 지급 − 기초 정리',
    eq(pb.closing - pb.opening, d.purchases.amount - d.payments.amount - d.payments.opening_amount),
    { pb, pu: d.purchases.amount, pay: d.payments }
  );
  const daily = await mustOk(await request('GET', `/api/reports/daily-purchase-sales?from_date=${T.from}&to_date=${T.to}`, null, A), '일별 보고서');
  check(
    'X-03 일별 매입·매출(T-202) 그 달 합 = 월 매입·매출·원가·이익·원가 모름',
    eq(sum(daily, (x) => x.purchase_amount), d.purchases.amount) && eq(sum(daily, (x) => x.sales_amount), d.sales.amount) &&
      eq(sum(daily, (x) => x.cost_amount), d.profit.cost) && eq(sum(daily, (x) => x.profit_amount), d.profit.profit) &&
      sum(daily, (x) => x.purchase_count) === d.purchases.count && sum(daily, (x) => x.sales_count) === d.sales.count &&
      sum(daily, (x) => x.cost_missing_count) === d.profit.cost_missing_count,
    { p: sum(daily, (x) => x.purchase_amount), s: sum(daily, (x) => x.sales_amount), prof: sum(daily, (x) => x.profit_amount) }
  );
  let ledOpen = 0;
  let ledClose = 0;
  let ledSales = 0;
  let ledReturns = 0;
  let ledReceipts = 0;
  let ledRefunds = 0;
  for (const c of [C1, C2]) {
    const l = await mustOk(await request('GET', `/api/partners/${c.id}/ledger?from=${T.from}&to=${T.to}`, null, A), '원장');
    ledOpen += l.opening_balance;
    ledClose += l.closing_balance;
    ledSales += l.totals.sales;
    ledReturns += l.totals.returns;
    ledReceipts += l.totals.receipts;
    ledRefunds += l.totals.refunds;
  }
  check(
    'X-04 거래처 원장(T-104) 그 달 합: 기초·기말 잔액, 매출·반품·수금·환불 지급 합이 보고서와 같음',
    eq(ledOpen, rv.opening) && eq(ledClose, rv.closing) && eq(ledSales, d.sales.amount) && eq(ledReturns, d.returns.amount) &&
      eq(ledReceipts, d.receipts.amount) && eq(ledRefunds, d.refund_payments.amount),
    { ledOpen, ledClose, ledSales, ledReturns, ledReceipts, ledRefunds }
  );
  let payOpen = 0;
  let payClose = 0;
  for (const s of [S1, S2]) {
    const l = await mustOk(await request('GET', `/api/partners/${s.id}/payable-ledger?from=${T.from}&to=${T.to}`, null, A), '지급 원장');
    payOpen += l.opening_balance;
    payClose += l.closing_balance;
  }
  check('X-05 지급 원장(T-201) 기초·기말 잔액 합 = 미지급 월초·월말', eq(payOpen, pb.opening) && eq(payClose, pb.closing), { payOpen, payClose, pb });
  const pays = await mustOk(await request('GET', `/api/supplier-payments?from_date=${T.from}&to_date=${T.to}`, null, A), '지급 목록');
  const payRows = Array.isArray(pays) ? pays : pays.items || pays.rows || [];
  check(
    'X-06 지급정보 목록(그 달, 취소 제외) 합 = 월 지급',
    eq(sum(payRows.filter((x) => x.status !== 'cancelled' && (x.kind || 'pay') === 'pay'), (x) => x.amount), d.payments.amount),
    payRows.map((x) => [x.amount, x.status, x.kind])
  );
  const pmts = await mustOk(await request('GET', `/api/payments?from_date=${T.from}&to_date=${T.to}`, null, A), '수금 목록');
  const pmRows = Array.isArray(pmts) ? pmts : pmts.items || pmts.rows || [];
  check(
    'X-07 수금정보 목록(그 달) 수금 합 = 월 수금, 환불 지급 합 = 월 환불 지급',
    eq(sum(pmRows.filter((x) => (x.entry_kind || 'receive') === 'receive'), (x) => x.amount), d.receipts.amount) &&
      eq(sum(pmRows.filter((x) => x.entry_kind === 'refund'), (x) => x.amount), d.refund_payments.amount),
    pmRows.map((x) => [x.amount, x.entry_kind, x.paid_at])
  );

  // 이번 달 M: 월말 잔액 = 대시보드 총미수·총미지급(오늘 기준), 전월(= T) 합계가 T 보고서와 같음
  r = await report(A, M.month);
  const dm = r.json?.data;
  const dash = await mustOk(await request('GET', '/api/dashboard', null, A), '대시보드');
  check(
    'X-08 이번 달 보고서 미수 월말 2,050(= 2,100 − 1일 00:10 수금 50) = 대시보드 총미수, 미지급 월말 1,700 = 대시보드 총미지급',
    dm.balances.receivable.closing === 2050 && eq(dm.balances.receivable.closing, dash.receivables.total_due) &&
      dm.balances.payable.closing === 1700 && eq(dm.balances.payable.closing, dash.payable.total) &&
      dm.receipts.amount === 50 && dm.receipts.count === 1,
    { m: dm.balances, dashDue: dash.receivables.total_due, dashPay: dash.payable.total, rc: dm.receipts }
  );
  check(
    'X-09 이번 달 보고서의 전월 = 지난달 보고서 본문과 같음(매출·이익·수금·잔액)',
    dm.previous.month === T.month && dm.previous.sales.amount === d.sales.amount && dm.previous.profit.profit === d.profit.profit &&
      dm.previous.receipts.amount === d.receipts.amount && dm.previous.balances.receivable.closing === rv.closing &&
      dm.balances.receivable.opening === rv.closing && dm.balances.payable.opening === pb.closing,
    { prev: dm.previous.month }
  );

  // ---------- 5. 회원 분리 ----------
  r = await report(B, T.month);
  const db = r.json?.data;
  check(
    'P-01 회원 B 보고서 = B 거래만(매입 10,000 · 매출 23,331), 상위에 A 거래처 없음',
    db.purchases.amount === 10000 && db.sales.amount === 23331 && db.top.sales_partners.length === 1 &&
      db.top.sales_partners[0].partner_id === CB.id && db.balances.receivable.closing === 23331,
    { p: db.purchases, s: db.sales, top: db.top }
  );
  check(
    'P-02 회원 A 보고서에 B 거래 없음(매출 상위·금액 그대로)',
    !d.top.sales_partners.some((x) => x.partner_id === CB.id) && !d.top.purchase_partners.some((x) => x.partner_id === SB.id),
    d.top
  );

  await pool.end();
  const fails = results.filter((x) => !x.ok).length;
  console.log(`\n[monthly-test] PASS ${results.length - fails} / FAIL ${fails} (대상 ${T.month}, 전월 ${P.month}, 이번 달 ${M.month})`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error('[monthly-test] 오류:', e);
  process.exit(1);
});
