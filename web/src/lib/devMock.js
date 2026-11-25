// T-203 개발용 목업 — 서버(B①)가 아직 없을 때 화면만 확인하려고 /api 응답을 브라우저 안에서 흉내 낸다.
// 켜는 법: `VITE_DEV_MOCK=1 npx vite --port 5181` (개발 서버에서만. main.jsx 가 import.meta.env.DEV && VITE_DEV_MOCK==='1' 일 때만 불러온다 → 빌드에는 들어가지 않음)
// 역할 바꾸기: 주소 뒤 ?mock_role=owner|admin|input|view  · 응답 지연: ?mock_delay=ms (기본 350)
// 데이터는 전부 가명(A청과·B청과, 출하자 마스킹) — 설계서 4장 응답 형식을 따른다. 실제 거래가 아니다.

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const Y1 = addDays(TODAY, -1);
const iso = (ymd, hm) => `${ymd}T${hm}:00+09:00`;

const ITEMS = [
  ['PEPPER._', '고추', '고추(품종 모름)'], ['PEPPER.CHEONGYANG', '고추', '청양고추'], ['PEPPER.KKWARI', '고추', '꽈리고추'],
  ['PEPPER.OI', '고추', '오이고추'], ['PEPPER.GENERAL', '고추', '일반고추(풋고추)'], ['PEPPER.RED', '고추', '홍고추'],
  ['PAPRIKA._', '파프리카', '파프리카(색 모름)'], ['PAPRIKA.RED', '파프리카', '빨강 파프리카'], ['PAPRIKA.YELLOW', '파프리카', '노랑 파프리카'], ['PAPRIKA.ORANGE', '파프리카', '주황 파프리카'],
].map(([item_key, family_name, variety_name]) => ({ item_key, family_name, variety_name, active: true }));
const label = (k) => {
  const i = ITEMS.find((x) => x.item_key === k);
  return i ? `${i.family_name} · ${i.variety_name}` : null;
};
const GN = { SPECIAL: '특', HIGH: '상', MID: '중', LOW: '하' };
const CORPS = [['C01', 'A청과'], ['C02', 'B청과'], ['C03', 'C농협공판장']];

// 경락 — 어제(확정) 30건 + 오늘(당일) 24건
const trades = [];
(function seed() {
  const kinds = [
    ['PEPPER.CHEONGYANG', '청양', 10, 35000], ['PEPPER.KKWARI', '꽈리', 4, 18000], ['PEPPER.OI', '오이맛', 10, 26000],
    ['PEPPER.GENERAL', '풋고추', 10, 21000], ['PEPPER.RED', '홍고추', 10, 42000], ['PAPRIKA.RED', '적파프리카', 5, 23000],
    ['PAPRIKA.YELLOW', '황파프리카', 5, 22000], ['PAPRIKA.ORANGE', '주황파프리카', 5, 24000], [null, '피망', 5, 15000],
  ];
  let id = 800;
  for (const [day, n] of [[Y1, 30], [TODAY, 24]]) {
    for (let i = 0; i < n; i++) {
      const [k, raw, kg, price] = kinds[i % kinds.length];
      const g = ['SPECIAL', 'HIGH', 'MID'][i % 3];
      const p = price - (i % 3) * 2000 + (i % 4) * 500;
      const qty = 5 + ((i * 7) % 20);
      const [cc, cn] = CORPS[i % 3];
      id += 1;
      trades.push({
        id, source: 'MOCK', trade_date: day, auction_at: iso(day, `0${1 + (i % 5)}:${String(10 + i).padStart(2, '0')}`),
        market_name: '서울가락', corp_code: cc, corp_name: cn, item_key: k, item_label: label(k), item_name_raw: raw,
        grade_norm: g, grade_name: GN[g], pkg_name: '상자', unit_qty_kg: `${kg}.000`, weight_source: 'SOURCE',
        qty: `${qty}.000`, unit_price: p, price_per_kg: (p / kg).toFixed(2), amount: p * qty,
        origin_name: ['충남 청양', '경남 밀양', '전남 화순', '강원 철원'][i % 4], shipper_name_masked: ['김*수', '이*희', '박*진'][i % 3], buyer_code: null,
        shipment_no: cc === 'C03' ? `0${30200 + Math.floor(i / 3)}` : String(9 + Math.floor(i / 3) + (day === Y1 ? 0 : 40)), auction_seq: String(1 + (i % 3) + (i > 9 ? 9 : 0)),
        map_status: k ? 'MAPPED' : 'UNMAPPED',
        revision: i === 2 ? 2 : 1, first_seen_at: iso(day, '03:00'), last_seen_at: iso(day, '09:10'), withdrawn_at: i === 5 && day === Y1 ? iso(day, '10:00') : null,
        history: i === 2 ? [{ revision: 1, qty: `${qty + 1}.000`, unit_price: p + 1000, changed_at: iso(day, '09:10') }] : [],
      });
    }
  }
})();

let jobs = [
  { id: 78, job_type: 'COLLECT', source: 'MOCK', trade_date: TODAY, phase: 'INTRADAY', attempts: 2, max_attempts: 5, status: 'QUEUED', run_after: iso(TODAY, '10:04'), last_error_kind: 'RATE_LIMIT', requested_by_name: null },
  { id: 77, job_type: 'COLLECT', source: 'MOCK', trade_date: Y1, phase: 'FINAL', attempts: 1, max_attempts: 5, status: 'DONE', requested_by_name: null },
  { id: 75, job_type: 'COLLECT', source: 'MOCK', trade_date: addDays(TODAY, -2), phase: 'FINAL', attempts: 5, max_attempts: 5, status: 'DEAD', last_error_kind: 'SERVER_ERROR', error_message: '외부 서버 502 Bad Gateway(목업)', requested_by_name: null },
];
let nextJob = 90;
let lastSync = 0;

const tol = {
  default_row: { id: 1, user_id: null, item_family: null, item_key: null, price_pct_auto: '0.00', price_pct_review: '10.00', qty_pct_auto: '0.00', qty_pct_review: '20.00', amount_abs_auto: 0, date_before_auto: 1, date_after_auto: 0, date_before_review: 3, date_after_review: 1, auto_convert: true, auto_min_score: 85, ambiguity_margin: 10 },
  rows: [],
};
let plinks = [
  { id: 1, item_key: 'PEPPER.CHEONGYANG', grade_norm: null, product_id: 31, product_name: '청양고추', product_unit: '10kg' },
  { id: 2, item_key: 'PEPPER.KKWARI', grade_norm: null, product_id: 32, product_name: '꽈리고추', product_unit: '4kg' },
  { id: 3, item_key: 'PEPPER.RED', grade_norm: null, product_id: 33, product_name: '홍고추', product_unit: '10kg' },
];
const tradeConv = new Map(); // 경락 → 매입 활성 전환: trade_id → purchase_id
let convertCalls = 0;
const purchases = [
  { id: 5012, purchase_date: `${Y1}T00:00:00+09:00`, partner_id: 7, partner_name: 'A청과', product_id: 31, product_name: '청양고추', quantity: '10', allocated_qty: '0', remaining_qty: '10', unit_price: 35000, total_amount: 350000, unpaid_amount: 350000, status: 'active', source_name: 'A청과' },
];
let clinks = [{ corp_code: 'C01', corp_name: 'A청과', partner_id: 7 }, { corp_code: 'C02', corp_name: 'B청과', partner_id: null }, { corp_code: 'C03', corp_name: 'C농협공판장', partner_id: null }];
let mappings = [
  { id: 1, target: 'BOTH', source: null, code_l: null, code_m: null, code_s: null, keyword_norm: '청양', item_key: 'PEPPER.CHEONGYANG', priority: 50, active: true },
  { id: 2, target: 'BOTH', source: null, keyword_norm: '꽈리', item_key: 'PEPPER.KKWARI', priority: 50, active: true },
  { id: 3, target: 'BOTH', source: null, keyword_norm: '홍청양', item_key: 'PEPPER.RED', priority: 40, active: true },
];
let calendar = [{ market_code: '110001', cal_date: addDays(TODAY, 31).slice(0, 8) + '01', kind: 'HOLIDAY', note: '목업 휴장' }];
let schedules = [
  { job_type: 'COLLECT_INTRADAY', source: 'AT_REALTIME', cron_text: '0 4-12 * * *', active: true, next_run_at: iso(TODAY, '11:00') },
  { job_type: 'COLLECT_FINAL', source: 'AT_REALTIME', cron_text: '0 11,16 * * *', active: true, next_run_at: iso(addDays(TODAY, 1), '11:00') },
];

// 매입서
let nextDoc = 42;
let nextLine = 320;
let nextPurchase = 5013;
let events = [];
const docs = [];
function mkLine(doc, no, o) {
  return {
    id: nextLine++, doc_id: doc.id, doc_no: doc.doc_no, line_no: no, trade_date: doc.doc_date, item_name_raw: o.name, item_key: o.key ?? null,
    grade_raw: o.grade || '', grade_norm: o.gn || null, pkg_raw: o.spec || '', unit_qty_kg: o.kg || null, qty: `${o.qty}.000`, unit_price: o.price,
    amount: o.amount ?? o.price * o.qty, origin_name: o.origin || null, status: o.status || 'PENDING', match_result: o.mr || null, match_score: o.score ?? null,
    candidate_count: o.cc ?? null, reason_codes: o.rc || [], warning_flags: o.wf || [], version: 1, purchase_id: o.pid || null, conversion_mode: o.mode || null,
    top_diff: o.diff || null,
  };
}
function recalc(doc) {
  const c = { converted: 0, pending: 0, hold: 0, rejected: 0, cancelled: 0 };
  for (const l of doc.lines) c[{ CONVERTED: 'converted', PENDING: 'pending', HOLD: 'hold', REJECTED: 'rejected', CANCELLED: 'cancelled' }[l.status]]++;
  doc.counts = c;
  doc.line_count = doc.lines.length;
  doc.amount_total = doc.lines.reduce((s, l) => s + l.amount, 0);
  if (doc.status === 'CANCELLED') return;
  const n = doc.lines.length;
  doc.status = c.rejected === n ? 'REJECTED' : c.converted > 0 && c.converted + c.rejected === n ? 'CONVERTED' : c.converted > 0 ? 'PARTIAL_CONVERTED' : c.hold + c.cancelled > 0 ? 'HOLD' : 'PENDING';
}
function addDoc(head, lineSpecs) {
  const doc = { id: nextDoc++, doc_no: head.doc_no || `D-${TODAY.slice(5).replace('-', '')}-${String(nextDoc).slice(-2)}`, doc_date: head.doc_date || Y1, supplier_partner_id: head.supplier_partner_id || 7, supplier_name: head.supplier_name || 'A청과', status: 'PENDING', lines: [] };
  lineSpecs.forEach((o, i) => doc.lines.push(mkLine(doc, i + 1, o)));
  recalc(doc);
  docs.unshift(doc);
  return doc;
}
addDoc({ doc_no: 'D-1124-01', doc_date: Y1 }, [
  { name: '청양고추', key: 'PEPPER.CHEONGYANG', grade: '특', gn: 'SPECIAL', spec: '10kg 상자', kg: '10.000', qty: 10, price: 35000, status: 'CONVERTED', mr: 'EXACT', score: 92, pid: 5012, mode: 'AUTO' },
  { name: '꽈리고추', key: 'PEPPER.KKWARI', grade: '상', gn: 'HIGH', spec: '4kg 상자', kg: '4.000', qty: 20, price: 18000, status: 'HOLD', mr: 'PARTIAL', score: 71, cc: 3, rc: ['MULTI_CANDIDATE'] },
  { name: '홍고추', key: 'PEPPER.RED', grade: '특', gn: 'SPECIAL', spec: '10kg 상자', kg: '10.000', qty: 8, price: 42000, status: 'PENDING', mr: 'EXACT', score: 95 },
]);
addDoc({ doc_no: 'D-1123-04', doc_date: Y1, supplier_name: 'B청과' }, [
  { name: '청양', key: 'PEPPER.CHEONGYANG', grade: '특', gn: 'SPECIAL', spec: '10kg', kg: '10.000', qty: 20, price: 36000, status: 'HOLD', mr: 'PARTIAL', score: 74, rc: ['PRICE_OUT'], diff: { price: 1000, price_pct: '2.86' } },
  { name: '오이고추', key: 'PEPPER.OI', grade: '상', gn: 'HIGH', spec: '', qty: 5, price: 26000, status: 'HOLD', mr: 'UNMATCHED', rc: ['BASE_NOT_READY'] },
  { name: '청량초', key: null, grade: '상', spec: '10kg', kg: '10.000', qty: 3, price: 30000, status: 'HOLD', mr: 'UNMATCHED', rc: ['ITEM_UNMAPPED'] },
  { name: '빨강 파프리카', key: 'PAPRIKA.RED', grade: '특', gn: 'SPECIAL', spec: '5kg 상자', kg: '5.000', qty: 12, price: 23000, status: 'PENDING', mr: 'EXACT', score: 90, rc: ['NO_PRODUCT_LINK'] },
]);

// ---------------------------------------------------------------------------
const P = new URLSearchParams(window.location.search);
const DELAY = Number(P.get('mock_delay') || 350);
const ROLE_ALLOW = { input: ['purchase_doc.upload', 'purchase_doc.match', 'purchase_doc.edit', 'purchase_doc.convert', 'purchase.convert_from_trade', 'purchase.create'], view: [] };

function setRoleUser() {
  const role = P.get('mock_role');
  let cur = null;
  try {
    cur = JSON.parse(window.sessionStorage.getItem('user') || 'null');
  } catch {
    /* 무시 */
  }
  if (!role && cur?.token) return;
  const r = role || 'admin';
  const base = { id: 1, name: '가명중매인', agent_no: 'mock001', token: 'mock-token', is_admin: r === 'admin' };
  const u = r === 'input' || r === 'view'
    ? { ...base, is_admin: false, staff: { id: 9, login_id: `mock_${r}`, name: r === 'input' ? '가명입력' : '가명조회', role: r, must_change_password: false }, allow: ROLE_ALLOW[r] }
    : { ...base, staff: null, allow: null };
  window.sessionStorage.setItem('user', JSON.stringify(u));
}
const who = () => {
  try {
    return JSON.parse(window.sessionStorage.getItem('user') || 'null') || {};
  } catch {
    return {};
  }
};
const role = () => who().staff?.role || 'owner';
const isAdmin = () => role() === 'owner' && !!who().is_admin;

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const ok = (body = {}) => json(200, { ok: true, ...body });
const fail = (status, code, message, extra = {}) => json(status, { ok: false, code, message, ...extra });
const forbid = () => fail(403, 'FORBIDDEN_ROLE', '권한이 없습니다. 중매인(주인) 계정에 요청하세요.', { role: role() });
const need = (lvl) => (lvl === 'owner' ? role() !== 'owner' : lvl === 'write' ? role() === 'view' : lvl === 'admin' ? !isAdmin() : false);
const page = (arr, q) => {
  const limit = Math.min(Number(q.get('limit') || 50), 200);
  const offset = Number(q.get('offset') || 0);
  return { data: arr.slice(offset, offset + limit), total: arr.length, limit, offset };
};
const findLine = (id) => {
  for (const d of docs) for (const l of d.lines) if (l.id === Number(id)) return [d, l];
  return [null, null];
};
const ev = (doc, l, type, extra = {}) => events.unshift({ id: events.length + 1, doc_id: doc.id, line_no: l?.line_no, event_type: type, actor_name: who().staff?.name || who().name, created_at: new Date().toISOString(), ...extra });
const lineView = (d, l) => ({ ...l, supplier_name: d.supplier_name });
const idemStore = new Map();

function candidatesFor(l) {
  const pool = trades.filter((t) => t.item_key && t.item_key === l.item_key && !t.withdrawn_at).slice(0, 4);
  return pool.map((t, i) => {
    const price = t.unit_price - l.unit_price;
    const pct = ((price / l.unit_price) * 100).toFixed(2);
    const strict = i === 0 && !(l.reason_codes || []).includes('PRICE_OUT');
    return { trade_id: t.id, trade: t, score: Math.max(50, (l.match_score || 80) - i * 4), strict, flags: strict ? [] : ['PRICE_OUT'], diff: { price: -price, price_pct: String(-Number(pct)), qty: '0.000', amount: String(-price * Number(l.qty)) } };
  });
}

async function route(method, path, q, body, headers) {
  const seg = path.split('/').filter(Boolean); // ['auction','trades',...]
  const [a, b, c, d] = seg;
  const W = method !== 'GET';
  // ---- 기존 화면이 부르는 것들(목업은 빈 값) ----
  if (a === 'partners') return ok({ data: [{ id: 7, name: 'A청과', type: 'market_wholesaler' }, { id: 8, name: 'B청과', type: 'market_wholesaler' }, { id: 9, name: '가명상회', type: 'customer' }] });
  if (a === 'products') return ok({ data: [{ id: 31, name: '청양고추', unit: '10kg' }, { id: 32, name: '꽈리고추', unit: '4kg' }, { id: 33, name: '홍고추', unit: '10kg' }, { id: 34, name: '빨강 파프리카', unit: '5kg' }, { id: 40, name: '내 청양(개인)', unit: '10kg', is_personal: true }] });
  if (a === 'dashboard') return fail(503, 'MOCK', '목업 모드 — 오늘 화면은 서버가 있어야 보입니다.');
  if (a === 'me') return ok({ allow: who().allow, staff: who().staff, is_admin: who().is_admin });

  // ---- 경락 ----
  if (a === 'auction') {
    if (b === 'items') return ok({ data: ITEMS });
    if (b === 'trades' && c) {
      const t = trades.find((x) => x.id === Number(c));
      return t ? ok({ data: t }) : fail(404, 'NOT_FOUND', '경락 건을 찾지 못했습니다.');
    }
    if (b === 'trades') {
      const from = q.get('date_from');
      const to = q.get('date_to');
      if (!from || !to) return fail(400, 'VALIDATION', '조회 기간을 지정하세요.', { field: 'date_from' });
      const keys = (q.get('item_key') || '').split(',').filter(Boolean);
      let rows = trades.filter((t) => t.trade_date >= from && t.trade_date <= to);
      // 원표번호(정확 일치·앞자리 0 무시) — 있으면 품목·품종·등급·규격·산지 무시, 매핑 안 된 행도 보임(설계 A 1절)
      const shipRaw = q.get('shipment_no');
      const ship = shipRaw != null ? shipRaw.replace(/[\s.-]/g, '') : null;
      if (ship != null && !/^\d{1,20}$/.test(ship)) return fail(400, 'VALIDATION', '원표번호는 숫자 20자리 이내로 입력하세요.', { field: 'shipment_no' });
      const SORTS = { trade_date: 'desc', auction_at: 'desc', corp: 'asc', shipment_no: 'asc', auction_seq: 'asc', item: 'asc', grade: 'asc', unit_kg: 'asc', qty: 'desc', unit_price: 'desc', price_per_kg: 'desc', origin: 'asc' };
      const sk = q.get('sort') || 'trade_date';
      if (!SORTS[sk]) return fail(400, 'VALIDATION', '정렬 기준이 올바르지 않습니다.', { field: 'sort' });
      const dir = q.get('dir') || SORTS[sk];
      if (!['asc', 'desc'].includes(dir)) return fail(400, 'VALIDATION', '정렬 방향이 올바르지 않습니다.', { field: 'dir' });
      const shipMode = ship != null;
      if (shipMode) {
        const z = (v) => String(v || '').replace(/^0+/, '') || '0';
        rows = rows.filter((t) => t.shipment_no && z(t.shipment_no) === z(ship));
      }
      if (!shipMode && q.get('include_unmapped') !== 'true') rows = rows.filter((t) => t.item_key);
      if (q.get('include_withdrawn') !== 'true') rows = rows.filter((t) => !t.withdrawn_at);
      if (!shipMode && q.get('family')) rows = rows.filter((t) => String(t.item_key).startsWith(q.get('family') + '.'));
      if (keys.length) rows = rows.filter((t) => keys.includes(t.item_key));
      if (q.get('grade')) rows = rows.filter((t) => t.grade_norm === q.get('grade'));
      if (q.get('corp_code')) rows = rows.filter((t) => t.corp_code === q.get('corp_code'));
      if (!shipMode && q.get('origin')) rows = rows.filter((t) => (t.origin_name || '').includes(q.get('origin')));
      const GRANK = { SPECIAL: 1, HIGH: 2, MID: 3, LOW: 4, OFF: 5, NONE: 6 };
      const lenKey = (v) => (v ? String(v.length).padStart(3, '0') + v : null);
      const SV = {
        trade_date: (t) => t.trade_date + (t.auction_at || ''), auction_at: (t) => t.auction_at, corp: (t) => t.corp_name,
        shipment_no: (t) => lenKey(t.shipment_no), auction_seq: (t) => lenKey(t.auction_seq),
        item: (t) => t.item_label || t.item_name_raw, grade: (t) => GRANK[t.grade_norm] ?? null, unit_kg: (t) => (t.unit_qty_kg == null ? null : Number(t.unit_qty_kg)),
        qty: (t) => Number(t.qty), unit_price: (t) => t.unit_price, price_per_kg: (t) => (t.price_per_kg == null ? null : Number(t.price_per_kg)), origin: (t) => t.origin_name,
      };
      const sgn = dir === 'asc' ? 1 : -1;
      rows = [...rows].sort((x, y) => {
        const a1 = SV[sk](x);
        const b1 = SV[sk](y);
        if (a1 == null && b1 == null) return sgn * (x.id - y.id);
        if (a1 == null) return 1; // NULLS LAST(양쪽 방향)
        if (b1 == null) return -1;
        if (a1 < b1) return -sgn;
        if (a1 > b1) return sgn;
        return sgn * (x.id - y.id);
      });
      rows = rows.map((t) => {
        const pid = tradeConv.get(t.id) || null;
        const why = pid ? null : t.withdrawn_at ? 'WITHDRAWN' : !t.item_key ? 'UNMAPPED_ITEM' : null;
        return { ...t, converted_purchase_id: pid, convertible: !pid && !why, not_convertible_reason: why };
      });
      if (q.get('pkg')) rows = rows.filter((t) => t.pkg_name === q.get('pkg'));
      const days = [];
      for (let dd = from; dd <= to; dd = addDays(dd, 1)) {
        const n = trades.filter((t) => t.trade_date === dd).length;
        days.push({ trade_date: dd, source: 'MOCK', phase: dd === TODAY ? 'INTRADAY' : 'FINAL', status: n ? 'COMPLETE' : dd > TODAY ? 'NOT_YET' : dd === TODAY ? 'NOT_YET' : 'EMPTY', fetched_count: n });
      }
      const onlyToday = from === TODAY && to === TODAY;
      return ok({ meta: { as_of: iso(TODAY, '09:12'), snapshot_status: 'COMPLETE', phase: onlyToday ? 'INTRADAY' : 'FINAL', stale: P.get('mock_stale') === '1', source_mode: 'MOCK', sort: sk, dir, shipment_no: ship }, ...page(rows, q), days });
    }
    if (b === 'daily-prices') return ok({ data: [{ price_date: q.get('date'), item_key: 'PEPPER.CHEONGYANG', item_name_raw: '청양', grade_name: '특', unit_name: '10kg', avg_price: 34800, prev_price: 34100, diff: 700, diff_pct: '2.1' }] });
    if (b === 'sync' && c === 'status')
      return ok({
        circuits: [
          { source: 'AT_REALTIME', state: 'OPEN', consecutive_failures: 5, next_probe_at: iso(TODAY, '10:20'), disabled_reason: null, last_error_kind: 'SERVER_ERROR', last_success_at: iso(TODAY, '06:31') },
          { source: 'AT_SETTLE', state: 'CLOSED', consecutive_failures: 0, disabled_reason: null, last_success_at: iso(TODAY, '07:02') },
          { source: 'GARAK_PRICE', state: 'CLOSED', consecutive_failures: 0, disabled_reason: 'NO_KEY' },
        ],
        days: [
          { trade_date: TODAY, source: 'MOCK', phase: 'INTRADAY', status: 'COMPLETE', total_count: 24, fetched_count: 24, unmapped: 3 },
          { trade_date: Y1, source: 'MOCK', phase: 'FINAL', status: 'COMPLETE', total_count: 30, fetched_count: 30, unmapped: 3, finished_at: iso(TODAY, '11:02') },
          { trade_date: addDays(TODAY, -2), source: 'MOCK', phase: 'FINAL', status: 'PARTIAL', total_count: 16, fetched_count: 15, unmapped: 0, verify_warning: '건수 불일치' },
          { trade_date: addDays(TODAY, -3), source: 'MOCK', phase: 'FINAL', status: 'HOLIDAY', fetched_count: 0 },
        ],
        queue: jobs.filter((j) => j.status === 'QUEUED'),
        source_mode: 'MOCK',
      });
    if (b === 'sync' && W) {
      if (need('owner')) return forbid();
      if (Date.now() - lastSync < 5 * 60e3) return fail(429, 'SYNC_RATE_LIMIT', '수동 동기화는 5분에 한 번만 할 수 있습니다.', { detail: { retry_after_sec: Math.ceil((5 * 60e3 - (Date.now() - lastSync)) / 1000) } });
      lastSync = Date.now();
      const queued = [];
      const skipped = [];
      for (let dd = body.date_from; dd <= body.date_to; dd = addDays(dd, 1)) {
        if (dd === Y1 && !body.force) skipped.push({ target_date: dd, reason: 'ALREADY_COMPLETE' });
        else if (dd === addDays(TODAY, -3)) skipped.push({ target_date: dd, reason: 'HOLIDAY' });
        else {
          const j = { id: nextJob++, job_type: 'COLLECT', source: body.source, trade_date: dd, phase: body.phase, attempts: 0, max_attempts: 5, status: 'QUEUED', run_after: new Date().toISOString(), requested_by_name: who().name };
          jobs.unshift(j);
          queued.push({ id: j.id, target_date: dd });
        }
      }
      return json(202, { ok: true, data: { queued, skipped } });
    }
    if (b === 'jobs' && d === 'retry') {
      if (need('owner')) return forbid();
      const j = jobs.find((x) => x.id === Number(c));
      if (!j || !['FAILED', 'DEAD'].includes(j.status)) return fail(409, 'JOB_NOT_FAILED', '실패한 작업만 다시 실행할 수 있습니다.');
      const nj = { ...j, id: nextJob++, attempts: 0, status: 'QUEUED', last_error_kind: null, error_message: null, run_after: new Date().toISOString(), requested_by_name: who().name };
      jobs.unshift(nj);
      return json(202, { ok: true, data: { id: nj.id } });
    }
    if (b === 'jobs' && d === 'cancel') {
      if (need('admin')) return forbid();
      const j = jobs.find((x) => x.id === Number(c));
      if (j.status !== 'QUEUED') return fail(409, 'JOB_RUNNING', '대기 중인 작업만 취소할 수 있습니다.');
      j.status = 'CANCELLED';
      return ok({ data: j });
    }
    if (b === 'jobs') return ok(page(jobs, q));
    if (b === 'calendar') {
      if (!W) return ok({ data: calendar.filter((x) => (!q.get('date_from') || x.cal_date >= q.get('date_from')) && (!q.get('date_to') || x.cal_date <= q.get('date_to'))) });
      if (need('admin')) return forbid();
      calendar = calendar.filter((x) => !(body.remove || []).includes(x.cal_date)).concat((body.add || []).map((x) => ({ market_code: body.market_code, ...x })));
      return ok({});
    }
    if (b === 'schedules') {
      if (!W) return ok({ data: schedules });
      if (need('admin')) return forbid();
      if (String(body.cron_text).trim().split(/\s+/).length !== 5) return fail(400, 'BAD_CRON', 'cron 형식이 틀렸습니다.', { field: 'cron_text' });
      schedules = schedules.map((s) => (s.job_type === body.job_type && s.source === body.source ? { ...s, ...body } : s));
      return ok({});
    }
    if (b === 'item-mappings') {
      if (!W) return ok({ data: mappings });
      if (need('admin')) return forbid();
      if (method === 'POST') {
        const kw = (body.keyword || '').replace(/\s+/g, '');
        if (mappings.some((m) => m.active && m.keyword_norm && m.keyword_norm === kw)) return fail(409, 'MAPPING_DUPLICATE', '같은 키워드 매핑이 이미 있습니다.', { field: 'keyword' });
        const m = { id: mappings.length + 1, target: body.target, source: null, keyword_norm: kw || null, code_m: body.code_m || null, code_s: body.code_s || null, item_key: body.item_key, priority: body.priority, active: true };
        mappings.push(m);
        return json(201, { ok: true, data: { id: m.id, remap_job_id: nextJob++ } });
      }
      const m = mappings.find((x) => x.id === Number(c));
      if (method === 'DELETE') m.active = false;
      else Object.assign(m, body, { id: m.id });
      return ok({ data: { remap_job_id: nextJob++ } });
    }
    if (b === 'unmapped') return need('admin') ? forbid() : ok({ data: [{ origin: 'MARKET', item_name_raw: '피망', count: 6, last_seen: TODAY }, { origin: 'DOC', item_name_raw: '청량초', count: 1, last_seen: Y1 }] });
    if (b === 'product-links') {
      if (!W) return ok({ data: plinks, suggestions: [{ item_key: 'PEPPER.KKWARI', product_id: 32, product_name: '꽈리고추' }, { item_key: 'PAPRIKA.RED', product_id: 34, product_name: '빨강 파프리카' }] });
      if (need('owner')) return forbid();
      if (method === 'DELETE') {
        plinks = plinks.filter((x) => x.id !== Number(c));
        return ok({});
      }
      for (const l of body.links) {
        plinks = plinks.filter((x) => !(x.item_key === l.item_key && (x.grade_norm || null) === (l.grade_norm || null)));
        plinks.push({ id: plinks.length + 10, ...l, product_name: `품목 #${l.product_id}` });
      }
      return ok({ data: { saved: body.links.length } });
    }
    if (b === 'corp-links') {
      if (!W) return ok({ data: clinks });
      if (need('owner')) return forbid();
      for (const l of body.links) clinks = clinks.map((x) => (x.corp_code === l.corp_code ? { ...x, partner_id: l.partner_id } : x));
      return ok({});
    }
  }

  // ---- 허용오차 ----
  if (a === 'purchase-match' && b === 'tolerances') {
    const eff = { ...tol.default_row, ...(tol.rows.find((r) => !r.item_family && !r.item_key) || {}) };
    if (!W) return ok({ data: { effective: eff, rows: [tol.default_row, ...tol.rows], default_row: tol.default_row } });
    if (need('owner')) return forbid();
    if (method === 'DELETE') {
      if (Number(c) === 1) return fail(403, 'DEFAULT_ROW', '기본값은 지울 수 없습니다.');
      tol.rows = tol.rows.filter((r) => r.id !== Number(c));
      return ok({});
    }
    if (body.price_pct_auto > body.price_pct_review) return fail(400, 'VALIDATION', '단가 자동 허용은 후보 허용보다 클 수 없습니다.', { field: 'price_pct_auto' });
    tol.rows = tol.rows.filter((r) => !((r.item_family || null) === (body.item_family || null) && (r.item_key || null) === (body.item_key || null)));
    tol.rows.push({ id: 100 + tol.rows.length, user_id: 1, ...body });
    return ok({});
  }

  // ---- 경락 → 매입 전환(R-138 미리보기 · R-139 전환, 설계 A 5.2·5.3) ----
  if (a === 'purchase-docs' && b === 'from-trades') {
    if (need('write')) return forbid();
    const tids = [...new Set((body?.trade_ids || []).map(Number))];
    if (!tids.length || tids.length > 200 || tids.some((n) => !(n > 0))) return fail(400, 'VALIDATION', '경락 건을 1~200건 고르세요.', { field: 'trade_ids' });
    const plan = (id) => {
      const t = trades.find((x) => x.id === id);
      if (!t) return { trade_id: id, result: 'NOT_FOUND', message: '경락 건을 찾지 못했습니다.' };
      if (tradeConv.get(id)) return { trade_id: id, result: 'ALREADY_CONVERTED', purchase_id: tradeConv.get(id), message: '이미 매입 등록한 경락 건입니다.' };
      if (t.withdrawn_at) return { trade_id: id, result: 'WITHDRAWN', message: '철회된 경락 건은 매입 등록하지 않습니다.' };
      if (!t.item_key) return { trade_id: id, result: 'UNMAPPED_ITEM', message: '품목 매핑이 없는 경락 건입니다.' };
      const cl = clinks.find((x) => x.corp_code === t.corp_code);
      if (!cl?.partner_id) return { trade_id: id, result: 'NO_CORP_LINK', message: `법인 ${t.corp_name}과 거래처 연결이 없습니다(대조 설정 → 법인 연결).` };
      const pl = plinks.find((x) => x.item_key === t.item_key);
      if (!pl) return { trade_id: id, result: 'NO_PRODUCT_LINK', message: `${t.item_label || t.item_name_raw} 품목 연결이 없습니다(대조 설정 → 품목 연결).` };
      return {
        trade_id: id, result: 'WILL_CONVERT', partner: { id: cl.partner_id, name: cl.corp_name }, product: { id: pl.product_id, name: pl.product_name },
        purchase_date: t.trade_date, quantity: t.qty, unit_price: `${t.unit_price}.00`, total: `${t.amount}.00`, shipment_no: t.shipment_no, auction_seq: t.auction_seq,
        warnings: t.trade_date === TODAY ? ['BASE_NOT_FINAL'] : [], _t: t, _pl: pl, _cl: cl,
      };
    };
    const strip = ({ _t, _pl, _cl, ...r }) => r; // eslint-disable-line no-unused-vars
    if (c === 'preview') {
      const rows = tids.map(plan);
      const will = rows.filter((r) => r.result === 'WILL_CONVERT');
      return ok({ data: { rows: rows.map(strip), summary: { will_convert: will.length, excluded: rows.length - will.length, total_amount: `${will.reduce((s2, r) => s2 + r._t.amount, 0)}.00` } } });
    }
    const key = headers['Idempotency-Key'];
    if (!key) return fail(400, 'VALIDATION', 'Idempotency-Key 헤더가 필요합니다.', { field: 'Idempotency-Key' });
    const bodyKey = JSON.stringify([...tids].sort((x, y) => x - y));
    if (idemStore.has(key)) {
      const prevRun = idemStore.get(key);
      if (prevRun.bodyKey !== bodyKey) return fail(422, 'REUSED', '같은 요청 키를 다른 내용에 다시 쓸 수 없습니다.');
      return json(200, prevRun.res, { 'Idempotent-Replay': 'true' });
    }
    convertCalls += 1;
    const results = tids.map((id) => {
      const r = plan(id);
      if (r.result === 'ALREADY_CONVERTED') return { trade_id: id, result: r.result, purchase_id: r.purchase_id };
      if (r.result !== 'WILL_CONVERT') return { trade_id: id, result: r.result, code: r.result, message: r.message };
      const pid = nextPurchase++;
      const t = r._t;
      tradeConv.set(id, pid);
      purchases.unshift({
        id: pid, purchase_date: `${t.trade_date}T00:00:00+09:00`, partner_id: r._cl.partner_id, partner_name: r._cl.corp_name, product_id: r._pl.product_id, product_name: r._pl.product_name,
        quantity: t.qty, allocated_qty: '0', remaining_qty: t.qty, unit_price: t.unit_price, total_amount: t.amount, unpaid_amount: t.amount, status: 'active',
        source_name: t.corp_name, origin_region: t.origin_name, memo: `경락 #${t.id} · 원표 ${t.shipment_no} · 경매 ${t.auction_seq}`, purchase_doc_line_id: nextLine++, purchase_doc_id: nextDoc, purchase_doc_kind: 'AUCTION',
      });
      return { trade_id: id, result: 'CONVERTED', purchase_id: pid, doc_id: nextDoc, line_id: nextLine - 1, conversion_id: 300 + pid };
    });
    const conv = results.filter((r) => r.result === 'CONVERTED');
    if (conv.length) {
      const first = trades.find((x) => x.id === conv[0].trade_id);
      docs.unshift({ id: nextDoc++, doc_no: null, input_kind: 'AUCTION', doc_date: first.trade_date, supplier_partner_id: 7, supplier_name: first.corp_name, status: 'CONVERTED', lines: [], counts: { converted: conv.length, pending: 0, hold: 0, rejected: 0, cancelled: 0 }, line_count: conv.length, amount_total: 0, memo: '경락 시세 직접 전환' });
    }
    const pids = results.filter((r) => r.purchase_id).map((r) => r.purchase_id);
    const dates = results.filter((r) => r.purchase_id).map((r) => trades.find((x) => x.id === r.trade_id).trade_date).sort();
    const res = {
      ok: true,
      data: {
        results,
        summary: { converted: conv.length, already: results.filter((r) => r.result === 'ALREADY_CONVERTED').length, failed: results.filter((r) => !r.purchase_id).length },
        navigate: pids.length ? { tab: 'purchases', from_date: dates[0], to_date: dates[dates.length - 1], purchase_ids: pids } : null,
      },
    };
    idemStore.set(key, { bodyKey, res });
    console.info('[devMock] R-139 전환 호출 수(키 재생 제외):', convertCalls);
    return json(200, res);
  }
  if (a === 'purchases' && !b && method === 'GET') {
    const idsQ = (q.get('ids') || '').split(',').filter(Boolean).map(Number);
    let rows = purchases.filter((x) => (!q.get('from_date') || x.purchase_date.slice(0, 10) >= q.get('from_date')) && (!q.get('to_date') || x.purchase_date.slice(0, 10) <= q.get('to_date')));
    if (idsQ.length) rows = rows.filter((x) => idsQ.includes(x.id));
    return ok(page(rows, q));
  }

  // ---- 매입서 ----
  if (a === 'purchase-docs') {
    if (b === 'template') return fail(404, 'MOCK', '목업 모드에서는 템플릿 파일이 없습니다(서버 R-116).');
    if (b === 'preview') {
      if (need('write')) return forbid();
      const name = body?.get?.('file')?.name || '';
      const bad = /err|오류/i.test(name);
      return ok({
        data: {
          docs: [{ group_key: 'D-NEW-01', doc_no: 'D-NEW-01', doc_date: Y1, supplier: 'A청과', lines: 3, amount_total: 1050000 }],
          rows: [
            { line: 2, ok: true, normalized: { item_key: 'PEPPER.CHEONGYANG', grade_norm: 'SPECIAL', unit_qty_kg: '10.000', amount: 350000 }, warnings: [] },
            bad
              ? { line: 3, ok: false, errors: [{ field: 'unit_price', code: 'NOT_INTEGER_WON', message: '단가는 원 단위 정수로 입력하세요(35000.5).' }] }
              : { line: 3, ok: true, normalized: { item_key: 'PEPPER.KKWARI', grade_norm: 'HIGH', unit_qty_kg: '4.000', amount: 360000 }, warnings: [] },
            { line: 4, ok: true, normalized: { item_key: null, amount: 340000 }, warnings: [{ code: 'ITEM_UNMAPPED', message: "'청량초'를 품목으로 찾지 못했습니다. 저장은 되고 대조에서 미매칭으로 표시됩니다." }] },
          ],
          summary: { rows: 3, ok: bad ? 2 : 3, errors: bad ? 1 : 0, warnings: 1, amount_total: 1050000 },
        },
      });
    }
    if (b === 'review') {
      const rows = [];
      for (const dd of docs) for (const l of dd.lines) if (l.status === 'HOLD' || l.status === 'CANCELLED' || (l.status === 'PENDING' && l.match_result === 'EXACT')) rows.push(lineView(dd, l));
      const r = q.get('reason');
      return ok(page(r ? rows.filter((l) => [...l.reason_codes, ...l.warning_flags].includes(r)) : rows, q));
    }
    if (b === 'convert') {
      if (need('write')) return forbid();
      const key = headers['Idempotency-Key'];
      if (!key) return fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key 가 필요합니다.');
      const sig = JSON.stringify(body);
      if (idemStore.has(key)) {
        const prev = idemStore.get(key);
        if (prev.sig !== sig) return fail(422, 'IDEMPOTENCY_KEY_REUSED', '같은 요청 키로 다른 내용을 보냈습니다. 화면을 새로고침해 다시 시도하세요.');
        return json(200, prev.res, { 'Idempotent-Replay': 'true' });
      }
      const results = body.lines.map(({ line_id }) => {
        const [dd, l] = findLine(line_id);
        if (!l) return { line_id, result: 'NOT_FOUND' };
        if (l.status === 'CONVERTED') return { line_id, result: 'ALREADY_CONVERTED', purchase_id: l.purchase_id };
        if ((l.reason_codes || []).includes('NO_PRODUCT_LINK')) return { line_id, result: 'NO_PRODUCT_LINK', message: '대조 설정에서 품목 연결을 먼저 하세요.' };
        if (l.match_result !== 'EXACT') return { line_id, result: 'NEEDS_CONFIRM', code: 'MATCH_NOT_EXACT', message: '부분일치 줄은 수동 확정(주인)으로 전환합니다.' };
        l.status = 'CONVERTED';
        l.purchase_id = nextPurchase++;
        l.conversion_mode = 'MANUAL';
        l.version++;
        recalc(dd);
        ev(dd, l, 'CONVERT', { score: l.match_score });
        return { line_id, result: 'CONVERTED', purchase_id: l.purchase_id, conversion_id: l.purchase_id - 4900, amount_diff: '0.00' };
      });
      const res = { ok: true, data: { results, summary: { converted: results.filter((x) => x.result === 'CONVERTED').length, already: results.filter((x) => x.result === 'ALREADY_CONVERTED').length, failed: results.filter((x) => !['CONVERTED', 'ALREADY_CONVERTED'].includes(x.result)).length } } };
      idemStore.set(key, { sig, res });
      return json(200, res);
    }
    if (b === 'lines') {
      const [dd, l] = findLine(c);
      if (!l) return fail(404, 'NOT_FOUND', '줄을 찾지 못했습니다.');
      if (d === 'candidates') return ok({ data: candidatesFor(l) });
      if (d === 'rematch') {
        if (need('write')) return forbid();
        if (l.status === 'CONVERTED') return fail(409, 'LINE_CONVERTED', '매입 등록된 줄입니다. 먼저 전환을 취소하세요.');
        l.status = l.match_result === 'EXACT' ? 'PENDING' : 'HOLD';
        l.version++;
        recalc(dd);
        ev(dd, l, 'REMATCH');
        return ok({ data: { line: lineView(dd, l) } });
      }
      if (d === 'confirm') {
        if (need('owner')) return forbid();
        if (body.version !== l.version) return fail(409, 'VERSION_CONFLICT', '다른 사람이 이 줄을 먼저 바꿨습니다.', { detail: { line: lineView(dd, l) } });
        const cand = candidatesFor(l).find((x) => x.trade_id === body.trade_id);
        const forced = !body.trade_id || (cand && !cand.strict);
        if (forced && !body.accept_diff) return fail(400, 'DIFF_NOT_ACCEPTED', '허용오차를 넘는 차이가 있습니다. 차이를 확인했다면 accept_diff 와 사유를 함께 보내세요.', { detail: { diff: cand?.diff || {} } });
        l.status = 'CONVERTED';
        l.purchase_id = nextPurchase++;
        l.conversion_mode = forced ? 'FORCED' : 'MANUAL';
        l.version++;
        recalc(dd);
        ev(dd, l, forced ? 'FORCE_CONVERT' : 'MANUAL_CONVERT', { reason: body.reason });
        return ok({ data: { line_id: l.id, result: 'CONVERTED', mode: l.conversion_mode, purchase_id: l.purchase_id, diff: cand?.diff || {}, warnings: forced ? ['PRICE_OUT'] : [] } });
      }
      if (d === 'reject') {
        if (need('owner')) return forbid();
        if (l.status === 'CONVERTED') return fail(409, 'LINE_CONVERTED', '매입 등록된 줄입니다. 먼저 전환을 취소하세요.');
        l.status = 'REJECTED';
        l.version++;
        recalc(dd);
        ev(dd, l, 'REJECT', { reason: body.reason });
        return ok({ data: lineView(dd, l) });
      }
      if (d === 'cancel') {
        if (need('owner')) return forbid();
        if (l.status !== 'CONVERTED') return fail(409, 'NOT_CONVERTED', '매입 등록된 줄이 아닙니다.');
        if (l.purchase_id === 5012 && P.get('mock_has_sales') === '1') return fail(409, 'PURCHASE_HAS_SALES', '이 매입은 판매에 쓰여 취소할 수 없습니다.', { detail: { sales: [{ id: 9001 }] } });
        l.status = 'CANCELLED';
        l.version++;
        recalc(dd);
        ev(dd, l, 'CANCEL', { reason: body.reason });
        return ok({ data: { line: lineView(dd, l), purchase_cancelled: l.purchase_id } });
      }
      if (method === 'PATCH') {
        if (need('write')) return forbid();
        if (body.version !== l.version) return fail(409, 'VERSION_CONFLICT', '다른 사람이 이 줄을 먼저 바꿨습니다.', { detail: { line: lineView(dd, l) } });
        Object.assign(l, { trade_date: body.trade_date, item_name_raw: body.item_name, grade_raw: body.grade, pkg_raw: body.spec, qty: String(body.qty), unit_price: body.unit_price, amount: body.amount ?? body.unit_price * body.qty, origin_name: body.origin });
        l.version++;
        l.status = 'HOLD';
        recalc(dd);
        ev(dd, l, 'EDIT');
        return ok({ data: { line: lineView(dd, l) } });
      }
    }
    if (b && /^\d+$/.test(b)) {
      const dd = docs.find((x) => x.id === Number(b));
      if (!dd) return fail(404, 'NOT_FOUND', '매입서를 찾지 못했습니다.');
      if (c === 'events') return ok(page(events.filter((e) => e.doc_id === dd.id), q));
      if (c === 'match') {
        if (need('write')) return forbid();
        if (dd.status === 'CANCELLED') return fail(409, 'DOC_CANCELLED', '취소한 매입서입니다.');
        return ok({ data: { docs: [dd], summary: { exact: dd.lines.filter((l) => l.match_result === 'EXACT').length, partial: dd.lines.filter((l) => l.match_result === 'PARTIAL').length, unmatched: dd.lines.filter((l) => l.match_result === 'UNMATCHED').length, skipped: dd.lines.filter((l) => l.status === 'CONVERTED').length } } });
      }
      if (c === 'cancel') {
        if (need('owner')) return forbid();
        const act = dd.lines.filter((l) => l.status === 'CONVERTED');
        if (act.length) return fail(409, 'DOC_HAS_CONVERSIONS', '매입 등록된 줄이 있어 매입서를 취소할 수 없습니다.', { detail: { lines: act.map((l) => ({ line_no: l.line_no, line_id: l.id })) } });
        dd.status = 'CANCELLED';
        ev(dd, null, 'DOC_CANCEL', { reason: body.reason });
        return ok({ data: dd });
      }
      return ok({ data: { ...dd, lines: dd.lines.map((l) => lineView(dd, l)) } });
    }
    if (!b && method === 'POST') {
      if (need('write')) return forbid();
      const isForm = body instanceof FormData;
      const dd = isForm
        ? addDoc({ doc_no: `D-NEW-${nextDoc}` }, [
            { name: '청양고추', key: 'PEPPER.CHEONGYANG', grade: '특', gn: 'SPECIAL', spec: '10kg 상자', kg: '10.000', qty: 10, price: 35000, status: body.get('auto_convert') === 'true' ? 'CONVERTED' : 'PENDING', mr: 'EXACT', score: 92, pid: body.get('auto_convert') === 'true' ? nextPurchase++ : null, mode: 'AUTO' },
            { name: '꽈리고추', key: 'PEPPER.KKWARI', grade: '상', gn: 'HIGH', spec: '4kg 상자', kg: '4.000', qty: 20, price: 18000, status: 'HOLD', mr: 'PARTIAL', score: 71, cc: 2, rc: ['MULTI_CANDIDATE'] },
            { name: '청량초', key: null, qty: 4, price: 30000, status: 'HOLD', mr: 'UNMATCHED', rc: ['ITEM_UNMAPPED'] },
          ])
        : addDoc({ doc_no: body.doc_no, doc_date: body.doc_date, supplier_partner_id: body.supplier_partner_id, supplier_name: body.supplier_partner_id === 8 ? 'B청과' : 'A청과' },
            body.lines.map((x) => ({ name: x.item_name, key: /청양/.test(x.item_name) ? 'PEPPER.CHEONGYANG' : /꽈리/.test(x.item_name) ? 'PEPPER.KKWARI' : null, grade: x.grade, spec: x.spec, qty: x.qty, price: x.unit_price, amount: x.amount, status: 'HOLD', mr: 'PARTIAL', score: 70, rc: ['LOW_SCORE'] })));
      ev(dd, null, 'UPLOAD');
      const lines = dd.lines;
      return json(201, { ok: true, data: { docs: [{ id: dd.id, status: dd.status, lines }], run_id: 120, summary: { exact: lines.filter((l) => l.match_result === 'EXACT').length, partial: lines.filter((l) => l.match_result === 'PARTIAL').length, unmatched: lines.filter((l) => l.match_result === 'UNMATCHED').length, auto_converted: lines.filter((l) => l.status === 'CONVERTED').length } } });
    }
    if (!b) {
      let rows = docs.map(({ lines, ...h }) => h);
      if (q.get('status')) rows = rows.filter((x) => q.get('status').split(',').includes(x.status));
      if (q.get('q')) rows = rows.filter((x) => x.doc_no.includes(q.get('q')));
      return ok(page(rows, q));
    }
  }
  // 그 밖의 기존 API — 빈 결과
  return W ? ok({}) : ok({ data: [], total: 0 });
}

export function installDevMock() {
  setRoleUser();
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.origin);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* 그대로 */
      }
    }
    await new Promise((r) => setTimeout(r, DELAY));
    const res = await route(method, url.pathname.replace(/^\/api/, ''), url.searchParams, body, init.headers || {});
    console.info('[devMock]', method, url.pathname + url.search, res.status);
    return res;
  };
  console.info('[devMock] T-203 개발용 목업 켜짐 — 서버 없이 화면만 확인합니다. 역할:', role());
}
