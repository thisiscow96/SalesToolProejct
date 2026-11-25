/**
 * T-203 C(테스트) 독립 검증 — 경락 → 매입 전환 멱등·동시성·권한·입력 방어·취소/재전환·재고·감사 (B t203-convert-test 와 별도로 C 가 작성)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> node scripts/t203-convert-c-test.js
 * 전제: 마이그레이션 001~032, seed-sample-local(공용 품목 청양고추·꽈리고추·홍고추), 서버 기동(AUCTION_SOURCE_MODE=mock)
 * 테스트 DB 전용 — 새 회원을 DB 에 직접 만들고 경락 행을 무작위 과거 날짜(2021~2022)에 직접 넣는다(실 API 호출 없음).
 * 선택: C_EXPECT_CORP_SCOPE=11000105 — 서버를 AUCTION_CORP_CODES=11000105 로 띄웠을 때 범위 밖 법인(서울청과) 건도 전환되는지 표시용
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.MATCH_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[t203-convert-c-test] 로컬 테스트 DB 에서만 실행합니다.');
  process.exit(2);
}
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
}
const note = (s) => console.log(`NOTE ${s}`);
const key = () => `c_${crypto.randomBytes(9).toString('hex')}`;
async function api(method, p, body, token, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { _text: text.slice(0, 200) }; }
  return { status: r.status, json: j };
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const digits = (n) => Array.from(crypto.randomBytes(n), (b) => String(b % 10)).join('');
const qs = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const tag = `c${Date.now().toString(36)}`;
  const D = addDays('2021-01-01', crypto.randomInt(0, 700));
  console.log(`[t203-convert-c-test] 기준일 ${D} tag ${tag} base ${BASE}`);

  // ---------- 준비 ----------
  const mkUser = async (name, agent) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const id = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,$4,NOW(),'active',false) RETURNING id`,
      [name, `${agent}@test.local`, agent, await bcrypt.hash(pw, 8)]))[0].id;
    const tok = (await api('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
    if (!tok) throw new Error(`로그인 실패 ${agent}`);
    return { id, tok, agent };
  };
  const O = await mkUser(`C검증 ${tag}`, `${tag}_o`);
  const O2 = await mkUser(`C다른회원 ${tag}`, `${tag}_o2`);
  const A = O.tok;
  const staff = async (owner, loginId, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    const r = await api('POST', '/api/staff', { login_id: loginId, name: `직원${loginId}`, role, temp_password: spw }, owner.tok);
    if (r.status >= 300) throw new Error(`직원 ${loginId} ${r.status} ${JSON.stringify(r.json)}`);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [owner.id, loginId]);
    const sid = (await q(`SELECT id FROM staff_account WHERE owner_user_id = $1 AND login_id = $2`, [owner.id, loginId]))[0].id;
    return { tok: (await api('POST', '/api/auth/login', { agent_no: owner.agent, login_id: loginId, password: spw })).json.token, id: sid };
  };
  const SI = await staff(O, 'cin', 'input');
  const SV = await staff(O, 'cvw', 'view');
  const partner = async (tok, name) => (await api('POST', '/api/partners', { name, type: 'supplier' }, tok)).json?.data?.id;
  const PK = await partner(A, `한국청과 ${tag}`);
  const PS = await partner(A, `서울청과 ${tag}`);
  const PK2 = await partner(O2.tok, `한국청과 ${tag}`);
  const P = (await q(`SELECT id, unit FROM product WHERE owner_user_id IS NULL AND name = '청양고추'`))[0];
  const setLinks = async (owner, corps) => {
    const r1 = await api('PUT', '/api/auction/corp-links', { links: corps }, owner.tok);
    const r2 = await api('PUT', '/api/auction/product-links', { links: [{ item_key: 'PEPPER.CHEONGYANG', product_id: P.id }] }, owner.tok);
    return r1.status === 200 && r2.status === 200;
  };
  check('준비 회원 2·직원(입력·조회)·거래처·법인/품목 연결', PK && PS && PK2 && P && SI.tok && SV.tok
    && (await setLinks(O, [{ corp_code: '11000105', partner_id: PK }, { corp_code: '11000101', partner_id: PS }])) && (await setLinks(O2, [{ corp_code: '11000105', partner_id: PK2 }])), { PK, PS, PK2 });

  const snap = (await q(`INSERT INTO collect_snapshot (source, market_code, trade_date, phase, status, finished_at, is_latest_ok) VALUES ('AT_REALTIME','110001',$1,'FINAL','COMPLETE',NOW(),true) RETURNING id`, [D]))[0].id;
  const CORP = { '11000101': '서울청과㈜', '11000105': '한국청과㈜' };
  let n = 0;
  const ins = async (o) => {
    n += 1;
    const ship = o.ship || `13${digits(12)}`;
    const seq = String(o.seq || n);
    const r = await q(
      `INSERT INTO auction_trade (source, source_row_key, trade_date, auction_at, market_code, market_name, corp_code, corp_name, item_name_raw, item_key, map_status, grade_name, grade_norm,
                                  pkg_name, pkg_norm, unit_qty_kg, weight_source, qty, unit_price, price_per_kg, amount, origin_name, auction_seq, shipment_no, snapshot_id, content_hash, withdrawn_at)
       VALUES ('AT_REALTIME',$1,$2,$3,'110001','가락',$4,$5,'청양','PEPPER.CHEONGYANG','MAPPED',NULL,'HIGH','상자','BOX',10.000,'SOURCE',$6::numeric,$7::bigint,($7::numeric/10)::numeric(12,2),ROUND($6::numeric*$7::bigint)::bigint,'경북 영양',$8,$9,$10,$11,$12) RETURNING id`,
      [`110001|${D}|${o.corp || '11000105'}|${ship}|${seq}`, D, `${D}T05:${String(n % 60).padStart(2, '0')}:00+09:00`, o.corp || '11000105', CORP[o.corp || '11000105'],
        String(o.qty || 5), o.price || 20000, seq, ship, snap, 'c'.repeat(64), o.withdrawn ? new Date().toISOString() : null]);
    return Number(r[0].id);
  };
  const cntPur = async (uid) => (await q(`SELECT count(*)::int AS n FROM purchase WHERE user_id = $1 AND status = 'active'`, [uid]))[0].n;
  const activeConv = async (uid, ids) => (await q(`SELECT count(*)::int AS n FROM purchase_doc_conversion WHERE user_id = $1 AND trade_id = ANY($2::bigint[]) AND status = 'ACTIVE'`, [uid, ids]))[0].n;
  const conv = (tok, ids, k = key()) => api('POST', '/api/purchase-docs/from-trades', { trade_ids: ids }, tok, { 'idempotency-key': k });
  const resSig = (x) => (x.status === 200 ? x.json.data.results.map((y) => y.result).sort().join(',') : `HTTP${x.status}`);

  // ================= 멱등·동시성 =================
  // C-01 버튼 연타: 같은 키·같은 본문 5개 동시
  {
    const t = [await ins({}), await ins({})];
    const n0 = await cntPur(O.id);
    const k = key();
    const rs = await Promise.all(Array.from({ length: 5 }, () => conv(A, t, k)));
    const sig = rs.map(resSig);
    const okBodies = rs.filter((x) => x.status === 200).map((x) => JSON.stringify(x.json.data.results.map((y) => [y.trade_id, y.purchase_id]).sort()));
    check('C-01 버튼 연타(같은 키 5개 동시) → 매입 +2만, 활성 전환 2, 200 응답은 모두 같은 purchase_id(그 밖은 409 RETRY만)', (await cntPur(O.id)) === n0 + 2 && (await activeConv(O.id, t)) === 2
      && new Set(okBodies).size === 1 && rs.every((x) => x.status === 200 || x.status === 409), { sig, okBodies });
  }
  // C-02 다른 키 5개 동시(같은 건)
  {
    const t = [await ins({}), await ins({}), await ins({})];
    const n0 = await cntPur(O.id);
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => conv(A, i % 2 ? [...t].reverse() : t)));
    const sig = rs.map(resSig);
    const converted = rs.filter((x) => x.status === 200).flatMap((x) => x.json.data.results.filter((y) => y.result === 'CONVERTED'));
    check('C-02 다른 키 5개 동시(같은 3건) → 매입 +3만(이중 0), CONVERTED 합계 3, 나머지 ALREADY_CONVERTED 또는 409', (await cntPur(O.id)) === n0 + 3 && (await activeConv(O.id, t)) === 3
      && converted.length === 3 && rs.every((x) => x.status === 200 || x.status === 409), sig);
  }
  // C-03 주인 + 입력 직원 동시(같은 건) — 같은 회원 잠금
  {
    const t = [await ins({})];
    const n0 = await cntPur(O.id);
    const [a, b] = await Promise.all([conv(A, t), conv(SI.tok, t)]);
    check('C-03 주인·입력 직원이 같은 건을 동시에 → 매입 1건', (await cntPur(O.id)) === n0 + 1 && (await activeConv(O.id, t)) === 1, [resSig(a), resSig(b)]);
  }
  // C-04 겹치는 묶음 동시: [a,b] 와 [b,c]
  {
    const a = await ins({}); const b = await ins({}); const c = await ins({});
    const n0 = await cntPur(O.id);
    const [r1, r2] = await Promise.all([conv(A, [a, b]), conv(A, [b, c])]);
    check('C-04 겹치는 묶음 동시([a,b]·[b,c]) → 매입 +3(b 1번), 활성 전환 3', (await cntPur(O.id)) === n0 + 3 && (await activeConv(O.id, [a, b, c])) === 3, [resSig(r1), resSig(r2)]);
  }
  // C-05 다른 회원은 같은 경락 건을 따로 전환 가능, 서로 영향 없음
  {
    const t = [await ins({})];
    await conv(A, t);
    const [x] = [await conv(O2.tok, t)];
    check('C-05 다른 회원이 같은 경락 건 전환 → CONVERTED(회원별 유일), 각자 활성 1', resSig(x) === 'CONVERTED' && (await activeConv(O.id, t)) === 1 && (await activeConv(O2.id, t)) === 1, x.json);
  }
  // C-06 Idempotency-Key 없음·빈 키 → 400, 매입 0
  {
    const t = [await ins({})];
    const n0 = await cntPur(O.id);
    const r1 = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: t }, A);
    const r2 = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: t }, A, { 'idempotency-key': '' });
    check('C-06 Idempotency-Key 없음·빈 값 → 400, 매입 추가 0', r1.status === 400 && r2.status === 400 && (await cntPur(O.id)) === n0, [r1.status, r2.status]);
  }

  // ================= 제외 사유 · 범위 =================
  {
    const w = await ins({ withdrawn: true });
    const s = await ins({ corp: '11000101' }); // 서울청과
    const n0 = await cntPur(O.id);
    const r = await conv(A, [w, s]);
    const by = Object.fromEntries((r.json.data?.results || []).map((x) => [x.trade_id, x.result]));
    check('C-07 철회 건 → WITHDRAWN(매입 0), 함께 보낸 정상 건은 CONVERTED', by[w] === 'WITHDRAWN' && by[s] === 'CONVERTED' && (await cntPur(O.id)) === n0 + 1, r.json);
    const scope = process.env.C_EXPECT_CORP_SCOPE;
    check(`C-08 법인 범위 밖(서버 수집 범위 ${scope || '전체'}) 서울청과 건도 연결이 있으면 전환(설계 3.2 "막지 않는다")`, by[s] === 'CONVERTED', r.json);
    // 미리보기: 쓰기 0
    const p0 = (await q(`SELECT (SELECT count(*) FROM purchase)+(SELECT count(*) FROM purchase_doc)+(SELECT count(*) FROM purchase_doc_conversion) AS n`))[0].n;
    const pv = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [w, s, await ins({})] }, A);
    const p1 = (await q(`SELECT (SELECT count(*) FROM purchase)+(SELECT count(*) FROM purchase_doc)+(SELECT count(*) FROM purchase_doc_conversion) AS n`))[0].n;
    check('C-09 미리보기(R-138) → 쓰기 0, 철회 WITHDRAWN·이미 전환 ALREADY_CONVERTED·새 건 WILL_CONVERT', pv.status === 200 && p0 === p1
      && pv.json.data.summary.will_convert === 1 && pv.json.data.summary.already === 1, pv.json.data && pv.json.data.summary);
  }

  // ================= 권한 (API 직접) =================
  {
    const t = [await ins({})];
    const noTok = [await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: t }), await conv(null, t), await api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D })}`)];
    check('C-10 토큰 없음 → R-138·R-139·R-92 모두 401', noTok.every((x) => x.status === 401), noTok.map((x) => x.status));
    const vp = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: t }, SV.tok);
    const vc = await conv(SV.tok, t);
    const vl = await api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D })}`, null, SV.tok);
    check('C-11 조회 직원 → R-138·R-139 403 FORBIDDEN_ROLE, 매입 0, R-92 목록은 200', vp.status === 403 && vc.status === 403 && vc.json.code === 'FORBIDDEN_ROLE' && vl.status === 200 && (await activeConv(O.id, t)) === 0,
      [vp.status, vc.status, vc.json.code, vl.status]);
    const me = await api('GET', '/api/me', null, SV.tok);
    const meI = await api('GET', '/api/me', null, SI.tok);
    const allowOf = (m) => JSON.stringify(m.json).includes('purchase.convert_from_trade');
    check('C-12 /api/me 권한 — 조회 직원에는 purchase.convert_from_trade 없음, 입력 직원에는 있음', !allowOf(me) && allowOf(meI), { v: me.status, i: meI.status });
    const ic = await conv(SI.tok, t);
    const pid = ic.json.data?.results?.[0]?.purchase_id;
    const by = pid ? (await q(`SELECT created_by_staff_id FROM purchase WHERE id = $1`, [pid]))[0] : {};
    check('C-13 입력 직원 전환 → CONVERTED, created_by_staff_id = 그 직원', resSig(ic) === 'CONVERTED' && by.created_by_staff_id === SI.id, { ic: ic.json, by });
    const icx = await api('POST', `/api/purchases/${pid}/cancel`, { reason: 'C 직원 취소 시도' }, SI.tok);
    const vcx = await api('POST', `/api/purchases/${pid}/cancel`, { reason: 'C 조회 취소 시도' }, SV.tok);
    check('C-14 입력·조회 직원은 매입 취소(R-36) 불가(주인만) → 403, 전환 그대로 ACTIVE', icx.status === 403 && vcx.status === 403 && (await activeConv(O.id, t)) === 1, [icx.status, vcx.status]);
    const other = await api('GET', `/api/purchases?${qs({ from_date: D, to_date: D, ids: String(pid) })}`, null, O2.tok);
    const oc = await api('POST', `/api/purchases/${pid}/cancel`, { reason: '남의 매입' }, O2.tok);
    check('C-15 다른 회원이 내 매입 id 로 R-22 ids 조회 → 0건, 취소 시도 → 거절(2xx 아님)', other.status === 200 && (other.json.data || []).length === 0 && oc.status >= 400 && (await activeConv(O.id, t)) === 1,
      { n: (other.json.data || []).length, oc: oc.status });
  }

  // ================= 입력 방어: 정렬·원표번호 =================
  {
    const list = (o, tok = A) => api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D, limit: 200, ...o })}`, null, tok);
    const rows0 = (await q(`SELECT (SELECT count(*) FROM auction_trade)+(SELECT count(*) FROM purchase) AS n`))[0].n;
    const badSort = ['unit_price;DROP TABLE auction_trade', "unit_price'--", 'unit_price DESC', 't.id', '1', 'UNIT_PRICE', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'unit_price,id', '(SELECT 1)', 'pg_sleep(3)', '%00', 'trade_date\u0000'];
    const sortRes = [];
    for (const s of badSort) sortRes.push([s, (await list({ sort: s })).status]);
    check('C-16 허용 밖 sort 15종(인젝션·대문자·JS 객체 키 constructor/__proto__ 등) → 전부 400', sortRes.every(([, st]) => st === 400), sortRes);
    const badDir = ['up', 'desc; DELETE FROM purchase', 'ascending', '1', 'asc desc', '__proto__'];
    const dirRes = [];
    for (const d of badDir) dirRes.push([d, (await list({ sort: 'qty', dir: d })).status]);
    check('C-17 허용 밖 dir 6종 → 전부 400 field=dir', dirRes.every(([, st]) => st === 400), dirRes);
    const dup = await api('GET', `/api/auction/trades?date_from=${D}&date_to=${D}&sort=qty&sort=unit_price`, null, A);
    check('C-18 sort 두 번(배열 파라미터) → 400(500 아님)', dup.status === 400, dup.status);
    const up = await list({ sort: 'qty', dir: 'ASC' });
    note(`dir=ASC(대문자) → ${up.status} (서버는 소문자로 바꿔 받음: ${up.json.meta && up.json.meta.dir})`);
    const rows1 = (await q(`SELECT (SELECT count(*) FROM auction_trade)+(SELECT count(*) FROM purchase) AS n`))[0].n;
    check('C-19 인젝션 시도 뒤 DB 행 수 변화 0', rows0 === rows1, { rows0, rows1 });

    const Z = await ins({ ship: '0030252' });
    const Z2 = await ins({ ship: '30252' }); // 같은 날 앞자리 0 다른 두 원표(실제로는 법인마다 자릿수 고정이라 드묾)
    const shipCase = async (v) => { const r = await list({ shipment_no: v }); return { v, st: r.status, ids: (r.json.data || []).map((x) => x.id).sort(), code: r.json.field }; };
    const cases = [];
    for (const v of ['30252', '030252', '0030252', '00030252', ' 30252 ', '30-252', '3.0252', '-30252', '\t30252\n']) cases.push(await shipCase(v));
    const want = [Z, Z2].sort().join();
    check('C-20 원표번호 앞자리 0·공백·하이픈·점·탭 변형 9종 → 모두 200, 0030252·30252 두 행만', cases.every((c) => c.st === 200 && c.ids.join() === want), cases);
    const bad = [];
    for (const v of ['12A4', '３０２５２', '30252%', "1' OR '1'='1", '1'.repeat(21), '30252,1', '+30252', '1e5', '_']) bad.push(await shipCase(v));
    check('C-21 원표번호 숫자 아님·전각·LIKE 문자·인젝션·21자리 등 9종 → 모두 400 field=shipment_no', bad.every((c) => c.st === 400 && c.code === 'shipment_no'), bad);
    const twenty = await shipCase('1'.repeat(20));
    const spaced21 = await shipCase(` ${'1'.repeat(4)}-${'1'.repeat(16)} `);
    check('C-22 20자리 → 200(0건), 하이픈·공백 빼면 20자리인 입력 → 200', twenty.st === 200 && spaced21.st === 200, [twenty, spaced21]);
    const empty = await shipCase('');
    const blank = await shipCase('   ');
    note(`원표번호 빈 값 '' → ${empty.st}(${empty.ids.length}건, 필터 없음 기대), 공백만 '   ' → ${blank.st}`);
    check('C-23 원표번호 빈 값 → 200(원표 조건 없이 기간 전체)', empty.st === 200 && empty.ids.length > 2, empty.st);
  }

  // ================= 취소 → 재전환 · 재고(FIFO) · 감사 =================
  {
    const t = await ins({ qty: 6, price: 21000 });
    const inv = async () => Number((await q(`SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2`, [O.id, P.id]))[0]?.quantity || 0);
    const aud = async () => (await q(`SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND entity_type = 'purchase_doc' AND after_data->>'route' = 'from_trades'`, [O.id]))[0].n;
    const i0 = await inv(); const a0 = await aud();
    const r1 = await conv(A, [t]);
    const pid1 = r1.json.data?.results?.[0]?.purchase_id;
    const i1 = await inv(); const a1 = await aud();
    const pu1 = (await q(`SELECT quantity::text AS q, status FROM purchase WHERE id = $1`, [pid1]))[0] || {};
    const lot1 = await q(`SELECT purchase_id, available::text AS av FROM inventory_lot_available WHERE purchase_id = $1`, [pid1]);
    const tr1 = await q(`SELECT count(*)::int AS n FROM product_transfer WHERE purchase_id = $1 AND to_type = 'inventory'`, [pid1]);
    check('C-24 전환 → 재고 +매입 수량, FIFO 로트(inventory_lot_available)에 그 매입, 입고 이동 이력 1건', pid1 && Math.abs(i1 - i0 - Number(pu1.q)) < 1e-9 && lot1.length === 1
      && Number(lot1[0].av) > 0 && tr1[0].n === 1, { i0, i1, pu1, lot1, tr1 });
    const ev1 = await q(`SELECT trade_id::int AS trade_id, actor_kind, detail FROM purchase_match_event WHERE user_id = $1 AND event_type = 'CONVERT_FROM_TRADE' AND purchase_id = $2`, [O.id, pid1]);
    check('C-25 감사 — 전환 1건에 CONVERT_FROM_TRADE 1건(trade_id·revision·shipment_no), 전환 요청 audit_log(from_trades) +1', ev1.length === 1 && ev1[0].trade_id === t
      && ev1[0].detail && ev1[0].detail.revision != null && ev1[0].detail.shipment_no && a1 === a0 + 1, { ev1, a0, a1 });
    const cx = await api('POST', `/api/purchases/${pid1}/cancel`, { reason: 'C 되돌리기' }, A);
    const i2 = await inv();
    const st = await q(`SELECT c.status AS cs, l.status AS ls, d.status AS ds FROM purchase_doc_conversion c JOIN purchase_doc_line l ON l.id = c.line_id JOIN purchase_doc d ON d.id = l.doc_id WHERE c.purchase_id = $1`, [pid1]);
    const lot2 = await q(`SELECT 1 FROM inventory_lot_available WHERE purchase_id = $1`, [pid1]);
    const cxAud = await q(`SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND entity_type = 'purchase' AND entity_id = $2`, [O.id, pid1]);
    check('C-26 취소(R-36) → 재고 원래대로, 로트 빠짐, 전환·줄 CANCELLED', cx.status === 200 && Math.abs(i2 - i0) < 1e-9 && lot2.length === 0 && st[0] && st[0].cs === 'CANCELLED' && st[0].ls === 'CANCELLED',
      { cx: cx.status, i0, i2, st, lot2: lot2.length });
    note(`취소 뒤 매입서 상태 ${st[0] && st[0].ds}, 매입 취소 audit_log(entity=purchase) ${cxAud[0].n}건`);
    const lr = await api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D, limit: 200 })}`, null, A);
    const row = (lr.json.data || []).find((x) => x.id === t) || {};
    const r2 = await conv(A, [t]);
    const pid2 = r2.json.data?.results?.[0]?.purchase_id;
    const i3 = await inv();
    const docs = await q(`SELECT count(DISTINCT l.doc_id)::int AS n FROM purchase_doc_conversion c JOIN purchase_doc_line l ON l.id = c.line_id WHERE c.user_id = $1 AND c.trade_id = $2`, [O.id, t]);
    const ev2 = await q(`SELECT count(*)::int AS n FROM purchase_match_event WHERE user_id = $1 AND event_type = 'CONVERT_FROM_TRADE' AND trade_id = $2`, [O.id, t]);
    check('C-27 취소 뒤 목록 convertible=true·converted_purchase_id=null → 재전환 CONVERTED 새 매입, 새 매입서(총 2건), 재고 다시 +수량, 이벤트 2건, 활성 1', row.convertible === true && row.converted_purchase_id == null
      && resSig(r2) === 'CONVERTED' && pid2 && pid2 !== pid1 && docs[0].n === 2 && Math.abs(i3 - i1) < 1e-9 && ev2[0].n === 2 && (await activeConv(O.id, [t])) === 1, { row, r2: r2.json, docs, i3, i1, ev2 });
    const again = await conv(A, [t]);
    check('C-28 재전환 뒤 또 전환 → ALREADY_CONVERTED(새 purchase_id 와 같음)', resSig(again) === 'ALREADY_CONVERTED' && again.json.data.results[0].purchase_id === pid2, again.json);
  }

  await pool.end();
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n[t203-convert-c-test] ${pass}/${results.length} PASS`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => { console.error('[t203-convert-c-test] 오류', e); process.exit(1); });
