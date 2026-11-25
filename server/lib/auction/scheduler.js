'use strict';
/**
 * T-203 스케줄러 (D 3.4·4.1)
 *  tick() = planDue(슬롯 → 작업, dedupe_key 로 1회) + 누락 보정(최근 7일 FINAL 정상 스냅샷 없는 날) + recoverStale + runBatch(최대 3작업·25초)
 *  - 외부 무료 cron(GitHub Actions → POST /api/internal/collect/tick) 과 서버 내부 타이머(COLLECT_TIMER_ENABLED) 가 같은 tick 을 부른다.
 *    둘이 겹쳐도 dedupe_key + FOR UPDATE SKIP LOCKED 로 한 번만 실행.
 *  - 슬롯은 "지난 6시간 안의 가장 최근 슬롯" 하나만 만든다(서버가 며칠 잠들었다 깨도 지난 INTRADAY 를 몰아 만들지 않음 — FINAL 은 누락 보정이 메움).
 *  - cron 은 5필드(분 시 일 월 요일, KST). 값: *, 숫자, a-b, a,b, *\/n, a-b/n
 */
const queue = require('./queue');
const worker = require('./worker');

const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

/** cron 5필드 → 필드별 허용 값 Set 배열. 형식 오류면 null */
function parseCron(text) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const out = [];
  for (let i = 0; i < 5; i += 1) {
    const [lo, hi] = FIELD_RANGES[i];
    const set = new Set();
    for (const item of parts[i].split(',')) {
      const m = item.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) return null;
      let a = lo;
      let b = hi;
      if (m[1] !== '*') {
        const [x, y] = m[1].split('-').map(Number);
        a = x;
        b = y == null ? (m[2] ? hi : x) : y;
      }
      const step = m[2] ? Number(m[2]) : 1;
      if (!(step >= 1) || a < lo || b > hi || a > b) return null;
      for (let v = a; v <= b; v += step) set.add(i === 4 && v === 7 ? 0 : v);
    }
    out.push(set);
  }
  return out;
}

function cronMatches(fields, kst) {
  return fields[0].has(kst.getUTCMinutes()) && fields[1].has(kst.getUTCHours()) && fields[2].has(kst.getUTCDate())
    && fields[3].has(kst.getUTCMonth() + 1) && fields[4].has(kst.getUTCDay());
}

/** now 이전(포함) 가장 최근 슬롯(분 단위, KST 표기 Date) — lookbackMin 안에 없으면 null */
function latestSlot(fields, now = new Date(), lookbackMin = 360) {
  const startKst = new Date(Math.floor((now.getTime() + 9 * 3600 * 1000) / 60000) * 60000);
  for (let i = 0; i <= lookbackMin; i += 1) {
    const t = new Date(startKst.getTime() - i * 60000);
    if (cronMatches(fields, t)) return t;
  }
  return null;
}
const slotKey = (kst) => kst.toISOString().slice(0, 16).replace(/[-T:]/g, '');
const kstDateOf = (kst) => kst.toISOString().slice(0, 10); // 인자는 KST 표기 Date(슬롯)

async function hasFinalOk(db, source, market, date) {
  // 법인 한정(AUCTION_CORP_CODES): 지금 설정 범위를 덮는 스냅샷(전체 = corp_scope NULL, 또는 범위를 다 포함)만 완료로 본다
  //   → 한국청과만 받은 날을 설정을 비운 뒤에도 "그날 전체 완료"로 보고 건너뛰지 않음
  const scope = worker.snapshotScope({ source });
  const r = await db.query(
    `SELECT 1 FROM collect_snapshot WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND is_latest_ok AND (phase = 'FINAL' OR status = 'HOLIDAY')
        AND (corp_scope IS NULL OR status = 'HOLIDAY' OR string_to_array(corp_scope, ',') @> $4::text[]) LIMIT 1`,
    [source, market, date, scope ? scope.split(',') : null]
  );
  return !!r.rows[0];
}

/** 같은 날짜의 진행 중 수집 작업(RUNNING, 또는 곧 실행될 QUEUED) — 스케줄 폴링·01:00 배치·수동 받기가 겹쳐 같은 호출을 두 번 쓰지 않게 */
async function activeCollect(db, { source = 'AT_REALTIME', market, date, now = new Date() }) {
  const r = await db.query(
    `SELECT id, status, phase, params FROM collect_job
      WHERE job_type = 'COLLECT' AND source = $1 AND market_code = $2 AND trade_date = $3
        AND (status = 'RUNNING' OR (status = 'QUEUED' AND run_after <= NOW() + interval '1 minute' AND $4::timestamptz IS NOT NULL))
      ORDER BY CASE status WHEN 'RUNNING' THEN 0 ELSE 1 END, id LIMIT 1`,
    [source, market, date, now]
  );
  return r.rows[0] ? { ...r.rows[0], id: Number(r.rows[0].id) } : null;
}

const DONE_STATES = ['SETTLED', 'CONFIRMED', 'HOLIDAY', 'NO_TRADE'];

/**
 * 02:00 창 종료(A 2.3) — 외부 호출 없음. 아직 LIVE 면 SETTLED(WINDOW_END) + FINAL 1회, 계속 빈 응답(WAITING)이면 NO_TRADE.
 * 상태 조건을 건 UPDATE 라 몇 번 불려도(타이머·collect_once·6시간 lookback) 결과가 같다.
 */
async function windowEnd(pool, { source, market, date, now }) {
  const scope = worker.snapshotScope({ source }) || '';
  const live = await pool.query(
    `UPDATE collect_day_state SET state = 'SETTLED', settled_at = $5, settle_reason = 'WINDOW_END', updated_at = NOW()
      WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND corp_scope = $4 AND state = 'LIVE' RETURNING id`,
    [source, market, date, scope, now]
  );
  if (live.rows[0]) {
    const r = await queue.enqueue(pool, { job_type: 'COLLECT', source, market_code: market, trade_date: date, phase: 'FINAL',
      params: { reason: 'WINDOW_END', live: true }, dedupe_key: `COLLECT:${source}:${market}:${date}:FINAL:SETTLED` });
    return { state: 'SETTLED', job_id: r.id, created: r.created };
  }
  const w = await pool.query(
    `UPDATE collect_day_state SET state = 'NO_TRADE', updated_at = NOW()
      WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND corp_scope = $4 AND state = 'WAITING' RETURNING id`,
    [source, market, date, scope]
  );
  return w.rows[0] ? { state: 'NO_TRADE' } : null;
}

/**
 * 슬롯대로 작업 넣기 (T-203 033 — 정산일 = settleDateOf(슬롯 시각), A 1.2·2.3·3절)
 *  COLLECT_INTRADAY  창 10분 폴링(phase INTRADAY, live). 그날 상태가 SETTLED·CONFIRMED·HOLIDAY·NO_TRADE 면 계획하지 않음. 휴장이면 1회만(HOLIDAY 스냅샷, 호출 0)
 *  COLLECT_NIGHTLY   01:00 고정 배치 — 상태와 관계없이 1회(진행 중이면 INTRADAY, 완료 판정 뒤면 FINAL). 같은 날짜 작업이 이미 돌고 있으면 그 작업에 nightly_of 표시
 *  COLLECT_WINDOW_END 02:00 창 종료(호출 0)
 *  COLLECT_FINAL     06:00 확인(+11:00 재시도) — CONFIRMED·HOLIDAY 면 건너뜀(완료 판정 때의 FINAL 만으로는 건너뛰지 않음)
 *  SETTLE_VERIFY·CODE_SYNC·PURGE_RAW 는 예전 그대로(SETTLE_VERIFY 대상 = 달력 어제, U-L-06)
 */
async function planDue(pool, now = new Date()) {
  const market = worker.marketCode();
  // 순서 고정(FINAL → INTRADAY → NIGHTLY → WINDOW_END): 01:00 에 창 폴링이 먼저 들어가고 01:00 배치는 그 작업에 nightly_of 로 합쳐진다
  const sch = await pool.query(`SELECT job_type, source, cron_text FROM collect_schedule WHERE active ORDER BY job_type, source`);
  const planned = [];
  for (const s of sch.rows) {
    const fields = parseCron(s.cron_text);
    if (!fields) continue;
    const slot = latestSlot(fields, now);
    if (!slot) continue;
    const key = slotKey(slot);
    const slotAt = new Date(slot.getTime() - 9 * 3600 * 1000); // 슬롯의 실제 시각(UTC)
    const D = worker.settleDateOf(slotAt); // L-D1: 달력 날짜가 아니라 정산일
    const yesterday = worker.addDays(kstDateOf(slot), -1);
    const live = s.source === 'AT_REALTIME';
    /* eslint-disable no-await-in-loop */
    const st = live && s.job_type.startsWith('COLLECT_') ? await worker.dayState(pool, { source: s.source, market, date: D }) : null;
    const hol = live && s.job_type.startsWith('COLLECT_') ? await worker.isHoliday(pool, market, D) : false;
    let job = null;
    if (s.job_type === 'COLLECT_INTRADAY') {
      if (st && DONE_STATES.includes(st.state)) continue;
      if (live && !hol && await activeCollect(pool, { source: s.source, market, date: D, now })) continue; // 같은 날짜 수집이 이미 대기·실행 중(수동·배치·지난 슬롯)
      if (hol) {
        // 휴장: 그날 1회만 넣는다 — 워커가 외부 호출 없이 HOLIDAY 스냅샷·하루 상태 HOLIDAY 를 남기고, 그 뒤 슬롯은 위에서 건너뜀
        job = { job_type: 'COLLECT', source: s.source, market_code: market, trade_date: D, phase: 'INTRADAY', params: { reason: 'HOLIDAY', live: true },
          dedupe_key: `COLLECT:${s.source}:${market}:${D}:INTRADAY:HOLIDAY` };
      } else {
        job = { job_type: 'COLLECT', source: s.source, market_code: market, trade_date: D, phase: 'INTRADAY', params: { reason: 'LIVE_POLL', live: live || undefined },
          dedupe_key: `COLLECT:${s.source}:${market}:${D}:INTRADAY:${key}` };
      }
    } else if (s.job_type === 'COLLECT_NIGHTLY') {
      if (hol || (st && st.state === 'HOLIDAY')) continue;
      const nkey = `COLLECT:${s.source}:${market}:${D}:NIGHTLY:${key}`;
      const seen = await pool.query(`SELECT id FROM collect_job WHERE dedupe_key = $1 OR (trade_date = $2 AND params->>'nightly_of' = $3) LIMIT 1`, [nkey, D, key]);
      if (seen.rows[0]) continue; // 이 슬롯은 이미 처리
      const act = await activeCollect(pool, { source: s.source, market, date: D, now });
      if (act) {
        // 같은 시각 중복 호출 방지 — 진행 중 작업을 01:00 배치 실행으로 기록(A 3절)
        await pool.query(`UPDATE collect_job SET params = params || jsonb_build_object('nightly_of', $2::text) WHERE id = $1`, [act.id, key]);
        planned.push({ id: act.id, job_type: 'COLLECT', trade_date: D, phase: act.phase, nightly_of: key, merged: true });
        continue;
      }
      const phase = st && ['SETTLED', 'CONFIRMED'].includes(st.state) ? 'FINAL' : 'INTRADAY';
      job = { job_type: 'COLLECT', source: s.source, market_code: market, trade_date: D, phase, params: { reason: 'NIGHTLY', live: true, nightly_of: key }, dedupe_key: nkey };
    } else if (s.job_type === 'COLLECT_WINDOW_END') {
      const w = await windowEnd(pool, { source: s.source, market, date: D, now });
      if (w && (w.state === 'NO_TRADE' || w.created)) planned.push({ id: w.job_id || null, job_type: 'WINDOW_END', trade_date: D, state: w.state });
      continue;
    } else if (s.job_type === 'COLLECT_FINAL') {
      if (st && ['CONFIRMED', 'HOLIDAY'].includes(st.state)) continue;
      if (st && st.state === 'NO_TRADE' && await hasFinalOk(pool, s.source, market, D)) continue; // 06:00 확인도 빈 응답 → EMPTY 경고 + 다음 날 11:00 재확인(기존)만
      if (!st && await hasFinalOk(pool, s.source, market, D)) continue; // 033 이전에 받은 날(하루 상태 없음)은 예전 기준
      job = { job_type: 'COLLECT', source: s.source, market_code: market, trade_date: D, phase: 'FINAL', params: { reason: 'CONFIRM' },
        dedupe_key: `COLLECT:${s.source}:${market}:${D}:FINAL:${key}` };
    } else if (s.job_type === 'SETTLE_VERIFY') {
      job = { job_type: 'SETTLE_VERIFY', source: 'AT_SETTLE', market_code: market, trade_date: yesterday, dedupe_key: `SETTLE_VERIFY:${market}:${yesterday}:${key}` };
    } else if (s.job_type === 'CODE_SYNC') {
      job = { job_type: 'CODE_SYNC', source: 'AT_CODE', dedupe_key: `CODE_SYNC:${key}` };
    } else if (s.job_type === 'PURGE_RAW') {
      job = { job_type: 'PURGE_RAW', dedupe_key: `PURGE_RAW:${key}` };
    }
    if (!job) continue;
    const r = await queue.enqueue(pool, job);
    /* eslint-enable no-await-in-loop */
    if (r.created) planned.push({ id: r.id, job_type: job.job_type, trade_date: job.trade_date || null, phase: job.phase || null, ...(job.params && job.params.reason ? { reason: job.params.reason } : {}) });
  }
  return planned;
}

/**
 * 누락 보정 — 최근 7일(+ 오늘 정산분) 중 마감 기준 시각(D 06:00)이 지났는데 확정 안 된 날을 FINAL 로 받는다
 *  - FINAL 정상 스냅샷(COMPLETE·EMPTY·HOLIDAY)이 없는 날(예전 기준) 또는 하루 상태가 아직 WAITING·LIVE·SETTLED 인 날(PC 가 06:00·11:00 에 꺼져 있던 날)
 *  - 같은 날짜 수집이 이미 돌고 있으면 넣지 않는다
 */
async function backfill(pool, now = new Date()) {
  const market = worker.marketCode();
  const days = Number(process.env.COLLECT_BACKFILL_DAYS || 7);
  const active = await pool.query(`SELECT 1 FROM collect_schedule WHERE job_type = 'COLLECT_FINAL' AND source = 'AT_REALTIME' AND active`);
  if (!active.rows[0]) return [];
  const base = worker.settleDateOf(now);
  const stamp = kstDateOf(new Date(now.getTime() + 9 * 3600 * 1000)).replace(/-/g, '');
  const out = [];
  for (let i = 0; i <= days; i += 1) {
    const d = worker.addDays(base, -i);
    if (now < worker.finalReadyAt(d)) continue;
    /* eslint-disable no-await-in-loop */
    const st = await worker.dayState(pool, { source: 'AT_REALTIME', market, date: d });
    const open = st && ['WAITING', 'LIVE', 'SETTLED'].includes(st.state);
    if (!open && await hasFinalOk(pool, 'AT_REALTIME', market, d)) continue;
    if (st && ['CONFIRMED', 'HOLIDAY'].includes(st.state)) continue;
    if (await activeCollect(pool, { source: 'AT_REALTIME', market, date: d, now })) continue;
    const r = await queue.enqueue(pool, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: market, trade_date: d, phase: 'FINAL',
      params: { reason: 'BACKFILL' }, dedupe_key: `COLLECT:AT_REALTIME:${market}:${d}:FINAL:BACKFILL:${stamp}` });
    /* eslint-enable no-await-in-loop */
    if (r.created) out.push({ id: r.id, trade_date: d });
  }
  return out;
}


/** 그 정산일의 다음 수집 예정 시각(UTC Date, R-96 next_run_at) — 하루 상태 때문에 건너뛸 슬롯은 뺀다. 없으면 null */
function nextRunFor(schedules, { date, state, now = new Date(), horizonMin = 36 * 60 }) {
  if (['CONFIRMED', 'HOLIDAY'].includes(state)) return null;
  const ps = (schedules || []).map((x) => ({ jt: x.job_type, f: parseCron(x.cron_text) }))
    .filter((x) => x.f && ['COLLECT_INTRADAY', 'COLLECT_NIGHTLY', 'COLLECT_FINAL'].includes(x.jt));
  const start = Math.floor((now.getTime() + 9 * 3600 * 1000) / 60000) * 60000;
  for (let i = 1; i <= horizonMin; i += 1) {
    const t = new Date(start + i * 60000);
    for (const p of ps) {
      if (!cronMatches(p.f, t)) continue;
      const at = new Date(t.getTime() - 9 * 3600 * 1000);
      if (worker.settleDateOf(at) !== date) continue;
      if (p.jt === 'COLLECT_INTRADAY' && DONE_STATES.includes(state)) continue;
      return at;
    }
  }
  return null;
}

/** 대기 작업 실행 — 최대 maxJobs 건, budgetMs 안에서. ids 를 주면 그 작업만(지금 받기) */
async function runBatch(pool, { maxJobs = 3, budgetMs = 25000, hooks = {}, types = null, ids = null } = {}) {
  const started = Date.now();
  const ran = [];
  while (ran.length < maxJobs && Date.now() - started < budgetMs) {
    // eslint-disable-next-line no-await-in-loop
    const job = await queue.claim(pool, { types, ids });
    if (!job) break;
    job.params = job.params || {};
    // eslint-disable-next-line no-await-in-loop
    const r = await worker.runJob(pool, job, hooks);
    ran.push({ id: Number(job.id), job_type: job.job_type, trade_date: job.trade_date || null, phase: job.phase || null, status: r.status, kind: r.kind || null, snapshot: r.snapshot || null,
      ...(r.day_state ? { day_state: r.day_state } : {}) });
  }
  return ran;
}

/** tick — hooks.now 로 시계 주입(테스트) */
async function tick(pool, { hooks = {}, maxJobs = 3, budgetMs = 25000, plan = true } = {}) {
  const started = Date.now();
  const now = worker.clockOf(hooks);
  const planned = plan ? await planDue(pool, now) : [];
  const filled = plan ? await backfill(pool, now) : [];
  const recovered = await queue.recoverStale(pool);
  const ran = await runBatch(pool, { maxJobs, budgetMs, hooks });
  return { planned: [...planned, ...filled], recovered: [...recovered], recovered_dead: recovered.dead || [], ran, elapsed_ms: Date.now() - started };
}

// 서버 안에서 수집을 한 번에 하나만 돌린다 — 내부 타이머와 "지금 받기" 즉시 실행이 같은 표시를 쓴다(겹쳐 돌지 않게)
let busy = false;
const isBusy = () => busy;
async function exclusive(fn) {
  if (busy) return { busy: true };
  busy = true;
  try { return await fn(); } finally { busy = false; }
}

/**
 * 지금 받기(R-98) 즉시 실행 — 응답을 보낸 뒤 부른다. 방금 넣은 작업(ids)만 돌린다(다른 대기 작업을 가로채지 않음).
 * 타이머가 돌고 있으면 2초 간격으로 최대 30회 기다렸다 다시 시도. 끝까지 못 돌리면 다음 tick 이 실행한다.
 * AUCTION_SYNC_RUN_NOW=false 면 끈다(예전처럼 다음 tick 에 실행).
 */
async function runNow(pool, ids, { hooks = {}, env = process.env, tries = 30 } = {}) {
  if (String(env.AUCTION_SYNC_RUN_NOW || 'true').toLowerCase() === 'false' || !ids || !ids.length) return { skipped: true };
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await exclusive(() => runBatch(pool, { maxJobs: ids.length, budgetMs: 120000, hooks, types: ['COLLECT'], ids }));
    if (!r || !r.busy) return { ran: r };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { busy: true };
}

/** 상시 호스트용 내부 타이머(COLLECT_TIMER_ENABLED=true) — 기본 5분. 창 10분 폴링을 놓치지 않게 COLLECT_TIMER_MS 는 10분 이하로 둔다 */
function startTimer(pool, hooks, env = process.env) {
  if (String(env.COLLECT_TIMER_ENABLED || '').toLowerCase() !== 'true') return null;
  const ms = Math.max(60000, Number(env.COLLECT_TIMER_MS || 300000));
  const h = setInterval(async () => {
    try { await exclusive(() => tick(pool, { hooks })); } catch (e) { console.error('[collect] timer tick error:', e.message); }
  }, ms);
  if (h.unref) h.unref();
  return h;
}

module.exports = { parseCron, cronMatches, latestSlot, planDue, backfill, runBatch, tick, startTimer, runNow, isBusy, exclusive, activeCollect, windowEnd, nextRunFor, slotKey, hasFinalOk, DONE_STATES };
