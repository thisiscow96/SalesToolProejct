// D17 목록 [엑셀(CSV) 다운로드]: 전체 목록을 다시 불러오는 동안 진행 표시가 없고 버튼도 잠기지 않아,
// 느린 망에서 멈춘 줄 알고 다시 누르면 같은 파일이 두 번 받아지는가. 기대: 받는 중 표시 + 잠금, 다운로드 1번
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '매입정보');
  await page.waitForSelector('table.main-table tbody tr');
  // CSV 는 limit 없이 같은 목록을 다시 부른다 — limit 이 없는 GET /api/purchases 만 2.5초 늦춤
  const st = await L.slow(page, (url, m) => m === 'GET' && /\/api\/purchases\?/.test(url) && !/limit=/.test(url), { ms: 2500 });
  const downloads = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const btn = page.locator('button', { hasText: '엑셀(CSV) 다운로드' }).first();
  await btn.click();
  await page.waitForTimeout(800);
  const disabledDuring = await btn.isDisabled();
  const label = await btn.innerText();
  const cap = await L.shot(page, `D17_${W}_받는중`);
  await btn.click().catch(() => {});
  await page.waitForTimeout(4500);
  await browser.close();
  const bug = !disabledDuring && st.count > 1;
  process.exit(L.finish(`D17_${W}`, 'CSV 다운로드 — 받는 중 표시·잠금 없음, 두 번 누르면 두 번 받음', bug, {
    width: W, csvFetches: st.count, downloads, buttonDisabledDuring: disabledDuring, labelDuring: label,
    expected: '받는 중 표시·잠금, 1번', capture: [cap],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
