// D05 선택 매출 전환: 판매 단가 칸은 매입 단가로 미리 채워진다. 전환 수량에서 Tab 으로 넘어가 판매 단가를 치면 뒤에 붙는가
// 기대: 4,500 / 결함: 매입단가 뒤에 4500 이 붙은 금액
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '매입정보');
  await page.waitForSelector('table.main-table tbody tr');
  // 남은 수량 있는 매입(정상 단가) 한 줄 체크 — 상품 '홍고추'
  const target = page.locator('table.main-table tbody tr', { hasText: '홍고추' }).first();
  await target.locator('input[type=checkbox]').first().check();
  await page.locator('button.main-btn', { hasText: '선택 매출 전환' }).click();
  await page.waitForSelector('#form-convert-modal');
  const price = page.locator('input.main-input-unit-price--convert').first();
  const prefilled = await price.inputValue();
  await page.locator('input.main-input-qty--convert').first().click();
  await page.keyboard.press('Tab');
  await page.keyboard.type('4500');
  const cap1 = await L.shot(page, `D05_${W}_Tab입력`);
  await page.keyboard.press('Tab');
  const shown = await price.inputValue();
  await browser.close();
  const bug = shown.replace(/,/g, '') !== '4500';
  process.exit(L.finish(`D05_${W}`, '매출 전환 판매 단가 — Tab 진입 후 입력이 매입 단가 뒤에 붙음', bug, {
    width: W, prefilled, typedAfterTab: '4500', shownAfterTab: shown, expected: '4,500', capture: [cap1],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
