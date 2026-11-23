// D06 수금 등록: 저장 요청 중 [취소]로 닫을 수 있고, 바로 다시 [수금 등록]을 열면
// 앞 요청이 끝나는 순간 새로 연 수금 창이 저절로 닫히고 입력이 사라지는가(앞 요청 결과가 새 창에 적용)
// 기대: 요청 중에는 닫히지 않음(또는 새 창은 앞 요청 결과에 영향받지 않음)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
async function pickPartnerWithUnpaid(page) {
  const sel = page.locator('.main-modal select[required]').first();
  const n = await sel.locator('option').count();
  for (let i = 1; i < n; i++) {
    await sel.selectOption({ index: i });
    await page.waitForTimeout(300);
    if (await page.locator('.main-modal input.main-input-collect-amount').count()) return await sel.locator('option').nth(i).innerText();
  }
  return null;
}
(async () => {
  const u = await L.apiLogin();
  const payBefore = (await L.api(u, 'GET', '/payments?limit=1&offset=0')).total;
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '매출정보');
  await page.locator('button.main-btn', { hasText: '수금 등록' }).click();
  await page.waitForSelector('.main-modal');
  await page.waitForTimeout(800);
  const partner = await pickPartnerWithUnpaid(page);
  if (!partner) throw new Error('미수 매출이 있는 거래처 없음 — 시드 확인');
  await page.locator('.main-modal input.main-input-collect-amount').first().fill('1000');
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/payments$/.test(new URL(url).pathname), { ms: 3500 });
  await page.locator('.main-modal-footer button.primary').click();
  await page.waitForTimeout(400);
  const cancel = page.locator('.main-modal-footer button.secondary');
  const cancelEnabled = !(await cancel.isDisabled());
  await cancel.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(300);
  const closedDuring = (await page.locator('.main-modal').count()) === 0;
  // 다시 열어서 두 번째 수금을 입력하기 시작
  await page.locator('button.main-btn', { hasText: '수금 등록' }).click();
  await page.waitForTimeout(700);
  const reopened = (await page.locator('.main-modal').count()) > 0;
  const partner2 = reopened ? await pickPartnerWithUnpaid(page) : null;
  if (partner2) await page.locator('.main-modal input.main-input-collect-amount').first().fill('500');
  const cap1 = await L.shot(page, `D06_${W}_다시열어입력중`);
  await page.waitForTimeout(3500); // 첫 요청 끝남
  const stillOpen = (await page.locator('.main-modal').count()) > 0;
  const cap2 = await L.shot(page, `D06_${W}_첫요청끝난뒤`);
  await browser.close();
  const payAfter = (await L.api(u, 'GET', '/payments?limit=1&offset=0')).total;
  const bug = cancelEnabled && closedDuring && reopened && !stillOpen;
  process.exit(L.finish(`D06_${W}`, '수금 등록 — 저장 중 닫고 다시 연 창이 앞 요청 끝날 때 저절로 닫힘', bug, {
    width: W, partner, cancelEnabledDuring: cancelEnabled, closedDuringRequest: closedDuring, reopened, secondInputStarted: !!partner2,
    secondModalStillOpenAfterFirstResponse: stillOpen, paymentsSaved: payAfter - payBefore, postCount: st.count,
    expected: '요청 중 닫기 잠금, 또는 다시 연 창 유지', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
