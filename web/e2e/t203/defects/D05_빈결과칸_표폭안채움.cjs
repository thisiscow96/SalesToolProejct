// D05 (하·web) 새 표의 빈 결과 행 <td className="main-empty" colSpan=…> 가 display:flex(.main-empty) 라 표 칸이 아니게 돼 표 전체 폭을 채우지 못함(첫 열 폭만)
// 위치: TabAuction(경락 조회 빈 결과)·TabPurchaseDocs(매입서 없음)·AuctionSyncStatus(작업 없음)·ReviewQueue 등. 기존 화면은 td 에 .main-empty-cell 사용
const L = require('../lib.cjs');
(async () => {
  const u = await L.login('owner');
  const { browser, page } = await L.open({ user: u });
  await L.tab(page, '경락 시세');
  await L.tid(page, 'auction-empty').waitFor({ timeout: 8000 });
  const m = await page.evaluate(() => {
    const td = document.querySelector('[data-testid="auction-empty"]'); const tb = document.querySelector('[data-testid="auction-table"]');
    return { td: Math.round(td.getBoundingClientRect().width), table: Math.round(tb.getBoundingClientRect().width), display: getComputedStyle(td).display };
  });
  const cap = await L.shot(page, 'D05_빈결과칸_폭');
  await browser.close();
  const bug = m.td < m.table * 0.9;
  process.exit(L.finish('D05', '빈 결과 칸이 표 폭을 안 채움', bug, { ...m, capture: cap, expected: '빈 결과 칸 = 표 폭', actual: bug ? `칸 ${m.td}px / 표 ${m.table}px (display ${m.display})` : '기대대로' }));
})().catch((e) => { console.error(e); process.exit(2); });
