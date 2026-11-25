/**
 * T-203 경매 직후 수집 테스트 — 정산일(settleDateOf)·완료 감지·01:00 배치·06:00 확인·지금 받기·C-CV-01 (A 설계 8절 AC-L-xx 를 테스트 이름에 그대로)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> node scripts/t203-live-collect-test.js
 * 전제: 마이그레이션 001~033, seed-sample-local, 서버 기동(AUCTION_SOURCE_MODE=mock, AUCTION_MOCK_CONTROL=true)
 * 테스트 DB 전용. 실 API 호출 없음 — 시계를 주입하고(hooks.now) 실데이터 샘플(정산일 2026-11-24)을 mdfcn_dt 순으로 "적재"되는 것처럼 돌려주는
 * 시간표 어댑터(hooks.createAdapter)로 스케줄러·워커를 이 프로세스에서 직접 돌린다.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('../lib/db-config'); // DATE 열 → 'YYYY-MM-DD' 문자열(서버와 같은 전역 파서)

// 이 프로세스의 수집기 설정 — 한국청과만(사용자 로컬 설정과 같음). 서버(3171) 설정과는 별개
process.env.AUCTION_CORP_CODES = '11000105';
delete process.env.AUCTION_ITEM_COMBOS;
const SAMPLE = process.env.T203_SAMPLE_JSON
  || path.join(__dirname, '..', '..', '..', '..', 'Resume', 'AI Project', 'work', '2026-11-24_garak-purchase-match', '산출물', '실데이터_샘플', '가락_20261124_고추파프리카_2009건.json');

const BASE = process.env.MATCH_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[t203-live-collect-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
}
async function api(method, p, body, token, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { _text: text.slice(0, 200) }; }
  return { status: r.status, json: j, headers: r.headers };
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const tag = Date.now().toString(36);
  const mkUser = async (name, agent) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const id = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,$4,NOW(),'active',false) RETURNING id`,
      [name, `${agent}_${tag}@test.local`, agent, await bcrypt.hash(pw, 8)]))[0].id;
    const tok = (await api('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
    if (!tok) throw new Error(`로그인 실패 ${agent}`);
    return { id, tok, agent, pw };
  };
  const O = await mkUser(`수집검사 ${tag}`, `lc_${tag}`);

  // ---------- C-CV-01 R-92 Cache-Control ----------
  {
    const r = await api('GET', '/api/auction/trades?date_from=2026-11-01&date_to=2026-11-02', null, O.tok);
    const cc = r.headers.get('cache-control');
    const etag = r.headers.get('etag');
    // Node fetch 는 조건부 헤더를 넣으면 요청에 cache-control: no-cache 를 붙여 서버가 304 를 못 준다 → 브라우저처럼 http 모듈로 재확인
    const st2 = etag ? await new Promise((res, rej) => {
      const u = new URL(`${BASE}/api/auction/trades?date_from=2026-11-01&date_to=2026-11-02`);
      require('http').get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { authorization: `Bearer ${O.tok}`, 'if-none-match': etag } },
        (x) => { x.resume(); res(x.statusCode); }).on('error', rej);
    }) : null;
    check('C-CV-01 R-92 Cache-Control = private, no-cache(max-age 없음)·ETag 재확인 304', r.status === 200 && cc === 'private, no-cache' && !!etag && st2 === 304, { status: r.status, cc, etag, st2 });
  }

  const worker = require('../lib/auction/worker');
  const scheduler = require('../lib/auction/scheduler');
  const circuit = require('../lib/auction/circuit');
  const { AtRealtimeAdapter } = require('../lib/auction/adapters');
  const addDays = worker.addDays;
  const K = (ymd, hm) => new Date(Date.parse(`${ymd}T${hm}:00+09:00`)); // KST 시각 → Date
  const hhmm = (d) => (d ? new Date(new Date(d).getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16) : null);

  // ---------- AC-L-01 settleDateOf ----------
  {
    const cases = [['2026-11-23', '21:30', '2026-11-24'], ['2026-11-24', '00:30', '2026-11-24'], ['2026-11-24', '01:00', '2026-11-24'], ['2026-11-24', '01:40', '2026-11-24'],
      ['2026-11-24', '06:00', '2026-11-24'], ['2026-11-24', '20:59', '2026-11-24'], ['2026-11-24', '21:00', '2026-11-25'], ['2026-11-23', '20:59', '2026-11-23']];
    const bad = cases.filter(([d, t, want]) => worker.settleDateOf(K(d, t)) !== want).map(([d, t, want]) => ({ d, t, want, got: worker.settleDateOf(K(d, t)) }));
    check('AC-L-01 settleDateOf: 21:30·00:30·01:00·01:40·06:00·20:59 → 11-24, 11-24 21:00 → 11-25', bad.length === 0, bad);
    check('AC-L-01 finalReadyAt(D) = D 06:00 KST(L-D3)', hhmm(worker.finalReadyAt('2026-11-24')) === '06:00' && worker.finalReadyAt('2026-11-24').toISOString().slice(0, 10) === '2026-11-23', worker.finalReadyAt('2026-11-24'));
  }

  // ---------- 준비: 시간표 어댑터(실데이터 샘플을 테스트 정산일로 옮겨 mdfcn_dt 시각에 "적재") ----------
  const SAMPLE_DATE = '2026-11-24';
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).filter((r) => r.corp_cd === '11000105');
  const shiftStr = (v, n) => (v ? addDays(String(v).slice(0, 10), n) + String(v).slice(10) : v);
  const timelines = new Map(); // date → rows
  const calls = new Map(); // date → 호출 수
  const ctl = { failNext: 0 };
  function makeTimeline(D, edit = (rows) => rows) {
    const n = Math.round((Date.parse(`${D}T00:00:00Z`) - Date.parse(`${SAMPLE_DATE}T00:00:00Z`)) / 86400000);
    const rows = sample.map((r) => ({ ...r, trd_clcln_ymd: D, scsbd_dt: shiftStr(r.scsbd_dt, n), mdfcn_dt: shiftStr(r.mdfcn_dt, n) }));
    timelines.set(D, edit(rows));
  }
  let clock = new Date();
  const real = new AtRealtimeAdapter({ mode: 'REPLAY' });
  class TimelineAdapter {
    get source() { return 'AT_REALTIME'; }
    get mode() { return 'REPLAY'; }
    buildParams(p) { return real.buildParams(p); }
    toNormalized(item) { return real.toNormalized(item); }
    async fetchPage(params) {
      const D = params.tradeDate;
      calls.set(D, (calls.get(D) || 0) + 1);
      const requestParams = this.buildParams(params);
      const masked = `timeline://AT_REALTIME?serviceKey=****&${new URLSearchParams(requestParams).toString()}`;
      const pageNo = params.pageNo || 1;
      if (ctl.failNext > 0) { ctl.failNext -= 1; return real.interpret({ status: 503, body: 'Service Unavailable', headers: {}, durationMs: 0 }, { masked, pageNo, requestParams }); }
      const now = clock.getTime();
      const mine = (timelines.get(D) || []).filter((r) => (!params.corpCode || r.corp_cd === params.corpCode) && (!params.itemL || r.gds_lclsf_cd === params.itemL)
        && (!params.itemM || r.gds_mclsf_cd === params.itemM) && Date.parse(`${r.mdfcn_dt.replace(' ', 'T')}+09:00`) <= now);
      const size = Number(params.numOfRows) || 1000;
      const items = mine.slice((pageNo - 1) * size, pageNo * size);
      const body = JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: { item: items }, numOfRows: size, pageNo, totalCount: mine.length } } });
      return real.interpret({ status: 200, body, headers: {}, durationMs: 0 }, { masked, pageNo, requestParams });
    }
  }
  const hooks = { now: () => clock, createAdapter: (source, opts) => (source === 'AT_REALTIME' ? new TimelineAdapter() : require('../lib/auction/adapters').createAdapter(source, opts)) };
  const tickAt = async (d, t) => { clock = K(d, t); return scheduler.tick(pool, { hooks, maxJobs: 5, budgetMs: 60000 }); };
  const st = async (D) => worker.dayState(pool, { source: 'AT_REALTIME', market: '110001', date: D });
  const jobsOf = async (D) => q(`SELECT id, phase, status, dedupe_key, params, result FROM collect_job WHERE job_type = 'COLLECT' AND trade_date = $1 ORDER BY id`, [D]);

  // 테스트 날짜: 2031~2035 무작위(다른 테스트·이전 실행과 겹치지 않게). 정산일 사이 간격 20일
  const D = addDays('2031-01-10', crypto.randomInt(0, 1400));
  const DS = { main: D, early: addDays(D, 20), late: addDays(D, 40), hol: addDays(D, 60), empty: addDays(D, 80), off9: addDays(D, 100), off18: addDays(D, 120) };
  console.log(`[t203-live-collect-test] 정산일 ${JSON.stringify(DS)} tag ${tag}`);
  // 일정: 수집 4종만 켜고 033 기본값(창 10분·01:00·02:00·06/11시), 나머지는 끔. 끝나면 되돌린다
  const schBefore = await q(`SELECT job_type, source, cron_text, active FROM collect_schedule`);
  await q(`UPDATE collect_schedule SET active = false`);
  for (const [jt, cron] of [['COLLECT_INTRADAY', '*/10 21-23,0-1 * * *'], ['COLLECT_NIGHTLY', '0 1 * * *'], ['COLLECT_WINDOW_END', '0 2 * * *'], ['COLLECT_FINAL', '0 6,11 * * *']]) {
    await q(`UPDATE collect_schedule SET active = true, cron_text = $2 WHERE job_type = $1 AND source = 'AT_REALTIME'`, [jt, cron]);
  }
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE status = 'QUEUED'`);
  await circuit.reset(pool, 'AT_REALTIME');
  // 누락 보정이 시나리오 밖 날짜를 받지 않게 각 정산일 앞 8일은 "확정 끝"으로 표시
  for (const x of Object.values(DS)) {
    for (let i = 1; i <= 8; i += 1) {
      await q(`INSERT INTO collect_snapshot (source, market_code, trade_date, phase, status, finished_at, is_latest_ok) VALUES ('AT_REALTIME','110001',$1,'FINAL','COMPLETE',NOW(),true) ON CONFLICT DO NOTHING`, [addDays(x, -i)]);
    }
  }
  for (const x of Object.values(DS)) makeTimeline(x);
  // late: 01:05·01:25 에 늦게 적재되는 행 2건(경매가 01:30 까지 이어진 날)
  // (샘플은 mdfcn_dt 내림차순 — 기존 행은 그대로 두고, 같은 분류의 새 원표 2건을 01:05·01:25 적재로 더한다)
  makeTimeline(DS.late, (rows) => [...rows, { ...rows[2], spm_no: '990001', auctn_seq: '990001', mdfcn_dt: `${DS.late} 01:05:00` }, { ...rows[3], spm_no: '990002', auctn_seq: '990002', mdfcn_dt: `${DS.late} 01:25:00` }]);
  // early: 23:30 전에 다 적재된 날(00:23 묶음 없음 → 23:43 묶음까지만, 그 뒤 무변화)
  makeTimeline(DS.early, (rows) => rows.filter((r) => r.mdfcn_dt.slice(0, 10) !== DS.early));
  timelines.set(DS.empty, []);
  await q(`INSERT INTO market_calendar (market_code, cal_date, kind, note) VALUES ('110001', $1, 'HOLIDAY', '검사 휴장') ON CONFLICT (market_code, cal_date) DO UPDATE SET kind = 'HOLIDAY'`, [DS.hol]);

  // ---------- 주 시나리오: 정산일 D, D-1 21:00 → D 06:00 (10분 간격 tick) ----------
  const P = addDays(D, -1);
  const log = [];
  const at = {};
  const snapAt = async (d, t) => { at[t] = { state: (await st(d)) || null, calls: calls.get(d) || 0 }; };
  // 판매툴 매일 일정처럼 10분마다 tick. 몇몇 시각에 검사
  const times = [];
  for (let h = 21; h <= 23; h += 1) for (let m = 0; m < 60; m += 10) times.push([P, `${h}:${String(m).padStart(2, '0')}`]);
  for (let h = 0; h <= 5; h += 1) for (let m = 0; m < 60; m += 10) times.push([D, `0${h}:${String(m).padStart(2, '0')}`]);
  times.push([D, '06:00']);
  let errProbe = null;
  let manual140 = null;
  for (const [d, t] of times) {
    const before = calls.get(D) || 0;
    if (d === P && t === '22:00') {
      // AC-L-26: 같은 슬롯에 tick 2개(서버 타이머 + collect_once)
      clock = K(d, t);
      const [a, b] = await Promise.all([scheduler.tick(pool, { hooks, maxJobs: 5 }), scheduler.tick(pool, { hooks, maxJobs: 5 })]);
      const ran = [...a.ran, ...b.ran].filter((x) => x.job_type === 'COLLECT');
      at.dual = { ran: ran.length, calls: (calls.get(D) || 0) - before, jobs: (await q(`SELECT count(*)::int AS n FROM collect_job WHERE trade_date = $1 AND dedupe_key LIKE '%:INTRADAY:' || $2`, [D, scheduler.slotKey(new Date(K(d, t).getTime() + 9 * 3600 * 1000))]))[0].n };
    } else if (d === P && t === '23:00') {
      // AC-L-17: 이 폴링은 외부 503 → 판정 시계·마지막 수집 시각 그대로
      const s0 = await st(D);
      ctl.failNext = 1;
      const r = await tickAt(d, t);
      const s1 = await st(D);
      const j = r.ran.find((x) => x.job_type === 'COLLECT');
      errProbe = { ran: j, before: s0 && [s0.last_change_at, s0.last_polled_at, s0.polls], after: s1 && [s1.last_change_at, s1.last_polled_at, s1.polls] };
      await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE trade_date = $1 AND status = 'QUEUED'`, [D]);
      await circuit.reset(pool, 'AT_REALTIME');
    } else {
      const r = await tickAt(d, t);
      log.push({ t, planned: r.planned.map((x) => `${x.job_type}:${x.phase || x.state || ''}:${x.reason || ''}${x.merged ? ':merged' : ''}`), ran: r.ran.map((x) => `${x.job_type}:${x.phase || ''}:${x.snapshot || x.status}:${x.day_state || ''}`), calls: (calls.get(D) || 0) - before });
    }
    if (['21:30', '22:50', '00:30', '01:00', '01:10', '01:40', '06:00'].includes(t)) await snapAt(D, t);
    if (d === D && t === '01:40') manual140 = 'pending';
    if (manual140 === 'pending') break;
  }
  const logAt = (t) => log.find((x) => x.t === t) || {};
  check('AC-L-02 D-1 21:30 INTRADAY 일정 → 작업 trade_date = D(L-D1 회귀 방지)', (await jobsOf(D)).some((j) => /:INTRADAY:/.test(j.dedupe_key) && j.dedupe_key.endsWith(`${P.replace(/-/g, '')}2130`)) && !(await jobsOf(P)).some((j) => /:INTRADAY:/.test(j.dedupe_key)),
    (await jobsOf(D)).slice(0, 3).map((j) => j.dedupe_key));
  check('AC-L-04 21:30 원천 빈 응답 → WAITING·스냅샷 NOT_YET·호출 5(1시간 뒤 재수집 따로 없음)', at['21:30'].state && at['21:30'].state.state === 'WAITING' && logAt('21:30').calls === 5 && logAt('21:30').ran[0] === 'COLLECT:INTRADAY:NOT_YET:WAITING'
    && !(await jobsOf(D)).some((j) => /:NOTYET:/.test(j.dedupe_key)), { s: at['21:30'], l: logAt('21:30') });
  const trades2250 = at['22:50'].state ? (await q(`SELECT count(*)::int AS n FROM auction_trade WHERE trade_date = $1`, [D]))[0].n : 0;
  check('AC-L-05 22:50(22:42 적재 뒤 첫 폴링) → LIVE·first_row_at 22:50·경락 행 저장', at['22:50'].state && at['22:50'].state.state === 'LIVE' && hhmm(at['22:50'].state.first_row_at) === '22:50' && trades2250 > 0, { s: at['22:50'].state && at['22:50'].state.state, trades2250 });
  check('AC-L-26 같은 슬롯 tick 2개 동시 → 작업 1건·호출 5', at.dual && at.dual.jobs === 1 && at.dual.calls === 5 && at.dual.ran === 1, at.dual);
  check('AC-L-17 폴링 중 외부 503 → 작업 재시도 대기(QUEUED)·판정 시계·마지막 수집 시각·폴링 수 그대로', errProbe && errProbe.ran && errProbe.ran.status === 'QUEUED' && errProbe.ran.kind === 'SERVER_ERROR'
    && JSON.stringify(errProbe.before) === JSON.stringify(errProbe.after), errProbe);
  check('AC-L-06 00:30(00:23 적재 반영, 변화) → LIVE 유지·판정 없음', at['00:30'].state.state === 'LIVE' && hhmm(at['00:30'].state.last_change_at) === '00:30', { s: at['00:30'].state.state, lc: hhmm(at['00:30'].state.last_change_at) });
  const j100 = (await jobsOf(D)).filter((j) => j.params && j.params.nightly_of);
  check('AC-L-07 01:00 → 01:00 배치 1건(창 폴링 작업에 nightly_of 로 합침, INTRADAY — 아직 LIVE)·호출 5·철회 0', at['01:00'].state.state === 'LIVE' && j100.length === 1 && j100[0].phase === 'INTRADAY'
    && logAt('01:00').calls === 5 && j100[0].result && j100[0].result.withdrawn === 0, { j100: j100.map((j) => ({ k: j.dedupe_key, p: j.phase, n: j.params })), l: logAt('01:00') });
  const fin110 = (await jobsOf(D)).filter((j) => j.phase === 'FINAL' && /:FINAL:SETTLED$/.test(j.dedupe_key));
  const rem = await q(`SELECT count(*)::int AS n FROM collect_job WHERE job_type = 'REMATCH' AND trade_date = $1`, [D]);
  check('AC-L-08 01:10(00:30 + 40분, 무변화) → SETTLED(NO_CHANGE)·FINAL 1건 자동 생성·실행(COMPLETE)·REMATCH 생성', at['01:10'].state.state === 'SETTLED' && at['01:10'].state.settle_reason === 'NO_CHANGE'
    && hhmm(at['01:10'].state.settled_at) === '01:10' && fin110.length === 1 && fin110[0].status === 'DONE' && fin110[0].result.snapshot === 'COMPLETE' && rem[0].n >= 1,
  { s: at['01:10'].state && at['01:10'].state.state, fin110: fin110.map((j) => [j.status, j.result && j.result.snapshot]), rem, l: logAt('01:10') });
  check('AC-L-09 01:20·01:30·01:40 → 창 폴링 계획 0·호출 0', ['01:20', '01:30', '01:40'].every((t) => logAt(t).calls === 0 && !(logAt(t).planned || []).length), ['01:20', '01:30', '01:40'].map(logAt));

  // ---------- 지금 받기(R-98·R-96) — 같은 라우트를 시계를 주입한 작은 앱으로(권한 표는 실서버로 따로 검사) ----------
  const express = require('express');
  const { registerAuctionRoutes } = require('../lib/auction/routes');
  const mkRaw = async (n) => (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,'x',NOW(),'active',false) RETURNING id`,
    [`받기${n} ${tag}`, `m${n}_${tag}@test.local`, `m${n}_${tag}`]))[0].id;
  let who = null;
  const app = express();
  app.use(express.json());
  registerAuctionRoutes(app, { pool, getUserId: async () => who, getUserIdAndAdmin: async () => (who ? { userId: who, isAdmin: false, staffId: null } : null), recordAudit: async () => {}, hooks, now: () => clock });
  const MINI = 3174;
  const srv = await new Promise((res) => { const s = app.listen(MINI, '127.0.0.1', () => res(s)); });
  const mini = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${MINI}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  const waitJob = async (id, ms = 10000) => {
    const t0 = Date.now();
    for (;;) {
      const j = (await q(`SELECT status, result FROM collect_job WHERE id = $1`, [id]))[0];
      if (!['QUEUED', 'RUNNING'].includes(j.status) || Date.now() - t0 > ms) return { ...j, ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  {
    // AC-L-10: 01:40 완료 판정(SETTLED, 06:00 확인 전) → "지금 받기" 오늘 → FINAL 실행(ALREADY_COMPLETE 로 건너뛰지 않음), 원천 같으면 변경 0
    who = await mkRaw(1);
    clock = K(D, '01:40');
    const c0 = calls.get(D) || 0;
    const r = await mini('POST', '/api/auction/sync', { date: D });
    const j = r.json.data && r.json.data.queued[0] ? await waitJob(r.json.data.queued[0].id) : null;
    check('AC-L-10 01:40 SETTLED 에서 지금 받기(오늘) → 202 FINAL 1건·즉시 실행·inserted 0·updated 0', r.status === 202 && r.json.data.queued.length === 1 && r.json.data.queued[0].phase === 'FINAL'
      && r.json.data.run_now === true && j && j.status === 'DONE' && j.result.inserted === 0 && j.result.updated === 0 && (calls.get(D) || 0) - c0 === 5, { r: r.json, j });
    check('AC-L-23 지금 받기 → 다음 tick 을 기다리지 않고 10초 안에 DONE', j && j.status === 'DONE' && j.ms < 10000, j && { status: j.status, ms: j.ms });
    const s = await mini('GET', '/api/auction/sync/status');
    const today = s.json.live && s.json.live.find((x) => x.label === 'today');
    check('R-96 live[] 오늘(D) = SETTLED·next_run_at 06:00·last_job FINAL DONE·settle_today D·live_config', s.status === 200 && s.json.settle_today === D && today && today.settle_date === D && today.state === 'SETTLED'
      && hhmm(today.next_run_at) === '06:00' && today.last_job && today.last_job.phase === 'FINAL' && today.last_job.status === 'DONE' && today.rows > 0 && today.running === null
      && s.json.live_config && s.json.live_config.settle_cutover_hour === 21 && s.json.live_config.settle_quiet_min === 40 && s.json.live_config.final_ready_hour === 6, { live: s.json.live, cfg: s.json.live_config });
  }
  // 나머지 시나리오 시각(01:50 → 06:00)
  {
    const idx = times.findIndex(([d, t]) => d === D && t === '01:40');
    for (const [d, t] of times.slice(idx + 1)) {
      const before = calls.get(D) || 0;
      if (d === D && t === '06:00') {
        // AC-L-12: 06:00 확인 수집 전에 정정 1건(05:00 재적재, 단가 변경)
        const rows = timelines.get(D);
        rows[5] = { ...rows[5], scsbd_prc: String(Number(rows[5].scsbd_prc) + 1000), mdfcn_dt: `${D} 05:00:00` };
      }
      const r = await tickAt(d, t);
      log.push({ t, planned: r.planned.map((x) => `${x.job_type}:${x.phase || x.state || ''}:${x.reason || ''}`), ran: r.ran.map((x) => `${x.job_type}:${x.phase || ''}:${x.snapshot || x.status}:${x.day_state || ''}`), calls: (calls.get(D) || 0) - before });
      if (t === '06:00') await snapAt(D, t);
    }
  }
  const nAuto = log.reduce((s, x) => s + x.calls, 0) + (at.dual ? at.dual.calls : 0) + 1; // + 23:00 실패 1호출
  const after2 = log.filter((x) => x.t >= '01:50' && x.t < '06:00');
  check('AC-L-09 01:50~05:50 → 호출 0(02:00 창 종료는 이미 SETTLED 라 변화 없음)', after2.every((x) => x.calls === 0), after2.filter((x) => x.calls));
  check('AC-L-03·11 06:00 → 확인 FINAL(trade_date D) 1회·COMPLETE → CONFIRMED', at['06:00'].state.state === 'CONFIRMED' && hhmm(at['06:00'].state.confirmed_at) === '06:00' && logAt('06:00').calls === 5
    && (await jobsOf(D)).some((j) => j.phase === 'FINAL' && j.params.reason === 'CONFIRM' && j.status === 'DONE'), { s: at['06:00'].state && at['06:00'].state.state, l: logAt('06:00') });
  const r5 = timelines.get(D)[5];
  const rk = `110001|${D}|${r5.corp_cd}|${r5.spm_no}|${r5.auctn_seq}`;
  const rev = await q(`SELECT revision, unit_price FROM auction_trade WHERE source = 'AT_REALTIME' AND source_row_key = $1`, [rk]);
  const hist = rev[0] ? await q(`SELECT count(*)::int AS n FROM auction_trade_history h JOIN auction_trade t ON t.id = h.trade_id WHERE t.source = 'AT_REALTIME' AND t.source_row_key = $1`, [rk]) : [{ n: 0 }];
  check('AC-L-12 06:00 확인에서 정정 1건 → revision+1·이전 값 이력 1', rev[0] && rev[0].revision === 2 && Number(rev[0].unit_price) === Number(timelines.get(D)[5].scsbd_prc) && hist[0].n === 1, { rev, hist });
  {
    const r = await tickAt(D, '11:00');
    check('AC-L-11 11:00 → CONFIRMED 라 FINAL 계획 0·호출 0', !r.planned.some((x) => x.phase === 'FINAL') && !r.ran.some((x) => x.job_type === 'COLLECT'), r);
  }
  check('AC-L-31 하루 자동 호출(21:00~11:00, 실패 1호출 포함) ≤ 175', nAuto <= 175, { nAuto, log: log.map((x) => `${x.t}:${x.calls}`).join(' ') });
  console.log(`NOTE 자동 호출 ${nAuto}회(정산일 D, 한국청과 5단위) — 시각별 ${log.filter((x) => x.calls).map((x) => `${x.t}:${x.calls}`).join(' ')}`);
  {
    // AC-L-10 뒤쪽: 06:00 CONFIRMED 뒤 같은 요청 → 202 skipped ALREADY_COMPLETE
    who = await mkRaw(2);
    clock = K(D, '06:10');
    const r = await mini('POST', '/api/auction/sync', { date: D });
    check('AC-L-10 CONFIRMED 뒤 지금 받기 → 202 skipped ALREADY_COMPLETE·새 작업 0', r.status === 202 && r.json.data.queued.length === 0 && r.json.data.skipped.some((x) => x.reason === 'ALREADY_COMPLETE'), r.json);
  }

  // ---------- early: 01:00 에 이미 SETTLED 인 날 → 01:00 배치가 FINAL 로 1회 ----------
  {
    const E = DS.early;
    const EP = addDays(E, -1);
    for (const t of ['21:00', '22:50', '23:00', '23:10', '23:20', '23:30', '23:40', '23:50', '00:00', '00:10', '00:20', '00:30', '00:40', '00:50', '01:00']) {
      const d = t >= '21:00' ? EP : E;
      await tickAt(d, t);
    }
    const s = await st(E);
    const nj = (await jobsOf(E)).filter((j) => j.dedupe_key.includes(':NIGHTLY:'));
    check('AC-L-13 01:00 에 이미 SETTLED → 01:00 배치 FINAL 1회 실행·결과 같으면 변경 0', s.state === 'SETTLED' && nj.length === 1 && nj[0].phase === 'FINAL' && nj[0].status === 'DONE'
      && nj[0].result.inserted === 0 && nj[0].result.updated === 0 && nj[0].result.withdrawn === 0, { s: s && s.state, settled: hhmm(s && s.settled_at), nj: nj.map((j) => [j.phase, j.status, j.result]) });
    const r2 = await tickAt(E, '01:20');
    check('AC-L-07 01:00 배치는 슬롯마다 1번만(01:20 tick 에 다시 안 넣음)', !r2.planned.some((x) => String(x.reason) === 'NIGHTLY'), r2.planned);
  }

  // ---------- late: 경매가 01:30 까지 → 01:10 판정 없음, 02:00 창 종료 → SETTLED(WINDOW_END) + FINAL ----------
  {
    const L = DS.late;
    const LP = addDays(L, -1);
    const ts = [];
    for (const t of ['22:50', '23:10', '23:30', '23:50']) ts.push([LP, t]);
    for (const t of ['00:30', '00:40', '00:50', '01:00', '01:10', '01:20', '01:30', '01:40', '01:50', '02:00']) ts.push([L, t]);
    const seen = {};
    for (const [d, t] of ts) { await tickAt(d, t); seen[t] = (await st(L)).state; }
    const s = await st(L);
    const fj = (await jobsOf(L)).filter((j) => /:FINAL:SETTLED$/.test(j.dedupe_key));
    check('AC-L-14 01:10 변화(01:05 적재) → 판정 없음, 01:30 변화 뒤 02:00 창 종료 → SETTLED(WINDOW_END)+FINAL 실행', seen['01:10'] === 'LIVE' && seen['01:50'] === 'LIVE' && s.state === 'SETTLED'
      && s.settle_reason === 'WINDOW_END' && hhmm(s.settled_at) === '02:00' && fj.length === 1 && fj[0].status === 'DONE', { seen, s: s && [s.state, s.settle_reason], fj: fj.map((j) => j.status) });
  }

  // ---------- 휴장: 창 안 호출 0·01:00 호출 0·HOLIDAY 스냅샷 1개 ----------
  {
    const H = DS.hol;
    const HP = addDays(H, -1);
    for (const [d, t] of [[HP, '21:00'], [HP, '21:10'], [HP, '23:00'], [H, '00:30'], [H, '01:00'], [H, '01:10'], [H, '02:00'], [H, '06:00']]) await tickAt(d, t);
    const s = await st(H);
    const hs = await q(`SELECT count(*)::int AS n FROM collect_snapshot WHERE trade_date = $1 AND status = 'HOLIDAY'`, [H]);
    check('AC-L-15 휴장일 → 창·01:00·06:00 호출 0·하루 상태 HOLIDAY·HOLIDAY 스냅샷 1개', (calls.get(H) || 0) === 0 && s && s.state === 'HOLIDAY' && hs[0].n === 1, { calls: calls.get(H) || 0, s: s && s.state, hs });
  }

  // ---------- 거래 없음: 창 내내 빈 응답 → 02:00 NO_TRADE, 06:00 확인 빈 응답 → EMPTY 경고 + 다음 날 11:00 재확인 ----------
  {
    const X = DS.empty;
    const XP = addDays(X, -1);
    for (const [d, t] of [[XP, '21:00'], [XP, '23:00'], [X, '01:00'], [X, '01:50'], [X, '02:00']]) await tickAt(d, t);
    const s2 = (await st(X)).state;
    await tickAt(X, '06:00');
    const sn = await q(`SELECT status, verify_warning FROM collect_snapshot WHERE trade_date = $1 AND phase = 'FINAL' ORDER BY id DESC LIMIT 1`, [X]);
    const rc = (await jobsOf(X)).filter((j) => /:FINAL:RECHECK$/.test(j.dedupe_key));
    const r11 = await tickAt(X, '11:00');
    check('AC-L-16 창 내내 빈 응답 → 02:00 NO_TRADE, 06:00 빈 응답 → EMPTY 경고·다음 날 11:00 재확인 1건, 11:00 슬롯 0', s2 === 'NO_TRADE' && (await st(X)).state === 'NO_TRADE'
      && sn[0] && sn[0].status === 'EMPTY' && !!sn[0].verify_warning && rc.length === 1 && hhmm(rc[0] && (await q(`SELECT run_after FROM collect_job WHERE id = $1`, [rc[0].id]))[0].run_after) === '11:00'
      && !r11.planned.some((x) => x.phase === 'FINAL'), { s2, sn, rc: rc.length, r11: r11.planned });
  }

  // ---------- PC 가 밤새 꺼짐 ----------
  {
    const Y = DS.off9;
    const r = await tickAt(Y, '09:00');
    const fj = (await jobsOf(Y)).filter((j) => j.phase === 'FINAL');
    check('AC-L-25 밤새 꺼졌다가 D 09:00 실행 → FINAL 1건(06:00 슬롯)·COMPLETE → CONFIRMED', fj.length === 1 && fj[0].status === 'DONE' && (await st(Y)).state === 'CONFIRMED', { fj: fj.map((j) => [j.dedupe_key, j.status]), planned: r.planned });
    const Z = DS.off18;
    const r2 = await tickAt(Z, '18:00');
    const fz = (await jobsOf(Z)).filter((j) => j.phase === 'FINAL');
    check('AC-L-25 D 18:00 처음 실행(06·11시 슬롯 lookback 밖) → 누락 보정 FINAL 1건(finalReadyAt D 06:00)·CONFIRMED', fz.length === 1 && fz[0].params.reason === 'BACKFILL' && fz[0].status === 'DONE' && (await st(Z)).state === 'CONFIRMED',
      { fz: fz.map((j) => [j.dedupe_key, j.status]), planned: r2.planned });
  }

  // ---------- 지금 받기: 밤 22시·연타·실행 중·5분 제한 ----------
  {
    const N = addDays(D, 140);
    const NP = addDays(N, -1);
    makeTimeline(N);
    for (let i = 1; i <= 8; i += 1) await q(`INSERT INTO collect_snapshot (source, market_code, trade_date, phase, status, finished_at, is_latest_ok) VALUES ('AT_REALTIME','110001',$1,'FINAL','COMPLETE',NOW(),true) ON CONFLICT DO NOTHING`, [addDays(N, -i)]);
    clock = K(NP, '22:00');
    who = await mkRaw(3);
    let r = await mini('POST', '/api/auction/sync', { date: addDays(N, 1) });
    const r2 = await mini('POST', '/api/auction/sync', { date: N });
    check('AC-L-18 D-1 22:00 지금 받기 "오늘 정산분"(D) → 202 INTRADAY(예전 400), D+1 → 400', r.status === 400 && r.json.code === 'VALIDATION' && r2.status === 202 && r2.json.data.queued.length === 1
      && r2.json.data.queued[0].phase === 'INTRADAY' && r2.json.data.settle_today === N, { r: r.json, r2: r2.json });
    if (r2.json.data && r2.json.data.queued[0]) await waitJob(r2.json.data.queued[0].id);
    // 연타: 같은 회원·같은 분 2번 동시
    who = await mkRaw(4);
    const userTap = who;
    const c0 = calls.get(N) || 0;
    const [a, b] = await Promise.all([mini('POST', '/api/auction/sync', { date: N }), mini('POST', '/api/auction/sync', { date: N })]);
    const nj = (await q(`SELECT id FROM collect_job WHERE requested_by_user_id = $1`, [who]));
    if (nj[0]) await waitJob(nj[0].id);
    await new Promise((res) => setTimeout(res, 300));
    check('AC-L-19 버튼 연타(같은 분 동시 2요청) → 작업 1건·둘 다 202·두 번째는 ALREADY_QUEUED/RUNNING·외부 호출 5', a.status === 202 && b.status === 202 && nj.length === 1
      && [a, b].some((x) => x.json.data.skipped.some((y) => ['ALREADY_QUEUED', 'ALREADY_RUNNING'].includes(y.reason))) && (calls.get(N) || 0) - c0 === 5, { a: a.json, b: b.json, nj, calls: (calls.get(N) || 0) - c0 });
    // 스케줄 폴링이 RUNNING 인 날짜
    const fake = (await q(`INSERT INTO collect_job (job_type, source, market_code, trade_date, phase, params, dedupe_key, status, locked_by, locked_at, attempts, started_at)
       VALUES ('COLLECT','AT_REALTIME','110001',$1,'INTRADAY','{"reason":"LIVE_POLL","live":true}',$2,'RUNNING','test-poll',NOW(),1,NOW()) RETURNING id`, [N, `TEST:${tag}:running`]))[0].id;
    who = await mkRaw(5);
    const nBefore = (await q(`SELECT count(*)::int AS n FROM collect_job WHERE trade_date = $1`, [N]))[0].n;
    r = await mini('POST', '/api/auction/sync', { date: N });
    const nAfter = (await q(`SELECT count(*)::int AS n FROM collect_job WHERE trade_date = $1`, [N]))[0].n;
    check('AC-L-20 스케줄 폴링이 RUNNING 인 날짜 → 202 skipped ALREADY_RUNNING + job_id·새 작업 0', r.status === 202 && r.json.data.queued.length === 0
      && r.json.data.skipped.some((x) => x.reason === 'ALREADY_RUNNING' && x.job_id === Number(fake)) && nAfter === nBefore, { r: r.json, nBefore, nAfter });
    const s = await mini('GET', '/api/auction/sync/status');
    const td = s.json.live.find((x) => x.label === 'today');
    check('R-96 live[] 진행 중 작업 표시(running.job_id)·state WAITING(경매 전)·next_run_at 22:10', td && td.settle_date === N && td.running && td.running.job_id === Number(fake) && td.state === 'WAITING' && hhmm(td.next_run_at) === '22:10', td);
    await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW(), locked_by = NULL, locked_at = NULL WHERE id = $1`, [fake]);
    // 5분 안 다른 날짜(어제) — 방금 작업을 만든 회원(연타 검사)
    who = userTap;
    r = await mini('POST', '/api/auction/sync', { date: NP });
    check('AC-L-21 5분 안 다른 날짜(어제) → 429 SYNC_RATE_LIMIT·retry_after_sec > 0', r.status === 429 && r.json.code === 'SYNC_RATE_LIMIT' && r.json.detail.retry_after_sec > 0, r.json);
    // 어제 정산분은 FINAL
    who = await mkRaw(6);
    r = await mini('POST', '/api/auction/sync', { date: NP });
    check('R-98 어제 정산분 → FINAL', r.status === 202 && (r.json.data.queued[0] ? r.json.data.queued[0].phase === 'FINAL' : r.json.data.skipped.length > 0), r.json);
    if (r.json.data && r.json.data.queued[0]) await waitJob(r.json.data.queued[0].id);
  }
  await new Promise((res) => srv.close(res));

  // ---------- 권한(실서버 3171): 조회 직원 POST 403·비로그인 401·상태는 직원도 200 ----------
  {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    const cr = await api('POST', '/api/staff', { login_id: 'vw1', name: '직원vw1', role: 'view', temp_password: spw }, O.tok);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = 'vw1'`, [O.id]);
    const sv = (await api('POST', '/api/auth/login', { agent_no: O.agent, login_id: 'vw1', password: spw })).json.token;
    const r1 = await api('POST', '/api/auction/sync', { date: '2026-11-01' }, sv);
    const r2 = await api('POST', '/api/auction/sync', { date: '2026-11-01' });
    const r3 = await api('GET', '/api/auction/sync/status', null, sv);
    check('AC-L-22 조회 직원 지금 받기 403·비로그인 401·수집 상태는 직원도 200(live·settle_today)', cr.status < 300 && r1.status === 403 && r2.status === 401 && r3.status === 200 && Array.isArray(r3.json.live)
      && r3.json.live.length === 2 && !!r3.json.settle_today && r3.json.corp_scope === undefined, { cr: cr.status, r1: r1.status, r2: r2.status, r3: r3.status, live: r3.json.live && r3.json.live.length });
  }

  // ---------- 지휘 AI ①: R-138·R-139 경락 원래 값·환산 근거 ----------
  {
    const DT = addDays(D, 160);
    const pid = (await api('POST', '/api/partners', { name: `한국청과 ${tag}`, type: 'supplier' }, O.tok)).json?.data?.id;
    const prod = (await q(`SELECT id, unit FROM product WHERE owner_user_id IS NULL AND name = '청양고추'`))[0];
    const l1 = await api('PUT', '/api/auction/corp-links', { links: [{ corp_code: '11000105', partner_id: pid }] }, O.tok);
    const l2 = await api('PUT', '/api/auction/product-links', { links: [{ item_key: 'PEPPER.CHEONGYANG', product_id: prod.id }] }, O.tok);
    const sid = (await q(`INSERT INTO collect_snapshot (source, market_code, trade_date, phase, status, finished_at, is_latest_ok) VALUES ('AT_REALTIME','110001',$1,'FINAL','COMPLETE',NOW(),true) RETURNING id`, [DT]))[0].id;
    const ship = String(crypto.randomInt(100000000, 999999999));
    const tid = (await q(`INSERT INTO auction_trade (source, source_row_key, trade_date, auction_at, market_code, market_name, corp_code, corp_name, item_name_raw, item_key, map_status, grade_name, grade_norm,
         pkg_name, pkg_norm, unit_qty_kg, weight_source, qty, unit_price, price_per_kg, amount, origin_name, auction_seq, shipment_no, snapshot_id, content_hash)
       VALUES ('AT_REALTIME', $1, $2, $3, '110001', '서울가락', '11000105', '한국청과㈜', '청양', 'PEPPER.CHEONGYANG', 'MAPPED', '상', 'HIGH', '상자', 'BOX', 6.000, 'SOURCE', 1, 33600, 5600.00, 33600, '경북 영양', '1', $4, $5, $6) RETURNING id`,
    [`110001|${DT}|11000105|${ship}|1`, DT, `${DT}T23:10:00+09:00`, ship, sid, 'y'.repeat(64)]))[0].id;
    const pv = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [Number(tid)] }, O.tok);
    const row = pv.json.data && pv.json.data.rows && pv.json.data.rows[0];
    check('지휘① R-138 미리보기: 금액 규칙 그대로(0.6 × 56,000 = 33,600) + trade_original(1 상자 6kg × 33,600) + unit_basis(10kg ↔ 6kg, factor 0.6)',
      l1.status === 200 && l2.status === 200 && pv.status === 200 && row && row.result === 'WILL_CONVERT' && Number(row.quantity) === 0.6 && Number(row.unit_price) === 56000 && Number(row.total) === 33600
      && row.trade_original && Number(row.trade_original.qty) === 1 && row.trade_original.pkg_name === '상자' && Number(row.trade_original.unit_qty_kg) === 6 && Number(row.trade_original.unit_price) === 33600
      && Number(row.trade_original.amount) === 33600 && row.unit_basis && row.unit_basis.product_unit === '10kg' && Number(row.unit_basis.product_unit_kg) === 10 && Number(row.unit_basis.trade_unit_kg) === 6
      && row.unit_basis.factor === '0.6' && row.unit_basis.same_unit === false && row.unit_basis.rule === 'KG_RATIO', { status: pv.status, json: pv.json });
    const cv = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [Number(tid)] }, O.tok, { 'idempotency-key': `k_${crypto.randomBytes(9).toString('hex')}` });
    const cr = cv.json.data && cv.json.data.results && cv.json.data.results[0];
    check('지휘① R-139 결과: CONVERTED + trade_original·unit_basis 같은 값·매입 금액 33,600', cv.status === 200 && cr && cr.result === 'CONVERTED' && Number(cr.total) === 33600
      && cr.trade_original && Number(cr.trade_original.unit_qty_kg) === 6 && cr.unit_basis && cr.unit_basis.factor === '0.6', { status: cv.status, json: cv.json });
    const pv2 = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [Number(tid)] }, O.tok);
    const r2 = pv2.json.data && pv2.json.data.rows[0];
    check('지휘① 전환 뒤 미리보기 ALREADY_CONVERTED 줄에도 trade_original', r2 && r2.result === 'ALREADY_CONVERTED' && r2.trade_original && Number(r2.trade_original.unit_price) === 33600, r2);
  }

  // ---------- AC-L-30 033 두 번 적용·사용자가 바꾼 일정 행 그대로 ----------
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '033_t203_live_collect.sql'), 'utf8');
    const c = await pool.connect();
    let ok = false;
    let detail = null;
    try {
      await c.query('BEGIN');
      await c.query(`UPDATE collect_schedule SET cron_text = '*/5 22-23 * * *', updated_by_user_id = $1 WHERE job_type = 'COLLECT_INTRADAY' AND source = 'AT_REALTIME'`, [O.id]);
      await c.query(`UPDATE collect_schedule SET cron_text = '0 * * * *', updated_by_user_id = NULL WHERE job_type = 'COLLECT_FINAL' AND source = 'AT_REALTIME'`);
      const before = (await c.query(`SELECT count(*)::int AS n FROM collect_schedule`)).rows[0].n;
      await c.query(sql);
      await c.query(sql);
      const rows = (await c.query(`SELECT job_type, cron_text FROM collect_schedule WHERE source = 'AT_REALTIME' ORDER BY job_type`)).rows;
      const by = Object.fromEntries(rows.map((x) => [x.job_type, x.cron_text]));
      const after = (await c.query(`SELECT count(*)::int AS n FROM collect_schedule`)).rows[0].n;
      ok = by.COLLECT_INTRADAY === '*/5 22-23 * * *' && by.COLLECT_FINAL === '0 6,11 * * *' && by.COLLECT_NIGHTLY === '0 1 * * *' && by.COLLECT_WINDOW_END === '0 2 * * *' && before === after;
      detail = { by, before, after };
    } catch (e) { detail = e.message; } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
    check('AC-L-30 033 두 번 더 적용 오류 0·사용자가 바꾼 행(updated_by_user_id) 그대로·기본 행만 갱신·행 수 그대로', ok, detail);
  }

  // 정리: 일정 되돌림·남은 대기 작업 취소
  for (const x of schBefore) await q(`UPDATE collect_schedule SET cron_text = $3, active = $4 WHERE job_type = $1 AND source = $2`, [x.job_type, x.source, x.cron_text, x.active]);
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE status = 'QUEUED'`);

  await pool.end();
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n[t203-live-collect-test] ${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[t203-live-collect-test] 예외:', e); process.exit(1); });
