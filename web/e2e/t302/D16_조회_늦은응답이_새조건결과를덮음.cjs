// D16 조회 화면 경쟁 상태: 조건 A 로 [검색] → 응답 전에 조건 B 로 다시 [검색] → B 결과가 먼저 오고 A 결과가 늦게 와서 화면을 덮는가
// 대상: 일별 매입·매출(거래처 필터) · 재고현황(거래처 필터) · 지급정보(거래처) — 목록 페이지 훅(usePagedList)은 순번으로 막고 있어 대조군으로 매입정보도 확인
// 기대: 화면에는 마지막 조건(B=전체)의 결과만 남는다
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
async function race(u, tabName, partnerSel, searchBtnText, apiRe, readRows) {
  const { browser, page } = await L.open({ user: u, width: W });
  try {
    await page.waitForSelector('button.main-tab');
    await L.tab(page, tabName);
    await page.waitForTimeout(1200);
    const sel = page.locator(partnerSel).first();
    const opts = await sel.locator('option').allInnerTexts();
    const pick = opts.find((o) => /농심|한국청과|오뚜기/.test(o));
    // A 조건(특정 거래처) 요청만 3초 늦춘다
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (apiRe.test(url) && /partner_id=\d+/.test(url)) await L.sleep(3000);
      await route.continue().catch(() => {});
    });
    await sel.selectOption({ label: pick });
    await page.locator('.main-filters button', { hasText: searchBtnText }).first().click();
    await page.waitForTimeout(300);
    await sel.selectOption({ index: 0 }); // 전체
    await page.locator('.main-filters button', { hasText: searchBtnText }).first().click();
    await page.waitForTimeout(1200);
    const rowsAfterB = await readRows(page);
    await page.waitForTimeout(3000); // A 늦은 응답 도착
    const rowsFinal = await readRows(page);
    const filterNow = await sel.locator('option:checked').innerText();
    const cap = await L.shot(page, `D16_${tabName.replace(/[^가-힣A-Za-z]/g, '')}_${W}`);
    return { screen: tabName, partnerA: pick, filterShownNow: filterNow, rowsAfterB, rowsFinal, overwritten: rowsFinal !== rowsAfterB, capture: cap };
  } finally { await browser.close(); }
}
const countRows = (sel) => async (page) => page.locator(sel).count();
(async () => {
  const u = await L.apiLogin();
  const out = [];
  const cases = [
    ['일별 매입·매출', '.main-filters--daily-trade select', '검색', /reports\/daily-purchase-sales/, countRows('table.main-table--daily-breakdown tbody tr')],
    ['재고현황', '.main-filters select', '검색', /\/api\/inventory/, countRows('table.main-table tbody tr')],
    ['매입정보', '.main-filters select >> nth=1', '검색', /\/api\/purchases\?/, countRows('table.main-table tbody tr')],
  ];
  for (const c of cases) { try { out.push(await race(u, ...c)); } catch (e) { out.push({ screen: c[0], error: e.message.slice(0, 200) }); } }
  const bug = out.some((r) => r.overwritten && r.screen !== '매입정보');
  process.exit(L.finish(`D16_${W}`, '조회 — 늦게 온 이전 조건 응답이 새 조건 결과를 덮음', bug, { width: W, results: out, expected: '마지막 조건(전체) 결과 유지' }));
})().catch((e) => { console.error(e); process.exit(2); });
