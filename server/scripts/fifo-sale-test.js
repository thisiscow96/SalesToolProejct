/**
 * T-205 재고 기준 판매(선입선출) 인수 조건 자동 테스트 — AC-01 ~ AC-23, AC-25
 * - 설계: AI 팀 산출물 T-205_FIFO_설계.md 9장 (AC-24 회귀는 기존 테스트로, AC-26 은 화면 캡처로, AC-27 은 U-1 승인 시에만)
 * - 출발점: A 검증 스크립트 verify_T205_fifo.cjs 의 경우(A1~G1)를 API 로 옮김
 * - 전제: 테스트 DB(마이그레이션 015까지) + seed-admin, 서버 기동
 * - 실행: DATABASE_URL=… FIFO_API_BASE=http://127.0.0.1:3495 node scripts/fifo-sale-test.js
 * - 운영 DB에서 실행하지 않는다. DATABASE_URL 이 127.0.0.1/localhost 가 아니면 멈춘다.
 * 각 AC 는 자기 상품을 새로 만들어 서로 영향을 주지 않는다.
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { getPgConfig } = require('../lib/db-config');

const BASE = process.env.FIFO_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const AGENT = 'admin001';
const PW = process.env.SEED_ADMIN_PASSWORD || 'sample';

const cfg = getPgConfig();
if (!/^(127\.0\.0\.1|localhost)$/.test(String(cfg.host || ''))) {
  console.error('[fifo] 로컬 테스트 DB가 아닙니다. 멈춥니다. host =', cfg.host);
  process.exit(2);
}
const pool = new Pool(cfg);
let TOKEN = '';
let USER_ID = 0;
let USER2 = 0;
let SUP = 0; // 매입처 K
let SUP2 = 0; // 매입처 L
let CUS = 0; // 판매처 C
let CUS_OTHER = 0; // 다른 회원의 판매처
const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const D1 = '2026-10-01';
const D2 = '2026-10-05';
const D3 = '2026-10-09';
const results = [];

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 빈 응답 */ }
  return { status: r.status, json };
}
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const num = (v) => Number(v);
const J = (x) => JSON.stringify(x);
function check(cond, msg) { if (!cond) throw new Error(msg); }

let seq = 0;
async function newProduct(label = '배추') {
  seq += 1;
  const r = await q(`INSERT INTO product (name, unit) VALUES ($1, 'kg') RETURNING id`, [`T205${label}${Date.now()}_${seq}`]);
  return r[0].id;
}
async function inv(pid) {
  const r = await q(`SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2`, [USER_ID, pid]);
  return num(r[0]?.quantity ?? 0);
}
async function purchase(pid, qty, price, date, partner = SUP, source = null) {
  const r = await api('POST', '/api/purchases', { partner_id: partner, product_id: pid, quantity: qty, unit_price: price, purchase_date: date, source_name: source });
  if (r.status !== 201) throw new Error('매입 등록 실패 ' + J(r.json));
  return r.json.data.id;
}
/** 기본 데이터: L1(10/01, 10 @1,000) · L2(10/05, 5 @1,200) · L3(10/09, 8 @1,100), 재고 23 */
async function base(opts = {}) {
  const pid = await newProduct();
  const L1 = await purchase(pid, 10, 1000, D1, SUP, '해남');
  const L2 = await purchase(pid, 5, 1200, D2, opts.l23Partner || SUP);
  const L3 = await purchase(pid, 8, 1100, D3, opts.l23Partner || SUP);
  return { pid, L1, L2, L3 };
}
async function sell(items, extra = {}) {
  return api('POST', '/api/sales', { partner_id: CUS, sale_date: TODAY, ...extra, items });
}
async function allocs(saleId) {
  return (await q(`SELECT purchase_id, quantity::numeric AS q FROM purchase_allocation WHERE sale_id = $1 ORDER BY purchase_id`, [saleId]))
    .map((r) => ({ purchase_id: r.purchase_id, q: num(r.q) }));
}
async function remaining(purchaseId) {
  const r = await q(
    `SELECT (pu.quantity - COALESCE((SELECT SUM(quantity) FROM purchase_allocation WHERE purchase_id = pu.id),0))::numeric AS r FROM purchase pu WHERE id = $1`,
    [purchaseId]
  );
  return num(r[0].r);
}
/** 방향 기준 원장 대조: 재고 = Σ(to=inventory) − Σ(from=inventory) → 차이 0 이어야 함 */
async function ledgerDiff(pid) {
  const r = await q(
    `SELECT COALESCE(SUM(CASE WHEN to_type='inventory' THEN quantity ELSE 0 END),0) - COALESCE(SUM(CASE WHEN from_type='inventory' THEN quantity ELSE 0 END),0) AS l
     FROM product_transfer WHERE user_id = $1 AND product_id = $2`,
    [USER_ID, pid]
  );
  return num(r[0].l) - (await inv(pid));
}
const snapshot = async (pid) => J({
  inv: await inv(pid),
  sale: (await q(`SELECT COUNT(*)::int c FROM sale WHERE product_id = $1`, [pid]))[0].c,
  pt: (await q(`SELECT COUNT(*)::int c FROM product_transfer WHERE product_id = $1`, [pid]))[0].c,
  pa: (await q(`SELECT COALESCE(SUM(pa.quantity),0)::numeric s FROM purchase_allocation pa JOIN purchase pu ON pu.id = pa.purchase_id WHERE pu.product_id = $1`, [pid]))[0].s,
});
const sameAlloc = (got, want) => J(got) === J(want);

async function ac(id, title, fn) {
  try {
    const note = await fn();
    results.push({ id, title, ok: true, note: note || '' });
    console.log(`PASS ${id} ${title}${note ? ' — ' + note : ''}`);
  } catch (err) {
    results.push({ id, title, ok: false, note: err.message });
    console.log(`FAIL ${id} ${title} — ${err.message}`);
  }
}

async function setup() {
  const lr = await api('POST', '/api/auth/login', { agent_no: AGENT, password: PW });
  if (lr.status !== 200 || !lr.json?.token) throw new Error('로그인 실패 ' + lr.status);
  TOKEN = lr.json.token;
  USER_ID = (await q(`SELECT id FROM "user" WHERE agent_no = $1`, [AGENT]))[0].id;
  SUP = (await q(`INSERT INTO account (user_id, name, type, location) VALUES ($1, 'T205 K농산', 'supplier', '가락 1동') RETURNING id`, [USER_ID]))[0].id;
  SUP2 = (await q(`INSERT INTO account (user_id, name, type, location) VALUES ($1, 'T205 L청과', 'supplier', '가락 2동') RETURNING id`, [USER_ID]))[0].id;
  CUS = (await q(`INSERT INTO account (user_id, name, type, location) VALUES ($1, 'T205 C상회', 'customer', '서울') RETURNING id`, [USER_ID]))[0].id;
  // 다른 회원(로그인하지 않음 — 데이터만)
  const u2 = await q(`SELECT id FROM "user" WHERE agent_no = 'T205OTHER'`);
  USER2 = u2[0]?.id || (await q(
    `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at)
     VALUES ('T205 다른 회원', NULL, $1, 'T205OTHER', 'x', NOW()) RETURNING id`,
    [`t205other${Date.now()}@example.test`]
  ))[0].id;
  CUS_OTHER = (await q(`INSERT INTO account (user_id, name, type) VALUES ($1, 'T205 남의 판매처', 'customer') RETURNING id`, [USER2]))[0].id;
}

async function main() {
  await setup();

  await ac('AC-01', '한 로트 안: 6개 → 매출 1건(fifo, 9,000), 배분 L1 6, 재고 17', async () => {
    const b = await base();
    const r = await sell([{ product_id: b.pid, quantity: 6, unit_price: 1500 }]);
    check(r.status === 201, `${r.status} ${J(r.json)}`);
    const s = r.json.data.sales[0];
    const row = (await q(`SELECT entry_mode, total_amount::numeric t, quantity::numeric q, payment_status FROM sale WHERE id = $1`, [s.sale_id]))[0];
    check(row.entry_mode === 'fifo' && num(row.t) === 9000 && num(row.q) === 6 && row.payment_status === 'unpaid', J(row));
    check(sameAlloc(await allocs(s.sale_id), [{ purchase_id: b.L1, q: 6 }]), J(await allocs(s.sale_id)));
    check((await inv(b.pid)) === 17, `재고 ${await inv(b.pid)}`);
    check((await ledgerDiff(b.pid)) === 0, '원장 대조 어긋남');
    return `sale #${s.sale_id}`;
  });

  let AC02 = null; // { b, saleId }
  async function makeAc02() {
    const b = await base();
    const r = await sell([{ product_id: b.pid, quantity: 12, unit_price: 1500 }]);
    if (r.status !== 201) throw new Error(`판매 실패 ${r.status} ${J(r.json)}`);
    return { b, saleId: r.json.data.sales[0].sale_id, res: r.json.data.sales[0] };
  }

  await ac('AC-02', '로트 경계: 12개 → L1 10 + L2 2, 이동 이력 2행, 재고 11', async () => {
    AC02 = await makeAc02();
    const { b, saleId } = AC02;
    check(sameAlloc(await allocs(saleId), [{ purchase_id: b.L1, q: 10 }, { purchase_id: b.L2, q: 2 }]), J(await allocs(saleId)));
    const pt = await q(`SELECT purchase_id, quantity::numeric q, action_type, from_type, to_type FROM product_transfer WHERE sale_id = $1 ORDER BY purchase_id`, [saleId]);
    check(pt.length === 2 && pt.every((x) => x.action_type === 'sale' && x.from_type === 'inventory' && x.to_type === 'customer'), J(pt));
    check(pt[0].purchase_id === b.L1 && num(pt[0].q) === 10 && pt[1].purchase_id === b.L2 && num(pt[1].q) === 2, J(pt));
    check((await inv(b.pid)) === 11, `재고 ${await inv(b.pid)}`);
    check((await ledgerDiff(b.pid)) === 0, '원장 대조 어긋남');
  });

  await ac('AC-03', '원가 12,400·이익 5,600 = 일별 보고서의 그 매출 원가·이익', async () => {
    const b = await base();
    const cus3 = (await q(`INSERT INTO account (user_id, name, type) VALUES ($1, 'T205 AC03 판매처', 'customer') RETURNING id`, [USER_ID]))[0].id;
    const r = await api('POST', '/api/sales', { partner_id: cus3, sale_date: TODAY, items: [{ product_id: b.pid, quantity: 12, unit_price: 1500 }] });
    check(r.status === 201, `${r.status} ${J(r.json)}`);
    const s = r.json.data.sales[0];
    check(s.cost === 12400 && s.profit === 5600 && s.total_amount === 18000 && s.below_cost === false, J(s));
    const rep = await api('GET', `/api/reports/daily-purchase-sales?from_date=${TODAY}&to_date=${TODAY}&partner_id=${cus3}`);
    const d = rep.json.data[0];
    check(num(d.cost_amount) === 12400 && num(d.profit_amount) === 5600 && num(d.cost_missing_count) === 0, J(d));
    return `보고서 원가 ${num(d.cost_amount)} 이익 ${num(d.profit_amount)}`;
  });

  await ac('AC-04', '원가보다 싼 단가(900) → 201, below_cost:true', async () => {
    const b = await base();
    const r = await sell([{ product_id: b.pid, quantity: 6, unit_price: 900 }]);
    check(r.status === 201 && r.json.data.sales[0].below_cost === true, `${r.status} ${J(r.json)}`);
  });

  await ac('AC-05', '24개(재고 23) → 409 STOCK_SHORT {sellable 23}, 변화 없음', async () => {
    const b = await base();
    const before = await snapshot(b.pid);
    const r = await sell([{ product_id: b.pid, quantity: 24, unit_price: 1500 }]);
    check(r.status === 409 && r.json.code === 'STOCK_SHORT', `${r.status} ${J(r.json)}`);
    const d = r.json.detail;
    check(d.sellable_qty === 23 && d.inventory_qty === 23 && d.unlinked_qty === 0 && d.requested_qty === 24 && d.item_index === 0, J(d));
    check((await snapshot(b.pid)) === before, '변화가 생김');
  });

  await ac('AC-06', '여러 품목 중 하나 부족 → 409 item_index 1, 앞 품목도 저장 안 됨', async () => {
    const b = await base();
    const mu = await newProduct('무');
    await purchase(mu, 2, 500, D1);
    const b0 = await snapshot(b.pid);
    const m0 = await snapshot(mu);
    const r = await sell([{ product_id: b.pid, quantity: 5, unit_price: 1500 }, { product_id: mu, quantity: 3, unit_price: 800 }]);
    check(r.status === 409 && r.json.code === 'STOCK_SHORT' && r.json.detail.item_index === 1 && r.json.detail.sellable_qty === 2, `${r.status} ${J(r.json)}`);
    check((await snapshot(b.pid)) === b0 && (await snapshot(mu)) === m0, '부분 저장됨');
  });

  await ac('AC-07', '폐기 6 후(재고 17) 6개 → L1 4 + L2 2', async () => {
    const b = await base();
    const d = await api('POST', '/api/disposals', { product_id: b.pid, quantity: 6, disposal_date: TODAY });
    check(d.status === 201 || d.status === 200, `폐기 ${d.status} ${J(d.json)}`);
    const r = await sell([{ product_id: b.pid, quantity: 6, unit_price: 1500 }]);
    check(r.status === 201, `${r.status} ${J(r.json)}`);
    check(sameAlloc(await allocs(r.json.data.sales[0].sale_id), [{ purchase_id: b.L1, q: 4 }, { purchase_id: b.L2, q: 2 }]), J(await allocs(r.json.data.sales[0].sale_id)));
    check((await inv(b.pid)) === 11, `재고 ${await inv(b.pid)}`);
  });

  await ac('AC-08', '전환 10 후 반품 3 → 재고현황 sellable 0·unlinked 3 / FIFO 3개 409 unlinked 3', async () => {
    const pid = await newProduct();
    const L1 = await purchase(pid, 10, 1000, D1);
    const cv = await api('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: L1, partner_id: CUS, quantity: 10, unit_price: 1500, sale_date: TODAY }] });
    check(cv.status === 201, `전환 ${cv.status}`);
    const rf = await api('POST', `/api/sales/${cv.json.data[0].sale_id}/refund`, { quantity: 3, refunded_at: TODAY, reason: '시험' });
    check(rf.status === 201 || rf.status === 200, `반품 ${rf.status} ${J(rf.json)}`);
    const iv = await api('GET', '/api/inventory');
    const row = iv.json.data.find((x) => x.product_id === pid);
    check(row && num(row.quantity) === 3 && num(row.sellable_qty) === 0 && num(row.unlinked_qty) === 3, J(row));
    const r = await sell([{ product_id: pid, quantity: 3, unit_price: 1500 }]);
    check(r.status === 409 && r.json.code === 'STOCK_SHORT' && r.json.detail.unlinked_qty === 3 && r.json.detail.sellable_qty === 0, `${r.status} ${J(r.json)}`);
    check(/반품으로 들어온 3/.test(r.json.message), r.json.message);
    return r.json.message;
  });

  await ac('AC-09', '판매일 10/04, 12개 → 409 sellable 10 (10/05 이후 매입 제외)', async () => {
    const b = await base();
    const r = await sell([{ product_id: b.pid, quantity: 12, unit_price: 1500 }], { sale_date: '2026-10-04' });
    check(r.status === 409 && r.json.code === 'STOCK_SHORT' && r.json.detail.sellable_qty === 10, `${r.status} ${J(r.json)}`);
  });

  await ac('AC-10', '매입처 한정(L2·L3 = L청과) 6개 → L2 5 + L3 1', async () => {
    const b = await base({ l23Partner: SUP2 });
    const r = await sell([{ product_id: b.pid, quantity: 6, unit_price: 1500, partner_id_filter: SUP2 }]);
    check(r.status === 201, `${r.status} ${J(r.json)}`);
    check(sameAlloc(await allocs(r.json.data.sales[0].sale_id), [{ purchase_id: b.L2, q: 5 }, { purchase_id: b.L3, q: 1 }]), J(await allocs(r.json.data.sales[0].sale_id)));
    // 출처 한정(해남 = L1)
    const r2 = await sell([{ product_id: b.pid, quantity: 3, unit_price: 1500, source_name_filter: '해남' }]);
    check(r2.status === 201 && sameAlloc(await allocs(r2.json.data.sales[0].sale_id), [{ purchase_id: b.L1, q: 3 }]), `출처 한정 ${r2.status} ${J(r2.json)}`);
  });

  await ac('AC-11', '취소된 매입·다른 회원 매입은 판매 가능에서 제외', async () => {
    const b = await base();
    const cn = await api('POST', `/api/purchases/${b.L1}/cancel`, { reason: '시험 취소' });
    check(cn.status === 200, `매입 취소 ${cn.status} ${J(cn.json)}`);
    // 다른 회원의 같은 상품 매입(오래된 날짜) + 재고
    const sup2 = (await q(`INSERT INTO account (user_id, name, type) VALUES ($1, 'T205 남의 매입처', 'supplier') RETURNING id`, [USER2]))[0].id;
    const op = (await q(
      `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date) VALUES ($1,$2,$3,50,10,500,'2026-09-01') RETURNING id`,
      [USER2, sup2, b.pid]
    ))[0].id;
    await q(`INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1,$2,50)`, [USER2, b.pid]);
    const pv = await api('GET', `/api/inventory/${b.pid}/fifo-preview?quantity=13&unit_price=1500`);
    check(pv.status === 200, `${pv.status} ${J(pv.json)}`);
    const d = pv.json.data;
    const ids = d.allocations.map((x) => x.purchase_id);
    check(d.sellable_qty === 13 && d.inventory_qty === 13 && d.enough === true, J(d));
    check(!ids.includes(b.L1) && !ids.includes(op) && J(ids) === J([b.L2, b.L3]), J(ids));
    const over = await sell([{ product_id: b.pid, quantity: 14, unit_price: 1500 }]);
    check(over.status === 409 && over.json.detail.sellable_qty === 13, `${over.status} ${J(over.json)}`);
  });

  await ac('AC-12', '다른 회원의 판매처로 판매 → 404, 변화 없음', async () => {
    const b = await base();
    const before = await snapshot(b.pid);
    const r = await api('POST', '/api/sales', { partner_id: CUS_OTHER, sale_date: TODAY, items: [{ product_id: b.pid, quantity: 1, unit_price: 1500 }] });
    check(r.status === 404 && r.json.code === 'NOT_FOUND', `${r.status} ${J(r.json)}`);
    check((await snapshot(b.pid)) === before, '변화가 생김');
  });

  await ac('AC-13', '판매처가 supplier 유형 → 400 (전환과 같은 문구)', async () => {
    const b = await base();
    const r = await api('POST', '/api/sales', { partner_id: SUP, sale_date: TODAY, items: [{ product_id: b.pid, quantity: 1, unit_price: 1500 }] });
    check(r.status === 400 && r.json.message === '판매 가능한 거래처를 선택하세요.', `${r.status} ${J(r.json)}`);
  });

  await ac('AC-14', '재고 10(L1 4 + L2 6), 10개 판매 2건 동시 → 1건 201·1건 409, 배분 합 10, 재고 0', async () => {
    const pid = await newProduct();
    const L1 = await purchase(pid, 4, 1000, D1);
    const L2 = await purchase(pid, 6, 1200, D2);
    const [a, c] = await Promise.all([
      sell([{ product_id: pid, quantity: 10, unit_price: 1500 }]),
      sell([{ product_id: pid, quantity: 10, unit_price: 1500 }]),
    ]);
    const st = [a.status, c.status].sort();
    check(J(st) === J([201, 409]), `상태 ${J(st)} ${J(a.json)} ${J(c.json)}`);
    const loser = a.status === 409 ? a : c;
    check(loser.json.code === 'STOCK_SHORT', J(loser.json));
    const s = (await q(`SELECT COALESCE(SUM(pa.quantity),0)::numeric s FROM purchase_allocation pa WHERE pa.purchase_id = ANY($1::int[])`, [[L1, L2]]))[0].s;
    check(num(s) === 10 && (await inv(pid)) === 0, `배분 ${s} 재고 ${await inv(pid)}`);
    check((await remaining(L1)) === 0 && (await remaining(L2)) === 0, '로트 잔량');
    return `상태 ${a.status}/${c.status}`;
  });

  await ac('AC-15', 'FIFO 12개와 전환(L1 10개) 동시 → L1 배분 ≤ 10, 잔량 음수 없음', async () => {
    const b = await base();
    const [f, cv] = await Promise.all([
      sell([{ product_id: b.pid, quantity: 12, unit_price: 1500 }]),
      api('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: b.L1, partner_id: CUS, quantity: 10, unit_price: 1500, sale_date: TODAY }] }),
    ]);
    const l1 = (await q(`SELECT COALESCE(SUM(quantity),0)::numeric s FROM purchase_allocation WHERE purchase_id = $1`, [b.L1]))[0].s;
    check(num(l1) <= 10, `L1 배분 ${l1}`);
    for (const p of [b.L1, b.L2, b.L3]) check((await remaining(p)) >= 0, `잔량 음수 ${p}`);
    check((await inv(b.pid)) >= 0 && (await ledgerDiff(b.pid)) === 0, '재고·원장');
    const lots = await q(`SELECT COALESCE(SUM(remain),0)::numeric s FROM inventory_lot_available WHERE user_id = $1 AND product_id = $2`, [USER_ID, b.pid]);
    check(num(lots[0].s) === (await inv(b.pid)), `로트 합 ${lots[0].s} ≠ 재고 ${await inv(b.pid)}`);
    return `FIFO ${f.status} · 전환 ${cv.status}, L1 배분 ${num(l1)}`;
  });

  await ac('AC-16', 'AC-02 매출 취소 → 배분 2행 삭제, 재고 23, 잔량 원복', async () => {
    const x = await makeAc02();
    const r = await api('POST', `/api/sales/${x.saleId}/cancel`, { reason: '시험 취소' });
    check(r.status === 200, `${r.status} ${J(r.json)}`);
    check((await allocs(x.saleId)).length === 0, '배분 남음');
    check((await inv(x.b.pid)) === 23 && (await remaining(x.b.L1)) === 10 && (await remaining(x.b.L2)) === 5, '재고·잔량');
    check((await ledgerDiff(x.b.pid)) === 0, '원장 대조');
  });

  await ac('AC-17', 'AC-02 매출 수량 12 → 8: L2 배분 삭제, L1 10 → 8, 재고 +4, correction 이력', async () => {
    const x = await makeAc02();
    const r = await api('PATCH', `/api/sales/${x.saleId}`, { reason: '수량 정정', changes: { quantity: 8 } });
    check(r.status === 200, `${r.status} ${J(r.json)}`);
    check(sameAlloc(await allocs(x.saleId), [{ purchase_id: x.b.L1, q: 8 }]), J(await allocs(x.saleId)));
    check((await inv(x.b.pid)) === 15, `재고 ${await inv(x.b.pid)}`);
    const pt = await q(`SELECT purchase_id, quantity::numeric q FROM product_transfer WHERE sale_id = $1 AND action_type = 'correction' ORDER BY purchase_id`, [x.saleId]);
    check(pt.length === 2 && pt[0].purchase_id === x.b.L1 && num(pt[0].q) === 2 && pt[1].purchase_id === x.b.L2 && num(pt[1].q) === 2, J(pt));
    check((await ledgerDiff(x.b.pid)) === 0, '원장 대조');
    const tc = await q(`SELECT action FROM trade_correction WHERE target_type = 'sale' AND target_id = $1`, [x.saleId]);
    check(tc.length === 1, '정정 이력');
  });

  await ac('AC-18', 'AC-02 매출 수량 12 → 14: L2 배분 2 → 4, 재고 −2', async () => {
    const x = await makeAc02();
    const r = await api('PATCH', `/api/sales/${x.saleId}`, { reason: '수량 정정', changes: { quantity: 14 } });
    check(r.status === 200, `${r.status} ${J(r.json)}`);
    check(sameAlloc(await allocs(x.saleId), [{ purchase_id: x.b.L1, q: 10 }, { purchase_id: x.b.L2, q: 4 }]), J(await allocs(x.saleId)));
    check((await inv(x.b.pid)) === 9 && (await ledgerDiff(x.b.pid)) === 0, `재고 ${await inv(x.b.pid)}`);
    // 남은 로트(L2 1 + L3 8 = 9)보다 많이 늘리면 409
    const over = await api('PATCH', `/api/sales/${x.saleId}`, { reason: '수량 정정', changes: { quantity: 24 } });
    check(over.status === 409 && over.json.code === 'STOCK_SHORT' && over.json.detail.max_qty === 23, `${over.status} ${J(over.json)}`);
  });

  await ac('AC-19', 'AC-02 매출 판매일을 10/03 으로 → 409 DATE_BEFORE_PURCHASE (10/06 은 200)', async () => {
    const x = await makeAc02();
    const r = await api('PATCH', `/api/sales/${x.saleId}`, { reason: '날짜', changes: { sale_date: '2026-10-03' } });
    check(r.status === 409 && r.json.code === 'DATE_BEFORE_PURCHASE' && r.json.detail.min_sale_date === D2, `${r.status} ${J(r.json)}`);
    const ok = await api('PATCH', `/api/sales/${x.saleId}`, { reason: '날짜', changes: { sale_date: '2026-10-06' } });
    check(ok.status === 200, `${ok.status} ${J(ok.json)}`);
  });

  await ac('AC-20', 'AC-02 뒤 L1 취소 → 409 PURCHASE_HAS_SALES / L1 수량 9 → 409 QTY_BELOW_ALLOCATED', async () => {
    const x = await makeAc02();
    const a = await api('POST', `/api/purchases/${x.b.L1}/cancel`, { reason: '시험' });
    const c = await api('PATCH', `/api/purchases/${x.b.L1}`, { reason: '시험', changes: { quantity: 9 } });
    check(a.status === 409 && a.json.code === 'PURCHASE_HAS_SALES', `${a.status} ${J(a.json)}`);
    check(c.status === 409 && c.json.code === 'QTY_BELOW_ALLOCATED', `${c.status} ${J(c.json)}`);
  });

  await ac('AC-21', 'AC-02 뒤 재고현황 경과일 기준일 = 10/05, 대시보드 오래된 재고와 같음', async () => {
    const x = AC02 || (await makeAc02());
    const iv = await api('GET', '/api/inventory');
    const row = iv.json.data.find((r) => r.product_id === x.b.pid);
    check(row && row.aging_base_date === D2, J(row));
    check(num(row.sellable_qty) === 11 && num(row.unlinked_qty) === 0, J(row));
    // 판매 가능 로트 중 가장 오래된 매입일도 10/05
    const v = await q(`SELECT to_char(MIN(purchase_date),'YYYY-MM-DD') d FROM inventory_lot_available WHERE user_id = $1 AND product_id = $2 AND available > 0`, [USER_ID, x.b.pid]);
    check(v[0].d === D2, J(v));
    const db = await api('GET', '/api/dashboard');
    const it = (db.json?.data?.stale_inventory?.items || []).find((r) => r.product_id === x.b.pid);
    if (it) check(it.aging_base_date === D2, `대시보드 ${J(it)}`);
    return it ? '대시보드 목록에서도 10/05' : '대시보드 목록 상위 N 밖 — 같은 SQL 식이라 재고현황 값으로 확인';
  });

  await ac('AC-22', '기존 전환(L3 지정)은 그대로, entry_mode=convert', async () => {
    const b = await base();
    const cv = await api('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: b.L3, partner_id: CUS, quantity: 3, unit_price: 1500, sale_date: TODAY }] });
    check(cv.status === 201, `${cv.status} ${J(cv.json)}`);
    const sid = cv.json.data[0].sale_id;
    const row = (await q(`SELECT entry_mode FROM sale WHERE id = $1`, [sid]))[0];
    check(row.entry_mode === 'convert' && sameAlloc(await allocs(sid), [{ purchase_id: b.L3, q: 3 }]), J(row));
    const list = await api('GET', `/api/sales?from_date=${TODAY}&to_date=${TODAY}&partner_id=${CUS}`);
    const lr = list.json.data.find((s) => s.id === sid);
    check(lr && lr.entry_mode === 'convert' && lr.allocation_count === 1, J(lr));
  });

  await ac('AC-23', '미리보기 12개 = AC-02 저장 결과(배분·원가), DB 변화 없음', async () => {
    const b = await base();
    const before = await snapshot(b.pid);
    const pv = await api('GET', `/api/inventory/${b.pid}/fifo-preview?quantity=12&unit_price=1500&sale_date=${TODAY}`);
    check(pv.status === 200, `${pv.status} ${J(pv.json)}`);
    const d = pv.json.data;
    check((await snapshot(b.pid)) === before, '미리보기가 DB를 바꿈');
    check(d.enough === true && d.sellable_qty === 23 && d.cost === 12400 && d.profit === 5600 && d.sale_amount === 18000 && d.margin_pct === 31.1 && d.avg_cost === 1033.33, J(d));
    check(J(d.allocations.map((x) => [x.purchase_id, x.quantity, x.unit_cost, x.cost])) === J([[b.L1, 10, 1000, 10000], [b.L2, 2, 1200, 2400]]), J(d.allocations));
    check(d.allocations[0].partner_name === 'T205 K농산' && d.allocations[0].source_name === '해남', J(d.allocations[0]));
    const r = await sell([{ product_id: b.pid, quantity: 12, unit_price: 1500 }]);
    const s = r.json.data.sales[0];
    check(s.cost === d.cost && s.profit === d.profit && J(s.allocations.map((x) => [x.purchase_id, x.quantity])) === J(d.allocations.map((x) => [x.purchase_id, x.quantity])), '저장 결과와 다름');
    // 부족할 때: enough false, short_qty
    const pv2 = await api('GET', `/api/inventory/${b.pid}/fifo-preview?quantity=20&unit_price=1500`);
    check(pv2.json.data.enough === false && pv2.json.data.short_qty === 9 && pv2.json.data.sellable_qty === 11, J(pv2.json.data));
    const bad = await api('GET', `/api/inventory/${b.pid}/fifo-preview?quantity=0`);
    const nf = await api('GET', `/api/inventory/99999999/fifo-preview?quantity=1`);
    check(bad.status === 400 && nf.status === 404, `${bad.status}/${nf.status}`);
  });

  await ac('AC-25', '015 를 한 번 더 실행해도 오류 없음(뷰·칸·제약 그대로)', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '015_fifo_sale.sql'), 'utf8');
    await pool.query(sql);
    await pool.query(sql);
    const c = await q(`SELECT COUNT(*)::int c FROM pg_constraint WHERE conname = 'sale_entry_mode_valid'`);
    check(c[0].c === 1, '제약 개수');
    let rejected = false;
    try { await pool.query(`UPDATE sale SET entry_mode = 'bad' WHERE id = (SELECT MIN(id) FROM sale)`); } catch (e) { rejected = e.code === '23514'; }
    check(rejected, 'CHECK 가 막지 않음');
  });

  await ac('EX-1', '같은 상품을 한 주문에 두 번(10 + 5) → 두 번째는 L1 다음 로트부터', async () => {
    const b = await base();
    const r = await sell([{ product_id: b.pid, quantity: 10, unit_price: 1500 }, { product_id: b.pid, quantity: 5, unit_price: 1600 }]);
    check(r.status === 201 && r.json.data.sales.length === 2, `${r.status} ${J(r.json)}`);
    check(sameAlloc(await allocs(r.json.data.sales[0].sale_id), [{ purchase_id: b.L1, q: 10 }]), 'first');
    check(sameAlloc(await allocs(r.json.data.sales[1].sale_id), [{ purchase_id: b.L2, q: 5 }]), J(await allocs(r.json.data.sales[1].sale_id)));
    check((await inv(b.pid)) === 8, `재고 ${await inv(b.pid)}`);
  });

  await ac('EX-2', '입력 검사: items 없음·21개·수량 0·판매일 형식 → 400 VALIDATION', async () => {
    const b = await base();
    const a = await api('POST', '/api/sales', { partner_id: CUS, items: [] });
    const many = Array.from({ length: 21 }, () => ({ product_id: b.pid, quantity: 1, unit_price: 1 }));
    const c = await api('POST', '/api/sales', { partner_id: CUS, items: many });
    const d = await api('POST', '/api/sales', { partner_id: CUS, items: [{ product_id: b.pid, quantity: 0, unit_price: 1 }] });
    const e = await api('POST', '/api/sales', { partner_id: CUS, sale_date: '2026-13-01', items: [{ product_id: b.pid, quantity: 1, unit_price: 1 }] });
    check([a, c, d, e].every((x) => x.status === 400 && x.json.code === 'VALIDATION'), [a, c, d, e].map((x) => x.status).join('/'));
    check(d.json.detail.field === 'items[0].quantity', J(d.json));
    const saved = TOKEN; TOKEN = '';
    const u = await api('POST', '/api/sales', { partner_id: CUS, items: [{ product_id: b.pid, quantity: 1, unit_price: 1 }] });
    const u2 = await api('GET', `/api/inventory/${b.pid}/fifo-preview?quantity=1`);
    TOKEN = saved;
    check(u.status === 401 && u2.status === 401, `${u.status}/${u2.status}`);
  });

  await ac('EX-3', '소수 수량(2.5 + 경계) — NUMERIC 그대로 배분', async () => {
    const pid = await newProduct();
    const L1 = await purchase(pid, 1.25, 1000, D1);
    const L2 = await purchase(pid, 2.5, 1200, D2);
    const r = await sell([{ product_id: pid, quantity: 2.5, unit_price: 1500 }]);
    check(r.status === 201, `${r.status} ${J(r.json)}`);
    check(sameAlloc(await allocs(r.json.data.sales[0].sale_id), [{ purchase_id: L1, q: 1.25 }, { purchase_id: L2, q: 1.25 }]), J(await allocs(r.json.data.sales[0].sale_id)));
    check(r.json.data.sales[0].cost === 2750 && (await inv(pid)) === 1.25, J(r.json.data.sales[0]));
  });

  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\n[fifo] 결과: PASS ${pass} / FAIL ${fail} (총 ${results.length})`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error('[fifo] 실행 오류:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
