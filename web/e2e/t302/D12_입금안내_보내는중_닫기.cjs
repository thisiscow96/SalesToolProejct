// D12 거래처 원장 → [입금 안내]: 메일 보내는 중에 [닫기]·Esc·바깥 클릭으로 창이 닫히는가 (메일은 그대로 나가고 결과 안내를 못 봄)
// 기대: 보내는 중에는 닫히지 않음. (MAIL_DRY_RUN=1 이라 실제 메일은 나가지 않음)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const u = await L.apiLogin();
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '거래처');
  // 입금 안내는 거래처당 하루 1번 — 오늘 아직 안 보낸(보내기 버튼이 열린) 판매처를 찾는다
  let canSend = false; let used = '';
  const sendBtn = page.locator('.reminder-modal button', { hasText: '메일 보내기' });
  for (const nm of ['농심', '오뚜기', 'T302동업']) {
    const b = page.locator(`button[aria-label="${nm} 원장"]`).first();
    if (!(await b.count())) continue;
    await b.click();
    await page.waitForSelector('.ledger-remind-btn');
    await page.locator('.ledger-remind-btn').click();
    await page.waitForSelector('.reminder-modal');
    await page.waitForTimeout(1200);
    const email = page.locator('.reminder-modal input[type=email]');
    if (await email.count()) await email.fill('t302@example.com');
    canSend = (await sendBtn.count()) > 0 && !(await sendBtn.isDisabled());
    if (canSend) { used = nm; break; }
    await page.keyboard.press('Escape'); await page.waitForTimeout(200); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  }
  if (!canSend) { console.error('오늘 보낼 수 있는 판매처가 없음(하루 1번) — 새 DB 나 내일 다시 실행'); await browser.close(); process.exit(2); }
  const st = await L.slow(page, (url, m) => m === 'POST' && /reminder/.test(url) && !/copy/.test(url), { ms: 3000 });
  if (canSend) await sendBtn.click();
  await page.waitForTimeout(400);
  const closeEnabled = !(await page.locator('.reminder-modal button', { hasText: '닫기' }).isDisabled());
  await page.locator('.reminder-modal button', { hasText: '닫기' }).click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(300);
  const closed = (await page.locator('.reminder-modal').count()) === 0;
  const cap1 = await L.shot(page, `D12_${W}_보내는중닫기`);
  await page.waitForTimeout(3300);
  await browser.close();
  const bug = canSend && closeEnabled && closed;
  process.exit(L.finish(`D12_${W}`, '입금 안내 — 보내는 중 닫기 가능(발송 결과 안내 못 봄)', bug, {
    width: W, partner: used, sendPossible: canSend, closeEnabledDuringSend: closeEnabled, closedDuringSend: closed, postCount: st.count,
    expected: '보내는 중 닫기 잠김', capture: [cap1],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
