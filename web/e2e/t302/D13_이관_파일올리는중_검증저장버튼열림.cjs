// D13 데이터 이관: 묶음 화면에서 파일을 바꿔 올리는 중(올리는 중…)에도 [전체 검증]·[저장(전부 아니면 전무)] 버튼이 잠기지 않아
// 이전 검증 결과로 저장이 눌리는가. 기대: 파일 올리는 중에는 검증·저장·묶음 삭제가 잠기고, 파일이 바뀌면 이전 검증 결과로 저장할 수 없음
// 준비: 로컬 테스트 DB 에 새 이관 묶음을 만든다(B_T-403 증거의 거래처 파일 2개 사용)
const path = require('path');
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
async function cleanup(u) {
  const bs = (await L.api(u, 'GET', '/migrations')).data || [];
  for (const b of bs.filter((x) => x.memo === 'T302 조작 검수')) {
    if (b.status === 'saved') await L.api(u, 'POST', `/migrations/${b.id}/rollback`, { reason: 'T302 재현 스크립트 정리' }).catch((e) => console.error('rollback', e.message));
    if (b.status === 'draft') await L.api(u, 'DELETE', `/migrations/${b.id}`).catch(() => {});
  }
}
(async () => {
  const u = await L.apiLogin();
  await cleanup(u); // 앞 실행이 남긴 T302 묶음 정리(로컬 DB)
  const { browser, page } = await L.open({ user: u, width: W });
  await page.waitForSelector('button.main-tab');
  await L.tab(page, '데이터 이관');
  await page.locator('.mg-create input[type=text]').fill('T302 조작 검수');
  await page.locator('.mg-create button[type=submit]').click();
  await page.waitForSelector('.mg-cards');
  const card = page.locator('.mg-card', { hasText: '거래처' }).first();
  await card.locator('input[type=file]').setInputFiles(path.join(__dirname, 'files/A_partner.xlsx'));
  await page.waitForTimeout(1500);
  await page.locator('.mg-actions button', { hasText: '전체 검증' }).click();
  await page.waitForSelector('.mg-actions--save', { timeout: 15000 });
  await page.waitForTimeout(500);
  const commitCalls = [];
  page.on('request', (r) => { if (/\/commit$/.test(r.url())) commitCalls.push(r.method()); });
  const st = await L.slow(page, (url, m) => m !== 'GET' && /\/migrations\/\d+\/files/.test(url), { ms: 4000 });
  await card.locator('input[type=file]').setInputFiles(path.join(__dirname, 'files/B_partner.xlsx'));
  await page.waitForTimeout(500);
  const uploading = await card.innerText();
  const validateEnabled = !(await page.locator('.mg-actions button', { hasText: '전체 검증' }).isDisabled());
  const saveBtn = page.locator('.mg-actions--save button');
  const saveEnabled = (await saveBtn.count()) > 0 && !(await saveBtn.isDisabled());
  const cap1 = await L.shot(page, `D13_${W}_올리는중_저장버튼`);
  if (saveEnabled) await saveBtn.click();
  await page.waitForTimeout(5000);
  const after = await page.locator('section[aria-label^="이관 묶음"]').innerText().catch(() => '');
  const cap2 = await L.shot(page, `D13_${W}_결과`);
  await browser.close();
  await cleanup(u);
  const bug = /올리는 중/.test(uploading) && (validateEnabled || saveEnabled);
  process.exit(L.finish(`D13_${W}`, '데이터 이관 — 파일 올리는 중 검증·저장 버튼이 열려 이전 검증 결과로 저장', bug, {
    width: W, uploadInProgressShown: /올리는 중/.test(uploading), validateEnabledDuringUpload: validateEnabled, saveEnabledDuringUpload: saveEnabled,
    commitRequests: commitCalls.length, uploadRequests: st.count, screenAfter: after.slice(0, 300),
    expected: '올리는 중 검증·저장 잠김', capture: [cap1, cap2],
  }));
})().catch((e) => { console.error(e); process.exit(2); });
