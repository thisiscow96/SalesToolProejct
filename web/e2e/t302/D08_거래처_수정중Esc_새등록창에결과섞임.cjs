// D08 거래처: [수정] 저장 요청 중 Esc·바깥 클릭으로 창이 닫히고, 바로 [거래처 등록]을 열면
// 앞 수정 요청 결과가 "새 등록"으로 처리되어 ① 새로 연 등록 창이 저절로 닫히고 ② 목록에 같은 거래처가 두 줄로 보이고 ③ "등록했습니다" 안내가 뜨는가
// 기대: 요청 중에는 닫히지 않음 / 닫혀도 앞 결과는 '수정'으로만 반영
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const partners = await L.api(u, 'GET', '/partners');
  const arr = partners.data || partners;
  const target = arr.find((p) => p.name === '농심') || arr[0];
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '거래처');
  await page.waitForSelector('.partner-edit-btn');
  await page.locator(`button[aria-label="${target.name} 수정"]`).first().click();
  await page.waitForSelector('.partner-modal');
  const memo = page.locator('.partner-modal textarea').first();
  const hasMemo = await memo.count();
  if (hasMemo) await memo.fill('T302 확인 ' + new Date().toISOString().slice(11, 19));
  else await page.locator('.partner-modal input[type=text]').nth(1).fill('T302');
  const st = await L.slow(page, (url, m) => ['PUT', 'PATCH'].includes(m) && /\/api\/partners\/\d+$/.test(new URL(url).pathname), { ms: 3000 });
  await page.locator('.partner-modal .main-modal-footer button.primary, .partner-modal button[type=submit]').first().click();
  await page.waitForTimeout(400);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closedDuring = (await page.locator('.partner-modal').count()) === 0;
  await page.locator('button.main-btn', { hasText: '거래처 등록' }).click();
  await page.waitForTimeout(300);
  const newOpen = (await page.locator('.partner-modal').count()) > 0;
  if (newOpen) await page.locator('.partner-modal input[type=text]').first().fill('새거래처입력중');
  const cap1 = await L.shot(page, `D08_${W}_새등록입력중`);
  await page.waitForTimeout(3500);
  const newStillOpen = (await page.locator('.partner-modal').count()) > 0;
  const notice = await page.locator('.partner-notice').innerText().catch(() => '');
  const rowsWithName = await page.locator('table tbody tr', { hasText: target.name }).count();
  const cap2 = await L.shot(page, `D08_${W}_앞요청끝난뒤`);
  await browser.close();
  const bug = closedDuring && newOpen && (!newStillOpen || /등록했습니다/.test(notice) || rowsWithName > 1);
  process.exit(L.finish(`D08_${W}`, '거래처 수정 중 Esc → 새 등록 창에 앞 결과 적용', bug, {
    width: W, partner: target.name, putCount: st.count, closedByEscDuringRequest: closedDuring, newFormOpened: newOpen,
    newFormStillOpenAfterFirstResponse: newStillOpen, notice, rowsShowingSamePartner: rowsWithName,
    expected: '요청 중 닫힘 없음 · 새 등록 창 유지 · 수정 안내 · 목록 1줄', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
