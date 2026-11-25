/**
 * T-203 로컬 단독 수집 1회 — Windows 작업 스케줄러가 10분마다 부른다(A 설계 6절 권고 (b)). 서버·화면을 띄워 두지 않아도 된다.
 *
 *  ① DB 확인: DATABASE_URL 포트가 열려 있으면 그 DB 를 그대로 쓴다(판매툴_로컬_시작.cmd 가 떠 있는 경우).
 *     포트가 닫혀 있는데 데이터 폴더 postmaster.pid 의 프로세스가 살아 있으면 띄우지 않고 끝낸다(다른 DB 가 켜지는 중 — 같은 폴더로 두 번째 DB 를 띄우지 않음, AC-L-24).
 *     pid 파일만 남은 비정상 종료 흔적이면 시작한다(Postgres 가 오래된 파일을 스스로 확인).
 *     둘 다 아니면 pg_ctl 로 직접 띄운다(이 스크립트가 띄운 DB 만 끝날 때 끈다).
 *  ② 마이그레이션(이미 적용된 파일은 건너뜀)
 *  ③ scheduler.tick() 을 큐가 빌 때까지 반복(최대 COLLECT_ONCE_MAX_MS, 기본 10분). 매입서 자동 재대조(REMATCH)도 서버와 같은 훅으로 실행
 *  ④ 자기가 띄운 DB 만 pg_ctl stop → 종료 코드 0(성공)/1(실패). 로그 파일에 한 줄(키 값은 남기지 않음)
 * 중복 실행: 서버 타이머·다른 collect_once 와 겹쳐도 dedupe_key + FOR UPDATE SKIP LOCKED + 날짜 advisory lock 이 한 번만 실행(scheduler.js 머리말).
 *
 * 설정(환경 변수, 없으면 기본값)
 *   COLLECT_ONCE_ENV_FILE  추가로 읽을 env 파일(기본 C:/SalesToolDB/local.env, 'none' 이면 읽지 않음). 이미 있는 환경 변수는 덮지 않는다
 *   DATABASE_URL           (env 파일·환경에서) 예) postgresql://postgres:<pw>@127.0.0.1:5433/sales_tool
 *   COLLECT_ONCE_PG_DIR    PG 데이터 폴더(기본 C:/SalesToolDB/data)
 *   COLLECT_ONCE_PG_CTL    pg_ctl.exe 경로(기본 C:/Users/user/pgtest/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe)
 *   COLLECT_ONCE_LOG       로그 파일(기본 C:/SalesToolDB/logs/collect_once.log)
 *   COLLECT_ONCE_MAX_MS    최대 실행 시간(기본 600000)
 * 사용: server 폴더에서 node scripts/collect_once.js   (작업 스케줄러용 래퍼: scripts/local/collect_once.cmd)
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ENV_FILE = process.env.COLLECT_ONCE_ENV_FILE || 'C:/SalesToolDB/local.env';
if (ENV_FILE !== 'none' && fs.existsSync(ENV_FILE)) {
  for (const l of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] == null) process.env[m[1]] = m[2];
  }
}
const PG_DIR = process.env.COLLECT_ONCE_PG_DIR || 'C:/SalesToolDB/data';
const PG_CTL = process.env.COLLECT_ONCE_PG_CTL || 'C:/Users/user/pgtest/node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe';
const LOG = process.env.COLLECT_ONCE_LOG || 'C:/SalesToolDB/logs/collect_once.log';
const MAX_MS = Number(process.env.COLLECT_ONCE_MAX_MS || 600000);
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.DB_SSL = process.env.DB_SSL || 'false';
process.env.MAIL_DRY_RUN = process.env.MAIL_DRY_RUN || '1';
// 자동 재대조가 쓰는 짧은 내부 토큰의 서명 비밀 — 이 프로세스 안에서만 쓰므로 없으면 실행마다 새로 만든다(파일·로그에 남기지 않음)
if (!process.env.AUTH_SECRET) process.env.AUTH_SECRET = crypto.randomBytes(32).toString('hex');

const t0 = Date.now();
const stamp = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
function logLine(s) {
  const line = `${stamp()} ${s}`;
  console.log(line);
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, `${line}\n`); } catch { /* 로그 실패는 무시 */ }
}
const mask = (s) => String(s || '').replace(/(serviceKey=)[^&\s]+/gi, '$1****').replace(/(postgres(?:ql)?:\/\/[^:]+:)[^@]+@/gi, '$1****@');

function dbTarget() {
  const u = new URL(String(process.env.DATABASE_URL || '').replace(/^postgres(ql)?:/, 'http:'));
  return { host: u.hostname || '127.0.0.1', port: Number(u.port || 5432) };
}
const portOpen = ({ host, port }, ms = 1500) => new Promise((res) => {
  const c = net.connect(port, host);
  const done = (v) => { c.destroy(); res(v); };
  c.setTimeout(ms, () => done(false));
  c.on('connect', () => done(true));
  c.on('error', () => done(false));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * postmaster.pid 가 있고 그 PID 프로세스가 살아 있으면 true(다른 DB 가 켜지는 중 — 띄우지 않음).
 * 파일만 남고 프로세스가 없으면(실행기 창을 닫는 등 비정상 종료 흔적) false — Postgres 가 시작할 때 오래된 파일을 스스로 확인·교체하고,
 * 같은 폴더에 살아 있는 postmaster 가 있으면 Postgres 자체가 두 번째 시작을 거절한다.
 */
function pidAlive(file) {
  if (!fs.existsSync(file)) return false;
  const pid = parseInt(String(fs.readFileSync(file, 'utf8')).split(/\r?\n/)[0], 10);
  if (!Number.isFinite(pid) || pid <= 0) return true; // 읽을 수 없으면 보수적으로 "살아 있음"
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function pgCtl(args) {
  return spawnSync(PG_CTL, args, { encoding: 'utf8', windowsHide: true, timeout: 90000 }); // stop·status 전용(start 는 위에서 stdio ignore)
}

async function main() {
  if (!process.env.DATABASE_URL) { logLine('FAIL DATABASE_URL 없음(env 파일·환경 확인)'); return 1; }
  const tgt = dbTarget();
  if (!/^(127\.0\.0\.1|localhost|::1)$/.test(tgt.host)) { logLine(`FAIL 로컬 DB 만 다룹니다(host=${tgt.host})`); return 1; }
  let ownDb = false;
  if (await portOpen(tgt)) {
    logLine(`DB 사용 중인 것을 그대로 씀(포트 ${tgt.port})`);
  } else if (pidAlive(path.join(PG_DIR, 'postmaster.pid'))) {
    logLine(`FAIL 포트 ${tgt.port} 닫힘 + ${PG_DIR}/postmaster.pid 의 프로세스가 살아 있음 — 다른 DB 가 켜지는 중. 두 번째 DB 를 띄우지 않음(다음 실행에서 다시 확인)`);
    return 1;
  } else if (!fs.existsSync(path.join(PG_DIR, 'PG_VERSION'))) {
    logLine(`FAIL ${PG_DIR} 에 DB 가 없음 — 판매툴_로컬_시작.cmd 를 한 번 실행해 DB 를 만드세요`);
    return 1;
  } else {
    // -W(기다리지 않음) + stdio ignore: Postgres 가 상속한 파이프를 잡고 있어 spawnSync 가 끝나지 않는 것을 막는다(처음 구현은 시작에 약 120초 걸림). 준비는 아래에서 직접 확인
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const r = spawnSync(PG_CTL, ['-D', PG_DIR, '-o', `-p ${tgt.port}`, '-l', path.join(path.dirname(LOG), 'collect_once_pg.log'), '-W', 'start'], { stdio: 'ignore', windowsHide: true, timeout: 60000 });
    if (r.status !== 0) { logLine(`FAIL DB 시작 실패 rc=${r.status}(로그 ${path.join(path.dirname(LOG), 'collect_once_pg.log')})`); return 1; }
    ownDb = true;
    const { Client } = require('pg');
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      /* eslint-disable no-await-in-loop */
      if (await portOpen(tgt, 500)) {
        const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: false, connectionTimeoutMillis: 2000 });
        try { await c.connect(); await c.query('SELECT 1'); ready = true; } catch { /* 아직 시작 중 */ } finally { await c.end().catch(() => {}); }
      }
      if (!ready) await sleep(500);
      /* eslint-enable no-await-in-loop */
    }
    if (!ready) { logLine('FAIL DB 가 60초 안에 준비되지 않음'); pgCtl(['-D', PG_DIR, '-m', 'fast', '-W', 'stop']); return 1; }
    logLine(`DB 직접 시작(포트 ${tgt.port}, ${Math.round((Date.now() - t0) / 100) / 10}초)`);
  }
  let code = 0;
  let pool = null;
  try {
    process.env.MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL || process.env.DATABASE_URL;
    const mg = spawnSync(process.execPath, [path.join(__dirname, 'migrate.js')], { encoding: 'utf8', env: process.env, windowsHide: true, timeout: 180000 });
    if (mg.status !== 0) throw new Error(`마이그레이션 실패 rc=${mg.status} ${mask((mg.stderr || '').trim()).slice(0, 300)}`);
    const srv = require('../index.js'); // 라우트·훅만 만든다(listen·타이머는 node index.js 로 실행할 때만)
    pool = srv.pool;
    const scheduler = require('../lib/auction/scheduler');
    const sum = { ticks: 0, planned: 0, ran: 0, done: 0, failed: 0, kinds: {} };
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const r = await scheduler.tick(pool, { hooks: srv.auctionHooks || {}, maxJobs: 5, budgetMs: 60000 });
      sum.ticks += 1;
      sum.planned += r.planned.length;
      sum.ran += r.ran.length;
      for (const x of r.ran) {
        if (x.status === 'DONE') sum.done += 1;
        else if (['FAILED', 'DEAD'].includes(x.status)) sum.failed += 1;
        const k = `${x.job_type}${x.phase ? `:${x.phase}` : ''}:${x.snapshot || x.status}`;
        sum.kinds[k] = (sum.kinds[k] || 0) + 1;
      }
      // 이번 tick 에 끝난 작업이 없으면(빈 큐·재시도 대기만 남음) 멈춘다
      if (!r.ran.some((x) => x.status === 'DONE')) break;
      if (Date.now() - t0 > MAX_MS) { logLine(`시간 한도 ${MAX_MS}ms — 남은 작업은 다음 실행에서`); break; }
    }
    const kinds = Object.entries(sum.kinds).map(([k, v]) => `${k}×${v}`).join(' ') || '없음';
    logLine(`OK tick ${sum.ticks} · 계획 ${sum.planned} · 실행 ${sum.ran}(완료 ${sum.done}, 실패 ${sum.failed}) · ${kinds}`);
    if (sum.failed) code = 1;
  } catch (e) {
    code = 1;
    logLine(`FAIL ${mask(e.message).slice(0, 400)}`);
  } finally {
    if (pool) await pool.end().catch(() => {});
    if (ownDb) {
      const r = pgCtl(['-D', PG_DIR, '-m', 'fast', '-w', '-t', '60', 'stop']);
      logLine(r.status === 0 ? 'DB 끔(이 실행이 띄운 DB)' : `WARN DB 끄기 실패 rc=${r.status} ${mask((r.stderr || '').trim()).slice(0, 200)}`);
    }
    logLine(`끝 rc=${code} ${Math.round((Date.now() - t0) / 100) / 10}초`);
  }
  return code;
}

main().then((c) => process.exit(c)).catch((e) => { logLine(`FAIL ${mask(e.message)}`); process.exit(1); });
