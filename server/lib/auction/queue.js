'use strict';
/**
 * T-203 Postgres 작업 큐 (collect_job, D 3.3·3.4·4.2)
 *  - enqueue: dedupe_key 전체 유일 → ON CONFLICT DO NOTHING (cron·타이머·수동이 겹쳐도 1건)
 *  - claim: FOR UPDATE SKIP LOCKED (여러 인스턴스·tick 이 동시에 돌아도 한 작업은 한 곳만)
 *  - 재시도: run_after = now + min(60초 × 2^(attempts−1), 30분) × 0.8~1.2, 최대 5회 → DEAD
 *  - 회수: RUNNING 인데 locked_at 10분 넘음 → QUEUED(attempts 유지)
 */
const os = require('os');

const INSTANCE = `${os.hostname()}:${process.pid}`.slice(0, 60);

/** 백오프(초) — attempts 는 이번까지 시도한 횟수(1부터). rand 는 테스트용 주입 */
function backoffSec(attempts, rand = Math.random) {
  const base = Math.min(60 * 2 ** Math.max(0, attempts - 1), 1800);
  const jitter = 0.8 + rand() * 0.4;
  return Math.round(base * jitter);
}

function staleMinutes(env = process.env) {
  const n = parseInt(env.COLLECT_STALE_MINUTES || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 120 ? n : 10;
}

/**
 * @param job { job_type, source, market_code, trade_date, phase, params, dedupe_key, run_after, requested_by_user_id, requested_by_staff_id, max_attempts }
 * @returns { id, created:boolean }
 */
async function enqueue(db, job) {
  const r = await db.query(
    `INSERT INTO collect_job (job_type, source, market_code, trade_date, phase, params, dedupe_key, run_after, max_attempts,
                              requested_by, requested_by_user_id, requested_by_staff_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, COALESCE($8::timestamptz, NOW()), COALESCE($9, 5),
             CASE WHEN $10::int IS NULL THEN 'SYSTEM' ELSE 'USER' END, $10, $11)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
    [job.job_type, job.source || null, job.market_code || null, job.trade_date || null, job.phase || null, JSON.stringify(job.params || {}),
      String(job.dedupe_key).slice(0, 120), job.run_after || null, job.max_attempts || null, job.requested_by_user_id || null, job.requested_by_staff_id || null]
  );
  if (r.rows[0]) return { id: Number(r.rows[0].id), created: true };
  const ex = await db.query(`SELECT id, status FROM collect_job WHERE dedupe_key = $1`, [String(job.dedupe_key).slice(0, 120)]);
  return { id: ex.rows[0] ? Number(ex.rows[0].id) : null, created: false, status: ex.rows[0] && ex.rows[0].status };
}

/** 실행할 작업 하나 가져오기 — 짧은 트랜잭션 */
async function claim(pool, { types = null } = {}) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(
      `SELECT id FROM collect_job
        WHERE status = 'QUEUED' AND run_after <= NOW() AND ($1::text[] IS NULL OR job_type = ANY($1::text[]))
        ORDER BY run_after, id
        FOR UPDATE SKIP LOCKED LIMIT 1`,
      [types]
    );
    if (!r.rows[0]) { await c.query('COMMIT'); return null; }
    const u = await c.query(
      `UPDATE collect_job SET status = 'RUNNING', locked_by = $2, locked_at = NOW(), attempts = attempts + 1,
              started_at = COALESCE(started_at, NOW())
        WHERE id = $1 RETURNING *`,
      [r.rows[0].id, INSTANCE]
    );
    await c.query('COMMIT');
    return u.rows[0];
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/**
 * 끝내기 — 이 인스턴스가 잡고 있는 RUNNING 일 때만 상태를 바꾼다(I 검토 D-06).
 *   회수(recoverStale)로 이미 QUEUED·DEAD 가 됐거나 다른 인스턴스가 다시 잡은 작업이면 0행 → 경고만 남기고 넘어감(옛 실행이 상태를 덮어쓰지 않게)
 */
async function finish(db, id, { status = 'DONE', result = {}, error = null, errorKind = null, lockedBy = INSTANCE }) {
  const r = await db.query(
    `UPDATE collect_job SET status = $2, result = $3::jsonb, last_error = $4, last_error_kind = $5, finished_at = NOW(), locked_by = NULL, locked_at = NULL
      WHERE id = $1 AND status = 'RUNNING' AND locked_by = $6`,
    [id, status, JSON.stringify(result || {}), error ? String(error).slice(0, 500) : null, errorKind, lockedBy]
  );
  if (!r.rowCount) console.warn(`[collect-queue] finish 무시: 작업 #${id} 은 이미 회수됐거나 다른 실행이 잡고 있음(${status})`);
  return r.rowCount > 0;
}

/** 다시 대기열로 — at(Date) 이 있으면 그 시각, 없으면 백오프. keepAttempt=false 면 이번 시도는 세지 않음(서킷·잠금으로 못 돌린 경우) */
async function requeue(db, job, { at = null, error = null, errorKind = null, keepAttempt = true, result = null }) {
  const runAfter = at || new Date(Date.now() + backoffSec(job.attempts) * 1000);
  const r = await db.query(
    `UPDATE collect_job SET status = 'QUEUED', run_after = $2, locked_by = NULL, locked_at = NULL,
            attempts = CASE WHEN $3 THEN attempts ELSE GREATEST(attempts - 1, 0) END,
            last_error = COALESCE($4, last_error), last_error_kind = COALESCE($5, last_error_kind),
            result = COALESCE($6::jsonb, result)
      WHERE id = $1 AND status = 'RUNNING' AND locked_by = $7`,
    [job.id, runAfter, keepAttempt, error ? String(error).slice(0, 500) : null, errorKind, result ? JSON.stringify(result) : null, job.locked_by || INSTANCE]
  );
  if (!r.rowCount) console.warn(`[collect-queue] requeue 무시: 작업 #${job.id} 은 이미 회수됐거나 다른 실행이 잡고 있음`);
  return runAfter;
}

/**
 * 멈춘 RUNNING 회수 — 최대 시도에 닿은 작업은 DEAD(finished_at 함께, CHECK collect_job_finished_match), 나머지는 QUEUED (I 검토 D-05)
 * @returns 다시 대기열로 간 작업 id 배열(기존 형식 그대로). 배열의 .dead 에 DEAD 로 끝낸 id
 */
async function recoverStale(db) {
  const r = await db.query(
    `UPDATE collect_job
        SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
            finished_at = CASE WHEN attempts >= max_attempts THEN NOW() END,
            locked_by = NULL, locked_at = NULL, run_after = NOW(),
            last_error = CASE WHEN attempts >= max_attempts THEN '실행 중 멈춤 — 최대 시도 도달로 중단' ELSE COALESCE(last_error, '실행 중 멈춤 — 회수') END,
            last_error_kind = CASE WHEN attempts >= max_attempts THEN 'STALE' ELSE COALESCE(last_error_kind, 'STALE') END
      WHERE status = 'RUNNING' AND locked_at < NOW() - make_interval(mins => $1)
      RETURNING id, status`,
    [staleMinutes()]
  );
  const ids = r.rows.filter((x) => x.status === 'QUEUED').map((x) => Number(x.id));
  ids.dead = r.rows.filter((x) => x.status === 'DEAD').map((x) => Number(x.id));
  return ids;
}

module.exports = { enqueue, claim, finish, requeue, recoverStale, backoffSec, INSTANCE, staleMinutes };
