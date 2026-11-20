/**
 * T-201 매입처 지급(미지급금) · 지급 원장 API 검사 — 설계 T-201_지급_설계.md 9장 인수 조건 AC-01~28, 31
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> PAYABLE_API_BASE=http://127.0.0.1:<포트> node scripts/payable-test.js
 * 전제: 마이그레이션 001~014, seed-admin(admin001 — 상품 등록용, 비밀번호 SMOKE_PASSWORD 또는 sample), 서버 기동.
 * 테스트 DB 전용 — 회원 A·B·D(t201a_/t201b_/t201d_<태그>)를 DB에 직접 만들고, 거래는 API로 만든다.
 * 날짜는 "실행일(KST 오늘) − n일"로 만든다. 설계 예시(오늘 11/20, P1 10/01, P2 10/05)는 P1 = 50일 전, P2 = 46일 전.
 * AC-29(기존 테스트 회귀)·AC-30(화면)은 이 스크립트 밖에서 실행·캡처한다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.PAYABLE_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[payable-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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
const toDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const fromDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const TODAY = kstToday();
const ago = (n) => fromDay(toDay(TODAY) - n);
const kstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

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
  const A = await mkUser('t201a');
  const B = await mkUser('t201b');
  const D = await mkUser('t201d');

  const product = await mustOk(await request('POST', '/api/products', { name: `T201-배추-${tag}`, unit: 'kg' }, admin), '상품');
  const mkPartner = async (token, name, type) => mustOk(await request('POST', '/api/partners', { name: `${name}-${tag}`, type }, token), `거래처 ${name}`);
  const buy = async (token, partner, qty, price, date) => {
    const p = await mustOk(
      await request('POST', '/api/purchases', { partner_id: partner.id, product_id: product.id, quantity: qty, unit_price: price, purchase_date: date }, token),
      `매입 ${partner.name} ${date}`
    );
    return p.id;
  };
  const pay = (token, body) => request('POST', '/api/supplier-payments', body, token);
  const pRow = async (id) => (await pool.query('SELECT paid_amount::float8 AS paid, payment_status AS st, total_amount::float8 AS total, status FROM purchase WHERE id = $1', [id])).rows[0];
  const spCount = async (partnerId) => Number((await pool.query('SELECT COUNT(*) FROM supplier_payment WHERE partner_id = $1', [partnerId])).rows[0].count);
  const ledger = async (token, partnerId, q = '') => request('GET', `/api/partners/${partnerId}/payable-ledger${q}`, null, token);
  const patchP = (token, id, changes) => request('PATCH', `/api/purchases/${id}`, { reason: 'T-201 테스트', changes }, token);

  // ---------- 준비 ----------
  const K1 = await mkPartner(A, 'K1농산', 'supplier');
  const K2 = await mkPartner(A, 'K2농산', 'wholesaler');
  const K3 = await mkPartner(A, 'K3농산', 'supplier');
  const K4 = await mkPartner(A, 'K4농산', 'market_wholesaler');
  const K5 = await mkPartner(A, 'K5농산', 'same_market');
  const L = await mkPartner(A, 'L농산', 'supplier');
  const L0 = await mkPartner(A, 'L0농산', 'supplier');
  const C = await mkPartner(A, 'C상회', 'customer');

  // ---------- AC-01 전액 지급 ----------
  const k1p1 = await buy(A, K1, 100, 1000, ago(50));
  let r = await pay(A, { partner_id: K1.id, amount: '100000', paid_at: `${TODAY}T10:00`, method: 'transfer', allocations: [{ purchase_id: k1p1, amount: '100000' }] });
  let row = await pRow(k1p1);
  const al1 = (await pool.query('SELECT COUNT(*)::int AS n FROM supplier_payment_allocation WHERE supplier_payment_id = $1', [r.json?.data?.id])).rows[0];
  check('AC-01 지급 100,000 [P1] → 201, 지급 1행·배분 1행, P1 paid 100000·paid',
    r.status === 201 && (await spCount(K1.id)) === 1 && al1.n === 1 && row.paid === 100000 && row.st === 'paid' && r.json.data.partner_payable_after === 0, { r: r.json, row });

  // ---------- AC-02 부분 지급 ----------
  const k2p1 = await buy(A, K2, 100, 1000, ago(20));
  r = await pay(A, { partner_id: K2.id, amount: 30000, allocations: [{ purchase_id: k2p1, amount: 30000 }] });
  const k2list = await mustOk(await request('GET', `/api/purchases?unpaid_only=1&partner_id=${K2.id}`, null, A), '미지급 매입 목록');
  check('AC-02 지급 30,000 → P1 partial, 미지급 70,000(매입 목록 unpaid_amount)',
    r.status === 201 && k2list.length === 1 && k2list[0].payment_status === 'partial' && Number(k2list[0].unpaid_amount) === 70000 && Number(k2list[0].paid_amount) === 30000, { r: r.json, k2list });

  // ---------- K3: P1 100,000(50일 전) · P2 50,000(46일 전) ----------
  const p1 = await buy(A, K3, 100, 1000, ago(50));
  const p2 = await buy(A, K3, 50, 1000, ago(46));

  r = await pay(A, { partner_id: K3.id, amount: 160000 });
  check('AC-04 초과 지급 160,000(배분 생략) → 400 OVERPAY, max_amount 150000, 변화 없음',
    r.status === 400 && r.json?.code === 'OVERPAY' && r.json.max_amount === 150000 && (await spCount(K3.id)) === 0 && (await pRow(p1)).paid === 0, r.json);

  r = await pay(A, { partner_id: K3.id, amount: 60000, allocations: [{ purchase_id: p2, amount: 60000 }] });
  check('AC-05 배분 [P2 60,000] > 미지급 50,000 → 400 ALLOC_OVER_DUE, 변화 없음',
    r.status === 400 && r.json?.code === 'ALLOC_OVER_DUE' && r.json.purchase_id === p2 && r.json.due === 50000 && (await spCount(K3.id)) === 0, r.json);

  r = await pay(A, { partner_id: K3.id, amount: 50000, allocations: [{ purchase_id: p1, amount: 40000 }] });
  check('AC-06 지급 50,000 · 배분 합 40,000 → 400 VALIDATION field allocations',
    r.status === 400 && r.json?.code === 'VALIDATION' && r.json.field === 'allocations' && (await spCount(K3.id)) === 0, r.json);

  r = await pay(A, { partner_id: K3.id, amount: '120000', paid_at: `${TODAY}T14:30`, memo: '10월분 일부' });
  const pay88 = r.json?.data?.id;
  let r1 = await pRow(p1);
  let r2 = await pRow(p2);
  const a3 = r.json?.data?.allocations || [];
  check('AC-03 지급 120,000 배분 생략 → 오래된 순 P1 100,000(paid)·P2 20,000(partial)',
    r.status === 201 && a3.length === 2 && a3[0].purchase_id === p1 && a3[0].amount === 100000 && a3[1].purchase_id === p2 && a3[1].amount === 20000 &&
      r1.st === 'paid' && r2.st === 'partial' && r2.paid === 20000 && r.json.data.partner_payable_after === 30000 && r.json.data.method === 'transfer', { r: r.json, r1, r2 });

  // ---------- AC-20·21 지급 원장 ----------
  r = await ledger(A, K3.id);
  let lg = r.json?.data;
  const last = lg?.entries?.[lg.entries.length - 1];
  check('AC-20 지급 원장(기간 없음) → 행 3개(매입·매입·지급), 마지막 잔액 30,000 = closing, check.diff 0',
    r.status === 200 && lg.scope === 'payable' && lg.entries.length === 3 && lg.entries.map((e) => e.kind).join(',') === 'purchase,purchase,payment' &&
      last.balance === 30000 && lg.closing_balance === 30000 && lg.check.diff === 0 && lg.check.purchase_based_due === 30000 &&
      lg.totals.purchases === 150000 && lg.totals.payments === 120000 && last.allocations.length === 2, lg);
  r = await ledger(A, K3.id, `?from=${ago(48)}`);
  lg = r.json?.data;
  check('AC-21 from = P1과 P2 사이 → opening 100,000, 첫 행 P2 잔액 150,000',
    r.status === 200 && lg.opening_balance === 100000 && lg.entries[0].ref_id === p2 && lg.entries[0].balance === 150000, lg);

  // ---------- AC-23 거래처 목록 미지급 ----------
  const partners = await mustOk(await request('GET', '/api/partners', null, A), '거래처 목록');
  const pf = (id) => partners.find((x) => x.id === id);
  check('AC-23 GET /api/partners → K3 payable 30,000, L0 0, 판매처 null',
    Number(pf(K3.id).payable_amount) === 30000 && Number(pf(L0.id).payable_amount) === 0 && pf(C.id).payable_amount === null, { K3: pf(K3.id), L0: pf(L0.id), C: pf(C.id) });

  // ---------- AC-11~15 매입 정정 제한 ----------
  r = await request('POST', `/api/purchases/${p1}/cancel`, { reason: '테스트' }, A);
  check('AC-11 지급 있는 P1 취소 → 409 PURCHASE_HAS_PAYMENT + payments 목록',
    r.status === 409 && r.json?.code === 'PURCHASE_HAS_PAYMENT' && r.json.detail?.payments?.length === 1 && r.json.detail.payments[0].id === pay88 && (await pRow(p1)).status === 'active', r.json);
  r = await patchP(A, p1, { unit_price: 800 });
  check('AC-12 P1 단가 내림(총액 80,000 < 지급 100,000) → 409 PAID_OVER_TOTAL, paid_amount 100000',
    r.status === 409 && r.json?.code === 'PAID_OVER_TOTAL' && r.json.detail?.paid_amount === 100000 && (await pRow(p1)).total === 100000, r.json);
  r = await patchP(A, p1, { unit_price: 1100 });
  r1 = await pRow(p1);
  check('AC-13 P1 단가 올림(총액 110,000) → 200, P1 partial, 미지급 10,000',
    r.status === 200 && r1.st === 'partial' && r1.total - r1.paid === 10000 && r.json.data.payment_status === 'partial' && Number(r.json.data.unpaid_amount) === 10000, { r: r.json, r1 });
  r = await patchP(A, p1, { partner_id: L.id });
  check('AC-14 지급 있는 P1 매입처 변경 → 409 PURCHASE_HAS_PAYMENT', r.status === 409 && r.json?.code === 'PURCHASE_HAS_PAYMENT', r.json);
  r = await patchP(A, p1, { purchase_date: ago(49), memo: '날짜 정정' });
  r1 = await pRow(p1);
  check('AC-15 지급 있는 P1 매입일·메모 변경 → 200, 지급·상태 그대로', r.status === 200 && r1.paid === 100000 && r1.st === 'partial', { r: r.json, r1 });
  // 되돌려 두기(총액 = 지급액은 허용) — 아래 AC-22 기대값(150,000)을 설계 예시와 같게
  r = await patchP(A, p1, { unit_price: 1000 });
  check('AC-13b P1 단가를 지급액과 같게(총액 100,000) → 200, paid', r.status === 200 && (await pRow(p1)).st === 'paid', r.json);

  // ---------- AC-16·17 지급 취소 ----------
  r = await request('POST', `/api/supplier-payments/${pay88}/cancel`, { reason: '금액 오입력' }, A);
  r1 = await pRow(p1);
  r2 = await pRow(p2);
  const keep = (await pool.query('SELECT COUNT(*)::int AS n FROM supplier_payment_allocation WHERE supplier_payment_id = $1', [pay88])).rows[0].n;
  const sp88 = (await pool.query('SELECT status, cancel_reason, cancelled_at FROM supplier_payment WHERE id = $1', [pay88])).rows[0];
  check('AC-16 지급 취소 → 200, cancelled, P1·P2 unpaid, 배분 행 2개 남음',
    r.status === 200 && sp88.status === 'cancelled' && sp88.cancelled_at && sp88.cancel_reason === '금액 오입력' &&
      r1.st === 'unpaid' && r1.paid === 0 && r2.st === 'unpaid' && r2.paid === 0 && keep === 2 && r.json.data.partner_payable_after === 150000, { r: r.json, r1, r2, keep });
  r = await request('POST', `/api/supplier-payments/${pay88}/cancel`, { reason: '다시' }, A);
  check('AC-17 취소된 지급 다시 취소 → 409 ALREADY_CANCELLED', r.status === 409 && r.json?.code === 'ALREADY_CANCELLED', r.json);
  r = await request('POST', `/api/supplier-payments/${pay88}/cancel`, { reason: '' }, A);
  check('AC-17b 사유 없이 취소 → 400 VALIDATION field reason', r.status === 400 && r.json?.field === 'reason', r.json);

  // ---------- AC-22 취소 후 원장 ----------
  r = await ledger(A, K3.id);
  lg = r.json?.data;
  const r22 = await ledger(A, K3.id, '?include_cancelled=1');
  const lgc = r22.json?.data;
  const cRow = lgc?.entries?.find((e) => e.kind === 'payment_cancelled');
  check('AC-22 취소 후 원장 → 지급 행 없음, 잔액 150,000 / include_cancelled=1 → 0원 취소 행',
    lg.entries.every((e) => e.kind !== 'payment') && lg.closing_balance === 150000 && lg.check.diff === 0 &&
      cRow && cRow.ref_id === pay88 && cRow.increase === 0 && cRow.decrease === 0 && cRow.cancelled_amount === 120000 && lgc.closing_balance === 150000, { lg, cRow });

  // ---------- AC-18 지급 취소 뒤 매입 취소 ----------
  r = await request('POST', `/api/purchases/${p1}/cancel`, { reason: '지급 취소 뒤' }, A);
  check('AC-18 지급 취소 뒤 P1 매입 취소 → 200', r.status === 200 && (await pRow(p1)).status === 'cancelled', r.json);

  // ---------- AC-07~09 지급 대상 ----------
  r = await pay(A, { partner_id: K3.id, amount: 1000, allocations: [{ purchase_id: p1, amount: 1000 }] });
  check('AC-07 취소된 매입 P1에 배분 → 400 PURCHASE_NOT_PAYABLE', r.status === 400 && r.json?.code === 'PURCHASE_NOT_PAYABLE', r.json);
  const lp = await buy(A, L, 10, 1000, ago(10));
  r = await pay(A, { partner_id: K3.id, amount: 1000, allocations: [{ purchase_id: lp, amount: 1000 }] });
  check('AC-08 다른 매입처 L의 매입을 K3 지급에 → 400 PURCHASE_NOT_PAYABLE', r.status === 400 && r.json?.code === 'PURCHASE_NOT_PAYABLE', r.json);
  r = await pay(A, { partner_id: C.id, amount: 1000 });
  check('AC-09 판매처(customer)에 지급 → 400 VALIDATION field partner_id', r.status === 400 && r.json?.code === 'VALIDATION' && r.json.field === 'partner_id', r.json);
  r = await pay(A, { partner_id: L0.id, amount: 1000 });
  check('AC-09b 지급 대상 매입 없음 → 400 NOTHING_TO_PAY', r.status === 400 && r.json?.code === 'NOTHING_TO_PAY', r.json);
  r = await pay(A, { partner_id: K3.id, amount: 1000, allocations: [{ purchase_id: p2, amount: 500 }, { purchase_id: p2, amount: 500 }] });
  check('AC-06b 같은 매입 두 행 → 400 VALIDATION allocations', r.status === 400 && r.json?.field === 'allocations', r.json);
  r = await pay(A, { partner_id: K3.id, amount: '10.005' });
  check('AC-06c 소수 3자리 금액 → 400 VALIDATION amount', r.status === 400 && r.json?.field === 'amount', r.json);

  // ---------- AC-10 남의 매입처·매입·지급 ----------
  const KB = await mkPartner(B, 'B농산', 'supplier');
  const bp = await buy(B, KB, 10, 500, ago(5));
  const bPay = await mustOk(await pay(B, { partner_id: KB.id, amount: 1000 }), 'B 지급');
  const bBefore = JSON.stringify(await pRow(bp));
  const t10 = [
    await pay(A, { partner_id: KB.id, amount: 1000 }),
    await pay(A, { partner_id: L.id, amount: 1000, allocations: [{ purchase_id: bp, amount: 1000 }] }),
    await ledger(A, KB.id),
    await request('POST', `/api/supplier-payments/${bPay.id}/cancel`, { reason: '남의 것' }, A),
    await request('GET', `/api/payables/aging?partner_id=${KB.id}`, null, A),
  ];
  const aList = await mustOk(await request('GET', '/api/supplier-payments?include_cancelled=1', null, A), 'A 지급 목록');
  check('AC-10 회원 A가 B의 매입처·매입·지급·원장·연령 → 모두 404, B 데이터 그대로, A 목록에 B 지급 없음',
    t10.every((x) => x.status === 404) && JSON.stringify(await pRow(bp)) === bBefore &&
      (await pool.query('SELECT status FROM supplier_payment WHERE id = $1', [bPay.id])).rows[0].status === 'active' && !aList.some((x) => x.id === bPay.id),
    t10.map((x) => x.status));
  r = await request('GET', '/api/supplier-payments', null, null);
  check('AC-10b 토큰 없음 → 401', r.status === 401, r.status);

  // ---------- AC-19 기초 정리 ----------
  const k4p1 = await buy(A, K4, 100, 1000, ago(50));
  const k4p2 = await buy(A, K4, 50, 1000, ago(46));
  r = await pay(A, { partner_id: K4.id, kind: 'opening', through_date: ago(48) });
  const op = r.json?.data;
  r1 = await pRow(k4p1);
  r2 = await pRow(k4p2);
  check('AC-19 기초 정리(P1과 P2 사이 기준일) → opening 1건 100,000, P1 paid, P2 그대로, 지급일 = 기준일(KST)',
    r.status === 201 && op.kind === 'opening' && op.amount === 100000 && op.allocations.length === 1 && op.allocations[0].purchase_id === k4p1 &&
      r1.st === 'paid' && r2.st === 'unpaid' && kstDate(op.paid_at) === ago(48) && op.memo === '기초 정리', { op, r1, r2 });
  r = await pay(A, { partner_id: K4.id, kind: 'opening', through_date: ago(48) });
  check('AC-19b 같은 기준일로 다시 기초 정리 → 400 NOTHING_TO_PAY', r.status === 400 && r.json?.code === 'NOTHING_TO_PAY', r.json);
  r = await pay(A, { partner_id: K4.id, kind: 'opening', through_date: ago(1), amount: 100 });
  check('AC-19c 기초 정리에 금액을 넣으면 → 400 VALIDATION amount', r.status === 400 && r.json?.field === 'amount', r.json);
  r = await ledger(A, K4.id);
  lg = r.json?.data;
  check('AC-19d 기초 정리는 원장에 "기초 정리" 행, 잔액 50,000, diff 0',
    lg.entries.some((e) => e.kind === 'payment' && e.pay_kind === 'opening' && e.kind_label === '기초 정리') && lg.closing_balance === 50000 && lg.check.diff === 0, lg);

  // ---------- AC-24 미지급 연령 ----------
  await buy(A, K5, 50, 1000, ago(40));
  r = await request('GET', `/api/payables/aging?partner_id=${K5.id}`, null, A);
  const ag = r.json?.data;
  const agRow = ag?.rows?.[0];
  check('AC-24 40일 전 50,000 → d31_60 50,000, 구간 합 = total_due, 매입 상세 1건',
    r.status === 200 && agRow.d31_60 === 50000 && agRow.total_due === 50000 && agRow.d0_30 + agRow.d31_60 + agRow.d61_90 + agRow.d91p === agRow.total_due &&
      ag.purchases.length === 1 && ag.purchases[0].bucket === 'd31_60' && ag.basis === 'purchase_date', ag);
  r = await request('GET', '/api/payables/aging', null, A);
  const agAll = r.json?.data;
  const tt = agAll?.totals;
  check('AC-24b 전체 연령: 구간 합 = total_due, 매입처 합 = 합계',
    r.status === 200 && Math.abs(tt.d0_30 + tt.d31_60 + tt.d61_90 + tt.d91p - tt.total_due) < 0.005 &&
      Math.abs(agAll.rows.reduce((s, x) => s + x.total_due, 0) - tt.total_due) < 0.005, tt);

  // ---------- AC-25 대시보드 (회원 D — 깨끗한 데이터) ----------
  const M = await mkPartner(D, 'M농산', 'supplier');
  const M2 = await mkPartner(D, 'M2농산', 'supplier');
  await buy(D, M, 100, 1000, TODAY);
  await buy(D, M2, 5, 1000, TODAY);
  const nowIso = new Date().toISOString();
  await mustOk(await pay(D, { partner_id: M.id, amount: 30000, paid_at: nowIso }), '오늘 지급 1');
  await mustOk(await pay(D, { partner_id: M.id, amount: 20000, paid_at: nowIso }), '오늘 지급 2');
  const toCancel = await mustOk(await pay(D, { partner_id: M.id, amount: 10000, paid_at: nowIso }), '오늘 지급 3');
  await mustOk(await request('POST', `/api/supplier-payments/${toCancel.id}/cancel`, { reason: '취소' }, D), '오늘 지급 3 취소');
  await mustOk(await pay(D, { partner_id: M2.id, kind: 'opening', through_date: TODAY }), '오늘 기초 정리');
  const dash = await mustOk(await request('GET', '/api/dashboard', null, D), '대시보드');
  const dAging = await mustOk(await request('GET', '/api/payables/aging', null, D), 'D 연령');
  const todayList = await mustOk(await request('GET', `/api/supplier-payments?from_date=${TODAY}&to_date=${TODAY}`, null, D), 'D 오늘 지급 목록');
  const listPay = todayList.filter((x) => x.kind === 'pay').reduce((s, x) => s + x.amount, 0);
  check('AC-25 대시보드 오늘 지급 50,000 2건(기초 정리·취소 제외), payable.total = 연령 total_due = 50,000, = 지급정보 오늘 목록(pay) 합',
    dash.today.pay_amount === 50000 && dash.today.pay_count === 2 && dash.today.payments.amount === 50000 &&
      dash.payable.total === dAging.totals.total_due && dash.payable.total === 50000 && listPay === 50000 &&
      dash.payable.top.length === 1 && dash.payable.top[0].partner_id === M.id && dash.payable.has_any_payment === true, { today: dash.today, payable: dash.payable, aging: dAging.totals, listPay });

  // ---------- AC-26 같은 매입에 동시 지급 ----------
  const N = await mkPartner(A, 'N농산', 'supplier');
  const np = await buy(A, N, 100, 1000, ago(3));
  const both = await Promise.all([
    pay(A, { partner_id: N.id, amount: 70000, allocations: [{ purchase_id: np, amount: 70000 }] }),
    pay(A, { partner_id: N.id, amount: 70000, allocations: [{ purchase_id: np, amount: 70000 }] }),
  ]);
  const st26 = both.map((x) => x.status).sort();
  check('AC-26 지급 70,000 두 건 동시 → 하나만 201, 다른 하나 400 ALLOC_OVER_DUE, paid 70,000',
    st26.join(',') === '201,400' && both.find((x) => x.status === 400).json.code === 'ALLOC_OVER_DUE' && (await pRow(np)).paid === 70000, both.map((x) => x.json));

  // ---------- AC-27 지급 등록 ↔ 매입 취소 동시 ----------
  let ok27 = true;
  const seen27 = [];
  for (let i = 0; i < 4; i += 1) {
    const N2 = await mkPartner(A, `N2농산${i}`, 'supplier');
    const q = await buy(A, N2, 10, 1000, ago(2));
    const [rp, rc] = await Promise.all([
      pay(A, { partner_id: N2.id, amount: 5000, allocations: [{ purchase_id: q, amount: 5000 }] }),
      request('POST', `/api/purchases/${q}/cancel`, { reason: '동시 취소' }, A),
    ]);
    const pr = await pRow(q);
    const payWon = rp.status === 201 && rc.status === 409 && rc.json?.code === 'PURCHASE_HAS_PAYMENT' && pr.status === 'active' && pr.paid === 5000;
    const cancelWon = rc.status === 200 && rp.status === 400 && rp.json?.code === 'PURCHASE_NOT_PAYABLE' && pr.status === 'cancelled' && pr.paid === 0;
    seen27.push(payWon ? 'pay' : cancelWon ? 'cancel' : `?${rp.status}/${rc.status}`);
    if (!payWon && !cancelWon) ok27 = false;
  }
  check(`AC-27 지급 등록과 매입 취소 동시(4회) → 매번 하나만 성공 [${seen27.join(',')}]`, ok27, seen27);

  // ---------- 지급 목록 ----------
  const k3list = await mustOk(await request('GET', `/api/supplier-payments?partner_id=${K3.id}`, null, A), 'K3 지급 목록');
  const k3all = await mustOk(await request('GET', `/api/supplier-payments?partner_id=${K3.id}&include_cancelled=1`, null, A), 'K3 지급 목록(취소 포함)');
  check('W-04 지급 목록: 취소 지급은 기본 제외, include_cancelled=1 이면 배분 포함해 보임',
    k3list.length === 0 && k3all.length === 1 && k3all[0].status === 'cancelled' && k3all[0].allocations.length === 2 && k3all[0].allocations[0].purchase_date === ago(49), { k3list, k3all });

  // ---------- 모든 매입처 원장 diff 0 ----------
  const allA = await mustOk(await request('GET', '/api/partners', null, A), 'A 거래처');
  let diffs = [];
  for (const p of allA.filter((x) => x.type !== 'customer')) {
    const x = (await ledger(A, p.id)).json.data;
    if (x.check.diff !== 0 || x.closing_balance !== Number(p.payable_amount)) diffs.push({ id: p.id, name: p.name, diff: x.check.diff, close: x.closing_balance, pay: p.payable_amount });
  }
  check('LEDGER 회원 A 모든 매입처: 원장 잔액 = 매입별 미지급 합 = 거래처 목록 미지급 (diff 0)', diffs.length === 0, diffs);
  const cLedger = (await ledger(A, C.id)).json;
  check('LEDGER-b 판매처(customer) 지급 원장 → 200 빈 원장 scope payable', cLedger.ok && cLedger.data.entries.length === 0 && cLedger.data.scope === 'payable', cLedger);

  // ---------- AC-28 확인 SQL ①②③ (DB 전체) ----------
  const q1 = await pool.query(`SELECT pu.id FROM purchase pu
      LEFT JOIN (SELECT spa.purchase_id, SUM(spa.amount) s FROM supplier_payment_allocation spa
                 JOIN supplier_payment sp ON sp.id = spa.supplier_payment_id AND sp.status = 'active'
                 GROUP BY spa.purchase_id) x ON x.purchase_id = pu.id
      WHERE pu.paid_amount <> COALESCE(x.s, 0)`);
  const q2 = await pool.query(`SELECT sp.id FROM supplier_payment sp LEFT JOIN supplier_payment_allocation spa ON spa.supplier_payment_id = sp.id
      GROUP BY sp.id, sp.amount HAVING sp.amount <> COALESCE(SUM(spa.amount), 0)`);
  const q3 = await pool.query(`SELECT spa.id FROM supplier_payment_allocation spa
      JOIN supplier_payment sp ON sp.id = spa.supplier_payment_id AND sp.status = 'active'
      JOIN purchase pu ON pu.id = spa.purchase_id AND pu.status = 'cancelled'`);
  const q4 = await pool.query(`SELECT id FROM purchase WHERE payment_status IS DISTINCT FROM
      (CASE WHEN paid_amount >= total_amount THEN 'paid' WHEN paid_amount > 0 THEN 'partial' ELSE 'unpaid' END)::payment_status`);
  check('AC-28 확인 SQL ① 유지 칸=배분 합 ② 지급액=배분 합 ③ 취소 매입 배분 ④ 상태식 — 모두 0행',
    q1.rowCount === 0 && q2.rowCount === 0 && q3.rowCount === 0 && q4.rowCount === 0, { q1: q1.rows, q2: q2.rows, q3: q3.rows, q4: q4.rows });

  // ---------- AC-31 014 다시 실행 ----------
  const snap = async () => (await pool.query(`SELECT (SELECT COUNT(*) FROM supplier_payment) a, (SELECT COUNT(*) FROM supplier_payment_allocation) b,
      (SELECT COALESCE(SUM(paid_amount), 0) FROM purchase) c, (SELECT string_agg(payment_status::text, '' ORDER BY id) FROM purchase) d`)).rows[0];
  const before31 = JSON.stringify(await snap());
  let err31 = null;
  const c31 = await pool.connect();
  try {
    await c31.query('BEGIN');
    await c31.query(fs.readFileSync(path.join(__dirname, '..', 'migrations', '014_supplier_payment.sql'), 'utf8'));
    await c31.query('COMMIT');
  } catch (e) {
    err31 = e.message;
    await c31.query('ROLLBACK').catch(() => {});
  } finally {
    c31.release();
  }
  check('AC-31 014를 데이터가 있는 DB에 다시 실행 → 오류 없음, 데이터 변화 없음', !err31 && JSON.stringify(await snap()) === before31, err31);

  await pool.end();
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n결과: ${pass}/${results.length} 통과 (AC 고유 ${new Set(results.map((x) => x.name.split(' ')[0].replace(/[a-d]$/, ''))).size}종)`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('[payable-test] 중단:', e.message);
  process.exit(1);
});
