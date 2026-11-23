// T-302 화면 조작 검수 공용 도구 — 로컬 전용(WEB=http://localhost:5506, API 는 vite 프록시)
// 실행 전제: 테스트 DB + 서버(3000) + vite(5506), seed-admin(admin001/sample)·seed-sample-local·seed-sample-transactions-local
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'C:/Users/user/pgtest/node_modules/playwright-core');
const WEB = process.env.WEB || 'http://localhost:5506';
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(WEB)) { console.error('로컬 주소만 허용'); process.exit(3); }
const CAP = path.join(__dirname, 'capture');
const AGENT = process.env.T302_AGENT || 'admin001';
const PW = process.env.T302_PW || 'sample';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiLogin(agent = AGENT, pw = PW, extra = {}) {
  const r = await fetch(WEB + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_no: agent, password: pw, ...extra }) });
  const d = await r.json();
  if (!r.ok) throw new Error('로그인 실패 ' + JSON.stringify(d));
  return {
    id: d.user?.id, name: d.user?.name, agent_no: d.user?.agent_no, is_admin: !!d.user?.is_admin, token: d.token,
    staff: d.user?.staff || null, allow: d.allow || null,
  };
}
async function api(user, method, p, body) {
  const r = await fetch(WEB + '/api' + p, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + user.token }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${p} ${r.status} ${t.slice(0, 200)}`);
  return d;
}

/** 브라우저 + 로그인된 페이지. width 390 이면 휴대폰 폭 */
async function open({ width = 1366, height = 900, user, path: p = '/' } = {}) {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept().catch(() => {}); });
  if (user) await page.addInitScript((u) => { try { sessionStorage.setItem('user', JSON.stringify(u)); } catch {} }, user);
  await page.goto(WEB + p);
  return { browser, ctx, page, dialogs };
}

/**
 * 요청 지연·실패·횟수 세기. match(url, method) 가 true 인 요청을 ms 만큼 늦춘다. fail 이면 500 으로 끝낸다.
 * 반환 { count, calls[] }
 */
async function slow(page, match, { ms = 2500, fail = false } = {}) {
  const st = { count: 0, calls: [], done: 0 };
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (!match(req.url(), req.method())) return route.continue();
    st.count++; st.calls.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await sleep(ms);
    try {
      if (fail) await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '테스트용 서버 오류(500)' }) });
      else await route.continue();
    } catch { /* 페이지가 닫힘 */ }
    st.done++;
  });
  return st;
}

async function tab(page, label) {
  await page.locator('button.main-tab', { hasText: label }).first().click();
  await page.waitForTimeout(600);
}
async function shot(page, name) {
  const f = path.join(CAP, name + '.png');
  await page.screenshot({ path: f, fullPage: false }).catch(() => {});
  return 'capture/' + name + '.png';
}
async function isEnabled(loc) {
  if ((await loc.count()) === 0) return null;
  return !(await loc.first().isDisabled());
}
/** 결과 출력 — bug=true 면 결함 재현(종료 코드 1), false 면 기대대로(0) */
function finish(id, title, bug, detail) {
  const r = { id, title, result: bug ? 'FAIL(결함 재현)' : 'PASS(기대대로)', ...detail };
  console.log(JSON.stringify(r, null, 1));
  require('fs').writeFileSync(path.join(__dirname, 'results', id + '.json'), JSON.stringify(r, null, 1));
  return bug ? 1 : 0;
}
require('fs').mkdirSync(path.join(__dirname, 'results'), { recursive: true });
module.exports = { WEB, CAP, sleep, apiLogin, api, open, slow, tab, shot, isEnabled, finish, chromium };
