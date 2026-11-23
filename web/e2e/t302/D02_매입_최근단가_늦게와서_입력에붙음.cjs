// D02 매입 등록: 상품을 고른 뒤 단가 칸에 들어가 있는 동안 '최근 단가' 응답이 늦게 오면
// 제안값(예 3000)이 칸에 들어가고, 이어 친 숫자(1000)가 뒤에 붙어 30,001,000 으로 저장될 수 있는가
// 기대: 사용자가 칸에 들어가 있거나 입력을 시작했으면 제안값으로 덮거나 붙이지 않는다 → 1,000
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '매입정보');
  await page.locator('button.main-btn', { hasText: '매입 등록' }).click();
  await page.waitForSelector('.main-modal');
  const st = await L.slow(page, (url) => /\/api\/purchases\/last-price/.test(url), { ms: 1500 });
  const row = page.locator('.main-table--purchase-modal tbody tr').first();
  await row.locator('select').nth(0).selectOption({ index: 1 });
  await row.locator('select').nth(1).selectOption({ index: 1 });
  const price = row.locator('input.main-input-unit-price--purchase');
  await price.click();                 // 단가 칸에 들어감(아직 비어 있음)
  await page.waitForTimeout(3300);     // 그 사이 최근 단가 응답 도착(거래처·상품 선택 2번 요청)
  const valueWhenTyping = await price.inputValue();
  await page.keyboard.type('1000');    // 사용자가 단가 1000 입력
  const cap1 = await L.shot(page, `D02_${W}_입력직후`);
  await row.locator('input.main-input-qty').click(); // 칸을 벗어남
  const shown = await price.inputValue();
  const cap2 = await L.shot(page, `D02_${W}_칸벗어난뒤`);
  await browser.close();
  const bug = shown.replace(/,/g, '') !== '1000';
  process.exit(L.finish(`D02_${W}`, '매입 단가 — 늦게 온 최근 단가 제안이 입력 중인 칸에 들어가 숫자가 붙음', bug, {
    width: W, lastPriceCalls: st.count, valueWhenUserStartsTyping: valueWhenTyping, typed: '1000', shownAfterBlur: shown,
    expected: '1,000', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
