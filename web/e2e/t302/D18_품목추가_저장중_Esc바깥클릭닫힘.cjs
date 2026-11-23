// D18 (C302-21, T-404 에서 추가) 매입 등록 위 [목록에 없는 품목] 창: 추가 요청 중 Esc·바깥 클릭·취소로 닫히는가
// 기대: 요청 중에는 닫히지 않고, 끝나면(실패 시) 창과 입력이 남아 다시 누를 수 있다
// 데이터: 요청은 브라우저에서 2.5초 늦춘 뒤 500 으로 끝내므로 DB 에 품목이 생기지 않는다
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '매입정보');
  await page.locator('button.main-btn', { hasText: '매입 등록' }).click();
  await page.waitForSelector('.main-modal');
  await page.locator('button.main-modal-toolbar-btn', { hasText: '목록에 없는 품목' }).click();
  const dlg = page.locator('.partner-modal', { hasText: '목록에 없는 품목 추가' });
  await dlg.waitFor();
  await dlg.locator('input[type=text]').first().fill('T404 품목 확인');
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/products\/personal$/.test(new URL(url).pathname), { ms: 2500, fail: true });
  await dlg.locator('button[type=submit]').click();
  await page.waitForTimeout(300);
  const cancelDisabled = await dlg.locator('button.secondary', { hasText: '취소' }).isDisabled();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const openAfterEsc = (await dlg.count()) > 0;
  await page.mouse.click(5, 5); // 바깥(배경) 클릭
  await page.waitForTimeout(200);
  const openAfterBackdrop = (await dlg.count()) > 0;
  const cap = await L.shot(page, `D18_${W}_추가중`);
  await page.waitForTimeout(3000);
  const openAfterFail = (await dlg.count()) > 0;
  const submitEnabledAfter = openAfterFail && !(await dlg.locator('button[type=submit]').isDisabled());
  await browser.close();
  const bug = !openAfterEsc || !openAfterBackdrop || !cancelDisabled || !openAfterFail || !submitEnabledAfter || st.count !== 1;
  process.exit(L.finish(`D18_${W}`, '품목 추가 — 저장 중 Esc·바깥 클릭·취소로 닫힘', bug, {
    width: W, requests: st.count, cancelDisabledDuring: cancelDisabled, openAfterEsc, openAfterBackdrop, openAfterFail, submitEnabledAfter,
    expected: '요청 중 닫히지 않음, 실패 뒤 다시 누를 수 있음', capture: [cap],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
