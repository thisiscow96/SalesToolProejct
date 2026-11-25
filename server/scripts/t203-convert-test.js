/**
 * T-203 서버 테스트 — 원표번호 검색(S) · 열 정렬(O) · 경락 → 매입 전환(V) · R-22 ids · 032 (A 설계 7절 AC 중 서버 쪽, AC ID 를 테스트 이름에 그대로)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> node scripts/t203-convert-test.js
 * 전제: 마이그레이션 001~032, seed-sample-local(공용 품목 청양고추·꽈리고추·홍고추 …), 서버 기동(AUCTION_SOURCE_MODE=mock 권장)
 * 테스트 DB 전용 — 새 회원을 DB 에 직접 만들고, 경락 행을 이번 실행 날짜(무작위 과거 날짜)에 직접 넣는다(실 API 호출 없음).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const BASE = process.env.MATCH_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[t203-convert-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
}
const note = (s) => console.log(`NOTE ${s}`);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {}) : v);
const same = (x, y) => JSON.stringify(canon(x)) === JSON.stringify(canon(y));
const key = () => `k_${crypto.randomBytes(9).toString('hex')}`;
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
  const tag = Date.now().toString(36);
  // 이번 실행 날짜: 2023~2024 사이 무작위(다른 테스트의 경락·이전 실행과 겹치지 않게). 그날 다른 행이 있으면 정렬 검사를 이번 행으로 한정
  const D = addDays('2023-01-01', crypto.randomInt(0, 700));
  const D1 = addDays(D, 1);
  const D2 = addDays(D, 2);
  const D3 = addDays(D, 3);
  console.log(`[t203-convert-test] 기준일 ${D} tag ${tag}`);

  // ---------- 준비: 회원·직원·거래처·연결 ----------
  const mkUser = async (name, agent) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const id = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,$4,NOW(),'active',false) RETURNING id`,
      [name, `${agent}_${tag}@test.local`, agent, await bcrypt.hash(pw, 8)]))[0].id;
    const tok = (await api('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
    if (!tok) throw new Error(`로그인 실패 ${agent}`);
    return { id, tok, agent };
  };
  const O = await mkUser(`전환검사 ${tag}`, `cv_${tag}`);
  const O2 = await mkUser(`다른회원 ${tag}`, `cv2_${tag}`);
  const O3 = await mkUser(`대량회원 ${tag}`, `cv3_${tag}`);
  const A = O.tok;
  const staffTok = async (owner, loginId, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    const r = await api('POST', '/api/staff', { login_id: loginId, name: `직원${loginId}`, role, temp_password: spw }, owner.tok);
    if (r.status >= 300) throw new Error(`직원 ${loginId} ${r.status} ${JSON.stringify(r.json)}`);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [owner.id, loginId]);
    const sid = (await q(`SELECT id FROM staff_account WHERE owner_user_id = $1 AND login_id = $2`, [owner.id, loginId]))[0].id;
    return { tok: (await api('POST', '/api/auth/login', { agent_no: owner.agent, login_id: loginId, password: spw })).json.token, id: sid };
  };
  const SI = await staffTok(O, 'in1', 'input');
  const SV = await staffTok(O, 'vw1', 'view');
  const partner = async (tok, name) => (await api('POST', '/api/partners', { name, type: 'supplier' }, tok)).json?.data?.id;
  const PK = await partner(A, `한국청과 ${tag}`);
  const PD = await partner(A, `동화청과 ${tag}`);
  const PS = await partner(A, `서울청과 ${tag}`);
  const prod = async (name) => (await q(`SELECT id, unit FROM product WHERE owner_user_id IS NULL AND name = $1`, [name]))[0];
  const P = { 청양: await prod('청양고추'), 꽈리: await prod('꽈리고추'), 홍: await prod('홍고추') };
  check('준비 거래처 3곳·공용 품목', PK && PD && PS && P.청양 && P.꽈리 && P.홍, { PK, PD, PS, P });
  const links = async (owner, corp) => {
    const r1 = await api('PUT', '/api/auction/corp-links', { links: corp }, owner.tok);
    const r2 = await api('PUT', '/api/auction/product-links', { links: [{ item_key: 'PEPPER.CHEONGYANG', product_id: P.청양.id }, { item_key: 'PEPPER.KKWARI', product_id: P.꽈리.id },
      { item_key: 'PEPPER.RED', product_id: P.홍.id }] }, owner.tok);
    return r1.status === 200 && r2.status === 200 ? true : { r1: r1.json, r2: r2.json };
  };
  let lk = await links(O, [{ corp_code: '11000105', partner_id: PK }, { corp_code: '11000104', partner_id: PD }, { corp_code: '11000101', partner_id: PS }]);
  check('준비 법인 연결 3건(11000103 중앙청과는 연결 안 함)·품목 연결 3건(PAPRIKA.ORANGE 는 안 함)', lk === true, lk);
  const PK2 = await partner(O2.tok, `한국청과 ${tag}`);
  lk = await links(O2, [{ corp_code: '11000105', partner_id: PK2 }]);
  check('준비 다른 회원 연결', lk === true, lk);
  const PK3 = await partner(O3.tok, `한국청과 ${tag}`);
  lk = await links(O3, [{ corp_code: '11000105', partner_id: PK3 }]);
  check('준비 대량 회원 연결', lk === true, lk);

  // ---------- 준비: 경락 행 ----------
  const snap = async (date, phase) => (await q(
    `INSERT INTO collect_snapshot (source, market_code, trade_date, phase, status, finished_at, is_latest_ok) VALUES ('AT_REALTIME','110001',$1,$2,'COMPLETE',NOW(),true) RETURNING id`,
    [date, phase]))[0].id;
  const snapD = await snap(D, 'INTRADAY'); // D: 확정 전(실시간)
  const snapD1 = await snap(D1, 'INTRADAY');
  const snapD2 = await snap(D2, 'FINAL'); // D2: 확정
  const snapD3 = await snap(D3, 'FINAL');
  const snapOf = { [D]: snapD, [D1]: snapD1, [D2]: snapD2, [D3]: snapD3 };
  const CORP = { '11000101': '서울청과㈜', '11000103': '㈜중앙청과', '11000104': '동화청과㈜', '11000105': '한국청과㈜' };
  const VAR = { 'PEPPER.CHEONGYANG': '청양', 'PEPPER.KKWARI': '꽈리', 'PEPPER.RED': '홍고추', 'PAPRIKA.ORANGE': '주황 파프리카' };
  const ins = async (o) => {
    const date = o.date || D;
    const source = o.source || 'AT_REALTIME';
    const seq = o.seq == null ? null : String(o.seq);
    const ship = o.ship == null ? null : String(o.ship);
    const rowKey = source === 'AT_REALTIME' && ship ? `110001|${date}|${o.corp}|${ship}|${seq}` : `${source}|${tag}|${crypto.randomBytes(6).toString('hex')}`;
    const kg = o.kg === undefined ? '10.000' : o.kg;
    const qty = o.qty || 10;
    const price = o.price || 25000;
    const itemKey = o.unmapped ? null : (o.item || 'PEPPER.CHEONGYANG');
    const r = await q(
      `INSERT INTO auction_trade (source, source_row_key, trade_date, auction_at, market_code, market_name, corp_code, corp_name, item_name_raw, item_key, map_status, grade_name, grade_norm,
                                  pkg_name, pkg_norm, unit_qty_kg, weight_source, qty, unit_price, price_per_kg, amount, origin_name, auction_seq, shipment_no, snapshot_id, content_hash, withdrawn_at)
       VALUES ($1,$2,$3,$4,'110001','가락',$5,$6,$7,$8,$9,$10,$11,'상자','BOX',$12::numeric,$13,$14::numeric,$15::bigint,$16::numeric,ROUND($14::numeric * $15::bigint)::bigint,$17,$18,$19,$20,$21,$22)
       RETURNING id`,
      [source, rowKey, date, o.at === null ? null : (o.at || `${date}T0${3 + (o.n || 0) % 6}:1${(o.n || 0) % 10}:00+09:00`), o.corp, CORP[o.corp], itemKey ? VAR[itemKey] : `미매핑품목${tag}`, itemKey,
        itemKey ? 'MAPPED' : 'UNMAPPED', o.gradeName || null, o.grade || null, kg, kg == null ? 'UNKNOWN' : 'SOURCE', String(qty), price,
        o.ppk === null ? null : (kg ? (price / Number(kg)).toFixed(2) : null), o.origin || '경북 영양', seq, ship, snapOf[date], 'x'.repeat(64), o.withdrawn ? new Date().toISOString() : null]);
    return Number(r[0].id);
  };
  const S1 = `1320${digits(10)}`; // 한국청과 14자리
  const SD = `0${digits(5)}`; // 동화청과 6자리 앞자리 0
  const SD_ = SD.replace(/^0+/, '');
  const T = {};
  T.k1 = await ins({ corp: '11000105', ship: S1, seq: 1, item: 'PEPPER.CHEONGYANG', grade: 'HIGH', qty: 10, price: 25000, n: 1 });
  T.k2 = await ins({ corp: '11000105', ship: S1, seq: 2, item: 'PEPPER.KKWARI', grade: 'MID', kg: '4.000', qty: 5, price: 12000, n: 2 }); // 꽈리 3kg 품목 ↔ 4kg → 환산 안 떨어짐
  T.k3 = await ins({ corp: '11000105', ship: S1, seq: 3, item: 'PEPPER.RED', grade: 'SPECIAL', qty: 7, price: 31000, n: 3 });
  T.kU = await ins({ corp: '11000105', ship: S1, seq: 4, unmapped: true, n: 4 }); // 미매핑
  T.kNext = await ins({ date: D1, corp: '11000105', ship: S1, seq: 1, qty: 2, price: 20000, n: 5 }); // 같은 원표번호 다음 날
  T.d1 = await ins({ corp: '11000104', ship: SD, seq: 1, item: 'PEPPER.CHEONGYANG', grade: 'LOW', qty: 3, price: 18000, n: 6 });
  T.d2 = await ins({ corp: '11000104', ship: SD, seq: 2, item: 'PEPPER.RED', grade: null, qty: 4, price: 22000, at: null, n: 7 }); // 낙찰시각 NULL
  T.s9 = await ins({ corp: '11000101', ship: '9', seq: 1, item: 'PEPPER.CHEONGYANG', grade: 'OFF', qty: 1, price: 9000, n: 8 });
  T.s10 = await ins({ corp: '11000101', ship: '10', seq: 1, item: 'PEPPER.CHEONGYANG', grade: 'NONE', qty: 2, price: 9500, kg: null, ppk: null, n: 9 }); // 무게 모름 → kg단가 NULL
  T.c1 = await ins({ corp: '11000103', ship: `20${digits(13)}`, seq: 1, item: 'PEPPER.CHEONGYANG', grade: 'HIGH', qty: 6, price: 26000, n: 10 }); // 법인 연결 없음
  T.or = await ins({ corp: '11000105', ship: `1321${digits(10)}`, seq: 1, item: 'PAPRIKA.ORANGE', grade: 'HIGH', qty: 4, price: 30000, n: 11 }); // 품목 연결 없음
  T.w = await ins({ corp: '11000105', ship: `1322${digits(10)}`, seq: 1, item: 'PEPPER.CHEONGYANG', grade: 'HIGH', qty: 3, price: 24000, withdrawn: true, n: 12 }); // 철회
  T.m = await ins({ source: 'MOCK', corp: '11000105', seq: 99, item: 'PEPPER.CHEONGYANG', grade: 'HIGH', qty: 2, price: 21000, n: 13 }); // 목업
  T.v1 = await ins({ corp: '11000105', ship: `1323${digits(10)}`, seq: 1, qty: 8, price: 23000, n: 14 }); // 동시 요청용
  T.v2 = await ins({ corp: '11000105', ship: `1323${digits(10)}`, seq: 2, qty: 9, price: 23500, n: 15 });
  T.x1 = await ins({ corp: '11000105', ship: `1324${digits(10)}`, seq: 1, qty: 4, price: 26500, n: 16 }); // 직원 전환
  T.x2 = await ins({ corp: '11000105', ship: `1324${digits(10)}`, seq: 2, qty: 5, price: 27000, n: 17 }); // 미리보기 뒤 철회
  T.x3 = await ins({ corp: '11000105', ship: `1324${digits(10)}`, seq: 3, qty: 6, price: 27500, n: 18 }); // 매입서 경로로 먼저 쓰임
  T.x4 = await ins({ corp: '11000105', ship: `1324${digits(10)}`, seq: 4, qty: 7, price: 28000, n: 19 }); // 직접 전환 → 매입서 후보 제외(X-02)
  T.f1 = await ins({ date: D2, corp: '11000105', ship: `1325${digits(10)}`, seq: 1, qty: 3, price: 25500, n: 20 }); // 확정 데이터 날
  const dayRows = await q(`SELECT count(*)::int AS n FROM auction_trade WHERE trade_date = $1`, [D]);
  const mineOnly = dayRows[0].n === Object.keys(T).filter((k) => !['kNext', 'f1'].includes(k)).length;
  if (!mineOnly) note(`기준일 ${D} 에 다른 행 ${dayRows[0].n}건 — 정렬 검사는 응답 전체 순서로 그대로 본다`);

  const list = (o, tok = A) => api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D, limit: 200, ...o })}`, null, tok);
  const ids = (r) => (r.json.data || []).map((x) => x.id);

  // ================= 원표번호 검색 (S) =================
  let r = await list({ shipment_no: S1 });
  check('AC-S-01 원표번호 정확 일치 — 그 원표 행만(미매핑 1건 포함 4행), 다른 원표 0', r.status === 200 && r.json.total === 4 && r.json.data.every((x) => x.shipment_no === S1)
    && r.json.meta.shipment_no === S1, r.json);
  const s01 = ids(r).sort();
  r = await list({ shipment_no: S1, include_unmapped: 'false' });
  check('AC-S-01 원표번호 + include_unmapped=false 명시 → 미매핑 제외 3행', r.status === 200 && r.json.total === 3 && !ids(r).includes(T.kU), r.json.total);
  const a = await list({ shipment_no: SD_ });
  const b = await list({ shipment_no: SD });
  check('AC-S-02 앞자리 0 무시 — 30252 형태와 030252 형태 결과가 같고 저장값 0 보존', a.status === 200 && a.json.total === 2 && JSON.stringify(ids(a).sort()) === JSON.stringify(ids(b).sort())
    && a.json.data.every((x) => x.shipment_no === SD), { a: a.json.total, b: b.json.total, sample: a.json.data && a.json.data[0] && a.json.data[0].shipment_no });
  r = await list({ shipment_no: ` ${S1.slice(0, 4)}-${S1.slice(4, 8)}-${S1.slice(8)} ` });
  check('AC-S-03 공백·하이픈 섞인 입력 = AC-S-01 결과', r.status === 200 && JSON.stringify(ids(r).sort()) === JSON.stringify(s01), r.json);
  r = await list({ shipment_no: '12A4' });
  const r21 = await list({ shipment_no: '1'.repeat(21) });
  check('AC-S-04 숫자 외 문자·21자리 → 400 VALIDATION field=shipment_no', r.status === 400 && r.json.field === 'shipment_no' && r21.status === 400 && r21.json.field === 'shipment_no', { r: r.json, r21: r21.json });
  r = await list({ shipment_no: S1, item_key: 'PEPPER.RED', grade: 'SPECIAL', family: 'PEPPER', origin: '없는산지' });
  check('AC-S-05 품종·등급·산지 조건이 있어도 원표번호면 무시 — 다른 품종 행도 나옴', r.status === 200 && r.json.total === 4, r.json.total);
  r = await api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D1, shipment_no: S1 })}`, null, A);
  const r6 = await list({ shipment_no: S1 });
  check('AC-S-06 같은 원표번호가 두 날짜 — 기간 1일이면 그날만, 2일이면 둘 다', r.json.total === 5 && ids(r).includes(T.kNext) && !ids(r6).includes(T.kNext), { two: r.json.total });
  r = await list({ shipment_no: S1, corp_code: '11000104' });
  const r7 = await list({ shipment_no: S1, corp_code: '11000105' });
  check('AC-S-07 원표번호 + 법인 조건 유지', r.json.total === 0 && r7.json.total === 4, { other: r.json.total, same: r7.json.total });
  r = await list({ shipment_no: '99999999999999999' });
  check('AC-S-09 결과 0건 → 200 빈 배열', r.status === 200 && Array.isArray(r.json.data) && r.json.data.length === 0 && r.json.total === 0, r.json);
  {
    const TQ = require('../lib/auction/trade-query');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      // 테스트 DB 는 행이 적어 계획이 실행마다 달라진다 → 이 트랜잭션 안에서만 다른 auction_trade 인덱스를 빼고(ROLLBACK 으로 원복) 이 조건이 새 인덱스로 풀리는지만 본다.
      // 실제 규모(180일 36만 행) 선택은 I 실측(I_전환_DB검토.md 2.2: 032 적용 후 정확 일치 COUNT 0.14ms, idx_auction_trade_shipment 사용)
      await c.query('SET LOCAL enable_seqscan = off');
      for (const ix of ['idx_auction_trade_codes', 'idx_auction_trade_match', 'idx_auction_trade_corp', 'idx_auction_trade_snapshot']) await c.query(`DROP INDEX IF EXISTS ${ix}`); // eslint-disable-line no-await-in-loop
      const plan = (await c.query(`EXPLAIN SELECT t.id FROM auction_trade t WHERE t.trade_date BETWEEN $1 AND $2 AND t.shipment_no = ANY($3::text[]) AND t.map_status = 'MAPPED' AND t.withdrawn_at IS NULL`,
        [addDays(D, -30), D, TQ.shipmentVariants(SD_)])).rows.map((x) => x['QUERY PLAN']).join('\n');
      await c.query('ROLLBACK');
      check('AC-S-08 원표번호 조건이 idx_auction_trade_shipment 로 풀림(31일, 다른 인덱스는 트랜잭션 안에서만 제외 후 ROLLBACK)', /idx_auction_trade_shipment/.test(plan), plan);
      note(`AC-S-08 계획:\n${plan}`);
    } finally { c.release(); }
  }
  {
    const TQ = require('../lib/auction/trade-query');
    check('원표번호 매칭 한 곳(trade-query) — 기본 exact, contains 로 바꿀 수 있음', TQ.shipmentMatchMode({}) === 'exact' && TQ.shipmentMatchMode({ AUCTION_SHIPMENT_MATCH: 'contains' }) === 'contains'
      && TQ.shipmentVariants('030252')[0] === '30252' && TQ.shipmentVariants('030252').includes('030252') && TQ.shipmentVariants('000').includes('0'), TQ.shipmentVariants('030252').slice(0, 3));
  }

  // ================= 정렬 (O) =================
  const nl = (v) => v == null;
  const cmpVal = (x, y) => (typeof x === 'number' && typeof y === 'number' ? x - y : (x < y ? -1 : x > y ? 1 : 0));
  const by = (parts) => (p, s) => {
    for (const [get, dir, nullsLast = true] of parts) {
      const x = get(p); const y = get(s);
      if (nl(x) && nl(y)) continue;
      if (nl(x)) return nullsLast ? 1 : -1;
      if (nl(y)) return nullsLast ? -1 : 1;
      const c = cmpVal(x, y);
      if (c) return dir === 'asc' ? c : -c;
    }
    return 0;
  };
  const num = (v) => (v == null ? null : Number(v));
  const GR = { SPECIAL: 1, HIGH: 2, MID: 3, LOW: 4, OFF: 5, NONE: 6 };
  const fam = (x) => (x.item_label ? x.item_label.split(' · ')[0] : null);
  const vari = (x) => (x.item_label ? x.item_label.split(' · ')[1] : null);
  const len = (v) => (v == null ? null : String(v).length);
  const comparators = {
    trade_date: (d) => by([[(x) => x.trade_date, d], [(x) => x.auction_at, d], [(x) => x.id, d]]),
    auction_at: (d) => by([[(x) => x.auction_at, d], [(x) => x.id, d]]),
    corp: (d) => by([[(x) => x.corp_name, d], [(x) => x.trade_date, 'desc'], [(x) => x.auction_at, 'desc'], [(x) => x.id, d]]),
    shipment_no: (d) => by([[(x) => len(x.shipment_no), d], [(x) => x.shipment_no, d], [(x) => len(x.auction_seq), 'asc'], [(x) => x.auction_seq, 'asc'], [(x) => x.id, d]]),
    auction_seq: (d) => by([[(x) => len(x.auction_seq), d], [(x) => x.auction_seq, d], [(x) => x.id, d]]),
    item: (d) => by([[fam, d], [vari, d], [(x) => x.item_name_raw, d], [(x) => x.id, d]]),
    grade: (d) => by([[(x) => (x.grade_norm ? GR[x.grade_norm] : null), d], [(x) => x.id, d]]),
    unit_kg: (d) => by([[(x) => num(x.unit_qty_kg), d], [(x) => x.pkg_norm, d], [(x) => x.id, d]]),
    qty: (d) => by([[(x) => num(x.qty), d], [(x) => x.id, d]]),
    unit_price: (d) => by([[(x) => x.unit_price, d], [(x) => x.id, d]]),
    price_per_kg: (d) => by([[(x) => num(x.price_per_kg), d], [(x) => x.id, d]]),
    origin: (d) => by([[(x) => x.origin_name, d], [(x) => x.id, d]]),
  };
  const timing = [];
  let o1ok = true;
  const o1bad = [];
  for (const k of Object.keys(comparators)) {
    for (const d of ['asc', 'desc']) {
      const t0 = Date.now();
      // eslint-disable-next-line no-await-in-loop
      const rr = await list({ sort: k, dir: d });
      timing.push(`${k}/${d} ${Date.now() - t0}ms`);
      const got = rr.json.data || [];
      const want = [...got].sort(comparators[k](d));
      const okk = rr.status === 200 && rr.json.meta.sort === k && rr.json.meta.dir === d && got.length > 5 && JSON.stringify(got.map((x) => x.id)) === JSON.stringify(want.map((x) => x.id));
      if (!okk) { o1ok = false; o1bad.push({ k, d, status: rr.status, got: got.map((x) => x.id), want: want.map((x) => x.id) }); }
    }
  }
  check('AC-O-01 정렬 12키 × asc/desc 각각 200, 응답 순서가 설계 ORDER BY 와 같음(meta.sort·dir 포함)', o1ok, o1bad);
  r = await list({ sort: 'shipment_no', dir: 'asc' });
  const sh = r.json.data.map((x) => x.shipment_no);
  check('AC-O-02 원표번호 asc — 9 가 10 보다 앞, 앞자리 0 그대로', sh.indexOf('9') > -1 && sh.indexOf('9') < sh.indexOf('10') && sh.includes(SD), sh);
  const ra = await list({ sort: 'auction_at', dir: 'asc' });
  const rd = await list({ sort: 'auction_at', dir: 'desc' });
  const rk = await list({ sort: 'price_per_kg', dir: 'asc' });
  const lastIs = (rr, f) => { const dd = rr.json.data; return dd.length && f(dd[dd.length - 1]); };
  check('AC-O-03 NULL(낙찰시각·kg단가)은 asc·desc 모두 맨 뒤', lastIs(ra, (x) => x.auction_at == null) && lastIs(rd, (x) => x.auction_at == null) && lastIs(rk, (x) => x.price_per_kg == null),
    { ra: ra.json.data.slice(-2).map((x) => x.auction_at), rd: rd.json.data.slice(-2).map((x) => x.auction_at), rk: rk.json.data.slice(-2).map((x) => x.price_per_kg) });
  {
    const all = [];
    let total = null;
    for (let off = 0; off < 400; off += 3) {
      // eslint-disable-next-line no-await-in-loop
      const pg = await list({ sort: 'grade', dir: 'asc', limit: 3, offset: off });
      total = pg.json.total;
      all.push(...ids(pg));
      if (off + 3 >= total) break;
    }
    check('AC-O-04 동률 많은 열(등급)로 쪽당 3건씩 모든 쪽 — 모은 id = 전체, 중복 0·누락 0', all.length === total && new Set(all).size === total, { n: all.length, total });
  }
  const before = (await q(`SELECT count(*)::int AS n FROM auction_trade`))[0].n;
  r = await list({ sort: 'unit_price;DROP TABLE x' });
  const rDir = await list({ sort: 'unit_price', dir: 'up' });
  const rInj = await list({ sort: 'unit_price', dir: 'desc; DELETE FROM auction_trade' });
  const after = (await q(`SELECT count(*)::int AS n FROM auction_trade`))[0].n;
  check('AC-O-07 정렬 값 인젝션·잘못된 방향 → 400(field sort/dir), DB 변화 0', r.status === 400 && r.json.field === 'sort' && rDir.status === 400 && rDir.json.field === 'dir'
    && rInj.status === 400 && before === after, { r: r.json, rDir: rDir.json, before, after });
  {
    const old = {
      trade_date: 'ORDER BY t.trade_date DESC, t.auction_at DESC NULLS LAST, t.id DESC',
      unit_price: 'ORDER BY t.unit_price DESC, t.id DESC',
      price_per_kg: 'ORDER BY t.price_per_kg DESC NULLS LAST, t.id DESC',
    };
    let okk = true;
    const bad = [];
    for (const [k, ob] of Object.entries(old)) {
      // eslint-disable-next-line no-await-in-loop
      const want = (await q(`SELECT t.id FROM auction_trade t WHERE t.trade_date BETWEEN $1 AND $1 AND t.map_status = 'MAPPED' AND t.withdrawn_at IS NULL ${ob} LIMIT 200`, [D])).map((x) => Number(x.id));
      // eslint-disable-next-line no-await-in-loop
      const got = ids(await api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D, limit: 200, sort: k })}`, null, A));
      if (JSON.stringify(want) !== JSON.stringify(got)) { okk = false; bad.push({ k, want, got }); }
    }
    const noSort = ids(await api('GET', `/api/auction/trades?${qs({ date_from: D, date_to: D, limit: 200 })}`, null, A));
    const want0 = (await q(`SELECT t.id FROM auction_trade t WHERE t.trade_date = $1 AND t.map_status = 'MAPPED' AND t.withdrawn_at IS NULL ${old.trade_date} LIMIT 200`, [D])).map((x) => Number(x.id));
    check('AC-O-08 회귀 — sort=trade_date|unit_price|price_per_kg(dir 없음)·sort 없음 결과가 66da7f1 의 ORDER BY 와 같음', okk && JSON.stringify(noSort) === JSON.stringify(want0), bad);
  }
  note(`AC-O-09 응답 시간(테스트 DB, 기준일 1일·${(await list({})).json.total}행): ${timing.join(', ')}`);

  // ================= 목록 전환 표시 =================
  r = await list({ include_withdrawn: 'true', include_unmapped: 'true' });
  const rowOf = (rr, id) => (rr.json.data || []).find((x) => x.id === id);
  check('R-92 응답 convertible·not_convertible_reason — 철회 WITHDRAWN·미매핑 UNMAPPED_ITEM·정상 true', rowOf(r, T.w).not_convertible_reason === 'WITHDRAWN' && rowOf(r, T.w).convertible === false
    && rowOf(r, T.kU).not_convertible_reason === 'UNMAPPED_ITEM' && rowOf(r, T.k1).convertible === true && rowOf(r, T.k1).converted_purchase_id === null, [rowOf(r, T.w), rowOf(r, T.kU)].map((x) => x && x.not_convertible_reason));

  // ================= 매입 전환 (V) =================
  const cnt = async (uid) => (await q(`SELECT count(*)::int AS n FROM purchase WHERE user_id = $1`, [uid]))[0].n;
  const n0 = await cnt(O.id);
  r = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [T.k1, T.k3, T.d1, T.c1, T.k1] }, A);
  const pv = r.json.data;
  check('R-138 미리보기 — 건별 결과·합계, 중복 id 제거, 쓰기 0', r.status === 200 && pv.rows.length === 4 && pv.summary.will_convert === 3 && pv.summary.excluded === 1
    && pv.rows.find((x) => x.trade_id === T.c1).result === 'NO_CORP_LINK' && pv.rows.find((x) => x.trade_id === T.k1).partner.id === PK
    && pv.summary.total_amount === String((10 * 25000 + 7 * 31000 + 3 * 18000).toFixed(2)) && (await cnt(O.id)) === n0, r.json);
  check('AC-V-16 확정 전(실시간) 경락 → 미리보기 경고 BASE_NOT_FINAL', pv.rows.find((x) => x.trade_id === T.k1).warnings.includes('BASE_NOT_FINAL'), pv.rows[0]);
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.k1] }, A);
  check('R-139 Idempotency-Key 없음 → 400', r.status === 400, r.json);
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [] }, A, { 'idempotency-key': key() });
  const rBad = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: ['1;DROP'] }, A, { 'idempotency-key': key() });
  check('R-139 trade_ids 없음·형식 오류 → 400 VALIDATION field=trade_ids', r.status === 400 && r.json.field === 'trade_ids' && rBad.status === 400, { r: r.json, rBad: rBad.json });

  const K1 = key();
  const body1 = { trade_ids: [T.k1, T.k3, T.d1] };
  const first = await api('POST', '/api/purchase-docs/from-trades', body1, A, { 'idempotency-key': K1 });
  const fr = first.json.data || {};
  const conv = (id) => (fr.results || []).find((x) => x.trade_id === id) || {};
  const pids = [T.k1, T.k3, T.d1].map((id) => conv(id).purchase_id);
  const pur = await q(`SELECT id, partner_id, product_id, purchase_date::text AS d, quantity::text AS qn, unit_price::text AS up, total_amount::text AS tot, memo, origin_region, source_name,
                              purchase_doc_line_id, created_by_staff_id, status FROM purchase WHERE id = ANY($1::int[]) ORDER BY id`, [pids]);
  const pOf = (id) => pur.find((x) => x.id === conv(id).purchase_id) || {};
  const docs = await q(`SELECT DISTINCT d.id, d.input_kind, d.doc_date::text AS dd, d.supplier_partner_id, d.status, d.upload_id FROM purchase_doc d JOIN purchase_doc_line l ON l.doc_id = d.id
                         JOIN purchase p ON p.purchase_doc_line_id = l.id WHERE p.id = ANY($1::int[])`, [pids]);
  const cv = await q(`SELECT trade_id, mode, status, match_result FROM purchase_doc_conversion WHERE user_id = $1 AND trade_id = ANY($2::bigint[])`, [O.id, [T.k1, T.k3, T.d1]]);
  check('AC-V-01 전환 3건 — 매입 3건(매입일=경락일·수량·단가·금액·거래처·품목·memo 원표/경매)', first.status === 200 && fr.summary.converted === 3 && pur.length === 3
    && pOf(T.k1).d === D && Number(pOf(T.k1).qn) === 10 && Number(pOf(T.k1).up) === 25000 && Number(pOf(T.k1).tot) === 250000 && pOf(T.k1).partner_id === PK && pOf(T.k1).product_id === P.청양.id
    && pOf(T.d1).partner_id === PD && pOf(T.k3).product_id === P.홍.id && /원표 /.test(pOf(T.k1).memo) && /경매 1/.test(pOf(T.k1).memo) && pOf(T.k1).memo.includes(S1)
    && pOf(T.k1).origin_region === '경북 영양' && pOf(T.k1).source_name === '한국청과㈜', { first: first.json, pur });
  check('AC-V-01 매입서 = (거래처, 경락일)별 2건 input_kind=AUCTION·업로드 없음·CONVERTED, 전환 기록 3건 ACTIVE MANUAL EXACT', docs.length === 2 && docs.every((d) => d.input_kind === 'AUCTION' && d.upload_id == null && d.dd === D && d.status === 'CONVERTED')
    && cv.length === 3 && cv.every((x) => x.mode === 'MANUAL' && x.status === 'ACTIVE' && x.match_result === 'EXACT'), { docs, cv });
  check('R-139 응답 navigate — 매입정보 탭·그 날짜·purchase_ids', fr.navigate && fr.navigate.tab === 'purchases' && fr.navigate.from_date === D && fr.navigate.to_date === D
    && JSON.stringify([...fr.navigate.purchase_ids].sort()) === JSON.stringify([...pids].sort()), fr.navigate);
  const n1 = await cnt(O.id);
  const again = await api('POST', '/api/purchase-docs/from-trades', body1, A, { 'idempotency-key': K1 });
  check('AC-V-02 같은 키 + 같은 요청 → 첫 응답 그대로, 매입 추가 0', again.status === 200 && same(again.json.data, first.json.data) && (await cnt(O.id)) === n1, again.json);
  const reuse = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.k1] }, A, { 'idempotency-key': K1 });
  check('R-139 같은 키 + 다른 본문 → 422', reuse.status === 422, reuse.json);
  const dup = await api('POST', '/api/purchase-docs/from-trades', body1, A, { 'idempotency-key': key() });
  const dr = dup.json.data || {};
  check('AC-V-03 다른 키로 같은 trade_ids(중복 클릭) → 전부 ALREADY_CONVERTED·같은 purchase_id·매입 추가 0', dup.status === 200 && dr.results.every((x) => x.result === 'ALREADY_CONVERTED')
    && dr.results.every((x) => x.purchase_id === conv(x.trade_id).purchase_id) && (await cnt(O.id)) === n1 && dr.navigate && dr.navigate.purchase_ids.length === 3, dup.json);
  // 동시 2개
  const [c1, c2] = await Promise.all([
    api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.v1, T.v2] }, A, { 'idempotency-key': key() }),
    api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.v2, T.v1] }, A, { 'idempotency-key': key() }),
  ]);
  const act = await q(`SELECT count(*)::int AS n FROM purchase_doc_conversion WHERE user_id = $1 AND trade_id = ANY($2::bigint[]) AND status = 'ACTIVE'`, [O.id, [T.v1, T.v2]]);
  const resOf = (x) => (x.status === 200 ? x.json.data.results.map((y) => y.result).sort().join(',') : `HTTP${x.status}`);
  check('AC-V-04 동시 요청 2개(같은 trade_ids, 다른 키) → 매입 = 건수(이중 0), 한쪽 CONVERTED·다른 쪽 ALREADY_CONVERTED 또는 409', (await cnt(O.id)) === n1 + 2 && act[0].n === 2
    && [resOf(c1), resOf(c2)].sort().join('|').match(/^(ALREADY_CONVERTED,ALREADY_CONVERTED|HTTP409)\|CONVERTED,CONVERTED$|^CONVERTED,CONVERTED\|(ALREADY_CONVERTED,ALREADY_CONVERTED|HTTP409)$/),
  { c1: resOf(c1), c2: resOf(c2), act: act[0].n });

  // 일부 실패·제외 사유
  const n2 = await cnt(O.id);
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.c1, T.or, T.s10, T.k2, T.w, T.kU, 987654321] }, A, { 'idempotency-key': key() });
  const res = (id) => ((r.json.data || {}).results || []).find((x) => x.trade_id === id) || {};
  const leftover = await q(`SELECT count(*)::int AS n FROM purchase_doc_line WHERE user_id = $1 AND best_trade_id = ANY($2::bigint[])`, [O.id, [T.c1, T.or, T.s10, T.k2, T.w, T.kU]]);
  check('AC-V-06 법인 연결 없음 → NO_CORP_LINK, 매입서·줄·매입 0', res(T.c1).result === 'NO_CORP_LINK' && /거래처 연결이 없습니다/.test(res(T.c1).message) && leftover[0].n === 0, r.json);
  check('AC-V-07 품목 연결 없음 → NO_PRODUCT_LINK', res(T.or).result === 'NO_PRODUCT_LINK', res(T.or));
  check('AC-V-08 kg 품목인데 무게 모름 → UNIT_CHECK_NEEDED(WEIGHT_UNKNOWN), 환산 안 떨어짐 → UNIT_CHECK_NEEDED(UNIT_ROUNDING)', res(T.s10).result === 'UNIT_CHECK_NEEDED' && res(T.s10).detail.reason === 'WEIGHT_UNKNOWN'
    && res(T.k2).result === 'UNIT_CHECK_NEEDED' && res(T.k2).detail.reason === 'UNIT_ROUNDING', [res(T.s10), res(T.k2)]);
  check('AC-V-09 철회 → WITHDRAWN, 미매핑 → UNMAPPED_ITEM, 없는 id → NOT_FOUND, 매입 추가 0', res(T.w).result === 'WITHDRAWN' && res(T.kU).result === 'UNMAPPED_ITEM' && res(987654321).result === 'NOT_FOUND'
    && (await cnt(O.id)) === n2 && r.json.data.summary.converted === 0 && r.json.data.navigate === null, r.json.data && r.json.data.summary);
  {
    process.env.ALLOW_MOCK_CONVERT = 'false';
    const tc = require('../lib/purchase-match/trade-convert');
    const pvm = await tc.previewTrades(pool, O.id, [T.m]);
    check('AC-V-09 목업 경락(ALLOW_MOCK_CONVERT 꺼짐) → MOCK_SOURCE (서비스 직접 호출)', pvm.rows[0].result === 'MOCK_SOURCE', pvm.rows[0]);
  }
  // 일부 성공 + 일부 실패 한 요청
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.c1, T.s9] }, A, { 'idempotency-key': key() });
  check('AC-V-06 2건 중 1건 실패 → 1건 CONVERTED·1건 NO_CORP_LINK, summary converted 1 failed 1', r.status === 200 && r.json.data.summary.converted === 1 && r.json.data.summary.failed === 1
    && r.json.data.results.find((x) => x.trade_id === T.s9).result === 'CONVERTED', r.json);

  // 권한
  r = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [T.x1] }, SV.tok);
  const rv = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.x1] }, SV.tok, { 'idempotency-key': key() });
  check('AC-V-11 조회 직원 R-138·R-139 → 403 FORBIDDEN_ROLE', r.status === 403 && rv.status === 403 && rv.json.code === 'FORBIDDEN_ROLE', { r: r.json, rv: rv.json });
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.x1] }, SI.tok, { 'idempotency-key': key() });
  const px1 = r.json.data && r.json.data.results[0].purchase_id;
  const sp = await q(`SELECT p.created_by_staff_id, d.created_by_staff_id AS doc_staff FROM purchase p JOIN purchase_doc_line l ON l.id = p.purchase_doc_line_id JOIN purchase_doc d ON d.id = l.doc_id WHERE p.id = $1`, [px1]);
  const ev = await q(`SELECT actor_kind, actor_staff_id FROM purchase_match_event WHERE purchase_id = $1 AND event_type = 'CONVERT_FROM_TRADE'`, [px1]);
  check('AC-V-11 입력 직원 → 200 + 매입·매입서 created_by_staff_id·이력 actor = 그 직원', r.status === 200 && sp[0] && sp[0].created_by_staff_id === SI.id && sp[0].doc_staff === SI.id
    && ev[0] && ev[0].actor_kind === 'STAFF' && ev[0].actor_staff_id === SI.id, { r: r.json, sp, ev });
  const me = await api('GET', '/api/me', null, SI.tok);
  const meV = await api('GET', '/api/me', null, SV.tok);
  const allowOf = (m) => JSON.stringify(m.json).includes('purchase.convert_from_trade');
  check('권한 표 ui purchase.convert_from_trade — 입력 직원 있음·조회 직원 없음(GET /api/me)', allowOf(me) && !allowOf(meV), { in: me.status, vw: meV.status });

  // 감사
  {
    const evs = await q(`SELECT purchase_id, trade_id, detail, actor_kind FROM purchase_match_event WHERE user_id = $1 AND event_type = 'CONVERT_FROM_TRADE' AND purchase_id = ANY($2::int[])`, [O.id, pids]);
    
    const audB = await q(`SELECT count(*)::int AS n FROM audit_log WHERE user_id = $1 AND entity_type = 'purchase_doc' AND action = 'create' AND after_data->>'route' = 'from_trades'`, [O.id]);
    check('AC-V-13 감사 — 전환 1건마다 CONVERT_FROM_TRADE 1건(trade_id·revision·shipment_no·actor), 전환 묶음 audit_log(purchase_doc·create) 1건 이상(매입 등록 자체는 기존에도 audit_log 를 남기지 않음)', evs.length === 3
      && evs.every((e) => e.detail.trade_id === Number(e.trade_id) && e.detail.revision === 1 && e.detail.route === 'AUCTION' && e.actor_kind === 'OWNER')
      && evs.find((e) => Number(e.trade_id) === T.k1).detail.shipment_no === S1 && audB[0].n >= 1, { evs: evs.map((e) => e.detail), audB });
  }
  // 미리보기 뒤 철회
  r = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [T.x2] }, A);
  const willBefore = r.json.data.rows[0].result;
  await q(`UPDATE auction_trade SET withdrawn_at = NOW() WHERE id = $1`, [T.x2]);
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.x2] }, A, { 'idempotency-key': key() });
  check('AC-V-14 미리보기 "등록"이던 건이 등록 직전 철회 → 등록 결과 WITHDRAWN', willBefore === 'WILL_CONVERT' && r.json.data.results[0].result === 'WITHDRAWN', { willBefore, r: r.json });
  // 미리보기 뒤 정정(수집기가 값을 고침 → revision 2) — 경락 행을 잠그지 않는 대신 전환 시점 값으로 등록하고 revision 을 기록
  {
    const TR = await ins({ corp: '11000105', ship: `1327${digits(10)}`, seq: 1, qty: 4, price: 21000, n: 22 });
    const pvr = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [TR] }, A);
    await q(`UPDATE auction_trade SET unit_price = 22000, amount = 88000, price_per_kg = 2200, revision = 2, updated_at = NOW() WHERE id = $1`, [TR]);
    r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [TR] }, A, { 'idempotency-key': key() });
    const pr = r.json.data && r.json.data.results[0];
    const pp = pr && pr.purchase_id ? (await q(`SELECT unit_price::text AS up, total_amount::text AS tot FROM purchase WHERE id = $1`, [pr.purchase_id]))[0] : {};
    const ee = pr && pr.purchase_id ? (await q(`SELECT detail FROM purchase_match_event WHERE purchase_id = $1 AND event_type = 'CONVERT_FROM_TRADE'`, [pr.purchase_id]))[0] : {};
    check('전환 도중 정정 — 미리보기 단가 21000 → 정정 22000(revision 2) 뒤 전환하면 정정 값으로 등록하고 이력에 revision 2', pvr.json.data.rows[0].unit_price === '21000.00'
      && pr && pr.result === 'CONVERTED' && Number(pp.up) === 22000 && Number(pp.tot) === 88000 && ee && ee.detail.revision === 2, { pv: pvr.json.data.rows[0].unit_price, pr, pp, ee });
  }
  // 다른 회원
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.k1] }, O2.tok, { 'idempotency-key': key() });
  const l2 = await list({ shipment_no: S1 }, O2.tok);
  check('AC-V-15 다른 회원이 같은 경락 건 전환 가능(회원별 유일), 목록 converted_purchase_id 는 각자 것', r.status === 200 && r.json.data.results[0].result === 'CONVERTED'
    && rowOf(l2, T.k1).converted_purchase_id === r.json.data.results[0].purchase_id && rowOf(l2, T.k3).converted_purchase_id === null, r.json);
  r = await list({ shipment_no: S1 });
  check('R-92 전환된 행 converted_purchase_id·convertible=false·ALREADY_CONVERTED', rowOf(r, T.k1).converted_purchase_id === conv(T.k1).purchase_id && rowOf(r, T.k1).convertible === false
    && rowOf(r, T.k1).not_convertible_reason === 'ALREADY_CONVERTED', rowOf(r, T.k1));
  // 확정 데이터 날
  r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.f1] }, A, { 'idempotency-key': key() });
  check('AC-V-16 확정(FINAL) 데이터 날 → CONVERTED, BASE_NOT_FINAL 경고 없음 / 실시간 날은 CONVERTED + 경고', r.json.data.results[0].result === 'CONVERTED' && !r.json.data.results[0].warnings.includes('BASE_NOT_FINAL')
    && conv(T.k1).warnings.includes('BASE_NOT_FINAL'), { f1: r.json.data.results[0], k1: conv(T.k1).warnings });

  // 매입서 경로와 교차 (AC-V-05) + X-02 확인
  {
    // 매입서(화면 입력) 줄 → x3 를 R-128 수동 확정(FORCED)으로 먼저 씀 → 직접 전환은 TRADE_TAKEN
    const md = await api('POST', '/api/purchase-docs', { supplier_partner_id: PK, lines: [{ trade_date: D, item_name: '청양고추', spec: '10kg 상자', qty: 6, unit_price: 27500 }], auto_convert: false }, A, { 'idempotency-key': key() });
    const lineId = md.json.data && md.json.data.docs[0].lines[0].id;
    const ver = (await q(`SELECT version FROM purchase_doc_line WHERE id = $1`, [lineId]))[0].version;
    const cf = await api('POST', `/api/purchase-docs/lines/${lineId}/confirm`, { trade_id: T.x3, version: ver, accept_diff: true, reason: '검사 확정' }, A, { 'idempotency-key': key() });
    const n3 = await cnt(O.id);
    r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.x3] }, A, { 'idempotency-key': key() });
    check('AC-V-05 매입서 줄로 이미 전환된 경락 건 → TRADE_TAKEN(매입서 #-줄 문구), 매입 추가 0', md.status === 201 && cf.status === 200 && r.json.data.results[0].result === 'TRADE_TAKEN'
      && /매입서 #\d+-\d+/.test(r.json.data.results[0].message) && (await cnt(O.id)) === n3, { md: md.status, cf: cf.json, r: r.json });
    // 반대: 직접 전환된 x4 → 매입서 줄 후보에서 빠지고(X-02: A안은 line_id NULL 행이 없어 `<>` 비교가 맞음), R-128 확정은 TRADE_TAKEN
    r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.x4] }, A, { 'idempotency-key': key() });
    const md2 = await api('POST', '/api/purchase-docs', { supplier_partner_id: PK, lines: [{ trade_date: D, item_name: '청양고추', spec: '10kg 상자', qty: 7, unit_price: 28000 }], auto_convert: false }, A, { 'idempotency-key': key() });
    const line2 = md2.json.data && md2.json.data.docs[0].lines[0].id;
    const cand = await api('GET', `/api/purchase-docs/lines/${line2}/candidates`, null, A);
    const candIds = ((cand.json.data || {}).candidates || []).map((x) => x.trade_id);
    const ver2 = (await q(`SELECT version FROM purchase_doc_line WHERE id = $1`, [line2]))[0].version;
    const cf2 = await api('POST', `/api/purchase-docs/lines/${line2}/confirm`, { trade_id: T.x4, version: ver2, accept_diff: true, reason: '검사 확정' }, A, { 'idempotency-key': key() });
    const nullLines = (await q(`SELECT count(*)::int AS n FROM purchase_doc_conversion WHERE line_id IS NULL`))[0].n;
    check('AC-V-05 반대 — 직접 전환된 경락 건은 매입서 줄 후보에서 빠지고(X-02 영향 없음), R-128 확정은 409 TRADE_TAKEN', r.json.data.results[0].result === 'CONVERTED' && md2.status === 201
      && !candIds.includes(T.x4) && cf2.status === 409 && cf2.json.code === 'TRADE_TAKEN' && nullLines === 0, { candIds, cf2: cf2.json, nullLines });
    // 업로드 매입서 줄의 1순위 후보인 경락을 직접 전환 → 경고 DOC_LINE_PENDING (막지 않음)
    const T5 = await ins({ corp: '11000105', ship: `1326${digits(10)}`, seq: 1, qty: 11, price: 29000, n: 21 });
    await q(`UPDATE purchase_doc_line SET best_trade_id = $1 WHERE id = $2`, [T5, line2]);
    r = await api('POST', '/api/purchase-docs/from-trades/preview', { trade_ids: [T5] }, A);
    check('R-138 업로드 매입서 대기 줄의 후보 경락 → 경고 DOC_LINE_PENDING(막지 않음)', r.json.data.rows[0].result === 'WILL_CONVERT' && r.json.data.rows[0].warnings.includes('DOC_LINE_PENDING'), r.json.data.rows[0]);
  }
  // 취소 → 재전환
  {
    const pid = conv(T.k3).purchase_id;
    const cr = await api('POST', `/api/purchases/${pid}/cancel`, { reason: '매입정보 화면에서 취소' }, A);
    const st = await q(`SELECT c.status AS cs, l.status AS ls FROM purchase_doc_conversion c JOIN purchase_doc_line l ON l.id = c.line_id WHERE c.purchase_id = $1`, [pid]);
    const lr = await list({ shipment_no: S1 });
    r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [T.k3] }, A, { 'idempotency-key': key() });
    const active = await q(`SELECT count(*)::int AS n FROM purchase_doc_conversion WHERE user_id = $1 AND trade_id = $2 AND status = 'ACTIVE'`, [O.id, T.k3]);
    check('AC-V-12 주인이 매입정보에서 매입 취소 → 전환·줄 CANCELLED, 목록 convertible 복귀, 다시 전환 → 새 매입 1건(활성 1건)', cr.status === 200 && st[0] && st[0].cs === 'CANCELLED' && st[0].ls === 'CANCELLED'
      && rowOf(lr, T.k3).convertible === true && r.json.data.results[0].result === 'CONVERTED' && r.json.data.results[0].purchase_id !== pid && active[0].n === 1, { cr: cr.json, st, r: r.json });
  }

  // ================= R-22 ids =================
  {
    const want = [conv(T.k1).purchase_id, conv(T.d1).purchase_id];
    r = await api('GET', `/api/purchases?${qs({ from_date: D, to_date: D, ids: want.join(',') })}`, null, A);
    const got = (r.json.data || []).map((x) => x.id).sort();
    const rb = await api('GET', `/api/purchases?${qs({ from_date: D, to_date: D, ids: '1,abc' })}`, null, A);
    const ro = await api('GET', `/api/purchases?${qs({ from_date: D, to_date: D, ids: want.join(',') })}`, null, O2.tok);
    const rAll = await api('GET', `/api/purchases?${qs({ from_date: D, to_date: D })}`, null, A);
    check('R-22 ids — 그 매입만(기간 AND), 형식 오류 400 field=ids, 남의 매입 0, ids 없으면 기존 그대로', r.status === 200 && JSON.stringify(got) === JSON.stringify([...want].sort())
      && rb.status === 400 && rb.json.field === 'ids' && (ro.json.data || []).length === 0 && (rAll.json.data || []).length > 2
      && r.json.data.every((x) => x.purchase_doc_kind === 'AUCTION' && x.purchase_doc_id), { got, rb: rb.json, ro: (ro.json.data || []).length });
  }

  // ================= 200건 / 201건 =================
  {
    const many = [];
    for (let i = 0; i < 200; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      many.push(await ins({ date: D3, corp: '11000105', ship: `1399${String(i).padStart(10, '0')}`, seq: 1, qty: 1 + (i % 5), price: 20000 + i, n: i }));
    }
    r = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: [...many, 999999999] }, O3.tok, { 'idempotency-key': key() });
    const t0 = Date.now();
    const r200 = await api('POST', '/api/purchase-docs/from-trades', { trade_ids: many }, O3.tok, { 'idempotency-key': key() });
    const ms = Date.now() - t0;
    const docs3 = await q(`SELECT count(*)::int AS n, max(line_count) AS lc FROM purchase_doc WHERE user_id = $1 AND input_kind = 'AUCTION'`, [O3.id]);
    check('AC-V-10 201건 → 400, 200건 → 200건 CONVERTED(매입서 1건 200줄)', r.status === 400 && r.json.field === 'trade_ids' && r200.status === 200 && r200.json.data.summary.converted === 200
      && docs3[0].n === 1 && docs3[0].lc === 200 && (await cnt(O3.id)) === 200, { r: r.json, s: r200.json.data && r200.json.data.summary, docs3 });
    note(`AC-V-10 200건 전환 1회 ${ms}ms (테스트 DB)`);
  }

  // ================= 032 =================
  {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '032_t203_trade_convert.sql'), 'utf8');
    const defs = async () => (await q(`SELECT conname, pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname IN ('purchase_doc_kind_chk','purchase_doc_upload_need','pme_type_chk') ORDER BY 1`));
    const before2 = JSON.stringify(await defs());
    const rows0 = (await q(`SELECT (SELECT count(*) FROM purchase_doc) + (SELECT count(*) FROM purchase_match_event) AS n`))[0].n;
    let err = null;
    try { await pool.query(sql); await pool.query(sql); } catch (e) { err = e.message; }
    const after2 = JSON.stringify(await defs());
    const rows1 = (await q(`SELECT (SELECT count(*) FROM purchase_doc) + (SELECT count(*) FROM purchase_match_event) AS n`))[0].n;
    const ix = await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_auction_trade_shipment'`);
    check('AC-R-03 032 를 두 번 더 적용 — 오류 0, 제약 정의·행 수 변화 0, 인덱스 1개', !err && before2 === after2 && rows0 === rows1 && ix.length === 1 && /AUCTION/.test(after2) && /CONVERT_FROM_TRADE/.test(after2), { err, ix });
    let bad = null;
    try { await pool.query(`INSERT INTO purchase_doc (user_id, input_kind, upload_id, doc_date, supplier_partner_id) VALUES ($1, 'AUCTION', 1, $2, $3)`, [O.id, D, PK]); } catch (e) { bad = e.code; }
    check('032 AUCTION 매입서에 upload_id 가 있으면 CHECK 23514', bad === '23514', bad);
  }

  await pool.end();
  const fail = results.filter((x) => !x.ok);
  console.log(`\n[t203-convert-test] ${results.length - fail.length}/${results.length} PASS${fail.length ? ` — FAIL: ${fail.map((x) => x.name).join(' | ')}` : ''}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('[t203-convert-test] 오류', e); process.exit(1); });
