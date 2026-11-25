/**
 * T-203 경매 직후 수집 — C(테스트) 독립 검사. B 테스트(t203-live-collect-test)와 겹치지 않는 경계·공격 위주.
 *   A. 시계 주입(이 프로세스에서 scheduler·worker·작은 앱): 날짜 경계(연말·월말·윤년·UTC 자정·env), 밤새 꺼졌다가 06:00 첫 실행,
 *      창 중간(01:30) 첫 실행, 20:59/21:00 경계의 R-96 settle_today·live[]·R-98 상한
 *   B. 실서버(MATCH_API_BASE, 실제 시계·목업 소스): 권한 표, 입력 방어, 버튼 연타(동시 5개), 5분 제한, 다른 날짜 동시 요청, C-CV-01
 * 사용: server 폴더에서 DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> node scripts/t203-live-collect-c-test.js
 * 테스트 DB 전용, 실 API 호출 없음. 기존 일정은 끝나면 되돌리고, 이 검사가 넣은 대기 작업은 취소한다.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
require('../lib/db-config');

process.env.AUCTION_CORP_CODES = '11000105';
delete process.env.AUCTION_ITEM_COMBOS;
const SAMPLE = process.env.T203_SAMPLE_JSON
  || path.join(__dirname, '..', '..', '..', '..', 'Resume', 'AI Project', 'work', '2026-11-24_garak-purchase-match', '산출물', '실데이터_샘플', '가락_20261124_고추파프리카_2009건.json');
const BASE = process.env.MATCH_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
const MINI = Number(process.env.C_MINI_PORT || 3195);
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) { console.error('로컬 테스트 DB 에서만 실행합니다.'); process.exit(2); }

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` — ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`}`);
}
function note(s) { console.log(`NOTE ${s}`); }
async function api(method, p, body, token, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _text: text.slice(0, 200) }; }
  return { status: r.status, json: j, headers: r.headers };
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const tag = `c${Date.now().toString(36)}`;
  const worker = require('../lib/auction/worker');
  const scheduler = require('../lib/auction/scheduler');
  const circuit = require('../lib/auction/circuit');
  const { AtRealtimeAdapter } = require('../lib/auction/adapters');
  const { addDays } = worker;
  const K = (ymd, hm) => new Date(Date.parse(`${ymd}T${hm}+09:00`));
  const hhmm = (d) => (d ? new Date(new Date(d).getTime() + 9 * 3600 * 1000).toISOString().slice(11, 16) : null);
  const createdJobsFrom = (await q(`SELECT COALESCE(MAX(id),0)::bigint AS m FROM collect_job`))[0].m;

  // ================= A1 settleDateOf 경계 =================
  {
    const cases = [
      ['2026-12-31', '20:59:59', '2026-12-31'], ['2026-12-31', '21:00:00', '2027-01-01'], ['2027-01-01', '00:30:00', '2027-01-01'],
      ['2026-11-30', '21:00:00', '2026-12-01'], ['2028-02-28', '21:00:00', '2028-02-29'], ['2028-02-29', '21:00:00', '2028-03-01'],
      ['2026-11-25', '08:59:59', '2026-11-25'], ['2026-11-25', '09:00:00', '2026-11-25'], // UTC 자정 전후
      ['2026-11-24', '20:59:59.999', '2026-11-24'],
    ];
    const bad = cases.filter(([d, t, w]) => worker.settleDateOf(K(d, t)) !== w).map(([d, t, w]) => ({ d, t, w, got: worker.settleDateOf(K(d, t)) }));
    check('C-L-01 settleDateOf 경계: 연말 21:00 → 다음 해 1/1, 월말·윤년 2/29, UTC 자정(KST 09:00) 전후, 20:59:59.999', bad.length === 0, bad);
    const e18 = { AUCTION_SETTLE_CUTOVER_HOUR: '18' };
    const envCases = [
      [worker.settleDateOf(K('2026-11-24', '18:00:00'), e18), '2026-11-25'], [worker.settleDateOf(K('2026-11-24', '17:59:00'), e18), '2026-11-24'],
      [worker.settleDateOf(K('2026-11-24', '21:00:00'), { AUCTION_SETTLE_CUTOVER_HOUR: '25' }), '2026-11-25'],
      [worker.settleDateOf(K('2026-11-24', '21:00:00'), { AUCTION_SETTLE_CUTOVER_HOUR: 'abc' }), '2026-11-25'],
      [worker.settleDateOf(K('2026-11-24', '20:00:00'), { AUCTION_SETTLE_CUTOVER_HOUR: '-1' }), '2026-11-24'],
    ];
    check('C-L-02 env AUCTION_SETTLE_CUTOVER_HOUR=18 이면 18시 경계, 범위 밖·문자(25·abc·-1)는 기본 21', envCases.every(([g, w]) => g === w), envCases);
    const lc = worker.liveConfig({ AUCTION_LIVE_SETTLE_MIN: '5', AUCTION_LIVE_START_HOUR: 'x', AUCTION_LIVE_END_HOUR: '30' });
    check('C-L-03 liveConfig 잘못된 값(판정 5분 < 하한 10·문자·30시) → 기본값(40분·21시·2시)', lc.settleMin === 40 && lc.startHour === 21 && lc.endHour === 2, lc);
    check('C-L-04 finalReadyAt(2027-01-01) = 2027-01-01 06:00 KST(연초)', worker.finalReadyAt('2027-01-01').toISOString() === '2026-12-31T21:00:00.000Z', worker.finalReadyAt('2027-01-01'));
  }

  // ================= 준비: 시간표 어댑터 =================
  const SAMPLE_DATE = '2026-11-24';
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).filter((r) => r.corp_cd === '11000105');
  const shiftStr = (v, n) => (v ? addDays(String(v).slice(0, 10), n) + String(v).slice(10) : v);
  const timelines = new Map();
  const calls = new Map();
  const mkTimeline = (D) => {
    const n = Math.round((Date.parse(`${D}T00:00:00Z`) - Date.parse(`${SAMPLE_DATE}T00:00:00Z`)) / 86400000);
    timelines.set(D, sample.map((r) => ({ ...r, trd_clcln_ymd: D, scsbd_dt: shiftStr(r.scsbd_dt, n), mdfcn_dt: shiftStr(r.mdfcn_dt, n) })));
  };
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
      const now = clock.getTime();
      const mine = (timelines.get(D) || []).filter((r) => (!params.corpCode || r.corp_cd === params.corpCode) && (!params.itemL || r.gds_lclsf_cd === params.itemL)
        && (!params.itemM || r.gds_mclsf_cd === params.itemM) && Date.parse(`${r.mdfcn_dt.replace(' ', 'T')}+09:00`) <= now);
      const size = Number(params.numOfRows) || 1000;
      const body = JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: { item: mine.slice((pageNo - 1) * size, pageNo * size) }, numOfRows: size, pageNo, totalCount: mine.length } } });
      return real.interpret({ status: 200, body, headers: {}, durationMs: 0 }, { masked, pageNo, requestParams });
    }
  }
  const hooks = { now: () => clock, createAdapter: (source, opts) => (source === 'AT_REALTIME' ? new TimelineAdapter() : require('../lib/auction/adapters').createAdapter(source, opts)) };
  const tickAt = async (d, t) => { clock = K(d, `${t}:00`); return scheduler.tick(pool, { hooks, maxJobs: 5, budgetMs: 60000 }); };
  const st = async (D) => worker.dayState(pool, { source: 'AT_REALTIME', market: '110001', date: D });
  const jobsOf = async (D) => q(`SELECT id, phase, status, dedupe_key, params, result FROM collect_job WHERE job_type = 'COLLECT' AND trade_date = $1 ORDER BY id`, [D]);

  // 일정: 수집 4종만(033 기본값). 끝나면 되돌림
  const schBefore = await q(`SELECT job_type, source, cron_text, active FROM collect_schedule`);
  await q(`UPDATE collect_schedule SET active = false`);
  for (const [jt, cron] of [['COLLECT_INTRADAY', '*/10 21-23,0-1 * * *'], ['COLLECT_NIGHTLY', '0 1 * * *'], ['COLLECT_WINDOW_END', '0 2 * * *'], ['COLLECT_FINAL', '0 6,11 * * *']]) {
    await q(`UPDATE collect_schedule SET active = true, cron_text = $2 WHERE job_type = $1 AND source = 'AT_REALTIME'`, [jt, cron]);
  }
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE status = 'QUEUED'`);
  await circuit.reset(pool, 'AT_REALTIME');
  // 테스트 정산일: 2036~2039 무작위(B 테스트 2031~2035 와 겹치지 않게)
  const base = addDays('2036-02-01', crypto.randomInt(0, 900));
  const DS = { off6: base, mid: addDays(base, 20), edge: addDays(base, 40) };
  const YY = 2040 + crypto.randomInt(0, 400); // 연말 경계 연도 무작위(다시 실행해도 같은 dedupe 키를 쓰지 않게)
  const YE = `${YY + 1}-01-01`;
  console.log(`[t203-live-collect-c-test] 정산일 ${JSON.stringify(DS)} tag ${tag}`);
  for (const x of Object.values(DS)) {
    mkTimeline(x);
    for (let i = 1; i <= 8; i += 1) {
      await q(`INSERT INTO collect_snapshot (source, market_code, trade_date, phase, status, finished_at, is_latest_ok) VALUES ('AT_REALTIME','110001',$1,'FINAL','COMPLETE',NOW(),true) ON CONFLICT DO NOTHING`, [addDays(x, -i)]);
    }
  }

  try {
    // ================= A2 밤새 꺼졌다가 06:00 첫 실행 =================
    {
      const D = DS.off6;
      const c0 = calls.get(D) || 0;
      const r = await tickAt(D, '06:00');
      const js = await jobsOf(D);
      const s = await st(D);
      const fin = js.filter((j) => j.phase === 'FINAL');
      const intra = js.filter((j) => j.phase === 'INTRADAY');
      check('C-L-05 밤새 꺼짐 → D 06:00 첫 실행: FINAL 1건(01:00 배치는 그 작업에 nightly_of 로 합침)·INTRADAY 0·호출 5·CONFIRMED',
        fin.length === 1 && intra.length === 0 && fin[0].status === 'DONE' && fin[0].params.nightly_of && (calls.get(D) || 0) - c0 === 5 && s && s.state === 'CONFIRMED',
        { js: js.map((j) => [j.phase, j.status, j.dedupe_key, j.params]), s: s && s.state, calls: (calls.get(D) || 0) - c0, planned: r.planned });
      const r2 = await tickAt(D, '06:10');
      const r3 = await tickAt(D, '11:00');
      check('C-L-06 06:00 CONFIRMED 뒤 06:10·11:00 → 계획 0·호출 0', r2.planned.length === 0 && r3.planned.length === 0 && (calls.get(D) || 0) - c0 === 5, { p2: r2.planned, p3: r3.planned });
    }

    // ================= A3 창 중간(01:30) 첫 실행 =================
    {
      const D = DS.mid;
      const c0 = calls.get(D) || 0;
      const r = await tickAt(D, '01:30');
      const js = await jobsOf(D);
      const s = await st(D);
      check('C-L-07 창 중간 D 01:30 첫 실행: 창 폴링 1건(01:00 배치 nightly_of 합침)·호출 5·LIVE', js.length === 1 && js[0].phase === 'INTRADAY' && js[0].params.nightly_of
        && (calls.get(D) || 0) - c0 === 5 && s && s.state === 'LIVE', { js: js.map((j) => [j.phase, j.status, j.params]), s: s && s.state, planned: r.planned });
      await tickAt(D, '01:40'); await tickAt(D, '01:50');
      const r200 = await tickAt(D, '02:00');
      const s2 = await st(D);
      const fin = (await jobsOf(D)).filter((j) => j.phase === 'FINAL');
      check('C-L-08 01:30 부터 매 폴링이 무변화여도 40분 전(02:00)이면 창 종료 → SETTLED(WINDOW_END)+FINAL 1건 DONE, 아직 CONFIRMED 아님(06:00 전)',
        s2.state === 'SETTLED' && s2.settle_reason === 'WINDOW_END' && fin.length === 1 && fin[0].status === 'DONE', { s: s2.state, reason: s2.settle_reason, fin: fin.map((j) => j.status), r: r200.planned });
      const c1 = calls.get(D) || 0;
      for (const t of ['02:10', '03:00', '05:50']) await tickAt(D, t); // eslint-disable-line no-await-in-loop
      check('C-L-09 창 종료 뒤 02:10~05:50 호출 0', (calls.get(D) || 0) === c1, (calls.get(D) || 0) - c1);
      await tickAt(D, '06:00');
      check('C-L-10 06:00 확인 FINAL → CONFIRMED', (await st(D)).state === 'CONFIRMED', (await st(D)).state);
    }

    // ================= A4 연말 경계 계획 =================
    {
      clock = K(`${YY}-12-31`, '21:30:00');
      const p = await scheduler.planDue(pool, clock);
      const intra = p.filter((x) => x.job_type === 'COLLECT');
      check('C-L-11 (무작위 연도) 12-31 21:30 창 폴링 계획 → trade_date 다음 해 01-01(연도 넘김)', intra.length >= 1 && intra.every((x) => x.trade_date === YE), p);
      await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE status = 'QUEUED' AND trade_date = $1`, [YE]);
      clock = K(`${YY}-12-31`, '20:50:00');
      const p2 = await scheduler.planDue(pool, clock);
      check('C-L-12 (같은 연도) 12-31 20:50(창 밖) → 수집 계획 0', p2.filter((x) => x.job_type === 'COLLECT').length === 0, p2);
    }

    // ================= A5 20:59 / 21:00 경계의 R-96·R-98 (작은 앱, 시계 주입) =================
    {
      const express = require('express');
      const { registerAuctionRoutes } = require('../lib/auction/routes');
      const D = DS.off6; // CONFIRMED 인 날
      const who = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,'x',NOW(),'active',false) RETURNING id`,
        [`C경계 ${tag}`, `cb_${tag}@test.local`, `cb_${tag}`]))[0].id;
      const app = express();
      app.use(express.json());
      registerAuctionRoutes(app, { pool, getUserId: async () => who, getUserIdAndAdmin: async () => ({ userId: who, isAdmin: false, staffId: null }), recordAudit: async () => {}, hooks, now: () => clock });
      const srv = await new Promise((res) => { const s = app.listen(MINI, '127.0.0.1', () => res(s)); });
      const mini = async (method, p, body) => {
        const r = await fetch(`http://127.0.0.1:${MINI}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json() };
      };
      try {
        clock = K(D, '20:59:00');
        const a = await mini('GET', '/api/auction/sync/status');
        clock = K(D, '21:00:00');
        const b = await mini('GET', '/api/auction/sync/status');
        const l0 = b.json.live && b.json.live[0];
        check('C-L-13 R-96 D 20:59 → settle_today D·today=D(CONFIRMED, next null) / 21:00 → settle_today D+1·today=D+1 경매 전·yesterday=D CONFIRMED',
          a.json.settle_today === D && a.json.live[0].settle_date === D && a.json.live[0].state === 'CONFIRMED' && a.json.live[0].next_run_at === null
          && b.json.settle_today === addDays(D, 1) && l0.settle_date === addDays(D, 1) && l0.label === 'today' && l0.state === 'WAITING' && l0.state_recorded === false
          && b.json.live[1].settle_date === D && b.json.live[1].state === 'CONFIRMED',
          { a: a.json.settle_today, a0: a.json.live && a.json.live[0], b: b.json.settle_today, b0: l0, b1: b.json.live && b.json.live[1] });
        check('C-L-14 R-96 21:00 오늘 정산분 다음 수집 = 21:10(창 10분 폴링)', hhmm(l0.next_run_at) === '21:10', l0.next_run_at);
        clock = K(D, '20:59:00');
        const f1 = await mini('POST', '/api/auction/sync', { date: addDays(D, 1) });
        clock = K(D, '21:00:00');
        const f3 = await mini('POST', '/api/auction/sync', { date: addDays(D, 2) });
        const f2 = await mini('POST', '/api/auction/sync', { date: addDays(D, 1) });
        check('C-L-15 R-98 상한 경계: 20:59 에 D+1 → 400, 21:00 에 D+2 → 400, 21:00 에 D+1 → 202 INTRADAY',
          f1.status === 400 && f3.status === 400 && f2.status === 202 && f2.json.data.queued.length === 1 && f2.json.data.queued[0].phase === 'INTRADAY' && f2.json.data.settle_today === addDays(D, 1),
          { f1: f1.status, f3: f3.status, f2: f2.json });
        // 즉시 실행 작업이 끝날 때까지 기다림(서버를 닫기 전에)
        for (let i = 0; i < 50; i += 1) {
          const left = await q(`SELECT 1 FROM collect_job WHERE trade_date = $1 AND status IN ('QUEUED','RUNNING')`, [addDays(D, 1)]); // eslint-disable-line no-await-in-loop
          if (!left.length) break;
          await new Promise((r) => setTimeout(r, 200)); // eslint-disable-line no-await-in-loop
        }
      } finally { await new Promise((res) => srv.close(res)); }
    }
  } finally {
    for (const s of schBefore) await q(`UPDATE collect_schedule SET cron_text = $3, active = $4 WHERE job_type = $1 AND source = $2`, [s.job_type, s.source, s.cron_text, s.active]); // eslint-disable-line no-await-in-loop
    await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE status = 'QUEUED' AND id > $1`, [createdJobsFrom]);
  }

  // ================= B 실서버(실제 시계·목업 소스) =================
  const mkUser = async (name, agent) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const id = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,$4,NOW(),'active',false) RETURNING id`,
      [name, `${agent}@test.local`, agent, await bcrypt.hash(pw, 8)]))[0].id;
    const tok = (await api('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
    if (!tok) throw new Error(`로그인 실패 ${agent}`);
    return { id, tok, agent };
  };
  const mkStaff = async (O, login, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    const cr = await api('POST', '/api/staff', { login_id: login, name: `직원${login}`, role, temp_password: spw }, O.tok);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [O.id, login]);
    const t = (await api('POST', '/api/auth/login', { agent_no: O.agent, login_id: login, password: spw })).json.token;
    return { cr: cr.status, tok: t };
  };
  const today = worker.settleDateOf(new Date());
  const yest = addDays(today, -1);
  const O1 = await mkUser(`C수집1 ${tag}`, `c1_${tag}`);
  const O2 = await mkUser(`C수집2 ${tag}`, `c2_${tag}`);
  const O3 = await mkUser(`C수집3 ${tag}`, `c3_${tag}`);
  const vw = await mkStaff(O1, 'cvw', 'view');
  const inp = await mkStaff(O1, 'cin', 'input');
  const jobCount = async (uid) => (await q(`SELECT count(*)::int AS n FROM collect_job WHERE requested_by_user_id = $1`, [uid]))[0].n;
  const waitJobs = async (uid, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await q(`SELECT id, status, phase, trade_date, result FROM collect_job WHERE requested_by_user_id = $1 ORDER BY id`, [uid]); // eslint-disable-line no-await-in-loop
      if (r.every((j) => !['QUEUED', 'RUNNING'].includes(j.status)) || Date.now() - t0 > ms) return { jobs: r, ms: Date.now() - t0 };
      await new Promise((x) => setTimeout(x, 150)); // eslint-disable-line no-await-in-loop
    }
  };

  // B1 R-96
  {
    const o = await api('GET', '/api/auction/sync/status', null, O1.tok);
    const v = await api('GET', '/api/auction/sync/status', null, vw.tok);
    const n = await api('GET', '/api/auction/sync/status');
    check(`C-L-16 R-96 주인·조회 직원 200(settle_today=${today}·live 2개 today/yesterday·corp_scope 없음), 비로그인 401`,
      o.status === 200 && v.status === 200 && n.status === 401 && o.json.settle_today === today && v.json.settle_today === today
      && o.json.live.map((x) => `${x.label}:${x.settle_date}`).join(',') === `today:${today},yesterday:${yest}` && o.json.corp_scope === undefined && v.json.corp_scope === undefined
      && o.json.live_config && o.json.live_config.settle_quiet_min === 40, { o: o.status, v: v.status, n: n.status, st: o.json.settle_today, live: o.json.live && o.json.live.map((x) => [x.label, x.settle_date, x.state]) });
  }
  // B2 권한
  {
    const c0 = await jobCount(O1.id);
    const a = await api('POST', '/api/auction/sync', { date: today }, vw.tok);
    const b = await api('POST', '/api/auction/sync', { date: today }, inp.tok);
    const c = await api('POST', '/api/auction/sync', { date: today });
    const d = await api('POST', '/api/auction/sync', { date: today }, 'x.y.z');
    check('C-L-17 R-98 권한: 조회 직원 403·입력 직원 403·비로그인 401·위조 토큰 401, 작업 0', vw.cr < 300 && inp.cr < 300 && a.status === 403 && b.status === 403 && c.status === 401 && d.status === 401
      && (await jobCount(O1.id)) === c0, { vw: vw.cr, inp: inp.cr, a: a.status, b: b.status, c: c.status, d: d.status });
  }
  // B3 입력 방어
  {
    const n0 = (await q(`SELECT count(*)::int AS n FROM collect_job`))[0].n;
    const bad = [
      { date: 'abc' }, { date: '2026-13-01' }, { date: '2026-02-30' }, { date: `${today}' OR 1=1--` }, { date: addDays(today, 1) },
      { date_from: today, date_to: yest }, { date_from: addDays(today, -31), date_to: today }, { date: today, phase: 'X' }, { date: today, source: 'X' },
      { date: { $gt: '' } }, { date: '２０２６-11-25' }, { date: [addDays(today, 1)] },
    ];
    const rs = [];
    for (const b of bad) rs.push((await api('POST', '/api/auction/sync', b, O1.tok)).status); // eslint-disable-line no-await-in-loop
    const n1 = (await q(`SELECT count(*)::int AS n FROM collect_job`))[0].n;
    check('C-L-18 R-98 입력 방어 12종(형식·없는 날짜·인젝션·미래·역순·32일·phase·source·객체·전각·미래 날짜 배열) → 모두 400·작업 0', rs.every((s) => s === 400) && n1 === n0, { rs, added: n1 - n0 });
  }
  // B4 버튼 연타(같은 날짜 동시 5개)
  {
    const rs = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/api/auction/sync', { date: today }, O2.tok)));
    const w = await waitJobs(O2.id);
    const queued = rs.flatMap((r) => (r.json.data ? r.json.data.queued : []));
    const skipped = rs.flatMap((r) => (r.json.data ? r.json.data.skipped : []));
    check('C-L-19 버튼 연타(오늘 정산분 동시 5개) → 모두 202·작업 1건·나머지 4건 skipped(ALREADY_QUEUED/RUNNING)·즉시 실행 DONE(15초 안)',
      rs.every((r) => r.status === 202) && w.jobs.length === 1 && queued.length === 1 && skipped.length === 4 && skipped.every((s) => ['ALREADY_QUEUED', 'ALREADY_RUNNING'].includes(s.reason))
      && w.jobs[0].status === 'DONE' && w.jobs[0].phase === 'INTRADAY', { st: rs.map((r) => r.status), queued, skipped, w });
    const skipNoId = skipped.filter((s) => s.reason === 'ALREADY_QUEUED' && s.job_id == null).length;
    note(`연타 skipped 중 job_id 없는 ALREADY_QUEUED ${skipNoId}건(H 개발 요청 1과 같은 현상)`);
    const r = await api('POST', '/api/auction/sync', { date: yest }, O2.tok);
    check('C-L-20 5분 안 다른 날짜(어제 정산분) → 429 SYNC_RATE_LIMIT·0<retry_after_sec≤300·작업 그대로 1건', r.status === 429 && r.json.code === 'SYNC_RATE_LIMIT'
      && r.json.detail.retry_after_sec > 0 && r.json.detail.retry_after_sec <= 300 && (await jobCount(O2.id)) === 1, { st: r.status, j: r.json });
    const s = await api('GET', '/api/auction/sync/status', null, O2.tok);
    const t0 = s.json.live && s.json.live[0];
    check('C-L-21 받기 뒤 R-96 today.last_job = 방금 작업(MANUAL·DONE)·running null', t0 && t0.last_job && t0.last_job.job_id === Number(w.jobs[0].id) && t0.last_job.reason === 'MANUAL'
      && t0.last_job.status === 'DONE' && t0.running === null, t0);
  }
  // B5 다른 날짜 동시 요청(5분 1회 제한의 경합) — 둘 다 확정 스냅샷이 없는 지난 날짜(ALREADY_COMPLETE 로 빠지지 않게)
  {
    const free = [];
    for (let i = 2; i < 30 && free.length < 2; i += 1) {
      const d = addDays(today, -i);
      const done = await q(`SELECT 1 FROM collect_snapshot WHERE trade_date = $1 AND is_latest_ok AND status = 'COMPLETE' LIMIT 1`, [d]); // eslint-disable-line no-await-in-loop
      if (!done.length) free.push(d);
    }
    note(`C-L-22 대상 날짜 ${free.join(',')}`);
    const rs = await Promise.all(free.map((d) => api('POST', '/api/auction/sync', { date: d }, O3.tok)));
    const w = await waitJobs(O3.id);
    const st2 = rs.map((r) => r.status).sort().join(',');
    check('C-L-22 같은 주인이 다른 지난 날짜 2개를 동시에 요청 → 5분 1회 제한대로 작업 1건(다른 하나는 429)', free.length === 2 && w.jobs.length === 1 && st2 === '202,429',
      { st: rs.map((r) => [r.status, r.json.code || r.json.data]), jobs: w.jobs.map((j) => [j.trade_date, j.phase, j.status]) });
  }
  // B5b 배열 날짜(관찰 — 지난 날짜 1개짜리 배열)
  {
    const O4 = await mkUser(`C수집4 ${tag}`, `c4_${tag}`);
    const r = await api('POST', '/api/auction/sync', { date: [addDays(today, -40)] }, O4.tok);
    note(`date 배열 ['${addDays(today, -40)}'] → ${r.status} ${JSON.stringify(r.json.data || r.json).slice(0, 160)} (String() 변환으로 문자열과 같게 처리. 미래 날짜 배열은 C-L-18 에서 400)`);
    await waitJobs(O4.id);
  }
  // B6 C-CV-01
  {
    const r = await api('GET', `/api/auction/trades?date_from=${yest}&date_to=${today}`, null, O1.tok);
    const etag = r.headers.get('etag');
    const s304 = etag ? await new Promise((res, rej) => {
      const u = new URL(`${BASE}/api/auction/trades?date_from=${yest}&date_to=${today}`);
      require('http').get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { authorization: `Bearer ${O1.tok}`, 'if-none-match': etag } }, (x) => { x.resume(); res(x.statusCode); }).on('error', rej);
    }) : null;
    check('C-L-23 C-CV-01 R-92 Cache-Control = private, no-cache·ETag 재확인 304', r.status === 200 && r.headers.get('cache-control') === 'private, no-cache' && !!etag && s304 === 304,
      { st: r.status, cc: r.headers.get('cache-control'), etag, s304 });
  }

  await pool.end();
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n[t203-live-collect-c-test] ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
