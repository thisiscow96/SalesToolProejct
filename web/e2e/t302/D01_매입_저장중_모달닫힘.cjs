// D01 매입 등록: 저장 요청 중 [취소]·바깥 클릭이 눌려 모달이 닫히는가 (기대: 요청 중에는 닫히지 않음)
// + 같은 시간에 저장 버튼 두 번 클릭·Enter 로 요청이 두 번 나가는가 (기대: 1번)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const before = (await L.api(u, 'GET', '/purchases?limit=1&offset=0')).total;
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  if (W < 768) { const t = page.locator('button.main-tab', { hasText: '매입정보' }); await t.scrollIntoViewIfNeeded(); }
  await L.tab(page, '매입정보');
  await page.locator('button.main-btn', { hasText: '매입 등록' }).click();
  await page.waitForSelector('.main-modal');
  const row = page.locator('.main-table--purchase-modal tbody tr').first();
  await row.locator('select').nth(0).selectOption({ index: 1 });
  await row.locator('select').nth(1).selectOption({ index: 1 });
  await page.waitForTimeout(1500); // 최근 단가 제안이 먼저 들어오게 기다림(D02 와 섞이지 않게)
  await row.locator('input.main-input-qty').fill('3');
  { const p = row.locator('input.main-input-unit-price--purchase'); await p.click(); await page.keyboard.press('Control+A'); await page.keyboard.type('1000'); }
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/purchases$/.test(new URL(url).pathname), { ms: 3000 });
  const save = page.locator('.main-modal-footer button.primary');
  await save.dblclick();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const cap1 = await L.shot(page, `D01_${W}_저장중`);
  const saveDisabled = await save.isDisabled();
  const cancel = page.locator('.main-modal-footer button.secondary');
  const cancelEnabled = !(await cancel.isDisabled());
  await cancel.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(300);
  const modalOpenAfterCancel = (await page.locator('.main-modal').count()) > 0;
  const cap2 = await L.shot(page, `D01_${W}_취소누른뒤`);
  await page.waitForTimeout(3500);
  const after = (await L.api(u, 'GET', '/purchases?limit=1&offset=0')).total;
  const cap3 = await L.shot(page, `D01_${W}_응답후`);
  await browser.close();
  const bug = cancelEnabled || !modalOpenAfterCancel || st.count !== 1;
  process.exit(L.finish(`D01_${W}`, '매입 등록 저장 중 취소/닫기·중복 요청', bug, {
    width: W, saveDisabledDuring: saveDisabled, cancelEnabledDuring: cancelEnabled, modalOpenAfterCancel, postCount: st.count, savedRows: after - before,
    expected: '요청 중 취소 버튼 잠김, 모달 유지, POST 1번', capture: [cap1, cap2, cap3],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
