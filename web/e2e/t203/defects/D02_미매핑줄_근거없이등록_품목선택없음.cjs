// D02 (중·web) 품목이 매핑되지 않은 줄(예 "청량초")을 후보 창 "경락 근거 없이 등록"으로 확정하면 서버가 400 NO_PRODUCT_LINK(product_id 필요)를 주는데,
// 후보 창에 판매툴 품목을 고르는 칸이 없어 화면에서는 끝낼 수 없음(설계 4.4 R-128 본문 product_id 선택, AC-27 "경락 근거 없이 → FORCED")
// 원인 추정: web/src/components/MatchCandidateModal.jsx confirm 본문에 product_id 없음·품목 선택 UI 없음
const L = require('../lib.cjs');
(async () => {
  const f = L.fixture(); const u = await L.login('owner');
  const r = await L.call(u, 'POST', '/purchase-docs', { doc_no: `D02-${Date.now().toString(36)}`, supplier_partner_id: f.partners.PC, auto_convert: false,
    lines: [{ trade_date: f.dates.E, item_name: '가명미매핑초', grade: '특', spec: '10kg', qty: 1, unit_price: 1000 }] }, { 'Idempotency-Key': L.key('d02') });
  const doc = r.json.data.docs[0]; const lid = doc.lines[0].id;
  const { browser, page } = await L.open({ user: u });
  await L.tab(page, '매입서 대조');
  await L.tid(page, `pdoc-open-${doc.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(400);
  await L.tid(page, `pdoc-line-cand-${lid}`).click(); await L.tid(page, 'pdoc-cand-modal').waitFor(); await page.waitForTimeout(800);
  await L.tid(page, 'pdoc-cand-none').click(); await L.tid(page, 'pdoc-cand-accept').check(); await L.tid(page, 'pdoc-cand-reason').fill('장외 거래(가명)');
  await L.tid(page, 'pdoc-cand-confirm').click(); await page.waitForTimeout(1500);
  const err = await L.text(L.tid(page, 'pdoc-cand-error'));
  const picker = await page.locator('[data-testid="pdoc-cand-modal"] select').count();
  const cap = await L.shot(page, 'D02_근거없이등록_품목선택없음');
  await browser.close();
  const bug = /품목 연결이 없습니다/.test(err) && picker === 0;
  process.exit(L.finish('D02', '미매핑 줄 "경락 근거 없이 등록" — 품목 고를 칸 없음', bug, { error: err, productSelect: picker, capture: cap,
    expected: '판매툴 품목을 골라 FORCED 로 매입 등록', actual: bug ? '오류 문구만 나오고 끝낼 수 없음' : '기대대로' }));
})().catch((e) => { console.error(e); process.exit(2); });
