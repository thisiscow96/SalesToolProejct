/**
 * T-203 순수 함수 단위 테스트 (B1-13) — DB·서버 없이 실행
 * 사용: server 폴더에서  node scripts/purchase-match-unit-test.js
 * 대상: 점수식·판정·결정적 배정, 단위 환산(품목 단위 kg), 키워드 정규화·매핑(AC-08), 규격 kg 파싱, 원 정수 검사, 마스킹,
 *       백오프, cron, 응답 분류(D 3.2 — 목업 파일), CSV(UTF-8·CP949), 목업 어댑터 시나리오, 경락 정규화(목업 normal·bad)
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.AUCTION_SOURCE_MODE = 'mock';
process.env.AUCTION_HTTP_TIMEOUT_MS = process.env.AUCTION_HTTP_TIMEOUT_MS || '200';

const N = require('../lib/purchase-match/normalize');
const S = require('../lib/purchase-match/score');
const { maskUrl, maskName, scrubSecrets } = require('../lib/auction/mask');
const { backoffSec } = require('../lib/auction/queue');
const { parseCron, latestSlot } = require('../lib/auction/scheduler');
const base = require('../lib/auction/adapters/base');
const { createAdapter, MockAdapter, AtRealtimeAdapter } = require('../lib/auction/adapters');
const norm = require('../lib/auction/normalizer');
const { parseCsv, decodeCsv } = require('../lib/purchase-match/doc-parse');
const { validateTolerance } = require('../lib/purchase-match/settings-routes');

const results = [];
async function t(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push(false);
    console.log(`FAIL ${name} — ${err.message}`);
  }
}

// 026 시드 키워드·등급(마이그레이션 파일 그대로 읽음 — 시드를 바꾸면 테스트도 따라감)
const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '026_market_collect.sql'), 'utf8');
const kwRules = [];
let id = 0;
for (const m of sql.matchAll(/\('BOTH',\s*'([^']+)',\s*'([A-Z._]+)',\s*(\d+)/g)) kwRules.push({ id: ++id, keyword_norm: m[1], item_key: m[2], priority: Number(m[3]) });
const gradeSql = sql.slice(sql.indexOf('INSERT INTO grade_alias'), sql.indexOf('ON CONFLICT (alias_norm)'));
const grades = new Map([...gradeSql.matchAll(/\('([^']+)', '(SPECIAL|HIGH|MID|LOW|OFF|NONE)'\)/g)].map((m) => [m[1], m[2]]));
const TOL = { price_pct_auto: '0', price_pct_review: '10', qty_pct_auto: '0', qty_pct_review: '20', amount_abs_auto: '0', date_before_auto: 1, date_after_auto: 0,
  date_before_review: 3, date_after_review: 1, auto_convert: true, auto_min_score: 85, ambiguity_margin: 10 };
const perfect = { ident: 'BUYER', same_item: true, variety_unknown_one: false, same_grade: true, grade_both_null: false, grade_one_null: false, kg_known_both: true,
  same_kg: true, same_pkg: true, price_diff_pct: '0.00', qty_diff_pct: '0.00', qty_cmp: 0, date_diff: 0, corp_same: true };
const LINE = { amount_calc_diff: '0', dup_other_doc: false, doc_corp_null: false };

(async () => {
  await t('키워드 시드 26행 읽음', () => assert.strictEqual(kwRules.length, 26));
  await t('normalizeKeyword 공백 제거·소문자', () => assert.strictEqual(N.normalizeKeyword(' 옐로 Paprika '), '옐로paprika'));
  // AC-08
  const exp = { 청양: 'PEPPER.CHEONGYANG', 청량고추: 'PEPPER.CHEONGYANG', 꽈리: 'PEPPER.KKWARI', 오이맛고추: 'PEPPER.OI', 녹광: 'PEPPER.GENERAL', 홍고추: 'PEPPER.RED',
    적파프리카: 'PAPRIKA.RED', '옐로 파프리카': 'PAPRIKA.YELLOW', 오렌지파프리카: 'PAPRIKA.ORANGE', 고추: 'PEPPER._' };
  for (const [name, key] of Object.entries(exp)) {
    // eslint-disable-next-line no-await-in-loop
    await t(`AC-08 '${name}' → ${key}`, () => assert.strictEqual((N.matchKeyword(N.nameCandidates(name), kwRules) || {}).item_key, key));
  }
  await t("AC-08 '청량초' → 미매핑", () => assert.strictEqual(N.matchKeyword(N.nameCandidates('청량초'), kwRules), null));
  await t("원천 '파프리카(적)' + 중분류 '파프리카' → PAPRIKA.RED", () => assert.strictEqual(N.matchKeyword(N.nameCandidates('파프리카(적)', '파프리카'), kwRules).item_key, 'PAPRIKA.RED'));
  await t("원천 '오이맛' + 중분류 '고추' → PEPPER.OI", () => assert.strictEqual(N.matchKeyword(N.nameCandidates('오이맛', '고추'), kwRules).item_key, 'PEPPER.OI'));
  await t("원천 '풋고추(일반)' → PEPPER.GENERAL", () => assert.strictEqual(N.matchKeyword(N.nameCandidates('풋고추(일반)', '고추'), kwRules).item_key, 'PEPPER.GENERAL'));
  await t("원천 '피망(청)' + '피망' → 미매핑", () => assert.strictEqual(N.matchKeyword(N.nameCandidates('피망(청)', '피망'), kwRules), null));
  await t('같은 길이면 priority 작은 것', () => assert.strictEqual(N.matchKeyword(['abcd'], [{ id: 1, keyword_norm: 'ab', item_key: 'X._', priority: 9 }, { id: 2, keyword_norm: 'cd', item_key: 'Y._', priority: 1 }]).item_key, 'Y._'));
  await t('코드 매핑: 더 구체적인 행(code_s) 우선', () => {
    const rules = [{ id: 1, code_m: '11', item_key: 'PEPPER._', priority: 100 }, { id: 2, code_m: '11', code_s: '01', item_key: 'PEPPER.CHEONGYANG', priority: 100 }];
    assert.strictEqual(N.matchCode({ m: '11', s: '01' }, rules).item_key, 'PEPPER.CHEONGYANG');
    assert.strictEqual(N.matchCode({ m: '11', s: '09' }, rules).item_key, 'PEPPER._');
  });
  await t('등급 별칭 13행·특/상품/등외', () => {
    assert.strictEqual(grades.size, 13);
    assert.strictEqual(N.normalizeGrade('특', grades), 'SPECIAL');
    assert.strictEqual(N.normalizeGrade(' 상품 ', grades), 'HIGH');
    assert.strictEqual(N.normalizeGrade('1등', grades), null);
  });
  // kg 파싱
  const specs = [['10kg 상자', '10.000', 'BOX'], ['5키로', '5.000', 'KG'], ['4kg/박스', '4.000', 'BOX'], ['500g 봉', '0.500', 'BAG'], ['5kg 망', '5.000', 'NET'], ['상자', null, 'BOX'], ['', null, null], ['2.5 kg', '2.500', 'KG']];
  for (const [s, kg, pkg] of specs) {
    // eslint-disable-next-line no-await-in-loop
    await t(`parseSpec('${s}') → ${kg} ${pkg}`, () => assert.deepStrictEqual(N.parseSpec(s), { kg, pkg }));
  }
  await t('품목 단위 kg: kg→1, 10kg→10, 500g→0.5, 상자→null', () => {
    assert.strictEqual(N.productUnitKg('kg'), '1.000');
    assert.strictEqual(N.productUnitKg('10kg'), '10.000');
    assert.strictEqual(N.productUnitKg('500g'), '0.500');
    assert.strictEqual(N.productUnitKg('상자'), null);
  });
  // 원 단위
  await t('readWon: 35,000 → 35000 / 35000.5 → NOT_INTEGER_WON / -1 → NOT_POSITIVE / 35000.00 → 35000', () => {
    assert.strictEqual(N.readWon('35,000').value, '35000');
    assert.strictEqual(N.readWon('35000.5').error, 'NOT_INTEGER_WON');
    assert.strictEqual(N.readWon(35000.5).error, 'NOT_INTEGER_WON');
    assert.strictEqual(N.readWon('-1').error, 'NOT_POSITIVE');
    assert.strictEqual(N.readWon('35000.00').value, '35000');
    assert.strictEqual(N.readWon(9999999).value, '9999999');
  });
  await t('readQty: 0 → NOT_POSITIVE, 1.2345 → 소수 4자리 오류, 12 → 12', () => {
    assert.strictEqual(N.readQty('0').error, 'NOT_POSITIVE');
    assert.strictEqual(N.readQty('1.2345').error, 'TOO_MANY_DECIMALS');
    assert.strictEqual(N.readQty(12).value, '12');
  });
  await t('decimalDiv 문자열 10진 (HALF_UP)', () => {
    assert.strictEqual(N.decimalDiv('10', 1, 3), '10.000');
    assert.strictEqual(N.decimalDiv('500', 1000, 3), '0.500');
    assert.strictEqual(N.decimalDiv('1', 3, 2), '0.33');
    assert.strictEqual(N.decimalDiv('2', 3, 2), '0.67');
  });
  await t('줄 지문: 같은 값 같은 해시, 수량 표기(12 vs 12.000) 같음', () => {
    const a = { trade_date: '2026-11-23', item_key: 'PEPPER.CHEONGYANG', qty: '12', unit_price: '38000' };
    assert.strictEqual(N.lineFingerprint(a), N.lineFingerprint({ ...a, qty: '12.000' }));
    assert.notStrictEqual(N.lineFingerprint(a), N.lineFingerprint({ ...a, unit_price: '38001' }));
  });
  // 마스킹
  await t('maskName: 출하자A → 출*A, 김민수 → 김*수, 홍길 → 홍*, 한 → *', () => {
    assert.strictEqual(maskName('출하자A'), '출*A');
    assert.strictEqual(maskName('김민수'), '김*수');
    assert.strictEqual(maskName('홍길'), '홍*');
    assert.strictEqual(maskName('한'), '*');
    assert.strictEqual(maskName(''), null);
  });
  await t('maskUrl: serviceKey 값 → **** (인코딩·대소문자)', () => {
    assert.strictEqual(maskUrl('https://x/y?serviceKey=AbC%2B123&pageNo=1'), 'https://x/y?serviceKey=****&pageNo=1');
    assert.strictEqual(maskUrl('a?ServiceKey=zz'), 'a?ServiceKey=****');
    assert.ok(!/s3cr3tKEY/.test(scrubSecrets('err s3cr3tKEYvalue here', ['s3cr3tKEYvalue'])));
  });
  // 백오프
  await t('백오프: 60s×2^(n−1)±20%, 최대 30분', () => {
    for (let n = 1; n <= 8; n += 1) {
      const b = Math.min(60 * 2 ** (n - 1), 1800);
      assert.strictEqual(backoffSec(n, () => 0), Math.round(b * 0.8));
      assert.strictEqual(backoffSec(n, () => 1), Math.round(b * 1.2));
    }
  });
  // cron
  await t('cron 5필드 파싱·형식 오류', () => {
    assert.ok(parseCron('0 4-12 * * *'));
    assert.ok(parseCron('*/15 0,12 * * 1-5'));
    assert.strictEqual(parseCron('0 25 * * *'), null);
    assert.strictEqual(parseCron('0 * * *'), null);
    assert.strictEqual(parseCron('x * * * *'), null);
  });
  await t('latestSlot: 0 11,16 * * * — 14:30 KST 면 11:00 슬롯', () => {
    const now = new Date(Date.parse('2026-11-24T14:30:00+09:00'));
    const s = latestSlot(parseCron('0 11,16 * * *'), now);
    assert.strictEqual(s.toISOString().slice(0, 16), '2026-11-24T11:00');
  });
  // 응답 분류
  const mock = (f) => fs.readFileSync(path.join(__dirname, '..', 'lib', 'auction', 'mock', f), 'utf8');
  await t('분류: auth.xml(200) → AUTH_ERROR, 401 → AUTH_ERROR', () => {
    assert.strictEqual(base.classifyHttp(200, mock('at_error_auth.xml')).kind, 'AUTH_ERROR');
    assert.strictEqual(base.classifyHttp(401, '').kind, 'AUTH_ERROR');
  });
  await t('분류: quota.xml → QUOTA, unknown(99) → SERVER_ERROR, 502 → SERVER_ERROR', () => {
    assert.strictEqual(base.classifyHttp(200, mock('at_error_quota.xml')).kind, 'QUOTA');
    assert.strictEqual(base.classifyHttp(200, mock('at_error_unknown.xml')).kind, 'SERVER_ERROR');
    assert.strictEqual(base.classifyHttp(502, mock('at_error_502.html')).kind, 'SERVER_ERROR');
  });
  await t('분류: 429 + Retry-After 120 → RATE_LIMIT 120초', () => {
    const c = base.classifyHttp(429, mock('at_error_429.json'), { 'retry-after': '120' });
    assert.strictEqual(c.kind, 'RATE_LIMIT');
    assert.strictEqual(c.retryAfterSec, 120);
  });
  await t('분류: normal → OK 15건, empty → EMPTY, JSON 깨짐 → BAD_RESPONSE', () => {
    assert.strictEqual(base.readStandardJson(JSON.parse(mock('at_realtime_normal.json'))).items.length, 15);
    assert.strictEqual(base.readStandardJson(JSON.parse(mock('at_realtime_empty.json'))).kind, 'EMPTY');
    assert.strictEqual(base.classifyHttp(200, '{not json').kind, 'BAD_RESPONSE');
  });
  await t('Retry-After HTTP 날짜', () => {
    const now = Date.parse('2026-11-24T00:00:00Z');
    assert.strictEqual(base.parseRetryAfter('Tue, 24 Nov 2026 00:02:00 GMT', now), 120);
  });
  // 목업 어댑터
  const run = async (scenario, pageNo = 1) => new MockAdapter(new AtRealtimeAdapter({ mode: 'MOCK' }), { scenario }).fetchPage({ tradeDate: '2026-11-23', marketCode: '110001', pageNo });
  for (const [sc, kind] of [['normal', 'OK'], ['empty', 'EMPTY'], ['auth', 'AUTH_ERROR'], ['auth401', 'AUTH_ERROR'], ['quota', 'QUOTA'], ['rate429', 'RATE_LIMIT'], ['5xx', 'SERVER_ERROR'], ['unknown', 'SERVER_ERROR'], ['timeout', 'TIMEOUT']]) {
    // eslint-disable-next-line no-await-in-loop
    await t(`목업 '${sc}' → ${kind}`, async () => assert.strictEqual((await run(sc)).kind, kind));
  }
  await t('목업 raw URL 에 키 값 없음(serviceKey=****)', async () => assert.ok(/serviceKey=\*\*\*\*/.test((await run('normal')).requestUrlMasked)));
  await t('목업 paged: 1쪽 10건·전체 15, 2쪽 5건', async () => {
    const p1 = await run('paged', 1);
    const p2 = await run('paged', 2);
    assert.strictEqual(p1.items.length, 10); assert.strictEqual(p1.totalCount, 15); assert.strictEqual(p2.items.length, 5);
  });
  await t('목업 날짜 바꾸기: 11-20 요청이면 trd_clcln_ymd 2026-11-20', async () => {
    const r = await new MockAdapter(new AtRealtimeAdapter({ mode: 'MOCK' }), { scenario: 'normal' }).fetchPage({ tradeDate: '2026-11-20', pageNo: 1 });
    assert.strictEqual(r.items[0].trd_clcln_ymd, '2026-11-20');
  });
  await t('시나리오 목록 a,b — 호출마다 다음 것', async () => {
    const a = new MockAdapter(new AtRealtimeAdapter({ mode: 'MOCK' }), { scenario: '5xx,normal' });
    assert.strictEqual((await a.fetchPage({ tradeDate: '2026-11-23' })).kind, 'SERVER_ERROR');
    assert.strictEqual((await a.fetchPage({ tradeDate: '2026-11-23' })).kind, 'OK');
  });
  await t('createAdapter: 키 없거나 mock 이면 MOCK', () => assert.strictEqual(createAdapter('AT_REALTIME').mode, 'MOCK'));
  // 경락 정규화
  const ctx = { codeRules: [], keywordRules: kwRules, grades, packRules: [], activeItems: new Set(kwRules.map((r) => r.item_key)) };
  await t('정규화 normal: 15행, 피망 1건 UNMAPPED, 고추 5종·파프리카 3종', async () => {
    const r = await run('normal');
    const n = norm.normalizeItems(ctx, new AtRealtimeAdapter({ mode: 'MOCK' }), r.items, { source: 'MOCK', marketCode: '110001' });
    assert.strictEqual(n.errors.length, 0);
    assert.strictEqual(n.rows.length, 15);
    assert.strictEqual(n.rows.filter((x) => x.map_status === 'UNMAPPED').length, 1);
    const keys = new Set(n.rows.filter((x) => x.item_key).map((x) => x.item_key));
    assert.deepStrictEqual([...keys].sort(), ['PAPRIKA.ORANGE', 'PAPRIKA.RED', 'PAPRIKA.YELLOW', 'PEPPER.CHEONGYANG', 'PEPPER.GENERAL', 'PEPPER.KKWARI', 'PEPPER.OI', 'PEPPER.RED']);
    const first = n.rows[0];
    assert.strictEqual(first.unit_qty_kg, '10.000');
    assert.strictEqual(first.weight_source, 'SOURCE');
    assert.strictEqual(first.grade_norm, 'SPECIAL');
    assert.strictEqual(first.shipper_name_masked, '출*A');
    assert.strictEqual(first.auction_at, '2026-11-23T01:12:05+09:00');
    assert.strictEqual(first.source_row_key, '20261123-00001');
  });
  await t('정규화 bad: 낙찰가 소수·수량 누락 → 오류 2건(저장 0건)', async () => {
    const r = await run('bad');
    const n = norm.normalizeItems(ctx, new AtRealtimeAdapter({ mode: 'MOCK' }), r.items, { source: 'MOCK', marketCode: '110001' });
    assert.strictEqual(n.errors.length, 2);
  });
  await t('정규화 content_hash: 같은 값 같은 해시, 단가 바뀌면 다름', async () => {
    const a = norm.normalizeItems(ctx, new AtRealtimeAdapter({ mode: 'MOCK' }), (await run('normal')).items, { source: 'MOCK', marketCode: '110001' }).rows;
    const b = norm.normalizeItems(ctx, new AtRealtimeAdapter({ mode: 'MOCK' }), (await run('revised')).items, { source: 'MOCK', marketCode: '110001' }).rows;
    assert.strictEqual(a[0].content_hash, b[0].content_hash);
    assert.notStrictEqual(a[2].content_hash, b[2].content_hash);
  });
  // 점수식
  await t('점수: 모두 일치 + 낙찰자 번호 = 90 strict', () => { const s = S.scoreCandidate(perfect, LINE, TOL); assert.strictEqual(s.score, 90); assert.ok(s.strict); });
  await t('점수: 경매번호 일치 = 100', () => assert.strictEqual(S.scoreCandidate({ ...perfect, ident: 'AUCTION' }, LINE, TOL).score, 100));
  await t('점수: 식별 근거 없음 = 65 (자동 최소 85 미달)', () => assert.strictEqual(S.scoreCandidate({ ...perfect, ident: null }, LINE, TOL).score, 65));
  await t('점수: 단가 +5%(자동 0·후보 10) → 6점·PRICE_DIFF·strict 아님', () => {
    const s = S.scoreCandidate({ ...perfect, price_diff_pct: '5.00' }, LINE, TOL);
    assert.strictEqual(s.breakdown.price, 6); assert.ok(!s.strict); assert.ok(s.flags.includes('PRICE_DIFF')); assert.ok(!s.out_of_range);
  });
  await t('점수: 단가 +12% → PRICE_OUT·범위 밖', () => { const s = S.scoreCandidate({ ...perfect, price_diff_pct: '12.00' }, LINE, TOL); assert.ok(s.flags.includes('PRICE_OUT')); assert.ok(s.out_of_range); });
  await t('점수: kg 다름 → UNIT_CONVERTED 5점·strict 아님', () => { const s = S.scoreCandidate({ ...perfect, same_kg: false }, LINE, TOL); assert.strictEqual(s.breakdown.pkg, 5); assert.ok(s.flags.includes('UNIT_CONVERTED')); assert.ok(!s.strict); });
  await t('점수: 날짜 −1(밤 경매) = 4점 strict / −2 = 2점 strict 아님', () => {
    assert.ok(S.scoreCandidate({ ...perfect, date_diff: -1 }, LINE, TOL).strict);
    const s = S.scoreCandidate({ ...perfect, date_diff: -2 }, LINE, TOL); assert.strictEqual(s.breakdown.date, 2); assert.ok(!s.strict);
  });
  await t('점수: 매입서 금액 ≠ 수량×단가 → AMOUNT_CALC_DIFF strict 아님', () => assert.ok(!S.scoreCandidate(perfect, { ...LINE, amount_calc_diff: '3000' }, TOL).strict));
  await t('점수: 다른 매입서 같은 줄 → strict 아님', () => assert.ok(!S.scoreCandidate(perfect, { ...LINE, dup_other_doc: true }, TOL).strict));
  await t('점수: 수량 매입서 < 경락 → QTY_PARTIAL 3점', () => assert.strictEqual(S.scoreCandidate({ ...perfect, qty_diff_pct: '50.00', qty_cmp: -1 }, LINE, TOL).breakdown.qty, 3));
  // 판정
  const c = (id, extra) => ({ trade_id: id, ...S.scoreCandidate({ ...perfect, ...extra }, LINE, TOL) });
  await t('판정: strict 1건 90점 → EXACT', () => assert.strictEqual(S.decide([c(1)], TOL).result, 'EXACT'));
  await t('판정: strict 2건 → PARTIAL MULTI_CANDIDATE', () => { const d = S.decide([c(1), c(2)], TOL); assert.strictEqual(d.result, 'PARTIAL'); assert.ok(d.reasons.includes('MULTI_CANDIDATE')); });
  await t('판정: 식별 근거 없는 같은 후보 2건 → PARTIAL MULTI_CANDIDATE', () => {
    const d = S.decide([c(1, { ident: null }), c(2, { ident: null })], TOL); assert.strictEqual(d.result, 'PARTIAL'); assert.ok(d.reasons.includes('MULTI_CANDIDATE'));
  });
  await t('판정: strict 1건이지만 점수 65 → LOW_SCORE', () => assert.ok(S.decide([c(1, { ident: null })], TOL).reasons.includes('LOW_SCORE')));
  await t('판정: 1·2위 간격 < 10 → AMBIGUOUS', () => { const d = S.decide([c(1), c(2, { grade_one_null: true, same_grade: false })], TOL); assert.ok(d.reasons.includes('AMBIGUOUS')); });
  await t('판정: 후보가 모두 범위 밖 → UNMATCHED PRICE_QTY_OUT_OF_RANGE', () => {
    const d = S.decide([c(1, { price_diff_pct: '30.00' })], TOL); assert.strictEqual(d.result, 'UNMATCHED'); assert.deepStrictEqual(d.reasons, ['PRICE_QTY_OUT_OF_RANGE']);
  });
  await t('배정: 두 줄이 같은 건 1위 → 점수 높은 줄 EXACT, 진 줄 CANDIDATE_TAKEN', () => {
    const m = S.assignWithinDoc([
      { line_id: 10, line_no: 1, scored: [c(7, { ident: null, price_diff_pct: '0.00' })] },
      { line_id: 11, line_no: 2, scored: [c(7)] },
    ], { ...TOL, auto_min_score: 60 });
    assert.strictEqual(m.get('11').result, 'EXACT');
    assert.ok(m.get('10').taken);
    assert.deepStrictEqual(m.get('10').reasons, ['ALL_CANDIDATES_TAKEN']);
  });
  await t('배정: 같은 점수면 줄 번호 작은 줄', () => {
    const m = S.assignWithinDoc([{ line_id: 21, line_no: 2, scored: [c(7)] }, { line_id: 20, line_no: 1, scored: [c(7)] }], TOL);
    assert.strictEqual(m.get('20').result, 'EXACT'); assert.ok(m.get('21').taken);
  });
  // CSV
  await t('CSV UTF-8(BOM)·CP949 같은 결과', () => {
    const text = '거래일,제공처,품목,수량,단가\n2026-11-23,가명청과,"청양고추, 특",12,"38,000"\n';
    const utf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
    const cp949 = require('iconv-lite').encode(text, 'cp949'); // express(body-parser) 의존성 — 테스트에서만 인코딩용
    assert.strictEqual(decodeCsv(cp949), text);
    const a = parseCsv(utf);
    const b = parseCsv(cp949);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a.rows[0].vals.item, '청양고추, 특');
    assert.strictEqual(a.rows[0].vals.unit_price, '38,000');
  });
  await t('CSV 필수 열 없음 → 오류 문구', () => assert.ok(/필수 열/.test(parseCsv(Buffer.from('a,b\n1,2\n')).error)));
  // 허용오차 검사(4.5)
  await t('허용오차: 자동 > 후보 → field 오류, 범위 밖 → field 오류', () => {
    const baseRow = { price_pct_auto: '0', price_pct_review: '10', qty_pct_auto: '0', qty_pct_review: '20', amount_abs_auto: '0', date_before_auto: 1, date_after_auto: 0, date_before_review: 3, date_after_review: 1, auto_convert: true, auto_min_score: 85, ambiguity_margin: 10 };
    assert.strictEqual(validateTolerance({ price_pct_auto: 12 }, baseRow).errors[0].field, 'price_pct_auto');
    assert.strictEqual(validateTolerance({ amount_abs_auto: 20000 }, baseRow).errors[0].field, 'amount_abs_auto');
    assert.strictEqual(validateTolerance({ auto_min_score: 40 }, baseRow).errors[0].field, 'auto_min_score');
    assert.ok(validateTolerance({ price_pct_review: 8, auto_min_score: 90 }, baseRow).values);
  });

  const pass = results.filter(Boolean).length;
  console.log(`\n[purchase-match-unit] ${pass}/${results.length} 통과`);
  process.exit(pass === results.length ? 0 : 1);
})();
