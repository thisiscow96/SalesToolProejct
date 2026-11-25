// S04 대조 결과·검토 대기·수동 확정(허용 밖 FORCED·후보 여러 건 MANUAL)·매입 등록·전환 취소·재대조·매입서 취소·줄 수정·매입정보 배지 (실서버, D.B)
// 준비 매입서는 API 로 만들고(주인), 조작·표시는 화면으로, 결과는 DB 로 확인한다
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const f = L.fixture(); const D = f.dates; const P = f.partners; const tag = Date.now().toString(36).slice(-5);
  const s = L.suite(`S04_${W}`, '대조 결과·확정·취소·재대조 — 실서버');
  const pool = L.db(); const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const u = await L.login('owner');
  const post = async (body) => (await L.call(u, 'POST', '/purchase-docs', body, { 'Idempotency-Key': L.key('s04') })).json?.data?.docs?.[0];
  const d1 = await post({ doc_no: `K1-${tag}`, supplier_partner_id: P.PA, auto_convert: true, lines: [
    { trade_date: D.B, item_name: '꽈리고추', grade: '특', spec: '4kg 상자', qty: 30, unit_price: 21000 },
    { trade_date: D.B, item_name: '빨강 파프리카', grade: '특', spec: '5kg 상자', qty: 40, unit_price: 25200 },
    { trade_date: D.B, item_name: '청양고추', grade: '특', spec: '10kg 상자', qty: 12, unit_price: 38000 }] });
  const d2 = await post({ doc_no: `K2-${tag}`, supplier_partner_id: P.PA, auto_convert: false, lines: [
    { trade_date: D.B, item_name: '노랑 파프리카', grade: '특', spec: '5kg 상자', qty: 35, unit_price: 25000 }] });
  const d3 = await post({ doc_no: `K3-${tag}`, supplier_partner_id: P.PC, auto_convert: false, lines: [
    { trade_date: D.B, item_name: '청량초', grade: '특', spec: '10kg', qty: 1, unit_price: 1000 },
    { trade_date: D.B, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000 }] });
  const [l1, l2, l3] = d1.lines.map((x) => x.id); const l4 = d2.lines[0].id; const [l5, l6] = d3.lines.map((x) => x.id);
  s.c('준비: K1 줄1 자동 등록·줄2 부분·줄3 후보 여러 건 / K2 전환 가능 / K3 미매핑+전환 가능', d1.lines[0].status === 'CONVERTED' && d1.lines[1].match_result === 'PARTIAL' && (d1.lines[2].reason_codes || []).includes('MULTI_CANDIDATE') && d2.lines[0].convertible && d3.lines[0].reason_codes.includes('ITEM_UNMAPPED'), [d1.lines, d2.lines, d3.lines].flat().map((x) => `${x.id}:${x.status}/${x.match_result}/${(x.reason_codes || []).join('|')}`));
  const { browser, page, errors } = await L.open({ user: u, width: W });
  await L.tab(page, '매입서 대조');
  const openDoc = async (id) => {
    if (await L.tid(page, 'pdoc-back').count()) { await L.tid(page, 'pdoc-back').click(); await page.waitForTimeout(400); }
    await L.tid(page, `pdoc-open-${id}`).waitFor({ timeout: 8000 });
    await L.tid(page, `pdoc-open-${id}`).click();
    await L.tid(page, 'pdoc-lines').waitFor({ timeout: 8000 }); await page.waitForTimeout(400);
  };
  const lineText = (id) => L.text(L.tid(page, `pdoc-line-${id}`));
  const cap = [];
  // 1) 대조 결과 표시 (B② "서버와 맞출 것": 칸 이름·convertible·purchase_id/conversion_mode)
  await openDoc(d1.id);
  const t1 = await lineText(l1), t2 = await lineText(l2), t3 = await lineText(l3);
  s.c('줄 품목·등급·규격 표시(item_name_raw·grade_raw·pkg_raw)', /꽈리고추 특 4kg 상자/.test(t1) && /빨강 파프리카 특 5kg/.test(t2), { t1, t2 });
  s.c('줄 점수 표시(match_score)', /\b\d{2,3}\b/.test(t1.replace(/[\d,]{5,}/g, '')), t1);
  s.c('자동 등록 줄: 매입 등록됨 #매입번호 + 방식(자동)', /#\d+/.test(t1) && /자동/.test(t1), t1);
  s.c('전환 취소 버튼(주인)은 등록된 줄에만', (await L.tid(page, `pdoc-line-cancel-${l1}`).count()) === 1 && (await L.tid(page, `pdoc-line-cancel-${l2}`).count()) === 0, '');
  const sub3 = await page.locator(`[data-testid="pdoc-line-${l3}"] + tr.pm-subrow`).innerText().catch(() => '');
  s.c('후보 여러 건 사유 문구', /후보/.test(sub3), sub3);
  cap.push(await L.shot(page, `S04_${W}_1_대조결과`));
  // 2) 허용 밖 수동 확정 → FORCED
  await L.tid(page, `pdoc-line-cand-${l2}`).click();
  await L.tid(page, 'pdoc-cand-modal').waitFor(); await page.waitForTimeout(1000);
  const candTxt = await L.text(L.tid(page, 'pdoc-cand-list'));
  s.c('후보 창: 허용 밖 표시·차이', /허용 밖/.test(candTxt), candTxt.slice(0, 300));
  const dis0 = await L.tid(page, 'pdoc-cand-confirm').isDisabled();
  await L.tid(page, 'pdoc-cand-accept').check();
  const dis1 = await L.tid(page, 'pdoc-cand-confirm').isDisabled();
  await L.tid(page, 'pdoc-cand-reason').fill('정산서 단가 정정분 확인(가명)');
  const dis2 = await L.tid(page, 'pdoc-cand-confirm').isDisabled();
  s.c('허용 밖: 확인 체크·사유 2자 전에는 확정 잠김', dis0 && dis1 && !dis2, { dis0, dis1, dis2 });
  cap.push(await L.shot(page, `S04_${W}_2_후보창_허용밖`));
  const stc = await L.slow(page, (url, m) => m === 'POST' && /\/confirm$/.test(url), { ms: 1500 });
  await L.tid(page, 'pdoc-cand-confirm').click();
  await page.waitForTimeout(200);
  await L.tid(page, 'pdoc-cand-confirm').click({ force: true, timeout: 300 }).catch(() => {});
  await page.keyboard.press('Escape');
  const openDuring = (await L.tid(page, 'pdoc-cand-modal').count()) === 1;
  await page.waitForTimeout(2500);
  await page.unroute('**/api/**');
  const cv2 = (await q(`SELECT mode, approve_reason, price_diff, trade_id FROM purchase_doc_conversion WHERE line_id=$1 AND status='ACTIVE'`, [l2]));
  s.c('확정 요청 1회·요청 중 창 안 닫힘', stc.count === 1 && openDuring, { count: stc.count, openDuring });
  s.c('DB: FORCED·사유·단가 차 1,200 저장, 활성 전환 1건', cv2.length === 1 && cv2[0].mode === 'FORCED' && /정정분/.test(cv2[0].approve_reason) && Number(cv2[0].price_diff) === 1200, cv2);
  const msg2 = await L.text(L.tid(page, 'pdoc-detail-msg'));
  s.c('확정 결과 문구(매입 #·방식)', /매입 등록했습니다/.test(msg2), msg2);
  // 3) 후보 여러 건 → 1위 확정(허용 안 = MANUAL, 확인·사유 불필요)
  await L.tid(page, `pdoc-line-cand-${l3}`).click();
  await L.tid(page, 'pdoc-cand-modal').waitFor(); await page.waitForTimeout(1000);
  const n3 = await page.locator('[data-testid^="pdoc-cand-"][data-testid$="0"], [data-testid^="pdoc-cand-"]').evaluateAll((els) => els.filter((e) => /^pdoc-cand-\d+$/.test(e.dataset.testid)).length);
  const dis3 = await L.tid(page, 'pdoc-cand-confirm').isDisabled();
  await L.tid(page, 'pdoc-cand-confirm').click(); await page.waitForTimeout(1500);
  const cv3 = await q(`SELECT mode FROM purchase_doc_conversion WHERE line_id=$1 AND status='ACTIVE'`, [l3]);
  s.c('후보 2건 표시·허용 안이면 바로 확정 가능 → MANUAL', n3 === 2 && !dis3 && cv3.length === 1 && cv3[0].mode === 'MANUAL', { n3, dis3, cv3 });
  // 4) 전환 취소 → 재대조 → 다시 매입 등록
  const pur1 = (await q(`SELECT purchase_id FROM purchase_doc_conversion WHERE line_id=$1 AND status='ACTIVE'`, [l1]))[0].purchase_id;
  await L.tid(page, `pdoc-line-cancel-${l1}`).click();
  await L.tid(page, 'pdoc-cancel-line').waitFor();
  const subDis = await L.tid(page, 'pdoc-cancel-line-submit').isDisabled();
  await page.locator('[data-testid="pdoc-cancel-line"] input').fill('단가 오기(가명)');
  await L.tid(page, 'pdoc-cancel-line-submit').click(); await page.waitForTimeout(1500);
  const p1 = (await q(`SELECT status FROM purchase WHERE id=$1`, [pur1]))[0];
  const ls1 = (await q(`SELECT status FROM purchase_doc_line WHERE id=$1`, [l1]))[0];
  s.c('전환 취소: 사유 없으면 잠김 → 취소 후 매입 cancelled·줄 CANCELLED', subDis && p1.status === 'cancelled' && ls1.status === 'CANCELLED', { subDis, p1, ls1 });
  const t1b = await lineText(l1);
  s.c('취소된 줄 표시(취소)', /취소/.test(t1b), t1b);
  await L.tid(page, 'pdoc-rematch').click(); await page.waitForTimeout(1800);
  const t1c = await lineText(l1);
  s.c('다시 대조 → 취소 줄이 다시 전환 가능', /전환 가능/.test(t1c) && (await L.tid(page, `pdoc-line-convert-${l1}`).count()) === 1, { t1c, msg: await L.text(L.tid(page, 'pdoc-detail-msg')) });
  if (await L.tid(page, `pdoc-line-convert-${l1}`).count()) {
    const stv = await L.slow(page, (url, m) => m === 'POST' && /\/purchase-docs\/convert$/.test(url), { ms: 1200 });
    await L.tid(page, `pdoc-line-convert-${l1}`).click();
    await L.tid(page, `pdoc-line-convert-${l1}`).click({ force: true, timeout: 300 }).catch(() => {});
    await page.waitForTimeout(2200); await page.unroute('**/api/**');
    const act = await q(`SELECT COUNT(*) c FROM purchase WHERE purchase_doc_line_id=$1 AND status<>'cancelled'`, [l1]);
    s.c('[매입 등록] 연타 → 요청 1회·활성 매입 1건(취소된 옛 매입 제외)', stv.count === 1 && Number(act[0].c) === 1, { count: stv.count, act: act[0].c });
  }
  cap.push(await L.shot(page, `S04_${W}_3_취소후재등록`));
  // 5) 등록된 줄이 있는 매입서 취소 → 409 문구
  await L.tid(page, 'pdoc-cancel-doc').click(); await L.tid(page, 'pdoc-cancel-doc-modal').waitFor();
  await page.locator('[data-testid="pdoc-cancel-doc-modal"] input').fill('중복 업로드(가명)');
  await L.tid(page, 'pdoc-cancel-doc-modal-submit').click(); await page.waitForTimeout(1200);
  const e5 = await L.text(L.tid(page, 'pdoc-cancel-doc-modal-error'));
  s.c('전환된 줄 있는 매입서 취소 → 막힘 문구', e5.length > 0 && /전환|등록|취소/.test(e5), e5);
  await page.locator('[data-testid="pdoc-cancel-doc-modal"] .main-modal-btn.secondary').click().catch(() => {});
  await page.waitForTimeout(300);
  // 6) K2: 전환 가능 → [매입 등록]
  await openDoc(d2.id);
  await L.tid(page, `pdoc-line-convert-${l4}`).click(); await page.waitForTimeout(1500);
  const r4 = await L.text(L.tid(page, `pdoc-line-result-${l4}`));
  const cv4 = await q(`SELECT mode FROM purchase_doc_conversion WHERE line_id=$1 AND status='ACTIVE'`, [l4]);
  s.c('K2 [매입 등록] → 결과 문구·DB 전환 1건', cv4.length === 1 && /등록/.test(r4 + (await L.text(L.tid(page, 'pdoc-detail-msg')))), { r4, cv4 });
  // 7) K3: 미매핑 줄 "경락 근거 없이 등록"
  await openDoc(d3.id);
  await L.tid(page, `pdoc-line-cand-${l5}`).click(); await L.tid(page, 'pdoc-cand-modal').waitFor(); await page.waitForTimeout(800);
  await L.tid(page, 'pdoc-cand-none').click();
  await L.tid(page, 'pdoc-cand-accept').check(); await L.tid(page, 'pdoc-cand-reason').fill('장외 거래(가명)');
  await L.tid(page, 'pdoc-cand-confirm').click(); await page.waitForTimeout(1500);
  const e7 = await L.text(L.tid(page, 'pdoc-cand-error'));
  const productPicker = await page.locator('[data-testid="pdoc-cand-modal"] select').count();
  const cv5 = await q(`SELECT 1 FROM purchase_doc_conversion WHERE line_id=$1 AND status='ACTIVE'`, [l5]);
  s.c('[D02] 미매핑 품목 줄을 "경락 근거 없이 등록" → 화면에서 끝낼 수 있음(품목 선택 수단)', cv5.length === 1 || productPicker > 0, { e7, productPicker, converted: cv5.length });
  cap.push(await L.shot(page, `S04_${W}_4_근거없이등록_미매핑`));
  await L.tid(page, 'pdoc-cand-close').click(); await page.waitForTimeout(300);
  // 8) 줄 수정 + VERSION_CONFLICT
  await L.tid(page, `pdoc-line-edit-${l5}`).click(); await L.tid(page, 'pdoc-edit-modal').waitFor();
  const v5 = (await q(`SELECT version FROM purchase_doc_line WHERE id=$1`, [l5]))[0].version;
  const other = await L.call(u, 'PATCH', `/purchase-docs/lines/${l5}`, { version: v5, item_name: '청양고추', grade: '특', spec: '10kg 상자', qty: 1, unit_price: 1000, trade_date: D.B });
  await L.tid(page, 'pdoc-edit-qty').fill('2');
  await L.tid(page, 'pdoc-edit-save').click(); await page.waitForTimeout(1200);
  const e8 = await L.text(L.tid(page, 'pdoc-edit-error'));
  const item8 = await L.tid(page, 'pdoc-edit-item_name').inputValue().catch(() => '');
  s.c('다른 사람이 먼저 고침 → 409 문구 + 최신 값으로 다시 채움', other.status === 200 && /먼저|다른 사람/.test(e8) && item8 === '청양고추', { other: other.status, e8, item8 });
  await L.tid(page, 'pdoc-edit-save').click(); await page.waitForTimeout(1500);
  s.c('다시 저장 → 창 닫힘·다시 대조 문구', (await L.tid(page, 'pdoc-edit-modal').count()) === 0 && /고치고 다시 대조/.test(await L.text(L.tid(page, 'pdoc-detail-msg'))), await L.text(L.tid(page, 'pdoc-detail-msg')));
  // 9) 전환 없는 매입서(K3 의 홍고추 줄은 PENDING) 취소 → CANCELLED, 이후 대조 버튼 없음·서버 409 DOC_CANCELLED
  await L.tid(page, 'pdoc-cancel-doc').click(); await L.tid(page, 'pdoc-cancel-doc-modal').waitFor();
  await page.locator('[data-testid="pdoc-cancel-doc-modal"] input').fill('중복 업로드(가명)');
  await L.tid(page, 'pdoc-cancel-doc-modal-submit').click(); await page.waitForTimeout(1500);
  const st9 = (await q(`SELECT status FROM purchase_doc WHERE id=$1`, [d3.id]))[0].status;
  const m9 = await L.call(u, 'POST', `/purchase-docs/${d3.id}/match`, { auto_convert: false });
  s.c('전환 없는 매입서 취소 → CANCELLED·안내 문구·[다시 대조] 숨김·서버 409 DOC_CANCELLED', st9 === 'CANCELLED' && /취소한 매입서/.test(await page.locator('[data-testid="pdoc-detail"]').innerText()) && (await L.tid(page, 'pdoc-rematch').count()) === 0 && m9.status === 409 && m9.json.code === 'DOC_CANCELLED', { st9, m9: m9.json.code });
  cap.push(await L.shot(page, `S04_${W}_5_매입서취소`));
  // 10) 검토 대기
  await L.tid(page, 'pdoc-back').click(); await page.waitForTimeout(300);
  await L.tid(page, 'pdoc-view-review').click(); await L.tid(page, 'pdoc-review-table').waitFor(); await page.waitForTimeout(1200);
  const rv = await L.call(u, 'GET', '/purchase-docs/review?limit=50&offset=0');
  const rows = await page.locator('[data-testid^="pdoc-review-row-"]').count();
  s.c(`검토 대기 행 수 = API(${rv.json.total})`, rows === Math.min(50, rv.json.total), { rows, total: rv.json.total });
  const navCount = await L.text(L.tid(page, 'pdoc-view-review'));
  s.c('하위 탭 "검토 대기 (N)" 건수 = API total', navCount.includes(String(rv.json.total)), { navCount, total: rv.json.total });
  if (rv.json.data[0]) {
    const rid = rv.json.data[0].id;
    const rt = await L.text(L.tid(page, `pdoc-review-row-${rid}`));
    s.c('검토 대기 행: 매입서번호-줄·품목·사유', rt.length > 10 && /\d/.test(rt), rt);
    await L.tid(page, `pdoc-review-open-${rid}`).click(); await page.waitForTimeout(1200);
    s.c('검토 대기 → 매입서 열기', (await L.tid(page, 'pdoc-detail').count()) === 1, '');
  }
  cap.push(await L.shot(page, `S04_${W}_6_검토대기`));
  // 11) 매입정보 탭 "매입서" 배지 → 그 매입서로 이동
  await L.tab(page, '매입정보'); await page.waitForTimeout(1500);
  const badges = page.locator('[data-testid="pdoc-purchase-badge"]');
  const nb = await badges.count();
  s.c('매입정보 목록에 "매입서" 배지', nb > 0, nb);
  if (nb) {
    const isBtn = await badges.first().evaluate((e) => e.tagName === 'BUTTON');
    await badges.first().click(); await page.waitForTimeout(1500);
    s.c('배지 누르면 매입서 대조 탭의 그 매입서로 이동', isBtn && (await L.tid(page, 'pdoc-detail').count()) === 1, { isBtn });
    cap.push(await L.shot(page, `S04_${W}_7_배지이동`));
  }
  s.c('pageerror 0', errors.length === 0, errors);
  await browser.close(); await pool.end();
  process.exit(s.done({ width: W, capture: cap, docs: { d1: d1.id, d2: d2.id, d3: d3.id } }));
})().catch((e) => { console.error(e); process.exit(2); });
