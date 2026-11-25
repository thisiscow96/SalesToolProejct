// S08 B② "서버와 맞출 것" 11건 중 다른 시나리오에서 안 본 칸을 화면에서 확인 (실서버, D.E)
// #3 전환 뒤 정정 표시(CORRECTED_AFTER_CONVERT) · #5 검토 대기 차이(top_diff) · #8 작업 행 요청자(가린 이름)·시도 x/5·오류 문구
// #10 시장 달력 조회(date_from/to) · #11 품목 매핑 추가 409 MAPPING_DUPLICATE / 400 VALIDATION 문구 (관리자)
// (#1·#2·#4·#6·#9 는 S03·S04·S05, #7 은 S02 에서 확인)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const f = L.fixture(); const D = f.dates; const P = f.partners; const tag = Date.now().toString(36).slice(-5);
  const s = L.suite(`S08_${W}`, '서버·화면 칸 맞춤 — 실서버');
  const pool = L.db(); const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const u = await L.login('owner');
  const post = async (body) => (await L.call(u, 'POST', '/purchase-docs', body, { 'Idempotency-Key': L.key('s08') })).json?.data?.docs?.[0];
  const d1 = await post({ doc_no: `Z1-${tag}`, supplier_partner_id: P.PC, auto_convert: true, lines: [{ trade_date: D.E, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000 }] });
  const d2 = await post({ doc_no: `Z2-${tag}`, supplier_partner_id: P.PB, auto_convert: true, lines: [{ trade_date: D.E, item_name: '오이고추', grade: '특', spec: '10kg 상자', qty: 18, unit_price: 30000 }] });
  const l1 = d1.lines[0]; const l2 = d2.lines[0];
  s.c('준비: 홍고추 자동 등록 / 오이 +1,000원 보류', l1.status === 'CONVERTED' && l2.status === 'HOLD', [l1.status, l2.status, l2.reason_codes]);
  // #3 매입정보에서 정정 → 매입서 상세 "전환 뒤 정정"
  const pid = l1.purchase_id;
  const corr = await L.call(u, 'PATCH', `/purchases/${pid}`, { changes: { memo: '정정 메모(가명)' }, reason: '메모 정정' });
  s.c('준비: 매입 정정(PATCH) 200', corr.status === 200, corr.json);
  const { browser, page, errors } = await L.open({ user: u, width: W });
  await L.tab(page, '매입서 대조');
  await L.tid(page, `pdoc-open-${d1.id}`).click(); await L.tid(page, 'pdoc-lines').waitFor(); await page.waitForTimeout(500);
  const sub = await page.locator(`[data-testid="pdoc-line-${l1.id}"] + tr.pm-subrow`).innerText().catch(() => '');
  s.c('#3 전환 뒤 정정 → 줄 아래 "정정" 문구', /정정/.test(sub) && !/CORRECTED_AFTER_CONVERT/.test(sub), sub);
  const cap = [await L.shot(page, `S08_${W}_1_전환뒤정정`)];
  // #5 검토 대기 차이 칸
  await L.tid(page, 'pdoc-back').click(); await L.tid(page, 'pdoc-view-review').click(); await L.tid(page, 'pdoc-review-table').waitFor(); await page.waitForTimeout(1200);
  const rr = await L.text(L.tid(page, `pdoc-review-row-${l2.id}`));
  s.c('#5 검토 대기 "차이" = 단가 +1,000원(+3.4~3.5%)', /단가 \+1,000원/.test(rr) && /3\.[45]%/.test(rr), rr);
  cap.push(await L.shot(page, `S08_${W}_2_검토대기차이`));
  // #8 작업 행: 요청자 가린 이름·시도 x/5·오류 문구
  const jid = (await q(`INSERT INTO collect_job(job_type,source,market_code,trade_date,phase,params,dedupe_key,attempts,status,last_error_kind,last_error,finished_at,requested_by,requested_by_user_id)
     VALUES('COLLECT','AT_REALTIME','110001',$1,'FINAL','{}'::jsonb,$2,5,'DEAD','SERVER_ERROR','HTTP 502 Bad Gateway(테스트)',NOW(),'USER',$3) RETURNING id`, [D.S, `C203S08:${tag}`, f.accounts.owner.id]))[0].id;
  await L.tab(page, '경락 시세'); await L.tid(page, 'auction-view-sync').click(); await L.tid(page, 'auction-jobs').waitFor(); await page.waitForTimeout(1200);
  const jr = await L.text(L.tid(page, `auction-job-${jid}`));
  s.c('#8 작업 행: 요청자 가린 이름(가*인)·5/5·오류 문구', /\*/.test(jr) && /5\/5/.test(jr) && /502/.test(jr) && !/가명중매인/.test(jr), jr);
  cap.push(await L.shot(page, `S08_${W}_3_작업행`));
  await browser.close();
  // #10·#11 관리자 — 시장 달력·품목 매핑
  const adm = await L.login('admin');
  const o = await L.open({ user: adm, width: W });
  await L.tab(o.page, '매입서 대조'); await L.tid(o.page, 'pdoc-view-settings').click(); await L.tid(o.page, 'pdoc-settings-admin').waitFor(); await o.page.waitForTimeout(1500);
  await o.page.locator('[data-testid="pdoc-cal-card"] input[type=month]').fill(D.H.slice(0, 7)); await o.page.waitForTimeout(1200);
  const cal = await L.text(L.tid(o.page, 'pdoc-cal-card'));
  s.c(`#10 시장 달력에 휴장일 ${D.H} 표시`, cal.includes(D.H) || cal.includes(D.H.slice(5)), cal.slice(0, 300));
  const unm = await L.text(L.tid(o.page, 'pdoc-unmapped'));
  s.c('관리자: 매핑 안 된 이름 목록에 "청량초"(매입서) 또는 피망', /청량초|피망/.test(unm), unm.slice(0, 200));
  await o.page.locator('[aria-label="키워드"]').fill('청량초');
  await L.tid(o.page, 'pdoc-map-item').selectOption('PEPPER.CHEONGYANG').catch(() => {});
  await L.tid(o.page, 'pdoc-map-add').click(); await o.page.waitForTimeout(1200);
  const mapCard = await L.text(L.tid(o.page, 'pdoc-map-card'));
  const added = (await q(`SELECT COUNT(*) c FROM item_mapping WHERE keyword_norm LIKE '%청량초%' AND active`).catch(() => [{ c: -1 }]))[0].c;
  s.c('#11 매핑 추가(청량초 → 청양고추) 성공', Number(added) >= 1 || /추가했|저장했/.test(mapCard), { added, mapCard: mapCard.slice(0, 200) });
  await o.page.locator('[aria-label="키워드"]').fill('청량초');
  await L.tid(o.page, 'pdoc-map-item').selectOption('PEPPER.CHEONGYANG').catch(() => {});
  await L.tid(o.page, 'pdoc-map-add').click(); await o.page.waitForTimeout(1200);
  const mapCard2 = await L.text(L.tid(o.page, 'pdoc-map-card'));
  s.c('#11 같은 매핑 다시 추가 → 중복 문구(409)', /이미|중복/.test(mapCard2), mapCard2.slice(0, 300));
  cap.push(await L.shot(o.page, `S08_${W}_4_관리자매핑`));
  s.c('pageerror 0', errors.length === 0 && o.errors.length === 0, [...errors, ...o.errors]);
  await o.browser.close(); await pool.end();
  process.exit(s.done({ width: W, capture: cap }));
})().catch((e) => { console.error(e); process.exit(2); });
