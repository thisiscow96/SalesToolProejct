/**
 * T-402 엑셀 업로드 + 템플릿 검사
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> SETTLE_API_BASE=http://127.0.0.1:<포트> node scripts/excel-upload-test.js
 * 전제: 마이그레이션 001~024, seed-sample-local(공용 품목 홍고추·청양고추), 서버 기동. 테스트 DB 전용 — 새 회원을 DB에 직접 만든다.
 * 선택: EXCEL_TEMPLATE_OUT=<폴더> 이면 대상별 템플릿 .xlsx 를 그 폴더에 저장한다.
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
  console.error('[excel-upload-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}`);
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
async function upload(kind, step, buf, token, name = 'upload.xlsx') {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  const r = await fetch(`${BASE}/api/excel/${kind}/${step}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  let j = null;
  try { j = await r.json(); } catch { /* */ }
  return { status: r.status, json: j };
}
async function template(kind, token) {
  const r = await fetch(`${BASE}/api/excel/${kind}/template`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) };
}
/** 머리글 + 줄로 xlsx 만들기. 셀 값에 {formula,result}·Date·숫자·문자열 그대로 */
async function makeXlsx(headers, rows, { sheet = '입력', note = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet);
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  if (note) wb.addWorksheet('메모').addRow([note]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const excelSerial = (ymd) => Math.round((Date.parse(`${ymd}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000);
const KINDS = ['partner', 'product', 'purchase', 'sale', 'convert', 'payment', 'supplier_payment', 'offset'];

async function main() {
  const tag = Date.now().toString(36);
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;

  const pw = crypto.randomBytes(12).toString('hex');
  const agent = `t402_${tag}`;
  const uid = (await q(
    `INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin)
     VALUES ($1, $2, $3, $4, NOW(), 'active', false) RETURNING id`,
    [`엑셀검사 ${tag}`, `${agent}@test.local`, agent, await bcrypt.hash(pw, 10)]
  ))[0].id;
  const A = (await json('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
  if (!A) throw new Error('주인 로그인 실패');
  const staffTok = async (loginId, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    const r = await json('POST', '/api/staff', { login_id: loginId, name: `직원${loginId}`, role, temp_password: spw }, A);
    if (r.status >= 300) throw new Error(`직원 ${loginId} ${r.status} ${JSON.stringify(r.json)}`);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [uid, loginId]);
    return (await json('POST', '/api/auth/login', { agent_no: agent, login_id: loginId, password: spw })).json.token;
  };
  const SI = await staffTok('in1', 'input');
  const SV = await staffTok('vw1', 'view');

  // ---------- 1. 템플릿 ----------
  const tpl = {};
  const outDir = process.env.EXCEL_TEMPLATE_OUT;
  for (const kind of KINDS) {
    const t = await template(kind, A);
    tpl[kind] = t.buf;
    const wb = new ExcelJS.Workbook();
    let sheets = [];
    let head = [];
    let exRows = 0;
    try {
      await wb.xlsx.load(t.buf);
      sheets = wb.worksheets.map((w) => w.name);
      head = wb.getWorksheet('입력').getRow(1).values.slice(1);
      exRows = wb.getWorksheet('입력').actualRowCount - 1;
    } catch (e) { /* 아래 FAIL */ }
    check(`TPL-${kind} 템플릿 xlsx(시트 입력·작성 안내, 필수 * 표시, 예시 줄)`,
      t.status === 200 && /spreadsheetml/.test(t.type || '') && sheets[0] === '입력' && sheets[1] === '작성 안내' && head.some((h) => String(h).endsWith('*')) && exRows >= 1,
      { status: t.status, sheets, head, exRows });
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const m = /filename\*=UTF-8''([^;]+)/i.exec(t.disp || '');
      fs.writeFileSync(path.join(outDir, m ? decodeURIComponent(m[1]) : `엑셀템플릿_${kind}.xlsx`), t.buf);
    }
  }
  check('TPL-권한 조회 직원도 템플릿은 내려받음', (await template('purchase', SV)).status === 200);
  check('TPL-없는 종류 404', (await template('nope', A)).status === 404);

  // ---------- 2. 템플릿을 그대로 올리면 예시 줄이 저장된다(대상 8종 순서대로) ----------
  const saved = {};
  for (const kind of KINDS) {
    const pv = await upload(kind, 'preview', tpl[kind], A, `tpl_${kind}.xlsx`);
    const s = pv.json?.summary;
    check(`TPL-AS-IS-${kind} 미리보기 오류 0`, pv.status === 200 && s && s.errors === 0 && s.ok === s.total && s.total >= 1, pv.json);
    const cm = await upload(kind, 'commit', tpl[kind], A, `tpl_${kind}.xlsx`);
    saved[kind] = cm.json;
    check(`TPL-AS-IS-${kind} 저장 201(전부)`, cm.status === 201 && cm.json?.saved === true && cm.json.summary.ok === s?.total, cm.json);
  }
  // 저장 결과 확인(예시 값)
  const pid = async (name) => (await q('SELECT id FROM account WHERE user_id = $1 AND name = $2', [uid, name]))[0]?.id;
  const [SEOUL, BUNONG, HANARO, FARM] = [await pid('서울청과'), await pid('부농'), await pid('하나로마트'), await pid('해남 농가')];
  const farmRow = (await q('SELECT type::text AS type, origin_region, bank_account FROM account WHERE id = $1', [FARM]))[0];
  check('VAL-거래처 4곳 + 생산자 산지·계좌', SEOUL && BUNONG && HANARO && farmRow?.type === 'producer' && farmRow.origin_region === '전남 해남' && farmRow.bank_account === '301-0000-0000-01', farmRow);
  const personal = await q(`SELECT name, unit FROM product WHERE owner_user_id = $1 ORDER BY name`, [uid]);
  check('VAL-개인 품목 2개', personal.length === 2 && personal.some((p) => p.name === '해남 꿀고구마' && p.unit === '10kg'), personal);
  const purch = await q(`SELECT p.quantity::float AS q, p.unit_price::float AS up, p.purchase_date::text AS d, p.origin_region, p.payee_partner_id, p.producer_id, pr.name AS product
                           FROM purchase p JOIN product pr ON pr.id = p.product_id WHERE p.user_id = $1 ORDER BY p.id`, [uid]);
  check('VAL-매입 3건(날짜 셀·생산자·산지·지급 대상)', purch.length === 3 && purch[0].d === '2026-11-20' && purch[0].producer_id === FARM && purch[0].origin_region === '전남 해남' && purch[0].payee_partner_id === SEOUL
    && purch[1].payee_partner_id === FARM && purch[2].product === '청양고추', purch);
  const sales = await q(`SELECT s.partner_id, s.quantity::float AS q, s.sale_date::text AS d FROM sale s WHERE s.user_id = $1 ORDER BY s.id`, [uid]);
  check('VAL-판매 3건 + 전환 1건', sales.length === 4 && sales.every((x) => x.d === '2026-11-21'), sales);
  const recv = await q(`SELECT SUM(total_amount - returned_amount - paid_amount - discount_amount - offset_amount)::float AS due FROM sale WHERE user_id = $1 AND partner_id = $2`, [uid, HANARO]);
  // 하나로마트: 4×38,000 + 2×42,000 + 2×38,000(전환) = 312,000 − 수금 100,000 − 할인 2,000 = 210,000
  check('VAL-하나로마트 미수 210,000(수금·할인 배분)', recv[0].due === 210000, recv);
  const seoulDue = await q(`SELECT SUM(total_amount - paid_amount)::float AS due FROM purchase WHERE user_id = $1 AND payee_partner_id = $2`, [uid, SEOUL]);
  check('VAL-서울청과 미지급 120,000(320,000 − 지급 200,000)', seoulDue[0].due === 120000, seoulDue);
  const off = await q(`SELECT amount::float AS a FROM settlement_offset WHERE user_id = $1 AND partner_id = $2 AND status = 'active'`, [uid, BUNONG]);
  const bunongDue = await q(`SELECT SUM(total_amount - returned_amount - paid_amount - discount_amount - offset_amount)::float AS due FROM sale WHERE user_id = $1 AND partner_id = $2`, [uid, BUNONG]);
  check('VAL-부농 상계 50,000 → 미수 40,000', bunongDue[0].due === 40000 && (!off || off.length === 1), { bunongDue, off });

  // ---------- 3. 같은 파일 두 번 ----------
  const again = await upload('partner', 'commit', tpl.partner, A);
  check('DUP-같은 파일 두 번째 저장 409', again.status === 409 && again.json?.code === 'DUPLICATE_FILE', again);
  const againPv = await upload('partner', 'preview', tpl.partner, A);
  check('DUP-미리보기에 이미 올린 파일 표시', againPv.status === 200 && againPv.json?.summary?.duplicate?.id, againPv.json?.summary);

  // ---------- 4. 오류 줄 + 전부 아니면 전무 ----------
  const H = ['매입일*', '제공처*', '품목*', '수량*', '단가*', '메모'];
  const bad = await makeXlsx(H, [
    ['2026-11-22', '서울청과', '홍고추', 1, 1000, '정상'],
    ['2026-11-22', '없는거래처', '홍고추', 1, 1000, '거래처 없음'],
    ['2026-11-22', '서울청과', '없는품목', 1, 1000, '품목 없음'],
    ['2026-11-22', '하나로마트', '홍고추', 1, 1000, '판매처로 매입 — 단건 API 규칙'],
    ['2026-13-40', '서울청과', '홍고추', 1, 1000, '날짜 오류'],
    ['2026-11-22', '서울청과', '홍고추', 'abc', 1000, '수량 오류'],
    ['2026-11-22', '서울청과', '홍고추', 0, 1000, '수량 0 — 단건 API 규칙'],
  ]);
  const before = (await q('SELECT COUNT(*)::int AS n FROM purchase WHERE user_id = $1', [uid]))[0].n;
  const bp = await upload('purchase', 'preview', bad, A);
  const rows = bp.json?.rows || [];
  check('ERR-미리보기 줄별 결과(정상 1·오류 6, 줄 번호)', bp.status === 200 && bp.json.summary.ok === 1 && bp.json.summary.errors === 6 && rows[1].line === 3 && !rows[1].ok, bp.json?.summary);
  check('ERR-이유: 거래처 없음', /없는거래처/.test(rows[1]?.message || ''), rows[1]);
  check('ERR-이유: 품목 없음', /없는품목/.test(rows[2]?.message || ''), rows[2]);
  check('ERR-이유: 단건 API 규칙 그대로(매입 가능한 거래처)', /매입 가능한 거래처/.test(rows[3]?.message || ''), rows[3]);
  check('ERR-이유: 날짜 형식', /형식/.test(rows[4]?.message || ''), rows[4]);
  check('ERR-이유: 수량 숫자', /숫자/.test(rows[5]?.message || ''), rows[5]);
  check('ERR-이유: 수량 0(단건 규칙)', /올바르게/.test(rows[6]?.message || ''), rows[6]);
  const bc = await upload('purchase', 'commit', bad, A);
  const after = (await q('SELECT COUNT(*)::int AS n FROM purchase WHERE user_id = $1', [uid]))[0].n;
  check('ERR-오류 있으면 저장 422, 정상 줄도 저장 안 됨(전부 아니면 전무)', bc.status === 422 && bc.json?.saved === false && after === before, { status: bc.status, before, after });
  const noUp = (await q('SELECT COUNT(*)::int AS n FROM excel_upload WHERE user_id = $1 AND file_hash = $2', [uid, crypto.createHash('sha256').update(bad).digest('hex')]))[0].n;
  check('ERR-실패한 저장은 업로드 기록도 없음(고쳐서 다시 올릴 수 있음)', noUp === 0);

  // ---------- 5. 날짜·쉼표·수식 형식 ----------
  const fmt = await makeXlsx(['매입일*', '제공처*', '품목*', '수량*', '단가*', '메모'], [
    ['2026.11.23', ' 서울청과 ', '홍고추', '1,200', '32,000원', '점 날짜·쉼표'],
    ['20261124', '서울청과', '홍고추', 2, '1,000', '숫자 날짜'],
    [excelSerial('2026-11-25'), '서울청과', '청양고추', { formula: '2*5', result: 10 }, 3000, '엑셀 날짜 숫자·수식'],
    [new Date(Date.UTC(2026, 10, 26)), '서울청과', '홍고추', 1.5, 2500.5, '날짜 셀·소수'],
  ]);
  const fc = await upload('purchase', 'commit', fmt, A);
  const fr = await q(`SELECT purchase_date::text AS d, quantity::float AS q, unit_price::float AS up FROM purchase WHERE user_id = $1 AND purchase_date >= '2026-11-23' ORDER BY purchase_date`, [uid]);
  check('FMT-점 날짜·쉼표 금액·숫자 날짜·엑셀 날짜·수식·날짜 셀 저장', fc.status === 201 && fr.length === 4
    && fr[0].d === '2026-11-23' && fr[0].q === 1200 && fr[0].up === 32000
    && fr[1].d === '2026-11-24' && fr[2].d === '2026-11-25' && fr[2].q === 10 && fr[3].d === '2026-11-26' && fr[3].up === 2500.5, { st: fc.status, body: fc.json?.rows?.filter((r) => !r.ok), fr });

  // ---------- 6. 파일 오류 ----------
  const noCol = await makeXlsx(['매입일', '제공처', '수량', '단가'], [['2026-11-22', '서울청과', 1, 1]]);
  const nc = await upload('purchase', 'preview', noCol, A);
  check('FILE-필수 열 없음 400(열 이름)', nc.status === 400 && /품목/.test(nc.json?.message || ''), nc);
  const notX = await upload('purchase', 'preview', Buffer.from('a,b,c\n1,2,3'), A, 'x.csv');
  check('FILE-xlsx 아님 400', notX.status === 400, notX);
  const big = await upload('purchase', 'preview', Buffer.alloc(2 * 1024 * 1024 + 10, 1), A, 'big.xlsx');
  check('FILE-2MB 넘음 413', big.status === 413, big);
  const empty = await makeXlsx(H, []);
  check('FILE-줄 없음 400', (await upload('purchase', 'preview', empty, A)).status === 400);
  const over = await makeXlsx(H, Array.from({ length: 1001 }, () => ['2026-11-22', '서울청과', '홍고추', 1, 1, '']));
  const ov = await upload('purchase', 'preview', over, A);
  check('FILE-1,001줄 400', ov.status === 400 && /1,000/.test(ov.json?.message || ''), ov);

  // ---------- 7. 권한 ----------
  const okP = await makeXlsx(H, [['2026-11-27', '서울청과', '홍고추', 1, 1000, '직원']]);
  const sip = await upload('purchase', 'commit', okP, SI);
  const staffRow = (await q(`SELECT created_by_staff_id FROM purchase WHERE user_id = $1 AND purchase_date = '2026-11-27'`, [uid]))[0];
  check('AUTH-입력 직원 매입 업로드 저장 + 입력자 기록', sip.status === 201 && staffRow?.created_by_staff_id, sip.json?.rows);
  const sipart = await upload('partner', 'preview', await makeXlsx(['거래처명*', '유형*'], [['직원거래처', '판매처']]), SI);
  check('AUTH-입력 직원 거래처 업로드 403', sipart.status === 403, sipart);
  for (const k of ['supplier_payment', 'offset']) {
    const r = await upload(k, 'preview', tpl[k], SI);
    check(`AUTH-입력 직원 ${k} 업로드 403`, r.status === 403, r);
  }
  const svp = await upload('purchase', 'preview', okP, SV);
  check('AUTH-조회 직원 매입 업로드 403', svp.status === 403, svp);
  const payH = ['수금일*', '거래처*', '금액*', '구분', '메모'];
  const sipay = await upload('payment', 'preview', await makeXlsx(payH, [['2026-11-27', '하나로마트', 1000, '수금', ''], ['2026-11-27', '하나로마트', 1000, '할인', '']]), SI);
  check('AUTH-입력 직원 수금 업로드: 현금 줄 OK · 할인 줄은 단건 규칙대로 오류', sipay.status === 200 && sipay.json.rows[0].ok && !sipay.json.rows[1].ok && /주인/.test(sipay.json.rows[1].message), sipay.json?.rows);
  const me = await json('GET', '/api/me', null, SI);
  check('AUTH-화면 allow: 입력 직원 excel.purchase 있음·excel.partner 없음', (me.json?.allow || []).includes('excel.purchase') && !(me.json?.allow || []).includes('excel.partner'), me.json?.allow);

  // ---------- 8. 변경 이력 ----------
  const h = await json('GET', '/api/history?kind=excel_upload&limit=50', null, A);
  const lines = (h.json?.data || []).map((x) => x.target_label || x.reason);
  check('AUDIT-변경 이력 "엑셀 업로드 N건" 한 줄씩(성공한 저장만)', h.status === 200 && lines.some((l) => /엑셀 업로드 매입 3건/.test(l)) && lines.some((l) => /엑셀 업로드 거래처 4건/.test(l)) && h.json.data.length === KINDS.length + 2, lines);
  const upRec = await q(`SELECT kind, row_count, jsonb_array_length(result) AS n FROM excel_upload WHERE user_id = $1 AND kind = 'purchase' ORDER BY id LIMIT 1`, [uid]);
  check('AUDIT-업로드 기록에 줄별 결과(건별)', upRec[0]?.n === 3 && upRec[0].row_count === 3, upRec);

  // ---------- 9. 1,000줄 성능 ----------
  const thousand = await makeXlsx(H, Array.from({ length: 1000 }, (_, i) => [`2026-11-28`, '서울청과', i % 2 ? '홍고추' : '청양고추', 1, 1000 + i, `성능 ${i + 1}`]));
  let t0 = Date.now();
  const tp = await upload('purchase', 'preview', thousand, A);
  const tPrev = Date.now() - t0;
  t0 = Date.now();
  const tc = await upload('purchase', 'commit', thousand, A);
  const tCommit = Date.now() - t0;
  const cnt = (await q(`SELECT COUNT(*)::int AS n FROM purchase WHERE user_id = $1 AND purchase_date = '2026-11-28'`, [uid]))[0].n;
  console.log(`  1,000줄: 미리보기 ${tPrev}ms · 저장 ${tCommit}ms · 파일 ${thousand.length}바이트`);
  check('PERF-1,000줄 미리보기·저장(각 60초 이내) 1,000건', tp.status === 200 && tp.json.summary.ok === 1000 && tc.status === 201 && cnt === 1000 && tPrev < 60000 && tCommit < 60000, { tp: tp.status, tc: tc.status, cnt, tPrev, tCommit });

  // ---------- 10. 동시에 같은 파일 저장 → 하나만 ----------
  const race = await makeXlsx(H, [['2026-11-29', '서울청과', '홍고추', 1, 777, '동시']]);
  const [r1, r2] = await Promise.all([upload('purchase', 'commit', race, A), upload('purchase', 'commit', race, A)]);
  const rc = (await q(`SELECT COUNT(*)::int AS n FROM purchase WHERE user_id = $1 AND purchase_date = '2026-11-29'`, [uid]))[0].n;
  check('DUP-같은 파일 동시 저장 → 1건만(201 + 409)', rc === 1 && [r1.status, r2.status].sort().join() === '201,409', { s: [r1.status, r2.status], rc });

  await pool.end();
  const fail = results.filter((r) => !r.ok);
  console.log(`\n결과: ${results.length - fail.length}/${results.length} 통과`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
