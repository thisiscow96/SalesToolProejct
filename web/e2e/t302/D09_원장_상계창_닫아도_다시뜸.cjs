// D09 거래처 원장 [상계]: 상계 창이 잔액을 불러오는 중(불러오는 중…)에 [닫기]를 누르면 닫히지만,
// 불러오기가 끝나는 순간 상계 창이 저절로 다시 뜨는가. + 상계 창이 떠 있을 때 Esc 를 누르면 원장 전체가 닫히는가
// 기대: 닫은 창은 다시 뜨지 않음 / Esc 는 맨 위 창(상계)만 닫음
// 준비: 상계 가능한 유형(same_market) 거래처가 없으면 API 로 'T302동업' 을 만든다(로컬 테스트 DB)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const ps = await L.api(u, 'GET', '/partners');
  let p = (ps.data || ps).find((x) => x.type === 'same_market');
  if (!p) p = (await L.api(u, 'POST', '/partners', { name: 'T302동업', type: 'same_market' })).data || {};
  const name = p.name || 'T302동업';
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '거래처');
  await page.locator(`button[aria-label="${name} 원장"]`).first().click();
  await page.waitForSelector('.ledger-offset-btn');
  // 1) 불러오는 중 닫기 → 다시 뜨는가
  const st = await L.slow(page, (url, m) => m === 'GET' && /\/ledger|\/payable/.test(url), { ms: 2500 });
  await page.locator('.ledger-offset-btn').click();
  await page.waitForTimeout(300);
  const sub = page.locator('.ledger-sub-backdrop');
  const openedLoading = (await sub.count()) > 0;
  await sub.locator('button.secondary', { hasText: '닫기' }).click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(200);
  const closedNow = (await sub.count()) === 0;
  await page.waitForTimeout(3000);
  const reappeared = (await sub.count()) > 0;
  const cap1 = await L.shot(page, `D09_${W}_닫았는데다시뜸`);
  // 2) 상계 창이 떠 있을 때 Esc
  if (!reappeared) { await page.locator('.ledger-offset-btn').click(); await page.waitForTimeout(3000); }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const ledgerOpenAfterEsc = (await page.locator('.ledger-backdrop').count()) > 0;
  const subOpenAfterEsc = (await sub.count()) > 0;
  const cap2 = await L.shot(page, `D09_${W}_Esc뒤`);
  await browser.close();
  const bug = (openedLoading && closedNow && reappeared) || !ledgerOpenAfterEsc;
  process.exit(L.finish(`D09_${W}`, '원장 상계 창 — 닫아도 다시 뜸 / Esc 가 원장 전체를 닫음', bug, {
    width: W, partner: name, slowedGets: st.count, closedWhileLoading: closedNow, reappearedAfterLoad: reappeared,
    escClosesWholeLedger: !ledgerOpenAfterEsc, subStillOpenAfterEsc: subOpenAfterEsc,
    expected: '다시 뜨지 않음 · Esc 는 상계 창만 닫음', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
