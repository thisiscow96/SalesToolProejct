// D04 매입 등록: 최근 단가 제안(예 2,800)이 들어간 단가 칸에 Tab 으로 들어가 바로 숫자를 치면
// 보통 웹 입력칸처럼 전체가 바뀌어야 하는데(Tab 은 칸 내용을 전체 선택), 콤마 표시→숫자 표시로 다시 그려지며 선택이 풀려 뒤에 붙는가
// 기대: 2,500 / 결함: 28,002,500 같은 금액
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '매입정보');
  await page.locator('button.main-btn', { hasText: '매입 등록' }).click();
  await page.waitForSelector('.main-modal');
  const row = page.locator('.main-table--purchase-modal tbody tr').first();
  await row.locator('select').nth(0).selectOption({ index: 1 });
  await row.locator('select').nth(1).selectOption({ label: '청양고추' });
  await page.waitForTimeout(1500); // 최근 단가 제안 도착
  const price = row.locator('input.main-input-unit-price--purchase');
  const suggested = await price.inputValue();
  await row.locator('input.main-input-qty').click();
  await page.keyboard.type('4');
  await page.keyboard.press('Tab');     // 단가 칸으로 이동(내용 전체 선택이 정상)
  await page.keyboard.type('2500');
  const cap1 = await L.shot(page, `D04_${W}_Tab입력`);
  await page.keyboard.press('Tab');
  const shown = await price.inputValue();
  // 같은 칸에 마우스로 들어가 Ctrl+A 후 입력하면 정상인지(대조)
  await price.click(); await page.keyboard.press('Control+A'); await page.keyboard.type('2500'); await page.keyboard.press('Tab');
  const viaCtrlA = await price.inputValue();
  await browser.close();
  const bug = shown.replace(/,/g, '') !== '2500';
  process.exit(L.finish(`D04_${W}`, '단가 칸 Tab 진입 후 입력이 제안값 뒤에 붙음', bug, {
    width: W, suggested, typedAfterTab: '2500', shownAfterTab: shown, controlCtrlA: viaCtrlA, expected: '2,500', capture: [cap1],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
