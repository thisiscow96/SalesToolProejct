// S07 장애 주입 화면 표시(실서버·목업 장애) — 5xx→DEAD(이전 결과 stale 배지)·타임아웃·429·서킷 OPEN·인증 오류·서버 5xx 응답·빈 데이터/휴장(S01)
// 목업 장애는 수집 작업 params.mock_scenario(테스트 DB)로 주입하고 tick 으로 실행한다 (AUCTION_MOCK_CONTROL=true)
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const f = L.fixture(); const D = f.dates; const tag = Date.now().toString(36);
  const TICK = process.env.COLLECT_TRIGGER_TOKEN || '';
  const s = L.suite(`S07_${W}`, '장애 주입 화면 표시 — 실서버');
  const pool = L.db(); const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const reset = () => q(`UPDATE ext_circuit_state SET state='CLOSED', consecutive_failures=0, opened_at=NULL, next_probe_at=NULL, disabled_reason=NULL, disabled_until=NULL, cooldown_sec=600`);
  let seq = 0;
  const enqueue = async (date, scen, extra = {}) => (await q(`INSERT INTO collect_job(job_type,source,market_code,trade_date,phase,params,dedupe_key,attempts) VALUES('COLLECT','AT_REALTIME','110001',$1,'FINAL',$2::jsonb,$3,$4) RETURNING id`, [date, JSON.stringify({ mock_scenario: scen, force: true }), `C203S07:${tag}:${++seq}`, extra.attempts || 0]))[0].id;
  const tick = () => L.call(null, 'POST', '/internal/collect/tick', {}, { 'x-collect-token': TICK });
  const job = async (id) => (await q(`SELECT status, attempts, last_error_kind FROM collect_job WHERE id=$1`, [id]))[0];
  if (TICK.length < 16) { console.error('COLLECT_TRIGGER_TOKEN 필요'); process.exit(2); }
  await reset();
  // 1) 5xx 5회째 → DEAD, 조회는 이전 정상 결과 + stale
  const j1 = await enqueue(D.S, '5xx', { attempts: 4 }); await tick();
  const j1s = await job(j1);
  s.c('주입: 5xx 5회째 → DEAD', j1s.status === 'DEAD' && j1s.last_error_kind === 'SERVER_ERROR', j1s);
  await reset();
  // 2) 타임아웃 → QUEUED(재시도 대기)·TIMEOUT
  const j2 = await enqueue(D.S, 'timeout'); await tick();
  const j2s = await job(j2);
  s.c('주입: 타임아웃 → QUEUED·TIMEOUT', j2s.status === 'QUEUED' && j2s.last_error_kind === 'TIMEOUT', j2s);
  await reset();
  // 3) 429
  const j3 = await enqueue(D.S, 'rate429'); await tick();
  s.c('주입: 429 → QUEUED·RATE_LIMIT', (await job(j3)).last_error_kind === 'RATE_LIMIT', await job(j3));
  const u = await L.login('owner');
  const { browser, page, errors } = await L.open({ user: u, width: W });
  await L.tab(page, '경락 시세');
  await L.tid(page, 'auction-date-from').fill(D.S); await L.tid(page, 'auction-date-to').fill(D.S);
  await L.tid(page, 'auction-search').click(); await page.waitForTimeout(1500);
  const meta = await L.text(L.tid(page, 'auction-meta'));
  const rows = await page.locator('[data-testid^="auction-row-"]').count();
  s.c('수집 실패한 날 조회 → 이전 정상 결과 + "이전 수집 결과(수집 지연)" 배지', rows > 0 && (await L.tid(page, 'auction-stale').count()) === 1, { rows, meta });
  const cap = [await L.shot(page, `S07_${W}_1_stale`)];
  // 수집 현황: 작업 오류 종류 문구
  await L.tid(page, 'auction-view-sync').click(); await L.tid(page, 'auction-jobs').waitFor(); await page.waitForTimeout(1200);
  const jt = (id) => L.text(L.tid(page, `auction-job-${id}`));
  const [t1, t2, t3] = [await jt(j1), await jt(j2), await jt(j3)];
  s.c('작업 목록: DEAD 행 "외부 서버 오류(5xx)"·[다시 실행]', /5xx/.test(t1) && (await L.tid(page, `auction-job-retry-${j1}`).count()) === 1, t1);
  s.c('작업 목록: 타임아웃 행 "응답 시간 초과"·다음 실행 시각', /응답 시간 초과/.test(t2) && /실행/.test(t2), t2);
  s.c('작업 목록: 429 행 "호출 한도(429)"', /429/.test(t3), t3);
  cap.push(await L.shot(page, `S07_${W}_2_작업오류`));
  // 4) 서킷 OPEN → 소스 상태 "잠시 멈춤 · HH:MM에 다시 시도", [지금 받기] → 409 문구
  await q(`UPDATE ext_circuit_state SET state='OPEN', consecutive_failures=5, opened_at=NOW(), next_probe_at=NOW() + interval '10 minutes', last_error_kind='SERVER_ERROR' WHERE source='AT_REALTIME'`).catch(async () => {
    await q(`UPDATE ext_circuit_state SET state='OPEN', consecutive_failures=5, opened_at=NOW(), next_probe_at=NOW() + interval '10 minutes' WHERE source='AT_REALTIME'`);
  });
  await q(`UPDATE collect_job SET created_at = created_at - interval '1 hour', dedupe_key = LEFT(dedupe_key, 100) || ':old' || id WHERE requested_by_user_id=$1 AND dedupe_key NOT LIKE '%:old%'`, [f.accounts.owner.id]);
  await L.tid(page, 'auction-sync-reload').click(); await page.waitForTimeout(1200);
  const c1 = await L.text(L.tid(page, 'auction-circuit-AT_REALTIME'));
  s.c('서킷 OPEN → "잠시 멈춤"·다시 시도 시각', /잠시 멈춤/.test(c1) && /다시 시도/.test(c1), c1);
  await L.tid(page, 'auction-sync-from').fill(D.S); await L.tid(page, 'auction-sync-to').fill(D.S);
  await page.locator('[data-testid="auction-sync-form"] input[type=checkbox]').check();
  await L.tid(page, 'auction-sync-now').click(); await page.waitForTimeout(1200);
  const m4 = await L.text(L.tid(page, 'auction-sync-msg'));
  s.c('서킷 OPEN 중 [지금 받기] → "잠시 멈춤 상태" 문구(409)', /멈춤/.test(m4), m4);
  cap.push(await L.shot(page, `S07_${W}_3_서킷OPEN`));
  // 5) 인증 오류
  await q(`UPDATE ext_circuit_state SET state='OPEN', disabled_reason='AUTH_ERROR' WHERE source='AT_REALTIME'`);
  await L.tid(page, 'auction-sync-reload').click(); await page.waitForTimeout(1200);
  const c2 = await L.text(L.tid(page, 'auction-circuit-AT_REALTIME'));
  s.c('인증 오류 → "API 키 확인 필요"', /API 키 확인 필요/.test(c2), c2);
  s.c('화면 어디에도 키 값 없음(serviceKey=)', !/serviceKey=[^*]/i.test(await page.locator('main').innerText()), '');
  cap.push(await L.shot(page, `S07_${W}_4_인증오류`));
  await reset();
  // 6) 서버가 5xx 를 돌려줄 때(경락 조회·매입서 목록) — 오류 문구, 화면 안 깨짐
  await page.route('**/api/auction/trades**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, message: '테스트용 서버 오류(500)' }) }));
  await L.tid(page, 'auction-view-trades').click(); await page.waitForTimeout(1200);
  const e6 = await L.text(L.tid(page, 'auction-error'));
  s.c('경락 조회 500 → 오류 문구 표시', /오류|불러오지/.test(e6), e6);
  await page.unroute('**/api/auction/trades**');
  await page.route('**/api/purchase-docs?**', (r) => r.abort('failed'));
  await L.tab(page, '매입서 대조'); await page.waitForTimeout(1200);
  const e7 = await page.locator('[data-testid="pdoc-tab"]').innerText();
  s.c('매입서 목록 네트워크 끊김 → "서버에 연결하지 못했습니다"', /연결하지 못했습니다/.test(e7), e7.slice(0, 200));
  cap.push(await L.shot(page, `S07_${W}_5_네트워크끊김`));
  await page.unroute('**/api/purchase-docs?**');
  s.c('pageerror 0', errors.length === 0, errors);
  await q(`UPDATE collect_job SET status='CANCELLED', finished_at=NOW() WHERE status='QUEUED'`);
  await browser.close(); await pool.end();
  process.exit(s.done({ width: W, capture: cap }));
})().catch((e) => { console.error(e); process.exit(2); });
