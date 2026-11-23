// D11 직원 관리 창(직원 추가·비밀번호 재설정·삭제): 처리 중에 [닫기]는 잠기지만 Esc·바깥 클릭으로는 닫히는가
// 기대: 처리 중에는 어떤 방법으로도 닫히지 않음(닫힌 뒤에도 요청은 끝까지 가서 직원이 만들어짐)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const old = ((await L.api(u, 'GET', '/staff')).data || []).find((x) => x.login_id === 't302c');
  if (old) await L.api(u, 'DELETE', `/staff/${old.id}`);
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '직원 관리');
  await page.locator('button.main-btn', { hasText: '직원 추가' }).click();
  await page.waitForSelector('.staff-form');
  const ins = page.locator('.staff-form input[type=text]');
  await ins.nth(0).fill('T302C');
  await ins.nth(1).fill('t302c');
  await page.locator('.staff-form input[placeholder="8자 이상"]').fill('T302-temp-pass!');
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/staff$/.test(new URL(url).pathname), { ms: 3000 });
  await page.locator('.main-modal-footer button.primary').click();
  await page.waitForTimeout(400);
  const closeBtnDisabled = await page.locator('.main-modal-footer button.secondary').isDisabled();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closedByEsc = (await page.locator('.staff-form').count()) === 0;
  const cap1 = await L.shot(page, `D11_${W}_처리중Esc`);
  await page.waitForTimeout(3300);
  const created = ((await L.api(u, 'GET', '/staff')).data || []).some((x) => x.login_id === 't302c');
  const notice = await page.locator('.partner-notice').innerText().catch(() => '');
  await browser.close();
  const bug = closeBtnDisabled && closedByEsc;
  process.exit(L.finish(`D11_${W}`, '직원 창 — 처리 중 닫기 버튼은 잠기나 Esc·바깥 클릭으로 닫힘', bug, {
    width: W, closeButtonDisabledDuring: closeBtnDisabled, closedByEscDuringRequest: closedByEsc, staffCreated: created, noticeAfter: notice, postCount: st.count,
    expected: '처리 중 Esc·바깥 클릭 무시', capture: [cap1],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
