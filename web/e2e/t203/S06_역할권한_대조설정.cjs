// S06 직원 역할별 권한(주인·입력·조회·관리자) — 화면 버튼 노출 ↔ 서버 403 일치 + 대조 설정(허용오차 칸 오류·저장·재대조 반영·기본값) (실서버, D.E)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const f = L.fixture(); const D = f.dates; const P = f.partners; const tag = Date.now().toString(36).slice(-5);
  const s = L.suite(`S06_${W}`, '역할별 권한·대조 설정 — 실서버');
  const pool = L.db(); const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const owner = await L.login('owner');
  const post = async (body) => (await L.call(owner, 'POST', '/purchase-docs', body, { 'Idempotency-Key': L.key('s06') })).json?.data?.docs?.[0];
  // 매입서 하나: 줄1 등록됨(꽈리 특), 줄2 전환 가능(노랑 파프리카 특), 줄3 보류(빨강 파프리카 +5%)
  const d = await post({ doc_no: `R-${tag}`, supplier_partner_id: P.PA, auto_convert: true, lines: [
    { trade_date: D.E, item_name: '꽈리고추', grade: '특', spec: '4kg 상자', qty: 30, unit_price: 21000 },
    { trade_date: D.E, item_name: '빨강 파프리카', grade: '특', spec: '5kg 상자', qty: 40, unit_price: 25200 }] });
  const d2 = await post({ doc_no: `R2-${tag}`, supplier_partner_id: P.PA, auto_convert: false, lines: [
    { trade_date: D.E, item_name: '노랑 파프리카', grade: '특', spec: '5kg 상자', qty: 35, unit_price: 25000 }] });
  const [lc, lh] = d.lines.map((x) => x.id); const lp = d2.lines[0].id;
  s.c('준비: 등록됨·보류·전환 가능 줄', d.lines[0].status === 'CONVERTED' && d.lines[1].status === 'HOLD' && d2.lines[0].convertible, [d.lines, d2.lines].flat().map((x) => x.status));
  const roles = ['owner', 'input', 'view', 'admin'];
  // 기대(설계 7장): ui 이름 → 역할별 허용
  const EXPECT = {
    upload: { owner: 1, input: 1, view: 0, admin: 1 }, convert: { owner: 1, input: 1, view: 0, admin: 1 }, match: { owner: 1, input: 1, view: 0, admin: 1 },
    edit: { owner: 1, input: 1, view: 0, admin: 1 }, confirm: { owner: 1, input: 0, view: 0, admin: 1 }, cancel: { owner: 1, input: 0, view: 0, admin: 1 },
    sync: { owner: 1, input: 0, view: 0, admin: 1 }, settings: { owner: 1, input: 0, view: 0, admin: 1 }, adminArea: { owner: 0, input: 0, view: 0, admin: 1 },
  };
  const cap = [];
  const table = [];
  for (const who of roles) {
    const u = who === 'owner' ? owner : await L.login(who);
    // 관리자는 다른 회원 → 같은 매입서가 없음(404). 버튼 검사는 자기 매입서로 해야 해서 관리자는 서버 쪽만 + 설정·수집 현황 화면만 본다
    const ui = {};
    const { browser, page, errors } = await L.open({ user: u, width: W });
    await L.tab(page, '매입서 대조'); await L.tid(page, 'pdoc-tab').waitFor(); await page.waitForTimeout(800);
    ui.upload = (await L.tid(page, 'pdoc-file-pick').count()) > 0 && (await L.tid(page, 'pdoc-manual-open').count()) > 0;
    if (who !== 'admin') {
      await L.tid(page, `pdoc-open-${d.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(500);
      ui.match = (await L.tid(page, 'pdoc-rematch').count()) > 0;
      ui.edit = (await L.tid(page, `pdoc-line-edit-${lh}`).count()) > 0;
      ui.cancel = (await L.tid(page, `pdoc-line-cancel-${lc}`).count()) > 0 && (await L.tid(page, 'pdoc-cancel-doc').count()) > 0;
      await L.tid(page, `pdoc-line-cand-${lh}`).click(); await L.tid(page, 'pdoc-cand-modal').waitFor(); await page.waitForTimeout(800);
      ui.confirm = (await L.tid(page, 'pdoc-cand-confirm').count()) > 0;
      const ownerOnly = (await L.tid(page, 'pdoc-cand-owner-only').count()) > 0;
      s.c(`[${who}] 후보 창: 확정 버튼 또는 "주인 확인 필요" 중 하나만`, ui.confirm !== ownerOnly, { confirm: ui.confirm, ownerOnly });
      if (who !== 'owner') cap.push(await L.shot(page, `S06_${W}_${who}_후보창`));
      await L.tid(page, 'pdoc-cand-close').click(); await page.waitForTimeout(300);
      await L.tid(page, 'pdoc-back').click(); await page.waitForTimeout(400);
      await L.tid(page, `pdoc-open-${d2.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(500);
      ui.convert = (await L.tid(page, `pdoc-line-convert-${lp}`).count()) > 0;
      if (who !== 'owner') cap.push(await L.shot(page, `S06_${W}_${who}_대조결과`));
      await L.tid(page, 'pdoc-back').click(); await page.waitForTimeout(300);
    }
    await L.tid(page, 'pdoc-view-settings').click(); await L.tid(page, 'pdoc-tol-card').waitFor(); await page.waitForTimeout(800);
    ui.settings = (await L.tid(page, 'pdoc-tol-save').count()) > 0;
    ui.adminArea = (await L.tid(page, 'pdoc-settings-admin').count()) > 0;
    cap.push(await L.shot(page, `S06_${W}_${who}_대조설정`));
    await L.tab(page, '경락 시세'); await L.tid(page, 'auction-view-sync').click(); await L.tid(page, 'auction-sync').waitFor(); await page.waitForTimeout(800);
    ui.sync = (await L.tid(page, 'auction-sync-now').count()) > 0;
    s.c(`[${who}] pageerror 0`, errors.length === 0, errors);
    await browser.close();
    // 서버(본문은 일부러 틀리게 — 권한 검사가 먼저면 403, 통과하면 400/404/409 — 데이터는 바뀌지 않음)
    const h = { 'Idempotency-Key': L.key('perm') };
    const srv = {
      upload: (await L.call(u, 'POST', '/purchase-docs', { lines: [] }, h)).status,
      convert: (await L.call(u, 'POST', '/purchase-docs/convert', { lines: [] }, h)).status,
      match: (await L.call(u, 'POST', `/purchase-docs/lines/999999999/rematch`, {})).status,
      edit: (await L.call(u, 'PATCH', `/purchase-docs/lines/999999999`, { version: 0 })).status,
      confirm: (await L.call(u, 'POST', `/purchase-docs/lines/999999999/confirm`, { version: 0 }, h)).status,
      cancel: (await L.call(u, 'POST', `/purchase-docs/lines/999999999/cancel`, {}, h)).status,
      sync: (await L.call(u, 'POST', '/auction/sync', { date_from: '2099-01-01', date_to: '2099-01-01' })).status,
      settings: (await L.call(u, 'PUT', '/purchase-match/tolerances', { price_pct_auto: 99 })).status,
      adminArea: (await L.call(u, 'POST', '/auction/item-mappings', { target: 'BOTH' })).status,
    };
    for (const k of Object.keys(EXPECT)) {
      const exp = EXPECT[k][who];
      const okSrv = exp ? srv[k] !== 403 : srv[k] === 403;
      const hasUi = k in ui;
      const okUi = !hasUi || !!ui[k] === !!exp;
      table.push({ who, k, expect: exp, ui: hasUi ? (ui[k] ? 1 : 0) : '-', server: srv[k] });
      s.c(`[${who}] ${k}: 화면 ${hasUi ? (ui[k] ? '보임' : '숨김') : '-'} · 서버 ${srv[k]} (기대 ${exp ? '허용' : '거부'})`, okSrv && okUi, { ui: ui[k], srv: srv[k], exp });
    }
  }
  console.table(table);
  // 대조 설정(주인): 칸 오류·저장·재대조 반영·기본값
  const { browser, page, errors } = await L.open({ user: owner, width: W });
  await L.tab(page, '매입서 대조'); await L.tid(page, 'pdoc-view-settings').click(); await L.tid(page, 'pdoc-tol-card').waitFor(); await page.waitForTimeout(1000);
  await L.tid(page, 'pdoc-tol-scope').selectOption('F:PAPRIKA'); await page.waitForTimeout(800);
  const pa = L.tid(page, 'pdoc-tol-price_pct_auto');
  await pa.fill('12'); await L.tid(page, 'pdoc-tol-save').click(); await page.waitForTimeout(500);
  const errTxt = await L.text(page.locator('[data-testid^="pdoc-tol-err-"]'));
  s.c('허용오차 자동 > 후보 → 칸 오류 문구·저장 안 함', /단가/.test(errTxt) && (await q(`SELECT COUNT(*) c FROM purchase_match_tolerance WHERE user_id=$1 AND item_family='PAPRIKA'`, [f.accounts.owner.id]).catch(() => [{ c: 0 }]))[0].c == 0, errTxt);
  await L.tid(page, 'pdoc-tol-amount_abs_auto').fill('20000'); await pa.fill('5'); await L.tid(page, 'pdoc-tol-save').click(); await page.waitForTimeout(500);
  s.c('금액 범위 밖(20,000원) → 칸 오류', /금액/.test(await L.text(page.locator('[data-testid^="pdoc-tol-err-"]'))), await L.text(page.locator('[data-testid^="pdoc-tol-err-"]')));
  await L.tid(page, 'pdoc-tol-amount_abs_auto').fill('0'); await pa.fill('5'); await L.tid(page, 'pdoc-tol-save').click(); await page.waitForTimeout(1200);
  const tolApi = await L.call(owner, 'GET', '/purchase-match/tolerances');
  const myRow = (tolApi.json.data.rows || []).find((r) => r.item_family === 'PAPRIKA');
  s.c('파프리카 단가 자동 5% 저장(API rows)', myRow && Number(myRow.price_pct_auto) === 5, tolApi.json.data.rows);
  cap.push(await L.shot(page, `S06_${W}_설정저장`));
  // 재대조 → 보류였던 빨강 파프리카(+5%) 줄이 완전일치로
  await L.tid(page, 'pdoc-view-docs').click(); await page.waitForTimeout(600);
  await L.tid(page, `pdoc-open-${d.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(400);
  await L.tid(page, 'pdoc-rematch').click(); await page.waitForTimeout(1800);
  const lt = await L.text(L.tid(page, `pdoc-line-${lh}`));
  const lr = (await q(`SELECT match_result, status FROM purchase_doc_line WHERE id=$1`, [lh]))[0];
  s.c('설정 저장 뒤 다시 대조 → 새 허용오차 적용(+5% 줄 완전일치)', lr.match_result === 'EXACT' && /완전/.test(lt), { lr, lt });
  // 기본값으로
  await L.tid(page, 'pdoc-back').click(); await L.tid(page, 'pdoc-view-settings').click(); await L.tid(page, 'pdoc-tol-card').waitFor(); await page.waitForTimeout(800);
  await L.tid(page, 'pdoc-tol-scope').selectOption('F:PAPRIKA'); await page.waitForTimeout(800);
  await L.tid(page, 'pdoc-tol-reset').click(); await page.waitForTimeout(1500);
  const after = await L.call(owner, 'GET', '/purchase-match/tolerances');
  s.c('[기본값으로] → 파프리카 내 값 삭제', !(after.json.data.rows || []).some((r) => r.item_family === 'PAPRIKA' && !r.is_default), after.json.data.rows);
  s.c('대조 설정 pageerror 0', errors.length === 0, errors);
  await browser.close(); await pool.end();
  process.exit(s.done({ width: W, capture: cap, table }));
})().catch((e) => { console.error(e); process.exit(2); });
