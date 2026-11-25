// T-203 C e2e 준비 — 로컬 테스트 DB 전용. 회원(주인 1001)·관리자·입력/조회 직원·거래처·법인/품목 연결·목업 수집을 만든다
// 사용: DATABASE_URL=<로컬> COLLECT_TRIGGER_TOKEN=<서버와 같음> WEB=http://localhost:5182 node setup.cjs
// 결과: FIXTURE(기본 %TEMP%/c203/fixture.json) — 로컬 테스트용 임시 비밀번호가 들어가므로 저장소에 두지 않는다
const path = require('path'); const fs = require('fs'); const os = require('os'); const crypto = require('crypto');
const SV = path.join(__dirname, '../../../server/node_modules/');
const { Pool } = require(SV + 'pg'); const bcrypt = require(SV + 'bcrypt');
const WEB = process.env.WEB || 'http://localhost:5182';
const DB = process.env.DATABASE_URL; const TICK = process.env.COLLECT_TRIGGER_TOKEN || '';
if (!DB || !/localhost|127\.0\.0\.1/.test(DB) || !/^http:\/\/(localhost|127)/.test(WEB)) { console.error('로컬 DB·주소만'); process.exit(2); }
const FIX = process.env.FIXTURE || path.join(os.tmpdir(), 'c203', 'fixture.json');
const kst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const add = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
async function api(method, p, body, tok, headers = {}) {
  const r = await fetch(WEB + '/api' + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { _text: t.slice(0, 200) }; }
  return { status: r.status, json: j };
}
(async () => {
  const pool = new Pool({ connectionString: DB });
  const q = async (s, p) => (await pool.query(s, p)).rows;
  const tag = Date.now().toString(36);
  await q(`UPDATE collect_schedule SET active = false`);
  await q(`UPDATE collect_job SET status='CANCELLED', finished_at=NOW(), locked_by=NULL, locked_at=NULL WHERE status IN ('QUEUED','RUNNING')`);
  await q(`UPDATE ext_circuit_state SET state='CLOSED', consecutive_failures=0, opened_at=NULL, next_probe_at=NULL, disabled_reason=NULL, disabled_until=NULL, cooldown_sec=600`);
  await q(`UPDATE "user" SET agent_no = agent_no || '_' || id WHERE agent_no = '1001'`);
  const accounts = {};
  const mkUser = async (who, name, agent, admin) => {
    const pw = 'C203-' + crypto.randomBytes(6).toString('hex');
    const id = (await q(`INSERT INTO "user"(name,email,agent_no,password_hash,terms_agreed_at,status,is_admin) VALUES($1,$2,$3,$4,NOW(),'active',$5) RETURNING id`, [name, `${agent}_${tag}@test.local`, agent, await bcrypt.hash(pw, 8), admin]))[0].id;
    accounts[who] = { id, agent_no: agent, pw };
    const t = (await api('POST', '/auth/login', { agent_no: agent, password: pw })).json.token;
    if (!t) throw new Error('login ' + who);
    accounts[who].tok = t;
    return t;
  };
  const A = await mkUser('owner', '가명중매인', '1001', false);
  await mkUser('admin', '가명관리자', `c203adm_${tag}`, true);
  for (const [who, lid, role] of [['input', 'cin1', 'input'], ['view', 'cvw1', 'view']]) {
    const pw = 'St-' + crypto.randomBytes(6).toString('hex');
    const r = await api('POST', '/staff', { login_id: lid, name: `가명${role}`, role, temp_password: pw }, A);
    if (r.status >= 300) throw new Error('staff ' + JSON.stringify(r.json));
    await q(`UPDATE staff_account SET must_change_password=false WHERE owner_user_id=$1 AND login_id=$2`, [accounts.owner.id, lid]);
    accounts[who] = { agent_no: '1001', login_id: lid, pw };
  }
  const partner = async (name, type = 'supplier') => (await api('POST', '/partners', { name, type }, A)).json?.data?.id;
  const PA = await partner('A청과'); const PB = await partner('B청과'); const PC = await partner('C농협공판장');
  let r = await api('PUT', '/auction/corp-links', { links: [{ corp_code: '11000101', partner_id: PA }, { corp_code: '11000102', partner_id: PB }, { corp_code: '11000103', partner_id: PC }] }, A);
  if (r.status !== 200) throw new Error('corp ' + JSON.stringify(r.json));
  const prod = async (n) => (await q(`SELECT id FROM product WHERE owner_user_id IS NULL AND name=$1`, [n]))[0]?.id;
  const P = { 청양: await prod('청양고추'), 꽈리: await prod('꽈리고추'), 홍: await prod('홍고추'), 오이: await prod('오이고추'), 적: await prod('빨강 파프리카'), 황: await prod('노랑 파프리카') };
  r = await api('PUT', '/auction/product-links', { links: [
    { item_key: 'PEPPER.CHEONGYANG', product_id: P.청양 }, { item_key: 'PEPPER.KKWARI', product_id: P.꽈리 }, { item_key: 'PEPPER.RED', product_id: P.홍 },
    { item_key: 'PEPPER.OI', product_id: P.오이 }, { item_key: 'PEPPER.GENERAL', product_id: P.청양 }, { item_key: 'PAPRIKA.RED', product_id: P.적 },
    { item_key: 'PAPRIKA.YELLOW', product_id: P.황 }, { item_key: 'PAPRIKA.ORANGE', product_id: P.황 }] }, A);
  if (r.status !== 200) throw new Error('plink ' + JSON.stringify(r.json));
  // 수집 — 날짜를 5일씩 띄워 후보 범위(−3~+1)가 겹치지 않게
  const today = kst();
  const D = { A: add(today, -1), B: add(today, -6), C: add(today, -11), D: add(today, -16), E: add(today, -21), H: add(today, -26), M: add(today, -28), S: add(today, -30) };
  let seq = 0;
  const tick = () => api('POST', '/internal/collect/tick', {}, null, { 'x-collect-token': TICK });
  const enqueue = async (date, phase, scen) => (await q(`INSERT INTO collect_job(job_type,source,market_code,trade_date,phase,params,dedupe_key) VALUES('COLLECT','AT_REALTIME','110001',$1,$2,$3::jsonb,$4) RETURNING id`, [date, phase, JSON.stringify({ mock_scenario: scen }), `C203:${tag}:${++seq}`]))[0].id;
  const run = async (id) => {
    for (let i = 0; i < 8; i++) {
      const j = (await q(`SELECT status FROM collect_job WHERE id=$1`, [id]))[0];
      if (!['QUEUED', 'RUNNING'].includes(j.status)) return j.status;
      await tick();
    }
    return 'TIMEOUT';
  };
  const out = {};
  for (const k of ['A', 'B', 'C', 'D', 'E', 'S']) out[k] = await run(await enqueue(D[k], 'FINAL', 'normal'));
  out.M_empty = await run(await enqueue(D.M, 'FINAL', 'empty'));
  r = await api('PUT', '/auction/calendar', { add: [{ cal_date: D.H, kind: 'HOLIDAY', note: '가명 휴장' }] }, accounts.admin.tok);
  out.holiday = r.status;
  out.H = r.json?.data?.requeued?.[0] ? await run(r.json.data.requeued[0]) : await run(await enqueue(D.H, 'FINAL', 'normal'));
  await q(`DELETE FROM collect_job WHERE trade_date=$1 AND dedupe_key LIKE '%:NOTYET:%'`, [today]);
  out.today = await run(await enqueue(today, 'INTRADAY', 'empty'));
  // 재수집 예약·REMATCH 등 남은 대기 작업은 테스트 간섭 방지로 취소
  await q(`UPDATE collect_job SET status='CANCELLED', finished_at=NOW() WHERE status='QUEUED'`);
  const snaps = await q(`SELECT trade_date::text d, phase, status FROM collect_snapshot WHERE id IN (SELECT MAX(id) FROM collect_snapshot GROUP BY trade_date, phase) ORDER BY trade_date`);
  for (const a of Object.values(accounts)) delete a.tok;
  const fx = { db_url: DB, web: WEB, today, dates: D, partners: { PA, PB, PC }, products: P, accounts, collect: out, snaps, tag };
  fs.mkdirSync(path.dirname(FIX), { recursive: true });
  fs.writeFileSync(FIX, JSON.stringify(fx, null, 1));
  console.log(JSON.stringify({ dates: D, collect: out, snaps, partners: fx.partners }, null, 1));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(2); });
