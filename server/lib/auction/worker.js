'use strict';
/**
 * T-203 수집 워커 — 작업 하나 실행 (D 3.4·4.3·5.x)
 *
 * COLLECT(AT_REALTIME · GARAK_PRICE):
 *   서킷 확인 → 휴장일이면 HOLIDAY → 수집 트랜잭션(pg_try_advisory_xact_lock 날짜·소스) → 스냅샷 RUNNING
 *   → 페이지마다 원천 로그(별도 연결 — 롤백돼도 남음) → 오류면 전체 ROLLBACK(반쪽 데이터 없음) 후 kind 별 재시도
 *   → 정규화·upsert → fetched = total 확인(중간에 totalCount 가 바뀌면 처음부터 1회 다시, 그래도 다르면 PARTIAL)
 *   → FINAL 이면 사라진 건 withdrawn_at → 스냅샷 COMPLETE/PARTIAL, is_latest_ok → COMMIT → FINAL·COMPLETE 면 REMATCH 작업
 * 빈 응답: 휴장 HOLIDAY / 마감 기준 시각 전 NOT_YET(다음 슬롯 재수집 예약) / 그 밖 EMPTY(경고, 다음 날 1회 재확인)
 *
 * 스냅샷·작업의 source 는 논리 소스(AT_REALTIME 등). 목업으로 돌면 경락 행·원천 로그의 source 가 'MOCK'(자동 전환 제외 표시).
 */
const crypto = require('crypto');
const { createAdapter, secretValues } = require('./adapters');
const circuit = require('./circuit');
const queue = require('./queue');
const norm = require('./normalizer');
const N = require('../purchase-match/normalize');
const { scrubSecrets } = require('./mask');

const MAX_PAGES = 200;
const MAX_BODY = 1024 * 1024;

const kstNow = () => new Date(Date.now() + 9 * 3600 * 1000);
const kstToday = () => kstNow().toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** KST 날짜·시각 → UTC Date */
const kstAt = (ymd, h, m = 0) => new Date(Date.parse(`${ymd}T00:00:00Z`) + (h * 60 + m) * 60000 - 9 * 3600 * 1000);

function pageSize(env = process.env) {
  const n = parseInt(env.AUCTION_PAGE_SIZE || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 10000 ? n : 1000;
}
/** 확정(FINAL) 마감 기준 시각 — 거래일 다음 날 10:00 KST [가정] */
function finalReadyAt(tradeDate, env = process.env) {
  const h = parseInt(env.AUCTION_FINAL_READY_HOUR || '', 10);
  return kstAt(addDays(tradeDate, 1), Number.isFinite(h) && h >= 0 && h <= 23 ? h : 10);
}
const marketCode = (env = process.env) => env.AUCTION_MARKET_CODE || '110001';

/** 목업 시나리오 주입은 목업 모드 + 테스트 DB(AUCTION_MOCK_CONTROL=true)에서만 */
function mockScenarioOf(job, env = process.env) {
  if (env.NODE_ENV === 'production' || String(env.AUCTION_MOCK_CONTROL || '').toLowerCase() !== 'true') return undefined;
  const s = job.params && job.params.mock_scenario;
  return s ? String(s).slice(0, 200) : undefined;
}

/** 원천 로그 — 별도 연결(수집 트랜잭션이 롤백돼도 남는다). 본문 1MB 넘으면 앞부분 + 전체 해시 */
async function logRaw(pool, job, effSource, r) {
  const body = r.rawBody || '';
  const truncated = Buffer.byteLength(body, 'utf8') > MAX_BODY;
  const stored = truncated ? body.slice(0, MAX_BODY / 2) : body;
  const ins = await pool.query(
    `INSERT INTO ext_raw_response (job_id, source, request_url_masked, request_params, page_no, http_status, kind, body, body_truncated, body_hash, row_count, duration_ms)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [job.id, effSource, scrubSecrets(r.requestUrlMasked, secretValues()), JSON.stringify(r.requestParams || {}), r.pageNo || null, r.httpStatus || null,
      r.kind, stored, truncated, crypto.createHash('sha256').update(body).digest('hex'), (r.items || []).length, r.durationMs ?? null]
  );
  return Number(ins.rows[0].id);
}

async function isHoliday(db, market, date) {
  const r = await db.query(`SELECT kind FROM market_calendar WHERE market_code = $1 AND cal_date = $2 AND kind = 'HOLIDAY'`, [market, date]);
  return !!r.rows[0];
}

/** 스냅샷 하나를 정상(is_latest_ok)으로 — 같은 날짜·소스의 이전 정상 표시는 내림. INTRADAY 는 FINAL 정상 표시를 빼앗지 않는다 */
async function markLatestOk(client, snap) {
  if (snap.phase === 'INTRADAY') {
    const f = await client.query(
      `SELECT 1 FROM collect_snapshot WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND is_latest_ok AND phase = 'FINAL' AND id <> $4`,
      [snap.source, snap.market_code, snap.trade_date, snap.id]
    );
    if (f.rows[0]) return false;
  }
  await client.query(`UPDATE collect_snapshot SET is_latest_ok = false WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND is_latest_ok AND id <> $4`,
    [snap.source, snap.market_code, snap.trade_date, snap.id]);
  await client.query(`UPDATE collect_snapshot SET is_latest_ok = true WHERE id = $1`, [snap.id]);
  return true;
}

/** 실패 스냅샷(롤백 뒤 별도 기록 — 수집 현황에 보이게) */
async function recordFailedSnapshot(pool, job, info) {
  await pool.query(
    `INSERT INTO collect_snapshot (source, market_code, trade_date, phase, job_id, status, pages, error_kind, error_message, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
    [job.source, job.market_code, job.trade_date, job.phase, job.id, info.status || 'FAILED', info.pages || 0, info.kind || null,
      info.message ? scrubSecrets(info.message, secretValues()).slice(0, 500) : null]
  );
}

/** 오류 kind → 작업 처리(D 4.3) */
async function handleFailure(pool, job, kind, message, retryAfterSec) {
  const msg = scrubSecrets(message || kind, secretValues()).slice(0, 500);
  await circuit.failure(pool, job.source, kind);
  if (kind === 'AUTH_ERROR') {
    await queue.finish(pool, job.id, { status: 'FAILED', error: `인증 오류 — API 키 확인 필요(${msg})`, errorKind: kind });
    return { status: 'FAILED', kind };
  }
  if (kind === 'QUOTA') {
    const at = circuit.nextQuotaReset();
    await queue.requeue(pool, job, { at, error: `일 호출 한도 초과(${msg})`, errorKind: kind, keepAttempt: false });
    return { status: 'QUEUED', kind, run_after: at };
  }
  if (kind === 'BAD_RESPONSE' && job.attempts >= 2) {
    await queue.finish(pool, job.id, { status: 'FAILED', error: msg, errorKind: kind });
    return { status: 'FAILED', kind };
  }
  if (job.attempts >= job.max_attempts) {
    await queue.finish(pool, job.id, { status: 'DEAD', error: msg, errorKind: kind });
    return { status: 'DEAD', kind };
  }
  let at = new Date(Date.now() + queue.backoffSec(job.attempts) * 1000);
  if (kind === 'RATE_LIMIT' && retryAfterSec != null) {
    const ra = new Date(Date.now() + retryAfterSec * 1000);
    if (ra > at) at = ra;
  }
  await queue.requeue(pool, job, { at, error: msg, errorKind: kind });
  return { status: 'QUEUED', kind, run_after: at };
}

/** 페이지 전부 받기(트랜잭션 밖 — 외부 호출 동안 DB 트랜잭션을 길게 잡지 않음). 실패하면 { error } */
async function fetchAll(pool, job, adapter, effSource) {
  const size = pageSize();
  for (let round = 1; round <= 2; round += 1) {
    const items = [];
    const rawIds = [];
    let total = null;
    let changed = false;
    let pages = 0;
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await adapter.fetchPage({ tradeDate: job.trade_date, marketCode: job.market_code, pageNo, numOfRows: size, ...(job.params.filter || {}) });
      // eslint-disable-next-line no-await-in-loop
      const rawId = await logRaw(pool, job, effSource, r);
      rawIds.push(rawId);
      pages = pageNo;
      if (r.kind === 'EMPTY' && pageNo === 1) return { empty: true, rawIds, pages };
      if (r.kind !== 'OK' && r.kind !== 'EMPTY') return { error: r.kind, message: r.message, retryAfterSec: r.retryAfterSec, rawIds, pages };
      if (total == null) total = r.totalCount;
      else if (r.totalCount !== total) { changed = true; break; }
      items.push(...r.items);
      if (!r.items.length || items.length >= total) break;
      if (pageNo === MAX_PAGES) return { items, total, rawIds, pages, partial: true, note: `최대 ${MAX_PAGES}쪽에서 멈춤` };
    }
    if (!changed && items.length === total) return { items, total, rawIds, pages };
    if (round === 2) return { items, total, rawIds, pages, partial: true, note: changed ? '수집 중 전체 건수가 바뀜' : `받은 건수 ${items.length} ≠ 전체 ${total}` };
  }
  return { error: 'BAD_RESPONSE', message: 'unreachable' };
}

async function runCollect(pool, job, hooks) {
  const scenario = mockScenarioOf(job);
  const adapter = createAdapter(job.source, { scenario });
  const effSource = adapter.mode === 'MOCK' ? 'MOCK' : job.source;
  const result = { source_mode: adapter.mode };

  if (job.source === 'AT_REALTIME' && await isHoliday(pool, job.market_code, job.trade_date)) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const s = await c.query(
        `INSERT INTO collect_snapshot (source, market_code, trade_date, phase, job_id, status, finished_at) VALUES ($1,$2,$3,$4,$5,'HOLIDAY',NOW()) RETURNING *`,
        [job.source, job.market_code, job.trade_date, job.phase, job.id]
      );
      await markLatestOk(c, s.rows[0]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    await queue.finish(pool, job.id, { status: 'DONE', result: { ...result, snapshot: 'HOLIDAY' } });
    return { status: 'DONE', snapshot: 'HOLIDAY' };
  }

  const gate = await circuit.allow(pool, job.source);
  if (!gate.allowed) {
    if (gate.reason === 'AUTH_ERROR' || gate.reason === 'MANUAL') {
      await queue.finish(pool, job.id, { status: 'FAILED', error: '소스가 꺼져 있음(API 키 확인 필요)', errorKind: 'AUTH_ERROR' });
      return { status: 'FAILED', kind: 'AUTH_ERROR' };
    }
    await queue.requeue(pool, job, { at: gate.retryAt, error: gate.reason === 'QUOTA' ? '일 호출 한도 초과 — 다음 날 재개' : '서킷 OPEN — 외부 호출 멈춤', errorKind: gate.reason, keepAttempt: false });
    return { status: 'QUEUED', kind: gate.reason, run_after: gate.retryAt };
  }

  const fetched = await fetchAll(pool, job, adapter, effSource);
  if (fetched.error) {
    await recordFailedSnapshot(pool, job, { kind: fetched.error, message: fetched.message, pages: fetched.pages });
    return handleFailure(pool, job, fetched.error, fetched.message, fetched.retryAfterSec);
  }

  if (job.source === 'GARAK_PRICE') return runGarakStore(pool, job, adapter, effSource, fetched, result);

  // 정규화(전부 검사 — 한 건이라도 형식 오류면 그 작업은 저장 0건)
  const ctx = await norm.loadMappingContext(pool, { target: 'MARKET', on: job.trade_date });
  const n = fetched.empty ? { rows: [], errors: [] } : norm.normalizeItems(ctx, adapter, fetched.items, { source: effSource, marketCode: job.market_code });
  if (n.errors.length) {
    const msg = `응답 형식 이상 ${n.errors.length}건: ${n.errors.slice(0, 3).map((e) => `${e.idx + 1}번째 ${e.message}`).join(' / ')}`;
    await recordFailedSnapshot(pool, job, { kind: 'BAD_RESPONSE', message: msg, pages: fetched.pages });
    return handleFailure(pool, job, 'BAD_RESPONSE', msg, null);
  }
  // 같은 키가 한 응답 안에 두 번(페이지 경계 중복) — 마지막 값
  const byKey = new Map();
  for (const r of n.rows) byKey.set(r.source_row_key, r);
  const rows = [...byKey.values()];

  const client = await pool.connect();
  let snap;
  let changedTrades = [];
  try {
    await client.query('BEGIN');
    const lk = await client.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok`, [`collect:${job.source}:${job.market_code}:${job.trade_date}`]);
    if (!lk.rows[0].ok) {
      await client.query('ROLLBACK');
      await queue.requeue(pool, job, { at: new Date(Date.now() + 60000), error: '같은 날짜 수집이 진행 중', errorKind: 'LOCKED', keepAttempt: false });
      return { status: 'QUEUED', kind: 'LOCKED' };
    }
    let status;
    if (fetched.empty) {
      if (new Date() < finalReadyAt(job.trade_date) && (job.phase === 'FINAL' || job.trade_date >= kstToday())) status = 'NOT_YET';
      else if (job.phase === 'INTRADAY' && job.trade_date >= kstToday()) status = 'NOT_YET';
      else status = 'EMPTY';
    } else status = fetched.partial ? 'PARTIAL' : 'COMPLETE';
    const s = await client.query(
      `INSERT INTO collect_snapshot (source, market_code, trade_date, phase, job_id, status, total_count, fetched_count, pages, started_at)
       VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7,$8,NOW()) RETURNING *`,
      [job.source, job.market_code, job.trade_date, job.phase, job.id, fetched.total || 0, fetched.items ? fetched.items.length : 0, fetched.pages || 0]
    );
    snap = s.rows[0];
    const lastRaw = fetched.rawIds[fetched.rawIds.length - 1] || null;
    const up = await norm.upsertTrades(client, rows, { snapshotId: snap.id, rawRef: lastRaw });
    let withdrawn = [];
    if (job.phase === 'FINAL' && status === 'COMPLETE') withdrawn = await norm.markWithdrawn(client, { source: effSource, marketCode: job.market_code, tradeDate: job.trade_date });
    changedTrades = [...up.changedIds, ...withdrawn];
    const flagged = await norm.flagRevisedConversions(client, changedTrades);
    const contentHash = crypto.createHash('sha256').update(rows.map((r) => r.content_hash).sort().join('')).digest('hex');
    await client.query(
      `UPDATE collect_snapshot SET status = $2, inserted = $3, updated = $4, unchanged = $5, unmapped = $6, withdrawn = $7, content_hash = $8,
              verify_warning = $9, finished_at = NOW() WHERE id = $1`,
      [snap.id, status, up.inserted, up.updated, up.unchanged, up.unmapped, withdrawn.length, contentHash, fetched.note || (status === 'EMPTY' ? '데이터 없음 — 확인 필요(휴장 미등록?)' : null)]
    );
    snap.status = status;
    let latest = false;
    if (['COMPLETE', 'EMPTY', 'HOLIDAY'].includes(status)) latest = await markLatestOk(client, snap);
    Object.assign(result, { snapshot_id: Number(snap.id), snapshot: status, latest_ok: latest, total: fetched.total || 0, fetched: rows.length,
      inserted: up.inserted, updated: up.updated, unchanged: up.unchanged, unmapped: up.unmapped, withdrawn: withdrawn.length, revised_flagged: flagged, pages: fetched.pages });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await recordFailedSnapshot(pool, job, { kind: 'SERVER_ERROR', message: `저장 실패: ${err.message}` });
    throw err;
  } finally {
    client.release();
  }
  await circuit.success(pool, job.source);
  await queue.finish(pool, job.id, { status: 'DONE', result });

  // 다음 할 일 — 빈 응답 재확인·FINAL 뒤 자동 재대조
  if (snap.status === 'NOT_YET') {
    const at = new Date(Date.now() + 3600 * 1000);
    const slot = new Date(at.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 13).replace(/[-T]/g, '');
    await queue.enqueue(pool, { job_type: 'COLLECT', source: job.source, market_code: job.market_code, trade_date: job.trade_date, phase: job.phase,
      params: job.params, dedupe_key: `COLLECT:${job.source}:${job.market_code}:${job.trade_date}:${job.phase}:NOTYET:${slot}`, run_after: at });
  } else if (snap.status === 'EMPTY' && !job.params.recheck) {
    await queue.enqueue(pool, { job_type: 'COLLECT', source: job.source, market_code: job.market_code, trade_date: job.trade_date, phase: 'FINAL',
      params: { ...job.params, recheck: true }, dedupe_key: `COLLECT:${job.source}:${job.market_code}:${job.trade_date}:FINAL:RECHECK`,
      run_after: kstAt(addDays(kstToday(), 1), 11) });
  }
  if (job.phase === 'FINAL' && snap.status === 'COMPLETE' && result.latest_ok) {
    await queue.enqueue(pool, { job_type: 'REMATCH', source: job.source, market_code: job.market_code, trade_date: job.trade_date,
      params: { reason: 'FINAL_COMPLETE', snapshot_id: Number(snap.id) }, dedupe_key: `REMATCH:${job.source}:${job.trade_date}:${snap.id}` });
  }
  if (hooks && hooks.afterCollect) await hooks.afterCollect(job, result).catch(() => {});
  return { status: 'DONE', ...result };
}

/** 가락 주요품목 가격(참고 시세) 저장 */
async function runGarakStore(pool, job, adapter, effSource, fetched, result) {
  const ctx = await norm.loadMappingContext(pool, { target: 'MARKET', on: job.trade_date });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query(
      `INSERT INTO collect_snapshot (source, market_code, trade_date, phase, job_id, status, total_count, fetched_count, pages, finished_at)
       VALUES ('GARAK_PRICE', $1, $2, $3, $4, $5, $6, $6, $7, NOW()) RETURNING *`,
      [job.market_code, job.trade_date, job.phase, job.id, fetched.empty ? 'EMPTY' : 'COMPLETE', (fetched.items || []).length, fetched.pages || 0]
    );
    let saved = 0;
    for (const raw of fetched.items || []) {
      const f = adapter.toNormalized(raw);
      const won = N.readWon(f.avg_price);
      const prev = N.readWon(f.prev_price);
      const itemKey = norm.mapItem(ctx, { source: 'GARAK_PRICE', name: f.item_name_raw });
      const kg = N.parseSpec(f.unit_name).kg || (f.unit_qty && /^\d+(\.\d+)?$/.test(f.unit_qty) ? N.decimalDiv(f.unit_qty, 1, 3) : null);
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO market_price_daily (source, price_date, item_name_raw, item_key, grade_name, grade_norm, unit_name, unit_qty_kg, avg_price, prev_price, snapshot_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (source, price_date, item_name_raw, grade_name, unit_name) DO UPDATE SET
           item_key = EXCLUDED.item_key, grade_norm = EXCLUDED.grade_norm, unit_qty_kg = EXCLUDED.unit_qty_kg,
           avg_price = EXCLUDED.avg_price, prev_price = EXCLUDED.prev_price, snapshot_id = EXCLUDED.snapshot_id, updated_at = NOW()`,
        [effSource === 'MOCK' ? 'MOCK' : 'GARAK_PRICE', job.trade_date, f.item_name_raw || '', itemKey, f.grade_name || '', N.normalizeGrade(f.grade_name, ctx.grades),
          f.unit_name || '', kg, won.value, prev.value, s.rows[0].id]
      );
      saved += 1;
    }
    if (!fetched.empty) await markLatestOk(client, s.rows[0]);
    await client.query('COMMIT');
    Object.assign(result, { snapshot_id: Number(s.rows[0].id), saved });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await circuit.success(pool, job.source);
  await queue.finish(pool, job.id, { status: 'DONE', result });
  return { status: 'DONE', ...result };
}

/** 정산정보로 누락 검증 — 법인·소분류별 거래물량 합 비교, 차이 > 2% 면 FINAL 스냅샷 경고 + 재수집 1회 */
async function runSettleVerify(pool, job) {
  const adapter = createAdapter('AT_SETTLE', { scenario: mockScenarioOf(job) });
  const gate = await circuit.allow(pool, 'AT_SETTLE');
  if (!gate.allowed) {
    await queue.requeue(pool, job, { at: gate.retryAt || new Date(Date.now() + 3600000), errorKind: gate.reason, keepAttempt: false });
    return { status: 'QUEUED', kind: gate.reason };
  }
  const f = await fetchAll(pool, { ...job, source: 'AT_SETTLE' }, adapter, adapter.mode === 'MOCK' ? 'MOCK' : 'AT_SETTLE');
  if (f.error) {
    return handleFailure(pool, { ...job, source: 'AT_SETTLE' }, f.error, f.message, f.retryAfterSec);
  }
  await circuit.success(pool, 'AT_SETTLE');
  const settle = new Map();
  for (const raw of f.items || []) {
    const x = adapter.toNormalized(raw);
    const k = `${x.corp_code}|${x.item_s_code}|${x.item_m_code}`;
    settle.set(k, (settle.get(k) || 0) + Number(x.trade_qty || 0));
  }
  const eff = adapter.mode === 'MOCK' ? 'MOCK' : 'AT_REALTIME';
  const t = await pool.query(
    `SELECT corp_code, item_s_code, item_m_code, SUM(qty)::text AS q FROM auction_trade
      WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND withdrawn_at IS NULL GROUP BY 1,2,3`,
    [eff, job.market_code || marketCode(), job.trade_date]
  );
  const mine = new Map(t.rows.map((r) => [`${r.corp_code}|${r.item_s_code}|${r.item_m_code}`, Number(r.q)]));
  const pct = Number(process.env.SETTLE_VERIFY_PCT || 2);
  const diffs = [];
  for (const [k, q] of settle) {
    const m = mine.get(k) || 0;
    if (q > 0 && (Math.abs(q - m) / q) * 100 > pct) diffs.push({ key: k, settle: q, realtime: m });
  }
  let warning = null;
  if (diffs.length) {
    warning = `정산정보 대비 거래물량 차이 ${diffs.length}건(>${pct}%): ${diffs.slice(0, 3).map((d) => `${d.key} ${d.realtime}/${d.settle}`).join(', ')}`.slice(0, 900);
    await pool.query(
      `UPDATE collect_snapshot SET verify_warning = $3 WHERE source = 'AT_REALTIME' AND market_code = $1 AND trade_date = $2 AND phase = 'FINAL' AND is_latest_ok`,
      [job.market_code || marketCode(), job.trade_date, warning]
    );
    await queue.enqueue(pool, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: job.market_code || marketCode(), trade_date: job.trade_date, phase: 'FINAL',
      params: { reason: 'SETTLE_VERIFY' }, dedupe_key: `COLLECT:AT_REALTIME:${job.market_code || marketCode()}:${job.trade_date}:FINAL:VERIFY` });
  }
  const result = { compared: settle.size, diffs: diffs.length, warning };
  await queue.finish(pool, job.id, { status: 'DONE', result });
  return { status: 'DONE', ...result };
}

/** 표준코드 → code_master (품목 대·중·소) */
async function runCodeSync(pool, job) {
  const adapter = createAdapter('AT_CODE', { scenario: mockScenarioOf(job) });
  const gate = await circuit.allow(pool, 'AT_CODE');
  if (!gate.allowed) {
    await queue.requeue(pool, job, { at: gate.retryAt || new Date(Date.now() + 3600000), errorKind: gate.reason, keepAttempt: false });
    return { status: 'QUEUED', kind: gate.reason };
  }
  const f = await fetchAll(pool, { ...job, source: 'AT_CODE' }, adapter, adapter.mode === 'MOCK' ? 'MOCK' : 'AT_CODE');
  if (f.error) return handleFailure(pool, { ...job, source: 'AT_CODE' }, f.error, f.message, f.retryAfterSec);
  await circuit.success(pool, 'AT_CODE');
  let n = 0;
  for (const raw of f.items || []) {
    const x = adapter.toNormalized(raw);
    const rows = [['item_l', x.item_l_code, x.item_l_name, null], ['item_m', x.item_m_code, x.item_m_name, x.item_l_code], ['item_s', `${x.item_m_code}-${x.item_s_code}`, x.item_s_name, x.item_m_code]];
    for (const [type, code, name, parent] of rows) {
      if (!code || !name) continue;
      // eslint-disable-next-line no-await-in-loop
      await pool.query(
        `INSERT INTO code_master (code_type, code, name, parent_code, fetched_at) VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (code_type, code) DO UPDATE SET name = EXCLUDED.name, parent_code = EXCLUDED.parent_code, fetched_at = NOW()`,
        [type, code, name, parent]
      );
      n += 1;
    }
  }
  await queue.finish(pool, job.id, { status: 'DONE', result: { upserted: n, source_mode: adapter.mode } });
  return { status: 'DONE', upserted: n };
}

async function runRemap(pool, job) {
  const c = await pool.connect();
  let r;
  try {
    await c.query('BEGIN');
    r = await norm.remapStored(c, { dateFrom: job.params.date_from || null });
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  await queue.finish(pool, job.id, { status: 'DONE', result: r });
  return { status: 'DONE', ...r };
}

/** 정리 — 원천 로그(정상 90일·오류 30일), 멱등 키 7일, 후보는 줄마다 최근 3회 실행만 */
async function runPurge(pool, job) {
  const okDays = Number(process.env.RAW_KEEP_OK_DAYS || 90);
  const errDays = Number(process.env.RAW_KEEP_ERROR_DAYS || 30);
  const a = await pool.query(`DELETE FROM ext_raw_response WHERE (kind IN ('OK','EMPTY') AND fetched_at < NOW() - make_interval(days => $1))
                                 OR (kind NOT IN ('OK','EMPTY') AND fetched_at < NOW() - make_interval(days => $2))`, [okDays, errDays]);
  const b = await pool.query(`DELETE FROM api_idempotency WHERE created_at < NOW() - interval '7 days'`);
  const c = await pool.query(
    `DELETE FROM purchase_match_candidate pc USING (
       SELECT line_id, run_id, dense_rank() OVER (PARTITION BY line_id ORDER BY run_id DESC) AS rk
         FROM (SELECT DISTINCT line_id, run_id FROM purchase_match_candidate) d) x
      WHERE pc.line_id = x.line_id AND pc.run_id = x.run_id AND x.rk > 3`
  );
  const result = { raw_deleted: a.rowCount, idempotency_deleted: b.rowCount, candidates_deleted: c.rowCount };
  await queue.finish(pool, job.id, { status: 'DONE', result });
  return { status: 'DONE', ...result };
}

async function runRematch(pool, job, hooks) {
  if (!hooks || !hooks.rematchForDate) {
    await queue.finish(pool, job.id, { status: 'DONE', result: { skipped: 'no-hook' } });
    return { status: 'DONE', skipped: true };
  }
  const r = await hooks.rematchForDate({ tradeDate: job.trade_date, source: job.source, jobId: job.id });
  await queue.finish(pool, job.id, { status: 'DONE', result: r });
  return { status: 'DONE', ...r };
}

/** 작업 하나 실행 — 예상 못 한 예외는 백오프 재시도(최대 → DEAD) */
async function runJob(pool, job, hooks = {}) {
  try {
    if (job.job_type === 'COLLECT') return await runCollect(pool, job, hooks);
    if (job.job_type === 'SETTLE_VERIFY') return await runSettleVerify(pool, job);
    if (job.job_type === 'CODE_SYNC') return await runCodeSync(pool, job);
    if (job.job_type === 'REMAP') return await runRemap(pool, job);
    if (job.job_type === 'PURGE_RAW') return await runPurge(pool, job);
    if (job.job_type === 'REMATCH') return await runRematch(pool, job, hooks);
    await queue.finish(pool, job.id, { status: 'FAILED', error: `알 수 없는 작업 ${job.job_type}`, errorKind: 'BAD_JOB' });
    return { status: 'FAILED' };
  } catch (err) {
    console.error(`[collect] job ${job.id} ${job.job_type} error:`, scrubSecrets(err.message, secretValues()));
    const msg = scrubSecrets(err.message, secretValues());
    if (job.attempts >= job.max_attempts) {
      await queue.finish(pool, job.id, { status: 'DEAD', error: msg, errorKind: 'INTERNAL' }).catch(() => {});
      return { status: 'DEAD', kind: 'INTERNAL' };
    }
    await queue.requeue(pool, job, { error: msg, errorKind: 'INTERNAL' }).catch(() => {});
    return { status: 'QUEUED', kind: 'INTERNAL' };
  }
}

module.exports = { runJob, runCollect, fetchAll, finalReadyAt, kstToday, addDays, kstAt, marketCode, pageSize, mockScenarioOf, markLatestOk };
