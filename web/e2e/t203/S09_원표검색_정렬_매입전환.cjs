// S09 원표번호 검색·열 정렬·체크 → 매입 전환 → 매입정보 이동(실서버) — A 설계 AC-S-05·S-09, AC-O-05·06·10, AC-F-01~07 (C 1650 작성)
// 전제: setup.cjs 를 돌린 같은 DB·서버·vite. 이 스크립트는 오늘−40일에 자기 경락 행 62건(테스트 DB 전용)을 직접 넣는다.
//   서울청과(11000101 → A청과 연결) 60건 · 한국청과(11000105, 연결 없음 → NO_CORP_LINK) 1건 · 철회 1건. 원표 0030252(경매 1~3)·9·10 포함
// 사용: WEB=http://localhost:<vite> FIXTURE=<setup 결과> W=1366 node S09_원표검색_정렬_매입전환.cjs  (W=390 은 휴대폰 폭 검사만)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
const add = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const f = L.fixture();
  const s = L.suite(`S09_${W}`, '원표번호 검색·열 정렬·매입 전환 — 실서버');
  const X = add(f.today, -40);
  const pool = L.db();
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  // ---------- 데이터 ----------
  let ids = (await q(`SELECT id FROM auction_trade WHERE trade_date = $1 ORDER BY id`, [X])).map((r) => Number(r.id));
  if (!ids.length) {
    const snap = (await q(`INSERT INTO collect_snapshot (source, market_code, trade_date, phase, status, finished_at, is_latest_ok) VALUES ('AT_REALTIME','110001',$1,'FINAL','COMPLETE',NOW(),true) RETURNING id`, [X]))[0].id;
    const rows = [];
    for (let i = 0; i < 60; i += 1) {
      const ship = i < 3 ? '0030252' : i === 3 ? '9' : i === 4 ? '10' : String(20000 + i);
      rows.push({ corp: '11000101', name: '서울청과㈜', ship, seq: String(i < 3 ? i + 1 : 1), price: 10000 + ((i * 37) % 50) * 100, qty: 1 + (i % 7), wd: false });
    }
    rows.push({ corp: '11000105', name: '한국청과㈜', ship: '11209999990001', seq: '1', price: 30000, qty: 2, wd: false });
    rows.push({ corp: '11000101', name: '서울청과㈜', ship: '29999', seq: '1', price: 15000, qty: 1, wd: true });
    for (const [i, r] of rows.entries()) {
      await q(`INSERT INTO auction_trade (source, source_row_key, trade_date, auction_at, market_code, market_name, corp_code, corp_name, item_name_raw, item_key, map_status, grade_norm,
                pkg_name, pkg_norm, unit_qty_kg, weight_source, qty, unit_price, price_per_kg, amount, origin_name, auction_seq, shipment_no, snapshot_id, content_hash, withdrawn_at)
              VALUES ('AT_REALTIME',$1,$2,$3,'110001','가락',$4,$5,'청양','PEPPER.CHEONGYANG','MAPPED','HIGH','상자','BOX',10.000,'SOURCE',$6::numeric,$7::bigint,($7::numeric/10)::numeric(12,2),ROUND($6::numeric*$7::bigint)::bigint,'경북 영양',$8,$9,$10,$11,$12)`,
      [`110001|${X}|${r.corp}|${r.ship}|${r.seq}`, X, `${X}T0${3 + (i % 6)}:${String(i % 60).padStart(2, '0')}:00+09:00`, r.corp, r.name, String(r.qty), r.price, r.seq, r.ship, snap, 's'.repeat(64), r.wd ? new Date().toISOString() : null]);
    }
    ids = (await q(`SELECT id FROM auction_trade WHERE trade_date = $1 ORDER BY id`, [X])).map((r) => Number(r.id));
  }
  const byShip = async (ship) => (await q(`SELECT id FROM auction_trade WHERE trade_date = $1 AND shipment_no = $2 ORDER BY id`, [X, ship])).map((r) => Number(r.id));
  const Z = await byShip('0030252');
  const NOLINK = (await byShip('11209999990001'))[0];
  const WD = (await byShip('29999'))[0];
  s.c(`준비 ${X} 경락 62건(원표 0030252 ×3, 연결 없음 1, 철회 1)`, ids.length >= 62 && Z.length === 3 && NOLINK && WD, { n: ids.length, Z, NOLINK, WD });

  const u = await L.login(W === 390 ? 'input' : 'owner');
  const { browser, page, errors } = await L.open({ user: u, width: W, height: W === 390 ? 844 : 900 });
  const reqs = [];
  page.on('request', (r) => { const x = new URL(r.url()); if (x.pathname.startsWith('/api/')) reqs.push(`${r.method()} ${x.pathname}${x.search}`); });
  const lastList = () => [...reqs].reverse().find((x) => x.startsWith('GET /api/auction/trades?')) || '';
  const idle = async () => { await page.waitForTimeout(250); await page.waitForFunction(() => !document.querySelector('[data-testid="auction-search"]')?.disabled, null, { timeout: 10000 }).catch(() => {}); await page.waitForTimeout(350); };
  const query = async (ship = '') => {
    await L.tid(page, 'auction-date-from').fill(X); await L.tid(page, 'auction-date-to').fill(X);
    await L.tid(page, 'auction-shipment').fill(ship);
    await L.tid(page, 'auction-search').click(); await idle();
  };
  const col = (label) => page.$$eval(`[data-testid="auction-table"] td[data-label="${label}"]`, (els) => els.map((e) => e.innerText.trim()));
  const num = (a) => a.map((x) => Number(String(x).replace(/[^0-9.-]/g, '')));
  const cap = [];
  await L.tab(page, '경락 시세'); await idle();
  await query('');

  if (W !== 390) {
    // ---------- AC-O-05 · O-06 ----------
    const pager = page.locator('[data-testid="auction-pager"]').last();
    await pager.locator('button[aria-label="2쪽"]').click(); await idle();
    s.c('준비 2쪽 이동(offset=50)', /offset=50/.test(lastList()), lastList());
    await L.tid(page, 'auction-sort-unit_price').click(); await idle();
    const r1 = lastList();
    const th = page.locator('th[aria-sort]:has([data-testid="auction-sort-unit_price"])');
    const p1 = num(await col('단가'));
    s.c('AC-O-05 머리글 클릭 → 기본 방향(단가 desc)·1쪽(offset=0)·쪽당 50 유지, aria-sort=descending, ▼ 표시, 화면 순서 내림차순',
      /sort=unit_price/.test(r1) && /dir=desc/.test(r1) && /offset=0/.test(r1) && /limit=50/.test(r1) && (await th.getAttribute('aria-sort')) === 'descending'
      && /▼/.test(await th.innerText()) && p1.every((v, i) => i === 0 || p1[i - 1] >= v), { r1, aria: await th.getAttribute('aria-sort'), p1: p1.slice(0, 5) });
    await L.tid(page, 'auction-sort-unit_price').click(); await idle();
    const p2 = num(await col('단가'));
    s.c('AC-O-05 다시 클릭 → 반대(asc), aria-sort=ascending, ▲', /dir=asc/.test(lastList()) && (await th.getAttribute('aria-sort')) === 'ascending' && /▲/.test(await th.innerText())
      && p2.every((v, i) => i === 0 || p2[i - 1] <= v), { r: lastList(), p2: p2.slice(0, 5) });
    const others = await page.locator('th[aria-sort]').evaluateAll((els) => els.filter((e) => e.getAttribute('aria-sort') !== 'none').length);
    s.c('AC-O-05 정렬 중인 머리글은 1개(나머지 aria-sort=none), 12열 모두 정렬 버튼', others === 1 && (await page.locator('[data-testid^="auction-sort-"]:not([data-testid="auction-sort-select"]):not([data-testid="auction-sort-dir"])').count()) === 12, others);
    await pager.locator('button[aria-label="2쪽"]').click(); await idle();
    const r2 = lastList();
    s.c('AC-O-06 정렬 상태에서 쪽 이동 요청에 sort·dir 실림', /sort=unit_price/.test(r2) && /dir=asc/.test(r2) && /offset=50/.test(r2), r2);
    await pager.locator('select').selectOption('100'); await idle();
    const r3 = lastList();
    s.c('AC-O-06 쪽당 건수 변경 요청에도 sort·dir 실림', /sort=unit_price/.test(r3) && /dir=asc/.test(r3) && /limit=100/.test(r3), r3);
    await L.tid(page, 'auction-sort-shipment_no').click(); await idle();
    const sh = (await col('원표번호')).filter((x) => x && x !== '-');
    s.c('원표번호 오름차순 화면 — 9 가 10 보다 앞, 0030252 앞자리 0 그대로', sh.indexOf('9') > -1 && sh.indexOf('9') < sh.indexOf('10') && sh.includes('0030252'), sh.slice(0, 8));
    cap.push(await L.shot(page, `S09_${W}_1_정렬`));

    // ---------- AC-S-05 · S-09 · 형식 오류 ----------
    await L.tid(page, 'auction-family').selectOption({ index: 1 }).catch(() => {});
    reqs.length = 0;
    await query('30252');
    const rs = lastList();
    const hint = await L.text(L.tid(page, 'auction-shipment-hint'));
    const rowsZ = await page.locator('[data-testid^="auction-row-"]').count();
    s.c('AC-S-05 품목 고른 상태에서 원표 30252 → 0030252 3행, 요청에 품목 조건 없음, "적용하지 않습니다" 안내', rowsZ === 3 && /shipment_no=30252/.test(rs) && !/family=/.test(rs) && /적용하지 않습니다/.test(hint), { rowsZ, rs, hint });
    cap.push(await L.shot(page, `S09_${W}_2_원표검색`));
    await query('77777777');
    s.c('AC-S-09 원표번호 0건 → 빈 결과 안내 문구', /없습니다/.test(await L.text(L.tid(page, 'auction-empty'))), await L.text(L.tid(page, 'auction-empty')));
    reqs.length = 0;
    await L.tid(page, 'auction-shipment').fill('12A4'); await L.tid(page, 'auction-search').click(); await page.waitForTimeout(800);
    const bodyTxt = await page.locator('[data-testid="auction-tab"]').innerText().catch(() => '');
    s.c('원표번호 형식 오류(12A4) → 요청 보내기 전 안내, R-92 요청 0', /숫자 20자리/.test(bodyTxt) && !reqs.some((x) => x.startsWith('GET /api/auction/trades?')), reqs);
    await L.tid(page, 'auction-family').selectOption({ index: 0 }).catch(() => {});
    await query('');

    // ---------- AC-F-05 비활성·선택 해제 ----------
    // 철회 행은 기본 목록에서 빠지므로 상세 조건 "철회된 건 포함"을 켜고 본다
    if (!(await L.tid(page, 'auction-adv').isVisible().catch(() => false))) await L.tid(page, 'auction-adv-toggle').click();
    await L.tid(page, 'auction-adv').locator('label.pm-check', { hasText: '철회된 건 포함' }).locator('input').check();
    await query('');
    await page.locator('[data-testid="auction-pager"]').last().locator('select').selectOption('100'); await idle();
    const wdBox = L.tid(page, `auction-pick-${WD}`);
    const wdTitle = await page.locator(`[data-testid="auction-row-${WD}"] label.pm-pick`).getAttribute('title', { timeout: 3000 }).catch(() => '');
    const wdAria = await wdBox.getAttribute('aria-label', { timeout: 3000 }).catch(() => '');
    s.c('AC-F-05 철회 행(철회 포함 조회) 체크 비활성 + 이유 툴팁·aria-label', (await wdBox.count()) === 1 && (await wdBox.isDisabled()) && /철회/.test(wdTitle || '') && /철회/.test(wdAria || ''), { wdTitle, wdAria, req: lastList() });
    await L.tid(page, 'auction-adv').locator('label.pm-check', { hasText: '철회된 건 포함' }).locator('input').uncheck();
    await query('');
    await page.locator('[data-testid="auction-pager"]').last().locator('select').selectOption('100'); await idle();
    const en0 = await page.$$eval('input[data-testid^="auction-pick-"]:not(:disabled):not([data-testid="auction-pick-all"])', (els) => els.map((e) => Number(e.dataset.testid.replace('auction-pick-', ''))));
    const two = en0.filter((id) => id !== NOLINK).slice(0, 2);
    await L.tid(page, `auction-pick-${two[0]}`).check(); await L.tid(page, `auction-pick-${two[1]}`).check();
    const cnt1 = await L.text(L.tid(page, 'auction-pick-count'));
    await L.tid(page, 'auction-sort-qty').click(); await idle();
    const cnt2 = (await L.tid(page, 'auction-pick-count').count()) ? await L.text(L.tid(page, 'auction-pick-count')) : '';
    s.c('AC-F-05 2건 선택 → 정렬 바꾸면 선택 해제', /2/.test(cnt1) && !/[1-9]건/.test(cnt2) && !(await L.tid(page, `auction-pick-${two[0]}`).isChecked()), { cnt1, cnt2 });

    // ---------- AC-F-01 · F-02 · F-04 전부 성공 ----------
    await L.tid(page, 'auction-sort-trade_date').click(); await idle();
    await page.locator('[data-testid="auction-pager"]').last().locator('select').selectOption('100'); await idle();
    const enabled = await page.$$eval('input[data-testid^="auction-pick-"]:not(:disabled):not([data-testid="auction-pick-all"])', (els) => els.map((e) => Number(e.dataset.testid.replace('auction-pick-', ''))));
    const free = ids.filter((id) => enabled.includes(id) && !Z.includes(id) && id !== NOLINK && id !== WD);
    const pick = free.slice(0, 3);
    for (const id of pick) await L.tid(page, `auction-pick-${id}`).check();
    const btn = await L.text(L.tid(page, 'auction-convert'));
    await L.tid(page, 'auction-convert').click();
    await L.tid(page, 'tc-summary').waitFor({ timeout: 8000 });
    const sum = await L.text(L.tid(page, 'tc-summary'));
    const pvRows = await page.locator('[data-testid^="tc-row-"]').count();
    s.c('AC-F-01 체크 3건 → [매입 전환 (3건)] → 미리보기 모달 건별 3행·합계·안내', /3/.test(btn) && pvRows === 3 && /3건/.test(sum) && /원/.test(sum) && (await L.text(L.tid(page, 'tc-notice'))).length > 0, { btn, sum, pvRows });
    cap.push(await L.shot(page, `S09_${W}_3_미리보기`));
    // 요청 지연(2.5초) 동안 잠금 확인
    const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/purchase-docs\/from-trades$/.test(new URL(url).pathname), { ms: 2500 });
    await L.tid(page, 'tc-submit').dblclick();
    await page.waitForTimeout(500);
    const subDis = await L.tid(page, 'tc-submit').isDisabled().catch(() => true);
    await page.keyboard.press('Escape');
    await page.locator('button.main-tab', { hasText: '매입서 대조' }).first().click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(300);
    const modalStill = (await L.tid(page, 'tc-modal').count()) === 1;
    await page.waitForFunction(() => /매입정보/.test(document.querySelector('.main-page-title')?.innerText || ''), null, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1200);
    s.c('AC-F-04 요청 중 [등록] 잠김·Esc/탭 이동 막힘, 두 번 눌러도 R-139 요청 1번', subDis && modalStill && st.count === 1, { subDis, modalStill, posts: st.count });
    const getP = [...reqs].reverse().find((x) => x.startsWith('GET /api/purchases?')) || '';
    const nNew = await page.locator('tr[data-testid^="purchase-new-"]').count();
    const chip = await L.text(L.tid(page, 'purchase-new-chip'));
    s.c('AC-F-02 전부 성공 → 매입정보 이동, 기간=경락일·R-22 ids, "방금 등록한 3건" 칩, 3행 강조, 경락 전환 배지 3', /매입정보/.test(await L.text(page.locator('.main-page-title')))
      && getP.includes(`from_date=${X}`) && /ids=/.test(getP) && nNew === 3 && /3건/.test(chip) && (await page.locator('[data-testid="pdoc-purchase-badge-auction"]').count()) === 3, { getP, nNew, chip });
    cap.push(await L.shot(page, `S09_${W}_4_매입정보_방금등록`));
    reqs.length = 0;
    await L.tid(page, 'purchase-new-chip-all').click(); await page.waitForTimeout(1000);
    const getAll = [...reqs].reverse().find((x) => x.startsWith('GET /api/purchases?')) || '';
    s.c('AC-F-02 [전체 보기] → 칩 없음, ids 없이 같은 기간', (await L.tid(page, 'purchase-new-chip').count()) === 0 && !/ids=/.test(getAll) && getAll.includes(`from_date=${X}`), getAll);
    const pur = (await L.call(u, 'GET', `/purchases?from_date=${X}&to_date=${X}&limit=200`)).json.data || [];
    s.c('API 확인 — 고른 3건 = 매입 3건(memo 경락 #id·원표, AUCTION)', pick.every((id) => pur.some((x) => String(x.memo || '').startsWith(`경락 #${id} `) && x.purchase_doc_kind === 'AUCTION')), pur.map((x) => x.memo));

    // ---------- AC-F-05 매입됨 · AC-F-03 일부 실패 ----------
    await L.tab(page, '경락 시세'); await idle(); await query('');
    await page.locator('[data-testid="auction-pager"]').last().locator('select').selectOption('100'); await idle();
    const done = await Promise.all(pick.map((id) => L.tid(page, `auction-converted-${id}`).count()));
    s.c('AC-F-05 전환된 행 "매입됨" 표시 + 체크 비활성', done.every((n) => n === 1) && (await L.tid(page, `auction-pick-${pick[0]}`).isDisabled()), done);
    const good = free.filter((id) => !pick.includes(id))[0];
    await L.tid(page, `auction-pick-${good}`).check(); await L.tid(page, `auction-pick-${NOLINK}`).check();
    await L.tid(page, 'auction-convert').click();
    await L.tid(page, 'tc-summary').waitFor({ timeout: 8000 });
    const pvText = await L.text(L.tid(page, 'tc-modal'));
    s.c('AC-F-01 미리보기 제외 이유(법인 연결 없음) 표시, 조사 중복("과과") 없음', /연결/.test(pvText) && !/과과/.test(pvText), pvText.slice(0, 300));
    await L.tid(page, 'tc-submit').click();
    await L.tid(page, 'tc-fail-list').waitFor({ timeout: 8000 }).catch(() => {});
    const go = await L.text(L.tid(page, 'tc-go'));
    s.c('AC-F-03 일부 실패 → 모달 유지·제외 목록·[매입정보에서 보기 (1건)]', (await L.tid(page, 'tc-fail-list').count()) === 1 && /1건/.test(go), go);
    cap.push(await L.shot(page, `S09_${W}_5_일부실패`));
    await L.tid(page, 'tc-go').click(); await page.waitForTimeout(1300);
    s.c('AC-F-03 [매입정보에서 보기] → 성공 1건만', (await page.locator('tr[data-testid^="purchase-new-"]').count()) === 1, await page.locator('tr[data-testid^="purchase-new-"]').count());

    // ---------- AC-F-07 ----------
    await L.tab(page, '매입서 대조'); await page.waitForTimeout(1000);
    // 매입서 목록 기본 기간은 최근 23일 — 이 스크립트 데이터(오늘−40일)가 보이게 기간 시작을 경락일로
    await L.tid(page, 'pdoc-filters').locator('input[type="date"]').first().fill(X);
    await L.tid(page, 'pdoc-search').click(); await page.waitForTimeout(1300);
    s.c('AC-F-07 매입서 대조 목록 "경락 직접 전환" 배지', (await page.locator('[data-testid^="pdoc-kind-auction-"]').count()) >= 1, await page.locator('[data-testid^="pdoc-kind-auction-"]').count());
    cap.push(await L.shot(page, `S09_${W}_6_매입서대조_배지`));
    s.c('pageerror 0', errors.length === 0, errors);
    await browser.close();

    // ---------- AC-F-06 조회 직원 ----------
    const v = await L.login('view');
    const o2 = await L.open({ user: v, width: W });
    await L.tab(o2.page, '경락 시세');
    await L.tid(o2.page, 'auction-date-from').fill(X); await L.tid(o2.page, 'auction-date-to').fill(X); await L.tid(o2.page, 'auction-search').click(); await o2.page.waitForTimeout(1500);
    const vr = await o2.page.locator('[data-testid^="auction-row-"]').count();
    s.c('AC-F-06 조회 직원 → 목록은 보이고 체크 열·[매입 전환] 없음', vr > 0 && (await L.tid(o2.page, 'auction-pick-all').count()) === 0 && (await L.tid(o2.page, 'auction-convert').count()) === 0
      && (await o2.page.locator('[data-testid^="auction-pick-"]').count()) === 0, vr);
    const vp = await L.call(v, 'POST', '/purchase-docs/from-trades', { trade_ids: [good] }, { 'Idempotency-Key': L.key('vw') });
    s.c('AC-F-06 조회 직원이 API 직접 호출(R-139) → 403', vp.status === 403, vp.status);
    cap.push(await L.shot(o2.page, `S09_${W}_7_조회직원`));
    s.c('조회 직원 pageerror 0', o2.errors.length === 0, o2.errors);
    await o2.browser.close();
  } else {
    // ---------- AC-O-10 휴대폰 정렬 선택 ----------
    await L.tid(page, 'auction-sort-select').selectOption('unit_price'); await idle();
    const r1 = lastList();
    const dirTxt1 = await L.text(L.tid(page, 'auction-sort-dir'));
    const api1 = (await L.call(u, 'GET', `/auction/trades?date_from=${X}&date_to=${X}&sort=unit_price&dir=desc&limit=50`)).json.data.map((x) => x.id);
    const shown1 = await page.$$eval('[data-testid^="auction-row-"]', (els) => els.map((e) => Number(e.dataset.testid.replace('auction-row-', ''))));
    s.c('AC-O-10 390 정렬 선택(단가) → sort=unit_price&dir=desc, 화면 순서 = 1366 머리글 정렬(API) 순서', /sort=unit_price/.test(r1) && /dir=desc/.test(r1) && JSON.stringify(shown1) === JSON.stringify(api1.slice(0, shown1.length)) && shown1.length > 0,
      { r1, dirTxt1, shown1: shown1.slice(0, 5), api1: api1.slice(0, 5) });
    await L.tid(page, 'auction-sort-dir').click(); await idle();
    const api2 = (await L.call(u, 'GET', `/auction/trades?date_from=${X}&date_to=${X}&sort=unit_price&dir=asc&limit=50`)).json.data.map((x) => x.id);
    const shown2 = await page.$$eval('[data-testid^="auction-row-"]', (els) => els.map((e) => Number(e.dataset.testid.replace('auction-row-', ''))));
    s.c('AC-O-10 390 방향 버튼 → dir=asc, 화면 순서 = API asc', /dir=asc/.test(lastList()) && JSON.stringify(shown2) === JSON.stringify(api2.slice(0, shown2.length)), { r: lastList(), shown2: shown2.slice(0, 5) });
    const dirBtn = await L.tid(page, 'auction-sort-dir').boundingBox();
    s.c('390 방향 버튼 터치 높이 ≥ 40px', dirBtn && dirBtn.height >= 40, dirBtn);
    cap.push(await L.shot(page, `S09_${W}_1_정렬선택`));
    // 입력 직원 전환 1건
    const free = await page.$$eval('input[data-testid^="auction-pick-"]:not(:disabled):not([data-testid="auction-pick-all"])', (els) => els.map((e) => Number(e.dataset.testid.replace('auction-pick-', ''))));
    const one = free.find((id) => id !== NOLINK);
    await L.tid(page, `auction-pick-${one}`).check();
    await L.tid(page, 'auction-convert').click(); await L.tid(page, 'tc-summary').waitFor({ timeout: 8000 });
    await L.tid(page, 'tc-submit').click();
    await page.waitForFunction(() => /매입정보/.test(document.querySelector('.main-page-title')?.innerText || ''), null, { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1200);
    s.c('390 입력 직원 전환 → 매입정보 1건 강조', (await page.locator('tr[data-testid^="purchase-new-"]').count()) === 1, await page.locator('tr[data-testid^="purchase-new-"]').count());
    cap.push(await L.shot(page, `S09_${W}_2_매입정보`));
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    s.c('390 가로 넘침 없음', ov <= 1, ov);
    s.c('pageerror 0', errors.length === 0, errors);
    await browser.close();
  }
  await pool.end();
  process.exit(s.done({ width: W, date: X, capture: cap }));
})().catch((e) => { console.error(e); process.exit(2); });
