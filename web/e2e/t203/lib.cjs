// T-203 새 화면 실서버 e2e 공용 도구 — 로컬 전용(WEB=http://localhost:5182, API 는 vite 프록시 → 서버 3102)
// 전제: setup.cjs 를 먼저 돌려 fixture(FIXTURE 경로, 기본 %TEMP%/c203/fixture.json)를 만든다. 운영 주소 금지.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'C:/Users/user/pgtest/node_modules/playwright-core');
const WEB = process.env.WEB || 'http://localhost:5182';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(WEB)) { console.error('로컬 주소만 허용'); process.exit(3); }
const CAP = process.env.T203_CAP || path.join(__dirname, 'capture');
const RES = path.join(__dirname, 'results');
const FIX = process.env.FIXTURE || path.join(os.tmpdir(), 'c203', 'fixture.json');
fs.mkdirSync(CAP, { recursive: true });
fs.mkdirSync(RES, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = () => JSON.parse(fs.readFileSync(FIX, 'utf8'));

async function login(who) {
  const f = fixture();
  const a = f.accounts[who];
  if (!a) throw new Error('계정 없음 ' + who);
  const body = a.login_id ? { agent_no: a.agent_no, login_id: a.login_id, password: a.pw } : { agent_no: a.agent_no, password: a.pw };
  const r = await fetch(WEB + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error('로그인 실패 ' + who + ' ' + JSON.stringify(d));
  const u = { id: d.user?.id, name: d.user?.name, agent_no: d.user?.agent_no, is_admin: !!d.user?.is_admin, token: d.token, staff: d.user?.staff || null, allow: d.allow || d.user?.allow || null };
  // 화면 로그인(Login.jsx)처럼 직원은 GET /api/me 의 allow 를 함께 저장
  if (u.staff && !u.allow) { const m = await (await fetch(WEB + '/api/me', { headers: { Authorization: 'Bearer ' + u.token } })).json().catch(() => ({})); u.allow = m.allow || m.data?.allow || null; }
  return u;
}
/** 상태 코드까지 돌려주는 API 호출(실패해도 던지지 않음) */
async function call(user, method, p, body, headers = {}) {
  const r = await fetch(WEB + '/api' + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(user ? { Authorization: 'Bearer ' + user.token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = { _text: t.slice(0, 200) }; }
  return { status: r.status, json: d, headers: r.headers };
}
async function open({ width = 1366, height = 900, user } = {}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  if (user) await page.addInitScript((u) => { try { sessionStorage.setItem('user', JSON.stringify(u)); } catch {} }, user);
  await page.goto(WEB + '/');
  await page.waitForSelector('button.main-tab', { timeout: 15000 });
  return { browser, ctx, page, errors };
}
/** API 요청 지연·실패·가로채기. match(url, method) true 인 요청만. respond 가 있으면 그 응답으로 끝낸다 */
async function slow(page, match, { ms = 2500, respond = null } = {}) {
  const st = { count: 0, calls: [], bodies: [], headers: [] };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (!match(req.url(), req.method())) return route.continue();
    st.count++; st.calls.push(`${req.method()} ${new URL(req.url()).pathname}${new URL(req.url()).search}`);
    st.bodies.push(req.postData()); st.headers.push(req.headers());
    await sleep(ms);
    try {
      if (respond) await route.fulfill({ status: respond.status, contentType: 'application/json', body: JSON.stringify(respond.body) });
      else await route.continue();
    } catch { /* 페이지 닫힘 */ }
  });
  return st;
}
async function tab(page, label) {
  await page.locator('button.main-tab', { hasText: label }).first().click();
  await page.waitForTimeout(700);
}
const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
async function shot(page, name) {
  const f = path.join(CAP, name + '.png');
  await page.screenshot({ path: f, fullPage: true }).catch(() => {});
  return 'capture/' + name + '.png';
}
async function text(loc) { return (await loc.count()) ? (await loc.first().innerText().catch(() => '')) : ''; }
/** 검사 묶음: c(이름, 조건, 상세) → 끝에 done(id) */
function suite(id, title) {
  const checks = [];
  return {
    c(name, ok, detail) { checks.push({ name, ok: !!ok, detail: ok ? undefined : detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)}`); return !!ok; },
    done(extra = {}) {
      const fail = checks.filter((x) => !x.ok).length;
      const r = { id, title, pass: checks.length - fail, fail, total: checks.length, checks, ...extra };
      fs.writeFileSync(path.join(RES, id + '.json'), JSON.stringify(r, null, 1));
      console.log(`== ${id} ${checks.length - fail}/${checks.length}`);
      return fail ? 1 : 0;
    },
  };
}
/** 결함 재현 스크립트 결과 — bug=true 면 재현(rc 1) */
function finish(id, title, bug, detail) {
  const r = { id, title, result: bug ? 'FAIL(결함 재현)' : 'PASS(기대대로)', ...detail };
  console.log(JSON.stringify(r, null, 1));
  fs.writeFileSync(path.join(RES, id + '.json'), JSON.stringify(r, null, 1));
  return bug ? 1 : 0;
}
/** 테스트 DB 직접 확인(로컬 전용) */
function db() {
  const { Pool } = require(path.join(__dirname, '../../../server/node_modules/pg'));
  const url = fixture().db_url;
  if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error('로컬 DB만');
  return new Pool({ connectionString: url });
}
const key = (p = 'e2e') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
module.exports = { WEB, CAP, sleep, fixture, login, call, open, slow, tab, tid, shot, text, suite, finish, db, key, chromium };
