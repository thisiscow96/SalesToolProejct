// P02 요청 중 닫기를 이미 막아 둔 창이 실제로 막히는지(대조군): 재고 판매(FIFO) · 매입처 지급 등록
// 기대(=현재 코드): 요청 중 [취소] 잠김, 바깥 클릭·Esc 로 닫히지 않음, 요청 1번
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
async function check(page, name, saveSel, post) {
  const st = await L.slow(page, (url, m) => m === 'POST' && post.test(new URL(url).pathname), { ms: 2500, fail: true });
  await page.locator(saveSel).first().dblclick();
  await page.waitForTimeout(300);
  const cancelDisabled = await page.locator('.main-modal-footer button.secondary').first().isDisabled();
  await page.mouse.click(3, 3);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const stillOpen = (await page.locator('.main-modal').count()) > 0;
  await page.waitForTimeout(2600);
  const cap = await L.shot(page, `P02_${name}_${W}`);
  return { screen: name, postCount: st.count, cancelDisabledDuring: cancelDisabled, openAfterBackdropAndEsc: stillOpen, pass: st.count === 1 && cancelDisabled && stillOpen, capture: cap };
}
(async () => {
  const u = await L.apiLogin();
  const out = [];
  { // 재고 판매
    const { browser, page } = await L.open({ user: u, width: W });
    try {
      await page.waitForSelector('button.main-tab');
      await L.tab(page, '재고현황');
      await page.locator('button.fifo-sell-btn:not([disabled])').first().click();
      await page.waitForSelector('.main-modal');
      await page.locator('.main-modal select').first().selectOption({ index: 1 });
      await page.locator('.main-modal input[type=number]').first().fill('0.1');
      const price = page.locator('.main-modal input[type=number]').nth(1);
      if (await price.count()) await price.fill('1000');
      out.push(await check(page, '재고판매', '.main-modal-footer button.primary', /\/api\/sales/));
    } catch (e) { out.push({ screen: '재고판매', error: e.message.slice(0, 200) }); } finally { await browser.close(); }
  }
  { // 매입처 지급
    const { browser, page } = await L.open({ user: u, width: W });
    try {
      await page.waitForSelector('button.main-tab');
      await L.tab(page, '매입정보');
      await page.waitForSelector('table.main-table tbody tr');
      await page.locator('table.main-table tbody tr', { hasText: '홍고추' }).first().locator('input[type=checkbox]').first().check();
      await page.locator('button.main-btn', { hasText: '지급 등록' }).click();
      await page.waitForSelector('#sp-pay-form');
      await page.waitForTimeout(1500);
      const amt = page.locator('#sp-pay-form input[inputmode=decimal], #sp-pay-form input[inputmode=numeric]').first();
      if (await amt.count()) await amt.fill('100');
      out.push(await check(page, '매입처지급', '.main-modal-footer button.primary', /\/api\/supplier-payments$/));
    } catch (e) { out.push({ screen: '매입처지급', error: e.message.slice(0, 200) }); } finally { await browser.close(); }
  }
  const bug = out.some((r) => !r.pass);
  process.exit(L.finish(`P02_${W}`, '가드 있는 창(재고 판매·매입처 지급) — 요청 중 닫힘 막힘', bug, { width: W, results: out }));
})().catch((e) => { console.error(e); process.exit(2); });
