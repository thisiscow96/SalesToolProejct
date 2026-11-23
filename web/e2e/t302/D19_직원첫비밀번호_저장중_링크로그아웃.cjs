// D19 (C302-22, T-404 에서 추가) 직원 비밀번호 화면: 저장 요청 중 [로그인으로 돌아가기]·[로그아웃]이 눌리는가
//  ① /staff-setup(초대 코드로 비밀번호 정하기)  ② 임시 비밀번호로 들어온 직원의 강제 변경 화면
// 기대: 요청 중 링크·로그아웃 잠김, 끝나면(실패 시) 다시 쓸 수 있음
// 데이터: 요청은 2.5초 늦춘 뒤 500 으로 끝내므로 서버·DB 는 바뀌지 않는다. ②는 세션에 '변경 필요' 직원 상태만 넣어 화면을 띄운다
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const out = {};
  // ① 초대 코드 화면
  {
    const { browser, page } = await L.open({ width: W, path: '/staff-setup' });
    await page.waitForSelector('form.login-form');
    const st = await L.slow(page, (url, m) => m === 'POST', { ms: 2500, fail: true });
    const texts = page.locator('form.login-form input[type=text]');
    await texts.nth(0).fill('admin001');
    await texts.nth(1).fill('t404x');
    await texts.nth(2).fill('123456');
    const pws = page.locator('form.login-form input[type=password]');
    for (let i = 0; i < (await pws.count()); i++) await pws.nth(i).fill('Abcd1234!x');
    await page.locator('button.login-btn').click();
    await page.waitForTimeout(300);
    const linkActive = (await page.locator('a.login-signup-link', { hasText: '로그인으로 돌아가기' }).count()) > 0;
    await page.locator('.login-signup-link', { hasText: '로그인으로 돌아가기' }).click({ timeout: 800 }).catch(() => {});
    await page.waitForTimeout(200);
    const pathDuring = new URL(page.url()).pathname;
    await page.waitForTimeout(3000);
    const linkBack = (await page.locator('a.login-signup-link', { hasText: '로그인으로 돌아가기' }).count()) > 0;
    out.setup = { requests: st.count, linkActiveDuring: linkActive, pathDuring, linkBackAfter: linkBack };
    await browser.close();
  }
  // ② 강제 변경 화면
  {
    const u = await L.apiLogin();
    const fake = { ...u, staff: { id: 0, login_id: 't404x', name: 'T404', role: 'clerk', must_change_password: true } };
    const { browser, page } = await L.open({ width: W, user: fake });
    await page.waitForSelector('form.login-form');
    const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/me\/password/.test(url), { ms: 2500, fail: true });
    await page.locator('input[type=password]').nth(0).fill('temp-pass');
    const pws = page.locator('input[type=password]');
    for (let i = 1; i < (await pws.count()); i++) await pws.nth(i).fill('Abcd1234!x');
    await page.locator('button.login-btn').click();
    await page.waitForTimeout(300);
    const logout = page.locator('button.login-link-btn', { hasText: '로그아웃' });
    const logoutDisabled = await logout.isDisabled();
    await logout.click({ force: true, timeout: 800 }).catch(() => {});
    await page.waitForTimeout(300);
    const pathDuring = new URL(page.url()).pathname;
    const cap = await L.shot(page, `D19_${W}_강제변경_저장중`);
    await page.waitForTimeout(3000);
    const logoutEnabledAfter = !(await logout.isDisabled().catch(() => true));
    out.force = { requests: st.count, logoutDisabledDuring: logoutDisabled, pathDuring, logoutEnabledAfter, capture: cap };
    await browser.close();
  }
  const bug = out.setup.linkActiveDuring || out.setup.pathDuring !== '/staff-setup' || !out.setup.linkBackAfter
    || !out.force.logoutDisabledDuring || out.force.pathDuring === '/login' || !out.force.logoutEnabledAfter;
  process.exit(L.finish(`D19_${W}`, '직원 비밀번호 화면 — 저장 중 링크·로그아웃 눌림', bug, { width: W, ...out, expected: '요청 중 잠김, 끝나면 풀림' }));
})().catch((e) => { console.error(e); process.exit(2); });
