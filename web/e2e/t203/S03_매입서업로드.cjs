// S03 매입서 업로드(실서버) — 템플릿 내려받기·미리보기 오류/경고·오류 있으면 저장 잠금·저장(자동 매입 등록)·CSV·중복 파일·잘못된 파일
// 날짜: xlsx 는 D.A, CSV 는 D.D (fixture). 저장 결과는 DB 로도 확인(매입 건수 = 자동 등록 줄 수)
const path = require('path'); const fs = require('fs'); const os = require('os');
const L = require('./lib.cjs');
const ExcelJS = require(path.join(__dirname, '../../../server/node_modules/exceljs'));
const W = Number(process.env.W || 1366);
const HEAD = ['매입서번호', '거래일', '입고일', '제공처', '품목', '등급', '규격', '수량', '단가', '금액', '산지', '출하자', '경매번호', '낙찰자번호', '판매툴품목', '메모'];
const row = (o) => [o.no || '', o.d, '', o.sup, o.item, o.grade || '', o.spec || '', o.qty, o.price, o.amount ?? '', o.origin || '', '', '', '', '', ''];
async function xlsx(file, rows) {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('입력'); ws.addRow(HEAD); for (const r of rows) ws.addRow(row(r));
  await wb.xlsx.writeFile(file); return file;
}
(async () => {
  const f = L.fixture(); const D = f.dates; const tag = Date.now().toString(36).slice(-5);
  const s = L.suite(`S03_${W}`, '매입서 업로드 — 실서버');
  const tmp = path.join(os.tmpdir(), 'c203', 'files'); fs.mkdirSync(tmp, { recursive: true });
  const pool = L.db(); const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const u = await L.login('owner');
  const purch0 = Number((await q(`SELECT COUNT(*) c FROM purchase WHERE user_id=$1 AND purchase_doc_line_id IS NOT NULL`, [f.accounts.owner.id]))[0].c);
  const { browser, page, errors } = await L.open({ user: u, width: W });
  await L.tab(page, '매입서 대조');
  await L.tid(page, 'pdoc-upload-bar').waitFor({ timeout: 8000 });
  const cap = [];
  // 1) 템플릿
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }).catch(() => null), L.tid(page, 'pdoc-template').click()]);
  let tplHead = [];
  if (dl) {
    const p = path.join(tmp, 'tpl.xlsx'); await dl.saveAs(p);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(p);
    tplHead = (wb.getWorksheet('입력')?.getRow(1).values || []).filter(Boolean).map((x) => String(x).replace(/\*$/, ''));
  }
  s.c('템플릿 내려받기(.xlsx, 시트 입력·머리글 거래일/제공처/품목/수량/단가)', dl && /\.xlsx$/.test(dl.suggestedFilename()) && ['거래일', '제공처', '품목', '수량', '단가'].every((h) => tplHead.includes(h)), { name: dl && dl.suggestedFilename(), tplHead });
  // 2) 오류·경고가 섞인 파일
  const bad = await xlsx(path.join(tmp, `bad_${tag}.xlsx`), [
    { no: `X-${tag}`, d: D.A, sup: 'C농협공판장', item: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, price: 45000 },
    { no: `X-${tag}`, d: D.A, sup: 'C농협공판장', item: '홍고추', grade: '상', spec: '5kg 망', qty: 14, price: 19000.5 },
    { no: `X-${tag}`, d: D.A, sup: 'C농협공판장', item: '청량초', grade: '특', spec: '10kg', qty: 1, price: 1000 },
    { no: `X-${tag}`, d: D.A, sup: 'C농협공판장', item: '홍고추', grade: '특', spec: '10kg 상자', qty: 2, price: 1000, amount: 9999 },
    { no: `X-${tag}`, d: '', sup: '', item: '', qty: '', price: '' , origin: '빈줄아님' },
  ]);
  await L.tid(page, 'pdoc-file-input').setInputFiles(bad);
  await L.tid(page, 'pdoc-preview').waitFor({ timeout: 8000 });
  const sum = await L.text(L.tid(page, 'pdoc-preview-summary'));
  const r3 = await L.text(L.tid(page, 'pdoc-preview-row-3'));
  const r4 = await L.text(L.tid(page, 'pdoc-preview-row-4'));
  const r5 = await L.text(L.tid(page, 'pdoc-preview-row-5'));
  const r6 = await L.text(L.tid(page, 'pdoc-preview-row-6'));
  s.c('미리보기 요약(줄 수·오류·경고)', /오류/.test(sum) && /경고/.test(sum), sum);
  s.c('3줄: 단가 원 단위 정수 오류', /정수/.test(r3), r3);
  s.c('4줄: 품목 못 찾음 경고(저장은 됨)', /청량초|찾지 못/.test(r4), r4);
  s.c('5줄: 금액 ≠ 수량×단가 경고', /금액/.test(r5), r5);
  s.c('6줄: 필수값 누락 오류(거래일·제공처·품목·수량·단가)', /거래일|필수|넣어/.test(r6), r6);
  s.c('오류가 있으면 [저장하고 대조] 잠김', await L.tid(page, 'pdoc-preview-save').isDisabled(), '');
  cap.push(await L.shot(page, `S03_${W}_1_미리보기_오류`));
  const docsBad = Number((await q(`SELECT COUNT(*) c FROM purchase_doc WHERE doc_no=$1`, [`X-${tag}`]))[0].c);
  s.c('미리보기는 저장 안 함(DB 0건)', docsBad === 0, docsBad);
  await L.tid(page, 'pdoc-preview-close').click(); await page.waitForTimeout(300);
  // 3) 정상 파일 저장(자동 매입 등록 켬)
  const good = await xlsx(path.join(tmp, `good_${tag}.xlsx`), [
    { no: `G-${tag}-C`, d: D.A, sup: 'C농협공판장', item: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, price: 45000, amount: 450000 },
    { no: `G-${tag}-A`, d: D.A, sup: 'A청과', item: '청양고추', grade: '특', spec: '10kg 상자', qty: 12, price: 38000 },
    { no: `G-${tag}-A`, d: D.A, sup: 'A청과', item: '꽈리고추', grade: '특', spec: '4kg 상자', qty: 30, price: 21000 },
    { no: `G-${tag}-A`, d: D.A, sup: 'A청과', item: '빨강 파프리카', grade: '특', spec: '5kg 상자', qty: 40, price: 25200 },
    { no: `G-${tag}-A`, d: D.A, sup: 'A청과', item: '노랑 파프리카', grade: '특', spec: '5kg 상자', qty: 35, price: 25000 },
  ]);
  const autoOn = await L.tid(page, 'pdoc-auto-convert').isChecked();
  await L.tid(page, 'pdoc-file-input').setInputFiles(good);
  await L.tid(page, 'pdoc-preview').waitFor({ timeout: 8000 });
  const sumG = await L.text(L.tid(page, 'pdoc-preview-summary'));
  s.c('정상 파일 미리보기: 오류 0·저장 버튼 켜짐', !(await L.tid(page, 'pdoc-preview-save').isDisabled()), sumG);
  cap.push(await L.shot(page, `S03_${W}_2_미리보기_정상`));
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/purchase-docs$/.test(new URL(url).pathname), { ms: 1500 });
  await L.tid(page, 'pdoc-preview-save').click();
  await page.waitForTimeout(200);
  const saveLocked = await L.tid(page, 'pdoc-preview-save').isDisabled();
  const closeLocked = await L.tid(page, 'pdoc-preview-close').isDisabled();
  await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  const stillOpen = (await L.tid(page, 'pdoc-preview').count()) === 1;
  await L.tid(page, 'pdoc-saved-summary').waitFor({ timeout: 10000 });
  const saved = await L.text(L.tid(page, 'pdoc-saved-summary'));
  s.c('저장 중 저장·닫기 잠김·Esc 로 안 닫힘·요청 1회', saveLocked && closeLocked && stillOpen && st.count === 1, { saveLocked, closeLocked, stillOpen, count: st.count });
  s.c('저장 요약(매입서 2건·완전/부분·바로 매입 등록)', /매입서 2건/.test(saved) && /바로 매입 등록/.test(saved), saved);
  await page.unroute('**/api/**');
  const docs = await q(`SELECT id, doc_no, status FROM purchase_doc WHERE doc_no LIKE $1 ORDER BY doc_no`, [`G-${tag}-%`]);
  const lines = await q(`SELECT l.id, d.doc_no, l.line_no, l.status, l.match_result, l.reason_codes FROM purchase_doc_line l JOIN purchase_doc d ON d.id=l.doc_id WHERE d.doc_no LIKE $1 ORDER BY d.doc_no, l.line_no`, [`G-${tag}-%`]);
  const conv = lines.filter((x) => x.status === 'CONVERTED').length;
  const purch1 = Number((await q(`SELECT COUNT(*) c FROM purchase WHERE user_id=$1 AND purchase_doc_line_id IS NOT NULL`, [f.accounts.owner.id]))[0].c);
  s.c('자동 매입 등록 켜짐(기본)', autoOn, autoOn);
  s.c('DB: 매입서 2건·줄 5개 저장', docs.length === 2 && lines.length === 5, { docs, n: lines.length });
  s.c('DB: 완전일치 줄 자동 매입 등록(홍고추 특·꽈리 특·노랑 파프리카 특 = 3), 매입 건수 = 전환 줄 수', conv === 3 && purch1 - purch0 === conv, { conv, purch: purch1 - purch0, lines: lines.map((x) => `${x.doc_no.slice(-1)}${x.line_no}:${x.status}/${x.match_result}/${(x.reason_codes || []).join('|')}`) });
  // 목록에 보임
  await page.waitForTimeout(800);
  for (const d of docs) s.c(`목록에 ${d.doc_no.slice(-3)} 행`, (await L.tid(page, `pdoc-row-${d.id}`).count()) === 1, d.id);
  const rowA = await L.text(L.tid(page, `pdoc-row-${docs[0].id}`));
  s.c('목록 행: 제공처·줄수·합계·건수(전환/대기/보류/아님/취소)', /A청과/.test(rowA) && /\d+\/\d+\/\d+\/\d+\/\d+/.test(rowA), rowA);
  cap.push(await L.shot(page, `S03_${W}_3_저장후목록`));
  // 4) 같은 파일 다시 → 409 DUPLICATE_FILE
  await L.tid(page, 'pdoc-file-input').setInputFiles(good);
  await L.tid(page, 'pdoc-preview').waitFor({ timeout: 8000 });
  await L.tid(page, 'pdoc-preview-save').click();
  await page.waitForTimeout(1500);
  const dupMsg = await L.text(L.tid(page, 'pdoc-preview-error'));
  s.c('같은 파일 다시 저장 → "이미 저장한 파일" 문구', /이미 저장한 파일/.test(dupMsg), dupMsg);
  cap.push(await L.shot(page, `S03_${W}_4_중복파일`));
  await L.tid(page, 'pdoc-preview-close').click(); await page.waitForTimeout(300);
  // 5) CSV(UTF-8 BOM) — D.D, 자동 매입 등록 끔
  const csv = path.join(tmp, `csv_${tag}.csv`);
  fs.writeFileSync(csv, '﻿' + [HEAD.join(','), row({ no: `V-${tag}`, d: D.D, sup: 'B청과', item: '오이고추', grade: '특', spec: '10kg 상자', qty: 18, price: 29000 }).join(','),
    row({ no: `W-${tag}`, d: D.D, sup: 'A청과', item: '꽈리', grade: '특', spec: '4kg 상자', qty: 30, price: 21000 }).join(',')].join('\r\n'));
  await L.tid(page, 'pdoc-auto-convert').uncheck();
  await L.tid(page, 'pdoc-file-input').setInputFiles(csv);
  await L.tid(page, 'pdoc-preview').waitFor({ timeout: 8000 });
  const sumC = await L.text(L.tid(page, 'pdoc-preview-summary'));
  s.c('CSV(UTF-8 BOM) 미리보기 2줄 정상', /2/.test(sumC) && !(await L.tid(page, 'pdoc-preview-save').isDisabled()), sumC);
  await L.tid(page, 'pdoc-preview-save').click();
  await L.tid(page, 'pdoc-saved-summary').waitFor({ timeout: 10000 });
  await page.waitForTimeout(600);
  const vl = await q(`SELECT l.status, l.match_result FROM purchase_doc_line l JOIN purchase_doc d ON d.id=l.doc_id WHERE d.doc_no IN ($1, $2) ORDER BY d.doc_no`, [`V-${tag}`, `W-${tag}`]);
  s.c('CSV 저장(자동 등록 끔) → 완전일치여도 PENDING(전환 가능)·매입 0', vl.length === 2 && vl.every((x) => x.status === 'PENDING' && x.match_result === 'EXACT'), vl);
  await L.tid(page, 'pdoc-auto-convert').check();
  // 6) 잘못된 파일 형식
  const txt = path.join(tmp, 'x.txt'); fs.writeFileSync(txt, 'hello');
  await L.tid(page, 'pdoc-file-input').setInputFiles(txt); await page.waitForTimeout(400);
  s.c('엑셀·CSV 아닌 파일 → 문구', /엑셀|CSV/.test(await L.text(L.tid(page, 'pdoc-upload-error'))), await L.text(L.tid(page, 'pdoc-upload-error')));
  cap.push(await L.shot(page, `S03_${W}_5_CSV와형식오류`));
  s.c('pageerror 0', errors.length === 0, errors);
  await browser.close(); await pool.end();
  fs.writeFileSync(path.join(__dirname, 'results', 'S03_docs.json'), JSON.stringify({ tag, docs, csvDoc: `V-${tag}` }));
  process.exit(s.done({ width: W, capture: cap }));
})().catch((e) => { console.error(e); process.exit(2); });
