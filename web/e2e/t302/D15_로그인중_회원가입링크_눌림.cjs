// D15 로그인: 로그인 요청 중 아래 [회원가입]·[초대 코드로 비밀번호 설정] 링크가 눌리는가.
// 눌리면 가입 화면으로 갔다가 로그인 응답이 오는 순간 메인 화면으로 튕긴다(사용자가 본 '왔다갔다'와 같은 계열)
// 기대: 로그인 중에는 링크도 잠김(전환 버튼·입력칸과 같게)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const { browser, page } = await L.open({ width: W, path: '/login' });
  await page.waitForSelector('.login-form');
  const st = await L.slow(page, (url) => /\/api\/auth\/login/.test(url), { ms: 2500 });
  await page.locator('form.login-form input').nth(0).fill('admin001');
  await page.locator('input[type=password]').fill('sample');
  await page.click('button.login-btn');
  await page.waitForTimeout(300);
  const link = page.locator('a.login-signup-link');
  await link.click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(300);
  const urlDuring = new URL(page.url()).pathname;
  const cap1 = await L.shot(page, `D15_${W}_로그인중_링크누름`);
  await page.waitForTimeout(3000);
  const urlAfter = new URL(page.url()).pathname;
  const cap2 = await L.shot(page, `D15_${W}_응답후`);
  await browser.close();
  const bug = urlDuring !== '/login';
  process.exit(L.finish(`D15_${W}`, '로그인 중 회원가입 링크가 눌려 가입 화면 → 메인으로 튕김', bug, {
    width: W, loginCalls: st.count, pathAfterLinkClickDuringLogin: urlDuring, pathAfterLoginResponse: urlAfter,
    expected: '로그인 중 링크 잠김(/login 유지)', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
