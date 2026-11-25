/**
 * T-203 C(테스트) 실데이터 시나리오 — 한국청과 원표번호로 찾기 → 정렬 → 선택 → 전환 → 매입정보에서 확인 + 정렬 응답 시간(AC-O-09)
 * 전제: 같은 DB 에 2026-11-24·25 실데이터 재생분이 있음(t203-realapi-test 를 먼저 돌리면 lib/auction/fixtures/real 재생 파일로 들어감, 실 API 호출 없음)
 * 사용: server 폴더에서 DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> node scripts/t203-convert-c-realdata.js
 * 원표번호 기본값은 실데이터 샘플(가락 2026-11-24 고추·파프리카 2,009건)에서 한국청과 행이 가장 많은 원표(C_REAL_SHIP 로 바꿀 수 있음)
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.MATCH_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) { console.error('로컬 테스트 DB 전용'); process.exit(2); }
const SHIP = process.env.C_REAL_SHIP || '11202611240455';
const DAY = '2026-11-24';
const results = [];
const check = (name, cond, detail) => { results.push({ name, ok: !!cond }); console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + JSON.stringify(detail).slice(0, 900)}`); };
const note = (s) => console.log(`NOTE ${s}`);
async function api(method, p, body, token, headers = {}) {
  const t0 = Date.now();
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _text: text.slice(0, 200) }; }
  return { status: r.status, json: j, ms: Date.now() - t0 };
}
const qs = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

(async () => {
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (s, p) => (await pool.query(s, p)).rows;
  const real = await q(`SELECT count(*)::int AS n FROM auction_trade WHERE trade_date = $1 AND source = 'AT_REALTIME'`, [DAY]);
  if (!real[0].n) { console.error('실데이터 재생분 없음 — t203-realapi-test 를 먼저'); process.exit(2); }
  const tag = `cr${Date.now().toString(36)}`;
  const pw = crypto.randomBytes(12).toString('hex');
  const uid = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,$4,NOW(),'active',false) RETURNING id`,
    [`실데이터검사 ${tag}`, `${tag}@test.local`, tag, await bcrypt.hash(pw, 8)]))[0].id;
  const A = (await api('POST', '/api/auth/login', { agent_no: tag, password: pw })).json.token;
  const pk = (await api('POST', '/api/partners', { name: `한국청과 ${tag}`, type: 'supplier' }, A)).json.data.id;
  const prod = (await q(`SELECT id, unit FROM product WHERE owner_user_id IS NULL AND name = '청양고추'`))[0];
  const l1 = await api('PUT', '/api/auction/corp-links', { links: [{ corp_code: '11000105', partner_id: pk }] }, A);
  const l2 = await api('PUT', '/api/auction/product-links', { links: [{ item_key: 'PEPPER.CHEONGYANG', product_id: prod.id }] }, A);
  check(`준비 회원·한국청과 연결·청양고추(${prod.unit}) 연결, 실데이터 ${DAY} ${real[0].n}행`, l1.status === 200 && l2.status === 200, [l1.json, l2.json]);

  // ① 원표번호로 찾기
  const dbRows = await q(`SELECT id FROM auction_trade WHERE trade_date = $1 AND shipment_no = $2`, [DAY, SHIP]);
  const r1 = await api('GET', `/api/auction/trades?${qs({ date_from: DAY, date_to: DAY, shipment_no: SHIP, limit: 200 })}`, null, A);
  check(`R1 한국청과 원표 ${SHIP} 검색 → DB 행 수(${dbRows.length})와 같음, 전부 그 원표·한국청과`, r1.status === 200 && r1.json.total === dbRows.length && r1.json.data.every((x) => x.shipment_no === SHIP && x.corp_name === '한국청과㈜'),
    { st: r1.status, total: r1.json.total });
  note(`검색 ${r1.ms}ms, meta ${JSON.stringify(r1.json.meta && { shipment_no: r1.json.meta.shipment_no, shipment_match: r1.json.meta.shipment_match, sort: r1.json.meta.sort, dir: r1.json.meta.dir })}`);
  // ② 정렬(단가 내림차순)
  const r2 = await api('GET', `/api/auction/trades?${qs({ date_from: DAY, date_to: DAY, shipment_no: SHIP, sort: 'unit_price', dir: 'desc', limit: 200 })}`, null, A);
  const prices = (r2.json.data || []).map((x) => Number(x.unit_price));
  check('R2 같은 원표 단가 내림차순 → 순서 내림차순, 같은 건수', r2.status === 200 && prices.length === dbRows.length && prices.every((v, i) => i === 0 || prices[i - 1] >= v), prices);
  const r2b = await api('GET', `/api/auction/trades?${qs({ date_from: DAY, date_to: DAY, shipment_no: SHIP, sort: 'auction_seq', dir: 'asc', limit: 200 })}`, null, A);
  const seqs = (r2b.json.data || []).map((x) => x.auction_seq);
  check('R2 경매번호 오름차순 → 앞자리 0 그대로(00010…) 오름차순', seqs.length && seqs.every((v, i) => i === 0 || (seqs[i - 1].length < v.length || (seqs[i - 1].length === v.length && seqs[i - 1] <= v))) && /^0/.test(seqs[0]), seqs.slice(0, 5));
  // ③ 선택(상위 3건 — 단가 높은 순) → 미리보기 → 전환
  const pick = (r2.json.data || []).filter((x) => x.convertible).slice(0, 3);
  const ids = pick.map((x) => x.id);
  const pv = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: ids }, A);
  note(`미리보기 ${pv.ms}ms ${JSON.stringify(pv.json.data && pv.json.data.summary)} 결과 ${JSON.stringify((pv.json.data?.rows || []).map((x) => [x.trade_id, x.result, x.quantity, x.unit_price, x.total, x.warnings]))}`);
  check('R3 미리보기 3건 → 결과 행 3, 쓰기 없음', pv.status === 200 && pv.json.data.rows.length === 3, pv.json);
  const k = `cr_${crypto.randomBytes(8).toString('hex')}`;
  const cv = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: ids }, A, { 'idempotency-key': k });
  const conv = (cv.json.data?.results || []).filter((x) => x.result === 'CONVERTED');
  note(`전환 ${cv.ms}ms ${JSON.stringify(cv.json.data && cv.json.data.summary)} navigate ${JSON.stringify(cv.json.data && cv.json.data.navigate)}`);
  check('R3 전환 → 미리보기의 WILL_CONVERT 건수만큼 CONVERTED, navigate 매입정보·경락일', cv.status === 200 && conv.length === pv.json.data.summary.will_convert && conv.length > 0
    && cv.json.data.navigate && cv.json.data.navigate.tab === 'purchases' && cv.json.data.navigate.from_date === DAY, cv.json);
  // ④ 매입정보에서 확인(R-22 ids)
  const nav = cv.json.data.navigate || { purchase_ids: [] };
  const r4 = await api('GET', `/api/purchases?${qs({ from_date: nav.from_date, to_date: nav.to_date, ids: nav.purchase_ids.join(',') })}`, null, A);
  const rows = r4.json.data || [];
  const byT = Object.fromEntries(pick.map((x) => [x.id, x]));
  const okRows = conv.every((c) => {
    const p = rows.find((x) => x.id === c.purchase_id);
    const t = byT[c.trade_id];
    return p && p.purchase_doc_kind === 'AUCTION' && String(p.memo || '').includes(SHIP) && String(p.memo || '').includes(`경매 ${t.auction_seq}`) && p.partner_id === pk && Number(p.total_amount ?? p.total ?? 0) > 0;
  });
  check('R4 매입정보(R-22 ids) → 전환한 건만, AUCTION 배지 값·memo 원표/경매번호·거래처 한국청과', r4.status === 200 && rows.length === conv.length && okRows, rows.map((x) => ({ id: x.id, kind: x.purchase_doc_kind, memo: x.memo, partner_id: x.partner_id, keys: Object.keys(x).slice(0, 40) })));
  const r5 = await api('GET', `/api/auction/trades?${qs({ date_from: DAY, date_to: DAY, shipment_no: SHIP, sort: 'unit_price', dir: 'desc', limit: 200 })}`, null, A);
  const after = (r5.json.data || []).filter((x) => ids.includes(x.id));
  check('R5 경락 목록 다시 조회 → 전환한 행 converted_purchase_id·convertible=false(ALREADY_CONVERTED)', after.length === ids.length && after.filter((x) => x.converted_purchase_id).length === conv.length
    && after.filter((x) => x.converted_purchase_id).every((x) => x.convertible === false && x.not_convertible_reason === 'ALREADY_CONVERTED'), after.map((x) => [x.id, x.converted_purchase_id, x.convertible, x.not_convertible_reason]));

  // ⑤ AC-O-09 응답 시간: 실데이터 2일(2026-11-24~25 전 품목) × 12키 × asc/desc, 쪽당 50, 각 3회 중 최댓값
  const KEYS = ['trade_date', 'auction_at', 'corp', 'shipment_no', 'auction_seq', 'item', 'grade', 'unit_kg', 'qty', 'unit_price', 'price_per_kg', 'origin'];
  const tim = [];
  for (const s of KEYS) for (const d of ['asc', 'desc']) {
    let mx = 0; let st = 0; let total = 0;
    for (let i = 0; i < 3; i += 1) { const r = await api('GET', `/api/auction/trades?${qs({ date_from: DAY, date_to: '2026-11-25', sort: s, dir: d, limit: 50 })}`, null, A); mx = Math.max(mx, r.ms); st = r.status; total = r.json.total; }
    tim.push({ s, d, st, total, max_ms: mx });
  }
  console.log(`TIMING ${JSON.stringify(tim)}`);
  check('AC-O-09 실데이터 2일 12키×2방향 전부 200(시간 기록 — 통과 기준 수치는 PM 결정 [가정])', tim.every((x) => x.st === 200), tim.filter((x) => x.st !== 200));
  note(`AC-O-09 최대 ${Math.max(...tim.map((x) => x.max_ms))}ms, 평균 ${Math.round(tim.reduce((a, x) => a + x.max_ms, 0) / tim.length)}ms, 행 ${tim[0].total}`);
  const off = await api('GET', `/api/auction/trades?${qs({ date_from: DAY, date_to: '2026-11-25', sort: 'origin', dir: 'asc', limit: 50, offset: Math.max(0, tim[0].total - 50) })}`, null, A);
  note(`마지막 쪽(OFFSET ${Math.max(0, tim[0].total - 50)}) origin asc ${off.ms}ms`);

  await pool.end();
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n[t203-convert-c-realdata] ${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
