/**
 * T-203 실 API(katRealTime2/trades2) 전환 테스트 — A_실API보정 AC-42~55 · I B-1~B-9 (기존 purchase-match-test 기대값은 건드리지 않음)
 *
 * 사용: server 폴더에서
 *   DATABASE_URL=<로컬 테스트 DB> MATCH_API_BASE=http://127.0.0.1:<포트> node scripts/t203-realapi-test.js
 * 전제: 마이그레이션 001~030 + scripts/seed-at-realtime-mapping.js + seed-sample-local(공용 품목), 서버 기동(AUCTION_SOURCE_MODE 아무거나 — 수집은 이 스크립트가 직접)
 *   ※ 실 API 를 부르지 않는다. 실데이터는 재생(REPLAY) 파일(lib/auction/fixtures/real/, 2026-11-24·25 실호출 원문)로만 쓴다.
 *   ※ 2026-11-24 에 AT_REALTIME FINAL 정상 스냅샷이 이미 있으면(로컬 실테스트로 실수집한 DB) 수집은 건너뛰고 저장 결과만 검사한다.
 *   ※ purchase-match-test 와 같은 DB 에서 돌릴 때는 purchase-match-test 를 먼저(이 스크립트는 2026-11-24·25 실데이터 날짜를 씀).
 *
 * 묶음
 *  U  순수 함수: 응답 코드 "0"·필드 이름(R-01)·자연키 모양·옛 목업 해시 불변·코드 매핑 IGNORE·점수 m2(실 경락만)
 *  M  실형식 목업(MOCK 시나리오 real*) — 저장·멱등·정정·옛 응답(STALE)·철회·같은 키 두 번·자연키 없음·쪽 나눔
 *  R  재생(REPLAY) — 2026-11-24 FINAL·2026-11-25 수집 건수(AC-42·43), 매핑 결과(AC-53), 자연키 중복 0, 철회 범위(R-04)
 *  S  보안·운영 경고 — 원천 로그 키 가림(C-RA-01, 가짜 키·가짜 fetch), 매핑 시드 0행 경고(O1)
 *  D  대조 m2(API) — AC-46·47·48·49·50·51·47b(스위치 끔)
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcrypt');
require('../lib/db-config');
const { Pool } = require('pg');

const BASE = process.env.MATCH_API_BASE || 'http://127.0.0.1:3000';
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL || !/127\.0\.0\.1|localhost/.test(DB_URL)) { console.error('[t203-realapi-test] 로컬 테스트 DB 에서만 실행합니다.'); process.exit(2); }
if (process.env.NODE_ENV === 'production') process.exit(2);

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' — ' + String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 700)}`);
}
async function api(method, p, body, token, headers = {}) {
  const r = await fetch(BASE + p, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { _text: text.slice(0, 200) }; }
  return { status: r.status, json: j };
}
const key = () => `k_${crypto.randomBytes(9).toString('hex')}`;
const KEY_RE = /^\d{6}\|\d{4}-\d{2}-\d{2}\|\d{8}\|[^|]+\|[^|]+$/;

/** 환경변수를 잠깐 바꿔 fn 실행(수집 모드 전환용 — 이 프로세스 안에서만) */
async function withEnv(vars, fn) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) { old[k] = process.env[k]; if (v == null) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v == null) delete process.env[k]; else process.env[k] = v; } }
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const q = async (sql, p) => (await pool.query(sql, p)).rows;
  const queue = require('../lib/auction/queue');
  const worker = require('../lib/auction/worker');
  const norm = require('../lib/auction/normalizer');
  const ad = require('../lib/auction/adapters');
  const base = require('../lib/auction/adapters/base');
  const score = require('../lib/purchase-match/score');
  const tag = Date.now().toString(36);

  await q(`UPDATE collect_schedule SET active = false`);
  await q(`UPDATE ext_circuit_state SET state = 'CLOSED', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL, disabled_reason = NULL, disabled_until = NULL`);
  const mapRows = Number((await q(`SELECT COUNT(*) n FROM item_mapping WHERE memo LIKE 'AT 시드:%'`))[0].n);
  check('준비 030 + AT 매핑 시드(seed-at-realtime-mapping) 적용됨', mapRows >= 21, mapRows);

  // ================= U 순수 함수 =================
  const okJson = (code, items) => JSON.stringify({ response: { header: { resultCode: code, resultMsg: 'x' }, body: { items: items.length ? { item: items } : '', totalCount: items.length } } });
  let s = base.readStandardJson(JSON.parse(okJson('0', [{ a: 1 }])));
  check('U-1 실 응답 resultCode "0" → OK(전에는 SERVER_ERROR 로 실패)', s.kind === 'OK' && s.items.length === 1, s);
  s = base.readStandardJson(JSON.parse(okJson('0', [])));
  check('U-2 resultCode "0" + 0건 → EMPTY', s.kind === 'EMPTY', s);
  s = base.readStandardJson(JSON.parse(okJson('30', [])));
  check('U-3 resultCode "30" → AUTH_ERROR(기존 규칙 유지)', s.kind === 'AUTH_ERROR', s);
  const mockDir = ad.MOCK_DIR;
  const realItems = JSON.parse(fs.readFileSync(path.join(mockDir, 'at_real_normal.json'), 'utf8')).response.body.items.item;
  const A = new ad.AtRealtimeAdapter({ mode: 'LIVE' });
  const f0 = A.toNormalized(realItems[0]);
  check('U-4 FIELD_MAP 실 이름: auctn_seq·spm_no·trd_se·corp_gds_*·mdfcn_dt', f0.source_id === realItems[0].auctn_seq && f0.shipment_no === realItems[0].spm_no && f0.trade_type === realItems[0].trd_se
    && f0.corp_variety_name === realItems[0].corp_gds_vrty_nm && f0.source_modified_at === realItems[0].mdfcn_dt, f0);
  const legacy = JSON.parse(fs.readFileSync(path.join(mockDir, 'at_realtime_normal.json'), 'utf8')).response.body.items.item[0];
  check('U-5 옛 목업(auc_seq)도 경매번호로 읽음(기존 목업 테스트 유지)', A.toNormalized(legacy).source_id === legacy.auc_seq, A.toNormalized(legacy));
  const ctx = await norm.loadMappingContext(pool, { target: 'MARKET', on: '2026-11-24' });
  let n = norm.normalizeItems(ctx, A, realItems, { source: 'AT_REALTIME', marketCode: '110001' });
  // R-01: FIELD_MAP 이 auc_seq(틀린 이름)면 auction_seq 가 비어 키가 64자리 해시가 된다 → 이 모양 검사가 잡는다
  check('U-6 (R-01 잡는 검사) 실형식 행 source_row_key = 시장|정산일|법인|출하번호|경매순번, 원문 순번 보존',
    n.errors.length === 0 && n.rows.every((r) => KEY_RE.test(r.source_row_key)) && n.rows.every((r, i) => r.auction_seq === realItems[i].auctn_seq)
    && n.rows.some((r) => /^0/.test(r.auction_seq)), { err: n.errors, keys: n.rows.map((r) => r.source_row_key) });
  const legacyRows = norm.normalizeItems(ctx, A, [legacy], { source: 'MOCK', marketCode: '110001' }).rows;
  const crypto2 = require('crypto');
  const HF = ['trade_date', 'auction_at', 'market_code', 'market_name', 'corp_code', 'corp_name', 'item_l_code', 'item_m_code', 'item_s_code', 'item_name_raw', 'item_key', 'grade_code', 'grade_name', 'grade_norm', 'pkg_code', 'pkg_name', 'pkg_norm', 'size_code', 'size_name', 'unit_code', 'unit_name', 'unit_qty_kg', 'weight_source', 'qty', 'unit_price', 'origin_code', 'origin_name', 'shipper_name_masked', 'buyer_code', 'auction_seq'];
  const oldHash = crypto2.createHash('sha256').update(JSON.stringify(HF.map((k) => legacyRows[0][k] ?? null))).digest('hex');
  check('U-7 옛 목업 행 content_hash 는 예전 계산과 같음(배포 뒤 기존 행이 전부 정정으로 잡히지 않음)', legacyRows[0].content_hash === oldHash && legacyRows[0].source_row_key === legacy.auc_seq, legacyRows[0].source_row_key);
  const st = Object.fromEntries(n.rows.map((r) => [`${r.item_l_code}-${r.item_m_code}-${r.item_s_code}`, `${r.map_status}:${r.item_key || ''}`]));
  check('U-8 AC-53 코드 매핑(A 권고 기본값): 피망 IGNORED · 신미락 M8→청양 · 녹색→PAPRIKA.GREEN · 홍청양→RED · 키워드 대체 없음',
    st['13-02-02'] === 'IGNORED:' && st['12-05-M8'] === 'MAPPED:PEPPER.CHEONGYANG' && st['13-26-05'] === 'MAPPED:PAPRIKA.GREEN' && st['12-08-02'] === 'MAPPED:PEPPER.RED', st);
  const badItems = JSON.parse(fs.readFileSync(path.join(mockDir, 'at_real_badkey.json'), 'utf8')).response.body.items.item;
  n = norm.normalizeItems(ctx, A, badItems, { source: 'MOCK', marketCode: '110001' });
  check('U-9 자연키 값(spm_no) 빈 실형식 행 → 오류(해시 키로 넘기지 않음)', n.errors.length === 1 && n.errors[0].field === 'source_row_key', n.errors);
  const dd = norm.dedupeRows([{ source_row_key: 'a', source_modified_at: '2026-11-24T02:00:00+09:00', v: 2 }, { source_row_key: 'a', source_modified_at: '2026-11-24T01:00:00+09:00', v: 1 }]);
  check('U-10 한 작업 안 같은 키 → 원천 수정일시 늦은 행만(I B-3)', dd.dropped === 1 && dd.rows.length === 1 && dd.rows[0].v === 2, dd);
  // 점수 m2 — 실 경락만
  const tol = { price_pct_auto: 0, price_pct_review: 10, qty_pct_auto: 0, qty_pct_review: 20, amount_abs_auto: 0, date_before_auto: 1, date_after_auto: 0, auto_min_score: 85, ambiguity_margin: 10, auto_unique_no_id: true };
  const cand = (src, extra = {}) => ({ source: src, same_item: true, variety_unknown_one: false, same_grade: false, grade_both_null: false, grade_one_null: true, grade_not_in_source: src === 'AT_REALTIME',
    kg_known_both: true, same_kg: true, same_pkg: true, price_diff_pct: '0', qty_diff_pct: '0', qty_cmp: 0, date_diff: 0, corp_same: true, ident: null, trade_id: 1, ...extra });
  const line = { amount_calc_diff: 0, dup_other_doc: false, doc_corp_null: false };
  const cm = score.scoreCandidate(cand('MOCK'), line, tol);
  const cr = score.scoreCandidate(cand('AT_REALTIME'), line, tol);
  check('U-11 목업 후보는 m1 그대로(등급 한쪽 없음 → strict 실패·GRADE_UNKNOWN)', !cm.strict && cm.flags.includes('GRADE_UNKNOWN'), cm);
  check('U-12 실 경락 후보 R2: 등급 비교 안 함(strict 유지·GRADE_NOT_IN_SOURCE)', cr.strict && cr.flags.includes('GRADE_NOT_IN_SOURCE') && cr.score === 65, cr);
  let d = score.decide([{ ...cand('AT_REALTIME'), ...cr }], tol);
  check('U-13 R3 유일 후보(식별 0·65점) → EXACT UNIQUE_NO_ID', d.result === 'EXACT' && d.best.flags.includes('UNIQUE_NO_ID'), d);
  d = score.decide([{ ...cand('AT_REALTIME'), ...score.scoreCandidate(cand('AT_REALTIME'), line, tol) }], { ...tol, auto_unique_no_id: false });
  check('U-14 R3 스위치 끔 → PARTIAL LOW_SCORE', d.result === 'PARTIAL' && d.reasons.includes('LOW_SCORE'), d);
  const crm = score.scoreCandidate(cand('MOCK', { grade_one_null: false, grade_both_null: true }), line, tol);
  d = score.decide([{ ...cand('MOCK'), ...crm }], tol);
  check('U-15 목업 후보는 R3 안 씀(65점 → PARTIAL)', d.result === 'PARTIAL', d);
  const c2 = score.scoreCandidate(cand('AT_REALTIME', { trade_id: 2, price_diff_pct: '5' }), line, tol);
  d = score.decide([{ ...cand('AT_REALTIME'), ...cr }, { ...cand('AT_REALTIME', { trade_id: 2 }), ...c2 }], tol);
  check('U-16 R3: 범위 안 다른 후보가 있으면 자동 아님', d.result !== 'EXACT', d);
  const co = score.scoreCandidate(cand('AT_REALTIME', { price_outlier: true }), line, tol);
  check('U-17 R4 PRICE_OUTLIER → strict 실패', !co.strict && co.flags.includes('PRICE_OUTLIER'), co);

  // ================= M 실형식 목업(MOCK) =================
  const runCollect = async (date, phase, scenario, envx = {}) => withEnv({ AUCTION_SOURCE_MODE: 'mock', AUCTION_MOCK_CONTROL: 'true', ...envx }, async () => {
    const e = await queue.enqueue(pool, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: '110001', trade_date: date, phase, params: scenario ? { mock_scenario: scenario } : {}, dedupe_key: `T203RT:${date}:${phase}:${scenario}:${key()}` });
    const job = (await q(`UPDATE collect_job SET status = 'RUNNING', locked_by = $2, locked_at = NOW(), attempts = attempts + 1, started_at = COALESCE(started_at, NOW()) WHERE id = $1 RETURNING *`, [e.id, queue.INSTANCE]))[0]; // claim 과 같은 상태
    job.params = job.params || {};
    const r = await worker.runJob(pool, job);
    const j = (await q(`SELECT status, last_error_kind, result FROM collect_job WHERE id = $1`, [e.id]))[0];
    return { r, j };
  });
  const D1 = '2025-01-03'; const D2 = '2025-01-13'; const D3 = '2025-01-23'; const D4 = '2025-02-02';
  await q(`DELETE FROM auction_trade_history WHERE trade_id IN (SELECT id FROM auction_trade WHERE source = 'MOCK' AND trade_date = ANY($1::date[]))`, [[D1, D2, D3, D4]]);
  await q(`DELETE FROM auction_trade WHERE source = 'MOCK' AND trade_date = ANY($1::date[]) AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.trade_id = auction_trade.id)`, [[D1, D2, D3, D4]]);
  const mrows = async (date) => q(`SELECT *, trade_date::text td FROM auction_trade WHERE source = 'MOCK' AND trade_date = $1 ORDER BY source_row_key`, [date]);
  let x = await runCollect(D1, 'FINAL', 'real');
  let rows = await mrows(D1);
  check('M-1 실형식 목업 저장 12행·피망 1행 IGNORED·자연키 모양·출하번호·매매방법·원천 수정일시 저장',
    x.r.status === 'DONE' && rows.length === 12 && rows.filter((r) => r.map_status === 'IGNORED').length === 1 && rows.every((r) => KEY_RE.test(r.source_row_key) && r.shipment_no && r.trade_type && r.source_modified_at)
    && x.j.result.ignored === 1, { st: x.r.status, n: rows.length, res: x.j.result });
  const out = rows.find((r) => Number(r.unit_price) >= 1000000);
  check('M-2 AC-51 이상 단가 행은 원문 그대로 저장(2,852,000원)', out && Number(out.unit_price) === 2852000, out && out.unit_price);
  const pal = rows.find((r) => r.pkg_code === '107');
  check('M-3 파렛트 행 kg·단가 그대로(qty×unit_qty_kg)', pal && Number(pal.weight_kg) === Number(pal.qty) * Number(pal.unit_qty_kg), pal && { q: pal.qty, kg: pal.unit_qty_kg, w: pal.weight_kg });
  x = await runCollect(D1, 'FINAL', 'real');
  check('M-4 AC-44 같은 응답 재수집 → inserted 0·updated 0·unchanged 12', x.j.result.inserted === 0 && x.j.result.updated === 0 && x.j.result.unchanged === 12, x.j.result);
  const before = Object.fromEntries((await mrows(D1)).map((r) => [r.source_row_key, r]));
  x = await runCollect(D1, 'FINAL', 'real_revised');
  const after = Object.fromEntries((await mrows(D1)).map((r) => [r.source_row_key, r]));
  const ks = Object.keys(before).sort((a, b) => a.localeCompare(b));
  const items0 = realItems.map((it) => `110001|${D1}|${it.corp_cd}|${it.spm_no}|${it.auctn_seq}`);
  const [k0, k1, k2, k3] = items0;
  const h1 = await q(`SELECT COUNT(*)::int n FROM auction_trade_history WHERE trade_id = $1`, [after[k1].id]);
  check('M-5 AC-45 ① 원천 수정일시만 늦게 → revision 그대로·수정일시 갱신', after[k0].revision === before[k0].revision && new Date(after[k0].source_modified_at) > new Date(before[k0].source_modified_at),
    { b: before[k0] && before[k0].source_modified_at, a: after[k0] && after[k0].source_modified_at });
  check('M-6 AC-45 ② 단가 변경 + 수정일시 늦게 → revision+1·history 1행', after[k1].revision === before[k1].revision + 1 && Number(after[k1].unit_price) === Number(before[k1].unit_price) + 1000 && h1[0].n === 1,
    { rev: after[k1].revision, p: after[k1].unit_price, h: h1[0].n });
  check('M-7 AC-45 ③ 단가 변경 + 수정일시 이르게 → 덮어쓰지 않음·STALE_ROW 1', after[k2].revision === before[k2].revision && after[k2].unit_price === before[k2].unit_price && x.j.result.stale_rows === 1,
    { rev: after[k2].revision, res: x.j.result });
  check('M-8 AC-45 ④ 빠진 행 → withdrawn_at(1건)', after[k3].withdrawn_at && x.j.result.withdrawn === 1, x.j.result);
  check('M-9 수집 결과 경고 문구에 STALE_ROW 표시', /STALE_ROW 1/.test((await q(`SELECT verify_warning FROM collect_snapshot WHERE id = $1`, [x.j.result.snapshot_id]))[0].verify_warning || ''), x.j.result.snapshot_id);
  check('M-10 키 개수 그대로(정정이 새 행을 만들지 않음 — R-01 증상 없음)', Object.keys(after).length === ks.length, Object.keys(after).length);
  x = await runCollect(D2, 'FINAL', 'real_dupkey');
  rows = await mrows(D2);
  const dupRow = rows.find((r) => r.source_row_key === `110001|${D2}|${realItems[1].corp_cd}|${realItems[1].spm_no}|${realItems[1].auctn_seq}`);
  check('M-11 한 응답에 같은 키 두 번 → 1행·늦은 값·dup_dropped 1', x.r.status === 'DONE' && rows.length === 12 && Number(dupRow.unit_price) === Number(realItems[1].scsbd_prc) + 2000 && x.j.result.dup_dropped === 1, x.j.result);
  x = await runCollect(D3, 'FINAL', 'real_badkey');
  check('M-12 자연키 값 없는 행 → 작업 BAD_RESPONSE·저장 0', x.j.last_error_kind === 'BAD_RESPONSE' && (await mrows(D3)).length === 0, x.j);
  await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE trade_date = $1 AND status = 'QUEUED'`, [D3]);
  await q(`UPDATE ext_circuit_state SET state = 'CLOSED', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL, disabled_reason = NULL, disabled_until = NULL`);
  x = await runCollect(D4, 'FINAL', 'real_paged', { AUCTION_PAGE_SIZE: '7' });
  check('M-13 쪽 나눔(2쪽) → 12행·pages 2', x.r.status === 'DONE' && (await mrows(D4)).length === 12 && x.j.result.pages === 2, x.j.result);

  // ================= R 재생(REPLAY) — 실호출 원문 =================
  const RD = '2026-11-24'; const RD2 = '2026-11-25';
  const haveFinal = (await q(`SELECT 1 FROM collect_snapshot WHERE source = 'AT_REALTIME' AND trade_date = $1 AND phase = 'FINAL' AND status = 'COMPLETE' AND is_latest_ok`, [RD]))[0];
  const runReplay = async (date, phase, envx = {}) => withEnv({ AUCTION_SOURCE_MODE: 'replay', ...envx }, async () => {
    const e = await queue.enqueue(pool, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: '110001', trade_date: date, phase, params: {}, dedupe_key: `T203RP:${date}:${phase}:${key()}` });
    const job = (await q(`UPDATE collect_job SET status = 'RUNNING', locked_by = $2, locked_at = NOW(), attempts = attempts + 1, started_at = COALESCE(started_at, NOW()) WHERE id = $1 RETURNING *`, [e.id, queue.INSTANCE]))[0]; // claim 과 같은 상태
    job.params = job.params || {};
    await worker.runJob(pool, job);
    return (await q(`SELECT status, last_error_kind, last_error, result FROM collect_job WHERE id = $1`, [e.id]))[0];
  });
  if (!haveFinal) {
    const j1 = await runReplay(RD, 'FINAL');
    check('R-1 AC-42 재생 2026-11-24 FINAL: 5조합·2,002행(=2,009−건고추2−고추잎5)·IGNORED 185·UNMAPPED 0·COMPLETE',
      j1.status === 'DONE' && j1.result.source_mode === 'REPLAY' && j1.result.inserted === 2002 && j1.result.ignored === 185 && j1.result.unmapped === 0 && j1.result.pages === 5 && j1.result.snapshot === 'COMPLETE', j1);
    const j2 = await runReplay(RD2, 'INTRADAY');
    check('R-2 AC-43 재생 2026-11-25: 1,983행·IGNORED 246', j2.status === 'DONE' && j2.result.inserted === 1983 && j2.result.ignored === 246, j2);
  } else console.log(`[t203-realapi-test] ${RD} 실수집 데이터가 이미 있어 재생 수집은 건너뜀(저장 결과만 검사)`);
  const cnt = await q(`SELECT trade_date::text d, COUNT(*)::int n, COUNT(*) FILTER (WHERE map_status = 'IGNORED')::int ig, COUNT(*) FILTER (WHERE map_status = 'UNMAPPED')::int un,
                         COUNT(*) FILTER (WHERE source_row_key !~ '^[0-9]{6}\\|[0-9]{4}-[0-9]{2}-[0-9]{2}\\|[0-9]{8}\\|[^|]+\\|[^|]+$')::int badkey, MAX(revision) mr
                         FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date IN ($1, $2) GROUP BY 1 ORDER BY 1`, [RD, RD2]);
  check('R-3 저장 결과 11/24 2,002·11/25 1,983, 자연키 모양 위반 0, revision 1(재수집이 새 행·정정을 만들지 않음)',
    cnt.length === 2 && cnt[0].n === 2002 && cnt[1].n === 1983 && cnt.every((c) => c.badkey === 0 && c.un === 0 && Number(c.mr) === 1), cnt);
  const dupNat = await q(`SELECT COUNT(*)::int n FROM (SELECT 1 FROM auction_trade WHERE source = 'AT_REALTIME' AND shipment_no IS NOT NULL GROUP BY market_code, trade_date, corp_code, shipment_no, auction_seq HAVING COUNT(*) > 1) z`);
  check('R-4 I 030 확인 SQL ① 자연키 중복 0', dupNat[0].n === 0, dupNat);
  const dist = await q(`SELECT item_key, COUNT(*)::int n FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND map_status = 'MAPPED' GROUP BY 1`, [RD]);
  const dm = Object.fromEntries(dist.map((r) => [r.item_key, r.n]));
  check('R-5 AC-53 11/24 품목별 건수 = A 2.2 표(청양 459·일반 128·오이 211·꽈리 230·홍 183·빨강 324·노랑 201·주황 17·녹색 18·색모름 46)',
    dm['PEPPER.CHEONGYANG'] === 459 && dm['PEPPER.GENERAL'] === 128 && dm['PEPPER.OI'] === 211 && dm['PEPPER.KKWARI'] === 230 && dm['PEPPER.RED'] === 183
    && dm['PAPRIKA.RED'] === 324 && dm['PAPRIKA.YELLOW'] === 201 && dm['PAPRIKA.ORANGE'] === 17 && dm['PAPRIKA.GREEN'] === 18 && dm['PAPRIKA._'] === 46, dm);
  const nh10 = await q(`SELECT COUNT(*)::int n FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND corp_code = '11000102' AND auction_seq = '10'`, [RD]);
  check('R-6 농협가락 순번 "10" 여러 건이 덮어쓰이지 않고 따로 저장(R-01·D-1)', nh10[0].n > 50, nh10);
  // 철회 범위(R-04): 12-06 조합만, 한 행 뺀 재생 파일 → 철회 1건(다른 조합 행은 그대로)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't203rp-'));
  const src = JSON.parse(fs.readFileSync(path.join(ad.REPLAY_DIR, `${RD}_12-06_p1.json`), 'utf8'));
  const removed = src.response.body.items.item.pop();
  src.response.body.totalCount -= 1;
  fs.writeFileSync(path.join(tmp, `${RD}_12-06_p1.json`), JSON.stringify(src));
  const wdBefore = (await q(`SELECT COUNT(*)::int n FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND withdrawn_at IS NOT NULL`, [RD]))[0].n;
  const j3 = await runReplay(RD, 'FINAL', { AUCTION_ITEM_COMBOS: '12-06', AUCTION_REPLAY_DIR: tmp });
  const wd = await q(`SELECT item_m_code, COUNT(*)::int n FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND withdrawn_at IS NOT NULL GROUP BY 1`, [RD]);
  check('R-7 (R-04) 중분류 하나만 부른 FINAL → 그 조합 안에서만 철회 1건(다른 조합 1,772행 철회 안 됨)',
    j3.status === 'DONE' && j3.result.withdrawn === 1 && wd.length === 1 && wd[0].item_m_code === '06' && wd[0].n === wdBefore + 1, { j3: j3.result, wd });
  // 되돌림 — 원래 재생 파일로 12-06 다시 → 철회 풀림
  const j4 = await runReplay(RD, 'FINAL', { AUCTION_ITEM_COMBOS: '12-06' });
  const back = await q(`SELECT withdrawn_at FROM auction_trade WHERE source = 'AT_REALTIME' AND source_row_key = $1`, [`110001|${RD}|${removed.corp_cd}|${removed.spm_no}|${removed.auctn_seq}`]);
  check('R-8 다시 보인 행 → 철회 표시 지움', j4.status === 'DONE' && back[0] && back[0].withdrawn_at === null, { j4: j4.result, back });
  fs.rmSync(tmp, { recursive: true, force: true });
  // 최신 FINAL 이 12-06 하나만이면 다음 대조의 base_final 판단은 같음(날짜 단위) — 전체 조합으로 한 번 더 받아 최신 스냅샷을 원래대로
  await runReplay(RD, 'FINAL');

  // ================= S 보안·운영 경고 (B 20261125-1430 — C-RA-01·O1) =================
  // 키는 가짜 값만 쓴다(실 키 읽지 않음). 실호출 0 — fetch 는 이 프로세스 안에서 잠깐 가짜로 바꾼다
  const FAKE = 'T203fakeKEY+/0123456789abcdef==';
  const FAKE_ENC = encodeURIComponent(FAKE);
  const hasKey = (v) => { const t = typeof v === 'string' ? v : JSON.stringify(v); return t.includes(FAKE) || t.includes(FAKE_ENC); };
  {
    // S-1 원천 로그 저장 지점(worker.logRaw) 자체가 가리는지 — 어댑터를 거치지 않은(가리지 않은) 결과가 와도 본문·URL 에 키가 남지 않음
    const e = await queue.enqueue(pool, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: '110001', trade_date: '2025-03-05', phase: 'FINAL', params: {}, dedupe_key: `T203S1:${key()}` });
    const rawBody = `{"response":{"header":{"resultCode":"30","resultMsg":"SERVICE KEY IS NOT REGISTERED ERROR. serviceKey=${FAKE_ENC}&x=1 echo ${FAKE}"}}}`;
    const rawId = await withEnv({ AT_AUCTION_API_KEY: FAKE }, () => worker.logRaw(pool, { id: e.id }, 'AT_REALTIME',
      { kind: 'AUTH_ERROR', httpStatus: 200, pageNo: 1, rawBody, requestUrlMasked: `https://x.invalid/trades2?serviceKey=${FAKE_ENC}&pageNo=1`, requestParams: {} }));
    const rr = (await q(`SELECT body, request_url_masked, body_hash FROM ext_raw_response WHERE id = $1`, [rawId]))[0];
    let parsedOk = true; try { JSON.parse(rr.body); } catch { parsedOk = false; }
    check('S-1 C-RA-01 원천 로그 저장 전 본문·URL 의 키(원문·인코딩) 가림 — **** 로 바뀌고 JSON 구조 유지·해시는 받은 원문 기준',
      !hasKey(rr) && rr.body.includes('****') && parsedOk && rr.body_hash === crypto.createHash('sha256').update(rawBody).digest('hex'), { body: rr.body, url: rr.request_url_masked, parsedOk });
    await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1`, [e.id]);
  }
  {
    // S-2 LIVE 어댑터 → 워커 전체 경로: 원격이 오류 응답(resultMsg·본문)에 키를 되돌려 줌 → 원천 로그·작업 오류·실패 스냅샷·어댑터 결과 어디에도 키 없음
    const SD = '2025-03-07';
    const fakeFetch = async () => ({ ok: true, status: 200, headers: { get: () => null, forEach() {} },
      text: async () => JSON.stringify({ response: { header: { resultCode: '99', resultMsg: `echo ${FAKE} serviceKey=${FAKE_ENC}` }, body: {} } }) });
    const A = ad.createAdapter('AT_REALTIME', { fetchImpl: fakeFetch }, { AT_AUCTION_API_KEY: FAKE });
    const ar = await A.fetchPage({ tradeDate: SD, marketCode: '110001', pageNo: 1, itemL: '12', itemM: '06' });
    check('S-2a 어댑터 결과 객체(rawBody·message)에 키 없음 — 오류 분류는 그대로(SERVER_ERROR)', A.mode === 'LIVE' && ar.kind === 'SERVER_ERROR' && !hasKey(ar), { kind: ar.kind, mode: A.mode });
    const realFetch = globalThis.fetch;
    let jr;
    const e = await queue.enqueue(pool, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: '110001', trade_date: SD, phase: 'FINAL', params: {}, dedupe_key: `T203S2:${key()}` });
    try {
      globalThis.fetch = fakeFetch;
      jr = await withEnv({ AUCTION_SOURCE_MODE: null, AT_AUCTION_API_KEY: FAKE, AUCTION_ITEM_COMBOS: '12-06' }, async () => {
        const job = (await q(`UPDATE collect_job SET status = 'RUNNING', locked_by = $2, locked_at = NOW(), attempts = attempts + 1, started_at = COALESCE(started_at, NOW()) WHERE id = $1 RETURNING *`, [e.id, queue.INSTANCE]))[0];
        job.params = job.params || {};
        await worker.runJob(pool, job);
        return (await q(`SELECT status, last_error_kind, last_error, result FROM collect_job WHERE id = $1`, [e.id]))[0];
      });
    } finally { globalThis.fetch = realFetch; }
    const raws = await q(`SELECT source, body, request_url_masked FROM ext_raw_response WHERE job_id = $1`, [e.id]);
    const snaps = await q(`SELECT error_kind, error_message FROM collect_snapshot WHERE job_id = $1`, [e.id]);
    check('S-2b C-RA-01 워커 경로(LIVE·가짜 fetch): 원천 로그 본문·URL, 작업 last_error, 실패 스냅샷 오류 문구에 키 없음',
      raws.length >= 1 && raws.every((r) => r.source === 'AT_REALTIME') && !hasKey(raws) && !hasKey(jr) && snaps.length >= 1 && !hasKey(snaps) && jr.last_error_kind === 'SERVER_ERROR',
      { raws: raws.length, kind: jr && jr.last_error_kind, snaps: snaps.length, leak: hasKey(raws) || hasKey(jr) || hasKey(snaps) });
    await q(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1 AND status = 'QUEUED'`, [e.id]);
    await q(`UPDATE ext_circuit_state SET state = 'CLOSED', consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL, disabled_reason = NULL, disabled_until = NULL`);
  }
  {
    // S-3·4 O1: 실 소스(REPLAY)인데 AT 코드 매핑 규칙이 0행 → 수집은 그대로(DONE·COMPLETE), 스냅샷 경고 + 결과 표시. 시드가 있으면 경고 없음
    const OD = '2025-03-03';
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 't203o1-'));
    const src2 = JSON.parse(fs.readFileSync(path.join(ad.REPLAY_DIR, `${RD}_12-06_p1.json`), 'utf8'));
    for (const it of src2.response.body.items.item) it.trd_clcln_ymd = OD;
    fs.writeFileSync(path.join(tmp2, `${OD}_12-06_p1.json`), JSON.stringify(src2));
    const n06 = src2.response.body.items.item.length;
    const off = await q(`UPDATE item_mapping SET active = false WHERE source = 'AT_REALTIME' AND active RETURNING id`);
    let o1;
    try {
      o1 = await runReplay(OD, 'FINAL', { AUCTION_ITEM_COMBOS: '12-06', AUCTION_REPLAY_DIR: tmp2 });
    } finally {
      await q(`UPDATE item_mapping SET active = true WHERE id = ANY($1::bigint[])`, [off.map((r) => r.id)]);
    }
    const sn1 = (await q(`SELECT status, verify_warning FROM collect_snapshot WHERE id = $1`, [o1.result && o1.result.snapshot_id]))[0] || {};
    check('S-3 O1 매핑 시드 0행 + 실 소스(REPLAY) → 수집 막지 않음(DONE·COMPLETE·전부 UNMAPPED) + 스냅샷 경고 "분류 코드 매핑 시드 없음 — seed-at-realtime-mapping.js 실행"',
      off.length >= 21 && o1.status === 'DONE' && o1.result.snapshot === 'COMPLETE' && o1.result.mapping_seed_missing === true && o1.result.unmapped === n06
      && String(sn1.verify_warning || '').includes(worker.SEED_MISSING_WARNING), { off: off.length, r: o1.result, sn1 });
    const o2 = await runReplay(OD, 'FINAL', { AUCTION_ITEM_COMBOS: '12-06', AUCTION_REPLAY_DIR: tmp2 });
    const sn2 = (await q(`SELECT verify_warning FROM collect_snapshot WHERE id = $1`, [o2.result && o2.result.snapshot_id]))[0] || {};
    check('S-4 O1 시드가 있으면 경고 없음(mapping_seed_missing 없음·스냅샷 경고에 문구 없음)',
      o2.status === 'DONE' && !('mapping_seed_missing' in o2.result) && !String(sn2.verify_warning || '').includes(worker.SEED_MISSING_WARNING), { r: o2.result, sn2 });
    fs.rmSync(tmp2, { recursive: true, force: true });
    // 정리 — 이 날짜 실형식 행은 다른 검사에 안 쓰임(재실행 대비 지움)
    await q(`DELETE FROM auction_trade_history WHERE trade_id IN (SELECT id FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1)`, [OD]);
    await q(`DELETE FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.trade_id = auction_trade.id)`, [OD]);
  }

  // ================= D 대조 m2 (API) =================
  const mkUser = async (name, agent) => {
    const pw = crypto.randomBytes(12).toString('hex');
    const id = (await q(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at, status) VALUES ($1,$2,$3,$4,NOW(),'active') RETURNING id`, [name, `${agent}@test.local`, agent, await bcrypt.hash(pw, 8)]))[0].id;
    const tok = (await api('POST', '/api/auth/login', { agent_no: agent, password: pw })).json?.token;
    if (!tok) throw new Error('로그인 실패');
    return { id, tok };
  };
  const O = await mkUser(`실API대조 ${tag}`, `rt_${tag}`);
  const T = O.tok;
  const partner = async (name) => (await api('POST', '/api/partners', { name, type: 'supplier' }, T)).json?.data?.id;
  const PS = await partner(`서울청과 ${tag}`); const PN = await partner(`농협가락 ${tag}`); const PK = await partner(`한국청과 ${tag}`);
  let r = await api('PUT', '/api/auction/corp-links', { links: [{ corp_code: '11000101', partner_id: PS }, { corp_code: '11000102', partner_id: PN }, { corp_code: '11000105', partner_id: PK }] }, T);
  check('D-0 준비 법인 연결 3건(서울청과·농협가락·한국청과)', r.status === 200, r.json);
  const prod = async (name) => (await q(`SELECT id FROM product WHERE owner_user_id IS NULL AND name = $1`, [name]))[0];
  const P = { 청양: await prod('청양고추'), 꽈리: await prod('꽈리고추'), 홍: await prod('홍고추'), 오이: await prod('오이고추'), 적: await prod('빨강 파프리카'), 황: await prod('노랑 파프리카'), 녹: await prod('초록 파프리카') };
  r = await api('PUT', '/api/auction/product-links', { links: [
    { item_key: 'PEPPER.CHEONGYANG', product_id: P.청양.id }, { item_key: 'PEPPER.KKWARI', product_id: P.꽈리.id }, { item_key: 'PEPPER.RED', product_id: P.홍.id },
    { item_key: 'PEPPER.OI', product_id: P.오이.id }, { item_key: 'PEPPER.GENERAL', product_id: P.청양.id }, { item_key: 'PAPRIKA.RED', product_id: P.적.id },
    { item_key: 'PAPRIKA.YELLOW', product_id: P.황.id }, { item_key: 'PAPRIKA.GREEN', product_id: (P.녹 || P.황).id }] }, T);
  check('D-0 준비 품목 연결 8건', r.status === 200, r.json);
  const NAME = { 'PEPPER.CHEONGYANG': '청양고추', 'PEPPER.RED': '홍고추', 'PEPPER.OI': '오이고추', 'PEPPER.GENERAL': '풋고추', 'PEPPER.KKWARI': '꽈리고추', 'PAPRIKA.RED': '빨강 파프리카', 'PAPRIKA.YELLOW': '노랑 파프리카' };
  const doc = async (pid, lines) => {
    const rr = await api('POST', '/api/purchase-docs', { supplier_partner_id: pid, doc_no: `RT-${key()}`, lines }, T, { 'idempotency-key': key() });
    return { rr, line: rr.json?.data?.docs?.[0]?.lines?.[0] };
  };
  const lineOf = (t, extra = {}) => ({ trade_date: RD, item_name: NAME[t.item_key], spec: `${Number(t.unit_qty_kg)}kg 상자`, qty: Number(t.qty), unit_price: Number(t.unit_price), ...extra });
  const dbLine = async (id) => (await q(`SELECT status, match_result, match_score, warning_flags, reason_codes, best_trade_id FROM purchase_doc_line WHERE id = $1`, [id]))[0];
  const runVer = async (id) => (await q(`SELECT r.engine_version FROM purchase_doc_line l JOIN purchase_match_run r ON r.id = l.last_run_id WHERE l.id = $1`, [id]))[0];

  // AC-46 출하번호 + 경매번호
  const t46 = (await q(`SELECT * FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND corp_code = '11000101' AND shipment_no = '20582' AND auction_seq = '324900'`, [RD]))[0];
  let o = await doc(PS, [{ trade_date: RD, item_name: '오이고추', spec: '7kg 상자', qty: 1, unit_price: 8400, shipment_ref: '20582', auction_ref: '324900' }]);
  let L = o.line && await dbLine(o.line.id);
  check('D-1 AC-46 서울청과 오이고추 7kg 1상자 8,400원 출하 20582·경매 324900 → EXACT·식별 35·자동 매입 등록·GRADE_NOT_IN_SOURCE·엔진 m2',
    t46 && o.rr.status === 201 && o.line.status === 'CONVERTED' && L.best_trade_id === t46.id && Number(L.match_score) >= 85 && L.warning_flags.includes('GRADE_NOT_IN_SOURCE') && (await runVer(o.line.id)).engine_version === 'm2',
    { st: o.rr.status, line: o.line, L });
  const pur = o.line && (await q(`SELECT p.total_amount FROM purchase p JOIN purchase_doc_conversion c ON c.purchase_id = p.id WHERE c.line_id = $1 AND c.status = 'ACTIVE'`, [o.line.id]))[0];
  check('D-2 AC-46 매입 1건 8,400원', pur && Number(pur.total_amount) === 8400, pur);

  // 유일 후보 고르기(AC-47·50): 연결한 법인 3곳, 10kg·5kg(품목 단위 10kg 로 딱 나뉨), 연결된 품목, 같은 법인·같은 품목군 범위(−3~+1일) 안에 kg 단가 ±11% 인 다른 경락 없음, 이상 단가 아님
  const uniqSql = `
    SELECT t.* FROM auction_trade t
     WHERE t.source = 'AT_REALTIME' AND t.trade_date = $1 AND t.corp_code IN ('11000101','11000102','11000105') AND t.map_status = 'MAPPED' AND t.withdrawn_at IS NULL
       AND t.unit_qty_kg IN (10, 5) AND t.item_key IN ('PEPPER.CHEONGYANG','PEPPER.RED','PEPPER.OI','PAPRIKA.RED','PAPRIKA.YELLOW') AND t.shipment_no IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM purchase_doc_conversion c WHERE c.trade_id = t.id AND c.status = 'ACTIVE')
       AND t.price_per_kg BETWEEN (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY m.price_per_kg) FROM auction_trade m WHERE m.source = 'AT_REALTIME' AND m.trade_date = t.trade_date AND m.item_key = t.item_key) / 10
                              AND (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY m.price_per_kg) FROM auction_trade m WHERE m.source = 'AT_REALTIME' AND m.trade_date = t.trade_date AND m.item_key = t.item_key) * 10 -- 이상 단가 아님
       AND NOT EXISTS (SELECT 1 FROM auction_trade o WHERE o.id <> t.id AND o.source = 'AT_REALTIME' AND o.corp_code = t.corp_code AND o.withdrawn_at IS NULL AND o.map_status = 'MAPPED'
             AND o.trade_date BETWEEN t.trade_date - 3 AND t.trade_date + 1 AND split_part(o.item_key, '.', 1) = split_part(t.item_key, '.', 1)
             AND (o.item_key = t.item_key OR right(o.item_key, 2) = '._')
             AND ABS(o.price_per_kg - t.price_per_kg) <= o.price_per_kg * 0.11)
     ORDER BY t.id LIMIT 3`;
  const uniq = await q(uniqSql, [RD]);
  check('D-3 준비: 유일 후보 경락 3건 찾음', uniq.length === 3, uniq.length);
  const PID = { '11000101': PS, '11000102': PN, '11000105': PK };
  o = await doc(PID[uniq[0].corp_code], [lineOf(uniq[0])]);
  L = o.line && await dbLine(o.line.id);
  check('D-4 AC-47 번호 없는 줄·유일 후보 → EXACT UNIQUE_NO_ID(점수 ≤65 기록)·자동 매입 등록', o.line && o.line.status === 'CONVERTED' && L.match_result === 'EXACT' && L.warning_flags.includes('UNIQUE_NO_ID') && Number(L.match_score) <= 65,
    { line: o.line, L });
  o = await doc(PID[uniq[1].corp_code], [lineOf(uniq[1], { grade: '특' })]);
  L = o.line && await dbLine(o.line.id);
  check('D-5 AC-50 매입서 등급 "특" + 등급 없는 실 경락 → 등급 때문에 막히지 않음(EXACT)', o.line && L.match_result === 'EXACT' && !L.warning_flags.includes('GRADE_DIFF'), { line: o.line, L });
  r = await api('PUT', '/api/purchase-match/tolerances', { auto_unique_no_id: false }, T);
  check('D-6 R-114 유일 후보 자동 끄기 저장', r.status === 200 && r.json.data.auto_unique_no_id === false, r.json);
  o = await doc(PID[uniq[2].corp_code], [lineOf(uniq[2])]);
  L = o.line && await dbLine(o.line.id);
  check('D-7 AC-47b 스위치 끔 → 자동 등록 0·PARTIAL LOW_SCORE(사람 확정)', o.line && o.line.status !== 'CONVERTED' && L.match_result === 'PARTIAL' && L.reason_codes.includes('LOW_SCORE'), { line: o.line, L });
  r = await api('PUT', '/api/purchase-match/tolerances', { auto_unique_no_id: true }, T);
  r = await api('GET', '/api/purchase-match/tolerances', null, T);
  check('D-8 R-113 스위치 다시 켬 → 조회값 true', r.status === 200 && r.json.data.effective.auto_unique_no_id === true, r.json.data && r.json.data.effective);

  // AC-48 같은 값 경락 2건 이상 → HOLD MULTI_CANDIDATE → 수동 확정 → 취소 → 재대조 HOLD
  const multi = (await q(`SELECT t.* FROM auction_trade t WHERE t.source = 'AT_REALTIME' AND t.trade_date = $1 AND t.corp_code = '11000101' AND t.map_status = 'MAPPED' AND t.unit_qty_kg = 10
                           AND t.item_key IN ('PEPPER.CHEONGYANG','PEPPER.RED','PEPPER.OI')
                           AND (SELECT COUNT(*) FROM auction_trade o WHERE o.source = 'AT_REALTIME' AND o.trade_date = t.trade_date AND o.corp_code = t.corp_code AND o.item_key = t.item_key
                                  AND o.unit_qty_kg = t.unit_qty_kg AND o.unit_price = t.unit_price AND o.qty = t.qty AND o.withdrawn_at IS NULL) >= 2
                         ORDER BY t.id LIMIT 1`, [RD]))[0];
  o = await doc(PS, [lineOf(multi)]);
  L = o.line && await dbLine(o.line.id);
  check('D-9 AC-48 같은 값 경락 여러 건 → HOLD·MULTI_CANDIDATE·자동 0', multi && o.line && L.status === 'HOLD' && L.reason_codes.includes('MULTI_CANDIDATE'), { multi: multi && multi.id, L });
  const lv = async (id) => (await q(`SELECT version FROM purchase_doc_line WHERE id = $1`, [id]))[0].version;
  r = await api('POST', `/api/purchase-docs/lines/${o.line.id}/confirm`, { trade_id: Number(multi.id), version: await lv(o.line.id), accept_diff: true, reason: '법인 정산서 출하번호로 확인' }, T, { 'idempotency-key': key() });
  L = await dbLine(o.line.id);
  check('D-10 AC-48 주인이 후보 1건 수동 확정 → 매입 등록', r.status === 200 && L.status === 'CONVERTED', { st: r.status, j: r.json, L });
  r = await api('POST', `/api/purchase-docs/lines/${o.line.id}/cancel`, { reason: '검사 — 전환 취소' }, T, { 'idempotency-key': key() });
  const canc = (await q(`SELECT COUNT(*) FILTER (WHERE status = 'ACTIVE')::int a, COUNT(*)::int n FROM purchase_doc_conversion WHERE line_id = $1`, [o.line.id]))[0];
  check('D-11 AC-48 전환 취소 → 활성 전환 0(이중 매입 0)', r.status === 200 && canc.a === 0 && canc.n === 1, { st: r.status, j: r.json, canc });
  r = await api('POST', `/api/purchase-docs/lines/${o.line.id}/rematch`, {}, T, { 'idempotency-key': key() });
  L = await dbLine(o.line.id);
  check('D-12 AC-48 재대조 → 다시 HOLD MULTI_CANDIDATE', L.status === 'HOLD' && L.reason_codes.includes('MULTI_CANDIDATE'), { st: r.status, L });

  // AC-49 농협가락 경매번호 "10"만 → 후보는 순번 10 건만, 식별 점수 0·AUCTION_REF_WEAK
  const nh = (await q(`SELECT * FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND corp_code = '11000102' AND auction_seq = '10' AND map_status = 'MAPPED' AND unit_qty_kg IS NOT NULL AND item_key IN ('PEPPER.CHEONGYANG','PEPPER.RED','PEPPER.OI','PEPPER.GENERAL','PEPPER.KKWARI','PAPRIKA.RED','PAPRIKA.YELLOW') ORDER BY id LIMIT 1`, [RD]))[0];
  o = await doc(PN, [{ trade_date: RD, item_name: NAME[nh.item_key] || '청양고추', spec: `${Number(nh.unit_qty_kg)}kg 상자`, qty: Number(nh.qty), unit_price: Number(nh.unit_price), auction_ref: '10' }]);
  L = o.line && await dbLine(o.line.id);
  const cands = o.line ? await q(`SELECT c.trade_id, c.breakdown, t.auction_seq FROM purchase_match_candidate c JOIN auction_trade t ON t.id = c.trade_id WHERE c.line_id = $1`, [o.line.id]) : [];
  check('D-13 AC-49 농협 경매번호 "10"만 → 후보 전부 순번 10·식별 0점·AUCTION_REF_WEAK',
    cands.length >= 1 && cands.every((c) => c.auction_seq === '10' && Number(c.breakdown.ident) === 0) && L.warning_flags.includes('AUCTION_REF_WEAK'), { L, cands: cands.slice(0, 3) });

  // AC-51 이상 단가
  const ol = (await q(`SELECT * FROM auction_trade WHERE source = 'AT_REALTIME' AND trade_date = $1 AND corp_code = '11000105' AND unit_price >= 1000000 ORDER BY id LIMIT 1`, [RD]))[0];
  o = await doc(PK, [{ trade_date: RD, item_name: '꽈리고추', spec: `${Number(ol.unit_qty_kg)}kg 상자`, qty: Number(ol.qty), unit_price: Number(ol.unit_price) }]);
  L = o.line && await dbLine(o.line.id);
  check('D-14 AC-51 이상 단가 경락 → PRICE_OUTLIER·자동 등록 안 함', ol && o.line && o.line.status !== 'CONVERTED' && L.warning_flags.includes('PRICE_OUTLIER'), { L, ol: ol && ol.unit_price });

  // 원천에 개인명 칸 없음(AC-37 실데이터판)
  const pn = await q(`SELECT COUNT(*)::int n FROM auction_trade WHERE source = 'AT_REALTIME' AND (shipper_name_masked IS NOT NULL OR buyer_code IS NOT NULL)`);
  check('D-15 AC-37(실데이터) 실 경락 출하자·낙찰자 칸 전부 NULL', pn[0].n === 0, pn);
  const leak = await q(`SELECT COUNT(*)::int n FROM ext_raw_response WHERE request_url_masked ~* 'servicekey=[^*&]' OR body ~* 'servicekey=[^*&]'`);
  check('D-16 원천 로그 URL·본문에 serviceKey 값 없음(****)', leak[0].n === 0, leak);

  await pool.end();
  const fail = results.filter((x) => !x.ok).length;
  console.log(`\n[t203-realapi-test] ${results.length - fail}/${results.length} PASS${fail ? ` — FAIL ${fail}` : ''}`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[t203-realapi-test] 오류', e); process.exit(1); });
