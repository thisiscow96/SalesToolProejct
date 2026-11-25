// S02 수집 현황(실서버) — 소스 상태·날짜별·[지금 받기](주인)·429 남은 시간·[다시 실행](FAILED/DEAD)·[대기 취소](관리자)·연타 1회
const L = require('./lib.cjs');
const W = Number(process.env.W || 1366);
(async () => {
  const f = L.fixture();
  const s = L.suite(`S02_${W}`, '수집 현황 — 실서버');
  const pool = L.db();
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  // 5분 1회 제한을 이 회원 기준으로 풀어 둠(테스트 DB) — 이전 실행의 수동 동기화 기록 시각을 과거로
  await q(`UPDATE collect_job SET created_at = created_at - interval '1 hour', dedupe_key = LEFT(dedupe_key, 100) || ':old' || id WHERE dedupe_key NOT LIKE '%:old%' AND requested_by_user_id = $1`, [f.accounts.owner.id]);
  // DEAD 작업 하나 준비(5xx 를 attempts 4 에서 실행)
  const dead = (await q(`INSERT INTO collect_job(job_type,source,market_code,trade_date,phase,params,dedupe_key,attempts,status,last_error_kind,finished_at)
     VALUES('COLLECT','AT_REALTIME','110001',$1,'FINAL','{"mock_scenario":"5xx"}'::jsonb,$2,5,'DEAD','SERVER_ERROR',NOW()) RETURNING id`, [f.dates.E, `C203:S02:${Date.now()}`]))[0].id;
  const u = await L.login('owner');
  const { browser, page, errors } = await L.open({ user: u, width: W });
  await L.tab(page, '경락 시세');
  await L.tid(page, 'auction-view-sync').click();
  await L.tid(page, 'auction-circuits').waitFor({ timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="auction-sync-reload"]')?.disabled, null, { timeout: 8000 });
  s.c('소스 상태 AT_REALTIME 정상', /정상/.test(await L.text(L.tid(page, 'auction-circuit-AT_REALTIME'))), await L.text(L.tid(page, 'auction-circuits')));
  const days = await L.text(L.tid(page, 'auction-days'));
  s.c('날짜별 칩에 확정 완료 15건·당일 경매 전', /확정.*완료.*15건/.test(days) && /경매 전|집계 전|NOT_YET/.test(days), days);
  s.c('[다시 실행] 버튼(DEAD 작업)', (await L.tid(page, `auction-job-retry-${dead}`).count()) === 1, dead);
  s.c('주인(관리자 아님)에게 [대기 취소] 없음', (await page.locator('[data-testid^="auction-job-cancel-"]').count()) === 0, '');
  const cap = [await L.shot(page, `S02_${W}_1_현황`)];
  // [지금 받기] 연타 → 요청 1회, 응답까지 잠금
  const st = await L.slow(page, (url, m) => m === 'POST' && /\/api\/auction\/sync$/.test(new URL(url).pathname), { ms: 2000 });
  await L.tid(page, 'auction-sync-from').fill(f.dates.A); await L.tid(page, 'auction-sync-to').fill(f.today);
  await L.tid(page, 'auction-sync-now').click();
  await L.tid(page, 'auction-sync-now').click({ force: true, timeout: 500 }).catch(() => {});
  await L.tid(page, 'auction-sync-now').click({ force: true, timeout: 500 }).catch(() => {});
  const lockBtn = await L.tid(page, 'auction-sync-now').isDisabled();
  const lockFrom = await L.tid(page, 'auction-sync-from').isDisabled();
  await page.waitForTimeout(2800);
  const msg = await L.text(L.tid(page, 'auction-sync-msg'));
  s.c('[지금 받기] 연타 → 요청 1회·응답까지 버튼·기간 잠금', st.count === 1 && lockBtn && lockFrom, { count: st.count, lockBtn, lockFrom });
  s.c('결과 문구(대기열·건너뜀 이미 받음)', /대기열/.test(msg) && /이미 받음/.test(msg), msg);
  const btn = await L.text(L.tid(page, 'auction-sync-now'));
  s.c('성공 뒤 버튼 "N분 뒤 다시 가능"', /분 뒤 다시 가능/.test(btn) && (await L.tid(page, 'auction-sync-now').isDisabled()), btn);
  cap.push(await L.shot(page, `S02_${W}_2_지금받기`));
  await page.unroute('**/api/**');
  // 화면을 다시 열면 남은 시간 기억 없음 → 누르면 서버 429 → 남은 시간 표시
  await page.reload(); await page.waitForSelector('button.main-tab');
  await L.tab(page, '경락 시세');
  await L.tid(page, 'auction-view-sync').click(); await L.tid(page, 'auction-sync-now').waitFor();
  const btnAfterReload = await L.text(L.tid(page, 'auction-sync-now'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="auction-sync-reload"]')?.disabled, null, { timeout: 8000 });
  // 같은 분 안 두 번째 [지금 받기](기간 넓힘) — 5분 1회 제한이 걸려야 함(D01: 같은 분 키가 하나라도 겹치면 제한을 건너뜀)
  const n0 = Number((await q(`SELECT COUNT(*) c FROM collect_job WHERE requested_by_user_id=$1 AND dedupe_key NOT LIKE '%:old%'`, [f.accounts.owner.id]))[0].c);
  await L.tid(page, 'auction-sync-now').click(); await page.waitForTimeout(1200);
  const n1 = Number((await q(`SELECT COUNT(*) c FROM collect_job WHERE requested_by_user_id=$1 AND dedupe_key NOT LIKE '%:old%'`, [f.accounts.owner.id]))[0].c);
  s.c('[D01] 5분 안 두 번째 지금 받기(같은 분·기간 넓힘) → 새 작업 0건', n1 === n0, { before: n0, after: n1, msg: await L.text(L.tid(page, 'auction-sync-msg')) });
  // 다음 분까지 기다렸다가 다시 → 이번에는 키가 겹치지 않아 429
  const curMin = new Date().getMinutes();
  while (new Date().getMinutes() === curMin) await L.sleep(1000);
  await page.reload(); await page.waitForSelector('button.main-tab');
  await L.tab(page, '경락 시세');
  await L.tid(page, 'auction-view-sync').click(); await L.tid(page, 'auction-sync-now').waitFor();
  await page.waitForFunction(() => !document.querySelector('[data-testid="auction-sync-reload"]')?.disabled, null, { timeout: 8000 });
  await L.tid(page, 'auction-sync-now').click(); await page.waitForTimeout(1200);
  const msg429 = await L.text(L.tid(page, 'auction-sync-msg'));
  const btn429 = await L.text(L.tid(page, 'auction-sync-now'));
  const api429 = await L.call(u, 'POST', '/auction/sync', { source: 'AT_REALTIME', date_from: f.dates.A, date_to: f.dates.A, phase: 'FINAL' });
  s.c('서버 429 SYNC_RATE_LIMIT + detail.retry_after_sec', api429.status === 429 && api429.json.code === 'SYNC_RATE_LIMIT' && Number(api429.json.detail?.retry_after_sec) > 0, api429.json);
  s.c('429 → 문구 + 버튼 남은 시간 표시', /5분|한 번/.test(msg429) && /분 뒤 다시 가능/.test(btn429), { msg429, btn429, btnAfterReload });
  cap.push(await L.shot(page, `S02_${W}_3_429`));
  // [다시 실행] — 새 작업 생김, 버튼 잠금
  const st2 = await L.slow(page, (url, m) => m === 'POST' && /\/retry$/.test(url), { ms: 1500 });
  await L.tid(page, `auction-job-retry-${dead}`).click();
  await page.waitForTimeout(200);
  const retryBusy = await L.tid(page, `auction-job-retry-${dead}`).isDisabled().catch(() => null);
  await L.tid(page, `auction-job-retry-${dead}`).click({ force: true, timeout: 400 }).catch(() => {});
  await page.waitForTimeout(2500);
  const newJobs = await q(`SELECT id, status FROM collect_job WHERE id > $1 AND trade_date = $2 AND job_type='COLLECT' ORDER BY id`, [dead, f.dates.E]);
  s.c('[다시 실행] 1회 요청·요청 중 그 줄 잠금·새 작업 1건', st2.count === 1 && retryBusy === true && newJobs.length === 1, { count: st2.count, retryBusy, newJobs });
  s.c('[다시 실행] 결과 문구', /다시 넣었습니다/.test(await L.text(L.tid(page, 'auction-sync-msg'))), await L.text(L.tid(page, 'auction-sync-msg')));
  await page.unroute('**/api/**');
  await browser.close();
  // 관리자: QUEUED 작업 [대기 취소]
  const adm = await L.login('admin');
  const o2 = await L.open({ user: adm, width: W });
  await L.tab(o2.page, '경락 시세'); await L.tid(o2.page, 'auction-view-sync').click();
  await L.tid(o2.page, 'auction-jobs').waitFor();
  await o2.page.waitForFunction(() => !document.querySelector('[data-testid="auction-sync-reload"]')?.disabled, null, { timeout: 8000 });
  const queued = (await q(`SELECT id FROM collect_job WHERE status='QUEUED' ORDER BY id DESC LIMIT 1`))[0]?.id;
  const cancelBtn = o2.page.locator(`[data-testid="auction-job-cancel-${queued}"]`);
  s.c('관리자에게 QUEUED 작업 [대기 취소] 보임', queued && (await cancelBtn.count()) === 1, { queued });
  if (queued && (await cancelBtn.count())) {
    await cancelBtn.click(); await o2.page.waitForTimeout(1500);
    const stq = (await q(`SELECT status FROM collect_job WHERE id=$1`, [queued]))[0].status;
    s.c('[대기 취소] → CANCELLED', stq === 'CANCELLED', stq);
  }
  cap.push(await L.shot(o2.page, `S02_${W}_4_관리자취소`));
  await o2.browser.close();
  // 남은 대기 작업 정리(다음 테스트 간섭 방지)
  await q(`UPDATE collect_job SET status='CANCELLED', finished_at=NOW() WHERE status='QUEUED'`);
  s.c('pageerror 0', errors.length === 0 && o2.errors.length === 0, [...errors, ...o2.errors]);
  await pool.end();
  process.exit(s.done({ width: W, capture: cap }));
})().catch((e) => { console.error(e); process.exit(2); });
