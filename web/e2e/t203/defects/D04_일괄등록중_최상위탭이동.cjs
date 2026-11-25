// D04 (하·web) 매입서 상세에서 [선택한 줄 매입 등록] 요청 중 왼쪽 최상위 탭(예 매출정보)을 누르면 이동됨 → 결과 문구를 못 보고 떠남
// (요청은 서버에서 끝나 매입은 생김 — 데이터 문제 아님). B② 보고서 "최상위 탭 잠금" 알려진 위험. 기존 P03(매입 저장 중 탭 이동)은 모달이 덮어 막힘
// 원인 추정: web/src/pages/TabPurchaseDocs.jsx 의 navBusy 가 하위 보기에만 쓰이고 Main.jsx 최상위 탭에 전달되지 않음
const L = require('../lib.cjs');
(async () => {
  const f = L.fixture(); const u = await L.login('owner');
  const r = await L.call(u, 'POST', '/purchase-docs', { doc_no: `D04-${Date.now().toString(36)}`, supplier_partner_id: f.partners.PB, auto_convert: false,
    lines: [{ trade_date: f.dates.E, item_name: '오이고추', grade: '특', spec: '10kg 상자', qty: 18, unit_price: 29000 }] }, { 'Idempotency-Key': L.key('d04') });
  const doc = r.json.data.docs[0];
  const { browser, page } = await L.open({ user: u });
  await L.tab(page, '매입서 대조');
  await L.tid(page, `pdoc-open-${doc.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(400);
  await L.tid(page, 'pdoc-check-all').check();
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/purchase-docs\/convert$/.test(url), { ms: 3000 });
  await L.tid(page, 'pdoc-convert-selected').click(); await page.waitForTimeout(300);
  const tabBtn = page.locator('button.main-tab', { hasText: '매출정보' });
  const enabled = !(await tabBtn.isDisabled());
  await tabBtn.click({ force: true, timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(400);
  const title = await page.locator('h2.main-page-title').innerText().catch(() => '');
  const cap1 = await L.shot(page, 'D04_일괄등록중_탭이동');
  await page.waitForTimeout(3200);
  await browser.close();
  const pool = L.db(); const n = Number((await pool.query(`SELECT COUNT(*) c FROM purchase WHERE purchase_doc_line_id=$1 AND status='active'`, [doc.lines[0].id])).rows[0].c); await pool.end();
  const bug = /매출정보/.test(title);
  process.exit(L.finish('D04', '일괄 매입 등록 중 최상위 탭 이동됨', bug, { tabEnabledDuringRequest: enabled, pageAfterClick: title, postCount: st.count, purchasesCreated: n, capture: cap1,
    expected: '요청 중 최상위 탭 잠금(또는 이동 뒤 결과 안내)', actual: bug ? '이동됨 — 결과 문구 못 봄(매입은 생성됨)' : '기대대로' }));
})().catch((e) => { console.error(e); process.exit(2); });
