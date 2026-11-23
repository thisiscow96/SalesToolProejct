// D10 직원 관리: 직원 A [정지] 요청 중에 직원 B 의 버튼을 누르면, A 의 버튼 잠금이 풀려(잠금 표시가 한 줄만 기억)
// A 에 같은 요청을 한 번 더 보낼 수 있는가. 기대: 요청 중인 줄은 끝날 때까지 계속 잠김, A 정지 요청 1번
// 준비: 직원 T302a·T302b 가 없으면 API 로 만든다(임시 비밀번호, 로컬 테스트 DB)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  let list = (await L.api(u, 'GET', '/staff')).data || [];
  for (const id of ['t302a', 't302b']) {
    let s = list.find((x) => x.login_id === id);
    if (!s) await L.api(u, 'POST', '/staff', { name: id.toUpperCase(), login_id: id, role: 'input', temp_password: 'T302-temp-pass!' });
    else if (s.status === 'suspended') await L.api(u, 'POST', `/staff/${s.id}/resume`);
  }
  list = (await L.api(u, 'GET', '/staff')).data;
  const A = list.find((x) => x.login_id === 't302a'), B = list.find((x) => x.login_id === 't302b');
  const { browser, page } = await L.open({ user: u, width: W });
  const calls = { A: 0, B: 0 };
  await page.route('**/api/staff/*/suspend', async (route) => {
    const id = Number(route.request().url().match(/staff\/(\d+)\/suspend/)[1]);
    const who = id === A.id ? 'A' : 'B';
    calls[who]++;
    await L.sleep(who === 'A' ? 4000 : 800);
    await route.continue().catch(() => {});
  });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '직원 관리');
  await page.waitForSelector('table.staff-table');
  const rowA = page.locator('table.staff-table tbody tr', { hasText: 't302a' });
  const rowB = page.locator('table.staff-table tbody tr', { hasText: 't302b' });
  await rowA.locator('button', { hasText: '정지' }).click();
  await page.waitForTimeout(200);
  const aLockedAfterOwnClick = await rowA.locator('button', { hasText: '정지' }).isDisabled();
  await rowB.locator('button', { hasText: '정지' }).click();
  await page.waitForTimeout(200);
  const aLockedAfterBClick = await rowA.locator('button', { hasText: '정지' }).isDisabled();
  await page.waitForTimeout(1200); // B 끝남, A 아직 진행
  const aBtn = rowA.locator('button', { hasText: '정지' });
  const aEnabledWhilePending = (await aBtn.count()) > 0 && !(await aBtn.isDisabled());
  const cap1 = await L.shot(page, `D10_${W}_A요청중_A버튼풀림`);
  if (aEnabledWhilePending) await aBtn.click().catch(() => {});
  await page.waitForTimeout(4500);
  await browser.close();
  // 되돌려 놓기
  for (const s of [A, B]) await L.api(u, 'POST', `/staff/${s.id}/resume`).catch(() => {});
  const bug = !aLockedAfterBClick || aEnabledWhilePending || calls.A > 1;
  process.exit(L.finish(`D10_${W}`, '직원 관리 — 다른 직원 버튼을 누르면 요청 중인 줄 잠금이 풀림', bug, {
    width: W, aLockedAfterOwnClick, aLockedAfterBClick, aEnabledWhileOwnRequestPending: aEnabledWhilePending, suspendCalls: calls,
    expected: 'A 는 자기 요청이 끝날 때까지 잠김 · A 정지 요청 1번', capture: [cap1],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
