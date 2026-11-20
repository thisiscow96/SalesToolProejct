/**
 * T-208 첫 화면 대시보드 GET /api/dashboard 검사
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> DASHBOARD_API_BASE=http://127.0.0.1:<포트> node scripts/dashboard-test.js
 * 전제: 마이그레이션 001~012, seed-admin(admin001 — 상품 등록용, 비밀번호 SMOKE_PASSWORD 또는 sample), 서버 기동.
 * 테스트 DB 전용 — 회원 A·B(t208a_/t208b_<태그>)를 DB에 직접 만들고, 거래는 API로 만든다.
 *
 * 검사 두 가지
 *  1) 손계산 기대값: 아래 시나리오로 직접 계산한 숫자와 같은가
 *  2) 목록·원장과 일치: 같은 숫자를 매입정보·매출정보·수금정보·일별 보고서·미수 연령·원장·재고현황 API로 다시 구해 같은가
 * 날짜는 모두 "실행일(KST 오늘) − n일"로 만들어 어느 날 돌려도 같은 결과가 나온다.
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.DASHBOARD_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[dashboard-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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
  if (r.status >= 300 || !r.json?.ok) throw new Error(`${what} 실패 status=${r.status} ${r.json?.message || ''}`);
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
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const sum = (arr, f) => arr.reduce((s, x) => s + Number(f(x)), 0);

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
  const A = await mkUser('t208a');
  const B = await mkUser('t208b');
  const dash = async (token) => request('GET', '/api/dashboard', null, token);

  // ---------- 1. 빈 데이터 ----------
  let r = await dash(A);
  let d = r.json?.data;
  check(
    'E-01 거래 없는 회원: 200, 오늘 0원·0건 ×3, 총미수 0, 목록 빈 배열',
    r.status === 200 && d.as_of === TODAY &&
      ['purchases', 'sales', 'receipts'].every((k) => d.today[k].amount === 0 && d.today[k].count === 0) &&
      d.receivables.total_due === 0 && d.receivables.partner_count === 0 && d.receivables.buckets.length === 4 &&
      d.top_receivable_partners.length === 0 && d.stale_inventory.items.length === 0 &&
      d.stale_inventory.product_count === 0 && d.stale_inventory.warn_count === 0 && d.stale_inventory.danger_count === 0,
    d
  );
  r = await request('GET', '/api/dashboard', null, null);
  check('E-02 토큰 없음 → 401', r.status === 401, r.status);
  r = await request('GET', '/api/dashboard', null, 'not-a-token');
  check('E-03 위조 토큰 → 401', r.status === 401, r.status);

  // ---------- 2. 시나리오 (회원 A) ----------
  const mkProduct = async (name) => mustOk(await request('POST', '/api/products', { name: `T208-${name}-${tag}`, unit: 'kg' }, admin), `상품 ${name}`);
  const mkPartner = async (token, name, type) => mustOk(await request('POST', '/api/partners', { name: `${name}-${tag}`, type }, token), `거래처 ${name}`);
  const buy = async (token, partner, product, qty, price, date) => {
    const p = await mustOk(
      await request('POST', '/api/purchases', { partner_id: partner.id, product_id: product.id, quantity: qty, unit_price: price, purchase_date: date }, token),
      `매입 ${product.name} ${date}`
    );
    return p.id || p.purchase_id || (p[0] && p[0].id);
  };

  const E = await mkPartner(A, 'E농장', 'supplier');
  const C = {};
  for (const [k, type] of [['C1', 'customer'], ['C2', 'wholesaler'], ['C3', 'same_market'], ['C4', 'market_wholesaler'], ['C5', 'customer'], ['C6', 'customer'], ['C7', 'customer']]) {
    C[k] = await mkPartner(A, `${k}상회`, type);
  }

  // 재고 경과일용 상품: 매입일 = 오늘 − n일 (n = 0,1,3,4,7,10,15,20) + 매출용 PS(120일 전)
  const P = {};
  for (const n of [0, 1, 3, 4, 7, 10, 15, 20]) {
    P[n] = await mkProduct(`재고${n}일`);
    if (n !== 0) await buy(A, E, P[n], 10, 10, ago(n));
  }
  // 오늘 매입: P0 100×10=1,000 + 50×12=600 (+ 취소할 1건 7×10=70)
  await buy(A, E, P[0], 100, 10, TODAY);
  await buy(A, E, P[0], 50, 12, TODAY);
  const cancelPurchase = await buy(A, E, P[0], 7, 10, TODAY);
  await mustOk(await request('POST', `/api/purchases/${cancelPurchase}/cancel`, { reason: '오입력' }, A), '매입 취소');

  const PS = await mkProduct('매출용');
  const psLot = await buy(A, E, PS, 100, 50, ago(120));
  const sell = async (partner, qty, price, date) => {
    const x = await mustOk(
      await request('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: psLot, partner_id: partner.id, quantity: qty, unit_price: price, sale_date: date }] }, A),
      `매출 ${date}`
    );
    return x[0].sale_id;
  };
  const receive = async (partner, amount, paidAt, saleId) =>
    mustOk(await request('POST', '/api/payments', { partner_id: partner.id, amount, paid_at: paidAt, entry_kind: 'receive', allocations: [{ sale_id: saleId, amount }] }, A), `수금 ${paidAt}`);
  const ret = async (saleId, qty, date) =>
    mustOk(await request('POST', `/api/sales/${saleId}/refund`, { quantity: qty, refunded_at: date, reason: '테스트 반품' }, A), `반품 ${date}`);

  const s1 = await sell(C.C1, 10, 100, ago(100)); // 1,000 → 오늘 100 수금 → 900 (91+)
  const s2 = await sell(C.C1, 5, 100, ago(45)); //   500 → 200 수금 → 300 (31–60)
  await receive(C.C1, 200, `${ago(40)}T10:00`, s2);
  await receive(C.C1, 100, `${TODAY}T00:30`, s1); // 오늘 00:30 KST(= 어제 15:30 UTC) — 오늘 수금
  const s3 = await sell(C.C2, 8, 100, ago(70)); //   800 → 외상 반품 2개 200 → 600 (61–90)
  await ret(s3, 2, ago(60));
  const s4 = await sell(C.C3, 6, 100, ago(30)); //   600 → 어제 23:50 수금 50 → 550 (30일 = 0–30)
  await receive(C.C3, 50, `${ago(1)}T23:50`, s4); // 어제 — 오늘 수금 아님
  const s5 = await sell(C.C4, 4, 100, ago(31)); //   400 (31일 = 31–60)
  await sell(C.C5, 3, 100, TODAY); //                300 (오늘 매출, 0–30)
  const s7 = await sell(C.C6, 2, 100, TODAY); //     200 오늘 매출 → 오늘 200 수금 → 반품 1개 현금 환불 100 → 미수 0
  await receive(C.C6, 200, `${TODAY}T09:00`, s7);
  const rf = await ret(s7, 1, TODAY);
  const s8 = await sell(C.C6, 1, 100, ago(10)); //   취소 → 어디에도 없음
  await mustOk(await request('POST', `/api/sales/${s8}/cancel`, { reason: '거래 취소' }, A), '매출 취소 s8');
  await sell(C.C7, 1, 100, ago(5)); //               100 (0–30)
  const s10 = await sell(C.C7, 1, 100, TODAY); //    오늘 매출이지만 취소 → 오늘 매출에 없음
  await mustOk(await request('POST', `/api/sales/${s10}/cancel`, { reason: '거래 취소' }, A), '매출 취소 s10');
  check('S-00 준비: s7 반품은 현금 환불 100(환불 지급 기록 — 수금 아님)', Number(rf?.refund_amount) === 100, rf);

  // 회원 B: 자기 거래 하나 — A 화면에 섞이면 안 된다
  const EB = await mkPartner(B, 'B농장', 'supplier');
  const CB = await mkPartner(B, 'B상회', 'customer');
  const PB = await mkProduct('B상품');
  const bLot = await buy(B, EB, PB, 10, 1000, ago(9));
  await mustOk(
    await request('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: bLot, partner_id: CB.id, quantity: 3, unit_price: 7777, sale_date: TODAY }] }, B),
    'B 매출'
  );

  r = await dash(A);
  d = r.json?.data;
  const t = d?.today;
  const rv = d?.receivables;

  // ---------- 3. 손계산 기대값 ----------
  check('H-01 오늘 매입 1,600원 2건 (1,000 + 600, 취소 70 제외)', t?.purchases.amount === 1600 && t.purchases.count === 2, t?.purchases);
  check('H-02 오늘 매출 500원 2건 (300 + 200, 취소 매출 제외, 반품은 총액에서 빼지 않음)', t?.sales.amount === 500 && t.sales.count === 2, t?.sales);
  check('H-03 오늘 수금 300원 2건 (00:30 KST 100 + 200, 어제 23:50·환불 지급 제외)', t?.receipts.amount === 300 && t.receipts.count === 2, t?.receipts);
  check(
    'H-04 총미수 3,150 = 950 + 700 + 600 + 900, 거래처 6곳, 매출 7건',
    rv?.total_due === 3150 && rv.d0_30 === 950 && rv.d31_60 === 700 && rv.d61_90 === 600 && rv.d91p === 900 &&
      rv.partner_count === 6 && rv.sale_count === 7 && eq(rv.d0_30 + rv.d31_60 + rv.d61_90 + rv.d91p, rv.total_due),
    rv
  );
  const top = d?.top_receivable_partners || [];
  const expectTop = [
    [C.C1.id, 1200, 0, 300, 0, 900],
    [C.C2.id, 600, 0, 0, 600, 0],
    [C.C3.id, 550, 550, 0, 0, 0],
    [C.C4.id, 400, 0, 400, 0, 0],
    [C.C5.id, 300, 300, 0, 0, 0],
  ];
  check(
    'H-05 미수 상위 5 = C1 1,200 · C2 600 · C3 550 · C4 400 · C5 300 (C7 100은 6위, C6 0은 없음)',
    top.length === 5 &&
      expectTop.every(([id, tot, a, b, c2, e], i) => top[i].partner_id === id && top[i].total_due === tot && top[i].d0_30 === a && top[i].d31_60 === b && top[i].d61_90 === c2 && top[i].d91p === e),
    top.map((x) => [x.partner_name, x.total_due])
  );
  const st = d?.stale_inventory;
  const staleNames = (st?.items || []).map((x) => x.product_id);
  check(
    'H-06 오래된 재고 상위 5 = 매출용 120일 · 20 · 15 · 10 · 7일 (3·4일은 목록 밖)',
    JSON.stringify(staleNames) === JSON.stringify([PS.id, P[20].id, P[15].id, P[10].id, P[7].id]) &&
      JSON.stringify(st.items.map((x) => x.aging_days)) === JSON.stringify([120, 20, 15, 10, 7]) &&
      st.items.every((x) => x.level === 'danger'),
    st?.items
  );
  check(
    'H-07 재고 개수: 경고(7일+) 5 · 주의(3–6일) 2 · 남은 재고 상품 9, 기준 3/7일',
    st?.danger_count === 5 && st.warn_count === 2 && st.product_count === 9 && st.warn_days === 3 && st.danger_days === 7,
    st && { danger: st.danger_count, warn: st.warn_count, n: st.product_count }
  );
  check('H-08 B의 매출 7,777×3·상품·거래처가 A 화면에 없음', !top.some((x) => x.partner_id === CB.id) && !staleNames.includes(PB.id) && t.sales.amount === 500, top);

  // ---------- 4. 목록·원장과 일치 ----------
  const purchases = await mustOk(await request('GET', `/api/purchases?from_date=${TODAY}&to_date=${TODAY}`, null, A), '매입 목록');
  const activeP = purchases.filter((x) => x.status === 'active');
  check('L-01 오늘 매입 = 매입정보 목록(오늘, 취소 제외) 합·건수', eq(sum(activeP, (x) => x.total_amount), t.purchases.amount) && activeP.length === t.purchases.count, { list: sum(activeP, (x) => x.total_amount), n: activeP.length });

  const sales = await mustOk(await request('GET', `/api/sales?from_date=${TODAY}&to_date=${TODAY}`, null, A), '매출 목록');
  const liveS = sales.filter((x) => x.status !== 'cancelled');
  check('L-02 오늘 매출 = 매출정보 목록(오늘, 취소 제외) 합·건수', eq(sum(liveS, (x) => x.total_amount), t.sales.amount) && liveS.length === t.sales.count, { list: sum(liveS, (x) => x.total_amount), n: liveS.length });

  const daily = await mustOk(await request('GET', `/api/reports/daily-purchase-sales?from_date=${TODAY}&to_date=${TODAY}`, null, A), '일별 보고서');
  const dr = daily[0] || {};
  check(
    'L-03 오늘 매입·매출 = 일별 매입·매출 보고서 오늘 행',
    eq(dr.purchase_amount, t.purchases.amount) && Number(dr.purchase_count) === t.purchases.count && eq(dr.sales_amount, t.sales.amount) && Number(dr.sales_count) === t.sales.count,
    dr
  );

  const pays = await mustOk(await request('GET', `/api/payments?from_date=${TODAY}&to_date=${TODAY}`, null, A), '수금 목록');
  const rec = pays.filter((x) => x.entry_kind === 'receive');
  check('L-04 오늘 수금 = 수금정보 목록(오늘, 수금만) 합·건수', eq(sum(rec, (x) => x.amount), t.receipts.amount) && rec.length === t.receipts.count, { list: sum(rec, (x) => x.amount), n: rec.length, all: pays.length });

  const ag = await mustOk(await request('GET', '/api/receivables/aging', null, A), '미수 연령');
  check(
    'L-05 총미수·구간·거래처 수 = 미수 연령 API 합계',
    ['total_due', 'd0_30', 'd31_60', 'd61_90', 'd91p'].every((k) => eq(ag.totals[k], rv[k])) && ag.totals.partner_count === rv.partner_count &&
      ag.rows.reduce((s, x) => s + x.sale_count, 0) === rv.sale_count,
    { aging: ag.totals, dash: rv }
  );
  const agTop = [...ag.rows].sort((a, b) => b.total_due - a.total_due || a.partner_name.localeCompare(b.partner_name)).slice(0, 5);
  check('L-06 상위 5 = 미수 연령 줄을 총미수 순으로 자른 것', agTop.every((x, i) => x.partner_id === top[i].partner_id && eq(x.total_due, top[i].total_due) && x.oldest_days === top[i].oldest_days), agTop.map((x) => [x.partner_name, x.total_due]));

  const unpaid = await mustOk(await request('GET', '/api/sales?unpaid_only=1', null, A), '미수 매출 목록');
  // unpaid_only 목록은 status='refunded'를 거른다(기존 동작) — 이 시나리오에는 그런 매출이 없으므로 합이 같아야 한다
  check('L-07 총미수 = 매출정보 미수만 보기 합', eq(sum(unpaid, (x) => x.unpaid_amount), rv.total_due), sum(unpaid, (x) => x.unpaid_amount));

  let ledgerOk = true;
  const ledgerDetail = [];
  for (const p of top) {
    const L = await mustOk(await request('GET', `/api/partners/${p.partner_id}/ledger`, null, A), `원장 ${p.partner_name}`);
    ledgerDetail.push([p.partner_name, L.closing_balance, L.check.diff]);
    if (!eq(L.closing_balance, p.total_due) || L.check.diff !== 0) ledgerOk = false;
  }
  check('L-08 상위 5 거래처 미수 = 각 거래처 원장 기말 잔액(diff 0)', ledgerOk && top.length === 5, ledgerDetail);

  const inv = await mustOk(await request('GET', '/api/inventory', null, A), '재고현황');
  const invStale = inv
    .filter((x) => x.aging_days != null && x.aging_days >= 3)
    .sort((a, b) => b.aging_days - a.aging_days || Number(b.quantity) - Number(a.quantity) || a.product_name.localeCompare(b.product_name));
  check(
    'L-09 오래된 재고 = 재고현황 API의 경과일(3일 이상, 오래된 순) 상위 5 — 같은 계산식',
    invStale.slice(0, 5).every((x, i) => x.product_id === st.items[i].product_id && x.aging_days === st.items[i].aging_days && x.aging_base_date === st.items[i].aging_base_date && eq(x.quantity, st.items[i].quantity)),
    { inv: invStale.slice(0, 5).map((x) => [x.product_name, x.aging_days]), dash: st.items.map((x) => [x.product_name, x.aging_days]) }
  );
  check(
    'L-10 경고·주의·상품 수 = 재고현황 목록에서 센 값',
    inv.filter((x) => x.aging_days >= 7).length === st.danger_count && inv.filter((x) => x.aging_days >= 3 && x.aging_days < 7).length === st.warn_count && inv.length === st.product_count,
    { inv: inv.length }
  );

  // ---------- 5. 회원 B ----------
  r = await dash(B);
  const db = r.json?.data;
  check(
    'B-01 B 화면: 자기 매출 23,331(7,777×3)·미수 1곳·재고 1개(9일)만, A 데이터 없음',
    r.status === 200 && db.today.sales.amount === 23331 && db.today.sales.count === 1 && db.today.purchases.count === 0 && db.today.receipts.count === 0 &&
      db.receivables.total_due === 23331 && db.receivables.partner_count === 1 && db.top_receivable_partners.length === 1 && db.top_receivable_partners[0].partner_id === CB.id &&
      db.stale_inventory.product_count === 1 && db.stale_inventory.items.length === 1 && db.stale_inventory.items[0].product_id === PB.id && db.stale_inventory.items[0].aging_days === 9,
    db
  );

  // ---------- 6. 쿼리 1회 · 인덱스 ----------
  const userIdA = (await pool.query(`SELECT id FROM "user" WHERE agent_no = $1`, [`t208a_${tag}`])).rows[0].id;
  const { DASHBOARD_SQL_FOR_TEST } = require('../lib/dashboard-routes');
  if (DASHBOARD_SQL_FOR_TEST) {
    const c = await pool.connect();
    try {
      await c.query('SET enable_seqscan = off');
      const ex = await c.query(`EXPLAIN ${DASHBOARD_SQL_FOR_TEST}`, [userIdA, TODAY, null, 3, 7, 5]);
      const plan = ex.rows.map((x) => x['QUERY PLAN']).join('\n');
      const seq = plan.split('\n').filter((l) => /Seq Scan on (sale|purchase|payment|inventory)\b/.test(l));
      console.log('[EXPLAIN 인덱스]', [...new Set((plan.match(/(?:Index|Bitmap Index) (?:Only )?Scan (?:using )?(?:on )?\w+/g) || []))].join(' | '));
      check('X-01 거래 테이블(sale·purchase·payment·inventory) 순차 스캔 없음(seqscan off EXPLAIN)', seq.length === 0, seq);
    } finally {
      await c.query('RESET enable_seqscan').catch(() => {});
      c.release();
    }
  }

  await pool.end();
  const fail = results.filter((x) => !x.ok);
  console.log(`\n=== 대시보드 검사 ${results.length - fail.length} / ${results.length} 통과 ===`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[dashboard-test] 오류:', err);
  process.exit(1);
});
