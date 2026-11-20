/**
 * T-104 거래처 원장 · 미수 연령 API 검사 (설계 T-104_원장_설계.md 8장 인수 조건)
 * - GET /api/partners/:id/ledger
 * - GET /api/receivables/aging
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> LEDGER_API_BASE=http://127.0.0.1:<포트> node scripts/ledger-aging-test.js
 * 전제: 마이그레이션 001~012, seed-admin(admin001 — 상품 등록용, 비밀번호 SMOKE_PASSWORD 또는 sample), 서버 기동.
 * 테스트 DB 전용 — 회원 A·B(t104a_/t104b_<태그>)를 DB에 직접 만들고, A로 매입·매출·수금·반품을 API로 만든다.
 * 날짜: 설계 기본 데이터는 "오늘 = 2026-11-20" 기준이다. 실행일이 다르면 모든 날짜를 같은 일수만큼 옮겨 경과일을 맞춘다.
 * 일부 경우(취소 매출 AC-15, 010 이전 흔적 AC-17)는 API가 없거나 옛 동작이라 테스트 DB에 SQL로 직접 만든다.
 */
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.LEDGER_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[ledger-aging-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
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

// 한국 오늘 · 날짜 계산(UTC 자정 기준 정수 일)
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const toDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const fromDay = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
const TODAY = kstToday();
const SHIFT = toDay(TODAY) - toDay('2026-11-20');
/** 설계 날짜(오늘=2026-11-20 기준)를 실행일 기준으로 옮김 */
const D = (s) => fromDay(toDay(s) + SHIFT);
/** 오늘 − n일 */
const ago = (n) => fromDay(toDay(TODAY) - n);
const eq = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const sumBuckets = (r) => Number(r.d0_30) + Number(r.d31_60) + Number(r.d61_90) + Number(r.d91p);

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const admin = await login('admin001', process.env.SMOKE_PASSWORD || 'sample');

  // 회원 A·B — 테스트 DB에 직접(가입 절차의 이메일 인증을 건너뜀). 비밀번호는 실행마다 임의값
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
  const A = await mkUser('t104a');
  const B = await mkUser('t104b');

  const product = await mustOk(await request('POST', '/api/products', { name: `T104-사과-${tag}`, unit: 'kg' }, admin), '상품');
  const mkPartner = async (token, name, type) => mustOk(await request('POST', '/api/partners', { name: `${name}-${tag}`, type }, token), `거래처 ${name}`);
  const E = await mkPartner(A, 'E농장', 'supplier');
  const C = await mkPartner(A, 'C상회', 'customer');
  const Dw = await mkPartner(A, 'D도매', 'wholesaler');
  const G = await mkPartner(A, 'G경계', 'customer');
  const F = await mkPartner(A, 'F전량반품', 'same_market');
  const H = await mkPartner(A, 'H취소', 'customer');
  const I = await mkPartner(A, 'I옛기록', 'customer');
  const J = await mkPartner(A, 'J시간대', 'market_wholesaler');

  // 매입 1건(충분한 재고) → 매출로 전환
  const pu = await mustOk(
    await request('POST', '/api/purchases', { partner_id: E.id, product_id: product.id, quantity: 200, unit_price: 50, purchase_date: D('2026-06-01') }, A),
    '매입'
  );
  const purchaseId = pu.id || pu.purchase_id || (pu[0] && pu[0].id);
  const sell = async (partner, qty, price, date) => {
    const d = await mustOk(
      await request('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: purchaseId, partner_id: partner.id, quantity: qty, unit_price: price, sale_date: date }] }, A),
      `매출 ${date}`
    );
    return d[0].sale_id;
  };
  const receive = async (partner, amount, paidAt, allocations) =>
    mustOk(await request('POST', '/api/payments', { partner_id: partner.id, amount, paid_at: paidAt, entry_kind: 'receive', allocations }, A), `수금 ${paidAt}`);
  const ret = async (saleId, qty, date, amount) =>
    mustOk(
      await request('POST', `/api/sales/${saleId}/refund`, { quantity: qty, refunded_at: date, reason: '테스트 반품', ...(amount != null ? { return_amount: amount } : {}) }, A),
      `반품 ${date}`
    );
  const ledger = (token, id, qs = '') => request('GET', `/api/partners/${id}/ledger${qs}`, null, token);
  const aging = (token, qs = '') => request('GET', `/api/receivables/aging${qs}`, null, token);

  // ---------- 기본 데이터 (설계 8장 ①~⑧) ----------
  const S1 = await sell(C, 10, 100, D('2026-07-01'));
  const S2 = await sell(C, 5, 100, D('2026-09-01'));
  await receive(C, 200, D('2026-09-10'), [{ sale_id: S2, amount: 200 }]);
  const S3 = await sell(C, 8, 100, D('2026-10-10'));
  await receive(C, 800, D('2026-10-15'), [{ sale_id: S3, amount: 800 }]);
  await ret(S3, 2, D('2026-10-20'));
  const S4 = await sell(C, 4, 100, D('2026-11-01'));
  await ret(S4, 1, D('2026-11-05'));

  // AC-01 행 순서·잔액
  let r = await ledger(A, C.id);
  let L = r.json?.data;
  const kinds = (L?.entries || []).map((e) => e.kind).join(',');
  const bals = (L?.entries || []).map((e) => e.balance).join(',');
  check('AC-01 원장 9행 순서(⑥ 반품→환불 지급)', r.status === 200 && kinds === 'sale,sale,receipt,sale,receipt,return,refund_cash,sale,return', kinds);
  check('AC-01 행별 잔액 1000,1500,1300,2100,1300,1100,1300,1700,1600', bals === '1000,1500,1300,2100,1300,1100,1300,1700,1600', bals);
  check('AC-01 날짜는 YYYY-MM-DD 문자열', (L?.entries || []).every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)), L?.entries?.map((e) => e.date));
  const retRow = L?.entries?.find((e) => e.kind === 'return' && e.sale_id === S3);
  check('AC-01 반품 행 미수 차감 0 / 현금 환불 200', retRow && retRow.credit_amount === 0 && retRow.cash_refund_amount === 200, retRow);

  // AC-02 잔액식 = 매출별 미수 합 = unpaid_only 목록 합
  const unpaid = await mustOk(await request('GET', `/api/sales?unpaid_only=1&partner_id=${C.id}`, null, A), '미수 목록');
  const unpaidSum = unpaid.reduce((s, x) => s + Number(x.unpaid_amount), 0);
  check(
    'AC-02 기말 1,600 = 매출 2,700 − 반품 300 − 수금 1,000 + 환불 200, diff 0, = unpaid_only 합',
    L.closing_balance === 1600 && eq(L.totals.sales - L.totals.returns - L.totals.receipts + L.totals.refunds, 1600) &&
      L.totals.sales === 2700 && L.totals.returns === 300 && L.totals.receipts === 1000 && L.totals.refunds === 200 &&
      L.check.diff === 0 && L.check.sale_based_due === 1600 && eq(unpaidSum, 1600),
    { closing: L.closing_balance, totals: L.totals, check: L.check, unpaidSum }
  );

  // AC-03 기초 잔액
  r = await ledger(A, C.id, `?from=${D('2026-10-01')}`);
  L = r.json?.data;
  check('AC-03 from=10-01 → 기초 1,300, 6행, 첫 행 잔액 2,100', L?.opening_balance === 1300 && L.entries.length === 6 && L.entries[0].balance === 2100, {
    opening: L?.opening_balance,
    n: L?.entries?.length,
  });

  // AC-04 기간 합
  r = await ledger(A, C.id, `?from=${D('2026-10-01')}&to=${D('2026-10-31')}`);
  L = r.json?.data;
  check(
    'AC-04 10월: 기초 1,300 · 기말 1,300 · {800,200,800,200} · 기초+매출−반품−수금+환불=기말',
    L?.opening_balance === 1300 && L.closing_balance === 1300 && L.totals.sales === 800 && L.totals.returns === 200 &&
      L.totals.receipts === 800 && L.totals.refunds === 200 &&
      eq(L.opening_balance + L.totals.sales - L.totals.returns - L.totals.receipts + L.totals.refunds, L.closing_balance),
    L && { opening: L.opening_balance, closing: L.closing_balance, totals: L.totals }
  );

  // AC-05 연령
  r = await aging(A);
  let Ag = r.json?.data;
  let rowC = Ag?.rows?.find((x) => x.partner_id === C.id);
  check(
    'AC-05 C: 총 1,600 = 300 + 0 + 300 + 1,000, = 원장 기말',
    r.status === 200 && rowC && rowC.total_due === 1600 && rowC.d0_30 === 300 && rowC.d31_60 === 0 && rowC.d61_90 === 300 && rowC.d91p === 1000 && eq(sumBuckets(rowC), rowC.total_due),
    rowC
  );
  check('AC-05 as_of = 서버 KST 오늘, basis sale_date, 구간 4개', Ag?.as_of === TODAY && Ag.basis === 'sale_date' && Ag.buckets.length === 4, { as_of: Ag?.as_of });

  // AC-06 경계 · AC-07 미래 날짜
  for (const n of [30, 31, 60, 61, 90, 91]) await sell(G, 1, 100, ago(n));
  const Sfuture = await sell(G, 1, 100, ago(-1));
  r = await aging(A, `?partner_id=${G.id}`);
  const g = r.json?.data;
  const rowG = g?.rows?.[0];
  check('AC-06 경계: 30→0–30, 31·60→31–60, 61·90→61–90, 91→90 초과', rowG && rowG.d0_30 === 200 && rowG.d31_60 === 200 && rowG.d61_90 === 200 && rowG.d91p === 100, rowG);
  const fut = g?.sales?.find((x) => x.sale_id === Sfuture);
  check('AC-07 내일 매출 → 0일, 30일 이내', fut && fut.days === 0 && fut.bucket === 'd0_30', fut);
  const byDays = Object.fromEntries((g?.sales || []).map((x) => [x.days, x.bucket]));
  check('AC-06 매출별 bucket', byDays[30] === 'd0_30' && byDays[31] === 'd31_60' && byDays[60] === 'd31_60' && byDays[61] === 'd61_90' && byDays[90] === 'd61_90' && byDays[91] === 'd91p', byDays);

  // AC-08 정렬·판매처 유형(wholesaler 포함)
  await sell(Dw, 4, 100, ago(2));
  r = await aging(A);
  Ag = r.json?.data;
  const idx = (id) => Ag.rows.findIndex((x) => x.partner_id === id);
  const rowD = Ag.rows.find((x) => x.partner_id === Dw.id);
  check('AC-08 C(90 초과 1,000)가 D보다 위, D(wholesaler) 400 포함', idx(C.id) >= 0 && idx(Dw.id) > idx(C.id) && rowD?.total_due === 400 && rowD.partner_type === 'wholesaler', Ag.rows.map((x) => x.partner_name));
  const tot = Ag.totals;
  const rowsSum = Ag.rows.reduce((s, x) => s + x.total_due, 0);
  check('AC-08 totals = 거래처 줄 합, 구간 합 = 총미수', eq(tot.total_due, rowsSum) && eq(sumBuckets(tot), tot.total_due) && tot.partner_count === Ag.rows.length, tot);
  check('모든 거래처 줄: 구간 합 = 총미수', Ag.rows.every((x) => eq(sumBuckets(x), x.total_due)), Ag.rows);

  // AC-09 매출별 상세
  r = await aging(A, `?partner_id=${C.id}`);
  let det = r.json?.data;
  const ids = (det?.sales || []).map((x) => `${x.sale_id}:${x.due}`).join(',');
  check('AC-09 C 상세 S1 1,000 · S2 300 · S4 300(오래된 순, S3 없음)', ids === `${S1}:1000,${S2}:300,${S4}:300`, ids);
  check('AC-09 상세 합 = 줄 총미수', det && eq(det.sales.reduce((s, x) => s + x.due, 0), det.rows[0].total_due), det?.rows);

  // AC-10 min_days
  r = await aging(A, '?min_days=61');
  const names = (r.json?.data?.rows || []).map((x) => x.partner_id);
  check('AC-10 min_days=61 → C 있음, D 없음', names.includes(C.id) && !names.includes(Dw.id), names);

  // AC-11 부분 수금
  await receive(C, 400, TODAY, [{ sale_id: S1, amount: 400 }]);
  r = await ledger(A, C.id);
  L = r.json.data;
  det = (await aging(A, `?partner_id=${C.id}`)).json.data;
  const s1 = det.sales.find((x) => x.sale_id === S1);
  check('AC-11 S1 400 수금 → S1 미수 600(90 초과), 원장 끝 수금 −400, 기말 1,200, diff 0',
    s1?.due === 600 && s1.bucket === 'd91p' && L.entries.at(-1).kind === 'receipt' && L.entries.at(-1).decrease === 400 && L.closing_balance === 1200 && L.check.diff === 0,
    { s1, last: L.entries.at(-1), closing: L.closing_balance });

  // AC-12 한 번에 여러 매출 수금 → 원장 1행 + 배분 2건
  await receive(C, 500, TODAY, [{ sale_id: S1, amount: 200 }, { sale_id: S2, amount: 300 }]);
  r = await ledger(A, C.id);
  L = r.json.data;
  const lastRow = L.entries.at(-1);
  det = (await aging(A, `?partner_id=${C.id}`)).json.data;
  rowC = det.rows[0];
  check('AC-12 수금 −500 한 행, allocations 2건', lastRow.kind === 'receipt' && lastRow.decrease === 500 && lastRow.allocations?.length === 2 && /매출 #\d+ 200 · 매출 #\d+ 300/.test(lastRow.description), lastRow);
  check('AC-12 S2 완납 → 61–90 0, 90 초과 400, 기말 700 = 연령 총미수', rowC.d61_90 === 0 && rowC.d91p === 400 && rowC.total_due === 700 && L.closing_balance === 700 && L.check.diff === 0, { rowC, closing: L.closing_balance });

  // AC-13 전량 반품인데 금액 일부만 (F-3) — T-219 R-06(T104-U-5 A안): API는 400으로 막는다.
  //   이미 그렇게 저장된 이전 기록은 테스트 DB에 SQL로 만들고, 원장·연령·미수 목록·수금에 모두 보이는지 본다
  const S5 = await sell(F, 10, 100, ago(40));
  const r13 = await request('POST', `/api/sales/${S5}/refund`, { quantity: 10, refunded_at: TODAY, reason: '테스트 반품', return_amount: 600 }, A);
  check('AC-13a 전량 반품 + 반품 금액 600(< 순매출 1,000) → 400 FULL_RETURN_AMOUNT', r13.status === 400 && r13.json?.code === 'FULL_RETURN_AMOUNT', r13);
  {
    const ins = await pool.query(
      `INSERT INTO refund (user_id, sale_id, quantity, refund_amount, credit_amount, return_amount, reason, refunded_at)
       SELECT user_id, id, 10, 0, 600, 600, '이전 기록(F-3)', $2::date FROM sale WHERE id = $1 RETURNING id`,
      [S5, TODAY]
    );
    if (!ins.rows[0]) throw new Error('AC-13 이전 기록 만들기 실패');
    await pool.query(`UPDATE sale SET returned_amount = 600, status = 'refunded', payment_status = 'unpaid' WHERE id = $1`, [S5]);
  }
  const st5 = (await pool.query('SELECT status, payment_status FROM sale WHERE id = $1', [S5])).rows[0];
  const up13 = (await request('GET', `/api/sales?unpaid_only=1&partner_id=${F.id}`, null, A)).json?.data || [];
  check('AC-13b refunded 인데 미수 400 → 미수 목록(unpaid_only)에 보임', up13.some((x) => x.id === S5 && Number(x.unpaid_amount) === 400), up13);
  r = await ledger(A, F.id);
  L = r.json.data;
  det = (await aging(A, `?partner_id=${F.id}`)).json.data;
  check('AC-13 전량 반품 V 600 → refunded, 원장 +1,000 −600 = 400, 연령 31–60에 400(same_market)',
    st5.status === 'refunded' && L.closing_balance === 400 && L.check.diff === 0 && det.rows[0]?.d31_60 === 400 && det.rows[0]?.partner_type === 'same_market',
    { st5, closing: L.closing_balance, row: det.rows[0] });

  // AC-14 권한 — B는 A의 거래처를 볼 수 없다
  const rb1 = await ledger(B, C.id);
  const rb2 = await aging(B, `?partner_id=${C.id}`);
  const rb3 = await aging(B);
  check('AC-14 B → A 거래처 원장 404', rb1.status === 404 && rb1.json?.code === 'NOT_FOUND' && !JSON.stringify(rb1.json).includes('1600'), rb1);
  check('AC-14 B → aging partner_id=A거래처 404', rb2.status === 404, rb2);
  check('AC-14 B 전체 aging에 A 거래처 없음', rb3.status === 200 && rb3.json.data.rows.length === 0 && rb3.json.data.totals.total_due === 0, rb3.json?.data);
  const r401 = await request('GET', `/api/partners/${C.id}/ledger`);
  const r401b = await request('GET', '/api/receivables/aging');
  check('로그인 없음 → 401 (원장·연령)', r401.status === 401 && r401b.status === 401, [r401.status, r401b.status]);

  // AC-15 취소 매출 (T-103 취소 API 병합 전 → 테스트 DB에서 직접)
  await sell(H, 1, 100, ago(5));
  const S6 = await sell(H, 3, 100, ago(3));
  await pool.query(`UPDATE sale SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [S6]);
  r = await ledger(A, H.id);
  L = r.json.data;
  const r15 = await ledger(A, H.id, '?include_cancelled=1');
  const L15 = r15.json.data;
  const crow = L15.entries.find((e) => e.kind === 'sale_cancelled');
  det = (await aging(A, `?partner_id=${H.id}`)).json.data;
  check('AC-15 취소 매출 원장·연령에서 빠짐', L.entries.length === 1 && L.closing_balance === 100 && det.rows[0]?.total_due === 100 && !det.sales.some((x) => x.sale_id === S6), { n: L.entries.length, due: det.rows[0] });
  check('AC-15 include_cancelled=1 → 0원 취소 행 1개, 잔액 변화 없음', L15.entries.length === 2 && crow?.sale_id === S6 && crow.increase === 0 && crow.decrease === 0 && crow.balance === 100 && L15.closing_balance === 100, L15.entries);

  // AC-17 010 이전 방식 흔적(받지 않은 돈의 환불 기록) → diff 500
  const S8 = await sell(I, 5, 100, ago(10));
  const rf = await pool.query(
    `INSERT INTO refund (user_id, sale_id, quantity, refund_amount, credit_amount, reason, refunded_at)
     SELECT user_id, id, 5, 500, 0, '옛 반품', $2::date FROM sale WHERE id = $1 RETURNING id`,
    [S8, ago(9)]
  );
  await pool.query(`INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo)
                    SELECT user_id, partner_id, 500, ($2::date)::timestamp AT TIME ZONE 'Asia/Seoul', 'refund', $3 FROM sale WHERE id = $1`, [S8, ago(9), `환불 #${rf.rows[0].id}`]);
  await pool.query(`UPDATE sale SET returned_amount = 500, status = 'refunded', payment_status = 'paid' WHERE id = $1`, [S8]);
  L = (await ledger(A, I.id)).json.data;
  det = (await aging(A, `?partner_id=${I.id}`)).json.data;
  check('AC-17 옛 흔적 → check.diff 500, 연령에 S8 없음', L.check.diff === 500 && L.check.sale_based_due === 0 && L.check.ledger_balance === 500 && det.rows.length === 0, L.check);

  // R-01·R-02 (T-219) 010 이전 "환불금 없이 반품"한 완납 매출: 받은 돈 1,000 > 순매출 700 → overpaid 300(013)
  {
    const K = await mkPartner(A, 'K초과수금', 'customer');
    const S9 = await sell(K, 10, 100, ago(20));
    await receive(K, 1000, ago(19), [{ sale_id: S9, amount: 1000 }]);
    // 옛 코드 모양: 환불금 0, 반품 3개, 받은 돈 그대로 → 013 백필 결과와 같은 값으로 직접 만든다
    await pool.query(`ALTER TABLE sale DROP CONSTRAINT sale_paid_not_over_net`);
    await pool.query(
      `INSERT INTO refund (user_id, sale_id, quantity, refund_amount, credit_amount, return_amount, reason, refunded_at)
       SELECT user_id, id, 3, 0, 300, 300, '옛 반품(환불금 없음)', $2::date FROM sale WHERE id = $1`, [S9, ago(18)]);
    await pool.query(`UPDATE sale SET returned_amount = 300, overpaid_amount = 300, payment_status = 'paid' WHERE id = $1`, [S9]);
    await pool.query(`ALTER TABLE sale ADD CONSTRAINT sale_paid_not_over_net CHECK (paid_amount <= total_amount - returned_amount + overpaid_amount)`);
    const pm = await request('PATCH', `/api/sales/${S9}`, { reason: '메모 고침', changes: { memo: '초과 수금 메모' } }, A);
    check('R-01 받은 돈 > 순매출 매출 메모 수정 → 200 (예전 500)', pm.status === 200 && pm.json?.data?.memo === '초과 수금 메모', pm);
    L = (await ledger(A, K.id)).json.data;
    check('R-01 원장 −300 = 매출별 미수 0 − 돌려줄 돈 300 → diff 0', L.closing_balance === -300 && L.check.overpaid === 300 && L.check.diff === 0, L.check);
    const rr = await mustOk(await request('POST', `/api/sales/${S9}/refund`, { quantity: 7, refunded_at: TODAY, reason: '남은 수량 반품' }, A), 'R-02 반품');
    const s9 = (await pool.query('SELECT paid_amount, returned_amount, overpaid_amount, status FROM sale WHERE id = $1', [S9])).rows[0];
    const rf9 = (await pool.query('SELECT return_amount, refund_amount, credit_amount FROM refund WHERE id = $1', [rr.refund_id])).rows[0];
    L = (await ledger(A, K.id)).json.data;
    const lastRet = L.entries.filter((e) => e.kind === 'return').at(-1);
    check('R-02 남은 7개 반품: V 700 · 현금 1,000(초과 300 포함) · 반품 행 −700 · 원장 0 = 미수 0, diff 0',
      rr.return_amount === 700 && rr.refund_amount === 1000 && Number(rf9.return_amount) === 700 && lastRet?.decrease === 700
        && Number(s9.paid_amount) === 0 && Number(s9.overpaid_amount) === 0 && s9.status === 'refunded'
        && L.closing_balance === 0 && L.check.diff === 0 && L.check.overpaid === 0,
      { rr, s9, rf9, check: L.check, closing: L.closing_balance });
  }

  // AC-18 매입처
  r = await ledger(A, E.id);
  check('AC-18 supplier → 200, entries [], scope receivable', r.status === 200 && r.json.data.entries.length === 0 && r.json.data.scope === 'receivable', r.json);

  // AC-19 서버 TZ 상관없이 수금 날짜는 한국 날짜 (KST 08:30 = 전날 23:30 UTC)
  const Sj = await sell(J, 1, 100, TODAY);
  await receive(J, 100, `${TODAY}T08:30`, [{ sale_id: Sj, amount: 100 }]);
  L = (await ledger(A, J.id)).json.data;
  const rj = L.entries.find((e) => e.kind === 'receipt');
  check(`AC-19 KST 08:30 수금 → date ${TODAY}(하루 밀리지 않음)`, rj?.date === TODAY && L.entries.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)), L.entries.map((e) => [e.kind, e.date]));

  // AC-20 입력 검사
  const bad = [
    [await ledger(A, C.id, '?from=2026-13-01'), 'from'],
    [await ledger(A, C.id, '?from=2026-02-30'), 'from'],
    [await ledger(A, C.id, '?to=20261101'), 'to'],
    [await ledger(A, C.id, `?from=${TODAY}&to=${ago(1)}`), 'from'],
    [await ledger(A, 'abc'), 'id'],
    [await ledger(A, '1 OR 1=1'), 'id'],
    [await aging(A, `?as_of=${TODAY}`), 'as_of'],
    [await aging(A, '?partner_id=x1'), 'partner_id'],
    [await aging(A, '?min_days=-3'), 'min_days'],
  ];
  check('AC-20 잘못된 입력 9건 → 400 VALIDATION(field)', bad.every(([x, f]) => x.status === 400 && x.json?.code === 'VALIDATION' && x.json.field === f), bad.map(([x, f]) => `${f}:${x.status}:${x.json?.field}`));
  const r404 = await ledger(A, 2147483000);
  check('없는 거래처 → 404', r404.status === 404, r404.status);

  // AC-23 receivables_by_partner 뷰(012) — 판매처 유형 4개 + refunded 미수 포함
  const v = await pool.query(
    `SELECT partner_id, receivable_amount FROM receivables_by_partner WHERE partner_id = ANY($1::int[])`,
    [[C.id, Dw.id, F.id, E.id]]
  );
  const vm = Object.fromEntries(v.rows.map((x) => [x.partner_id, Number(x.receivable_amount)]));
  check('AC-23 뷰: C 700 · D(wholesaler) 400 · F(refunded 미수) 400 · E(supplier) 없음', vm[C.id] === 700 && vm[Dw.id] === 400 && vm[F.id] === 400 && !(E.id in vm), vm);

  // 검증식 — A의 모든 거래처: 원장 기말 = 전체 기간 원장 잔액, 연령 총미수 = 매출별 미수 합 = 원장 잔액(옛 흔적 I 제외)
  Ag = (await aging(A)).json.data;
  const partners = [C, Dw, G, F, H, I, J];
  let allOk = true;
  const rowsOut = [];
  for (const p of partners) {
    const l = (await ledger(A, p.id)).json.data;
    const due = Ag.rows.find((x) => x.partner_id === p.id)?.total_due || 0;
    const ok = l.closing_balance === l.check.ledger_balance && eq(l.check.sale_based_due, due) && (p === I ? l.check.diff === 500 : l.check.diff === 0 && eq(l.closing_balance, due));
    rowsOut.push(`${p.name.split('-')[0]} 원장 ${l.closing_balance} / 매출별 ${l.check.sale_based_due} / 연령 ${due}`);
    if (!ok) allOk = false;
  }
  console.log('  ' + rowsOut.join('\n  '));
  check('검증식: 거래처 7곳 원장 잔액 = 매출별 미수 합 = 연령 총미수(옛 흔적 I만 diff 500)', allOk, rowsOut);

  // R-07 (T-219) 거래명세서 합계 미수 = 총액 − 반품액 − 수금 = 같은 기간 원장 잔액(C상회 전체 기간)
  {
    const st = await request('GET', `/api/sales/statement?partner_id=${C.id}&from_date=2026-01-01&to_date=${TODAY}`, null, A);
    const lc = (await ledger(A, C.id)).json.data;
    const t = st.json?.data?.totals || {};
    const itemDue = (st.json?.data?.items || []).reduce((acc, x) => acc + Number(x.unpaid_amount), 0);
    check('R-07 명세서 미수 = 총액 − 반품액 − 수금 = 원장 잔액, 항목 미수 합과 같음',
      st.status === 200 && Number(t.returned_amount) > 0 && eq(Number(t.unpaid_amount), lc.closing_balance)
        && eq(Number(t.unpaid_amount), Number(t.total_amount) - Number(t.returned_amount) - Number(t.paid_amount)) && eq(itemDue, Number(t.unpaid_amount)),
      { totals: t, closing: lc.closing_balance, itemDue });
  }

  // AC-13c (T-219 R-06) refunded 라도 미수가 남은 매출은 수금 배분 가능 — 검증식 확인 뒤(F 잔액이 바뀌므로)
  {
    const p13 = await request('POST', '/api/payments', { partner_id: F.id, amount: 400, paid_at: `${TODAY}T10:00:00+09:00`, entry_kind: 'receive', allocations: [{ sale_id: S5, amount: 400 }] }, A);
    const s5 = (await pool.query('SELECT paid_amount, payment_status FROM sale WHERE id = $1', [S5])).rows[0];
    const lf = (await ledger(A, F.id)).json.data;
    check('AC-13c refunded·미수 400 매출에 수금 400 → 201, 완납, 원장 0', p13.status === 201 && s5.payment_status === 'paid' && lf.closing_balance === 0 && lf.check.diff === 0, { p13: p13.status, s5, check: lf.check });
  }

  // EXPLAIN — 인덱스 사용 확인(설계 4.3). 데이터가 적으면 플래너가 순차 스캔을 고르므로 seqscan off 로 경로만 본다
  const c1 = await pool.connect();
  try {
    await c1.query('SET enable_seqscan = off');
    const uid = (await pool.query('SELECT user_id FROM account WHERE id = $1', [C.id])).rows[0].user_id;
    const e1 = await c1.query(`EXPLAIN SELECT * FROM partner_ledger_entry WHERE user_id = $1 AND partner_id = $2`, [uid, C.id]);
    const e2 = await c1.query(
      `EXPLAIN SELECT id FROM sale s WHERE s.user_id = $1 AND s.status <> 'cancelled' AND s.payment_status IN ('unpaid','partial') AND s.total_amount - s.returned_amount - s.paid_amount > 0.005`,
      [uid]
    );
    const p1 = e1.rows.map((x) => x['QUERY PLAN']).join('\n');
    const p2 = e2.rows.map((x) => x['QUERY PLAN']).join('\n');
    console.log('--- EXPLAIN 원장\n' + p1 + '\n--- EXPLAIN 연령\n' + p2);
    check('EXPLAIN: 원장·연령 모두 인덱스 경로 있음(Seq Scan 없음)', !/Seq Scan/.test(p1) && !/Seq Scan/.test(p2), '');
  } finally {
    c1.release();
  }

  await pool.end();
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n결과: ${pass} / ${results.length} 통과 (오늘 KST ${TODAY}, 날짜 이동 ${SHIFT}일)`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('[ledger-aging-test] 오류:', e);
  process.exit(1);
});
