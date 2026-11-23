// D14 회원가입: [중복확인] 요청 중에도 이메일·중매인 번호 칸을 고칠 수 있어, 앞 값의 확인 결과가 고친 값에 붙는가
// 예) 비어 있는 번호로 확인 → 응답 전 이미 쓰는 번호(admin001)로 고침 → '사용 가능' 표시 + 확인 완료 상태
// 기대: 확인 중에는 칸을 잠그거나, 응답이 지금 칸의 값과 다르면 버린다
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const { browser, page } = await L.open({ width: W, path: '/signup' });
  await page.waitForSelector('.signup-form');
  const st = await L.slow(page, (url) => /check-agent-no|check-email/.test(url), { ms: 2000 });
  const agent = page.locator('input[placeholder="중매인 번호 입력"]');
  const agentRow = page.locator('.signup-label', { hasText: '중매인 번호' });
  await agent.fill('t302free' + (Date.now() % 1000));
  await agentRow.locator('button.signup-check-btn').click();
  await page.waitForTimeout(300);
  const agentEditable = !(await agent.isDisabled());
  await agent.fill('admin001'); // 이미 쓰는 번호로 고침
  await page.waitForTimeout(2300);
  const agentText = await agentRow.innerText();
  const cap1 = await L.shot(page, `D14_${W}_번호`);
  // 이메일도 같은 방식
  const email = page.locator('input[type=email]');
  const emailRow = page.locator('.signup-label', { hasText: '이메일' }).first();
  await email.fill(`t302free${Date.now() % 1000}@example.com`);
  await emailRow.locator('button.signup-check-btn').click();
  await page.waitForTimeout(300);
  const emailEditable = !(await email.isDisabled());
  await email.fill('admin@sample.local'); // 이미 가입된 이메일(seed-admin)
  await page.waitForTimeout(2300);
  const emailText = await emailRow.innerText();
  const cap2 = await L.shot(page, `D14_${W}_이메일`);
  await browser.close();
  const agentOkShown = /사용 가능/.test(agentText) || !/사용 중|사용 불가/.test(agentText) && /확인/.test(agentText) && false;
  const emailOkShown = /사용 가능/.test(emailText);
  const bug = (agentEditable && /사용 가능/.test(agentText)) || (emailEditable && emailOkShown);
  process.exit(L.finish(`D14_${W}`, '가입 — 중복확인 중 칸을 고치면 앞 값의 결과(사용 가능)가 고친 값에 붙음', bug, {
    width: W, checkCalls: st.count, agentEditableDuringCheck: agentEditable, agentFieldNow: 'admin001', agentRowText: agentText.replace(/\s+/g, ' ').slice(0, 80),
    emailEditableDuringCheck: emailEditable, emailFieldNow: 'admin@sample.local', emailRowText: emailText.replace(/\s+/g, ' ').slice(0, 120),
    expected: '고친 값(admin001·admin@sample.local)에 사용 가능이 뜨지 않음', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
