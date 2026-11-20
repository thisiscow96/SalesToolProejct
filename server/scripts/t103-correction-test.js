/**
 * T-103 매입·매출 정정(수정·취소) 인수 조건 자동 테스트 — AC-01 ~ AC-30 (AC-31·32 는 스모크·시나리오·마이그레이션 재실행으로 따로 확인)
 * - 설계: AI 팀 산출물 T-103_정정_설계.md 11장
 * - 전제: 테스트 DB(마이그레이션 010까지) + seed-admin, 서버 기동
 * - 실행: DATABASE_URL=… SMOKE_API_BASE=http://127.0.0.1:3473 node scripts/t103-correction-test.js
 * - 운영 DB에서 실행하지 않는다(테스트용 상품·거래처를 만든다). DATABASE_URL 에 127.0.0.1/localhost 가 아니면 멈춘다.
 * 각 AC 는 자기 상품을 새로 만들어 서로 영향을 주지 않는다.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { getPgConfig } = require('../lib/db-config');

const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const AGENT = 'admin001';
const PW = process.env.SEED_ADMIN_PASSWORD || 'sample';

const cfg = getPgConfig();
if (!/^(127\.0\.0\.1|localhost)$/.test(String(cfg.host || ''))) {
  console.error('[t103] 로컬 테스트 DB가 아닙니다. 멈춥니다. host =', cfg.host);
  process.exit(2);
}
const pool = new Pool(cfg);
let TOKEN = '';
let USER_ID = 0;
let SUP = 0;
let SUP2 = 0;
let CUS = 0;
const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
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

let seq = 0;
async function newProduct() {
  seq += 1;
  const r = await q(`INSERT INTO product (name, unit) VALUES ($1, 'kg') RETURNING id`, [`T103상품${Date.now()}_${seq}`]);
  return r[0].id;
}
async function inv(pid) {
  const r = await q(`SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2`, [USER_ID, pid]);
  return num(r[0]?.quantity ?? 0);
}
async function purchase(pid, qty, price = 100) {
  const r = await api('POST', '/api/purchases', { partner_id: SUP, product_id: pid, quantity: qty, unit_price: price, purchase_date: TODAY });
  if (r.status !== 201) throw new Error('매입 등록 실패 ' + JSON.stringify(r.json));
  return r.json.data.id;
}
async function convert(purchaseId, qty, price = 100) {
  const r = await api('POST', '/api/purchases/convert-to-sales', {
    items: [{ purchase_id: purchaseId, partner_id: CUS, quantity: qty, unit_price: price, sale_date: TODAY }],
  });
  if (r.status !== 201) throw new Error('전환 실패 ' + JSON.stringify(r.json));
  return r.json.data[0].sale_id;
}
async function pay(saleId, amount) {
  return api('POST', '/api/payments', { partner_id: CUS, amount, paid_at: TODAY, allocations: [{ sale_id: saleId, amount }] });
}
async function remaining(purchaseId) {
  const r = await q(
    `SELECT (pu.quantity - COALESCE((SELECT SUM(quantity) FROM purchase_allocation WHERE purchase_id = pu.id),0))::numeric AS r FROM purchase pu WHERE id = $1`,
    [purchaseId]
  );
  return num(r[0].r);
}
async function updatedAt(table, id) {
  const r = await q(`SELECT updated_at FROM ${table} WHERE id = $1`, [id]);
  return new Date(r[0].updated_at).toISOString();
}
/** 방향 기준 원장 대조(4장 끝): 재고 = Σ(to=inventory) − Σ(from=inventory) */
async function ledgerDiff(pid) {
  const r = await q(
    `SELECT COALESCE(SUM(CASE WHEN to_type='inventory' THEN quantity ELSE 0 END),0) - COALESCE(SUM(CASE WHEN from_type='inventory' THEN quantity ELSE 0 END),0) AS l
     FROM product_transfer WHERE user_id = $1 AND product_id = $2`,
    [USER_ID, pid]
  );
  return num(r[0].l) - (await inv(pid));
}
const snapshot = async (pid) => JSON.stringify({
  inv: await inv(pid),
  pt: (await q(`SELECT COUNT(*)::int c FROM product_transfer WHERE product_id = $1`, [pid]))[0].c,
  tc: (await q(`SELECT COUNT(*)::int c FROM trade_correction`))[0].c,
  pa: (await q(`SELECT COALESCE(SUM(pa.quantity),0)::numeric s FROM purchase_allocation pa JOIN purchase pu ON pu.id = pa.purchase_id WHERE pu.product_id = $1`, [pid]))[0].s,
});

function check(cond, msg) {
  if (!cond) throw new Error(msg);
}

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
  SUP = (await q(`INSERT INTO account (user_id, name, type, location) VALUES ($1, 'T103 공급처', 'supplier', '가락 1동') RETURNING id`, [USER_ID]))[0].id;
  SUP2 = (await q(`INSERT INTO account (user_id, name, type, location) VALUES ($1, 'T103 공급처2', 'supplier', '가락 2동') RETURNING id`, [USER_ID]))[0].id;
  CUS = (await q(`INSERT INTO account (user_id, name, type, location) VALUES ($1, 'T103 판매처', 'customer', '서울') RETURNING id`, [USER_ID]))[0].id;
}

async function main() {
  await setup();

  // ---------------- 매입 ----------------
  let P01; let X01;
  await ac('AC-01', '미전환 매입 취소 → 재고·이동·정정 이력', async () => {
    X01 = await newProduct();
    P01 = await purchase(X01, 20);
    check((await inv(X01)) === 20, '재고 20 아님');
    const r = await api('POST', `/api/purchases/${P01}/cancel`, { reason: '오입력', expected_updated_at: await updatedAt('purchase', P01) });
    check(r.status === 200, `status ${r.status} ${JSON.stringify(r.json)}`);
    const p = (await q(`SELECT status, cancelled_at, cancel_reason FROM purchase WHERE id = $1`, [P01]))[0];
    check(p.status === 'cancelled' && p.cancelled_at && p.cancel_reason === '오입력', '상태 저장 안 됨');
    check((await inv(X01)) === 0, '재고 0 아님');
    const t = await q(`SELECT * FROM product_transfer WHERE purchase_id = $1 AND action_type = 'purchase_cancel'`, [P01]);
    check(t.length === 1 && num(t[0].quantity) === 20 && t[0].from_type === 'inventory' && t[0].to_type === 'supplier' && t[0].to_partner_id === SUP, '이동 이력 이상');
    const c = await q(`SELECT * FROM trade_correction WHERE target_type='purchase' AND target_id = $1 AND action='cancel'`, [P01]);
    check(c.length === 1 && c[0].reason === '오입력', '정정 이력 이상');
    check((await ledgerDiff(X01)) === 0, '원장 불일치');
    return `재고 20→0, purchase_cancel 1건, trade_correction 1건, inventory_qty_after=${r.json.data.inventory_qty_after}`;
  });

  await ac('AC-02', '취소 매입은 목록에 취소로, 집계·마지막 매입에서 제외', async () => {
    const l = await api('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}&product_id=${X01}`);
    const row = l.json.data.find((x) => x.id === P01);
    check(row && row.status === 'cancelled' && row.cancel_reason === '오입력' && row.updated_at, '목록 상태 없음');
    // 다른 활성 매입과 비교 — 같은 날 활성 매입 1건 추가 후 집계에서 취소분이 빠지는지
    const before = await api('GET', `/api/reports/daily-purchase-sales?from_date=${TODAY}&to_date=${TODAY}&partner_id=${SUP}`);
    const sumDb = (await q(`SELECT COALESCE(SUM(total_amount),0)::numeric s, COUNT(*)::int c FROM purchase WHERE user_id=$1 AND partner_id=$2 AND purchase_date=$3 AND status='active'`, [USER_ID, SUP, TODAY]))[0];
    const d = before.json.data[0];
    check(num(d.purchase_amount) === num(sumDb.s) && d.purchase_count === sumDb.c, `일별 집계에 취소 포함 (${d.purchase_amount}/${d.purchase_count} vs ${sumDb.s}/${sumDb.c})`);
    const br = await api('GET', `/api/reports/daily-purchase-sales-breakdown?from_date=${TODAY}&to_date=${TODAY}`);
    check(!br.json.data.some((x) => x.product_id === X01 && x.line_kind === 'purchase'), '상세 집계에 취소 매입 포함');
    // 마지막 매입: 재고 행이 남도록 다른 공급처로 같은 상품 매입(어제 날짜) → 마지막 매입처는 공급처2여야 함
    const yday = new Date(Date.now() + 9 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    await api('POST', '/api/purchases', { partner_id: SUP2, product_id: X01, quantity: 3, unit_price: 10, purchase_date: yday });
    const iv = await api('GET', '/api/inventory');
    const ir = iv.json.data.find((x) => x.product_id === X01);
    check(ir && ir.last_partner_name === 'T103 공급처2', `마지막 매입에 취소 매입 사용 (${ir && ir.last_partner_name})`);
    return '목록 status=cancelled, 일별·상세 집계 제외, 마지막 매입=공급처2';
  });

  await ac('AC-03', '취소된 매입으로 전환 거절', async () => {
    const s0 = await snapshot(X01);
    const r = await api('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: P01, partner_id: CUS, quantity: 1, unit_price: 100, sale_date: TODAY }] });
    check(r.status === 400 && /취소된 매입/.test(r.json.message), `status ${r.status} ${r.json?.message}`);
    check(s0 === (await snapshot(X01)), 'DB 변화 있음');
    return `400 "${r.json.message}"`;
  });

  await ac('AC-04', '일부 전환 매입 취소 → 409 PURCHASE_HAS_SALES', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); const S = await convert(P, 5);
    const s0 = await snapshot(X);
    const r = await api('POST', `/api/purchases/${P}/cancel`, { reason: '오입력' });
    check(r.status === 409 && r.json.code === 'PURCHASE_HAS_SALES', `${r.status} ${r.json?.code}`);
    check(r.json.detail.sales.length === 1 && r.json.detail.sales[0].id === S, 'detail.sales 이상');
    check(s0 === (await snapshot(X)), 'DB 변화 있음');
    return `detail.sales=[#${S}]`;
  });

  await ac('AC-05', '전부 전환 매입 취소 → 409 PURCHASE_HAS_SALES', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); await convert(P, 20);
    const r = await api('POST', `/api/purchases/${P}/cancel`, { reason: '오입력' });
    check(r.status === 409 && r.json.code === 'PURCHASE_HAS_SALES', `${r.status} ${r.json?.code}`);
  });

  await ac('AC-06', '폐기로 재고 부족 → 409 INVENTORY_SHORT', async () => {
    const X = await newProduct(); const P = await purchase(X, 20);
    const d = await api('POST', '/api/disposals', { product_id: X, quantity: 15, disposal_date: TODAY });
    check(d.status === 201, '폐기 실패');
    const s0 = await snapshot(X);
    const r = await api('POST', `/api/purchases/${P}/cancel`, { reason: '오입력' });
    check(r.status === 409 && r.json.code === 'INVENTORY_SHORT' && r.json.detail.inventory_qty === 5 && r.json.detail.need_qty === 20, `${r.status} ${JSON.stringify(r.json)}`);
    check(s0 === (await snapshot(X)), 'DB 변화 있음');
    return 'detail {inventory_qty:5, need_qty:20}';
  });

  await ac('AC-07', '이미 취소된 매입 취소·수정 → 409 ALREADY_CANCELLED', async () => {
    const a = await api('POST', `/api/purchases/${P01}/cancel`, { reason: '중복 입력' });
    const b = await api('PATCH', `/api/purchases/${P01}`, { reason: '수정', changes: { memo: 'x' } });
    check(a.status === 409 && a.json.code === 'ALREADY_CANCELLED', `cancel ${a.status}`);
    check(b.status === 409 && b.json.code === 'ALREADY_CANCELLED', `patch ${b.status}`);
  });

  let X08; let P08;
  await ac('AC-08', '일부 전환 매입 수량 20→18', async () => {
    X08 = await newProduct(); P08 = await purchase(X08, 20, 100); await convert(P08, 5);
    check((await inv(X08)) === 15, '재고 15 아님');
    const r = await api('PATCH', `/api/purchases/${P08}`, { reason: '수량 오타', expected_updated_at: await updatedAt('purchase', P08), changes: { quantity: 18 } });
    check(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    check(num(r.json.data.quantity) === 18 && num(r.json.data.total_amount) === 1800, '수량·금액');
    check((await inv(X08)) === 13, '재고 13 아님');
    const t = await q(`SELECT * FROM product_transfer WHERE purchase_id = $1 AND action_type = 'correction'`, [P08]);
    check(t.length === 1 && num(t[0].quantity) === 2 && t[0].from_type === 'inventory' && t[0].to_type === 'supplier', '이동 이력');
    const c = await q(`SELECT changed_fields FROM trade_correction WHERE target_type='purchase' AND target_id=$1 AND action='update'`, [P08]);
    check(c.length === 1 && c[0].changed_fields.join(',') === 'quantity,total_amount', `changed_fields ${c[0]?.changed_fields}`);
    check((await ledgerDiff(X08)) === 0, '원장 불일치');
    return '수량 18·금액 1800, 재고 13, correction 2개, changed_fields={quantity,total_amount}';
  });

  await ac('AC-09', '전환 수량보다 작게 → 409 QTY_BELOW_ALLOCATED', async () => {
    const r = await api('PATCH', `/api/purchases/${P08}`, { reason: '수량', changes: { quantity: 4 } });
    check(r.status === 409 && r.json.code === 'QTY_BELOW_ALLOCATED' && r.json.detail.allocated_qty === 5, `${r.status} ${JSON.stringify(r.json)}`);
  });

  await ac('AC-10', '미전환 매입 상품 X→Y', async () => {
    const X = await newProduct(); const Y = await newProduct(); const P = await purchase(X, 20);
    const r = await api('PATCH', `/api/purchases/${P}`, { reason: '상품 잘못 고름', changes: { product_id: Y } });
    check(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    check((await inv(X)) === 0 && (await inv(Y)) === 20, '재고 이동');
    const t = await q(`SELECT * FROM product_transfer WHERE purchase_id = $1 AND action_type = 'correction'`, [P]);
    check(t.length === 2, `correction ${t.length}건`);
    check((await ledgerDiff(X)) === 0 && (await ledgerDiff(Y)) === 0, '원장 불일치');
    return '재고 X 20→0, Y 0→20, correction 2건';
  });

  await ac('AC-11', '일부 전환 매입 상품 변경 → 409 PURCHASE_HAS_SALES', async () => {
    const Y = await newProduct();
    const r = await api('PATCH', `/api/purchases/${P08}`, { reason: '상품', changes: { product_id: Y } });
    check(r.status === 409 && r.json.code === 'PURCHASE_HAS_SALES', `${r.status} ${r.json?.code}`);
  });

  await ac('AC-12', '일부 전환 매입 단가 100→120, 매출은 그대로', async () => {
    const X = await newProduct(); const P = await purchase(X, 20, 100); const S = await convert(P, 5, 300);
    const r = await api('PATCH', `/api/purchases/${P}`, { reason: '단가 정정', changes: { unit_price: 120 } });
    check(r.status === 200 && num(r.json.data.total_amount) === 2400, `${r.status} ${r.json?.data?.total_amount}`);
    const s = (await q(`SELECT unit_price, total_amount FROM sale WHERE id = $1`, [S]))[0];
    check(num(s.unit_price) === 300 && num(s.total_amount) === 1500, '매출 단가 바뀜');
    return 'total 2400, 매출 300/1500 유지';
  });

  // ---------------- 매출 ----------------
  let X13; let P13; let Q13;
  await ac('AC-13', '수금 전 매출 취소 → 재고·배분·이동·정정 이력', async () => {
    X13 = await newProduct(); P13 = await purchase(X13, 20); Q13 = await convert(P13, 5);
    check((await inv(X13)) === 15, '재고 15 아님');
    const r = await api('POST', `/api/sales/${Q13}/cancel`, { reason: '거래 취소', expected_updated_at: await updatedAt('sale', Q13) });
    check(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    check(r.json.data.purchase_id === P13 && r.json.data.purchase_remaining_qty_after === 20 && r.json.data.inventory_qty_after === 20, '응답 data');
    const s = (await q(`SELECT status, cancelled_at FROM sale WHERE id = $1`, [Q13]))[0];
    check(s.status === 'cancelled' && s.cancelled_at, '상태');
    check((await q(`SELECT 1 FROM purchase_allocation WHERE sale_id = $1`, [Q13])).length === 0, '배분 남음');
    check((await remaining(P13)) === 20 && (await inv(X13)) === 20, '잔여·재고');
    const t = await q(`SELECT * FROM product_transfer WHERE sale_id = $1 AND action_type = 'sale_cancel'`, [Q13]);
    check(t.length === 1 && num(t[0].quantity) === 5 && t[0].from_type === 'customer' && t[0].to_type === 'inventory' && t[0].purchase_id === P13, '이동 이력');
    const c = await q(`SELECT before_data FROM trade_correction WHERE target_type='sale' AND target_id=$1 AND action='cancel'`, [Q13]);
    check(c.length === 1 && Array.isArray(c[0].before_data.allocations) && c[0].before_data.allocations.length === 1, 'before_data.allocations');
    check((await ledgerDiff(X13)) === 0, '원장 불일치');
    return 'P 잔여 20, 재고 20, sale_cancel 1건, before_data.allocations 1행';
  });

  await ac('AC-14', '취소 매출은 미수·집계에서 빠지고 수금·반품 거절', async () => {
    const un = await api('GET', '/api/sales?unpaid_only=1');
    check(!un.json.data.some((x) => x.id === Q13), '미수 목록에 있음');
    const br = await api('GET', `/api/reports/daily-purchase-sales-breakdown?from_date=${TODAY}&to_date=${TODAY}`);
    check(!br.json.data.some((x) => x.product_id === X13 && x.line_kind === 'sale'), '집계에 있음');
    const p = await pay(Q13, 100);
    check(p.status === 400 && /취소/.test(p.json.message), `수금 ${p.status} ${p.json?.message}`);
    const rf = await api('POST', `/api/sales/${Q13}/refund`, { quantity: 1, refunded_at: TODAY });
    check(rf.status === 400 && /이미 취소된 매출/.test(rf.json.message), `반품 ${rf.status}`);
    return `수금 400, 반품 400 "${rf.json.message}"`;
  });

  await ac('AC-15', '매출 취소 → 매입 취소 순서', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); const Q = await convert(P, 7);
    const a = await api('POST', `/api/sales/${Q}/cancel`, { reason: '오입력' });
    const b = await api('POST', `/api/purchases/${P}/cancel`, { reason: '오입력' });
    check(a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
    check((await inv(X)) === 0 && (await ledgerDiff(X)) === 0, '재고·원장');
    return '둘 다 200, 재고 0, 원장 불일치 0';
  });

  let X16; let P16;
  await ac('AC-16', '일부 수금 매출 취소 → 409 SALE_HAS_PAYMENT', async () => {
    X16 = await newProduct(); P16 = await purchase(X16, 20); const Q = await convert(P16, 5); // 500원
    check((await pay(Q, 200)).status === 201, '수금 실패');
    const s0 = await snapshot(X16);
    const r = await api('POST', `/api/sales/${Q}/cancel`, { reason: '오입력' });
    check(r.status === 409 && r.json.code === 'SALE_HAS_PAYMENT' && r.json.detail.paid_amount === 200, `${r.status} ${JSON.stringify(r.json)}`);
    check(s0 === (await snapshot(X16)), 'DB 변화');
  });

  await ac('AC-17', '전부 수금 매출 취소 → 409 SALE_HAS_PAYMENT', async () => {
    const Q = await convert(P16, 5);
    check((await pay(Q, 500)).status === 201, '수금 실패');
    const r = await api('POST', `/api/sales/${Q}/cancel`, { reason: '오입력' });
    check(r.status === 409 && r.json.code === 'SALE_HAS_PAYMENT', `${r.status} ${r.json?.code}`);
  });

  await ac('AC-18', '반품 이력 매출 취소 → 409 SALE_HAS_REFUND', async () => {
    const Q = await convert(P16, 5);
    const rf = await api('POST', `/api/sales/${Q}/refund`, { quantity: 2, refunded_at: TODAY });
    check(rf.status === 201, `반품 ${rf.status}`);
    const r = await api('POST', `/api/sales/${Q}/cancel`, { reason: '오입력' });
    check(r.status === 409 && r.json.code === 'SALE_HAS_REFUND' && r.json.detail.refunded_qty === 2, `${r.status} ${JSON.stringify(r.json)}`);
    const m = await api('PATCH', `/api/sales/${Q}`, { reason: '메모', changes: { memo: '반품 후 메모' } });
    const u = await api('PATCH', `/api/sales/${Q}`, { reason: '단가', changes: { unit_price: 90 } });
    check(m.status === 200 && u.status === 409 && u.json.code === 'SALE_HAS_REFUND', `메모 ${m.status} 단가 ${u.status}`);
    return '취소 409, 메모 수정 200, 단가 수정 409';
  });

  await ac('AC-19', '이미 취소된 매출 취소·수정 → 409 ALREADY_CANCELLED', async () => {
    const a = await api('POST', `/api/sales/${Q13}/cancel`, { reason: '중복' });
    const b = await api('PATCH', `/api/sales/${Q13}`, { reason: '수정', changes: { memo: 'x' } });
    check(a.status === 409 && a.json.code === 'ALREADY_CANCELLED' && b.status === 409 && b.json.code === 'ALREADY_CANCELLED', `${a.status}/${b.status}`);
  });

  let X20; let P20; let Q20;
  await ac('AC-20', '매출 수량 5→8', async () => {
    X20 = await newProduct(); P20 = await purchase(X20, 20); Q20 = await convert(P20, 5);
    const r = await api('PATCH', `/api/sales/${Q20}`, { reason: '수량 오타', expected_updated_at: await updatedAt('sale', Q20), changes: { quantity: 8 } });
    check(r.status === 200 && num(r.json.data.quantity) === 8 && num(r.json.data.total_amount) === 800, `${r.status} ${JSON.stringify(r.json)}`);
    const a = await q(`SELECT quantity FROM purchase_allocation WHERE sale_id = $1`, [Q20]);
    check(num(a[0].quantity) === 8 && (await remaining(P20)) === 12 && (await inv(X20)) === 12, '배분·잔여·재고');
    const t = await q(`SELECT * FROM product_transfer WHERE sale_id = $1 AND action_type = 'correction'`, [Q20]);
    check(t.length === 1 && num(t[0].quantity) === 3 && t[0].from_type === 'inventory' && t[0].to_type === 'customer', '이동 이력');
    check((await ledgerDiff(X20)) === 0, '원장');
    return '배분 8, P 잔여 12, 재고 12, correction 3개';
  });

  await ac('AC-21', '매출 수량 8→3 (AC-20 이어서, 설계 Given 5→3 과 같은 방향)', async () => {
    const r = await api('PATCH', `/api/sales/${Q20}`, { reason: '수량 오타', changes: { quantity: 3 } });
    check(r.status === 200, `${r.status}`);
    const a = await q(`SELECT quantity FROM purchase_allocation WHERE sale_id = $1`, [Q20]);
    check(num(a[0].quantity) === 3 && (await remaining(P20)) === 17 && (await inv(X20)) === 17, '배분·잔여·재고');
    const t = await q(`SELECT * FROM product_transfer WHERE sale_id = $1 AND action_type = 'correction' ORDER BY id DESC LIMIT 1`, [Q20]);
    check(num(t[0].quantity) === 5 && t[0].from_type === 'customer' && t[0].to_type === 'inventory', '이동 이력');
    check((await ledgerDiff(X20)) === 0, '원장');
    return '배분 3, P 잔여 17, 재고 17, correction customer→inventory';
  });

  await ac('AC-21b', '매출 수량 5→3 (설계 Given 그대로)', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); const Q = await convert(P, 5);
    const r = await api('PATCH', `/api/sales/${Q}`, { reason: '수량', changes: { quantity: 3 } });
    check(r.status === 200 && (await remaining(P)) === 17 && (await inv(X)) === 17, `${r.status}`);
    const t = await q(`SELECT quantity FROM product_transfer WHERE sale_id = $1 AND action_type = 'correction'`, [Q]);
    check(t.length === 1 && num(t[0].quantity) === 2, 'correction 2개');
    return '배분 3, P 잔여 17, 재고 17, correction 2개';
  });

  await ac('AC-22', '매입 잔여 초과 → 409 QTY_OVER_PURCHASE(max 7)', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); const Q = await convert(P, 5); await convert(P, 13); // 잔여 2
    const r = await api('PATCH', `/api/sales/${Q}`, { reason: '수량', changes: { quantity: 8 } });
    check(r.status === 409 && r.json.code === 'QTY_OVER_PURCHASE' && r.json.detail.max_qty === 7, `${r.status} ${JSON.stringify(r.json)}`);
  });

  await ac('AC-23', '재고 부족(폐기) → 409 INVENTORY_SHORT', async () => {
    const X = await newProduct(); const P = await purchase(X, 15); const Q = await convert(P, 5); // 잔여 10, 재고 10
    await api('POST', '/api/disposals', { product_id: X, quantity: 9, disposal_date: TODAY }); // 재고 1
    const r = await api('PATCH', `/api/sales/${Q}`, { reason: '수량', changes: { quantity: 8 } });
    check(r.status === 409 && r.json.code === 'INVENTORY_SHORT', `${r.status} ${JSON.stringify(r.json)}`);
  });

  await ac('AC-24', '일부 수금 매출: 금액·수량·판매처 409, 판매일·메모 200', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); const Q = await convert(P, 5);
    await pay(Q, 200);
    const cus2 = (await q(`INSERT INTO account (user_id, name, type) VALUES ($1, 'T103 판매처2', 'customer') RETURNING id`, [USER_ID]))[0].id;
    const a = await api('PATCH', `/api/sales/${Q}`, { reason: 'x', changes: { unit_price: 120 } });
    const b = await api('PATCH', `/api/sales/${Q}`, { reason: 'x', changes: { quantity: 6 } });
    const c = await api('PATCH', `/api/sales/${Q}`, { reason: 'x', changes: { partner_id: cus2 } });
    const yday = new Date(Date.now() + 9 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
    const d = await api('PATCH', `/api/sales/${Q}`, { reason: '날짜 정정', changes: { sale_date: yday, memo: '메모' } });
    check([a, b, c].every((x) => x.status === 409 && x.json.code === 'SALE_HAS_PAYMENT'), `${a.status}/${b.status}/${c.status}`);
    check(d.status === 200 && String(d.json.data.memo) === '메모', `날짜·메모 ${d.status} ${JSON.stringify(d.json)}`);
    const s = (await q(`SELECT sale_date::text d FROM sale WHERE id = $1`, [Q]))[0];
    check(s.d === yday, `sale_date ${s.d}`);
    return '단가·수량·판매처 409, 판매일·메모 200';
  });

  await ac('AC-25', '판매처를 매출 불가 유형으로 → 400 VALIDATION', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); const Q = await convert(P, 5);
    const r = await api('PATCH', `/api/sales/${Q}`, { reason: 'x', changes: { partner_id: SUP } });
    check(r.status === 400 && r.json.code === 'VALIDATION' && r.json.detail.field === 'partner_id', `${r.status} ${JSON.stringify(r.json)}`);
  });

  await ac('AC-26', '사유 없이 정정 → 400 VALIDATION(field=reason)', async () => {
    const X = await newProduct(); const P = await purchase(X, 20); const Q = await convert(P, 5);
    const rs = [
      await api('POST', `/api/purchases/${P}/cancel`, {}),
      await api('PATCH', `/api/purchases/${P}`, { reason: '  ', changes: { memo: 'a' } }),
      await api('POST', `/api/sales/${Q}/cancel`, { reason: '' }),
      await api('PATCH', `/api/sales/${Q}`, { changes: { memo: 'a' } }),
    ];
    check(rs.every((r) => r.status === 400 && r.json.code === 'VALIDATION' && r.json.detail.field === 'reason'), rs.map((r) => r.status).join('/'));
    return '4개 API 모두 400 field=reason';
  });

  await ac('AC-27', '옛 expected_updated_at → 409 STALE_DATA, A 결과 유지', async () => {
    const X = await newProduct(); const P = await purchase(X, 20);
    const seen = await updatedAt('purchase', P);
    await new Promise((r) => setTimeout(r, 5));
    const A = await api('PATCH', `/api/purchases/${P}`, { reason: 'A', expected_updated_at: seen, changes: { memo: 'A가 고침' } });
    const B = await api('PATCH', `/api/purchases/${P}`, { reason: 'B', expected_updated_at: seen, changes: { memo: 'B가 고침' } });
    check(A.status === 200 && B.status === 409 && B.json.code === 'STALE_DATA', `${A.status}/${B.status}`);
    const m = (await q(`SELECT memo FROM purchase WHERE id = $1`, [P]))[0].memo;
    check(m === 'A가 고침', 'A 결과 안 남음');
    // 매출 취소도 같은 방식
    const Q = await convert(P, 1);
    const seenS = await updatedAt('sale', Q);
    await new Promise((r) => setTimeout(r, 5));
    await api('PATCH', `/api/sales/${Q}`, { reason: 'A', changes: { memo: 'A' } });
    const C = await api('POST', `/api/sales/${Q}/cancel`, { reason: 'B', expected_updated_at: seenS });
    check(C.status === 409 && C.json.code === 'STALE_DATA', `sale cancel ${C.status}`);
    return '매입 수정 B 409, 매출 취소 409, A 결과 유지';
  });

  // ---------------- 동시성 ----------------
  await ac('AC-28', '매출 취소 vs 수금 동시 20회', async () => {
    const X = await newProduct(); const P = await purchase(X, 40);
    let both = 0; let none = 0; let five = 0;
    for (let i = 0; i < 20; i += 1) {
      const Q = await convert(P, 1);
      const [c, p] = await Promise.all([api('POST', `/api/sales/${Q}/cancel`, { reason: '동시성' }), pay(Q, 50)]);
      const ok = (c.status === 200 ? 1 : 0) + (p.status === 201 ? 1 : 0);
      if (ok === 2) both += 1; if (ok === 0) none += 1;
      if (c.status >= 500 || p.status >= 500) five += 1;
    }
    const bad = await q(`SELECT COUNT(*)::int c FROM sale WHERE status = 'cancelled' AND paid_amount > 0`);
    check(both === 0 && none === 0 && five === 0 && bad[0].c === 0, `둘다성공 ${both}, 둘다실패 ${none}, 5xx ${five}, cancelled+paid ${bad[0].c}`);
    check((await ledgerDiff(X)) === 0, '원장');
    return '20회 모두 하나만 성공, 5xx 0, cancelled+paid 0';
  });

  await ac('AC-29', '매입 취소 vs 전환 동시 20회', async () => {
    let both = 0; let none = 0; let dead = 0;
    for (let i = 0; i < 20; i += 1) {
      const X = await newProduct(); const P = await purchase(X, 10);
      const [c, v] = await Promise.all([
        api('POST', `/api/purchases/${P}/cancel`, { reason: '동시성' }),
        api('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: P, partner_id: CUS, quantity: 2, unit_price: 100, sale_date: TODAY }] }),
      ]);
      const ok = (c.status === 200 ? 1 : 0) + (v.status === 201 ? 1 : 0);
      if (ok === 2) both += 1; if (ok === 0) none += 1;
      if (c.status >= 500 || v.status >= 500) dead += 1;
    }
    const bad = await q(`SELECT COUNT(*)::int c FROM purchase pu WHERE pu.status = 'cancelled' AND EXISTS (SELECT 1 FROM purchase_allocation pa WHERE pa.purchase_id = pu.id)`);
    check(both === 0 && none === 0 && dead === 0 && bad[0].c === 0, `둘다 ${both}, 없음 ${none}, 5xx ${dead}, cancelled+배분 ${bad[0].c}`);
    return '20회 모두 하나만 성공, 5xx(deadlock 포함) 0, cancelled+배분 0';
  });

  await ac('AC-30', '매출 취소 + [P2,P1] 순서 전환 동시 20회 → deadlock 0', async () => {
    let five = 0; let fails = 0;
    for (let i = 0; i < 20; i += 1) {
      const X = await newProduct(); const P1 = await purchase(X, 10); const P2 = await purchase(X, 10);
      const Q1 = await convert(P1, 2); await convert(P2, 2);
      const [c, v] = await Promise.all([
        api('POST', `/api/sales/${Q1}/cancel`, { reason: '동시성' }),
        api('POST', '/api/purchases/convert-to-sales', { items: [
          { purchase_id: P2, partner_id: CUS, quantity: 1, unit_price: 100, sale_date: TODAY },
          { purchase_id: P1, partner_id: CUS, quantity: 1, unit_price: 100, sale_date: TODAY },
        ] }),
      ]);
      if (c.status >= 500 || v.status >= 500) five += 1;
      if (c.status !== 200 || v.status !== 201) fails += 1;
      if ((await ledgerDiff(X)) !== 0) fails += 100;
    }
    check(five === 0 && fails === 0, `5xx ${five}, 실패 ${fails}`);
    return '20회 둘 다 성공, 5xx 0, 원장 불일치 0';
  });

  // ---------------- 추가 확인 ----------------
  await ac('EX-01', '남의/없는 ID → 404 NOT_FOUND, 잘못된 칸 → 400', async () => {
    const a = await api('POST', '/api/purchases/99999999/cancel', { reason: 'x' });
    const b = await api('PATCH', '/api/sales/99999999', { reason: 'x', changes: { memo: 'a' } });
    const X = await newProduct(); const P = await purchase(X, 3); const Q = await convert(P, 1);
    const c = await api('PATCH', `/api/sales/${Q}`, { reason: 'x', changes: { product_id: X } });
    const d = await api('PATCH', `/api/purchases/${P}`, { reason: 'x', changes: {} });
    const e = await api('PATCH', `/api/purchases/${P}`, { reason: 'x', changes: { purchase_date: '2026-02-30' } });
    check(a.status === 404 && a.json.code === 'NOT_FOUND' && b.status === 404, `${a.status}/${b.status}`);
    check(c.status === 400 && d.status === 400 && e.status === 400, `${c.status}/${d.status}/${e.status}`);
    return '404·400 확인';
  });

  await ac('EX-02', '정정 이력 API(W-09)', async () => {
    const r = await api('GET', `/api/corrections?target_type=purchase&target_id=${P08}`);
    check(r.status === 200 && r.json.data.length === 1 && r.json.data[0].action === 'update', `${r.status}`);
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[t103] ${pass}/${results.length} 통과`);
  console.log('JSON_RESULT ' + JSON.stringify(results));
  await pool.end();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[t103] 오류', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
