// D03 (하·web) 서버가 주는 사유·경고·후보 표시 코드 중 화면 문구표(matchLabels.js)에 없는 것이 영문 코드 그대로 보임
// 화면 재현: +5% 단가 줄의 사유 "NOT_STRICT" / 코드 목록 대조: B① 보고서 "사유·경고 코드" + 서버 엔진이 넣는 후보 flags
// 원인 추정: web/src/lib/matchLabels.js 에 BUYER_MISMATCH·NOT_STRICT·UNIT_ROUNDING·GRADE_UNKNOWN·PRICE_DIFF·NO_BASE_TRADE·CORP_UNKNOWN·DATE_DIFF·QTY_DIFF·VARIETY_UNKNOWN 없음
const fs = require('fs'); const path = require('path');
const L = require('../lib.cjs');
(async () => {
  const f = L.fixture(); const u = await L.login('owner');
  const r = await L.call(u, 'POST', '/purchase-docs', { doc_no: `D03-${Date.now().toString(36)}`, supplier_partner_id: f.partners.PA, auto_convert: false,
    lines: [{ trade_date: f.dates.D, item_name: '빨강 파프리카', grade: '특', spec: '5kg 상자', qty: 40, unit_price: 25200 }] }, { 'Idempotency-Key': L.key('d03') });
  const doc = r.json.data.docs[0];
  const { browser, page } = await L.open({ user: u });
  await L.tab(page, '매입서 대조');
  await L.tid(page, `pdoc-open-${doc.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(500);
  const body = await L.tid(page, 'pdoc-lines').innerText();
  const raw = (body.match(/\b[A-Z]{3,}(?:_[A-Z]+)+\b/g) || []);
  const cap = await L.shot(page, 'D03_사유코드_영문');
  await browser.close();
  const labels = fs.readFileSync(path.join(__dirname, '../../../src/lib/matchLabels.js'), 'utf8');
  const codes = ['BUYER_MISMATCH', 'NOT_STRICT', 'UNIT_ROUNDING', 'GRADE_UNKNOWN', 'PRICE_DIFF', 'NO_BASE_TRADE', 'CORP_UNKNOWN', 'DATE_DIFF', 'QTY_DIFF', 'VARIETY_UNKNOWN'];
  const missing = codes.filter((c) => !labels.includes(c));
  const bug = raw.length > 0 || missing.length > 0;
  process.exit(L.finish('D03', '사유·경고 코드 한국어 문구 없음 — 영문 코드 그대로 표시', bug, { shownRawCodes: [...new Set(raw)], missingInLabels: missing, capture: cap,
    expected: '모든 사유·경고·후보 표시를 한국어 문구로', actual: bug ? `화면에 ${[...new Set(raw)].join(',')} / 문구표에 없음 ${missing.length}개` : '기대대로' }));
})().catch((e) => { console.error(e); process.exit(2); });
