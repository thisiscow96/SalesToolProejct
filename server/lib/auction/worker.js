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
const { createAdapter, secretValues, itemCombos, corpCodes, corpScope } = require('./adapters');
const circuit = require('./circuit');
const queue = require('./queue');
const norm = require('./normalizer');
const N = require('../purchase-match/normalize');
const { scrubSecrets } = require('./mask');

const MAX_PAGES = 200;
const MAX_BODY = 1024 * 1024;
/** O1 경고 문구 — 수집 현황(verify_warning)·서버 로그에 그대로 보임 */
const SEED_MISSING_WARNING = '분류 코드 매핑 시드 없음 — seed-at-realtime-mapping.js 실행';

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
  const raw = r.rawBody || '';
  // C-RA-01: 원격이 오류 본문에 키를 되돌려 줘도 저장 전에 가린다(serviceKey= 패턴 + 알고 있는 키 값). 해시는 받은 원문 기준
  const body = scrubSecrets(raw, secretValues());
  const truncated = Buffer.byteLength(body, 'utf8') > MAX_BODY;
  const stored = truncated ? body.slice(0, MAX_BODY / 2) : body;
  const ins = await pool.query(
    `INSERT INTO ext_raw_response (job_id, source, request_url_masked, request_params, page_no, http_status, kind, body, body_truncated, body_hash, row_count, duration_ms)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [job.id, effSource, scrubSecrets(r.requestUrlMasked, secretValues()), JSON.stringify(r.requestParams || {}), r.pageNo || null, r.httpStatus || null,
      r.kind, stored, truncated, crypto.createHash('sha256').update(raw).digest('hex'), (r.items || []).length, r.durationMs ?? null]
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
    `INSERT INTO collect_snapshot (source, market_code, trade_date, phase, job_id, status, pages, error_kind, error_message, finished_at, corp_scope)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
    [job.source, job.market_code, job.trade_date, job.phase, job.id, info.status || 'FAILED', info.pages || 0, info.kind || null,
      info.message ? scrubSecrets(info.message, secretValues()).slice(0, 500) : null, snapshotScope(job)]
  );
}

/** 스냅샷 corp_scope — 실시간 경락(AT_REALTIME)만 법인 한정 대상. 다른 소스·전체 수집은 null */
function snapshotScope(job, env = process.env) {
  return job.source === 'AT_REALTIME' ? corpScope(env) : null;
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

/**
 * 페이지 전부 받기(트랜잭션 밖 — 외부 호출 동안 DB 트랜잭션을 길게 잡지 않음). 실패하면 { error }
 * T-203 실 API(LIVE·REPLAY) 경락은 (대분류, 중분류) 조합별로 부른다(A 5.1 — 대분류만 부르면 마늘·양파까지 와서 쪽 수가 늘어남).
 * 조합 하나라도 실패하면 작업 전체를 실패로 돌려 재시도(반쪽 저장 없음). 목업·다른 소스는 예전처럼 한 번에.
 */
async function fetchAll(pool, job, adapter, effSource) {
  const filter = (job.params && job.params.filter) || null;
  const useCombos = job.source === 'AT_REALTIME' && adapter.mode !== 'MOCK' && !filter;
  // 수집 대상 법인 한정(AUCTION_CORP_CODES) — 실시간 경락만. 법인마다 따로 부르고(cond[corp_cd::EQ]), 완결성(totalCount)은 호출 단위(법인 × 조합)로 본다
  const corps = job.source === 'AT_REALTIME' ? corpCodes() : [];
  if (!useCombos && !corps.length) return fetchOne(pool, job, adapter, effSource, filter || {});
  const combos = useCombos ? itemCombos() : [filter || {}];
  const units = [];
  for (const corp of (corps.length ? corps : [null])) for (const c of combos) units.push(corp ? { ...c, corpCode: corp } : { ...c });
  const label = (u) => [u.corpCode, u.itemL ? `${u.itemL}-${u.itemM}` : null].filter(Boolean).join(' ') || 'all';
  const out = { items: [], total: 0, rawIds: [], pages: 0, combos: useCombos ? combos : null, corps: corps.length ? corps : null, perCombo: [], outOfScope: 0 };
  const notes = [];
  for (const u of units) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fetchOne(pool, job, adapter, effSource, u);
    out.rawIds.push(...(r.rawIds || []));
    out.pages += r.pages || 0;
    if (r.error) return { ...r, rawIds: out.rawIds, pages: out.pages, message: `${label(u)}: ${r.message || r.error}` };
    const entry = { ...(u.corpCode ? { corp: u.corpCode } : {}), ...(u.itemL ? { combo: `${u.itemL}-${u.itemM}` } : {}), total: r.empty ? 0 : r.total, pages: r.pages };
    out.perCombo.push(entry);
    if (r.empty) continue;
    let items = r.items;
    if (u.corpCode) {
      // 원천이 법인 조건을 무시해도(목업·명세 변경) 범위 밖 법인 행은 저장하지 않는다 — 버린 수는 경고에
      items = r.items.filter((it) => String(adapter.toNormalized(it).corp_code || '') === u.corpCode);
      if (items.length !== r.items.length) { entry.out_of_scope = r.items.length - items.length; out.outOfScope += entry.out_of_scope; }
    }
    out.items.push(...items);
    out.total += r.total;
    if (r.partial) { out.partial = true; notes.push(`${label(u)} ${r.note}`); }
  }
  if (out.outOfScope) notes.push(`법인 조건 밖 행 ${out.outOfScope}건 제외`);
  if (!out.items.length) return { empty: true, rawIds: out.rawIds, pages: out.pages, combos: out.combos, corps: out.corps, perCombo: out.perCombo, ...(notes.length ? { note: notes.join(' / ') } : {}) };
  if (notes.length) out.note = notes.join(' / ');
  return out;
}

async function fetchOne(pool, job, adapter, effSource, filter) {
  const size = pageSize();
  for (let round = 1; round <= 2; round += 1) {
    const items = [];
    const rawIds = [];
    let total = null;
    let changed = false;
    let pages = 0;
    for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await adapter.fetchPage({ tradeDate: job.trade_date, marketCode: job.market_code, pageNo, numOfRows: size, ...filter });
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
  // O1: 실 소스(LIVE·REPLAY)인데 AT 코드 매핑 규칙이 0행이면 전부 UNMAPPED 가 된다 — 수집은 그대로 하고 경고만 남김
  const seedMissing = job.source === 'AT_REALTIME' && adapter.mode !== 'MOCK' && !ctx.codeRules.some((x) => x.source === 'AT_REALTIME');
  if (seedMissing) console.warn(`[collect] job ${job.id} ${SEED_MISSING_WARNING}`);
  const n = fetched.empty ? { rows: [], errors: [] } : norm.normalizeItems(ctx, adapter, fetched.items, { source: effSource, marketCode: job.market_code });
  if (n.errors.length) {
    const msg = `응답 형식 이상 ${n.errors.length}건: ${n.errors.slice(0, 3).map((e) => `${e.idx + 1}번째 ${e.message}`).join(' / ')}`;
    await recordFailedSnapshot(pool, job, { kind: 'BAD_RESPONSE', message: msg, pages: fetched.pages });
    return handleFailure(pool, job, 'BAD_RESPONSE', msg, null);
  }
  // 같은 키가 한 작업 안에 두 번(페이지 경계·적재 경합) — 원천 수정일시가 가장 늦은 값(없으면 마지막 값). 버린 수는 경고에(I B-3)
  const dd = norm.dedupeRows(n.rows);
  const rows = dd.rows;

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
      `INSERT INTO collect_snapshot (source, market_code, trade_date, phase, job_id, status, total_count, fetched_count, pages, started_at, corp_scope)
       VALUES ($1,$2,$3,$4,$5,'RUNNING',$6,$7,$8,NOW(),$9) RETURNING *`,
      [job.source, job.market_code, job.trade_date, job.phase, job.id, fetched.total || 0, fetched.items ? fetched.items.length : 0, fetched.pages || 0,
        fetched.corps ? fetched.corps.join(',') : null]
    );
    snap = s.rows[0];
    const lastRaw = fetched.rawIds[fetched.rawIds.length - 1] || null;
    const up = await norm.upsertTrades(client, rows, { snapshotId: snap.id, rawRef: lastRaw });
    let withdrawn = [];
    if (job.phase === 'FINAL' && status === 'COMPLETE') withdrawn = await norm.markWithdrawn(client, { source: effSource, marketCode: job.market_code, tradeDate: job.trade_date, combos: fetched.combos || null, corps: fetched.corps || null });
    changedTrades = [...up.changedIds, ...withdrawn];
    const flagged = await norm.flagRevisedConversions(client, changedTrades);
    const contentHash = crypto.createHash('sha256').update(rows.map((r) => r.content_hash).sort().join('')).digest('hex');
    await client.query(
      `UPDATE collect_snapshot SET status = $2, inserted = $3, updated = $4, unchanged = $5, unmapped = $6, withdrawn = $7, content_hash = $8,
              verify_warning = $9, finished_at = NOW() WHERE id = $1`,
      [snap.id, status, up.inserted, up.updated, up.unchanged, up.unmapped, withdrawn.length, contentHash,
        [seedMissing ? SEED_MISSING_WARNING : null,
          fetched.note || (status === 'EMPTY' ? '데이터 없음 — 확인 필요(휴장 미등록?)' : null),
          dd.dropped ? `같은 키 중복 ${dd.dropped}행 정리` : null, up.stale ? `STALE_ROW ${up.stale}건(옛 응답 — 덮어쓰지 않음)` : null]
          .filter(Boolean).join(' / ').slice(0, 1000) || null]
    );
    snap.status = status;
    let latest = false;
    if (['COMPLETE', 'EMPTY', 'HOLIDAY'].includes(status)) latest = await markLatestOk(client, snap);
    Object.assign(result, { snapshot_id: Number(snap.id), snapshot: status, latest_ok: latest, total: fetched.total || 0, fetched: rows.length,
      inserted: up.inserted, updated: up.updated, unchanged: up.unchanged, unmapped: up.unmapped, withdrawn: withdrawn.length, revised_flagged: flagged, pages: fetched.pages,
      ignored: up.ignored, stale_rows: up.stale, dup_dropped: dd.dropped, ...(fetched.corps ? { corp_scope: fetched.corps.join(',') } : {}), ...(fetched.outOfScope ? { out_of_scope_dropped: fetched.outOfScope } : {}), ...(seedMissing ? { mapping_seed_missing: true } : {}), ...(fetched.perCombo ? { combos: fetched.perCombo } : {}) });
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
  // 법인 한정 수집이면 그 법인만 비교(범위 밖 법인을 "누락"으로 보고 재수집을 부르지 않게)
  const scoped = new Set(corpCodes());
  for (const raw of f.items || []) {
    const x = adapter.toNormalized(raw);
    if (scoped.size && !scoped.has(String(x.corp_code || ''))) continue;
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

/**
 * 경락 보관 기간(운영 무료 DB용, T-203 후속) — AUCTION_TRADE_KEEP_DAYS
 *  - 비어 있으면 무기한(로컬 영구 DB 기본) → 경락 행은 지우지 않는다.
 *  - 최소값 = 누락 보정 일수(COLLECT_BACKFILL_DAYS, 기본 7) + 1. 더 짧으면 지운 날을 누락 보정이 다시 받아 지우고 받기를 되풀이한다.
 *  - 정수가 아니거나 0 이하이면 설정 오류로 보고 지우지 않는다(invalid=true, 관리자 화면에 표시).
 */
function tradeRetention(env = process.env) {
  const raw = String(env.AUCTION_TRADE_KEEP_DAYS == null ? '' : env.AUCTION_TRADE_KEEP_DAYS).trim();
  const min = Number(env.COLLECT_BACKFILL_DAYS || 7) + 1;
  if (!raw) return { configured: null, days: null, min, invalid: false, clamped: false };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { configured: raw, days: null, min, invalid: true, clamped: false };
  return { configured: n, days: Math.max(n, min), min, invalid: false, clamped: n < min };
}

/** 매입서 대조 근거가 되는 경락 — 줄의 최적 후보·후보 목록·매입전환·대조 이력(감사)이 가리키면 지우지 않는다 */
const TRADE_UNREFERENCED = `NOT EXISTS (SELECT 1 FROM purchase_doc_line l WHERE l.best_trade_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM purchase_match_candidate c WHERE c.trade_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion v WHERE v.trade_id = t.id)
   AND NOT EXISTS (SELECT 1 FROM purchase_match_event e WHERE e.trade_id = t.id)`;

/**
 * 보관 기간 지난 경락·딸린 행 분할 삭제 — budget 안에서만. 남으면 다음 정리에서 이어서
 *  ① 경락(+이전 값 이력) 1회 batch 행씩, 참조된 행은 남김 ② 품목별 가격 ③ 아무도 안 가리키는 스냅샷
 *  ④ 참조 행 때문에 남은 옛 스냅샷은 is_latest_ok 를 내려 "기준 데이터 있음"으로 보이지 않게(경락 일부만 남았으므로 재대조는 BASE_NOT_READY)
 */
async function purgeTrades(pool, { cutoff, budgetMs, t0, batch }) {
  const out = { trades_deleted: 0, trade_history_deleted: 0, trades_remaining: 0, trades_kept_referenced: 0,
    prices_deleted: 0, snapshots_deleted: 0, snapshots_unmarked: 0, trade_purge_conflict: false };
  const over = () => Date.now() - t0 > budgetMs;
  // 묶음마다 지운 뒤 예산을 본다(원천 로그 정리와 같은 방식 — 예산 0 이어도 한 묶음은 지움). 경락이 남으면 가격·스냅샷은 다음 정리에서
  let done = false;
  let stopped = false;
  for (;;) {
    let d;
    try {
      // eslint-disable-next-line no-await-in-loop
      d = await pool.query(
        `WITH v AS (SELECT t.id FROM auction_trade t WHERE t.trade_date < $1::date AND ${TRADE_UNREFERENCED} ORDER BY t.id LIMIT $2 FOR UPDATE SKIP LOCKED),
              h AS (DELETE FROM auction_trade_history h USING v WHERE h.trade_id = v.id RETURNING 1),
              x AS (DELETE FROM auction_trade t USING v WHERE t.id = v.id RETURNING 1)
         SELECT (SELECT COUNT(*) FROM x)::int AS trades, (SELECT COUNT(*) FROM h)::int AS hist`,
        [cutoff, batch]
      );
    } catch (e) {
      // 그 사이 대조가 같은 경락을 후보로 잡음(FK 23503) — 이번 정리는 여기서 멈추고 다음 정리에서 다시 고른다
      if (e.code !== '23503') throw e;
      out.trade_purge_conflict = true;
      break;
    }
    out.trades_deleted += d.rows[0].trades;
    out.trade_history_deleted += d.rows[0].hist;
    if (d.rows[0].trades < batch) { done = true; break; }
    if (over()) { stopped = true; break; }
  }
  for (;;) {
    if (stopped || out.trade_purge_conflict) break;
    // eslint-disable-next-line no-await-in-loop
    const p = await pool.query(`DELETE FROM market_price_daily WHERE id IN (SELECT id FROM market_price_daily WHERE price_date < $1::date ORDER BY id LIMIT $2)`, [cutoff, batch]);
    out.prices_deleted += p.rowCount;
    if (p.rowCount < batch) break;
    if (over()) { stopped = true; done = false; break; }
  }
  for (;;) {
    if (stopped || out.trade_purge_conflict) break;
    // eslint-disable-next-line no-await-in-loop
    const s = await pool.query(
      `DELETE FROM collect_snapshot WHERE id IN (
         SELECT s.id FROM collect_snapshot s
          WHERE s.trade_date < $1::date AND s.status <> 'RUNNING'
            AND NOT EXISTS (SELECT 1 FROM auction_trade a WHERE a.snapshot_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM auction_trade_history h WHERE h.snapshot_id = s.id)
            AND NOT EXISTS (SELECT 1 FROM market_price_daily m WHERE m.snapshot_id = s.id)
          ORDER BY s.id LIMIT $2)`,
      [cutoff, batch]
    );
    out.snapshots_deleted += s.rowCount;
    if (s.rowCount < batch) break;
    if (over()) { done = false; break; }
  }
  if (done) {
    const u = await pool.query(
      `UPDATE collect_snapshot SET is_latest_ok = false,
              verify_warning = LEFT(COALESCE(verify_warning || ' / ', '') || $2, 1000)
        WHERE trade_date < $1::date AND is_latest_ok`,
      [cutoff, '보관 기간이 지나 매입서 근거 경락만 남음']
    );
    out.snapshots_unmarked = u.rowCount;
  }
  const left = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${TRADE_UNREFERENCED})::int AS unref, COUNT(*)::int AS total FROM auction_trade t WHERE t.trade_date < $1::date`,
    [cutoff]
  );
  out.trades_remaining = left.rows[0].unref;
  out.trades_kept_referenced = left.rows[0].total - left.rows[0].unref;
  return out;
}

/** 정리 — 원천 로그(정상 90일·오류 30일), 멱등 키 7일, 후보는 줄마다 최근 3회 실행만, 경락은 AUCTION_TRADE_KEEP_DAYS 가 있을 때만 */
async function runPurge(pool, job) {
  const keep = tradeRetention();
  // 경락 보관 기간이 있으면 원천 로그도 그보다 오래 두지 않는다(무료 DB 용량 — 원천 본문이 가장 큼)
  const capRaw = (n) => (keep.days ? Math.min(n, keep.days) : n);
  const okDays = capRaw(Number(process.env.RAW_KEEP_OK_DAYS || 90));
  const errDays = capRaw(Number(process.env.RAW_KEEP_ERROR_DAYS || 30));
  // 원천 로그는 1,000행씩 나눠 지운다(I 검토 D-04 — 한 번에 지우면 경락 raw_ref SET NULL 로 긴 잠금). 예산(기본 20초)을 넘기면 멈추고 다음 정리에서 이어서
  const RAW_WHERE = `(kind IN ('OK','EMPTY') AND fetched_at < NOW() - make_interval(days => $1))
                  OR (kind NOT IN ('OK','EMPTY') AND fetched_at < NOW() - make_interval(days => $2))`;
  const budgetMs = Number(process.env.PURGE_BUDGET_MS || 20000);
  const t0 = Date.now();
  let rawDeleted = 0;
  let remaining = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const d = await pool.query(`DELETE FROM ext_raw_response WHERE id IN (SELECT id FROM ext_raw_response WHERE ${RAW_WHERE} ORDER BY id LIMIT 1000)`, [okDays, errDays]);
    rawDeleted += d.rowCount;
    if (d.rowCount < 1000) break;
    if (Date.now() - t0 > budgetMs) {
      // eslint-disable-next-line no-await-in-loop
      const left = await pool.query(`SELECT COUNT(*)::int AS n FROM ext_raw_response WHERE ${RAW_WHERE}`, [okDays, errDays]);
      remaining = left.rows[0].n;
      break;
    }
  }
  const b = await pool.query(`DELETE FROM api_idempotency WHERE created_at < NOW() - interval '7 days'`);
  const c = await pool.query(
    `DELETE FROM purchase_match_candidate pc USING (
       SELECT line_id, run_id, dense_rank() OVER (PARTITION BY line_id ORDER BY run_id DESC) AS rk
         FROM (SELECT DISTINCT line_id, run_id FROM purchase_match_candidate) d) x
      WHERE pc.line_id = x.line_id AND pc.run_id = x.run_id AND x.rk > 3`
  );
  const result = { raw_deleted: rawDeleted, raw_remaining: remaining, idempotency_deleted: b.rowCount, candidates_deleted: c.rowCount,
    raw_keep_ok_days: okDays, raw_keep_error_days: errDays, trade_keep_days: keep.days, trade_keep_invalid: keep.invalid };
  if (keep.days) {
    const batch = Math.max(1, Number(process.env.PURGE_BATCH_ROWS || 1000));
    const cutoff = addDays(kstToday(), -keep.days);
    Object.assign(result, { trade_cutoff: cutoff }, await purgeTrades(pool, { cutoff, budgetMs, t0, batch }));
  }
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

module.exports = { SEED_MISSING_WARNING, logRaw, snapshotScope, runJob, runCollect, fetchAll, finalReadyAt, kstToday, addDays, kstAt, marketCode, pageSize, mockScenarioOf, markLatestOk, tradeRetention };
