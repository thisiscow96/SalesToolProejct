// D07 공용 모달(Main.jsx Modal) 쓰는 저장 화면들: 저장 요청 중 [취소] 버튼·바깥(어두운 배경) 클릭으로 모달이 닫히는가
// 대상: 폐기 등록 · 환불 처리 · 선택 매출 전환 · 상품 마스터 등록  (매입 D01·수금 D06 과 같은 원인)
// 기대: 요청 중에는 [취소]가 잠기고 바깥 클릭으로 닫히지 않음. 닫혀도 저장은 되므로 "취소했는데 저장됨"이 된다
// 사용: node D07...cjs [disposal|refund|convert|product|all]   W=390 이면 휴대폰 폭
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
const SC = {
  disposal: { tab: '폐기정보', btn: '폐기 등록', post: /\/api\/disposals$/, prep: async (page) => {
    await page.waitForTimeout(1200);
    await page.locator('.main-modal tbody input[type=checkbox]').first().check();
    await page.locator('.main-modal input.main-input-qty--disposal').first().fill('0.1');
  } },
  refund: { tab: '매출정보', btn: '환불 처리', post: /\/api\/sales\/\d+\/refund$/, prep: async (page) => {
    await page.waitForTimeout(1200);
    await page.locator('.main-modal tbody input[type=checkbox]').first().check();
    await page.locator('.main-modal input.main-input-qty-refund').first().fill('0.1');
  } },
  convert: { tab: '매입정보', btn: '선택 매출 전환', post: /\/api\/purchases\/convert-to-sales$/, before: async (page) => {
    await page.waitForSelector('table.main-table tbody tr');
    await page.locator('table.main-table tbody tr', { hasText: '노랑 파프리카' }).first().locator('input[type=checkbox]').first().check();
  }, prep: async (page) => {
    await page.locator('.main-modal select').first().selectOption({ index: 1 });
    await page.locator('.main-modal input.main-input-qty--convert').first().fill('0.1');
  } },
  product: { tab: '상품 마스터', btn: '상품 등록', post: /\/api\/products\/bulk$|\/api\/products$/, prep: async (page) => {
    await page.locator('.main-modal tbody input').first().fill('T302조작확인품목' + Date.now() % 100000);
  } },
};
async function runOne(name) {
  const s = SC[name];
  const u = await L.apiLogin();
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, s.tab);
  if (s.before) await s.before(page);
  await page.locator('button.main-btn', { hasText: s.btn }).first().click();
  await page.waitForSelector('.main-modal');
  await s.prep(page);
  const st = await L.slow(page, (url, m) => m === 'POST' && s.post.test(new URL(url).pathname), { ms: 3000 });
  await page.locator('.main-modal-footer button.primary').click();
  await page.waitForTimeout(400);
  const cancelEnabled = !(await page.locator('.main-modal-footer button.secondary').isDisabled());
  // 바깥(배경) 클릭 — 왼쪽 위 모서리
  await page.mouse.click(3, 3);
  await page.waitForTimeout(300);
  const closed = (await page.locator('.main-modal').count()) === 0;
  const cap = await L.shot(page, `D07_${name}_${W}_바깥클릭뒤`);
  await page.waitForTimeout(3300);
  await browser.close();
  return { scenario: name, cancelEnabledDuring: cancelEnabled, closedByBackdropDuringRequest: closed, postCount: st.count, postDone: st.done, capture: cap };
}
(async () => {
  const which = process.argv[2] || 'all';
  const names = which === 'all' ? Object.keys(SC) : [which];
  const out = [];
  for (const n of names) { try { out.push(await runOne(n)); } catch (e) { out.push({ scenario: n, error: e.message.slice(0, 200) }); } }
  const bug = out.some((r) => r.closedByBackdropDuringRequest || r.cancelEnabledDuring);
  process.exit(L.finish(`D07_${which}_${W}`, '공용 모달 — 저장 중 취소·바깥 클릭으로 닫힘(저장은 계속됨)', bug, { width: W, results: out, expected: '요청 중 취소 잠김·바깥 클릭 무시' }));
})().catch((e) => { console.error(e); process.exit(2); });
