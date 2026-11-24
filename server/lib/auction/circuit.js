'use strict';
/**
 * T-203 서킷브레이커 — 상태는 DB(ext_circuit_state)에 둔다(재시작·여러 인스턴스가 같은 상태를 본다, D 4.4)
 *   CLOSED →(연속 실패 N=5)→ OPEN(next_probe_at = now + cooldown 10분) → 시각이 지나면 HALF_OPEN 1건 통과
 *   → 성공 CLOSED / 실패 OPEN(쿨다운 2배, 최대 1시간)
 *   AUTH_ERROR → disabled_reason AUTH_ERROR(사람이 해제할 때까지), QUOTA → disabled_until = 다음 날 00:10 KST
 *   연속 실패로 세는 것: TIMEOUT·SERVER_ERROR·RATE_LIMIT·BAD_RESPONSE (EMPTY 는 정상)
 */
const FAIL_KINDS = new Set(['TIMEOUT', 'SERVER_ERROR', 'RATE_LIMIT', 'BAD_RESPONSE']);

function threshold(env = process.env) {
  const n = parseInt(env.AUCTION_CIRCUIT_THRESHOLD || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 50 ? n : 5;
}
function baseCooldown(env = process.env) {
  const n = parseInt(env.AUCTION_CIRCUIT_COOLDOWN_SEC || '', 10);
  return Number.isFinite(n) && n >= 60 && n <= 3600 ? n : 600;
}

/** 다음 날 00:10 KST (UTC Date) */
function nextQuotaReset(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000);
  const next = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() + 1, 0, 10, 0) - 9 * 3600 * 1000;
  return new Date(next);
}

/**
 * 이 소스로 외부 호출을 해도 되나 — 한 줄 잠금 짧은 트랜잭션
 * @returns { allowed, state, retryAt?, reason? }
 */
async function allow(pool, source) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO ext_circuit_state (source) VALUES ($1) ON CONFLICT (source) DO NOTHING`, [source]);
    const r = await c.query(`SELECT * FROM ext_circuit_state WHERE source = $1 FOR UPDATE`, [source]);
    const s = r.rows[0];
    const now = new Date();
    let out;
    if (s.disabled_reason === 'AUTH_ERROR' || s.disabled_reason === 'MANUAL') {
      out = { allowed: false, state: s.state, reason: s.disabled_reason, retryAt: null };
    } else if (s.disabled_reason === 'QUOTA' && s.disabled_until && new Date(s.disabled_until) > now) {
      out = { allowed: false, state: s.state, reason: 'QUOTA', retryAt: new Date(s.disabled_until) };
    } else if (s.state === 'OPEN' && new Date(s.next_probe_at) > now) {
      out = { allowed: false, state: 'OPEN', reason: 'CIRCUIT_OPEN', retryAt: new Date(s.next_probe_at) };
    } else if (s.state === 'HALF_OPEN' && s.next_probe_at && new Date(s.next_probe_at) > now) {
      // 시험 1건이 이미 나가 있다 — 그 결과를 기다린다
      out = { allowed: false, state: 'HALF_OPEN', reason: 'CIRCUIT_OPEN', retryAt: new Date(s.next_probe_at) };
    } else {
      if (s.disabled_reason === 'QUOTA') {
        await c.query(`UPDATE ext_circuit_state SET disabled_reason = NULL, disabled_until = NULL, updated_at = NOW() WHERE source = $1`, [source]);
      }
      if (s.state === 'OPEN' || s.state === 'HALF_OPEN') {
        // 시험 1건 통과 — 그동안 다른 작업은 next_probe_at 까지 기다린다(2분 뒤 다시 봄)
        await c.query(`UPDATE ext_circuit_state SET state = 'HALF_OPEN', next_probe_at = NOW() + interval '2 minutes', updated_at = NOW() WHERE source = $1`, [source]);
        out = { allowed: true, state: 'HALF_OPEN' };
      } else out = { allowed: true, state: 'CLOSED' };
    }
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

async function success(pool, source) {
  await pool.query(
    `UPDATE ext_circuit_state SET state = 'CLOSED', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL,
            cooldown_sec = $2, last_error_kind = NULL, last_success_at = NOW(), updated_at = NOW()
      WHERE source = $1`,
    [source, baseCooldown()]
  );
}

/** 실패 기록 — kind 에 따라 연속 실패·OPEN·비활성 */
async function failure(pool, source, kind) {
  if (kind === 'AUTH_ERROR') {
    await pool.query(`UPDATE ext_circuit_state SET disabled_reason = 'AUTH_ERROR', disabled_until = NULL, last_error_kind = $2, updated_at = NOW() WHERE source = $1`, [source, kind]);
    return;
  }
  if (kind === 'QUOTA') {
    await pool.query(`UPDATE ext_circuit_state SET disabled_reason = 'QUOTA', disabled_until = $2, last_error_kind = $3, updated_at = NOW() WHERE source = $1`, [source, nextQuotaReset(), kind]);
    return;
  }
  if (!FAIL_KINDS.has(kind)) return;
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`SELECT * FROM ext_circuit_state WHERE source = $1 FOR UPDATE`, [source]);
    const s = r.rows[0];
    if (!s) { await c.query('ROLLBACK'); return; }
    const fails = s.consecutive_failures + 1;
    if (s.state === 'HALF_OPEN') {
      const cd = Math.min(s.cooldown_sec * 2, 3600);
      await c.query(
        `UPDATE ext_circuit_state SET state = 'OPEN', consecutive_failures = $2, opened_at = NOW(), cooldown_sec = $3,
                next_probe_at = NOW() + make_interval(secs => $3), last_error_kind = $4, updated_at = NOW() WHERE source = $1`,
        [source, fails, cd, kind]
      );
    } else if (fails >= threshold()) {
      const cd = baseCooldown();
      await c.query(
        `UPDATE ext_circuit_state SET state = 'OPEN', consecutive_failures = $2, opened_at = NOW(), cooldown_sec = $3,
                next_probe_at = NOW() + make_interval(secs => $3), last_error_kind = $4, updated_at = NOW() WHERE source = $1`,
        [source, fails, cd, kind]
      );
    } else {
      await c.query(`UPDATE ext_circuit_state SET consecutive_failures = $2, last_error_kind = $3, updated_at = NOW() WHERE source = $1`, [source, fails, kind]);
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/** 사람이 해제(AUTH_ERROR·MANUAL) — 관리자 수동 동기화 force 가 쓴다 */
async function reset(pool, source) {
  await pool.query(
    `UPDATE ext_circuit_state SET state = 'CLOSED', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL,
            disabled_reason = NULL, disabled_until = NULL, updated_at = NOW() WHERE source = $1`,
    [source]
  );
}

module.exports = { allow, success, failure, reset, nextQuotaReset, FAIL_KINDS, threshold, baseCooldown };
