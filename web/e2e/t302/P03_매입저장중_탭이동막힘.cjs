// P03 (대조) 매입 등록 저장 중 왼쪽 메뉴(탭)가 눌리는가 — 매입 모달은 화면 전체를 덮어 탭을 누를 수 없어야 한다(현재 PASS)
// 기대: 저장 중에는 탭 이동을 막거나, 옮겨 가도 결과를 알려 준다
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const before = (await L.api(u, 'GET', '/purchases?limit=1&offset=0')).total;
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '매입정보');
  await page.locator('button.main-btn', { hasText: '매입 등록' }).click();
  await page.waitForSelector('.main-modal');
  const row = page.locator('.main-table--purchase-modal tbody tr').first();
  await row.locator('select').nth(0).selectOption({ index: 1 });
  await row.locator('select').nth(1).selectOption({ index: 2 });
  await page.waitForTimeout(1500);
  await row.locator('input.main-input-qty').fill('2');
  { const p = row.locator('input.main-input-unit-price--purchase'); await p.click(); await page.keyboard.press('Control+A'); await page.keyboard.type('2500'); }
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/purchases$/.test(new URL(url).pathname), { ms: 3000 });
  await page.locator('.main-modal-footer button.primary').click();
  await page.waitForTimeout(400);
  const tabBtn = page.locator('button.main-tab', { hasText: '매출정보' });
  const tabEnabled = !(await tabBtn.isDisabled());
  await tabBtn.click({ force: true, timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(500);
  const title = await page.locator('h2.main-page-title').innerText().catch(() => '');
  const cap1 = await L.shot(page, `P03_${W}_저장중탭이동`);
  await page.waitForTimeout(3500);
  const after = (await L.api(u, 'GET', '/purchases?limit=1&offset=0')).total;
  const body = await page.locator('main.main-content').innerText();
  const anyNotice = /매입.*(저장|등록)/.test(body);
  const cap2 = await L.shot(page, `P03_${W}_응답후`);
  await browser.close();
  const bug = title.includes("매출정보");
  process.exit(L.finish(`P03_${W}`, '매입 저장 중 탭 이동 — 화면 전체 모달이 덮어 막힘(대조)', bug, {
    width: W, tabEnabledDuringSave: tabEnabled, pageAfterClick: title, postCount: st.count, savedRows: after - before, noticeShown: anyNotice,
    expected: '저장 중 탭 잠금 또는 저장 결과 안내', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
