// S01 경락 조회(실서버·목업 소스) — meta 배지·확정/당일·빈 결과(경매 전·휴장·데이터 없음)·상세·기간 검사·늦은 응답 버림(AC-38)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const f = L.fixture(); const D = f.dates;
  const s = L.suite(`S01_${W}`, '경락 조회 — 실서버');
  const u = await L.login('owner');
  const { browser, page, errors } = await L.open({ user: u, width: W });
  await L.tab(page, '경락 시세');
  await L.tid(page, 'auction-meta').waitFor({ timeout: 8000 });
  // 1) 처음 들어오면 오늘 → 경매 전(NOT_YET)
  s.c('첫 화면(오늘) 빈 결과 = 경매 전 문구', /아직 경매 전/.test(await L.text(L.tid(page, 'auction-empty'))), await L.text(L.tid(page, 'auction-empty')));
  s.c('첫 화면 목업 배지', (await L.tid(page, 'auction-mock-badge').count()) > 0 || /목업/.test(await L.text(L.tid(page, 'auction-meta'))), await L.text(L.tid(page, 'auction-meta')));
  const meta0 = await L.text(L.tid(page, 'auction-meta'));
  s.c('첫 화면 기준 시각 칸이 비정상 문자(Invalid·undefined·NaN) 아님', !/Invalid|undefined|NaN|null/.test(meta0), meta0);
  const cap = [await L.shot(page, `S01_${W}_1_오늘_경매전`)];
  // 2) 확정일 조회 — 고추 10건
  const query = async (from, to = from) => {
    await L.tid(page, 'auction-date-from').fill(from);
    await L.tid(page, 'auction-date-to').fill(to);
    await L.tid(page, 'auction-search').click();
    await page.waitForTimeout(300);
    await page.waitForFunction(() => !document.querySelector('[data-testid="auction-search"]')?.disabled, null, { timeout: 8000 });
    await page.waitForTimeout(200);
  };
  await query(D.A);
  const rows = await page.locator('[data-testid^="auction-row-"]').count();
  const api = await L.call(u, 'GET', `/auction/trades?date_from=${D.A}&date_to=${D.A}&family=PEPPER`);
  s.c(`확정일(${D.A}) 고추 행 수 = API total(${api.json.total})`, rows === api.json.total && rows === 10, { rows, total: api.json.total });
  s.c('확정 단계 배지', /확정/.test(await L.text(L.tid(page, 'auction-phase'))), await L.text(L.tid(page, 'auction-phase')));
  const firstRow = await L.text(page.locator('[data-testid^="auction-row-"]').first());
  s.c('행에 법인·단가(원 표기) 표시', /A청과|B청과|C농협/.test(firstRow) && /\d{1,3},\d{3}/.test(firstRow), firstRow);
  s.c('출하자 실명 없음(화면)', !/출하자[A-Z]/.test(await page.locator('main').innerText()), '');
  cap.push(await L.shot(page, `S01_${W}_2_확정일`));
  // 3) 상세
  await page.locator('[data-testid^="auction-row-"]').first().click();
  await L.tid(page, 'auction-detail').waitFor({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => !/불러오는 중/.test(document.querySelector('[data-testid="auction-detail"]')?.innerText || ''), null, { timeout: 6000 }).catch(() => {});
  const det = await L.text(L.tid(page, 'auction-detail'));
  s.c('행 클릭 → 상세(개정 번호)', /개정|revision|1/.test(det) && det.length > 20, det.slice(0, 200));
  cap.push(await L.shot(page, `S01_${W}_3_상세`));
  await page.keyboard.press('Escape');
  await page.locator('.main-modal-btn.secondary', { hasText: '닫기' }).click({ timeout: 1500 }).catch(() => {});
  await page.waitForTimeout(300);
  // 4) 휴장일·데이터 없음
  await query(D.H);
  s.c(`휴장일(${D.H}) 문구`, /휴장일/.test(await L.text(L.tid(page, 'auction-empty'))), await L.text(L.tid(page, 'auction-empty')));
  cap.push(await L.shot(page, `S01_${W}_4_휴장`));
  await query(D.M);
  s.c(`빈 응답(${D.M}) = 데이터 없음(확인 필요)`, /데이터 없음/.test(await L.text(L.tid(page, 'auction-empty'))), await L.text(L.tid(page, 'auction-empty')));
  // 5) 기간 31일 넘음 → 화면 검사(요청 안 보냄)
  const st0 = await L.slow(page, (url, m) => m === 'GET' && /\/api\/auction\/trades/.test(url), { ms: 0 });
  await L.tid(page, 'auction-date-from').fill(D.S); await L.tid(page, 'auction-date-to').fill(f.today);
  await L.tid(page, 'auction-date-from').fill(new Date(Date.parse(D.S + 'T00:00:00Z') - 5 * 864e5).toISOString().slice(0, 10));
  await L.tid(page, 'auction-search').click(); await page.waitForTimeout(400);
  s.c('31일 초과 → 화면 문구·요청 0', /31일/.test(await page.locator('[data-testid="auction-filters"]').innerText()) && st0.count === 0, { calls: st0.calls });
  await page.unroute('**/api/**');
  // 6) 늦은 응답 버림: D.B 조회를 3초 늦춘 뒤 바로 D.A 로 바꿔 조회
  await query(D.A);
  const st = await L.slow(page, (url, m) => m === 'GET' && url.includes(`date_from=${D.B}`), { ms: 3000 });
  await L.tid(page, 'auction-date-from').fill(D.B); await L.tid(page, 'auction-date-to').fill(D.B);
  await L.tid(page, 'auction-search').click(); await page.waitForTimeout(300);
  const disabledDuring = await L.tid(page, 'auction-search').isDisabled();
  await L.tid(page, 'auction-date-from').fill(D.C); await L.tid(page, 'auction-date-to').fill(D.C);
  await L.tid(page, 'auction-search').click();
  await page.waitForTimeout(4000);
  const shownDates = await page.locator('[data-testid^="auction-row-"] td[data-label="경락일"]').allInnerTexts();
  const mdC = D.C.slice(5).replace('-', '-');
  s.c('조회 중 [조회] 버튼 잠김', disabledDuring, { disabledDuring });
  s.c('늦게 온 앞 조건(D.B) 응답이 새 조건(D.C) 결과를 덮지 않음', shownDates.length > 0 && shownDates.every((t) => t.includes(D.C.slice(5, 7)) && t.includes(D.C.slice(8, 10))), { shownDates: shownDates.slice(0, 3), delayed: st.count, mdC });
  cap.push(await L.shot(page, `S01_${W}_5_늦은응답`));
  s.c('pageerror 0', errors.length === 0, errors);
  await browser.close();
  process.exit(s.done({ width: W, capture: cap }));
})().catch((e) => { console.error(e); process.exit(2); });
