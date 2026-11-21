/**
 * T-403 데이터 이관(마이그레이션) 검사 — 설계 7장 AC-403-01~72(화면 70~72 제외 — 캡처로 확인)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> SETTLE_API_BASE=http://127.0.0.1:<포트> SEED_ADMIN_PASSWORD=<로컬 관리자 비밀번호> node scripts/migration-test.js
 * 전제: 마이그레이션 001~025, seed-admin(admin001)·seed-sample-local(공용 품목 홍고추·청양고추), 서버 기동. 테스트 DB 전용 — 회원을 DB에 직접 만든다.
 * 선택: MIGRATION_TEMPLATE_OUT=<폴더> 이면 이관 템플릿 7종 .xlsx 를 그 폴더에 저장한다. MIGRATION_TEST_OUT=<파일> 이면 결과 JSON 저장.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const BASE = process.env.SETTLE_API_BASE || process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[migration-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}
const ADMIN_PW = process.env.SEED_ADMIN_PASSWORD || process.env.SMOKE_PASSWORD;

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
}
async function json(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try { j = await r.json(); } catch { /* */ }
  return { status: r.status, json: j };
}
async function upload(token, id, kind, buf, name = `${kind}.xlsx`) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const r = await fetch(`${BASE}/api/migrations/${id}/files/${kind}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  let j = null;
  try { j = await r.json(); } catch { /* */ }
  return { status: r.status, json: j };
}
async function makeXlsx(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('입력');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const H = {
  partner: ['거래처명', '유형', '담당자', '전화', '이메일', '지역', '주소', '산지', '은행', '계좌번호', '예금주', '외상한도', '메모', '기존 코드'],
  product: ['품목명', '단위', '대분류', '중분류', '소분류', '메모', '기존 코드', '공용'],
  opening_ar: ['거래처', '미수 금액', '원래 매출일', '원 전표번호', '메모'],
  opening_ap: ['지급 대상', '미지급 금액', '원래 매입일', '원 전표번호', '메모'],
  opening_stock: ['품목', '수량', '원가 단가', '입고일', '제공처', '생산자', '산지', '원 전표번호', '메모'],
  history: ['구분', '날짜', '거래처', '품목', '수량', '단가', '금액', '원가', '원 전표번호', '메모'],
  disposal: ['폐기일', '품목', '수량', '사유', '메모'],
};
const KINDS = Object.keys(H);
const pRow = (name, type, { limit = '', code = '', origin = '', memo = '' } = {}) => [name, type, '', '', '', '', '', origin, '', '', '', limit, memo, code];
const xlsx = (kind, rows) => makeXlsx(H[kind], rows);
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const rowsOf = (v, kind) => (v.json && v.json.files && v.json.files[kind] ? v.json.files[kind].rows : []);
const errLines = (v, kind) => rowsOf(v, kind).filter((r) => !r.ok);

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const today = kst();
  const D = '2026-11-01';
  const DM1 = addDays(D, -1);

  const mkUser = async (label) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const agent = `t403${label}_${tag}`;
    const uid = (await q(
      `INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
       VALUES ($1, $2, $3, $4, NOW(), 'active', false) RETURNING id`,
      [`이관검사${label} ${tag}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
    ))[0].id;
    const token = (await json('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
    if (!token) throw new Error(`로그인 실패 ${label}`);
    return { uid, token, agent };
  };
  const staffTok = async (owner, loginId, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    const r = await json('POST', '/api/staff', { login_id: loginId, name: `직원${loginId}`, role, temp_password: spw }, owner.token);
    if (r.status >= 300) throw new Error(`직원 ${loginId} ${r.status} ${JSON.stringify(r.json)}`);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [owner.uid, loginId]);
    return (await json('POST', '/api/auth/login', { agent_no: owner.agent, login_id: loginId, password: spw })).json.token;
  };
  const newBatch = async (token, d = D) => json('POST', '/api/migrations', { cutover_date: d, memo: 'test' }, token);
  const validate = (token, id) => json('POST', `/api/migrations/${id}/validate`, {}, token);
  const commit = (token, id, confirm) => json('POST', `/api/migrations/${id}/commit`, confirm ? { confirm_warnings: true } : {}, token);
  const receivable = async (uid, pid) => Number((await q(`SELECT receivable_amount FROM receivables_by_partner WHERE user_id = $1 AND partner_id = $2`, [uid, pid]))[0]?.receivable_amount || 0);
  const payable = async (uid, pid) => Number((await q(`SELECT payable_amount FROM payables_by_partner WHERE user_id = $1 AND partner_id = $2`, [uid, pid]))[0]?.payable_amount || 0);
  const inv = async (uid, prid) => Number((await q(`SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2`, [uid, prid]))[0]?.quantity || 0);
  const pid = async (uid, name) => (await q(`SELECT id FROM account WHERE user_id = $1 AND name = $2`, [uid, name]))[0]?.id;
  const prodId = async (name, uid) => (await q(`SELECT id FROM product WHERE name = $1 AND (owner_user_id IS NULL OR owner_user_id = $2) ORDER BY owner_user_id NULLS FIRST LIMIT 1`, [name, uid]))[0]?.id;
  const countsOf = async (uid) => (await q(
    `SELECT (SELECT COUNT(*) FROM account WHERE user_id = $1)::int a, (SELECT COUNT(*) FROM sale WHERE user_id = $1)::int s,
            (SELECT COUNT(*) FROM purchase WHERE user_id = $1)::int p, (SELECT COUNT(*) FROM disposal WHERE user_id = $1)::int d,
            (SELECT COUNT(*) FROM migration_history WHERE user_id = $1)::int h, (SELECT COALESCE(SUM(quantity),0)::text FROM inventory WHERE user_id = $1) i,
            (SELECT COUNT(*) FROM product WHERE owner_user_id = $1)::int pr`, [uid]))[0];

  // ---------- 0. 025 재실행 (AC-403-01) ----------
  {
    const c = await pool.connect();
    let ok = false;
    let sysN = null;
    let err = null;
    try {
      await c.query('BEGIN');
      const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '025_data_migration.sql'), 'utf8');
      await c.query(sql);
      await c.query(sql);
      sysN = Number((await c.query(`SELECT COUNT(*) n FROM product WHERE is_system`)).rows[0].n);
      ok = sysN === 1;
    } catch (e) { err = e.message; } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
    check('AC-403-01 025 두 번 다시 실행 → 오류 없음, 시스템 품목 1행', ok, { sysN, err });
  }

  const A = await mkUser('a');
  const SI = await staffTok(A, 'in1', 'input');
  const SV = await staffTok(A, 'vw1', 'view');
  const O = await mkUser('o'); // 다른 회원

  // ---------- 1. 템플릿 (AC-403-05) ----------
  const outDir = process.env.MIGRATION_TEMPLATE_OUT;
  const tplBuf = {};
  for (const kind of KINDS) {
    const r = await fetch(`${BASE}/api/migrations/template/${kind}`, { headers: { authorization: `Bearer ${A.token}` } });
    const buf = Buffer.from(await r.arrayBuffer());
    tplBuf[kind] = buf;
    const wb = new ExcelJS.Workbook();
    let sheets = [];
    let head = [];
    let ex = 0;
    let guide = '';
    try {
      await wb.xlsx.load(buf);
      sheets = wb.worksheets.map((w) => w.name);
      head = wb.getWorksheet('입력').getRow(1).values.slice(1);
      ex = wb.getWorksheet('입력').actualRowCount - 1;
      wb.getWorksheet('작성 안내').eachRow((row) => { guide += ` ${row.values.slice(1).join(' ')}`; });
    } catch { /* FAIL 아래 */ }
    check(`AC-403-05 템플릿 ${kind} — 입력·작성 안내 시트, 필수 *, 가락시장 예시 줄, 기준일·저장 순서 안내`,
      r.status === 200 && sheets[0] === '입력' && sheets[1] === '작성 안내' && head.some((h) => String(h).endsWith('*')) && ex >= 1 && /기준일/.test(guide) && /저장 순서/.test(guide),
      { status: r.status, sheets, head, ex });
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const m = /filename\*=UTF-8''([^;]+)/i.exec(r.headers.get('content-disposition') || '');
      fs.writeFileSync(path.join(outDir, m ? decodeURIComponent(m[1]) : `이관_${kind}.xlsx`), buf);
    }
  }

  // ---------- 2. 묶음 만들기·기준일 (AC-403-03) ----------
  {
    const r = await newBatch(A.token, today);
    check('AC-403-03 기준일 = 오늘 묶음 만들기 → 201 draft', r.status === 201 && r.json.data.status === 'draft', r.json);
    const del = await json('DELETE', `/api/migrations/${r.json.data.id}`, null, A.token);
    check('R-83 draft 묶음 삭제 → 200', del.status === 200, del.json);
  }

  // ---------- 3. 주 묶음(A): 7종 정상 → 검증(저장 안 됨) → 저장 ----------
  // 기존 거래처 1곳(기존 이름 사용 · 코드 채움 MP-03)
  await json('POST', '/api/partners', { name: '기존상회', type: 'customer', memo: '원래 메모' }, A.token);
  const b1 = (await newBatch(A.token)).json.data.id;
  const files1 = {
    partner: await xlsx('partner', [
      pRow('판매처A', '판매처', { limit: 300000, code: 'C-A' }),
      pRow('생산자B', '생산자', { origin: '전남 해남', code: 'C-B' }),
      pRow('같은시장C', '같은 시장', { code: 'C-C' }),
      pRow('기존상회', '판매처', { code: 'C-OLD' }),
    ]),
    product: await xlsx('product', [['이관품목P', '박스', '채소', '', '', '', 'P-1', 'N']]),
    opening_ar: await xlsx('opening_ar', [
      ['C-A', 300000, '2026-10-01', 'S-001', ''],
      ['판매처A', 200000, '2026-10-20', 'S-002', ''],
      ['같은시장C', 100000, '2026-10-15', 'S-003', ''],
    ]),
    opening_ap: await xlsx('opening_ap', [['생산자B', 400000, '2026-10-10', 'B-001', ''], ['C-C', 50000, '2026-10-12', 'B-002', '']]),
    opening_stock: await xlsx('opening_stock', [
      ['P-1', 10, 10000, '2026-10-05', '생산자B', '생산자B', '', 'L-001', ''],
      ['이관품목P', 5, 12000, '2026-10-25', '생산자B', '', '', 'L-002', ''],
    ]),
    history: await xlsx('history', [
      ['매출', '2026-09-01', '판매처A', '이관품목P', 2, 15000, '', 20000, 'H-1', ''],
      ['매출', '2026-09-02', '판매처A', '이관품목P', 1, 15000, '', '', 'H-2', ''],
      ['매출', '2026-09-03', '옛거래처', '', '', '', 50000, '', 'H-3', ''],
      ['수금', '2026-09-10', '판매처A', '', '', '', 30000, '', 'H-4', ''],
      ['수금', '2026-09-11', '옛거래처', '', '', '', 50000, '', 'H-5', ''],
    ]),
    disposal: await xlsx('disposal', [['2026-10-29', 'P-1', 3, '무름', ''], [D, '이관품목P', 2, '시듦', '']]),
  };
  for (const k of KINDS) {
    const r = await upload(A.token, b1, k, files1[k]);
    if (r.status !== 201) check(`파일 올리기 ${k}`, false, r.json);
  }
  // AC-403-06 같은 대상 다시 올리면 교체
  {
    const tmp = await xlsx('product', [['임시', '', '', '', '', '', '', 'N'], ['임시2', '', '', '', '', '', '', 'N']]);
    await upload(A.token, b1, 'product', tmp);
    const r = await upload(A.token, b1, 'product', files1.product);
    const det = await json('GET', `/api/migrations/${b1}`, null, A.token);
    const pf = det.json.data.files.filter((f) => f.kind === 'product');
    check('AC-403-06 같은 대상 두 번 올림 → 교체(파일 1개, 줄 수 갱신)', r.status === 201 && pf.length === 1 && pf[0].row_count === 1, det.json.data.files);
  }
  const before1 = await countsOf(A.uid);
  const v1 = await validate(A.token, b1);
  const after1 = await countsOf(A.uid);
  check('AC-403-07 7종 정상 검증 → 오류 0, 대상별 합계, DB 거래·잔액 0건(롤백)',
    v1.status === 200 && v1.json.summary.errors === 0 && v1.json.summary.counts.opening_ar.amount === 600000 && JSON.stringify(before1) === JSON.stringify(after1),
    { s: v1.status, summary: v1.json && v1.json.summary, before1, after1, errs: KINDS.flatMap((k) => errLines(v1, k)) });
  check('AC-403-20(검증) 미등록 거래처 과거 거래 → 경고·이름만', rowsOf(v1, 'history').filter((r) => r.warning).length === 2, rowsOf(v1, 'history'));
  check('AC-403-25 한도 30만 판매처에 기초 미수 50만 → 경고 "한도 초과 거래처 1곳"', (v1.json.warnings || []).some((w) => w.code === 'CREDIT_OVER' && /1곳/.test(w.message)), v1.json.warnings);
  const c1n = await commit(A.token, b1, false);
  check('AC-403-09 경고가 있으면 확인 없이 저장 → 409 CONFIRM_REQUIRED', c1n.status === 409 && c1n.json.code === 'CONFIRM_REQUIRED', c1n.json);
  const t0 = Date.now();
  const c1 = await commit(A.token, b1, true);
  check('AC-403-09 경고 확인하고 저장 → 201 saved', c1.status === 201 && c1.json.saved === true, c1.json && (c1.json.code || c1.json.message));
  console.log(`  (주 묶음 저장 ${Date.now() - t0}ms)`);

  const pA = await pid(A.uid, '판매처A');
  const pB = await pid(A.uid, '생산자B');
  const pC = await pid(A.uid, '같은시장C');
  const pOld = await pid(A.uid, '기존상회');
  const prP = await prodId('이관품목P', A.uid);
  {
    const acc = await q(`SELECT name, migration_batch_id, external_code, memo FROM account WHERE user_id = $1 ORDER BY id`, [A.uid]);
    const made = acc.filter((a) => String(a.migration_batch_id) === String(b1));
    const old = acc.find((a) => a.name === '기존상회');
    check('AC-403-10 새 거래처 3(묶음 표시) + 기존 1(기존 사용, 다른 칸 불변, 코드만 채움)',
      made.length === 3 && old && old.migration_batch_id == null && old.memo === '원래 메모' && old.external_code === 'C-OLD', acc);
  }
  check('AC-403-14 판매처A 기초 미수 50만', (await receivable(A.uid, pA)) === 500000, await receivable(A.uid, pA));
  {
    const ag = await json('GET', `/api/receivables/aging?partner_id=${pA}`, null, A.token);
    const led = await json('GET', `/api/partners/${pA}/ledger`, null, A.token);
    const ent = (led.json && led.json.data && (led.json.data.entries || led.json.data.rows)) || [];
    const op = ent.filter((e) => e.kind_label === '이관 기초');
    const agText = JSON.stringify(ag.json);
    check('AC-403-14 받을 돈 원장 두 줄 "이관 기초"(원래 매출일)', op.length === 2 && op[0].date === '2026-10-01' && op[1].date === '2026-10-20', { status: led.status, op, keys: led.json && Object.keys(led.json.data || {}) });
    check('AC-403-14 미수 연령이 원래 매출일 기준(가장 오래된 10-01)', ag.status === 200 && /2026-10-01/.test(agText), agText.slice(0, 400));
  }
  check('AC-403-17 생산자B 기초 미지급 40만', (await payable(A.uid, pB)) === 400000, await payable(A.uid, pB));
  {
    const led = await json('GET', `/api/partners/${pB}/payable-ledger`, null, A.token);
    const d = led.json && led.json.data;
    const ent = (d && (d.entries || d.rows)) || [];
    check('AC-403-17 줄 돈 원장 "이관 기초" + 원장 잔액 = 매입 기준 미지급(이관 재고는 원장에 없음)',
      led.status === 200 && ent.some((e) => e.kind_label === '이관 기초') && !ent.some((e) => /이관 재고/.test(e.memo || '')) && d.check && d.check.diff === 0,
      { s: led.status, check: d && d.check, ent: ent.map((e) => [e.date, e.kind_label, e.increase]) });
    const lots = await q(`SELECT COUNT(*)::int n FROM inventory_lot_available WHERE user_id = $1 AND product_id = (SELECT id FROM product WHERE is_system)`, [A.uid]);
    check('AC-403-17·28 기초 미지급은 재고 로트가 아님(시스템 품목 로트 0)', lots[0].n === 0, lots);
  }
  check('AC-403-18·21 이관품목P 재고 = 15 − 기준일 이후 폐기 2 = 13', (await inv(A.uid, prP)) === 13, await inv(A.uid, prP));
  {
    const il = await json('GET', '/api/inventory', null, A.token);
    const row = ((il.json && il.json.data) || []).find((x) => x.product_id === prP);
    check('AC-403-18 재고현황 경과일 기준 = 10-05(가장 오래된 이관 로트)', row && row.aging_base_date === '2026-10-05', row);
    const pl = await json('GET', `/api/purchases?from_date=2026-10-01&to_date=2026-10-31`, null, A.token);
    const rows = (pl.json && pl.json.data) || [];
    check('AC-403-18·29 매입 목록: 이관 재고는 보임(entry_kind=opening_stock), 기초 미지급은 기본 숨김',
      rows.filter((r) => r.entry_kind === 'opening_stock').length === 2 && !rows.some((r) => r.entry_kind === 'opening_ap'), rows.map((r) => r.entry_kind));
    const pl2 = await json('GET', `/api/purchases?from_date=2026-10-01&to_date=2026-10-31&include_opening=1`, null, A.token);
    check('AC-403-29 매입 목록 include_opening=1 → 기초 미지급 보임', ((pl2.json && pl2.json.data) || []).filter((r) => r.entry_kind === 'opening_ap').length === 2);
    const sl = await json('GET', `/api/sales?from_date=2026-10-01&to_date=2026-10-31`, null, A.token);
    const sl2 = await json('GET', `/api/sales?from_date=2026-10-01&to_date=2026-10-31&include_opening=1`, null, A.token);
    check('AC-403-29 매출 목록 기본 숨김 / include_opening=1 이면 entry_mode=opening 3건',
      ((sl.json && sl.json.data) || []).length === 0 && ((sl2.json && sl2.json.data) || []).filter((r) => r.entry_mode === 'opening').length === 3,
      { a: sl.json && sl.json.data && sl.json.data.length, b: sl2.json && sl2.json.data && sl2.json.data.length });
  }
  {
    const h = await q(`SELECT kind, partner_id, partner_name FROM migration_history WHERE user_id = $1 ORDER BY line_no, id`, [A.uid]);
    check('AC-403-20·21 이관 기록 6행(과거 거래 5 + 기준일 전 폐기 1), 미등록 거래처는 이름만',
      h.length === 6 && h.filter((x) => x.partner_id == null && x.partner_name === '옛거래처').length === 2 && h.filter((x) => x.kind === 'disposal').length === 1, h);
    const d = await q(`SELECT disposal_date::text d, quantity::float q FROM disposal WHERE user_id = $1 AND migration_batch_id = $2`, [A.uid, b1]);
    check('AC-403-21 기준일 이후 폐기 → disposal 1건(재고 차감)', d.length === 1 && d[0].d === D && d[0].q === 2, d);
    const hl = await json('GET', `/api/migration-history?kind=sale`, null, A.token);
    check('AC-403-22(R-91) 이관 기록 조회 — 구분 필터 매출 3건', hl.status === 200 && hl.json.total === 3, hl.json);
  }
  // AC-403-23 매출 합계 제외 · 총미수 포함
  {
    const daily = await json('GET', `/api/reports/daily-purchase-sales?from_date=2026-10-01&to_date=2026-10-31`, null, A.token);
    const dRows = (daily.json && daily.json.data) || [];
    const dSales = dRows.reduce((t, r) => t + Number(r.sales_amount || 0), 0);
    const dPur = dRows.reduce((t, r) => t + Number(r.purchase_amount || 0), 0);
    const mo = await json('GET', '/api/reports/monthly?month=2026-10', null, A.token);
    const m = mo.json && mo.json.data;
    const dash = await json('GET', '/api/dashboard', null, A.token);
    const dashText = JSON.stringify(dash.json);
    check('AC-403-23 일별 보고서·월 정산 매출·매입 합계에 이관 행 없음(0)', daily.status === 200 && dSales === 0 && dPur === 0 && m && m.sales.amount === 0 && m.purchases.amount === 0,
      { daily: daily.status, dSales, dPur, sales: m && m.sales, purchases: m && m.purchases });
    check('AC-403-23 대시보드 총미수에 기초 미수 포함(60만)', dash.status === 200 && /600000/.test(dashText), dashText.slice(0, 300));
    const rv = m.balances.receivable;
    const pv = m.balances.payable;
    const recvOk = Math.round((rv.closing - rv.opening) * 100) === Math.round((m.sales.amount + m.opening_receivable.amount - m.returns.amount - m.receipts.amount - m.sale_discounts.amount - m.offsets.amount + m.refund_payments.amount + m.discount_reversals.amount) * 100);
    const payOk = Math.round((pv.closing - pv.opening) * 100) === Math.round((m.purchases.amount + m.opening_payable.amount - m.payments.amount - m.payments.opening_amount - m.payments.discount_amount - m.payments.offset_amount) * 100);
    check('AC-403-24 10월 월 정산 opening_receivable=60만·opening_payable=45만, 항등식 성립',
      m.opening_receivable.amount === 600000 && m.opening_payable.amount === 450000 && recvOk && payOk, { or: m.opening_receivable, op: m.opening_payable, rv, pv, recvOk, payOk });
    const mo9 = await json('GET', '/api/reports/monthly?month=2026-09', null, A.token);
    check('AC-403-24 9월 월 정산 "이관 기록(참고)" 구분별 합(매출 3·수금 2)', (mo9.json.data.history || []).some((h) => h.kind === 'sale' && h.count === 3) && (mo9.json.data.history || []).some((h) => h.kind === 'receipt' && h.count === 2), mo9.json.data.history);
  }
  // AC-403-26 정정·반품 거부 / AC-403-27 시스템 품목 / AC-403-28 전환 거부
  {
    const os = (await q(`SELECT id FROM sale WHERE user_id = $1 AND entry_mode = 'opening' ORDER BY id LIMIT 1`, [A.uid]))[0].id;
    const ostk = (await q(`SELECT id FROM purchase WHERE user_id = $1 AND entry_kind = 'opening_stock' ORDER BY id LIMIT 1`, [A.uid]))[0].id;
    const oap = (await q(`SELECT id FROM purchase WHERE user_id = $1 AND entry_kind = 'opening_ap' ORDER BY id LIMIT 1`, [A.uid]))[0].id;
    const r1 = await json('PATCH', `/api/sales/${os}`, { unit_price: 1, reason: 'x' }, A.token);
    const r2 = await json('POST', `/api/sales/${os}/cancel`, { reason: 'x' }, A.token);
    const r3 = await json('POST', `/api/sales/${os}/refund`, { quantity: 1, reason: 'x' }, A.token);
    const r4 = await json('POST', `/api/purchases/${ostk}/cancel`, { reason: 'x' }, A.token);
    const r5 = await json('PATCH', `/api/purchases/${oap}`, { unit_price: 1, reason: 'x' }, A.token);
    check('AC-403-26 이관 행 정정·취소·반품 → 409 MIGRATION_ROW(5가지)',
      [r1, r2, r3, r4, r5].every((r) => r.status === 409 && r.json.code === 'MIGRATION_ROW'), [r1, r2, r3, r4, r5].map((r) => [r.status, r.json && r.json.code]));
    const pl = await json('GET', '/api/products', null, A.token);
    check('AC-403-27 품목 목록에 시스템 품목 없음', !((pl.json && pl.json.data) || []).some((p) => p.name === '이관 기초 잔액'));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('입력');
    ws.addRow(['매입일', '제공처', '품목', '수량', '단가']);
    ws.addRow([today, '생산자B', '이관 기초 잔액', 1, 1000]);
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from(await wb.xlsx.writeBuffer())]), 'x.xlsx');
    const xr = await fetch(`${BASE}/api/excel/purchase/preview`, { method: 'POST', headers: { authorization: `Bearer ${A.token}` }, body: fd });
    const xj = await xr.json();
    check('AC-403-27 엑셀 업로드에 "이관 기초 잔액" 쓰면 줄 오류', xr.status === 200 && xj.summary.errors === 1, xj);
    const cv = await json('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: oap, partner_id: pA, quantity: 1, unit_price: 1, sale_date: today }] }, A.token);
    check('AC-403-28 기초 미지급을 판매로 전환 → 거부(409)', cv.status === 409, cv.json);
  }

  // ---------- 4. 이관 직후 실제 거래 (AC-403-31~34) ----------
  const lot1 = (await q(`SELECT id FROM purchase WHERE user_id = $1 AND entry_kind = 'opening_stock' AND purchase_date = '2026-10-05'`, [A.uid]))[0].id;
  {
    const r = await json('POST', '/api/sales', { partner_id: pA, sale_date: today, items: [{ product_id: prP, quantity: 4, unit_price: 30000 }], credit_confirmed: true }, A.token);
    const sid = r.json && r.json.data && r.json.data.sales && (r.json.data.sales[0].sale_id || r.json.data.sales[0].id);
    const al = sid ? await q(`SELECT purchase_id, quantity::float q FROM purchase_allocation WHERE sale_id = $1`, [sid]) : [];
    const s = sid ? (await q(`SELECT cost_at_sale::float c FROM sale WHERE id = $1`, [sid]))[0] : null;
    check('AC-403-31 재고 판매 4개 → 10-05 이관 로트에서 배분(원가 = 이관 원가 1만), 미수 50만 + 12만',
      r.status === 201 && al.length === 1 && al[0].purchase_id === lot1 && al[0].q === 4 && (await receivable(A.uid, pA)) === 620000 && (!s || s.c == null || s.c === 10000 || s.c === 40000),
      { s: r.status, j: r.json, al, cost: s });
  }
  {
    const un = await json('GET', `/api/sales?unpaid_only=1&partner_id=${pA}`, null, A.token);
    const list = ((un.json && un.json.data) || []).slice().sort((a, b) => (String(a.sale_date) < String(b.sale_date) ? -1 : String(a.sale_date) > String(b.sale_date) ? 1 : a.id - b.id));
    let left = 600000;
    const allocations = [];
    for (const s of list) {
      if (left <= 0) break;
      const take = Math.min(left, Number(s.unpaid_amount));
      allocations.push({ sale_id: s.id, amount: take });
      left -= take;
    }
    const r = await json('POST', '/api/payments', { partner_id: pA, amount: 600000, paid_at: today, allocations }, A.token);
    const order = list.map((s) => s.entry_mode);
    check('AC-403-32 판매처A 60만 수금(오래된 순 배분): 10-01 이관 30만 → 10-20 이관 20만 → 새 매출 10만, 미수 2만 남음',
      r.status === 201 && order.join(',') === 'opening,opening,fifo' && allocations.map((a) => a.amount).join(',') === '300000,200000,100000' && (await receivable(A.uid, pA)) === 20000,
      { s: r.status, j: r.json, order, allocations, rv: await receivable(A.uid, pA) });
  }
  {
    // 같은시장C: 기초 미수 10만 · 기초 미지급 5만 → 할인 1만 · 상계 5만
    const un = await json('GET', `/api/sales?unpaid_only=1&partner_id=${pC}`, null, A.token);
    const s0 = ((un.json && un.json.data) || [])[0];
    const dsc = await json('POST', '/api/payments', { partner_id: pC, amount: 10000, paid_at: today, entry_kind: 'discount', allocations: [{ sale_id: s0.id, amount: 10000 }] }, A.token);
    const off = await json('POST', '/api/offsets', { partner_id: pC, amount: 50000, offset_at: today }, A.token);
    const led = await json('GET', `/api/partners/${pC}/ledger`, null, A.token);
    const ent = (led.json && led.json.data && (led.json.data.entries || led.json.data.rows)) || [];
    const lastBal = ent.length ? ent[ent.length - 1].balance : null;
    check('AC-403-33 이관 기초 미수에 할인 1만·상계 5만 → 미수 4만, 미지급 0, 원장 잔액 = 미수',
      dsc.status === 201 && off.status === 201 && (await receivable(A.uid, pC)) === 40000 && (await payable(A.uid, pC)) === 0 && lastBal === 40000,
      { d: [dsc.status, dsc.json && dsc.json.message], o: [off.status, off.json && off.json.message], rv: await receivable(A.uid, pC), pv: await payable(A.uid, pC), lastBal });
  }
  {
    const r = await json('POST', '/api/supplier-payments', { partner_id: pB, amount: 400000, paid_at: today, kind: 'pay', method: 'transfer' }, A.token);
    const led = await json('GET', `/api/partners/${pB}/payable-ledger`, null, A.token);
    const ck = led.json && led.json.data && led.json.data.check;
    check('AC-403-34 생산자B 40만 자동 지급 → 미지급 0, ledger_balance = purchase_based_due = 0',
      r.status === 201 && (await payable(A.uid, pB)) === 0 && ck && ck.ledger_balance === 0 && ck.purchase_based_due === 0, { s: r.status, j: r.json, ck });
  }
  // ---------- 대조 리포트 (AC-403-50~52) ----------
  {
    const rc = await json('GET', `/api/migrations/${b1}/reconcile`, null, A.token);
    const d = rc.json && rc.json.data;
    const sumRows = (d && d.summary) || [];
    check('AC-403-50·52 대조: 미수·미지급·재고 모든 줄 차이 0, 파일 줄 수 = 저장+기존+기록(거래 뒤에도)',
      rc.status === 200 && d.all_zero === true && d.receivable.rows.every((r) => r.diff === 0) && d.payable.rows.every((r) => r.diff === 0)
      && d.stock.rows.every((r) => r.diff_qty === 0 && r.diff_amount === 0) && sumRows.every((s) => s.matched),
      d);
    const rowA = d.receivable.rows.find((r) => r.partner_id === pA);
    check('AC-403-52 "현재 잔액"만 이후 거래를 반영(판매처A 파일 50만 = 저장 50만, 현재 0 또는 −)', rowA && rowA.file_amount === 500000 && rowA.saved_amount === 500000 && rowA.current !== 500000, rowA);
    const xr = await fetch(`${BASE}/api/migrations/${b1}/reconcile?format=xlsx`, { headers: { authorization: `Bearer ${A.token}` } });
    const wb = new ExcelJS.Workbook();
    let names = [];
    let total = null;
    try {
      await wb.xlsx.load(Buffer.from(await xr.arrayBuffer()));
      names = wb.worksheets.map((w) => w.name);
      const ws = wb.getWorksheet('기초 미수');
      const last = ws.getRow(ws.actualRowCount);
      total = last.getCell(3).value;
    } catch { /* */ }
    check('AC-403-51 엑셀 받기: 시트 4개(요약·기초 미수·기초 미지급·기초 재고), 합계가 화면과 같음',
      xr.status === 200 && names.join(',') === '요약,기초 미수,기초 미지급,기초 재고' && Number(total) === d.receivable.total.file_amount, { names, total, screen: d.receivable.total });
  }
  // ---------- 되돌리기 막힘 (AC-403-41·42) ----------
  {
    const ck = await json('GET', `/api/migrations/${b1}/rollback-check`, null, A.token);
    const types = ((ck.json && ck.json.data && ck.json.data.blockers) || []).map((b) => b.type);
    const rb = await json('POST', `/api/migrations/${b1}/rollback`, { reason: '테스트' }, A.token);
    check('AC-403-41·42 수금 배분·판매 배분 뒤 되돌리기 → 409 ROLLBACK_BLOCKED (payment_allocation·purchase_allocation)',
      ck.json.data.can_rollback === false && types.includes('payment_allocation') && types.includes('purchase_allocation') && rb.status === 409 && rb.json.code === 'ROLLBACK_BLOCKED',
      { types, rb: rb.json && rb.json.code });
  }
  // ---------- 기준일 다른 묶음 (AC-403-04) ----------
  {
    const r1 = await newBatch(A.token, '2026-11-15');
    const r2 = await newBatch(A.token, addDays(today, 1));
    check('AC-403-04 저장 묶음과 다른 기준일 → 400 CUTOVER_MISMATCH / 내일 → 400', r1.status === 400 && r1.json.code === 'CUTOVER_MISMATCH' && r2.status === 400, [r1.json, r2.json]);
  }
  // ---------- 두 번 이관 (AC-403-30·35·36) ----------
  {
    const b2 = (await newBatch(A.token)).json.data.id;
    const dup = await upload(A.token, b2, 'opening_ar', files1.opening_ar);
    check('AC-403-30 다른 묶음에 같은 파일 → 409 DUPLICATE_FILE', dup.status === 409 && dup.json.code === 'DUPLICATE_FILE', dup.json);
    await upload(A.token, b2, 'opening_ar', await xlsx('opening_ar', [['판매처A', 1000, '2026-10-02', 'S-001', ''], ['판매처A', 2000, '2026-10-03', 'S-009', '']]));
    const v = await validate(A.token, b2);
    const e = errLines(v, 'opening_ar');
    check('AC-403-35 저장된 원 전표번호 S-001 다시 → 줄 오류', e.length === 1 && /S-001/.test(e[0].message), rowsOf(v, 'opening_ar'));
    await upload(A.token, b2, 'opening_ar', await xlsx('opening_ar', [['판매처A', 2000, '2026-10-03', 'S-009', '']]));
    const v2 = await validate(A.token, b2);
    check('AC-403-36 이미 기초 미수가 있는 거래처 추가 → 경고 DM-03', v2.json.summary.errors === 0 && (v2.json.warnings || []).some((w) => w.code === 'DM03_ALREADY_MIGRATED'), v2.json.warnings);
    const c = await commit(A.token, b2, true);
    check('AC-403-36 확인하면 저장 201', c.status === 201, c.json && c.json.code);
  }

  // ---------- 5. 되돌리기 정상 (AC-403-40) · 같은 파일 다시 (AC-403-30 후반) ----------
  const R = await mkUser('r');
  await json('POST', '/api/partners', { name: '코드없는곳', type: 'customer' }, R.token);
  const rPart = (await json('POST', '/api/partners', { name: '정상매입처', type: 'supplier' }, R.token)).json.data.id;
  const hongId = await prodId('홍고추', R.uid);
  await json('POST', '/api/purchases', { partner_id: rPart, product_id: hongId, quantity: 7, unit_price: 1000, purchase_date: today }, R.token);
  const snap = async () => JSON.stringify({
    c: await countsOf(R.uid),
    rv: await q(`SELECT partner_id, receivable_amount FROM receivables_by_partner WHERE user_id = $1 ORDER BY 1`, [R.uid]),
    pv: await q(`SELECT partner_id, payable_amount FROM payables_by_partner WHERE user_id = $1 ORDER BY 1`, [R.uid]),
    led: await q(`SELECT partner_id, SUM(increase - decrease) s FROM partner_ledger_entry WHERE user_id = $1 GROUP BY 1 ORDER BY 1`, [R.uid]),
    inv: await q(`SELECT product_id, quantity FROM inventory WHERE user_id = $1 ORDER BY 1`, [R.uid]),
    codes: await q(`SELECT id, external_code FROM account WHERE user_id = $1 ORDER BY 1`, [R.uid]),
  });
  const s0 = await snap();
  const rb1 = (await newBatch(R.token)).json.data.id;
  const rFiles = {
    partner: await xlsx('partner', [pRow('코드없는곳', '판매처', { code: 'R-1' }), pRow('새판매처', '판매처', { code: 'R-2' }), pRow('새매입처', '매입처')]),
    product: await xlsx('product', [['R품목', '', '', '', '', '', 'RP-1', 'N']]),
    opening_ar: await xlsx('opening_ar', [['R-2', 70000, '', '', ''], ['R-1', 10000, '2026-10-01', '', '']]),
    opening_ap: await xlsx('opening_ap', [['새매입처', 30000, '2026-10-01', '', '']]),
    opening_stock: await xlsx('opening_stock', [['RP-1', 3, 1000, '2026-10-01', '새매입처', '', '', '', ''], ['홍고추', 2, 900, '2026-10-02', '새매입처', '', '', '', '']]),
    disposal: await xlsx('disposal', [[D, '홍고추', 1, '', '']]),
    history: await xlsx('history', [['지급', '2026-10-01', '새매입처', '', '', '', 5000, '', '', '']]),
  };
  for (const k of KINDS) await upload(R.token, rb1, k, rFiles[k]);
  const rv = await validate(R.token, rb1);
  check('AC-403-15 원래 매출일 비움 → 기준일 전날로 + 경고', rowsOf(rv, 'opening_ar')[0].ok && /기준일 전날/.test(rowsOf(rv, 'opening_ar')[0].warning || '') && rowsOf(rv, 'opening_ar')[0].summary.includes(DM1), rowsOf(rv, 'opening_ar'));
  const rc = await commit(R.token, rb1, true);
  check('AC-403-40 준비: 저장 201', rc.status === 201, rc.json && (rc.json.code || rc.json.message));
  const ck = await json('GET', `/api/migrations/${rb1}/rollback-check`, null, R.token);
  const auditBefore = Number((await q(`SELECT COUNT(*) n FROM audit_log WHERE user_id = $1 AND entity_type = 'migration'`, [R.uid]))[0].n);
  const rr = await json('POST', `/api/migrations/${rb1}/rollback`, { reason: '금액 오타' }, R.token);
  const s1 = await snap();
  const auditAfter = await q(`SELECT action FROM audit_log WHERE user_id = $1 AND entity_type = 'migration' ORDER BY id`, [R.uid]);
  const st = (await q(`SELECT status FROM migration_batch WHERE id = $1`, [rb1]))[0].status;
  check('AC-403-40 저장 직후 되돌리기 → 재고·미수·미지급·원장·코드가 저장 전과 같음, rolled_back, 변경 이력(migrate·rollback)',
    ck.json.data.can_rollback === true && rr.status === 200 && s0 === s1 && st === 'rolled_back' && auditBefore === 1 && auditAfter.map((x) => x.action).join(',') === 'migrate,rollback',
    { rr: rr.json, same: s0 === s1, s0: s0.slice(0, 400), s1: s1.slice(0, 400), st, auditAfter });
  {
    const h = await json('GET', '/api/history?kind=data_migration', null, R.token);
    check('R-변경이력 /api/history 에 "데이터 이관" 2줄', h.status === 200 && (h.json.data || []).length === 2 && /데이터 이관/.test(JSON.stringify(h.json.data)), h.json);
    const rb2 = (await newBatch(R.token)).json.data.id;
    const again = await upload(R.token, rb2, 'opening_ar', rFiles.opening_ar);
    check('AC-403-30 되돌린 뒤 같은 파일 다시 올리기 → 201', again.status === 201, again.json);
    const rbAgain = await json('POST', `/api/migrations/${rb1}/rollback`, { reason: 'x' }, R.token);
    check('되돌린 묶음 다시 되돌리기 → 409', rbAgain.status === 409, rbAgain.json);
  }

  // ---------- 6. 오류·경고·경계 (AC-403-08·11·12·15·16·19·22·38) ----------
  const E = await mkUser('e');
  await json('POST', '/api/partners', { name: '코드주인', type: 'customer' }, E.token);
  const eb0 = (await newBatch(E.token)).json.data.id;
  await upload(E.token, eb0, 'partner', await xlsx('partner', [pRow('코드주인', '판매처', { code: 'X-1' })]));
  await commit(E.token, eb0, true);
  const ePart = (await json('POST', '/api/partners', { name: '일반매입처', type: 'supplier' }, E.token)).json.data.id;
  await json('POST', '/api/purchases', { partner_id: ePart, product_id: await prodId('청양고추', E.uid), quantity: 1, unit_price: 100, purchase_date: '2026-10-20' }, E.token);
  const eb = (await newBatch(E.token)).json.data.id;
  await upload(E.token, eb, 'partner', await xlsx('partner', [pRow('딴이름', '판매처', { code: 'X-1' }), pRow('중복', '판매처'), pRow('중복', '판매처'), pRow('매입처M', '매입처')]));
  await upload(E.token, eb, 'product', await xlsx('product', [['공용시도', '', '', '', '', '', '', 'Y'], ['이관 기초 잔액', '', '', '', '', '', '', 'N']]));
  await upload(E.token, eb, 'opening_ar', await xlsx('opening_ar', [['코드주인', 1000, D, '', ''], ['매입처M', 1000, '2026-10-01', '', ''], ['코드주인', -5, '2026-10-01', '', '']]));
  await upload(E.token, eb, 'opening_stock', await xlsx('opening_stock', [['홍고추', 1, 100, D, '매입처M', '', '', '', ''], ['홍고추', 2, 100, '2026-10-01', '매입처M', '', '', '', '']]));
  await upload(E.token, eb, 'disposal', await xlsx('disposal', [[D, '홍고추', 5, '', ''], [addDays(today, 1), '홍고추', 1, '', '']]));
  const eBefore = await countsOf(E.uid);
  const ev = await validate(E.token, eb);
  const pe = rowsOf(ev, 'partner');
  check('AC-403-11 기존 코드가 다른 거래처와 같음 / 같은 파일 같은 이름 둘째 줄 → 줄 오류', !pe[0].ok && /X-1/.test(pe[0].message) && pe[1].ok && !pe[2].ok && /같은 파일/.test(pe[2].message), pe);
  const pr = rowsOf(ev, 'product');
  check('AC-403-12 비관리자 공용=Y → 줄 오류 "공용 품목은 관리자만"', !pr[0].ok && /관리자만/.test(pr[0].message), pr);
  check('AC-403-27 이관 품목 파일에 "이관 기초 잔액" → 줄 오류', !pr[1].ok && /시스템 품목/.test(pr[1].message), pr);
  const ar = rowsOf(ev, 'opening_ar');
  check('AC-403-15 원래 매출일 = 기준일 → 줄 오류(경계)', !ar[0].ok && /기준일/.test(ar[0].message), ar[0]);
  check('AC-403-16 매입처(supplier)에 기초 미수 → 줄 오류', !ar[1].ok && /판매 거래처/.test(ar[1].message), ar[1]);
  check('U-403-07 음수 미수(선수금) → 줄 오류', !ar[2].ok, ar[2]);
  const sk = rowsOf(ev, 'opening_stock');
  check('AC-403-19 입고일 = 기준일 → 줄 오류(경계)', !sk[0].ok && /기준일/.test(sk[0].message) && sk[1].ok, sk);
  const dp = rowsOf(ev, 'disposal');
  check('AC-403-22 기준일 이후 폐기 수량 > 이관 재고 / 폐기일 > 오늘 → 줄 오류', !dp[0].ok && /재고/.test(dp[0].message) && !dp[1].ok && /오늘/.test(dp[1].message), dp);
  check('AC-403-38 기준일 이전 일반 매입 1건 → 경고 DM-07', (ev.json.warnings || []).some((w) => w.code === 'DM07_PRE_CUTOVER' && /1건/.test(w.message)), ev.json.warnings);
  const ec = await commit(E.token, eb, true);
  const eAfter = await countsOf(E.uid);
  check('AC-403-08 오류가 있으면 저장 → 400, 아무것도 저장 안 됨', ec.status === 400 && ec.json.code === 'HAS_ERRORS' && JSON.stringify(eBefore) === JSON.stringify(eAfter), { s: ec.status, eBefore, eAfter });
  {
    const det = await json('GET', `/api/migrations/${eb}`, null, E.token);
    check('검증 결과가 묶음에 남음(다시 열면 보임)', det.json.data.files.some((f) => Array.isArray(f.result) && f.result.some((r) => !r.ok)), det.json.data.files.map((f) => f.kind));
  }
  // AC-403-37 동시 저장
  {
    const cb = (await newBatch(E.token)).json.data.id;
    await upload(E.token, cb, 'opening_ar', await xlsx('opening_ar', [['코드주인', 1234, '2026-10-05', 'CC-1', '']]));
    const [x, y] = await Promise.all([commit(E.token, cb, true), commit(E.token, cb, true)]);
    const n = Number((await q(`SELECT COUNT(*) n FROM sale WHERE user_id = $1 AND migration_batch_id = $2`, [E.uid, cb]))[0].n);
    const sts = [x.status, y.status].sort();
    check('AC-403-37 같은 묶음 commit 두 번 동시 → 하나만 201, 다른 하나 409, 저장 1건', sts[0] === 201 && sts[1] === 409 && n === 1, { sts, codes: [x.json.code, y.json.code], n });
  }
  // AC-403-43 묶음이 만든 거래처로 일반 매입 → 되돌리기 막힘 / AC-403-45 수금 취소 뒤에도 막힘
  {
    const gb = (await newBatch(E.token)).json.data.id;
    await upload(E.token, gb, 'partner', await xlsx('partner', [pRow('G매입처', '매입처'), pRow('G판매처', '판매처')]));
    await upload(E.token, gb, 'opening_ar', await xlsx('opening_ar', [['G판매처', 5000, '2026-10-05', '', '']]));
    await commit(E.token, gb, true);
    const gp = await pid(E.uid, 'G매입처');
    const gs = await pid(E.uid, 'G판매처');
    await json('POST', '/api/purchases', { partner_id: gp, product_id: await prodId('청양고추', E.uid), quantity: 1, unit_price: 100, purchase_date: today }, E.token);
    const os = (await q(`SELECT id FROM sale WHERE user_id = $1 AND migration_batch_id = $2`, [E.uid, gb]))[0].id;
    // 현금 수금은 취소할 수 없는 구조라(기존 규칙) 취소 가능한 매출 할인으로 "배분 뒤 취소"를 만든다
    const pay = await json('POST', '/api/payments', { partner_id: gs, amount: 1000, paid_at: today, entry_kind: 'discount', allocations: [{ sale_id: os, amount: 1000 }] }, E.token);
    const cancel = await json('POST', `/api/payments/${pay.json.data.id}/cancel`, { reason: '테스트' }, E.token);
    const r = await json('POST', `/api/migrations/${gb}/rollback`, { reason: 'x' }, E.token);
    const types = ((r.json && r.json.blockers) || []).map((b) => b.type);
    check('AC-403-43 묶음이 만든 거래처로 일반 매입 → 409(partner_used)', r.status === 409 && types.includes('partner_used'), { s: r.status, types });
    check('AC-403-45 수금 후 그 수금을 취소해도 → 409(배분 행 남음, U-403-09)', cancel.status === 200 && types.includes('payment_allocation'), { cancel: [cancel.status, cancel.json && cancel.json.message], types });
  }

  // ---------- 7. 관리자 공용 품목 (AC-403-13·44) ----------
  {
    const adm = (await json('POST', '/api/auth/login', { agent_no: 'admin001', password: ADMIN_PW })).json;
    const AT = adm && adm.token;
    if (!AT) check('관리자 로그인(SEED_ADMIN_PASSWORD)', false, adm);
    else {
      const admUid = (await q(`SELECT id FROM "user" WHERE agent_no = 'admin001'`))[0].id;
      const cut = (await q(`SELECT cutover_date::text d FROM migration_batch WHERE user_id = $1 AND status = 'saved' LIMIT 1`, [admUid]))[0];
      const ab = (await newBatch(AT, cut ? cut.d : D)).json.data.id;
      const pname = `공용이관품목_${tag}`;
      await upload(AT, ab, 'product', await xlsx('product', [[pname, '10kg', '채소', '', '', '', `PUB-${tag}`, 'Y']]));
      const c = await commit(AT, ab, true);
      const prow = (await q(`SELECT id, owner_user_id FROM product WHERE name = $1`, [pname]))[0];
      const other = await json('GET', '/api/products', null, O.token);
      check('AC-403-13 관리자 공용=Y → owner NULL 품목, 다른 회원 품목 목록에 보임',
        c.status === 201 && prow && prow.owner_user_id == null && ((other.json && other.json.data) || []).some((p) => p.name === pname), { c: c.status, prow });
      const oPart = (await json('POST', '/api/partners', { name: '오매입처', type: 'supplier' }, O.token)).json.data.id;
      await json('POST', '/api/purchases', { partner_id: oPart, product_id: prow.id, quantity: 1, unit_price: 100, purchase_date: today }, O.token);
      const r = await json('POST', `/api/migrations/${ab}/rollback`, { reason: 'x' }, AT);
      check('AC-403-44 관리자 묶음이 만든 공용 품목을 다른 회원이 매입 → 되돌리기 409', r.status === 409 && ((r.json.blockers || []).some((b) => b.type === 'product_used')), r.json);
    }
  }

  // ---------- 8. 권한 (AC-403-60·61) ----------
  {
    const routes = [
      ['GET', '/api/migrations/template/partner'], ['GET', '/api/migrations'], ['POST', '/api/migrations'], ['GET', `/api/migrations/${b1}`],
      ['DELETE', `/api/migrations/${b1}`], ['POST', `/api/migrations/${b1}/files/partner`], ['DELETE', `/api/migrations/${b1}/files/partner`],
      ['POST', `/api/migrations/${b1}/validate`], ['POST', `/api/migrations/${b1}/commit`], ['GET', `/api/migrations/${b1}/rollback-check`],
      ['POST', `/api/migrations/${b1}/rollback`], ['GET', `/api/migrations/${b1}/reconcile`], ['GET', '/api/migration-history'],
    ];
    const bad = [];
    for (const [m, p] of routes) {
      for (const [who, t] of [['input', SI], ['view', SV]]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await json(m, p, m === 'GET' || m === 'DELETE' ? null : {}, t);
        if (!(r.status === 403 && ['ROUTE_NOT_ALLOWED', 'FORBIDDEN_ROLE'].includes(r.json && r.json.code))) bad.push([who, m, p, r.status, r.json && r.json.code]);
      }
    }
    check('AC-403-60 입력·조회 직원 → R-79~91 전부 403', bad.length === 0, bad);
    const me = await json('GET', '/api/me', null, A.token);
    const meS = await json('GET', '/api/me', null, SI);
    const allowOf = (x) => JSON.stringify(x.json);
    check('AC-403-70(서버) /api/me — 주인 allow 에 migration, 직원에는 없음', /"migration"/.test(allowOf(me)) && !/"migration"/.test(allowOf(meS)), { me: allowOf(me).slice(0, 200) });
    const others = [];
    for (const [m, p] of [['GET', `/api/migrations/${b1}`], ['POST', `/api/migrations/${b1}/commit`], ['POST', `/api/migrations/${b1}/rollback`], ['GET', `/api/migrations/${b1}/reconcile`], ['POST', `/api/migrations/${b1}/validate`]]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await json(m, p, m === 'GET' ? null : { reason: 'x' }, O.token);
      if (r.status !== 404) others.push([m, p, r.status]);
    }
    check('AC-403-61 다른 회원의 묶음 → 404', others.length === 0, others);
  }

  // ---------- 9. 대용량 (AC-403-63·64) ----------
  const perf = {};
  {
    const L = await mkUser('l');
    const lb = (await newBatch(L.token)).json.data.id;
    const N = 1000;
    const prt = [];
    for (let i = 1; i <= 50; i += 1) prt.push(pRow(`대량판매처${i}`, '판매처', { code: `LC-${i}` }));
    prt.push(pRow('대량매입처', '매입처', { code: 'LS-1' }));
    const prd = [];
    for (let i = 1; i <= 20; i += 1) prd.push([`대량품목${i}`, '', '', '', '', '', `LP-${i}`, 'N']);
    const arRows = [];
    let arSum = 0;
    for (let i = 1; i <= N; i += 1) {
      const amt = 1000 + (i % 97) * 10;
      arSum += amt;
      arRows.push([`LC-${(i % 50) + 1}`, amt, addDays('2026-08-01', i % 90), `LAR-${i}`, '']);
    }
    const stRows = [];
    for (let i = 1; i <= N; i += 1) stRows.push([`LP-${(i % 20) + 1}`, (i % 7) + 1, 500 + (i % 13), addDays('2026-08-01', i % 90), 'LS-1', '', '', `LST-${i}`, '']);
    await upload(L.token, lb, 'partner', await xlsx('partner', prt));
    await upload(L.token, lb, 'product', await xlsx('product', prd));
    await upload(L.token, lb, 'opening_ar', await xlsx('opening_ar', arRows));
    await upload(L.token, lb, 'opening_stock', await xlsx('opening_stock', stRows));
    let t = Date.now();
    const v = await validate(L.token, lb);
    perf.validate_ms = Date.now() - t;
    t = Date.now();
    const c = await commit(L.token, lb, true);
    perf.commit_ms = Date.now() - t;
    t = Date.now();
    const rc2 = await json('GET', `/api/migrations/${lb}/reconcile`, null, L.token);
    perf.reconcile_ms = Date.now() - t;
    check(`AC-403-63 ③ 1,000줄 + ⑤ 1,000줄 검증·저장 성공, 대조 차이 0 (검증 ${perf.validate_ms}ms · 저장 ${perf.commit_ms}ms)`,
      v.status === 200 && v.json.summary.errors === 0 && c.status === 201 && rc2.json.data.all_zero === true && rc2.json.data.receivable.total.saved_amount === arSum,
      { v: v.status, err: v.json && v.json.summary && v.json.summary.errors, c: c.status, all: rc2.json && rc2.json.data && rc2.json.data.all_zero });
    const big = [];
    for (let i = 1; i <= 5001; i += 1) big.push([`LC-1`, 1, '2026-10-01', '', '']);
    const lb2 = (await newBatch(L.token)).json.data.id;
    const r1 = await upload(L.token, lb2, 'opening_ar', await xlsx('opening_ar', big));
    const huge = Buffer.concat([await xlsx('opening_ar', [['LC-1', 1, '2026-10-01', '', '']]), crypto.randomBytes(5 * 1024 * 1024 + 10)]);
    const r2 = await upload(L.token, lb2, 'opening_ar', huge);
    check('AC-403-64 5,001줄 → 400 / 5MB 초과 → 413', r1.status === 400 && r1.json.code === 'TOO_MANY_ROWS' && r2.status === 413, [r1.status, r1.json && r1.json.code, r2.status]);
  }

  await pool.end();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n결과: ${pass}/${results.length} 통과 · 성능 ${JSON.stringify(perf)}`);
  if (process.env.MIGRATION_TEST_OUT) fs.writeFileSync(process.env.MIGRATION_TEST_OUT, JSON.stringify({ results, perf }, null, 2));
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('[migration-test] 오류:', e);
  process.exit(1);
});
