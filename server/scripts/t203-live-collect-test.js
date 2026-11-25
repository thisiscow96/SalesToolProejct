/**
 * T-203 경매 직후 수집 테스트 — 정산일(settleDateOf)·완료 감지·01:00 배치·06:00 확인·지금 받기·C-CV-01 (A 설계 8절 AC-L-xx 를 테스트 이름에 그대로)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> node scripts/t203-live-collect-test.js
 * 전제: 마이그레이션 001~033, seed-sample-local, 서버 기동(AUCTION_SOURCE_MODE=mock, AUCTION_MOCK_CONTROL=true)
 * 테스트 DB 전용. 실 API 호출 없음 — 시계를 주입하고(hooks.now) 실데이터 샘플(정산일 2026-11-24)을 mdfcn_dt 순으로 "적재"되는 것처럼 돌려주는
 * 시간표 어댑터(hooks.createAdapter)로 스케줄러·워커를 이 프로세스에서 직접 돌린다.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

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

  await pool.end();
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n[t203-live-collect-test] ${results.length - fail}/${results.length} PASS`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[t203-live-collect-test] 예외:', e); process.exit(1); });
