// S05 요청 중 잠금(T-404)·중복 요청(Idempotency-Key) — 화면 + DB 확인 SQL (실서버, D.C)
// ① 일괄 매입 등록 중 잠금(하위 보기·목록 링크·줄 버튼) ② 최상위 탭 이동(B② 알려진 위험) ③ 더블클릭 → 요청 1회·매입 1건
// ④ 같은 키 재생(Idempotent-Replay)·다른 본문 422 ⑤ 두 사람이 동시에 같은 줄 → 매입 1건 ⑥ 직접 입력 저장 응답 유실 → 같은 키 재전송 → 매입서 1건
// ⑦ 확인 SQL(027 ①~④) 0행
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {}) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
(async () => {
  const f = L.fixture(); const D = f.dates; const P = f.partners; const tag = Date.now().toString(36).slice(-5);
  const s = L.suite(`S05_${W}`, '요청 중 잠금·중복 요청 — 실서버');
  const pool = L.db(); const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const u = await L.login('owner');
  const post = async (body) => (await L.call(u, 'POST', '/purchase-docs', body, { 'Idempotency-Key': L.key('s05') })).json?.data?.docs?.[0];
  // 전환 가능(PENDING EXACT) 줄 4개: A청과 꽈리 특·노랑 파프리카 특 / C 홍고추 특 / B 오이 특
  const dA = await post({ doc_no: `M1-${tag}`, supplier_partner_id: P.PA, auto_convert: false, lines: [
    { trade_date: D.C, item_name: '꽈리고추', grade: '특', spec: '4kg 상자', qty: 30, unit_price: 21000 },
    { trade_date: D.C, item_name: '노랑 파프리카', grade: '특', spec: '5kg 상자', qty: 35, unit_price: 25000 }] });
  const dC = await post({ doc_no: `M2-${tag}`, supplier_partner_id: P.PC, auto_convert: false, lines: [{ trade_date: D.C, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000 }] });
  const dB = await post({ doc_no: `M3-${tag}`, supplier_partner_id: P.PB, auto_convert: false, lines: [{ trade_date: D.C, item_name: '오이고추', grade: '특', spec: '10kg 상자', qty: 18, unit_price: 29000 }] });
  const conv = [dA, dC, dB].every((d) => d.lines.every((l) => l.convertible));
  s.c('준비: 전환 가능 줄 4개', conv, [dA, dC, dB].map((d) => d.lines.map((l) => `${l.status}/${l.match_result}/${l.convertible}`)));
  const activeOf = async (lid) => Number((await q(`SELECT COUNT(*) c FROM purchase WHERE purchase_doc_line_id=$1 AND status='active'`, [lid]))[0].c);
  const { browser, page, errors } = await L.open({ user: u, width: W });
  await L.tab(page, '매입서 대조');
  await L.tid(page, `pdoc-open-${dA.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(400);
  const cap = [];
  // ① 일괄 매입 등록 중 잠금
  await L.tid(page, 'pdoc-check-all').check();
  const st1 = await L.slow(page, (url, m) => m === 'POST' && /\/purchase-docs\/convert$/.test(url), { ms: 3000 });
  await L.tid(page, 'pdoc-convert-selected').click();
  await page.waitForTimeout(300);
  const lk = {
    bulk: await L.tid(page, 'pdoc-convert-selected').isDisabled(),
    back: await L.tid(page, 'pdoc-back').isDisabled(),
    rematch: await L.tid(page, 'pdoc-rematch').isDisabled(),
    subReview: await L.tid(page, 'pdoc-view-review').isDisabled(),
    rowBtn: await L.tid(page, `pdoc-line-convert-${dA.lines[0].id}`).isDisabled(),
  };
  await L.tid(page, 'pdoc-convert-selected').click({ force: true, timeout: 300 }).catch(() => {});
  await L.tid(page, 'pdoc-view-review').click({ force: true, timeout: 300 }).catch(() => {});
  cap.push(await L.shot(page, `S05_${W}_1_일괄등록중잠금`));
  // ② 최상위 탭(매출정보) — 요청 중 이동되는가
  const topTab = page.locator('button.main-tab', { hasText: '매출정보' });
  const topDisabled = await topTab.isDisabled();
  await topTab.click({ force: true, timeout: 800 }).catch(() => {});
  await page.waitForTimeout(400);
  const title = await page.locator('h2.main-page-title').innerText().catch(() => '');
  await page.waitForTimeout(3200);
  await page.unroute('**/api/**');
  s.c('일괄 등록 중: 일괄 버튼·목록 링크·다시 대조·하위 보기·줄 버튼 잠금', Object.values(lk).every(Boolean), lk);
  s.c('일괄 등록 연타 → 요청 1회', st1.count === 1, st1.calls);
  s.c('[D04] 일괄 등록 중 최상위 탭(매출정보) 이동 막힘', topDisabled || !/매출정보/.test(title), { topDisabled, title });
  const a1 = await activeOf(dA.lines[0].id), a2 = await activeOf(dA.lines[1].id);
  s.c('일괄 등록 결과: 두 줄 매입 각 1건', a1 === 1 && a2 === 1, { a1, a2 });
  // ③ 더블클릭 → 1회
  await L.tab(page, '매입서 대조');
  await L.tid(page, `pdoc-open-${dC.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(400);
  const st3 = await L.slow(page, (url, m) => m === 'POST' && /\/purchase-docs\/convert$/.test(url), { ms: 800 });
  await L.tid(page, `pdoc-line-convert-${dC.lines[0].id}`).dblclick();
  await page.waitForTimeout(2000); await page.unroute('**/api/**');
  s.c('[매입 등록] 더블클릭 → 요청 1회·매입 1건', st3.count === 1 && (await activeOf(dC.lines[0].id)) === 1, { count: st3.count, active: await activeOf(dC.lines[0].id) });
  // ④ 같은 키 재생 / 다른 본문
  const lineB = dB.lines[0].id; const k = L.key('same');
  const r1 = await L.call(u, 'POST', '/purchase-docs/convert', { lines: [{ line_id: lineB }] }, { 'Idempotency-Key': k });
  const r2 = await L.call(u, 'POST', '/purchase-docs/convert', { lines: [{ line_id: lineB }] }, { 'Idempotency-Key': k });
  const r3 = await L.call(u, 'POST', '/purchase-docs/convert', { lines: [{ line_id: dC.lines[0].id }] }, { 'Idempotency-Key': k });
  s.c('같은 키 재요청 → 같은 본문 + Idempotent-Replay: true, 매입 1건', r1.status === 200 && r2.status === 200 && r2.headers.get('idempotent-replay') === 'true' && same(r1.json, r2.json) && (await activeOf(lineB)) === 1, { r1: r1.status, r2: r2.status, replay: r2.headers.get('idempotent-replay') });
  s.c('같은 키·다른 본문 → 422 IDEMPOTENCY_KEY_REUSED', r3.status === 422 && r3.json.code === 'IDEMPOTENCY_KEY_REUSED', r3.json);
  const r4 = await L.call(u, 'POST', '/purchase-docs/convert', { lines: [{ line_id: lineB }] });
  s.c('키 없음 → 400 IDEMPOTENCY_KEY_REQUIRED', r4.status === 400 && r4.json.code === 'IDEMPOTENCY_KEY_REQUIRED', r4.json);
  // ⑤ 두 사람(주인 화면 + 입력 직원 화면)이 같은 줄을 동시에 [매입 등록]
  const ui = await L.login('input');
  const o2 = await L.open({ user: ui, width: W });
  const dY = await post({ doc_no: `M5-${tag}`, supplier_partner_id: P.PA, auto_convert: false, lines: [{ trade_date: D.C, item_name: '빨강 파프리카', grade: '특', spec: '5kg 상자', qty: 40, unit_price: 24000 }] });
  const ly = dY.lines[0];
  await L.tab(o2.page, '매입서 대조');
  for (const pg of [page, o2.page]) {
    if (await L.tid(pg, 'pdoc-back').count()) { await L.tid(pg, 'pdoc-back').click(); await pg.waitForTimeout(300); }
    await L.tid(pg, 'pdoc-search').click(); await pg.waitForTimeout(800);
    await L.tid(pg, `pdoc-open-${dY.id}`).click(); await L.tid(pg, 'pdoc-lines').waitFor(); await pg.waitForTimeout(500);
  }
  const both = [page, o2.page].map((pg) => L.tid(pg, `pdoc-line-convert-${ly.id}`));
  const canBoth = (await both[0].count()) === 1 && (await both[1].count()) === 1;
  if (canBoth) {
    await Promise.all(both.map((b) => b.click()));
    await page.waitForTimeout(2500);
    const rs = [await L.text(L.tid(page, `pdoc-line-result-${ly.id}`)), await L.text(L.tid(o2.page, `pdoc-line-result-${ly.id}`))];
    const act = await activeOf(ly.id);
    const cvs = Number((await q(`SELECT COUNT(*) c FROM purchase_doc_conversion WHERE line_id=$1 AND status='ACTIVE'`, [ly.id]))[0].c);
    s.c('두 화면 동시 [매입 등록](다른 키) → 매입 1건·활성 전환 1건·한쪽은 이미 등록', act === 1 && cvs === 1 && rs.some((t) => /이미/.test(t)), { act, cvs, rs });
    const st = await L.text(L.tid(o2.page, 'pdoc-detail-msg'));
    s.c('500 없음(화면 오류 문구 없음)', !/500|서버 오류/.test(st + rs.join(' ')), st);
  } else s.c('두 화면 모두 [매입 등록] 버튼 보임(입력 직원 포함)', false, { ly });
  cap.push(await L.shot(o2.page, `S05_${W}_2_동시등록_입력직원화면`));
  await o2.browser.close();
  // ⑥ 직접 입력 — 저장 응답이 유실(502)돼도 다시 누르면 같은 키로 재전송 → 매입서 1건
  await L.tid(page, 'pdoc-back').click(); await page.waitForTimeout(300);
  await L.tid(page, 'pdoc-manual-open').click(); await L.tid(page, 'pdoc-manual').waitFor();
  const docNo = `MN-${tag}`;
  await L.tid(page, 'pdoc-manual-docno').fill(docNo);
  await L.tid(page, 'pdoc-manual-date').fill(D.C);
  await L.tid(page, 'pdoc-manual-supplier').selectOption({ label: 'B청과' }).catch(async () => { await L.tid(page, 'pdoc-manual-supplier').selectOption(String(P.PB)); });
  await page.locator('[data-testid="pdoc-manual-lines"] input[type=date]').first().fill(D.C);
  await L.tid(page, 'pdoc-manual-item-0').fill('오이고추');
  await page.locator('[aria-label="1줄 등급"]').fill('중');
  await page.locator('[aria-label="1줄 규격"]').fill('10kg 상자');
  await L.tid(page, 'pdoc-manual-qty-0').fill('8');
  await L.tid(page, 'pdoc-manual-price-0').fill('22000');
  let n = 0; const keys = [];
  await page.route('**/api/purchase-docs', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.continue();
    n++; keys.push(req.headers()['idempotency-key']);
    if (n === 1) { const resp = await route.fetch(); void resp; return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false, message: '게이트웨이 오류(테스트)' }) }); }
    return route.continue();
  });
  await L.tid(page, 'pdoc-manual-save').click(); await page.waitForTimeout(1500);
  const e6 = await L.text(L.tid(page, 'pdoc-manual-error'));
  await L.tid(page, 'pdoc-manual-save').click(); await page.waitForTimeout(1800);
  await page.unroute('**/api/purchase-docs');
  const docs6 = Number((await q(`SELECT COUNT(*) c FROM purchase_doc WHERE doc_no=$1`, [docNo]))[0].c);
  s.c('직접 입력: 첫 응답 유실 → 오류 문구 → 다시 저장 시 같은 키 → 매입서 1건·창 닫힘', n === 2 && keys[0] && keys[0] === keys[1] && docs6 === 1 && (await L.tid(page, 'pdoc-manual').count()) === 0, { n, sameKey: keys[0] === keys[1], docs6, e6 });
  cap.push(await L.shot(page, `S05_${W}_3_직접입력_재전송`));
  // ⑦ 확인 SQL
  const chk = {
    one: (await q(`SELECT purchase_doc_line_id FROM purchase WHERE purchase_doc_line_id IS NOT NULL AND status='active' GROUP BY 1 HAVING COUNT(*) > 1`)).length,
    two: (await q(`SELECT c.id FROM purchase_doc_conversion c JOIN purchase p ON p.id = c.purchase_id WHERE (c.status = 'ACTIVE') <> (p.status = 'active')`)).length,
    three: (await q(`SELECT l.id FROM purchase_doc_line l WHERE l.status='CONVERTED' AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.line_id = l.id AND c.status='ACTIVE')`)).length,
    four: (await q(`SELECT d.id FROM purchase_doc d JOIN (SELECT doc_id, COUNT(*) n FROM purchase_doc_line GROUP BY 1) x ON x.doc_id = d.id WHERE x.n <> d.line_count`)).length,
  };
  s.c('확인 SQL(027 ①~④) 모두 0행', Object.values(chk).every((x) => x === 0), chk);
  s.c('pageerror 0', errors.length === 0 && o2.errors.length === 0, [...errors, ...o2.errors]);
  await browser.close(); await pool.end();
  process.exit(s.done({ width: W, capture: cap, sql: chk }));
})().catch((e) => { console.error(e); process.exit(2); });
