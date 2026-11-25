'use strict';
/**
 * T-203 매입서 템플릿·파일 읽기·줄 검증 (설계 3.1·4.3, R-116·R-117)
 *  - 템플릿·엑셀 읽기는 T-402 buildTemplate/parseWorkbook 을 정의 객체로 재사용(같은 모양·같은 규칙)
 *  - CSV: UTF-8(BOM 허용)·CP949 자동 판별, 첫 줄 머리글 이름으로 열 찾기(순서 무관), 따옴표·쉼표·줄바꿈 처리
 *  - 줄 검증 결과: errors[{field, code, message}] (저장 막음) · warnings[{code, message}] (저장 가능)
 *  - 단가·금액은 원 단위 정수만(소수면 NOT_INTEGER_WON — U-10). 금액이 비면 DB 가 ROUND(수량 × 단가)
 */
const { buildTemplate, parseWorkbook, readDate, rawCell, textOf, MAX_ROWS } = require('../excel-upload');
const N = require('./normalize');
const { maskName } = require('../auction/mask');

const DOC_DEF = {
  label: '매입서',
  columns: [
    { key: 'doc_no', header: '매입서번호', format: '글자', help: '법인 정산서·거래명세 번호(선택). 같은 제공처에 같은 번호는 한 번만. 비우면 제공처·거래일로 묶습니다.' },
    { key: 'trade_date', header: '거래일', required: true, format: '날짜', help: '경락일(경매 거래정산일). 2026-11-23 또는 엑셀 날짜' },
    { key: 'arrival_date', header: '입고일', format: '날짜', help: '선택' },
    { key: 'supplier', header: '제공처', required: true, format: '거래처명', help: '도매시장법인 등 매입처. 내 거래처 이름 그대로' },
    { key: 'item', header: '품목', required: true, format: '글자', help: '예: 청양고추, 꽈리, 빨강 파프리카' },
    { key: 'grade', header: '등급', format: '글자', help: '특·상·중·하·등외' },
    { key: 'spec', header: '규격', format: '글자', help: '예: 10kg 상자, 5kg 망, 4키로' },
    { key: 'qty', header: '수량', required: true, format: '숫자', help: '0보다 큰 수(소수 3자리까지)' },
    { key: 'unit_price', header: '단가', required: true, format: '금액(원)', help: '원 단위 정수(쉼표 가능)' },
    { key: 'amount', header: '금액', format: '금액(원)', help: '비우면 수량 × 단가. 다르면 경고(자동 매입 등록 안 함)' },
    { key: 'origin', header: '산지', format: '글자' },
    { key: 'shipper', header: '출하자', format: '글자', help: '저장할 때 가려서 저장합니다(예: 김*수)' },
    { key: 'auction_ref', header: '경매번호', format: '글자', help: '정산서의 경매(건) 번호 — 있으면 정확도가 크게 오릅니다' },
    { key: 'shipment_ref', header: '출하번호', format: '글자', help: '정산서의 출하번호(선택) — 경매번호와 함께 있으면 그 경락 한 건을 바로 찾습니다' },
    { key: 'buyer_code', header: '낙찰자번호', format: '글자', help: '비우면 내 중매인 번호' },
    { key: 'product', header: '판매툴품목', format: '품목명', help: '선택 — 비우면 대조 설정의 품목 연결을 씁니다' },
    { key: 'memo', header: '메모', format: '글자' },
  ],
  examples: [
    ['D-1123-01', '2026-11-23', '', '가명청과', '청양고추', '특', '10kg 상자', 12, 38000, 456000, '충남 청양', '', '', '', '', '', '예시 — 지우고 쓰세요'],
    ['D-1123-01', '2026-11-23', '', '가명청과', '꽈리고추', '특', '4kg 상자', 30, 21000, '', '전남 고흥', '', '', '', '', '', ''],
  ],
};

const HEADER_INDEX = new Map(DOC_DEF.columns.map((c) => [c.header.replace(/\s/g, ''), c.key]));

function templateBuffer() {
  return buildTemplate(DOC_DEF, {
    notes: [
      '[매입서] 업로드 작성 방법',
      "· '입력' 시트 1행(머리글)은 바꾸지 마세요. 열 순서는 바꿔도 됩니다. * 표시 열은 필수입니다.",
      '· 한 줄 = 매입서의 한 품목 줄. 같은 매입서번호(없으면 같은 제공처·거래일) 줄이 한 매입서로 묶입니다.',
      '· 단가·금액은 원 단위 정수입니다(소수 원은 오류). 금액이 수량×단가와 다르면 경고가 뜨고 자동 매입 등록을 하지 않습니다.',
      `· 최대 ${MAX_ROWS.toLocaleString('ko-KR')}줄 · 파일 2MB · .xlsx 또는 .csv(UTF-8·CP949).`,
      '· 저장은 전부 아니면 전무입니다. 같은 파일은 두 번 저장되지 않습니다(고쳐서 다시 올리세요).',
      '· 저장하면 경락 데이터와 바로 대조하고, 완전일치 줄은 매입 등록(매입전환)까지 합니다(설정에서 끌 수 있음).',
    ],
  });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function decodeCsv(buf) {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('euc-kr').decode(b); // CP949 (윈도우 엑셀 기본 CSV)
  }
}
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function parseCsv(buf, maxRows = MAX_ROWS) {
  const text = decodeCsv(buf);
  const table = parseCsvText(text);
  if (!table.length) return { error: '빈 파일입니다.' };
  const colOf = {};
  table[0].forEach((h, i) => {
    const k = HEADER_INDEX.get(String(h || '').replace(/\(필수\)|\*|\s/g, ''));
    if (k && !(k in colOf)) colOf[k] = i;
  });
  const missing = DOC_DEF.columns.filter((c) => c.required && !(c.key in colOf)).map((c) => c.header);
  if (missing.length) return { error: `필수 열이 없습니다: ${missing.join(', ')} — 템플릿 1행 머리글을 그대로 써 주세요.` };
  const rows = [];
  for (let r = 1; r < table.length; r += 1) {
    const vals = {};
    let any = false;
    for (const [k, i] of Object.entries(colOf)) {
      const v = table[r][i] == null ? '' : String(table[r][i]).trim();
      vals[k] = v === '' ? null : v;
      if (v !== '') any = true;
    }
    if (!any) continue;
    rows.push({ line: r + 1, vals });
    if (rows.length > maxRows) return { error: `한 번에 ${maxRows.toLocaleString('ko-KR')}줄까지 올릴 수 있습니다. 파일을 나눠 주세요.`, code: 'TOO_MANY_ROWS' };
  }
  if (!rows.length) return { error: '올릴 줄이 없습니다. 2행부터 입력해 주세요.' };
  return { rows };
}

/** 파일 → { kind:'EXCEL'|'CSV', rows } | { error, code } */
async function parseFile(file) {
  const name = Buffer.from(file.originalname || '', 'latin1').toString('utf8');
  const isCsv = /\.csv$/i.test(name) || /text\/csv|application\/vnd\.ms-excel/.test(file.mimetype || '') && !/\.xlsx$/i.test(name);
  const isXlsx = /\.xlsx$/i.test(name) || (file.buffer && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b);
  if (isCsv && !isXlsx) {
    const r = parseCsv(file.buffer);
    return r.error ? { error: r.error, code: r.code || 'BAD_FILE' } : { kind: 'CSV', rows: r.rows, fileName: name };
  }
  if (!isXlsx) return { error: '엑셀(.xlsx) 또는 CSV 파일만 올릴 수 있습니다.', code: 'BAD_FILE' };
  const r = await parseWorkbook(DOC_DEF, file.buffer);
  if (r.error) return { error: r.error, code: r.code || 'BAD_FILE' };
  // 엑셀 셀 값 → 원시 값(날짜는 parse 단계에서)
  return { kind: 'EXCEL', rows: r.rows.map((x) => ({ line: x.line, vals: Object.fromEntries(Object.entries(x.vals).map(([k, v]) => [k, rawCell(v)])) })), fileName: name };
}

// ---------------------------------------------------------------------------
// 줄 검증·정규화 — 파일 줄과 화면 입력 줄이 같은 함수를 쓴다
// ---------------------------------------------------------------------------
const E = (field, code, message) => ({ field, code, message });
const WARN_TEXT = {
  ITEM_UNMAPPED: (v) => `'${v}'를 품목으로 찾지 못했습니다. 저장은 되고 대조에서 미매칭으로 표시됩니다.`,
  GRADE_UNKNOWN: (v) => `등급 '${v}'를 알 수 없습니다(특·상·중·하·등외). 등급 없이 대조합니다.`,
  AMOUNT_MISMATCH: (v) => `금액이 수량×단가와 ${v}원 다릅니다(수수료·하역비?). 저장은 되지만 자동 매입 등록은 하지 않습니다.`,
  WEIGHT_UNKNOWN: () => '규격에서 중량(kg)을 찾지 못했습니다. kg 비교 없이 대조합니다.',
  NO_PRODUCT_LINK: () => '판매툴 품목 연결이 없습니다. 대조는 하지만 매입 등록 전에 품목을 연결해야 합니다.',
};
const w = (code, v) => ({ code, message: WARN_TEXT[code](v) });

/**
 * @param raw { doc_no, trade_date, arrival_date, supplier|supplier_partner_id, item, grade, spec, qty, unit_price, amount, origin, shipper, auction_ref, buyer_code, product|product_id }
 * @param lk  { today, partnerByName(name), partnerById(id), productByName(name), productById(id), mapping(doc ctx), productLink(itemKey, grade), corpOf(partnerId) }
 * @returns { errors, warnings, line, doc }
 */
async function buildLine(raw, lk) {
  const errors = [];
  const warnings = [];
  const txt = (v) => (v == null ? '' : textOf(v));
  // 날짜
  const td = readDate(raw.trade_date);
  if (td === undefined) errors.push(E('trade_date', 'BAD_DATE', '거래일 형식이 올바르지 않습니다(예: 2026-11-23).'));
  else if (td == null) errors.push(E('trade_date', 'REQUIRED', '거래일(경락일)을 입력하세요.'));
  else if (td > addDays(lk.today, 1)) errors.push(E('trade_date', 'FUTURE_DATE', '거래일이 미래입니다.'));
  let ad = null;
  if (raw.arrival_date != null && raw.arrival_date !== '') {
    ad = readDate(raw.arrival_date);
    if (!ad) { errors.push(E('arrival_date', 'BAD_DATE', '입고일 형식이 올바르지 않습니다(예: 2026-11-24).')); ad = null; } else if (td && ad < addDays(td, -7)) { errors.push(E('arrival_date', 'BAD_DATE', '입고일이 거래일보다 7일 넘게 이릅니다.')); ad = null; }
  }
  // 제공처
  let partner = null;
  if (raw.supplier_partner_id != null) {
    partner = await lk.partnerById(raw.supplier_partner_id);
    if (!partner) errors.push(E('supplier_partner_id', 'PARTNER_NOT_FOUND', '제공처를 내 거래처에서 찾을 수 없습니다.'));
  } else if (txt(raw.supplier)) {
    partner = await lk.partnerByName(txt(raw.supplier));
    if (!partner) errors.push(E('supplier', 'PARTNER_NOT_FOUND', `제공처 「${txt(raw.supplier)}」을(를) 내 거래처에서 찾을 수 없습니다.`));
  } else errors.push(E('supplier', 'REQUIRED', '제공처를 입력하세요.'));
  if (partner && !partner.purchasable) { errors.push(E('supplier', 'PARTNER_TYPE', `「${partner.name}」은(는) 매입 가능한 거래처 유형이 아닙니다.`)); }
  // 품목
  const itemName = txt(raw.item ?? raw.item_name);
  if (!itemName) errors.push(E('item', 'REQUIRED', '품목을 입력하세요.'));
  else if (itemName.length > 100) errors.push(E('item', 'TOO_LONG', '품목은 100자 이내로 입력하세요.'));
  // 수량·단가·금액
  const q = N.readQty(raw.qty);
  if (q.value == null && !q.error) errors.push(E('qty', 'REQUIRED', '수량을 입력하세요.'));
  else if (q.error === 'NOT_POSITIVE') errors.push(E('qty', 'NOT_POSITIVE', '수량은 0보다 커야 합니다.'));
  else if (q.error) errors.push(E('qty', 'NOT_NUMBER', '수량은 숫자로 입력하세요(소수 3자리까지).'));
  const p = N.readWon(raw.unit_price);
  if (p.value == null && !p.error) errors.push(E('unit_price', 'REQUIRED', '단가를 입력하세요.'));
  else if (p.error === 'NOT_INTEGER_WON') errors.push(E('unit_price', 'NOT_INTEGER_WON', `단가는 원 단위 정수로 입력하세요(${p.raw}).`));
  else if (p.error === 'NOT_POSITIVE') errors.push(E('unit_price', 'NOT_POSITIVE', '단가는 0 이상이어야 합니다.'));
  else if (p.error) errors.push(E('unit_price', 'NOT_NUMBER', '단가는 숫자로 입력하세요(쉼표 가능).'));
  const a = N.readWon(raw.amount);
  if (a.error === 'NOT_INTEGER_WON') errors.push(E('amount', 'NOT_INTEGER_WON', `금액은 원 단위 정수로 입력하세요(${a.raw}).`));
  else if (a.error) errors.push(E('amount', a.error === 'NOT_POSITIVE' ? 'NOT_POSITIVE' : 'NOT_NUMBER', '금액은 0 이상의 숫자로 입력하세요.'));
  const lens = [['doc_no', 50], ['origin', 50], ['auction_ref', 50], ['shipment_ref', 20], ['buyer_code', 20], ['grade', 30], ['spec', 50], ['memo', 200]];
  for (const [k, n] of lens) if (txt(raw[k]).length > n) errors.push(E(k, 'TOO_LONG', `${k} 은(는) ${n}자 이내로 입력하세요.`));
  // 판매툴 품목(선택)
  let product = null;
  if (raw.product_id != null && raw.product_id !== '') {
    product = await lk.productById(raw.product_id);
    if (!product) errors.push(E('product_id', 'PRODUCT_NOT_FOUND', '판매툴 품목을 찾을 수 없습니다(공용 품목·내 개인 품목).'));
  } else if (txt(raw.product)) {
    product = await lk.productByName(txt(raw.product));
    if (!product) errors.push(E('product', 'PRODUCT_NOT_FOUND', `판매툴 품목 「${txt(raw.product)}」을(를) 찾을 수 없습니다.`));
  }
  if (errors.length) return { errors, warnings, line: null };

  // 정규화
  const km = N.matchKeyword(N.nameCandidates(itemName), lk.mapping.keywordRules);
  const itemKey = km && lk.mapping.activeItems.has(km.item_key) ? km.item_key : null;
  if (!itemKey) warnings.push(w('ITEM_UNMAPPED', itemName));
  const gradeRaw = txt(raw.grade) || null;
  const gradeNorm = gradeRaw ? N.normalizeGrade(gradeRaw, lk.mapping.grades) : null;
  if (gradeRaw && !gradeNorm) warnings.push(w('GRADE_UNKNOWN', gradeRaw));
  const spec = txt(raw.spec) || null;
  const ps = N.parseSpec(spec);
  let kg = ps.kg;
  let ws = kg ? 'SOURCE' : 'UNKNOWN';
  if (!kg && ps.pkg) {
    const rule = lk.mapping.packRules.find((r) => r.item_key === itemKey && r.pkg_norm === ps.pkg) || lk.mapping.packRules.find((r) => r.item_key == null && r.pkg_norm === ps.pkg);
    if (rule) { kg = String(rule.unit_qty_kg); ws = 'RULE'; }
  }
  if (!kg) warnings.push(w('WEIGHT_UNKNOWN'));
  const amountDiff = a.value != null ? await lk.calcDiff(q.value, p.value, a.value) : '0';
  if (a.value != null && amountDiff !== '0') warnings.push(w('AMOUNT_MISMATCH', Number(amountDiff).toLocaleString('ko-KR')));
  const link = !product && itemKey ? lk.productLink(itemKey, gradeNorm) : null;
  if (!product && !link) warnings.push(w('NO_PRODUCT_LINK'));
  const corp = partner ? await lk.corpOf(partner.id) : null;
  const line = {
    trade_date: td, arrival_date: ad, item_name_raw: itemName, item_key: itemKey, grade_raw: gradeRaw, grade_norm: gradeNorm,
    pkg_raw: spec, pkg_norm: ps.pkg, unit_qty_kg: kg, weight_source: ws, qty: q.value, unit_price: p.value, amount: a.value, // amount null → DB ROUND
    origin_name: txt(raw.origin) || null, shipper_name_masked: maskName(txt(raw.shipper) || null), auction_ref: txt(raw.auction_ref).replace(/\s/g, '') || null,
    shipment_ref: txt(raw.shipment_ref).replace(/\s/g, '') || null,
    buyer_code: txt(raw.buyer_code).replace(/\s/g, '') || null, product_id: product ? product.id : null, corp_code: corp,
  };
  line.line_fingerprint = N.lineFingerprint(line);
  return { errors, warnings, line, doc: { doc_no: txt(raw.doc_no) || null, supplier: partner, memo: txt(raw.memo) || null } };
}

function addDays(ymd, n) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

module.exports = { DOC_DEF, templateBuffer, parseFile, parseCsv, parseCsvText, decodeCsv, buildLine };
