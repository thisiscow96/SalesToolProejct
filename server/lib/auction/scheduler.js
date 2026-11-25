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
const kstDateOf = (kst) => kst.toISOString().slice(0, 10);

async function hasFinalOk(db, source, market, date) {
  const r = await db.query(
    `SELECT 1 FROM collect_snapshot WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND is_latest_ok AND (phase = 'FINAL' OR status = 'HOLIDAY') LIMIT 1`,
    [source, market, date]
  );
  return !!r.rows[0];
}

/** 슬롯대로 작업 넣기 */
async function planDue(pool, now = new Date()) {
  const market = worker.marketCode();
  const sch = await pool.query(`SELECT job_type, source, cron_text FROM collect_schedule WHERE active`);
  const planned = [];
  for (const s of sch.rows) {
    const fields = parseCron(s.cron_text);
    if (!fields) continue;
    const slot = latestSlot(fields, now);
    if (!slot) continue;
    const key = slotKey(slot);
    const today = kstDateOf(slot);
    const yesterday = worker.addDays(today, -1);
    let job = null;
    if (s.job_type === 'COLLECT_INTRADAY') {
      job = { job_type: 'COLLECT', source: s.source, market_code: market, trade_date: today, phase: 'INTRADAY', dedupe_key: `COLLECT:${s.source}:${market}:${today}:INTRADAY:${key}` };
    } else if (s.job_type === 'COLLECT_FINAL') {
      // eslint-disable-next-line no-await-in-loop
      if (await hasFinalOk(pool, s.source, market, yesterday)) continue;
      job = { job_type: 'COLLECT', source: s.source, market_code: market, trade_date: yesterday, phase: 'FINAL', dedupe_key: `COLLECT:${s.source}:${market}:${yesterday}:FINAL:${key}` };
    } else if (s.job_type === 'SETTLE_VERIFY') {
      job = { job_type: 'SETTLE_VERIFY', source: 'AT_SETTLE', market_code: market, trade_date: yesterday, dedupe_key: `SETTLE_VERIFY:${market}:${yesterday}:${key}` };
    } else if (s.job_type === 'CODE_SYNC') {
      job = { job_type: 'CODE_SYNC', source: 'AT_CODE', dedupe_key: `CODE_SYNC:${key}` };
    } else if (s.job_type === 'PURGE_RAW') {
      job = { job_type: 'PURGE_RAW', dedupe_key: `PURGE_RAW:${key}` };
    }
    if (!job) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await queue.enqueue(pool, job);
    if (r.created) planned.push({ id: r.id, job_type: job.job_type, trade_date: job.trade_date || null, phase: job.phase || null });
  }
  return planned;
}

/** 누락 보정 — 최근 7일 중 FINAL 정상 스냅샷(COMPLETE·EMPTY·HOLIDAY)이 없는 날(어제는 마감 기준 시각 뒤에만) */
async function backfill(pool, now = new Date()) {
  const market = worker.marketCode();
  const days = Number(process.env.COLLECT_BACKFILL_DAYS || 7);
  const active = await pool.query(`SELECT 1 FROM collect_schedule WHERE job_type = 'COLLECT_FINAL' AND source = 'AT_REALTIME' AND active`);
  if (!active.rows[0]) return [];
  const today = new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const stamp = today.replace(/-/g, '');
  const out = [];
  for (let i = 1; i <= days; i += 1) {
    const d = worker.addDays(today, -i);
    if (now < worker.finalReadyAt(d)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await hasFinalOk(pool, 'AT_REALTIME', market, d)) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await queue.enqueue(pool, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: market, trade_date: d, phase: 'FINAL',
      params: { reason: 'BACKFILL' }, dedupe_key: `COLLECT:AT_REALTIME:${market}:${d}:FINAL:BACKFILL:${stamp}` });
    if (r.created) out.push({ id: r.id, trade_date: d });
  }
  return out;
}

/** 대기 작업 실행 — 최대 maxJobs 건, budgetMs 안에서 */
async function runBatch(pool, { maxJobs = 3, budgetMs = 25000, hooks = {}, types = null } = {}) {
  const started = Date.now();
  const ran = [];
  while (ran.length < maxJobs && Date.now() - started < budgetMs) {
    // eslint-disable-next-line no-await-in-loop
    const job = await queue.claim(pool, { types });
    if (!job) break;
    job.params = job.params || {};
    // eslint-disable-next-line no-await-in-loop
    const r = await worker.runJob(pool, job, hooks);
    ran.push({ id: Number(job.id), job_type: job.job_type, trade_date: job.trade_date || null, status: r.status, kind: r.kind || null, snapshot: r.snapshot || null });
  }
  return ran;
}

async function tick(pool, { hooks = {}, maxJobs = 3, budgetMs = 25000, plan = true } = {}) {
  const started = Date.now();
  const planned = plan ? await planDue(pool) : [];
  const filled = plan ? await backfill(pool) : [];
  const recovered = await queue.recoverStale(pool);
  const ran = await runBatch(pool, { maxJobs, budgetMs, hooks });
  return { planned: [...planned, ...filled], recovered, ran, elapsed_ms: Date.now() - started };
}

/** 상시 호스트용 내부 타이머(COLLECT_TIMER_ENABLED=true) — 5분 */
function startTimer(pool, hooks, env = process.env) {
  if (String(env.COLLECT_TIMER_ENABLED || '').toLowerCase() !== 'true') return null;
  const ms = Math.max(60000, Number(env.COLLECT_TIMER_MS || 300000));
  let busy = false;
  const h = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(pool, { hooks }); } catch (e) { console.error('[collect] timer tick error:', e.message); } finally { busy = false; }
  }, ms);
  if (h.unref) h.unref();
  return h;
}

module.exports = { parseCron, cronMatches, latestSlot, planDue, backfill, runBatch, tick, startTimer, slotKey };
