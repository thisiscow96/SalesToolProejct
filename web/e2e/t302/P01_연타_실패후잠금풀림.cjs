// P01 저장 버튼 두 번 클릭 + Enter 연타 → 요청 1번인가(②), 서버 500 실패 뒤 버튼이 다시 풀리고 창·입력이 남는가(④)
// 대상: 매입 등록 · 수금 등록 · 폐기 등록 · 거래처 등록 · 직원 추가 · 로그인 · 상품 마스터
// 실패는 page.route 로 500 을 돌려주므로 DB 에는 아무것도 저장되지 않는다
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
const SC = {
  purchase: { tab: '매입정보', btn: '매입 등록', post: /\/api\/purchases$/, prep: async (page) => {
    const row = page.locator('.main-table--purchase-modal tbody tr').first();
    await row.locator('select').nth(0).selectOption({ index: 1 });
    await row.locator('select').nth(1).selectOption({ index: 1 });
    await page.waitForTimeout(1200);
    await row.locator('input.main-input-qty').fill('1');
  }, save: '.main-modal-footer button.primary', open: '.main-modal', err: '.main-modal [role=alert]' },
  collect: { tab: '매출정보', btn: '수금 등록', post: /\/api\/payments$/, prep: async (page) => {
    await page.waitForTimeout(800);
    const sel = page.locator('.main-modal select[required]').first();
    const n = await sel.locator('option').count();
    for (let i = 1; i < n; i++) { await sel.selectOption({ index: i }); await page.waitForTimeout(300); if (await page.locator('.main-modal input.main-input-collect-amount').count()) break; }
    await page.locator('.main-modal input.main-input-collect-amount').first().fill('100');
  }, save: '.main-modal-footer button.primary', open: '.main-modal', err: '.main-modal [role=alert]' },
  disposal: { tab: '폐기정보', btn: '폐기 등록', post: /\/api\/disposals$/, prep: async (page) => {
    await page.waitForTimeout(1200);
    await page.locator('.main-modal tbody input[type=checkbox]').first().check();
    await page.locator('.main-modal input.main-input-qty--disposal').first().fill('0.1');
  }, save: '.main-modal-footer button.primary', open: '.main-modal', err: '[role=alert]' },
  partner: { tab: '거래처', btn: '거래처 등록', post: /\/api\/partners$/, prep: async (page) => {
    await page.locator('.partner-modal input[type=text]').first().fill('T302실패확인');
  }, save: '.partner-modal button[type=submit], .partner-modal .main-modal-footer button.primary', open: '.partner-modal', err: '.partner-modal [role=alert]' },
  staff: { tab: '직원 관리', btn: '직원 추가', post: /\/api\/staff$/, prep: async (page) => {
    const ins = page.locator('.staff-form input[type=text]');
    await ins.nth(0).fill('T302D'); await ins.nth(1).fill('t302d');
    await page.locator('.staff-form input[placeholder="8자 이상"]').fill('T302-temp-pass!');
  }, save: '.main-modal-footer button.primary', open: '.staff-form', err: '.main-modal [role=alert]' },
  product: { tab: '상품 마스터', btn: '상품 등록', post: /\/api\/products/, prep: async (page) => {
    await page.locator('.main-modal tbody input').first().fill('T302실패품목');
  }, save: '.main-modal-footer button.primary', open: '.main-modal', err: '.main-modal [role=alert]' },
};
async function runOne(name, u) {
  const s = SC[name];
  const { browser, page } = await L.open({ user: u, width: W });
  try {
    await page.waitForSelector('button.main-tab');
    await L.tab(page, s.tab);
    await page.locator('button.main-btn', { hasText: s.btn }).first().click();
    await page.waitForSelector(s.open);
    await s.prep(page);
    const st = await L.slow(page, (url, m) => m === 'POST' && s.post.test(new URL(url).pathname), { ms: 1500, fail: true });
    const save = page.locator(s.save).first();
    await save.dblclick();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await save.click({ force: true }).catch(() => {});
    await page.waitForTimeout(2500);
    const r = { scenario: name, postCount: st.count, openAfterFail: (await page.locator(s.open).count()) > 0,
      saveEnabledAfterFail: !(await page.locator(s.save).first().isDisabled().catch(() => true)),
      errorShown: (await page.locator(s.err).allInnerTexts().catch(() => [])).join(' ').slice(0, 80) };
    r.capture = await L.shot(page, `P01_${name}_${W}_실패후`);
    r.pass = r.postCount === 1 && r.openAfterFail && r.saveEnabledAfterFail && /500|오류/.test(r.errorShown);
    return r;
  } finally { await browser.close(); }
}
(async () => {
  const u = await L.apiLogin();
  const out = [];
  for (const n of Object.keys(SC)) { try { out.push(await runOne(n, u)); } catch (e) { out.push({ scenario: n, error: e.message.slice(0, 200), pass: false }); } }
  // 로그인 화면(연타·실패 후 풀림)
  {
    const { browser, page } = await L.open({ width: W, path: '/login' });
    await page.waitForSelector('.login-form');
    const st = await L.slow(page, (url) => /\/api\/auth\/login/.test(url), { ms: 1500, fail: true });
    await page.locator('form.login-form input').nth(0).fill('admin001');
    await page.locator('input[type=password]').fill('sample');
    await page.locator('button.login-btn').dblclick();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2500);
    const r = { scenario: 'login', postCount: st.count, saveEnabledAfterFail: !(await page.locator('button.login-btn').isDisabled()), errorShown: await page.locator('.login-error').innerText().catch(() => ''), toggleEnabledAfterFail: !(await page.locator('.login-mode-btn').nth(1).isDisabled()) };
    r.pass = r.postCount === 1 && r.saveEnabledAfterFail && r.toggleEnabledAfterFail;
    await browser.close();
    out.push(r);
  }
  const bug = out.some((r) => !r.pass);
  process.exit(L.finish(`P01_${W}`, '저장 연타 요청 1번 · 실패 후 잠금 풀림·입력 유지', bug, { width: W, results: out, expected: '요청 1번 · 실패 뒤 창 유지·버튼 다시 눌림·오류 표시' }));
})().catch((e) => { console.error(e); process.exit(2); });
