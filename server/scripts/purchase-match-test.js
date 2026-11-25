/**
 * T-203 서버 통합 테스트 — 가락 경락 수집 + 매입서 대조·매입전환 (설계 8장 AC 중 서버 쪽)
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> COLLECT_TRIGGER_TOKEN=<서버와 같은 값> node scripts/purchase-match-test.js
 * 전제: 마이그레이션 001~027, seed-sample-local(공용 품목 청양고추·꽈리고추·홍고추·오이고추·빨강 파프리카), 서버 기동 —
 *   서버 환경: AUCTION_SOURCE_MODE=mock, ALLOW_MOCK_CONVERT=true, AUCTION_MOCK_CONTROL=true, AUCTION_HTTP_TIMEOUT_MS=400, COLLECT_TRIGGER_TOKEN
 * 테스트 DB 전용 — 새 회원을 DB에 직접 만들고, 수집 일정(collect_schedule)을 끄고, 남은 대기 작업을 취소한다.
 * 목업 경락은 요청 날짜로 바꿔 돌려주므로(같은 15건) 시나리오마다 날짜를 띄워(10일) 서로 후보가 섞이지 않게 한다.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const BASE = process.env.MATCH_API_BASE || process.env.SETTLE_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
const TICK = process.env.COLLECT_TRIGGER_TOKEN || '';
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) {
  console.error('[purchase-match-test] 로컬 테스트 DB(DATABASE_URL=127.0.0.1/localhost)에서만 실행합니다.');
  process.exit(2);
}
if (TICK.length < 16) { console.error('[purchase-match-test] COLLECT_TRIGGER_TOKEN(16자 이상)을 서버와 같게 지정하세요.'); process.exit(2); }

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 900)}`);
}
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {}) : v);
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const key = () => `k_${crypto.randomBytes(9).toString('hex')}`;
async function api(method, p, body, token, headers = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  const text = await r.text();
  try { j = JSON.parse(text); } catch { j = { _text: text.slice(0, 200) }; }
  return { status: r.status, json: j, headers: r.headers };
}
async function upload(p, buf, token, name, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(BASE + p, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  let j = null;
  try { j = await r.json(); } catch { /* */ }
  return { status: r.status, json: j };
}
async function xlsx(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('입력');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, params) => (await pool.query(sql, params)).rows;
  const tag = Date.now().toString(36);

  // ---------- 준비 ----------
  await q(`UPDATE collect_schedule SET active = false`);
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW(), locked_by = NULL, locked_at = NULL WHERE status IN ('QUEUED','RUNNING')`);
  const resetCircuit = () => q(`UPDATE ext_circuit_state SET state = 'CLOSED', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL, disabled_reason = NULL, disabled_until = NULL, cooldown_sec = 600`);
  await resetCircuit();
  // 경락 보관 정리(AUCTION_TRADE_KEEP_DAYS)가 옛 경락을 지워도 이전 실행 날짜와 겹치지 않게 작업·스냅샷·매입서 날짜까지 본다
  const minDate = (await q(`SELECT COALESCE(LEAST((SELECT MIN(trade_date) FROM auction_trade), (SELECT MIN(trade_date) FROM collect_job), (SELECT MIN(trade_date) FROM collect_snapshot),
                                                 (SELECT MIN(trade_date) FROM purchase_doc_line)), DATE '2026-11-23')::text AS d`))[0].d;
  const B = addDays(minDate, -120); // 이번 실행 기준일(실행마다 120일씩 앞으로)
  const slot = (i) => addDays(B, -10 * i);
  console.log(`[purchase-match-test] 기준일 ${B}`);

  await q(`UPDATE "user" SET agent_no = agent_no || '_' || id WHERE agent_no = '1001'`); // 목업 낙찰자 번호 1001 을 이번 회원에게
  const mkUser = async (name, agent, admin = false) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const id = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status, is_admin) VALUES ($1,$2,$3,$4,NOW(),'active',$5) RETURNING id`,
      [name, `${agent}_${tag}@test.local`, agent, await bcrypt.hash(pw, 8), admin]))[0].id;
    const tok = (await api('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
    if (!tok) throw new Error(`로그인 실패 ${agent}`);
    return { id, tok };
  };
  const O = await mkUser(`대조검사 ${tag}`, '1001');
  const ADM = await mkUser(`대조관리자 ${tag}`, `t203a_${tag}`, true);
  const OTHER = await mkUser(`다른회원 ${tag}`, `t203o_${tag}`);
  const A = O.tok;
  const staffTok = async (loginId, role) => {
    const spw = `St-${crypto.randomBytes(6).toString('hex')}`;
    const r = await api('POST', '/api/staff', { login_id: loginId, name: `직원${loginId}`, role, temp_password: spw }, A);
    if (r.status >= 300) throw new Error(`직원 ${loginId} ${r.status} ${JSON.stringify(r.json)}`);
    await q(`UPDATE staff_account SET must_change_password = false WHERE owner_user_id = $1 AND login_id = $2`, [O.id, loginId]);
    return (await api('POST', '/api/auth/login', { agent_no: '1001', login_id: loginId, password: spw })).json.token;
  };
  const SI = await staffTok('in1', 'input');
  const SV = await staffTok('vw1', 'view');
  const partner = async (name, type = 'supplier', tok = A) => (await api('POST', '/api/partners', { name, type }, tok)).json?.data?.id;
  const PA = await partner('A청과');
  const PB = await partner('B청과');
  const PC = await partner('C농협공판장');
  const CUS = await partner('검사 판매처', 'customer');
  check('준비 거래처 4곳', PA && PB && PC && CUS, { PA, PB, PC, CUS });
  const prod = async (name) => (await q(`SELECT id, unit FROM product WHERE owner_user_id IS NULL AND name = $1`, [name]))[0];
  const P = { 청양: await prod('청양고추'), 꽈리: await prod('꽈리고추'), 홍: await prod('홍고추'), 오이: await prod('오이고추'), 적: await prod('빨강 파프리카'), 황: await prod('노랑 파프리카') };
  check('준비 공용 품목(seed-sample-local)', Object.values(P).every(Boolean), P);
  const personal10 = (await api('POST', '/api/products/personal', { name: `꽈리10단위 ${tag}`, unit: '10kg' }, A)).json?.data?.id;

  // ---------- 설정 R-108~R-115 ----------
  let r = await api('PUT', '/api/auction/corp-links', { links: [{ corp_code: '11000101', partner_id: PA }, { corp_code: '11000102', partner_id: PB }, { corp_code: '11000103', partner_id: PC }] }, A);
  check('R-112 법인 연결 3건', r.status === 200 && r.json.data.saved === 3, r.json);
  r = await api('PUT', '/api/auction/corp-links', { links: [{ corp_code: '11000109', partner_id: CUS }] }, A);
  check('R-112 판매처는 법인 연결 불가 400 PARTNER_TYPE', r.status === 400 && r.json.code === 'PARTNER_TYPE', r.json);
  r = await api('PUT', '/api/auction/product-links', { links: [
    { item_key: 'PEPPER.CHEONGYANG', product_id: P.청양.id }, { item_key: 'PEPPER.KKWARI', product_id: P.꽈리.id }, { item_key: 'PEPPER.RED', product_id: P.홍.id },
    { item_key: 'PEPPER.OI', product_id: P.오이.id }, { item_key: 'PEPPER.GENERAL', product_id: P.청양.id }, { item_key: 'PAPRIKA.RED', product_id: P.적.id },
    { item_key: 'PAPRIKA.YELLOW', product_id: P.황.id }, { item_key: 'PAPRIKA.ORANGE', product_id: P.황.id }] }, A);
  check('R-109 품목 연결 8건', r.status === 200 && r.json.data.saved === 8, r.json);
  const otherPersonal = (await api('POST', '/api/products/personal', { name: `남의품목 ${tag}`, unit: 'kg' }, OTHER.tok)).json?.data?.id;
  r = await api('PUT', '/api/auction/product-links', { links: [{ item_key: 'PEPPER.RED', product_id: otherPersonal }] }, A);
  check('AC-33 남의 개인 품목으로 연결 → 400 PRODUCT_NOT_FOUND', r.status === 400 && r.json.code === 'PRODUCT_NOT_FOUND', r.json);
  r = await api('PUT', '/api/auction/product-links', { links: [{ item_key: 'PEPPER.RED', product_id: 2000000000 }] }, A);
  check('AC-33 시스템 품목으로 연결 → 400 PRODUCT_NOT_FOUND', r.status === 400 && r.json.code === 'PRODUCT_NOT_FOUND', r.json);
  r = await api('GET', '/api/auction/product-links', null, SV);
  check('R-108 조회 직원도 품목 연결 조회', r.status === 200 && r.json.data.length === 8, r.json);
  r = await api('PUT', '/api/purchase-match/tolerances', { price_pct_auto: 12 }, A);
  check('AC-40 허용오차 자동 > 후보 → 400 field price_pct_auto', r.status === 400 && r.json.field === 'price_pct_auto', r.json);
  r = await api('PUT', '/api/purchase-match/tolerances', { amount_abs_auto: 99999 }, A);
  check('AC-40 허용오차 금액 범위 밖 → 400 field amount_abs_auto', r.status === 400 && r.json.field === 'amount_abs_auto', r.json);
  r = await api('GET', '/api/purchase-match/tolerances', null, A);
  check('R-113 기본 허용오차(U-01) 0/10·0/20·0원·−1~0/−3~+1·85·10', r.status === 200 && Number(r.json.data.effective.price_pct_review) === 10 && r.json.data.effective.auto_min_score === 85, r.json);
  const defId = r.json.data.default_row.id;
  r = await api('DELETE', `/api/purchase-match/tolerances/${defId}`, null, A);
  check('R-115 기본 허용오차 삭제 → 403 DEFAULT_ROW', r.status === 403 && r.json.code === 'DEFAULT_ROW', r.json);

  // ---------- 수집 도우미 ----------
  let seq = 0;
  const tick = (token = TICK) => api('POST', '/api/internal/collect/tick', {}, null, { 'x-collect-token': token });
  const job = async (id) => (await q(`SELECT * FROM collect_job WHERE id = $1`, [id]))[0];
  async function enqueue(date, phase, scenario, extra = {}) {
    seq += 1;
    return (await q(`INSERT INTO collect_job (job_type, source, market_code, trade_date, phase, params, dedupe_key) VALUES ($1,$2,'110001',$3,$4,$5::jsonb,$6) RETURNING id`,
      [extra.job_type || 'COLLECT', extra.source || 'AT_REALTIME', date, phase, JSON.stringify({ mock_scenario: scenario, ...(extra.params || {}) }), `TEST:${tag}:${seq}`]))[0].id;
  }
  async function runJob(id, maxTicks = 10) {
    for (let i = 0; i < maxTicks; i += 1) {
      const j = await job(id);
      if (!['QUEUED', 'RUNNING'].includes(j.status)) return j;
      if (j.status === 'QUEUED' && new Date(j.run_after) > new Date(Date.now() + 1000)) return j;
      // eslint-disable-next-line no-await-in-loop
      await tick();
    }
    return job(id);
  }
  const collect = async (date, phase = 'FINAL', scenario = 'normal', extra) => runJob(await enqueue(date, phase, scenario, extra));
  const drain = async () => { for (let i = 0; i < 12; i += 1) { const t = await tick(); if (!t.json || !t.json.ran || !t.json.ran.length) break; } };
  const snap = async (date, phase) => (await q(`SELECT * FROM collect_snapshot WHERE source = 'AT_REALTIME' AND market_code = '110001' AND trade_date = $1 AND ($2::text IS NULL OR phase = $2) ORDER BY id DESC LIMIT 1`, [date, phase || null]))[0];
  const trades = async (date) => q(`SELECT *, trade_date::text AS trade_date FROM auction_trade WHERE source = 'MOCK' AND trade_date = $1 ORDER BY source_row_key`, [date]);
  const T = async (date, seqNo) => (await q(`SELECT * FROM auction_trade WHERE source = 'MOCK' AND trade_date = $1 AND auction_seq LIKE $2`, [date, `%-${String(seqNo).padStart(5, '0')}`]))[0];

  // ---------- AC-37 tick 토큰 ----------
  r = await tick('wrong-token-0123456789');
  check('AC-37 tick 토큰 틀림 → 404', r.status === 404, r.status);
  r = await api('POST', '/api/internal/collect/tick', {});
  check('AC-37 tick 토큰 없음 → 404', r.status === 404, r.status);

  // ---------- AC-01 정상 수집(2쪽) ----------
  const S0 = slot(0);
  let j = await collect(S0, 'FINAL', 'paged');
  let s = await snap(S0, 'FINAL');
  const raws = await q(`SELECT * FROM ext_raw_response WHERE job_id = $1 ORDER BY page_no`, [j.id]);
  check('AC-01 작업 DONE·스냅샷 COMPLETE·fetched=total=15·is_latest_ok', j.status === 'DONE' && s.status === 'COMPLETE' && s.total_count === 15 && s.fetched_count === 15 && s.is_latest_ok, { j: j.status, s });
  check('AC-01 쪽마다 raw 1행(2쪽)·URL serviceKey=****', raws.length === 2 && raws.every((x) => /serviceKey=\*\*\*\*/.test(x.request_url_masked)), raws.map((x) => x.request_url_masked));
  let tr = await trades(S0);
  const keys = [...new Set(tr.filter((x) => x.item_key).map((x) => x.item_key))].sort();
  check('AC-01 고추 5종·파프리카 3종 item_key, 피망 1건 UNMAPPED, trade_date KST', tr.length === 15 && keys.length === 8 && tr.filter((x) => x.map_status === 'UNMAPPED').length === 1 && tr.every((x) => x.trade_date === S0), { n: tr.length, keys });
  check('AC-37 경락 행 출하자 마스킹(출*A)', tr.every((x) => !x.shipper_name_masked || /\*/.test(x.shipper_name_masked)) && tr[0].shipper_name_masked === '출*A', tr[0].shipper_name_masked);
  check('AC-35 kg 단가 HALF_UP(38000/10kg = 3800.00), 금액 = 수량×단가', tr[0].price_per_kg === '3800.00' && tr[0].amount === '456000', tr[0]);
  const rem = await q(`SELECT 1 FROM collect_job WHERE job_type = 'REMATCH' AND trade_date = $1`, [S0]);
  check('AC-20 FINAL·COMPLETE 뒤 REMATCH 작업 생김', rem.length === 1, rem);
  r = await api('GET', `/api/auction/trades?date_from=${S0}&date_to=${S0}&family=PEPPER`, null, SV);
  check('R-92 조회(조회 직원) meta source_mode MOCK·phase FINAL·고추 10건', r.status === 200 && r.json.meta.source_mode === 'MOCK' && r.json.meta.phase === 'FINAL' && r.json.total === 10 && r.json.days[0].status === 'COMPLETE', r.json.meta);
  check('R-92 응답에 출하자 실명 없음', !JSON.stringify(r.json).includes('출하자A'), '');
  check('R-92 Cache-Control private', /private/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  r = await api('GET', `/api/auction/trades?date_from=${addDays(S0, -40)}&date_to=${S0}`, null, A);
  check('R-92 기간 31일 넘음 → 400 VALIDATION date_to', r.status === 400 && r.json.field === 'date_to', r.json);
  r = await api('GET', `/api/auction/trades/${tr[0].id}`, null, A);
  check('R-93 상세 revision·history', r.status === 200 && r.json.data.revision === 1 && Array.isArray(r.json.data.history), r.json);
  r = await api('GET', `/api/auction/items`, null, SI);
  check('R-95 내부 품목 10행', r.status === 200 && r.json.data.length === 10, r.json);

  // ---------- AC-07 재수집 멱등·정정·철회 ----------
  const S8 = slot(8);
  await collect(S8, 'FINAL', 'normal');
  const before8 = await trades(S8);
  await q(`INSERT INTO auction_trade (source, source_row_key, trade_date, market_code, item_key, map_status, qty, unit_price, amount, snapshot_id, content_hash, last_seen_at)
           SELECT 'MOCK', 'X-EXTRA-${tag}', trade_date, market_code, item_key, map_status, qty, unit_price, amount, snapshot_id, content_hash, NOW() - interval '1 day'
             FROM auction_trade WHERE id = $1`, [before8[0].id]);
  j = await collect(S8, 'FINAL', 'normal', { params: { reason: 'again' } });
  let after8 = await trades(S8);
  check('AC-07 같은 데이터 재수집: 15건 unchanged·revision 그대로', j.status === 'DONE' && j.result.unchanged === 15 && j.result.inserted === 0 && after8.filter((x) => x.source_row_key !== `X-EXTRA-${tag}`).every((x) => x.revision === 1), j.result);
  check('AC-07 원천에서 사라진 건 → withdrawn_at', after8.find((x) => x.source_row_key === `X-EXTRA-${tag}`).withdrawn_at !== null && j.result.withdrawn === 1, j.result);
  // 정정 대상 건(00003 청양 상 B청과 낙찰자 1002)을 먼저 매입전환해 둔다
  r = await api('POST', '/api/purchase-docs', { supplier_partner_id: PB, doc_no: `R-${tag}`, lines: [{ trade_date: S8, item_name: '청양고추', grade: '상', spec: '10kg 상자', qty: 20, unit_price: 31500, buyer_code: '1002' }] }, A, { 'idempotency-key': key() });
  const revLine = r.json?.data?.docs?.[0]?.lines?.[0];
  check('AC-07 준비: 00003 줄 자동 매입전환', r.status === 201 && revLine && revLine.status === 'CONVERTED', r.json);
  j = await collect(S8, 'FINAL', 'revised');
  const t3 = await T(S8, 3);
  const hist = await q(`SELECT * FROM auction_trade_history WHERE trade_id = $1`, [t3.id]);
  check('AC-07 값 바뀜: 00003 revision 2·낙찰가 30500·수량 19, history 1행(이전 31500)', t3.revision === 2 && t3.unit_price === '30500' && Number(t3.qty) === 19 && hist.length === 1 && hist[0].old_values.unit_price === 31500, { t3, hist: hist.length });
  const rl = (await q(`SELECT status, warning_flags FROM purchase_doc_line WHERE id = $1`, [revLine.id]))[0];
  const cpur = (await q(`SELECT p.status, p.total_amount FROM purchase p JOIN purchase_doc_conversion c ON c.purchase_id = p.id WHERE c.line_id = $1 AND c.status = 'ACTIVE'`, [revLine.id]))[0];
  check('AC-07 전환된 줄: 매입 그대로(630,000) + 경고 BASE_REVISED', rl.status === 'CONVERTED' && rl.warning_flags.includes('BASE_REVISED') && Number(cpur.total_amount) === 630000, { rl, cpur });
  r = await api('GET', '/api/purchase-docs/review?reason=BASE_REVISED', null, A);
  check('AC-07 검토 대기에 BASE_REVISED 줄', r.status === 200 && r.json.data.some((x) => x.id === revLine.id), r.json);

  // ---------- AC-02 빈 데이터·휴장·경매 전 ----------
  const today = kstToday();
  await q(`DELETE FROM collect_job WHERE trade_date = $1 AND dedupe_key LIKE '%:NOTYET:%'`, [today]); // 같은 시간대 재실행 대비(테스트 DB)
  j = await collect(today, 'INTRADAY', 'empty');
  s = await snap(today, 'INTRADAY');
  const fol = await q(`SELECT run_after FROM collect_job WHERE trade_date = $1 AND dedupe_key LIKE '%:NOTYET:%' AND status = 'QUEUED'`, [today]);
  check('AC-02 ① 오늘 빈 응답 → NOT_YET·작업 DONE·다음 슬롯 재수집 예약', j.status === 'DONE' && s.status === 'NOT_YET' && !s.is_latest_ok && fol.length >= 1, { j: j.status, s: s.status, fol });
  const S9 = slot(9);
  r = await api('PUT', '/api/auction/calendar', { add: [{ cal_date: S9, kind: 'HOLIDAY', note: '검사 휴장' }] }, A);
  check('R-102 시장 달력 저장은 관리자만 → 주인 403 ADMIN_ONLY', r.status === 403 && r.json.code === 'ADMIN_ONLY', r.json);
  r = await api('PUT', '/api/auction/calendar', { add: [{ cal_date: S9, kind: 'HOLIDAY', note: '검사 휴장' }] }, ADM.tok);
  check('R-102 관리자 휴장일 등록 + 지난 날짜 재판정 작업', r.status === 200 && r.json.data.added === 1 && r.json.data.requeued.length === 1, r.json);
  const rawBefore = Number((await q(`SELECT COUNT(*) FROM ext_raw_response`))[0].count);
  j = await runJob(r.json.data.requeued[0]);
  s = await snap(S9, 'FINAL');
  const rawAfter = Number((await q(`SELECT COUNT(*) FROM ext_raw_response`))[0].count);
  check('AC-02 ② 휴장일 → HOLIDAY·외부 호출 0·재시도 없음·경락 0', j.status === 'DONE' && s.status === 'HOLIDAY' && s.is_latest_ok && rawAfter === rawBefore && (await trades(S9)).length === 0, { j: j.status, s: s && s.status });
  const S7 = slot(7);
  j = await collect(S7, 'FINAL', 'empty');
  s = await snap(S7, 'FINAL');
  const recheck = await q(`SELECT 1 FROM collect_job WHERE trade_date = $1 AND dedupe_key LIKE '%:RECHECK' AND status = 'QUEUED'`, [S7]);
  check('AC-02 ③ 과거 미등록 날 빈 응답 → EMPTY(경고)·다음 날 1회 재확인 작업', j.status === 'DONE' && s.status === 'EMPTY' && s.is_latest_ok && !!s.verify_warning && recheck.length === 1, { s });

  // ---------- AC-03 타임아웃·5xx 재시도 → DEAD, 폴백 ----------
  const E1 = slot(20);
  await collect(E1, 'FINAL', 'normal');
  await resetCircuit();
  let id = await enqueue(E1, 'FINAL', '5xx', { params: { force: true } });
  await tick();
  j = await job(id);
  const wait = (new Date(j.run_after) - Date.now()) / 1000;
  check('AC-03 5xx → QUEUED·attempts 1·run_after ≈ 60s±20%', j.status === 'QUEUED' && j.attempts === 1 && wait > 40 && wait < 80 && j.last_error_kind === 'SERVER_ERROR', { status: j.status, wait, kind: j.last_error_kind });
  await q(`UPDATE collect_job SET attempts = 4, run_after = NOW() WHERE id = $1`, [id]);
  await tick();
  j = await job(id);
  check('AC-03 5회째 실패 → DEAD', j.status === 'DEAD' && j.attempts === 5, { status: j.status, attempts: j.attempts });
  r = await api('GET', `/api/auction/trades?date_from=${E1}&date_to=${E1}`, null, A);
  check('AC-03 폴백: 이전 정상 결과 14건 + stale:true', r.status === 200 && r.json.total === 14 && r.json.meta.stale === true, r.json.meta);
  await resetCircuit();
  id = await enqueue(E1, 'FINAL', 'timeout');
  await tick();
  j = await job(id);
  check('AC-03 타임아웃 → QUEUED·last_error_kind TIMEOUT', j.status === 'QUEUED' && j.last_error_kind === 'TIMEOUT', { status: j.status, kind: j.last_error_kind });
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1`, [id]);
  r = await api('POST', `/api/auction/jobs/${(await q(`SELECT id FROM collect_job WHERE status = 'DEAD' AND trade_date = $1 ORDER BY id DESC LIMIT 1`, [E1]))[0].id}/retry`, {}, A);
  check('R-132 DEAD 작업 다시 실행 → 202 새 작업', r.status === 202 && r.json.data.id, r.json);
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1`, [r.json.data.id]);
  r = await api('POST', `/api/auction/jobs/${(await q(`SELECT id FROM collect_job WHERE status = 'DONE' ORDER BY id DESC LIMIT 1`))[0].id}/retry`, {}, A);
  check('R-132 실패 아닌 작업 → 409 JOB_NOT_FAILED', r.status === 409 && r.json.code === 'JOB_NOT_FAILED', r.json);

  // ---------- AC-04 서킷 OPEN·HALF_OPEN·페이지 중간 실패 ----------
  await resetCircuit();
  const E2 = slot(21);
  for (let i = 0; i < 5; i += 1) {
    const x = await enqueue(E2, 'FINAL', '5xx');
    await tick();
    await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1 AND status = 'QUEUED'`, [x]);
  }
  let c = (await q(`SELECT * FROM ext_circuit_state WHERE source = 'AT_REALTIME'`))[0];
  const probeIn = (new Date(c.next_probe_at) - Date.now()) / 1000;
  check('AC-04 연속 5회 실패 → OPEN·next_probe_at ≈ +10분', c.state === 'OPEN' && c.consecutive_failures === 5 && probeIn > 540 && probeIn < 610, { c, probeIn });
  const rawN = Number((await q(`SELECT COUNT(*) FROM ext_raw_response`))[0].count);
  id = await enqueue(E2, 'FINAL', 'normal');
  await tick();
  j = await job(id);
  check('AC-04 OPEN 동안 외부 호출 0·작업은 next_probe_at 까지 대기', Number((await q(`SELECT COUNT(*) FROM ext_raw_response`))[0].count) === rawN && j.status === 'QUEUED' && j.attempts === 0, { status: j.status, attempts: j.attempts });
  r = await api('POST', '/api/auction/sync', { date_from: E2, date_to: E2 }, A);
  check('R-98 서킷 OPEN 이면 수동 동기화 409 CIRCUIT_OPEN', r.status === 409 && r.json.code === 'CIRCUIT_OPEN', r.json);
  await q(`UPDATE ext_circuit_state SET next_probe_at = NOW() - interval '1 second' WHERE source = 'AT_REALTIME'`);
  await q(`UPDATE collect_job SET run_after = NOW() WHERE id = $1`, [id]);
  j = await runJob(id);
  c = (await q(`SELECT * FROM ext_circuit_state WHERE source = 'AT_REALTIME'`))[0];
  check('AC-04 시각 지나 HALF_OPEN 1건 성공 → CLOSED', j.status === 'DONE' && c.state === 'CLOSED' && c.consecutive_failures === 0, { j: j.status, c: c.state });
  const E3 = slot(22);
  id = await enqueue(E3, 'FINAL', 'paged,5xx');
  await tick();
  const raw3 = await q(`SELECT kind FROM ext_raw_response WHERE job_id = $1 ORDER BY id`, [id]);
  check('AC-04 2쪽째 5xx → 경락 행 변화 0(전체 롤백), raw 2행 남음(OK·SERVER_ERROR)', (await trades(E3)).length === 0 && raw3.length === 2 && raw3[1].kind === 'SERVER_ERROR', raw3);
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1 AND status = 'QUEUED'`, [id]);
  await resetCircuit();

  // ---------- AC-05 429 ----------
  id = await enqueue(E3, 'FINAL', 'rate429');
  await tick();
  j = await job(id);
  c = (await q(`SELECT consecutive_failures FROM ext_circuit_state WHERE source = 'AT_REALTIME'`))[0];
  check('AC-05 429 Retry-After 120 → run_after ≥ now+120초·연속 실패 +1', j.status === 'QUEUED' && (new Date(j.run_after) - Date.now()) / 1000 >= 115 && j.last_error_kind === 'RATE_LIMIT' && c.consecutive_failures === 1, { run_after: j.run_after, c });
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1`, [id]);

  // ---------- AC-06 인증·한도 ----------
  await resetCircuit();
  id = await enqueue(E3, 'FINAL', 'auth');
  await tick();
  j = await job(id);
  c = (await q(`SELECT * FROM ext_circuit_state WHERE source = 'AT_REALTIME'`))[0];
  r = await api('GET', '/api/auction/sync/status', null, A);
  check('AC-06 인증 오류 → FAILED·재시도 없음·disabled_reason AUTH_ERROR', j.status === 'FAILED' && j.attempts === 1 && c.disabled_reason === 'AUTH_ERROR', { j: j.status, c: c.disabled_reason });
  check('AC-06 수집 현황에 AUTH_ERROR 표시·키 값 없음', r.status === 200 && r.json.circuits.find((x) => x.source === 'AT_REALTIME').disabled_reason === 'AUTH_ERROR' && !/serviceKey=[^*]/i.test(JSON.stringify(r.json)), r.json.circuits);
  await resetCircuit();
  id = await enqueue(E3, 'FINAL', 'quota');
  await tick();
  j = await job(id);
  const ra = new Date(new Date(j.run_after).getTime() + 9 * 3600 * 1000).toISOString();
  check('AC-06 일 한도 → 다음 날 00:10 KST 까지 정지', j.status === 'QUEUED' && ra.slice(11, 16) === '00:10' && ra.slice(0, 10) === addDays(kstToday(), 1), ra);
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1`, [id]);
  await resetCircuit();
  id = await enqueue(E3, 'FINAL', 'bad');
  await tick();
  j = await job(id);
  check('BAD_RESPONSE(낙찰가 소수·수량 누락) → 저장 0건·raw 보존·재시도 1회', (await trades(E3)).length === 0 && j.last_error_kind === 'BAD_RESPONSE' && j.status === 'QUEUED', { j: j.status, k: j.last_error_kind });
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1`, [id]);
  await resetCircuit();

  // ---------- AC-36 동시 tick·멈춘 작업 회수·수동 동기화 ----------
  const E4 = slot(23);
  const ja = await enqueue(E4, 'FINAL', 'normal');
  const jb = await enqueue(addDays(E4, -1), 'FINAL', 'normal');
  const [t1, t2] = await Promise.all([tick(), tick()]);
  const ranIds = [...(t1.json.ran || []), ...(t2.json.ran || [])].map((x) => x.id);
  check('AC-36 tick 2개 동시 → 작업마다 1회만 실행', ranIds.filter((x) => x === Number(ja)).length === 1 && ranIds.filter((x) => x === Number(jb)).length === 1, ranIds);
  await drain();
  const stuck = await enqueue(addDays(E4, -2), 'FINAL', 'normal');
  await q(`UPDATE collect_job SET status = 'RUNNING', locked_by = 'dead-worker', locked_at = NOW() - interval '11 minutes' WHERE id = $1`, [stuck]);
  const tk = await tick();
  check('AC-36 RUNNING 11분 멈춘 작업 → 회수·실행', (tk.json.recovered || []).includes(Number(stuck)) && (await job(stuck)).status === 'DONE', tk.json);
  await drain();
  // ---------- 큐 회수 최대 시도·옛 실행 (I 검토 D-05·D-06) ----------
  {
    const Q = require('../lib/auction/queue');
    const jDead = await enqueue(addDays(E4, -5), 'FINAL', 'normal');
    await q(`UPDATE collect_job SET status = 'RUNNING', locked_by = 'dead-worker', locked_at = NOW() - interval '11 minutes', attempts = max_attempts WHERE id = $1`, [jDead]);
    const tkd = await tick();
    const jd = await job(jDead);
    check('D-05 최대 시도에 닿은 멈춘 RUNNING → 회수 뒤 DEAD(finished_at·recovered_dead)·다시 실행 안 함', jd.status === 'DEAD' && jd.finished_at && (tkd.json.recovered_dead || []).includes(Number(jDead))
      && !(tkd.json.recovered || []).includes(Number(jDead)) && !(tkd.json.ran || []).some((x) => x.id === Number(jDead)), { jd: { status: jd.status, attempts: jd.attempts, finished_at: jd.finished_at }, tk: tkd.json });
    const fd = await Q.finish(pool, jDead, { status: 'DONE', lockedBy: 'dead-worker' });
    const jOld = await enqueue(addDays(E4, -6), 'FINAL', 'normal');
    await q(`UPDATE collect_job SET status = 'RUNNING', locked_by = 'old-worker', locked_at = NOW() - interval '11 minutes', attempts = 1 WHERE id = $1`, [jOld]);
    await Q.recoverStale(pool);
    const before = await job(jOld);
    const fo = await Q.finish(pool, jOld, { status: 'DONE', lockedBy: 'old-worker' });
    await Q.requeue(pool, { id: jOld, attempts: 1, locked_by: 'old-worker' }, { at: new Date(Date.now() + 86400000) });
    const after = await job(jOld);
    check('D-06 회수 뒤 옛 실행의 finish·requeue → 상태 안 바뀜(DEAD 그대로·QUEUED 그대로)', fd === false && (await job(jDead)).status === 'DEAD' && fo === false
      && before.status === 'QUEUED' && after.status === 'QUEUED' && after.finished_at === null && new Date(after.run_after).getTime() === new Date(before.run_after).getTime(), { fd, fo, before: before.status, after: after.status });
    await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1 AND status = 'QUEUED'`, [jOld]);
  }
  const syncDate = addDays(E4, -3);
  const [m1, m2] = await Promise.all([api('POST', '/api/auction/sync', { date_from: syncDate, date_to: syncDate, mock_scenario: 'normal' }, A), api('POST', '/api/auction/sync', { date_from: syncDate, date_to: syncDate }, A)]);
  const queuedN = [m1, m2].reduce((t, x) => t + ((x.json.data && x.json.data.queued.length) || 0), 0);
  check('AC-36 같은 분 수동 동기화 2번 → 1건만 + ALREADY_QUEUED', m1.status === 202 && m2.status === 202 && queuedN === 1 && [m1, m2].some((x) => x.json.data.skipped.some((y) => y.reason === 'ALREADY_QUEUED')), [m1.json, m2.json]);
  await q(`UPDATE collect_job SET created_at = NOW() - interval '2 minutes', dedupe_key = dedupe_key || ':old' WHERE requested_by_user_id = $1 AND dedupe_key LIKE '%:MANUAL:%'`, [O.id]);
  r = await api('POST', '/api/auction/sync', { date_from: addDays(syncDate, -1), date_to: addDays(syncDate, -1) }, A);
  check('AC-36 5분 안 두 번째 수동 동기화 → 429 SYNC_RATE_LIMIT', r.status === 429 && r.json.code === 'SYNC_RATE_LIMIT', r.json);
  { // C D01: 같은 분 키가 일부 겹쳐도(기간을 넓혀 다시 누름) 새 날짜가 있으면 429, 새 작업 0건
    await q(`UPDATE collect_job SET created_at = NOW() - interval '1 hour' WHERE requested_by_user_id = $1 AND dedupe_key LIKE '%:MANUAL:%'`, [O.id]);
    const wd = addDays(syncDate, -6);
    while (new Date().getSeconds() > 50) await new Promise((res) => setTimeout(res, 1000)); // 두 요청을 같은 분에
    const w1 = await api('POST', '/api/auction/sync', { date_from: wd, date_to: wd, phase: 'FINAL', force: true }, A);
    const nBefore = Number((await q(`SELECT COUNT(*)::int AS n FROM collect_job WHERE requested_by_user_id = $1`, [O.id]))[0].n);
    const w2 = await api('POST', '/api/auction/sync', { date_from: addDays(wd, -2), date_to: wd, phase: 'FINAL', force: true }, A);
    const nAfter = Number((await q(`SELECT COUNT(*)::int AS n FROM collect_job WHERE requested_by_user_id = $1`, [O.id]))[0].n);
    const w3 = await api('POST', '/api/auction/sync', { date_from: wd, date_to: wd, phase: 'FINAL', force: true }, A);
    check('D01 같은 분 키 일부 겹침 + 새 날짜 → 429·새 작업 0, 같은 범위 재요청은 202 ALREADY_QUEUED',
      w1.status === 202 && w2.status === 429 && w2.json.code === 'SYNC_RATE_LIMIT' && nAfter === nBefore
      && w3.status === 202 && w3.json.data.queued.length === 0, { w1: w1.status, w2: w2.json, nBefore, nAfter, w3: w3.json });
    await q(`UPDATE collect_job SET status = CASE WHEN status = 'QUEUED' THEN 'CANCELLED' ELSE status END, finished_at = CASE WHEN status = 'QUEUED' THEN NOW() ELSE finished_at END, created_at = NOW() - interval '1 hour' WHERE requested_by_user_id = $1 AND dedupe_key LIKE '%:MANUAL:%' AND created_at > NOW() - interval '5 minutes'`, [O.id]);
  }
  r = await api('POST', '/api/auction/sync', { date_from: addDays(kstToday(), 1) }, ADM.tok);
  check('R-98 미래 날짜 → 400 VALIDATION', r.status === 400 && r.json.code === 'VALIDATION', r.json);
  r = await api('POST', '/api/auction/sync', { date_from: S0, date_to: S0, phase: 'FINAL' }, ADM.tok);
  check('R-98 이미 정상 수집한 날 → skipped ALREADY_COMPLETE', r.status === 202 && r.json.data.skipped.some((x) => x.reason === 'ALREADY_COMPLETE'), r.json);
  await drain();
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE status = 'QUEUED' AND run_after < NOW() + interval '1 hour'`);

  // ---------- AC-37 원천 로그(관리자) ----------
  const rawId = raws[0].id;
  r = await api('GET', `/api/auction/raw/${rawId}`, null, A);
  check('AC-37 원천 본문: 관리자 아닌 주인 → 403', r.status === 403, r.status);
  r = await api('GET', `/api/auction/raw/${rawId}`, null, SI);
  check('AC-37 원천 본문: 직원 → 403', r.status === 403, r.status);
  r = await api('GET', `/api/auction/raw/${rawId}`, null, ADM.tok);
  const au = await q(`SELECT 1 FROM audit_log WHERE user_id = $1 AND entity_type = 'market_sync' AND note = 'raw 조회'`, [ADM.id]);
  check('AC-37 원천 본문: 관리자 200 + audit_log "raw 조회"', r.status === 200 && r.json.data.body.includes('auc_seq') && au.length === 1, r.status);

  // ---------- AC-09 매핑 추가 → REMAP ----------
  r = await api('POST', '/api/auction/item-mappings', { target: 'BOTH', keyword: '피 망', item_key: 'PEPPER._', priority: 500 }, ADM.tok);
  check('R-104 매핑 추가(관리자) → 201 + REMAP 작업', r.status === 201 && r.json.data.remap_job_id, r.json);
  const mapId = r.json.data && r.json.data.id;
  r = await api('POST', '/api/auction/item-mappings', { target: 'BOTH', keyword: '피망', item_key: 'PEPPER._' }, ADM.tok);
  check('R-104 같은 키워드 활성 매핑 → 409 MAPPING_DUPLICATE', r.status === 409 && r.json.code === 'MAPPING_DUPLICATE', r.json);
  r = await api('POST', '/api/auction/item-mappings', { keyword: 'x', item_key: 'PEPPER._' }, A);
  check('R-104 관리자 아닌 주인 → 403', r.status === 403, r.status);
  await drain();
  tr = await trades(S0);
  const pim = tr.find((x) => x.item_name_raw === '피망(청)');
  check('AC-09 REMAP 뒤 미매핑 피망 → MAPPED', pim && pim.map_status === 'MAPPED' && pim.item_key === 'PEPPER._', pim && pim.map_status);
  r = await api('DELETE', `/api/auction/item-mappings/${mapId}`, null, ADM.tok);
  await drain();
  check('R-106 매핑 끄기 → REMAP 뒤 다시 UNMAPPED', r.status === 200 && (await trades(S0)).find((x) => x.item_name_raw === '피망(청)').map_status === 'UNMAPPED', r.json);
  r = await api('GET', `/api/auction/unmapped?date_from=${addDays(S0, -30)}&date_to=${S0}`, null, ADM.tok);
  check('R-107 미매핑 목록에 피망(청)', r.status === 200 && r.json.data.some((x) => x.item_name_raw === '피망(청)'), r.json);

  // ---------- 매입서 업로드·검증 AC-10~13 ----------
  const HEAD = ['매입서번호', '거래일*', '제공처*', '품목*', '등급', '규격', '수량*', '단가*', '금액', '산지', '출하자', '낙찰자번호'];
  const okBuf = await xlsx(HEAD, [
    [`X-${tag}`, S0, 'A청과', '청양고추', '특', '10kg 상자', 12, 38000, 456000, '충남 청양', '김민수', ''],
    [`X-${tag}`, S0, 'A청과', '꽈리', '특', '4kg 상자', 30, 21000, '', '', '', ''],
    [`X-${tag}`, S0, 'A청과', '청량초', '상', '4키로', 5, 17000, '', '', '', ''],
  ]);
  const docCount = async () => Number((await q(`SELECT COUNT(*) FROM purchase_doc WHERE user_id = $1`, [O.id]))[0].count);
  const dc0 = await docCount();
  r = await upload('/api/purchase-docs/preview', okBuf, A, 'ok.xlsx');
  check('AC-10 미리보기 3줄 OK·정규화(item_key·grade_norm·kg)·DB 변화 0', r.status === 200 && r.json.data.summary.ok === 3 && r.json.data.rows[0].normalized.item_key === 'PEPPER.CHEONGYANG'
    && r.json.data.rows[0].normalized.grade_norm === 'SPECIAL' && r.json.data.rows[0].normalized.unit_qty_kg === '10.000' && (await docCount()) === dc0, r.json);
  check('AC-08 미리보기 "청량초" → 경고 ITEM_UNMAPPED', r.json.data.rows[2].warnings.some((w) => w.code === 'ITEM_UNMAPPED'), r.json.data.rows[2]);
  check('미리보기 합계 456,000 + 630,000 + 85,000', r.json.data.summary.amount_total === 1171000, r.json.data.summary);
  const badBuf = await xlsx(HEAD, [
    ['', '', 'A청과', '청양고추', '특', '10kg', 12, 38000, '', '', '', ''],
    ['', S0, '', '청양고추', '특', '10kg', 12, 38000, '', '', '', ''],
    ['', S0, 'A청과', '', '특', '10kg', 12, 38000, '', '', '', ''],
    ['', S0, 'A청과', '청양고추', '특', '10kg', '', 38000, '', '', '', ''],
    ['', S0, 'A청과', '청양고추', '특', '10kg', 12, '', '', '', '', ''],
    ['', '2026-13-45', 'A청과', '청양고추', '특', '10kg', 12, 38000, '', '', '', ''],
    ['', S0, 'A청과', '청양고추', '특', '10kg', 12, 35000.5, '', '', '', ''],
    ['', S0, 'A청과', '청양고추', '특', '10kg', 12, 38000, 459000, '', '', ''],
    ['', S0, '없는거래처', '청양고추', '특', '10kg', 12, 38000, '', '', '', ''],
  ]);
  r = await upload('/api/purchase-docs/preview', badBuf, A, 'bad.xlsx');
  const rows = r.json?.data?.rows || [];
  const codeAt = (i) => (rows[i] && rows[i].errors ? rows[i].errors.map((e) => `${e.field}:${e.code}`) : []);
  check('AC-11 필수값 누락 5종·날짜 형식 → 엑셀 줄 번호·field·code', rows[0].line === 2 && codeAt(0).includes('trade_date:REQUIRED') && codeAt(1).includes('supplier:REQUIRED') && codeAt(2).includes('item:REQUIRED')
    && codeAt(3).includes('qty:REQUIRED') && codeAt(4).includes('unit_price:REQUIRED') && codeAt(5).includes('trade_date:BAD_DATE'), rows.map((x) => x.errors));
  check('AC-12 단가 35000.5 → NOT_INTEGER_WON', codeAt(6).includes('unit_price:NOT_INTEGER_WON'), codeAt(6));
  check('AC-12 금액 ≠ 수량×단가 → 경고 AMOUNT_MISMATCH(오류 아님)', rows[7].ok && rows[7].warnings.some((w) => w.code === 'AMOUNT_MISMATCH'), rows[7]);
  check('AC-11 없는 제공처 → PARTNER_NOT_FOUND', codeAt(8).includes('supplier:PARTNER_NOT_FOUND'), codeAt(8));
  r = await upload('/api/purchase-docs', badBuf, A, 'bad.xlsx');
  check('AC-11 저장 → 400 HAS_ERRORS·매입서 0건(전부 아니면 전무)', r.status === 400 && r.json.code === 'HAS_ERRORS' && (await docCount()) === dc0, r.json && r.json.code);
  const big = await xlsx(HEAD, Array.from({ length: 1001 }, (_, i) => ['', S0, 'A청과', '청양고추', '특', '10kg', 1 + i, 38000, '', '', '', '']));
  r = await upload('/api/purchase-docs/preview', big, A, 'big.xlsx');
  check('AC-13 1,001줄 → 400 TOO_MANY_ROWS', r.status === 400 && r.json.code === 'TOO_MANY_ROWS', r.json);
  r = await upload('/api/purchase-docs/preview', Buffer.alloc(2 * 1024 * 1024 + 10, 65), A, 'huge.csv');
  check('AC-13 2MB 넘는 파일 → 413 FILE_TOO_LARGE', r.status === 413 && r.json.code === 'FILE_TOO_LARGE', r.json);
  const csvText = `거래일,제공처,품목,등급,규격,수량,단가\n${S0},A청과,청양고추,특,10kg 상자,12,"38,000"\n`;
  const iconv = require('iconv-lite'); // eslint-disable-line global-require
  const ru = await upload('/api/purchase-docs/preview', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csvText, 'utf8')]), A, 'u.csv');
  const rc = await upload('/api/purchase-docs/preview', iconv.encode(csvText, 'cp949'), A, 'c.csv');
  check('AC-13 CSV UTF-8(BOM)·CP949 같은 결과', ru.status === 200 && rc.status === 200 && JSON.stringify(ru.json.data.rows) === JSON.stringify(rc.json.data.rows) && ru.json.data.rows[0].ok, [ru.json, rc.json]);
  r = await upload('/api/purchase-docs/preview', Buffer.from('hello'), A, 'x.pdf');
  check('R-117 엑셀·CSV 아닌 파일 → 400 BAD_FILE', r.status === 400 && r.json.code === 'BAD_FILE', r.json);
  r = await upload('/api/purchase-docs/preview', okBuf, SV, 'ok.xlsx');
  check('AC-34 조회 직원 미리보기 → 403', r.status === 403, r.status);
  const tplR = await fetch(`${BASE}/api/purchase-docs/template`, { headers: { authorization: `Bearer ${SV}` } });
  check('R-116 템플릿(조회 직원도) xlsx', tplR.status === 200 && /spreadsheetml/.test(tplR.headers.get('content-type') || ''), tplR.status);

  // ---------- AC-14 완전일치 자동 매입전환 (S0, 홍고추 특 C농협 10kg 10×45,000 낙찰자 1001) ----------
  const invOf = async (pid) => Number((await q(`SELECT COALESCE(SUM(quantity),0) AS q FROM inventory WHERE user_id = $1 AND product_id = $2`, [O.id, pid]))[0].q);
  const inv0 = await invOf(P.홍.id);
  const postDoc = (tok, body, k = key()) => api('POST', '/api/purchase-docs', body, tok, { 'idempotency-key': k });
  r = await postDoc(A, { supplier_partner_id: PC, doc_no: `C-${tag}`, lines: [{ trade_date: S0, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000, amount: 450000, origin: '충남 청양' }] });
  const l14 = r.json?.data?.docs?.[0]?.lines?.[0];
  const doc14 = r.json?.data?.docs?.[0];
  check('AC-14 EXACT·점수≥85 → CONVERTED·헤더 CONVERTED', r.status === 201 && l14.match_result === 'EXACT' && l14.score >= 85 && l14.status === 'CONVERTED' && doc14.status === 'CONVERTED', r.json);
  const p14 = (await q(`SELECT * FROM purchase WHERE id = $1`, [l14.purchase_id]))[0];
  check('AC-14 매입 1건: 제공처 C농협·수량 10·단가 45,000·합계 450,000·purchase_doc_line_id', p14 && p14.partner_id === PC && Number(p14.quantity) === 10 && Number(p14.unit_price) === 45000 && Number(p14.total_amount) === 450000 && Number(p14.purchase_doc_line_id) === l14.id, p14);
  check('AC-14 재고 +10·미지급 450,000(제공처 지급 대상)', (await invOf(P.홍.id)) - inv0 === 10 && p14.payment_status === 'unpaid' && p14.payee_partner_id === PC, { inv: (await invOf(P.홍.id)) - inv0 });
  const ev14 = await q(`SELECT * FROM purchase_match_event WHERE line_id = $1 AND event_type = 'AUTO_CONVERT'`, [l14.id]);
  check('AC-14 이력 AUTO_CONVERT(행위자 주인·tolerance)', ev14.length === 1 && ev14[0].actor_kind === 'OWNER' && ev14[0].detail.tolerance && Number(ev14[0].detail.tolerance.auto_min_score) === 85, ev14);
  r = await api('GET', `/api/purchases?from_date=${S0}&to_date=${S0}`, null, A);
  check('B1-12 매입 목록 응답에 purchase_doc_line_id·purchase_doc_id', r.status === 200 && r.json.data.some((x) => x.id === l14.purchase_id && Number(x.purchase_doc_line_id) === l14.id && Number(x.purchase_doc_id) === doc14.id), '');

  // ---------- AC-16·17·19·21 보류 / AC-20 ④⑤ 미매칭 사유 (S0) ----------
  r = await postDoc(A, { supplier_partner_id: PA, lines: [
    { trade_date: S0, item_name: '빨강 파프리카', grade: '특', spec: '5kg 상자', qty: 40, unit_price: 25200 },
    { trade_date: S0, item_name: '풋고추', grade: '상', spec: '5kg 상자', qty: 50, unit_price: 13000, buyer_code: '1002' },
    { trade_date: S0, item_name: '청양고추', grade: '특', spec: '10kg 상자', qty: 12, unit_price: 38000 },
    { trade_date: S0, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000 },
  ] });
  const L = r.json?.data?.docs?.[0]?.lines || [];
  check('AC-16 단가 +5% → PARTIAL·HOLD·매입 0', L[0] && L[0].match_result === 'PARTIAL' && L[0].status === 'HOLD' && !L[0].purchase_id, L[0]);
  check('AC-17 5kg vs 10kg(kg 단가 같음) → UNIT_CONVERTED·PARTIAL', L[1] && L[1].match_result === 'PARTIAL' && L[1].warning_flags.includes('UNIT_CONVERTED'), L[1]);
  check('AC-21 같은 조건 2건 → PARTIAL MULTI_CANDIDATE·HOLD', L[2] && L[2].match_result === 'PARTIAL' && L[2].reason_codes.includes('MULTI_CANDIDATE') && L[2].candidate_count === 2, L[2]);
  check('AC-20 법인 다름(A청과 줄, 홍고추는 C농협뿐) → UNMATCHED CORP_MISMATCH', L[3] && L[3].match_result === 'UNMATCHED' && L[3].reason_codes.includes('CORP_MISMATCH'), L[3]);
  const docMix = r.json?.data?.docs?.[0];
  check('헤더 HOLD(전환 0·보류 4)', docMix && docMix.status === 'HOLD', docMix);
  r = await postDoc(A, { supplier_partner_id: PB, lines: [{ trade_date: S0, item_name: '청양고추', grade: '상', spec: '10kg 상자', qty: 20, unit_price: 31500, amount: 633000, buyer_code: '1002' }] });
  const l19 = r.json?.data?.docs?.[0]?.lines?.[0];
  check('AC-19 금액 = 수량×단가 + 3,000 → AMOUNT_CALC_DIFF·자동 전환 안 함', l19 && l19.status === 'HOLD' && l19.warning_flags.includes('AMOUNT_CALC_DIFF'), l19);
  await q(`UPDATE auction_trade SET withdrawn_at = NOW() WHERE source = 'MOCK' AND trade_date = $1 AND item_key = 'PAPRIKA.ORANGE'`, [S0]);
  r = await postDoc(A, { supplier_partner_id: PC, lines: [
    { trade_date: S0, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000 },
    { trade_date: S0, item_name: '청량초', grade: '특', spec: '10kg', qty: 1, unit_price: 1000 },
  ] });
  const L5 = r.json?.data?.docs?.[0]?.lines || [];
  check('AC-20 ⑤ 유일 후보를 다른 줄이 전환에 씀 → ALL_CANDIDATES_TAKEN', L5[0] && L5[0].match_result === 'UNMATCHED' && L5[0].reason_codes.includes('ALL_CANDIDATES_TAKEN'), L5[0]);
  check('AC-26 다른 매입서에 같은 줄 → 경고 DUP_LINE_OTHER_DOC', L5[0] && L5[0].warning_flags.includes('DUP_LINE_OTHER_DOC'), L5[0]);
  check('AC-20 ① 미매핑 품목 → UNMATCHED ITEM_UNMAPPED', L5[1] && L5[1].reason_codes.includes('ITEM_UNMAPPED'), L5[1]);
  r = await postDoc(A, { supplier_partner_id: PB, lines: [{ trade_date: S0, item_name: '주황파프리카', grade: '특', spec: '5kg', qty: 12, unit_price: 26500, buyer_code: '1002' }] });
  check('AC-20 ④ 그 날 그 품종 경락 없음 → NO_TRADE_SAME_VARIETY', r.json?.data?.docs?.[0]?.lines?.[0]?.reason_codes.includes('NO_TRADE_SAME_VARIETY'), r.json);

  // ---------- AC-27 수동 확정 (AC-16 줄: 단가 +5%) ----------
  r = await api('GET', `/api/purchase-docs/lines/${L[0].id}/candidates`, null, SV);
  const cand0 = r.json?.data?.candidates?.[0];
  check('R-122 후보(조회 직원) 1위 경락·점수·차이(+ 화면 별칭 strict·diff.days)', r.status === 200 && cand0 && cand0.diff.price === 1200 && cand0.trade.unit_price === 24000 && cand0.strict === cand0.strict_pass && cand0.diff.days === cand0.diff.date, r.json);
  const lv = async (lid) => (await q(`SELECT version FROM purchase_doc_line WHERE id = $1`, [lid]))[0].version;
  r = await api('POST', `/api/purchase-docs/lines/${L[0].id}/confirm`, { trade_id: cand0.trade_id, version: await lv(L[0].id) }, A, { 'idempotency-key': key() });
  check('AC-27 허용오차 밖 accept_diff 없이 → 400 DIFF_NOT_ACCEPTED(diff)', r.status === 400 && r.json.code === 'DIFF_NOT_ACCEPTED' && r.json.detail.diff.price === 1200, r.json);
  r = await api('POST', `/api/purchase-docs/lines/${L[0].id}/confirm`, { trade_id: cand0.trade_id, version: await lv(L[0].id), accept_diff: true }, SI, { 'idempotency-key': key() });
  check('AC-27 입력 직원 수동 확정 → 403 FORBIDDEN_ROLE', r.status === 403 && r.json.code === 'FORBIDDEN_ROLE', r.json);
  r = await api('POST', `/api/purchase-docs/lines/${L[0].id}/confirm`, { trade_id: cand0.trade_id, version: 1 }, A, { 'idempotency-key': key() });
  check('R-128 version 다름 → 409 VERSION_CONFLICT(최신 줄)', r.status === 409 && r.json.code === 'VERSION_CONFLICT' && r.json.detail.line, r.json);
  r = await api('POST', `/api/purchase-docs/lines/${L[0].id}/confirm`, { trade_id: cand0.trade_id, version: await lv(L[0].id), accept_diff: true, reason: '법인 정산서 단가 정정분 확인(전화)' }, A, { 'idempotency-key': key() });
  check('AC-27 accept_diff + 사유 → CONVERTED·FORCED·차액(단가 +1,200·금액 +48,000)', r.status === 200 && r.json.data.result === 'CONVERTED' && r.json.data.mode === 'FORCED' && r.json.data.diff.price === 1200 && r.json.data.diff.amount === '48000' && r.json.data.warnings.includes('PRICE_DIFF'), r.json);
  const cv27 = (await q(`SELECT * FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [L[0].id]))[0];
  check('AC-27 전환 기록 FORCED·사유·price_diff 1200 저장', cv27 && cv27.mode === 'FORCED' && /정정분/.test(cv27.approve_reason) && Number(cv27.price_diff) === 1200, cv27);
  r = await api('POST', `/api/purchase-docs/lines/${L5[1].id}/confirm`, { version: await lv(L5[1].id), accept_diff: true, reason: '장외 거래' }, A, { 'idempotency-key': key() });
  check('AC-27 경락 근거 없이(trade_id 생략) → 품목 연결 없음 400 NO_PRODUCT_LINK', r.status === 400 && r.json.code === 'NO_PRODUCT_LINK', r.json);
  r = await api('POST', `/api/purchase-docs/lines/${L5[1].id}/confirm`, { version: await lv(L5[1].id), accept_diff: true, reason: '장외 거래', product_id: P.청양.id }, A, { 'idempotency-key': key() });
  const cvNo = (await q(`SELECT * FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [L5[1].id]))[0];
  check('AC-27 경락 근거 없이 → FORCED·trade_id NULL', r.status === 200 && r.json.data.mode === 'FORCED' && cvNo && cvNo.trade_id === null, r.json);
  // AC-19 수동 확정: 매입 합계는 수량×단가, 차액 −3,000
  const c19 = (await api('GET', `/api/purchase-docs/lines/${l19.id}/candidates`, null, A)).json.data.candidates[0];
  r = await api('POST', `/api/purchase-docs/lines/${l19.id}/confirm`, { trade_id: c19.trade_id, version: await lv(l19.id), accept_diff: true, reason: '하역비 포함 금액' }, A, { 'idempotency-key': key() });
  const cv19 = (await q(`SELECT c.*, p.total_amount FROM purchase_doc_conversion c JOIN purchase p ON p.id = c.purchase_id WHERE c.line_id = $1 AND c.status = 'ACTIVE'`, [l19.id]))[0];
  check('AC-19 수동 확정 → 매입 합계 630,000(수량×단가)·차액 −3,000 기록', r.status === 200 && cv19 && Number(cv19.total_amount) === 630000 && Number(cv19.amount_diff) === -3000 && Number(cv19.doc_amount) === 633000, cv19);
  // AC-21 수동 확정(후보 2건 중 하나) → MANUAL
  const c21 = (await api('GET', `/api/purchase-docs/lines/${L[2].id}/candidates`, null, A)).json.data.candidates;
  r = await api('POST', `/api/purchase-docs/lines/${L[2].id}/confirm`, { trade_id: c21[0].trade_id, version: await lv(L[2].id) }, A, { 'idempotency-key': key() });
  check('AC-21 후보 2건 중 하나 확정(허용오차 안) → MANUAL', r.status === 200 && r.json.data.mode === 'MANUAL' && c21.length === 2, r.json);
  const used21 = (await q(`SELECT trade_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [L[2].id]))[0];
  check('AC-21 그 건(#1위)만 사용', used21 && Number(used21.trade_id) === c21[0].trade_id, used21);

  // ---------- AC-15 밤 경매(−1) EXACT / −2 PARTIAL (S1) ----------
  const S1 = slot(1);
  await collect(S1, 'FINAL', 'normal');
  r = await postDoc(A, { supplier_partner_id: PB, auto_convert: false, lines: [{ trade_date: addDays(S1, 1), item_name: '오이고추', grade: '특', spec: '10kg 상자', qty: 18, unit_price: 29000 }] });
  const l15a = r.json?.data?.docs?.[0]?.lines?.[0];
  check('AC-15 경락일 = 거래일 −1 → EXACT(자동 꺼짐 → PENDING 전환 가능)', l15a && l15a.match_result === 'EXACT' && l15a.status === 'PENDING' && l15a.convertible, l15a);
  r = await postDoc(A, { supplier_partner_id: PA, lines: [{ trade_date: addDays(S1, 2), item_name: '노랑 파프리카', grade: '특', spec: '5kg 상자', qty: 35, unit_price: 25000 }] });
  const l15b = r.json?.data?.docs?.[0]?.lines?.[0];
  check('AC-15 −2 → PARTIAL(날짜 후보 범위)·HOLD', l15b && l15b.match_result === 'PARTIAL' && l15b.status === 'HOLD', l15b);

  // ---------- AC-22·23·24 멱등·동시성 (S2) ----------
  const S2 = slot(2);
  await collect(S2, 'FINAL', 'normal');
  r = await postDoc(A, { supplier_partner_id: PA, auto_convert: false, doc_no: `I-${tag}`, lines: [
    { trade_date: S2, item_name: '꽈리고추', grade: '특', spec: '4kg 상자', qty: 30, unit_price: 21000 },
    { trade_date: S2, item_name: '빨강 파프리카', grade: '특', spec: '5kg 상자', qty: 40, unit_price: 24000 },
    { trade_date: S2, item_name: '노랑 파프리카', grade: '특', spec: '5kg 상자', qty: 35, unit_price: 25000 },
  ] });
  const I = r.json?.data?.docs?.[0];
  check('준비 S2 3줄 EXACT·PENDING(자동 꺼짐)', I && I.lines.every((x) => x.match_result === 'EXACT' && x.status === 'PENDING'), I);
  const purchCount = async (lid) => Number((await q(`SELECT COUNT(*) FROM purchase WHERE purchase_doc_line_id = $1`, [lid]))[0].count);
  const k22 = key();
  const a1 = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: I.lines[0].id }] }, A, { 'idempotency-key': k22 });
  const a2 = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: I.lines[0].id }] }, A, { 'idempotency-key': k22 });
  check('AC-22 같은 키 두 번(순차) → 매입 1건·두 번째 = 첫 응답 + Idempotent-Replay', a1.status === 200 && a1.json.data.results[0].result === 'CONVERTED' && same(a1.json, a2.json)
    && a2.headers.get('idempotent-replay') === 'true' && (await purchCount(I.lines[0].id)) === 1, [a1.json, a2.headers.get('idempotent-replay')]);
  check('AC-18 단위 환산: 꽈리 4kg 30상자 → 품목 3kg 단위 40.000·15,750(합계 630,000 = 매입서 금액)', (await q(`SELECT quantity, unit_price, total_amount FROM purchase WHERE purchase_doc_line_id = $1`, [I.lines[0].id]))
    .every((x) => Number(x.quantity) === 40 && Number(x.unit_price) === 15750 && Number(x.total_amount) === 630000), '');
  r = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: I.lines[1].id }] }, A, { 'idempotency-key': k22 });
  check('AC-22 같은 키·다른 본문 → 422 IDEMPOTENCY_KEY_REUSED', r.status === 422 && r.json.code === 'IDEMPOTENCY_KEY_REUSED', r.json);
  const k23 = key();
  const inv23 = await invOf(P.적.id);
  const [b1, b2] = await Promise.all([1, 2].map(() => api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: I.lines[1].id }] }, A, { 'idempotency-key': k23 })));
  check('AC-23 같은 키 동시 2요청 → 매입 1건·두 응답 같음·재고 +20(5kg 40상자 = 10kg 단위 20) 1회', b1.status === 200 && b2.status === 200 && same(b1.json, b2.json)
    && (await purchCount(I.lines[1].id)) === 1 && (await invOf(P.적.id)) - inv23 === 20, [b1.status, b2.status, b1.json, b2.json]);
  const inv24 = await invOf(P.황.id);
  const races = await Promise.all([
    api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: I.lines[2].id }] }, A, { 'idempotency-key': key() }),
    api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: I.lines[2].id }] }, SI, { 'idempotency-key': key() }),
    api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: I.lines[2].id }] }, A, { 'idempotency-key': key() }),
    api('POST', `/api/purchase-docs/${I.id}/match`, { auto_convert: true }, A),
  ]);
  const conv24 = races.slice(0, 3).map((x) => x.json?.data?.results?.[0]?.result);
  const act24 = Number((await q(`SELECT COUNT(*) FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [I.lines[2].id]))[0].count);
  check('AC-24 다른 키 동시 3요청 + 자동 전환 대조 → 매입 1건·전환 ACTIVE 1건·나머지 ALREADY_CONVERTED·500 0건',
    races.every((x) => x.status < 500) && (await purchCount(I.lines[2].id)) === 1 && act24 === 1 && conv24.filter((x) => x === 'CONVERTED').length <= 1
    && conv24.every((x) => x === 'CONVERTED' || x === 'ALREADY_CONVERTED') && (await invOf(P.황.id)) - inv24 === 17.5, { conv24, status: races.map((x) => x.status), n: await purchCount(I.lines[2].id), act24, inv: (await invOf(P.황.id)) - inv24 });
  const dupChk = await q(`SELECT line_id FROM purchase_doc_conversion WHERE status = 'ACTIVE' GROUP BY line_id HAVING COUNT(*) > 1
                          UNION ALL SELECT purchase_doc_line_id FROM purchase WHERE purchase_doc_line_id IS NOT NULL AND status = 'active' GROUP BY 1 HAVING COUNT(*) > 1
                          UNION ALL SELECT trade_id FROM purchase_doc_conversion WHERE status = 'ACTIVE' AND trade_id IS NOT NULL GROUP BY user_id, trade_id HAVING COUNT(*) > 1`);
  check('AC-24 확인 SQL(줄·매입·경락 건 중복 활성) 0행', dupChk.length === 0, dupChk);
  const staffPur = (await q(`SELECT created_by_staff_id FROM purchase WHERE purchase_doc_line_id = $1 AND status = 'active'`, [I.lines[2].id]))[0];
  check('R-127 응답 줄 결과·헤더 CONVERTED', (await q(`SELECT status FROM purchase_doc WHERE id = $1`, [I.id]))[0].status === 'CONVERTED', staffPur);

  // ---------- AC-28·29·30·31 취소·재대조 ----------
  const lid28 = I.lines[0].id;
  r = await api('POST', `/api/purchase-docs/lines/${lid28}/cancel`, { reason: '단가 오기' }, SI, { 'idempotency-key': key() });
  check('AC-34 입력 직원 전환 취소 → 403', r.status === 403, r.status);
  r = await api('POST', `/api/purchase-docs/lines/${lid28}/cancel`, { reason: '단가 오기' }, A);
  check('R-130 Idempotency-Key 없음 → 400 IDEMPOTENCY_KEY_REQUIRED', r.status === 400 && r.json.code === 'IDEMPOTENCY_KEY_REQUIRED', r.json);
  const inv28 = await invOf(P.꽈리.id);
  const pid28 = (await q(`SELECT purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [lid28]))[0].purchase_id;
  r = await api('POST', `/api/purchase-docs/lines/${lid28}/cancel`, { reason: '단가 오기' }, A, { 'idempotency-key': key() });
  const p28 = (await q(`SELECT status, total_amount - paid_amount AS due FROM purchase WHERE id = $1`, [pid28]))[0];
  const ev28 = await q(`SELECT event_type FROM purchase_match_event WHERE line_id = $1 AND event_type IN ('CANCEL','CANCEL_VIA_PURCHASE')`, [lid28]);
  check('AC-28 전환 취소 → 매입 cancelled·재고 −40·줄 CANCELLED·헤더 재계산·이력 CANCEL 1건(트리거 이력 없음)', r.status === 200 && r.json.data.status === 'CANCELLED' && p28.status === 'cancelled'
    && inv28 - (await invOf(P.꽈리.id)) === 40 && r.json.data.doc_status === 'PARTIAL_CONVERTED' && ev28.length === 1 && ev28[0].event_type === 'CANCEL', { r: r.json, p28, ev28 });
  r = await api('POST', `/api/purchase-docs/lines/${lid28}/rematch`, {}, SI);
  check('AC-28 재대조(입력 직원) → EXACT·PENDING', r.status === 200 && r.json.data.match_result === 'EXACT' && r.json.data.status === 'PENDING', r.json);
  r = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: lid28 }] }, SI, { 'idempotency-key': key() });
  const actives = await q(`SELECT purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [lid28]);
  const staffBy = actives[0] ? (await q(`SELECT created_by_staff_id FROM purchase WHERE id = $1`, [actives[0].purchase_id]))[0].created_by_staff_id : null;
  check('AC-28 재전환 → 새 매입 1건(활성 1건)·AC-34 입력 직원 기록(created_by_staff_id)', r.status === 200 && r.json.data.results[0].result === 'CONVERTED' && actives.length === 1 && actives[0].purchase_id !== pid28 && staffBy != null, { r: r.json, actives, staffBy });
  // AC-29 판매 연결 / 지급
  const pid29 = actives[0].purchase_id;
  const sale29 = await api('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: pid29, partner_id: CUS, quantity: 1, unit_price: 20000, sale_date: kstToday() }] }, A);
  r = await api('POST', `/api/purchase-docs/lines/${lid28}/cancel`, { reason: '테스트' }, A, { 'idempotency-key': key() });
  check('AC-29 판매 연결된 매입 → 409 PURCHASE_HAS_SALES(매출 목록)·변화 없음', sale29.status === 201 && r.status === 409 && r.json.code === 'PURCHASE_HAS_SALES' && Array.isArray(r.json.detail.sales)
    && (await q(`SELECT status FROM purchase_doc_line WHERE id = $1`, [lid28]))[0].status === 'CONVERTED', { sale: sale29.status, r: r.json });
  const pidPay = (await q(`SELECT purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [I.lines[1].id]))[0].purchase_id;
  const pay = await api('POST', '/api/supplier-payments', { partner_id: PA, amount: 1000, paid_at: `${kstToday()}T10:00`, method: 'transfer', allocations: [{ purchase_id: pidPay, amount: 1000 }] }, A);
  r = await api('POST', `/api/purchase-docs/lines/${I.lines[1].id}/cancel`, { reason: '테스트' }, A, { 'idempotency-key': key() });
  check('AC-29 지급 걸린 매입 → 409 PURCHASE_HAS_PAYMENT', pay.status === 201 && r.status === 409 && r.json.code === 'PURCHASE_HAS_PAYMENT', { pay: pay.status, r: r.json });
  // AC-30 매입정보에서 직접 매입 취소
  const pid30 = (await q(`SELECT purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [I.lines[2].id]))[0].purchase_id;
  r = await api('POST', `/api/purchases/${pid30}/cancel`, { reason: '매입정보 화면에서 취소' }, A);
  const l30 = (await q(`SELECT status FROM purchase_doc_line WHERE id = $1`, [I.lines[2].id]))[0];
  const ev30 = await q(`SELECT actor_kind FROM purchase_match_event WHERE line_id = $1 AND event_type = 'CANCEL_VIA_PURCHASE'`, [I.lines[2].id]);
  check('AC-30 기존 매입 취소 → 전환·줄 CANCELLED·이력 CANCEL_VIA_PURCHASE(SYSTEM) 1건', r.status === 200 && l30.status === 'CANCELLED' && ev30.length === 1 && ev30[0].actor_kind === 'SYSTEM', { r: r.json, l30, ev30 });
  const cancelledActive = await q(`SELECT d.id FROM purchase_doc d JOIN purchase_doc_conversion c ON c.doc_id = d.id AND c.status = 'ACTIVE' WHERE d.status = 'CANCELLED'`);
  check('AC-30 확인 SQL(취소된 매입서의 활성 전환) 0행', cancelledActive.length === 0, cancelledActive);
  // AC-31
  r = await api('POST', `/api/purchase-docs/${I.id}/cancel`, { reason: '중복 업로드' }, A, { 'idempotency-key': key() });
  check('AC-31 활성 전환 있는 매입서 취소 → 409 DOC_HAS_CONVERSIONS(줄 목록)', r.status === 409 && r.json.code === 'DOC_HAS_CONVERSIONS' && r.json.detail.lines.length >= 1, r.json);
  const pidCorr = (await q(`SELECT purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [I.lines[1].id]))[0].purchase_id;
  const upd = (await q(`SELECT (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS e FROM purchase WHERE id = $1`, [pidCorr]))[0];
  const corr = await api('PATCH', `/api/purchases/${pidCorr}`, { changes: { memo: '정정 메모' }, reason: '메모 정정' }, A);
  r = await api('GET', `/api/purchase-docs/${I.id}`, null, A);
  check('AC-31 전환 매입을 매입정보에서 정정 → 상세 "전환 뒤 정정됨"(+ 경고 CORRECTED_AFTER_CONVERT)·매입서 값 그대로', corr.status === 200 && r.json.data.lines.find((x) => x.id === I.lines[1].id).corrected_after_convert === true
    && r.json.data.lines.find((x) => x.id === I.lines[1].id).warning_flags.includes('CORRECTED_AFTER_CONVERT')
    && r.json.data.lines.find((x) => x.id === I.lines[1].id).unit_price === 24000, { corr: corr.json, upd });
  r = await postDoc(A, { supplier_partner_id: PA, doc_no: `Z-${tag}`, auto_convert: false, lines: [{ trade_date: S2, item_name: '청양고추', grade: '특', spec: '10kg', qty: 12, unit_price: 38000 }] });
  const z = r.json.data.docs[0];
  r = await api('POST', `/api/purchase-docs/${z.id}/cancel`, { reason: '오등록' }, A, { 'idempotency-key': key() });
  const r2 = await api('POST', `/api/purchase-docs/${z.id}/match`, {}, A);
  const r3 = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: z.lines[0].id }] }, A, { 'idempotency-key': key() });
  check('AC-31 전환 없는 매입서 취소 → CANCELLED, 이후 대조 409 DOC_CANCELLED·전환 불가', r.status === 200 && r.json.data.status === 'CANCELLED' && r2.status === 409 && r2.json.code === 'DOC_CANCELLED'
    && r3.json.data.results[0].result === 'LINE_NOT_CONVERTIBLE', [r.json, r2.json, r3.json]);
  r = await postDoc(A, { supplier_partner_id: PA, doc_no: `Z-${tag}`, lines: [{ trade_date: S2, item_name: '청양고추', qty: 1, unit_price: 1 }] });
  check('취소한 매입서 번호는 다시 쓸 수 있음(취소 제외 유일)', r.status === 201, r.json);
  r = await postDoc(A, { supplier_partner_id: PA, doc_no: `Z-${tag}`, lines: [{ trade_date: S2, item_name: '청양고추', qty: 1, unit_price: 1 }] });
  check('AC-26 같은 제공처·매입서 번호 → 409 DUPLICATE_DOC_NO(기존 id)', r.status === 409 && r.json.code === 'DUPLICATE_DOC_NO' && r.json.detail.doc_id, r.json);
  // AC-26 같은 파일 두 번
  const fileBuf = await xlsx(HEAD, [[`F-${tag}`, S2, 'B청과', '오이고추', '특', '10kg 상자', 18, 29000, '', '', '', '']]);
  const f1 = await upload('/api/purchase-docs', fileBuf, A, 'f.xlsx');
  const f2 = await upload('/api/purchase-docs', fileBuf, A, 'f.xlsx');
  check('AC-26 파일 저장 201(+자동 전환) → 같은 파일 다시 409 DUPLICATE_FILE(기존 doc_ids)', f1.status === 201 && f1.json.data.docs[0].lines[0].status === 'CONVERTED' && f2.status === 409 && f2.json.code === 'DUPLICATE_FILE'
    && f2.json.detail.doc_ids[0] === f1.json.data.docs[0].id, [f1.json, f2.json]);
  const ex = await q(`SELECT kind FROM excel_upload WHERE user_id = $1 AND kind = 'purchase_doc'`, [O.id]);
  check('excel_upload kind purchase_doc 재사용', ex.length === 1, ex);

  // ---------- R-131 매입서 취소 ↔ R-128 수동 확정 같은 매입서 동시 20회 (I 검토 D-01) ----------
  {
    const RACE_N = 20;
    const st = { cancel: {}, confirm: {} };
    for (let i = 0; i < RACE_N; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const rd = await postDoc(A, { supplier_partner_id: PB, auto_convert: false, lines: [{ trade_date: S2, item_name: '오이고추', grade: '특', spec: '10kg 상자', qty: 1, unit_price: 1000 + i }] });
      const dd = rd.json?.data?.docs?.[0];
      if (!dd) { check(`D-01 경합 준비 ${i}`, false, rd.json); break; }
      const lid = dd.lines[0].id;
      // eslint-disable-next-line no-await-in-loop
      const ver = await lv(lid);
      // eslint-disable-next-line no-await-in-loop
      const [rc, rf] = await Promise.all([
        api('POST', `/api/purchase-docs/${dd.id}/cancel`, { reason: '동시성 검사' }, A, { 'idempotency-key': key() }),
        api('POST', `/api/purchase-docs/lines/${lid}/confirm`, { version: ver, accept_diff: true, reason: '동시성 검사', product_id: P.오이.id }, A, { 'idempotency-key': key() }),
      ]);
      st.cancel[`${rc.status}${rc.json && rc.json.code ? ':' + rc.json.code : ''}`] = (st.cancel[`${rc.status}${rc.json && rc.json.code ? ':' + rc.json.code : ''}`] || 0) + 1;
      st.confirm[`${rf.status}${rf.json && rf.json.code ? ':' + rf.json.code : ''}`] = (st.confirm[`${rf.status}${rf.json && rf.json.code ? ':' + rf.json.code : ''}`] || 0) + 1;
      if (rc.status >= 500 || rf.status >= 500) st.err = (st.err || 0) + 1;
    }
    const bad = await q(`SELECT d.id FROM purchase_doc d WHERE d.user_id = $1 AND d.status = 'CANCELLED' AND (
                           EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.doc_id = d.id AND c.status = 'ACTIVE')
                        OR EXISTS (SELECT 1 FROM purchase_doc_line l WHERE l.doc_id = d.id AND l.status = 'CONVERTED')
                        OR EXISTS (SELECT 1 FROM purchase p JOIN purchase_doc_line l ON l.id = p.purchase_doc_line_id WHERE l.doc_id = d.id AND p.status = 'active'))`, [O.id]);
    console.log(`[D-01 경합] 취소 ${JSON.stringify(st.cancel)} / 확정 ${JSON.stringify(st.confirm)}`);
    check(`D-01 매입서 취소 ↔ 수동 확정 동시 ${RACE_N}회 → 취소된 매입서의 활성 전환·CONVERTED 줄·활성 매입 0건`, bad.length === 0, bad);
    check(`D-01 동시 ${RACE_N}회 → 500 0건·한쪽만 성공(취소 200 + 확정 200 동시 0건)`, !st.err && (st.cancel[200] || 0) + (st.confirm[200] || 0) === RACE_N, st);
  }
  // ---------- AC-25 같은 경락 건을 두 줄이 노림 / 동시 확정 (S3) ----------
  const S3 = slot(3);
  await collect(S3, 'FINAL', 'normal');
  const t9 = await T(S3, 9);
  r = await postDoc(A, { supplier_partner_id: PC, auto_convert: false, lines: [
    { trade_date: S3, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000 },
    { trade_date: S3, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000, auction_ref: t9.auction_seq },
  ] });
  const L25 = r.json?.data?.docs?.[0]?.lines || [];
  check('AC-25 점수 높은 줄(경매번호 일치) EXACT, 다른 줄 CANDIDATE_TAKEN', L25[1] && L25[1].match_result === 'EXACT' && L25[1].score === 100 && L25[0].warning_flags.includes('CANDIDATE_TAKEN')
    && L25[0].match_result !== 'EXACT', L25);
  r = await postDoc(A, { supplier_partner_id: PA, lines: [{ trade_date: S3, item_name: '청양고추', grade: '특', spec: '10kg 상자', qty: 12, unit_price: 38000 }] });
  const ha = r.json.data.docs[0].lines[0];
  r = await postDoc(A, { supplier_partner_id: PA, lines: [{ trade_date: S3, item_name: '청양고추', grade: '특', spec: '10kg 상자', qty: 12, unit_price: 38000, origin: '다른 매입서' }] });
  const hb = r.json.data.docs[0].lines[0];
  const t1a = await T(S3, 1);
  const [ca, cb] = await Promise.all([
    api('POST', `/api/purchase-docs/lines/${ha.id}/confirm`, { trade_id: Number(t1a.id), accept_diff: true, reason: '같은 건 경합' }, A, { 'idempotency-key': key() }),
    api('POST', `/api/purchase-docs/lines/${hb.id}/confirm`, { trade_id: Number(t1a.id), accept_diff: true, reason: '같은 건 경합' }, A, { 'idempotency-key': key() }),
  ]);
  check('AC-25 같은 경락 건 동시 확정 2건 → 하나만 성공, 다른 하나 409 TRADE_TAKEN', [ca, cb].filter((x) => x.status === 200).length === 1 && [ca, cb].some((x) => x.status === 409 && x.json.code === 'TRADE_TAKEN'), [ca.json, cb.json]);

  // ---------- AC-18 환산 반올림 차 (S4) ----------
  const S4 = slot(4);
  await collect(S4, 'FINAL', 'normal');
  r = await postDoc(A, { supplier_partner_id: PA, auto_convert: false, lines: [{ trade_date: S4, item_name: '꽈리고추', grade: '특', spec: '4kg 상자', qty: 30, unit_price: 21000, product_id: personal10 }] });
  const l18 = r.json.data.docs[0].lines[0];
  r = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: l18.id }] }, A, { 'idempotency-key': key() });
  const p18 = (await q(`SELECT quantity, unit_price, total_amount FROM purchase WHERE purchase_doc_line_id = $1`, [l18.id]))[0];
  check('AC-18 품목 단위 10kg·매입서 4kg 30상자 → 수량 12.000·단가 52,500·합계 630,000(차 0)', r.json.data.results[0].result === 'CONVERTED' && Number(p18.quantity) === 12 && Number(p18.unit_price) === 52500 && Number(p18.total_amount) === 630000, { r: r.json, p18 });
  r = await postDoc(A, { supplier_partner_id: PC, auto_convert: false, lines: [{ trade_date: S4, item_name: '꽈리고추', grade: '상', spec: '4kg 상자', qty: 7, unit_price: 17500, buyer_code: '1003' }] });
  const l18b = r.json.data.docs[0].lines[0];
  const t4 = await T(S4, 5);
  r = await api('POST', `/api/purchase-docs/lines/${l18b.id}/confirm`, { trade_id: Number(t4.id), version: await lv(l18b.id) }, A, { 'idempotency-key': key() });
  check('AC-18 4kg 7상자 → 품목 3kg 단위 환산 차 → 400 DIFF_NOT_ACCEPTED', r.status === 400 && r.json.code === 'DIFF_NOT_ACCEPTED' && r.json.detail.plan.reason === 'UNIT_ROUNDING', r.json);
  r = await api('POST', `/api/purchase-docs/lines/${l18b.id}/confirm`, { trade_id: Number(t4.id), version: await lv(l18b.id), accept_diff: true, reason: '반올림 차 확인' }, A, { 'idempotency-key': key() });
  const cv18 = (await q(`SELECT amount_diff, purchase_qty, purchase_unit_price FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [l18b.id]))[0];
  check('AC-18 accept_diff + 사유 → FORCED·amount_diff 기록(ROUND(9.333 × 13,125, 2) − 122,500 = −4.37)', r.status === 200 && r.json.data.mode === 'FORCED' && cv18 && Number(cv18.amount_diff) === -4.37 && Number(cv18.purchase_qty) === 9.333, cv18);

  // ---------- AC-20 ② 수집 안 된 날 → FINAL 수집 뒤 자동 재대조 (S5) / ③ 당일 INTRADAY 만 (S6) / NO_BASE_DATA (S7) ----------
  const S5 = slot(5);
  r = await postDoc(A, { supplier_partner_id: PB, lines: [{ trade_date: S5, item_name: '오이고추', grade: '특', spec: '10kg 상자', qty: 18, unit_price: 29000 }] });
  const l20 = r.json.data.docs[0].lines[0];
  check('AC-20 ② 수집 안 된 날 → UNMATCHED BASE_NOT_READY·HOLD', l20.match_result === 'UNMATCHED' && l20.reason_codes.includes('BASE_NOT_READY') && l20.status === 'HOLD', l20);
  await collect(S5, 'FINAL', 'normal');
  await drain();
  const l20b = (await q(`SELECT status, match_result FROM purchase_doc_line WHERE id = $1`, [l20.id]))[0];
  const ev20 = await q(`SELECT actor_kind, event_type FROM purchase_match_event WHERE line_id = $1 AND event_type = 'AUTO_CONVERT'`, [l20.id]);
  check('AC-20 ② 그 날 FINAL 수집 뒤 REMATCH → EXACT·자동 전환(행위자 SYSTEM)', l20b.status === 'CONVERTED' && l20b.match_result === 'EXACT' && ev20.length === 1 && ev20[0].actor_kind === 'SYSTEM', { l20b, ev20 });
  const S6 = slot(6);
  await collect(S6, 'INTRADAY', 'normal');
  r = await postDoc(A, { supplier_partner_id: PC, lines: [{ trade_date: S6, item_name: '홍고추', grade: '특', spec: '10kg 상자', qty: 10, unit_price: 45000 }] });
  const l20c = r.json.data.docs[0].lines[0];
  check('AC-20 ③ 당일(INTRADAY 만) → EXACT 여도 PENDING BASE_NOT_FINAL(자동 전환 안 함)', l20c.match_result === 'EXACT' && l20c.status === 'PENDING' && l20c.reason_codes.includes('BASE_NOT_FINAL') && !l20c.convertible, l20c);
  r = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: l20c.id }] }, A, { 'idempotency-key': key() });
  check('R-127 BASE_NOT_FINAL 줄 → NEEDS_CONFIRM', r.json.data.results[0].result === 'NEEDS_CONFIRM' && r.json.data.results[0].code === 'BASE_NOT_FINAL', r.json);
  r = await postDoc(A, { supplier_partner_id: PB, lines: [{ trade_date: S7, item_name: '오이고추', grade: '특', spec: '10kg 상자', qty: 18, unit_price: 29000 }] });
  check('AC-02·20 정상 스냅샷이 EMPTY 뿐 → UNMATCHED NO_BASE_DATA', r.json.data.docs[0].lines[0].reason_codes.includes('NO_BASE_DATA'), r.json.data.docs[0].lines[0]);

  // ---------- R-126 줄 수정 / R-129 매입 아님 ----------
  r = await api('PATCH', `/api/purchase-docs/lines/${l15b.id}`, { version: 1, unit_price: 25000 }, A);
  check('R-126 version 다름 → 409 VERSION_CONFLICT', r.status === 409 && r.json.code === 'VERSION_CONFLICT', r.json);
  r = await api('PATCH', `/api/purchase-docs/lines/${l15b.id}`, { version: await lv(l15b.id), trade_date: addDays(S1, 1) }, SI);
  check('R-126 줄 수정(입력 직원, 거래일 −1로) → 재대조 EXACT', r.status === 200 && r.json.data.match_result === 'EXACT', r.json);
  r = await api('PATCH', `/api/purchase-docs/lines/${l15b.id}`, { version: await lv(l15b.id), unit_price: '25000.5' }, A);
  check('R-126 단가 소수 → 400 NOT_INTEGER_WON', r.status === 400 && r.json.errors && r.json.errors[0].code === 'NOT_INTEGER_WON', r.json);
  r = await api('PATCH', `/api/purchase-docs/lines/${l14.id}`, { version: await lv(l14.id), qty: 9 }, A);
  check('R-126 전환된 줄 수정 → 409 LINE_CONVERTED', r.status === 409 && r.json.code === 'LINE_CONVERTED', r.json);
  r = await api('POST', `/api/purchase-docs/lines/${L[1].id}/reject`, { reason: '' }, A);
  check('R-129 사유 없음 → 400 REASON_REQUIRED', r.status === 400 && r.json.code === 'REASON_REQUIRED', r.json);
  r = await api('POST', `/api/purchase-docs/lines/${L[1].id}/reject`, { reason: '다른 중매인 낙찰분' }, SI);
  check('AC-34 입력 직원 매입 아님 → 403', r.status === 403, r.status);
  r = await api('POST', `/api/purchase-docs/lines/${L[1].id}/reject`, { reason: '다른 중매인 낙찰분' }, A);
  check('R-129 매입 아님 → REJECTED', r.status === 200 && r.json.data.status === 'REJECTED', r.json);
  r = await api('POST', `/api/purchase-docs/lines/${l14.id}/reject`, { reason: '잘못' }, A);
  check('R-129 전환된 줄 → 409 LINE_CONVERTED', r.status === 409 && r.json.code === 'LINE_CONVERTED', r.json);
  r = await api('POST', `/api/purchase-docs/lines/${L[1].id}/rematch`, {}, A);
  check('R-125 REJECTED 줄 재대조 → 다시 대조(rejected_at 지움)', r.status === 200 && r.json.data.status === 'HOLD' && (await q(`SELECT rejected_at FROM purchase_doc_line WHERE id = $1`, [L[1].id]))[0].rejected_at === null, r.json);

  // ---------- 조회 R-119·R-120·R-121·R-123 ----------
  r = await api('GET', `/api/purchase-docs?status=CONVERTED&limit=200`, null, SV);
  check('R-119 목록(조회 직원) 상태 필터·건수', r.status === 200 && r.json.data.some((x) => x.id === doc14.id) && r.json.data.every((x) => x.status === 'CONVERTED'), r.json.total);
  r = await api('GET', `/api/purchase-docs/${doc14.id}`, null, A);
  check('R-120 상세: 줄·purchase_id·best 후보', r.status === 200 && r.json.data.lines[0].purchase_id === l14.purchase_id && r.json.data.lines[0].best.unit_price === 45000, r.json.data && r.json.data.lines[0]);
  r = await api('GET', `/api/purchase-docs/review?reason=MULTI_CANDIDATE`, null, A);
  check('R-121 검토 대기 사유 필터(+ doc_id·top_diff)', r.status === 200 && Array.isArray(r.json.data) && r.json.data.every((x) => x.doc_id && 'top_diff' in x), r.json);
  r = await api('GET', `/api/purchase-docs/review`, null, A);
  check('R-121 검토 대기에 HOLD·CANCELLED 줄', r.status === 200 && r.json.data.some((x) => x.status === 'HOLD') && r.json.data.some((x) => x.status === 'CANCELLED'), r.json.total);

  // ---------- AC-32 감사 ----------
  r = await api('GET', `/api/purchase-docs/${docMix.id}/events`, null, A);
  check('AC-32 R-123 사건 이력(행위자 이름·점수·사유·tolerance·diff)', r.status === 200 && r.json.data.some((e) => e.event_type === 'FORCE_CONFIRM' && e.actor_name === '주인' && e.detail.tolerance && e.detail.diff)
    && r.json.data.some((e) => e.event_type === 'MATCH' && e.score != null), r.json.data && r.json.data.map((e) => e.event_type));
  r = await api('GET', `/api/purchase-docs/${I.id}/events`, null, A);
  check('AC-32 직원 행위자 이름(직원in1)', r.json.data.some((e) => e.actor_kind === 'STAFF' && e.actor_name === '직원in1'), r.json.data.map((e) => [e.event_type, e.actor_kind, e.actor_name]));
  r = await api('GET', '/api/history?kind=purchase_match&limit=200', null, A);
  check('AC-32 변경 이력 화면 kind=purchase_match 에 AUTO_CONVERT·FORCE_CONFIRM·CANCEL', r.status === 200 && ['자동 매입 등록', '강제 확정', '전환 취소'].every((w) => r.json.data.some((h) => (h.target_label || '').includes(w))), r.json.data && r.json.data.slice(0, 5));
  let upErr = null;
  try { await q(`UPDATE purchase_match_event SET reason = 'x' WHERE user_id = $1`, [O.id]); } catch (e) { upErr = e.code; }
  let delErr = null;
  try { await q(`DELETE FROM purchase_match_event WHERE user_id = $1`, [O.id]); } catch (e) { delErr = e.code; }
  check('AC-32 이력 UPDATE·DELETE → 오류 P0001', upErr === 'P0001' && delErr === 'P0001', { upErr, delErr });

  // ---------- AC-33 다른 회원 ----------
  const OT = OTHER.tok;
  const rs = await Promise.all([
    api('GET', `/api/purchase-docs/${doc14.id}`, null, OT), api('GET', `/api/purchase-docs/lines/${l14.id}/candidates`, null, OT),
    api('POST', `/api/purchase-docs/lines/${L[0].id}/confirm`, { accept_diff: true, reason: '남의 줄' }, OT, { 'idempotency-key': key() }),
    api('POST', `/api/purchase-docs/lines/${l14.id}/cancel`, { reason: '남의 줄' }, OT, { 'idempotency-key': key() }),
    api('GET', `/api/purchase-docs/${doc14.id}/events`, null, OT), api('POST', `/api/purchase-docs/${doc14.id}/match`, {}, OT),
    api('PATCH', `/api/purchase-docs/lines/${l14.id}`, { version: 1, qty: 1 }, OT),
  ]);
  check('AC-33 다른 회원 토큰으로 내 매입서·줄·후보·이력 → 404(존재 숨김)', rs.every((x) => x.status === 404), rs.map((x) => x.status));
  r = await api('POST', '/api/purchase-docs/convert', { lines: [{ line_id: l15a.id }] }, OT, { 'idempotency-key': key() });
  check('AC-33 다른 회원 R-127 → 줄 결과 NOT_FOUND', r.status === 200 && r.json.data.results[0].result === 'NOT_FOUND', r.json);
  r = await api('POST', '/api/purchase-docs', { supplier_partner_id: PA, lines: [{ trade_date: S0, item_name: '청양고추', qty: 1, unit_price: 1 }] }, OT, { 'idempotency-key': key() });
  check('AC-33 남의 거래처로 매입서 → 400 PARTNER_NOT_FOUND(field lines.0.supplier_partner_id)', r.status === 400 && r.json.errors[0].code === 'PARTNER_NOT_FOUND' && r.json.errors[0].field === 'lines.0.supplier_partner_id', r.json);
  r = await api('GET', `/api/purchase-docs/abc`, null, A);
  check(':id 양의 정수 아님 → 404', r.status === 404, r.status);

  // ---------- AC-34 역할별 쓰기 ----------
  const W = [
    ['POST', '/api/purchase-docs/convert', { lines: [{ line_id: l15a.id }] }, true], ['POST', `/api/purchase-docs/${I.id}/match`, {}, false],
    ['POST', `/api/purchase-docs/lines/${l15a.id}/rematch`, {}, false], ['PATCH', `/api/purchase-docs/lines/${l15a.id}`, { version: 1 }, false],
    ['POST', '/api/purchase-docs', { supplier_partner_id: PA, lines: [] }, true],
    ['POST', '/api/auction/sync', {}, false], ['PUT', '/api/auction/product-links', { links: [] }, false], ['PUT', '/api/purchase-match/tolerances', {}, false],
    ['POST', `/api/purchase-docs/lines/${l15a.id}/confirm`, {}, true], ['POST', `/api/purchase-docs/lines/${l15a.id}/reject`, { reason: 'xx' }, false],
    ['POST', `/api/purchase-docs/lines/${l15a.id}/cancel`, { reason: 'xx' }, true], ['POST', `/api/purchase-docs/${I.id}/cancel`, { reason: 'xx' }, true],
    ['PUT', '/api/auction/calendar', { add: [] }, false], ['PUT', '/api/auction/schedules', {}, false], ['POST', '/api/auction/item-mappings', {}, false],
    ['POST', '/api/auction/jobs/1/retry', {}, false], ['POST', '/api/auction/jobs/1/cancel', {}, false], ['PUT', '/api/auction/corp-links', { links: [] }, false],
    ['DELETE', '/api/auction/product-links/1', null, false], ['DELETE', '/api/purchase-match/tolerances/1', null, false], ['DELETE', '/api/auction/item-mappings/1', null, false],
    ['PUT', '/api/auction/item-mappings/1', {}, false],
  ];
  const viewRes = await Promise.all(W.map(([m, p, b, ik]) => api(m, p, b, SV, ik ? { 'idempotency-key': key() } : {})));
  check('AC-34 조회 직원: 모든 쓰기 403', viewRes.every((x) => x.status === 403), W.map((w, i) => `${w[1]}:${viewRes[i].status}`).filter((x) => !x.endsWith(':403')));
  const ownerOnly = W.slice(5);
  const inRes = await Promise.all(ownerOnly.map(([m, p, b, ik]) => api(m, p, b, SI, ik ? { 'idempotency-key': key() } : {})));
  check('AC-34 입력 직원: R-98·R-109·R-114·R-128~R-131·관리자 라우트 403', inRes.every((x) => x.status === 403), ownerOnly.map((w, i) => `${w[1]}:${inRes[i].status}`).filter((x) => !x.endsWith(':403')));
  const inOk = await Promise.all(W.slice(0, 5).map(([m, p, b, ik]) => api(m, p, b, SI, ik ? { 'idempotency-key': key() } : {})));
  check('AC-34 입력 직원: R-117·R-118·R-124~R-127 권한 통과(403 아님)', inOk.every((x) => x.status !== 403), inOk.map((x) => x.status));
  r = await api('GET', '/api/me', null, SI);
  const ui = (r.json && (r.json.allow || (r.json.data && r.json.data.allow))) || [];
  check('allowedUi: 입력 직원 purchase_doc.upload·convert 있음, confirm 없음', ui.includes('purchase_doc.upload') && ui.includes('purchase_doc.convert') && !ui.includes('purchase_doc.confirm'), ui);

  // ---------- AC-35 금액 정밀 ----------
  r = await postDoc(A, { supplier_partner_id: PA, lines: [
    { trade_date: S0, item_name: '청양고추', grade: '하', spec: '3kg', qty: '999.000', unit_price: 9999999 },
    { trade_date: S0, item_name: '청양고추', grade: '하', spec: '3kg', qty: 3, unit_price: 35000 },
    { trade_date: S0, item_name: '청양고추', grade: '하', spec: '3kg', qty: 1, unit_price: 23000 },
  ] });
  const amts = await q(`SELECT amount::text, ROUND(unit_price::numeric / unit_qty_kg, 2)::text AS kgp FROM purchase_doc_line WHERE doc_id = $1 ORDER BY line_no`, [r.json.data.docs[0].id]);
  check('AC-35 9,999,999 × 999 = 9,989,999,001 / 35,000 × 3 = 105,000 / 23,000원 3kg → 7,666.67', amts[0].amount === '9989999001' && amts[1].amount === '105000' && amts[2].kgp === '7666.67', amts);
  check('AC-35 응답 금액 정수 원', r.json.data.docs[0].lines.length === 3, r.json);
  r = await api('GET', `/api/purchase-docs/${r.json.data.docs[0].id}`, null, A);
  check('AC-35 상세 금액 9989999001(2^53 안 정수)', r.json.data.amount_total === 9989999001 + 105000 + 23000, r.json.data.amount_total);

  // ---------- R-96·R-97·R-134·R-135·R-94 ----------
  r = await api('GET', '/api/auction/sync/status', null, SV);
  check('R-96 수집 현황(조회 직원) circuits·days·queue·source_mode', r.status === 200 && r.json.circuits.length >= 4 && Array.isArray(r.json.days) && r.json.source_mode === 'MOCK', Object.keys(r.json));
  r = await api('GET', '/api/auction/jobs?status=DEAD', null, SV);
  check('R-97 작업 목록 상태 필터·error_message', r.status === 200 && r.json.data.every((x) => x.status === 'DEAD') && r.json.data.every((x) => 'error_message' in x), r.json.total);
  r = await api('PUT', '/api/auction/schedules', { job_type: 'COLLECT_FINAL', source: 'AT_REALTIME', cron_text: '0 25 * * *' }, ADM.tok);
  check('R-135 cron 형식 오류 → 400 BAD_CRON', r.status === 400 && r.json.code === 'BAD_CRON', r.json);
  r = await api('PUT', '/api/auction/schedules', { job_type: 'COLLECT_FINAL', source: 'AT_REALTIME', cron_text: '0 11,16 * * *', active: false }, ADM.tok);
  check('R-135 일정 저장(관리자)', r.status === 200 && r.json.data.cron_text === '0 11,16 * * *', r.json);
  const G = slot(30);
  j = await collect(G, 'FINAL', 'normal', { source: 'GARAK_PRICE' });
  r = await api('GET', `/api/auction/daily-prices?date=${G}`, null, A);
  check('R-94 참고 시세(가락 목업 3품목) 평균가·전일 대비', j.status === 'DONE' && r.status === 200 && r.json.data.length === 3 && r.json.data[0].avg_price > 0 && r.json.data.some((x) => x.diff === 500), r.json);

  // ---------- H UI: R-137 법인 목록 — 조회 페이지가 아니라 수집된 전체 법인(DISTINCT corp_code) ----------
  {
    const mk = (await q(`SELECT market_code FROM auction_trade WHERE corp_code IS NOT NULL ORDER BY id DESC LIMIT 1`))[0]?.market_code;
    const want = (await q(`SELECT DISTINCT corp_code FROM auction_trade WHERE market_code = $1 AND corp_code IS NOT NULL AND corp_code <> '' ORDER BY 1`, [mk])).map((x) => x.corp_code);
    r = await api('GET', '/api/auction/corps', null, A);
    const got = r.status === 200 && Array.isArray(r.json.data) ? r.json.data : [];
    const codes = got.map((x) => x.corp_code);
    check('R-137 법인 목록 = 수집된 경락의 전체 법인(코드 중복 없음·이름 있음·정렬)', r.status === 200 && want.length > 0 && want.every((c) => codes.includes(c))
      && new Set(codes).size === codes.length && got.every((x) => x.corp_name) && codes.join() === [...codes].sort().join(), { want, got });
    r = await api('GET', '/api/auction/corps', null, SV);
    check('R-137 직원(조회)도 법인 목록 조회 200', r.status === 200, r.status);
    r = await api('GET', '/api/auction/corps');
    check('R-137 로그인 없음 → 401', r.status === 401, r.status);
  }

  // ---------- T-203 후속: 운영 경락 보관 기간(AUCTION_TRADE_KEEP_DAYS) · R-136 DB 사용량 ----------
  // 정리 작업을 이 프로세스에서 직접 돌린다(서버 환경을 바꾸지 않음). 기준선 = 이번 실행 기준일 B 다음 날 → B 이하(이번·이전 실행 데이터)만 대상
  {
    const workerLib = require('../lib/auction/worker');
    const queueLib = require('../lib/auction/queue');
    const savedEnv = { k: process.env.AUCTION_TRADE_KEEP_DAYS, b: process.env.PURGE_BATCH_ROWS, m: process.env.PURGE_BUDGET_MS };
    const cut = addDays(B, 1);
    const keepN = Math.round((Date.parse(`${kstToday()}T00:00:00Z`) - Date.parse(`${cut}T00:00:00Z`)) / 86400000);
    const REF = `(EXISTS (SELECT 1 FROM purchase_doc_line l WHERE l.best_trade_id = t.id) OR EXISTS (SELECT 1 FROM purchase_match_candidate c WHERE c.trade_id = t.id)
                 OR EXISTS (SELECT 1 FROM purchase_doc_conversion v WHERE v.trade_id = t.id) OR EXISTS (SELECT 1 FROM purchase_match_event e WHERE e.trade_id = t.id))`;
    const stat = async () => (await q(
      `SELECT (SELECT COUNT(*)::int FROM auction_trade t WHERE t.trade_date < $1 AND NOT ${REF}) AS old_unref,
              (SELECT COALESCE(array_agg(t.id::int ORDER BY t.id), '{}') FROM auction_trade t WHERE t.trade_date < $1 AND ${REF}) AS old_ref_ids,
              (SELECT COUNT(*)::int FROM auction_trade WHERE trade_date >= $1) AS recent,
              (SELECT COUNT(*)::int FROM auction_trade) AS total,
              (SELECT COUNT(*)::int FROM auction_trade_history h JOIN auction_trade t ON t.id = h.trade_id WHERE t.trade_date < $1 AND NOT ${REF}) AS old_hist,
              (SELECT COUNT(*)::int FROM market_price_daily WHERE price_date < $1) AS old_price,
              (SELECT COUNT(*)::int FROM collect_snapshot WHERE trade_date >= $1) AS recent_snap,
              (SELECT COUNT(*)::int FROM collect_snapshot WHERE trade_date < $1 AND is_latest_ok) AS old_snap_ok,
              (SELECT COUNT(*)::int FROM purchase_doc_conversion) AS conv`, [cut]))[0];
    const purge = async () => {
      await queueLib.enqueue(pool, { job_type: 'PURGE_RAW', dedupe_key: `PURGE_RAW:TEST:${crypto.randomBytes(6).toString('hex')}` });
      const job = await queueLib.claim(pool, { types: ['PURGE_RAW'] });
      job.params = job.params || {};
      const rr = await workerLib.runJob(pool, job);
      return { ...rr, job_status: (await q(`SELECT status FROM collect_job WHERE id = $1`, [job.id]))[0].status };
    };
    // 근거 없는 옛 경락 하나에 이전 값 이력을 붙여 둔다(경락과 함께 지워져야 함)
    const victim = (await q(`SELECT t.id, t.snapshot_id FROM auction_trade t WHERE t.trade_date < $1 AND NOT ${REF} ORDER BY t.id LIMIT 1`, [cut]))[0];
    if (victim) await q(`INSERT INTO auction_trade_history (trade_id, revision, old_values, content_hash, snapshot_id) VALUES ($1, 9999, '{}'::jsonb, repeat('0', 64), $2) ON CONFLICT DO NOTHING`, [victim.id, victim.snapshot_id]);
    const s0 = await stat();
    check('RET 준비 — 기준선 이전 근거 없는 경락·근거 경락이 모두 있음', s0.old_unref > 0 && s0.old_ref_ids.length > 0 && !!victim, { old_unref: s0.old_unref, ref: s0.old_ref_ids.length });

    delete process.env.AUCTION_TRADE_KEEP_DAYS;
    let pr = await purge();
    let s1 = await stat();
    check('RET-1 보관 기간 미설정 → 경락 삭제 0(무기한)', pr.status === 'DONE' && pr.trade_keep_days === null && pr.trades_deleted === undefined && s1.total === s0.total && s1.old_price === s0.old_price, { pr, total: [s0.total, s1.total] });

    process.env.AUCTION_TRADE_KEEP_DAYS = 'abc';
    pr = await purge();
    s1 = await stat();
    check('RET-2 잘못된 값(abc) → 설정 오류 표시·삭제 0', pr.trade_keep_invalid === true && pr.trade_keep_days === null && s1.total === s0.total, pr);
    const k3 = workerLib.tradeRetention({ AUCTION_TRADE_KEEP_DAYS: '3' });
    check('RET-3 최소값 — 3일 설정은 누락 보정+1(8일)로 적용', k3.days === 8 && k3.clamped === true, k3);

    // 분할 삭제: 한 번에 5행, 시간 예산 0 → 첫 정리는 1묶음만 지우고 남은 수를 보고
    process.env.AUCTION_TRADE_KEEP_DAYS = String(keepN);
    process.env.PURGE_BATCH_ROWS = '5';
    process.env.PURGE_BUDGET_MS = '0';
    pr = await purge();
    s1 = await stat();
    check('RET-4 분할 삭제 — 예산 0·묶음 5 → 5행만 지우고 남은 행 보고·작업 DONE', pr.job_status === 'DONE' && pr.trade_cutoff === cut && pr.trades_deleted === Math.min(5, s0.old_unref)
      && pr.trades_remaining === s0.old_unref - pr.trades_deleted && s1.old_unref === s0.old_unref - pr.trades_deleted, { pr, before: s0.old_unref, after: s1.old_unref });

    process.env.PURGE_BATCH_ROWS = '1000';
    process.env.PURGE_BUDGET_MS = '20000';
    pr = await purge();
    const s2 = await stat();
    check('RET-5 보관 기간 지난 근거 없는 경락 0·이전 값 이력·참고 시세도 삭제', s2.old_unref === 0 && s2.old_hist === 0 && s2.old_price === 0 && pr.trades_remaining === 0
      && (await q(`SELECT 1 FROM auction_trade_history WHERE trade_id = $1`, [victim.id])).length === 0, { pr, s2 });
    check('RET-6 매입서 근거 경락은 그대로(같은 id 전부)·매입전환 수 그대로', same(s2.old_ref_ids, s0.old_ref_ids) && s2.conv === s0.conv && pr.trades_kept_referenced === s0.old_ref_ids.length,
      { kept: s2.old_ref_ids.length, was: s0.old_ref_ids.length, pr });
    check('RET-7 기준선 이후 경락·스냅샷은 그대로', s2.recent === s0.recent && s2.recent_snap === s0.recent_snap, { recent: [s0.recent, s2.recent], snap: [s0.recent_snap, s2.recent_snap] });
    const orphanSnap = (await q(`SELECT COUNT(*)::int AS n FROM collect_snapshot s WHERE s.trade_date < $1 AND s.status <> 'RUNNING'
        AND NOT EXISTS (SELECT 1 FROM auction_trade a WHERE a.snapshot_id = s.id) AND NOT EXISTS (SELECT 1 FROM auction_trade_history h WHERE h.snapshot_id = s.id)
        AND NOT EXISTS (SELECT 1 FROM market_price_daily m WHERE m.snapshot_id = s.id)`, [cut]))[0].n;
    check('RET-8 빈 옛 스냅샷 삭제·근거 경락 때문에 남은 옛 스냅샷은 정상 표시(is_latest_ok) 내림', orphanSnap === 0 && s2.old_snap_ok === 0 && pr.snapshots_deleted > 0, { orphanSnap, pr });
    const det = (await q(`SELECT line_id FROM purchase_doc_conversion WHERE trade_id = ANY($1::bigint[]) AND status = 'ACTIVE' LIMIT 1`, [s0.old_ref_ids]))[0];
    r = det ? await api('GET', `/api/purchase-docs/lines/${det.line_id}/candidates`, null, A) : { status: 'no-line' };
    check('RET-9 정리 뒤에도 매입 등록 줄의 후보 조회 정상(200)', r.status === 200, r.status);

    pr = await purge();
    const s3 = await stat();
    check('RET-10 재실행 멱등 — 삭제 0·표시 변경 0·행 수 그대로', pr.trades_deleted === 0 && pr.trade_history_deleted === 0 && pr.prices_deleted === 0 && pr.snapshots_deleted === 0
      && pr.snapshots_unmarked === 0 && s3.total === s2.total, pr);

    r = await api('GET', '/api/auction/storage', null, ADM.tok);
    const sd = r.json && r.json.data;
    check('RET-11 R-136 DB 사용량(관리자) — 크기·한도·경락 행 수·가장 오래된 날짜·표 크기·마지막 정리', r.status === 200 && sd.db_bytes > 0 && sd.limit_bytes === 1024 * 1024 * 1024
      && sd.trade_count === s3.total && typeof sd.oldest_trade_date === 'string' && 'retention' in sd && Array.isArray(sd.tables) && sd.tables.some((x) => x.name === 'auction_trade')
      && sd.last_purge && sd.last_purge.result && sd.last_purge.result.trade_keep_days === keepN, sd);
    check('RET-12 R-136 한도 80% 미만이면 경고 없음(이상이면 경고 문구)', !!sd && (sd.usage_ratio < 0.8 ? sd.warning === null : typeof sd.warning === 'string'), sd && { ratio: sd.usage_ratio, warning: sd.warning });
    r = await api('GET', '/api/auction/storage', null, A);
    check('RET-13 R-136 관리자 아닌 주인 → 403 ADMIN_ONLY', r.status === 403 && r.json.code === 'ADMIN_ONLY', r.json);
    r = await api('GET', '/api/auction/storage', null, SV);
    check('RET-14 R-136 직원 → 403', r.status === 403, r.status);

    for (const [k, v] of [['AUCTION_TRADE_KEEP_DAYS', savedEnv.k], ['PURGE_BATCH_ROWS', savedEnv.b], ['PURGE_BUDGET_MS', savedEnv.m]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }

  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE status = 'QUEUED'`);
  await resetCircuit();
  await pool.end();
  const pass = results.filter((x) => x.ok).length;
  console.log(`\n[purchase-match-test] ${pass}/${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error('[purchase-match-test] 중단:', err);
  process.exit(1);
});
