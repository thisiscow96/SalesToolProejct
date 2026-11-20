'use strict';
/**
 * T-402 엑셀 업로드 + 샘플 템플릿 — 모든 입력 프로세스
 *
 *  GET  /api/excel/:kind/template   템플릿(.xlsx) 내려받기 — 시트1 입력(머리글·필수 표시·예시), 시트2 작성 안내
 *  POST /api/excel/<kind>/preview   파일 검증 → 줄별 OK/오류 + 합계 (저장하지 않음)
 *  POST /api/excel/<kind>/commit    오류 0일 때만 저장 — 전부 아니면 전무(한 트랜잭션), 같은 파일 두 번 저장 막음
 *
 * 검증 규칙을 복제하지 않는다(지휘 지시):
 *  - 엑셀 한 줄을 기존 단건 API 본문으로 바꾼 뒤(이름 → id 찾기만 여기서), 기존 라우트 핸들러를 같은 프로세스 안에서 그대로 부른다.
 *    권한 미들웨어(lib/access.js)도 줄마다 다시 거친다 → 입력 직원의 할인 줄·외상 한도 확인 같은 본문 조건도 단건과 똑같이 막힌다.
 *  - 한 업로드 동안 pool.connect()/pool.query() 를 하나의 DB 연결(바깥 트랜잭션)로 돌린다(AsyncLocalStorage).
 *    핸들러의 BEGIN/COMMIT/ROLLBACK 은 SAVEPOINT/RELEASE/ROLLBACK TO 로 바뀐다. 줄마다 바깥 SAVEPOINT 를 하나 더 둬서
 *    오류 줄은 그 줄만 되돌리고 다음 줄을 계속 검사한다.
 *  - 미리보기는 실제로 저장해 본 뒤 전부 ROLLBACK → 앞 줄이 만든 재고·미수를 뒷줄이 그대로 본다(FIFO·배분 결과가 저장과 같다).
 *    저장은 같은 과정을 다시 하고 오류가 하나라도 있으면 ROLLBACK, 0이면 COMMIT.
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const ExcelJS = require('exceljs');
const multer = require('multer');

const MAX_ROWS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const INPUT_SHEET = '입력';
const GUIDE_SHEET = '작성 안내';

// ---------------------------------------------------------------------------
// 1. 업로드 동안 하나의 DB 연결로 돌리기
// ---------------------------------------------------------------------------
const bulkStore = new AsyncLocalStorage();

/** pool.connect / pool.query 를 업로드 문맥이면 그 연결로 돌린다. 업로드가 아니면 원래대로(다른 요청에 영향 없음) */
function patchPool(pool) {
  if (pool.__excelPatched) return;
  const origConnect = pool.connect.bind(pool);
  const origQuery = pool.query.bind(pool);
  pool.connect = function connect(cb) {
    const s = bulkStore.getStore();
    if (!s) return origConnect(cb);
    const lease = s.lease();
    if (typeof cb === 'function') {
      cb(null, lease, () => {});
      return undefined;
    }
    return Promise.resolve(lease);
  };
  pool.query = function query(...args) {
    const s = bulkStore.getStore();
    if (!s) return origQuery(...args);
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const p = s.client.query(...args);
    if (cb) {
      p.then((r) => cb(null, r), (e) => cb(e));
      return undefined;
    }
    return p;
  };
  pool.__excelPatched = true;
}

/** 핸들러가 받는 "연결" — BEGIN/COMMIT/ROLLBACK 을 SAVEPOINT 로 바꾼다 */
function makeBulkContext(client) {
  let seq = 0;
  const ctx = {
    client,
    lease() {
      const stack = [];
      const run = (sql) => client.query(sql);
      return {
        async query(text, ...rest) {
          if (typeof text === 'string') {
            const t = text.trim().replace(/;\s*$/, '').toUpperCase();
            if (t === 'BEGIN' || t.startsWith('BEGIN ') || t.startsWith('START TRANSACTION')) {
              const name = `xl_tx_${++seq}`;
              stack.push(name);
              await run(`SAVEPOINT ${name}`);
              return { rows: [], rowCount: 0, command: 'BEGIN' };
            }
            if (t === 'COMMIT' || t === 'END') {
              const name = stack.pop();
              if (name) await run(`RELEASE SAVEPOINT ${name}`);
              return { rows: [], rowCount: 0, command: 'COMMIT' };
            }
            if (t === 'ROLLBACK') {
              const name = stack.pop();
              if (name) {
                await run(`ROLLBACK TO SAVEPOINT ${name}`);
                await run(`RELEASE SAVEPOINT ${name}`);
              }
              return { rows: [], rowCount: 0, command: 'ROLLBACK' };
            }
          }
          return client.query(text, ...rest);
        },
        release() {},
        on() {},
        removeListener() {},
      };
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// 2. 셀 값 읽기 — 수식·날짜(엑셀 날짜 숫자)·쉼표 금액
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
function ymdOfUtcDate(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
/** exceljs 셀 값 → 원시 값(문자열·숫자·Date·null) */
function rawCell(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('error' in v) return { error: v.error };
    if ('result' in v) return rawCell(v.result); // 수식·공유 수식 → 계산 결과
    if ('formula' in v || 'sharedFormula' in v) return null; // 결과가 저장되지 않은 수식
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return rawCell(v.text); // 하이퍼링크
    return String(v);
  }
  return v;
}
function textOf(v) {
  const r = rawCell(v);
  if (r == null) return '';
  if (r instanceof Date) return ymdOfUtcDate(r);
  if (typeof r === 'object' && r.error) return '';
  return String(r).trim();
}
function isValidYmdParts(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
/** 날짜 → 'YYYY-MM-DD' | null. 날짜 셀(Date)·엑셀 날짜 숫자(1900 체계)·2026-11-21·2026.11.21·2026/11/21·20261121 */
function readDate(v) {
  const r = rawCell(v);
  if (r == null || r === '') return null;
  if (r instanceof Date) return Number.isNaN(r.getTime()) ? undefined : ymdOfUtcDate(r);
  if (typeof r === 'number') {
    if (!(r > 0 && r < 2958466)) return undefined;
    const ms = Math.round((Math.floor(r) - 25569) * 86400000); // 1899-12-30 기준
    return ymdOfUtcDate(new Date(ms));
  }
  const s = String(r).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})\.?(?:\s.*)?$/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) m = s.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일$/);
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!isValidYmdParts(y, mo, d)) return undefined;
  return `${y}-${pad2(mo)}-${pad2(d)}`;
}
/** 금액·수량 → 숫자 문자열 | null(빈칸) | undefined(형식 오류). 쉼표·공백·'원'·'₩' 허용 */
function readNumber(v, { maxDecimals = 2 } = {}) {
  const r = rawCell(v);
  if (r == null || r === '') return null;
  if (typeof r === 'number') {
    if (!Number.isFinite(r)) return undefined;
    const f = Number(r.toFixed(maxDecimals));
    return String(f);
  }
  if (r instanceof Date) return undefined;
  const s = String(r).replace(/[,\s원₩]/g, '');
  if (!s) return null;
  const re = new RegExp(`^-?\\d+(\\.\\d{1,${maxDecimals}})?$`);
  if (!re.test(s)) return undefined;
  return String(Number(s));
}
const YES = new Set(['y', 'yes', '예', '네', 'o', 'ㅇ', '1', 'true', '확인']);
const NO = new Set(['', 'n', 'no', '아니오', '아니요', 'x', '0', 'false']);
function readYesNo(v) {
  const s = textOf(v).toLowerCase();
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  return undefined;
}

// ---------------------------------------------------------------------------
// 3. 대상별 정의 (열·예시·본문 만들기)
// ---------------------------------------------------------------------------
const PARTNER_TYPE_IN = {
  매입처: 'supplier', 도매시장법인: 'supplier', 청과: 'supplier', supplier: 'supplier',
  판매처: 'customer', customer: 'customer',
  '같은 시장': 'same_market', 같은시장: 'same_market', 중매인: 'same_market', same_market: 'same_market',
  도매상: 'wholesaler', wholesaler: 'wholesaler',
  시장도매인: 'market_wholesaler', market_wholesaler: 'market_wholesaler',
  생산자: 'producer', 출하주: 'producer', 농가: 'producer', producer: 'producer',
};
const PAYEE_IN = { 제공처: 'supplier', 매입처: 'supplier', supplier: 'supplier', 생산자: 'producer', 출하주: 'producer', producer: 'producer' };
const RECEIVE_KIND_IN = { 수금: 'receive', 현금: 'receive', 입금: 'receive', receive: 'receive', 할인: 'discount', discount: 'discount' };
const PAY_KIND_IN = { 지급: 'pay', 현금: 'pay', pay: 'pay', 할인: 'discount', discount: 'discount' };
const PAY_METHOD_IN = { 현금: 'cash', cash: 'cash', 계좌이체: 'transfer', 이체: 'transfer', transfer: 'transfer', 어음: 'bill', bill: 'bill', 기타: 'other', other: 'other' };

/** 허용 값 표에서 고르기 — 없으면 undefined */
function pick(map, v) {
  const s = textOf(v);
  if (!s) return null;
  if (s in map) return map[s];
  const k = Object.keys(map).find((x) => x.toLowerCase() === s.toLowerCase() || x.replace(/\s/g, '') === s.replace(/\s/g, ''));
  return k ? map[k] : undefined;
}

class RowError extends Error {}
const rowErr = (m) => new RowError(m);

/** 공통 열 읽기 — 필수·형식 오류는 그 줄 오류 */
function need(row, key, label) {
  const s = textOf(row[key]);
  if (!s) throw rowErr(`${label}을(를) 입력하세요.`);
  return s;
}
function dateCol(row, key, label, required) {
  const d = readDate(row[key]);
  if (d === undefined) throw rowErr(`${label} 형식이 올바르지 않습니다(예: 2026-11-21).`);
  if (d == null && required) throw rowErr(`${label}을(를) 입력하세요.`);
  return d;
}
function numCol(row, key, label, required, opts) {
  const n = readNumber(row[key], opts);
  if (n === undefined) throw rowErr(`${label}은(는) 숫자로 입력하세요(쉼표 가능).`);
  if (n == null && required) throw rowErr(`${label}을(를) 입력하세요.`);
  return n;
}
function enumCol(row, key, label, map, allowed) {
  const v = pick(map, row[key]);
  if (v === undefined) throw rowErr(`${label} 값 「${textOf(row[key])}」은(는) 쓸 수 없습니다. 허용: ${allowed}`);
  return v;
}
function optText(row, key) {
  const s = textOf(row[key]);
  return s || undefined;
}
const won = (v) => Number(v || 0).toLocaleString('ko-KR');

// 날짜 예시는 실제 날짜 셀로 넣는다(엑셀이 날짜로 보여 주고, 올릴 때 날짜 숫자 처리도 같이 검사됨)
const D = (s) => new Date(`${s}T00:00:00Z`);

const KINDS = {
  partner: {
    label: '거래처',
    endpoint: ['POST', '/api/partners'],
    columns: [
      { key: 'name', header: '거래처명', required: true, format: '글자(100자 이내)', help: '내 거래처 안에서 같은 이름은 한 번만 등록됩니다.' },
      { key: 'type', header: '유형', required: true, format: '목록', allowed: '매입처, 판매처, 같은 시장, 도매상, 시장도매인, 생산자', help: '매입처 = 도매시장법인(청과). 생산자 = 출하주·농가.' },
      { key: 'contact', header: '담당자', format: '글자' },
      { key: 'phone', header: '전화', format: '글자', help: '예: 02-000-0000' },
      { key: 'email', header: '이메일', format: '이메일', help: '입금 안내 메일 받을 주소' },
      { key: 'location', header: '지역', format: '글자' },
      { key: 'address', header: '주소', format: '글자' },
      { key: 'origin_region', header: '산지', format: '글자', help: '생산자의 산지(예: 전남 해남). 매입에서 생산자를 고르면 이 산지가 기본으로 들어갑니다.' },
      { key: 'bank_name', header: '은행', format: '글자', help: '은행·계좌번호·예금주는 셋 다 쓰거나 셋 다 비웁니다.' },
      { key: 'bank_account', header: '계좌번호', format: '숫자와 -', help: '숫자와 하이픈만 4~50자' },
      { key: 'bank_holder', header: '예금주', format: '글자' },
      { key: 'credit_limit', header: '외상한도', format: '금액(원)', help: '비우면 한도 없음' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      ['서울청과', '매입처', '경매팀', '02-0000-0001', '', '가락시장', '서울 송파구 양재대로 932', '', '', '', '', '', '도매시장법인'],
      ['부농', '같은 시장', '', '', '', '가락시장', '', '', '', '', '', 3000000, '같은 시장 중매인 — 사고팔기·상계'],
      ['하나로마트', '판매처', '구매 담당', '', '', '서울', '', '', '', '', '', 5000000, '실수요처'],
      ['해남 농가', '생산자', '', '', '', '전남', '', '전남 해남', '농협', '301-0000-0000-01', '해남 농가', '', '출하주(예시 계좌)'],
    ],
    async toBody(row) {
      const body = {
        name: need(row, 'name', '거래처명'),
        type: enumCol(row, 'type', '유형', PARTNER_TYPE_IN, '매입처, 판매처, 같은 시장, 도매상, 시장도매인, 생산자'),
      };
      if (!body.type) throw rowErr('유형을 입력하세요.');
      for (const k of ['contact', 'phone', 'email', 'location', 'address', 'origin_region', 'memo']) {
        const v = optText(row, k);
        if (v !== undefined) body[k] = v;
      }
      // 계좌는 셋을 함께 보낸다 — 단건 API 규칙(셋 다 또는 셋 다 비움)을 그대로 받게
      body.bank_name = textOf(row.bank_name);
      body.bank_account = textOf(row.bank_account);
      body.bank_holder = textOf(row.bank_holder);
      const cl = numCol(row, 'credit_limit', '외상한도', false);
      if (cl != null) body.credit_limit = cl;
      return { body, summary: `${body.name} · ${textOf(row.type)}` };
    },
    resultOf: (data) => ({ id: data && data.id }),
  },

  product: {
    label: '품목(개인 품목)',
    endpoint: ['POST', '/api/products/personal'],
    columns: [
      { key: 'name', header: '품목명', required: true, format: '글자', help: '공용 품목이나 내 개인 품목과 같은 이름이면 등록되지 않습니다(그 품목을 그대로 쓰면 됩니다).' },
      { key: 'unit', header: '단위', format: '글자', help: '비우면 kg. 예: 10kg, 박스' },
      { key: 'category_large', header: '대분류', format: '글자' },
      { key: 'category_mid', header: '중분류', format: '글자' },
      { key: 'category_small', header: '소분류', format: '글자' },
      { key: 'memo', header: '메모', format: '글자' },
      { key: 'request_public', header: '공용 등록 요청', format: 'Y/N', allowed: 'Y, N', help: 'Y면 관리자에게 공용 품목 등록을 요청합니다.' },
    ],
    examples: [
      ['해남 꿀고구마', '10kg', '채소', '고구마', '', '해남 농가 출하', 'N'],
      ['부농 대추방울토마토', '5kg', '과일', '토마토', '', '', 'N'],
    ],
    async toBody(row) {
      const body = { name: need(row, 'name', '품목명') };
      for (const k of ['unit', 'category_large', 'category_mid', 'category_small', 'memo']) {
        const v = optText(row, k);
        if (v !== undefined) body[k] = v;
      }
      const rp = readYesNo(row.request_public);
      if (rp === undefined) throw rowErr('공용 등록 요청은 Y 또는 N으로 입력하세요.');
      if (rp) body.request_public = true;
      return { body, summary: `${body.name}${body.unit ? ` (${body.unit})` : ''}` };
    },
    resultOf: (data) => ({ id: data && data.id }),
  },

  purchase: {
    label: '매입',
    endpoint: ['POST', '/api/purchases'],
    columns: [
      { key: 'purchase_date', header: '매입일', required: true, format: '날짜', help: '2026-11-21 또는 엑셀 날짜' },
      { key: 'partner', header: '제공처', required: true, format: '거래처명', help: '물건을 사 온 곳(매입처·같은 시장·도매상 등). 내 거래처 이름 그대로' },
      { key: 'product', header: '품목', required: true, format: '품목명', help: '공용 품목 또는 내 개인 품목 이름 그대로' },
      { key: 'quantity', header: '수량', required: true, format: '숫자', help: '0보다 큰 수(소수 가능)' },
      { key: 'unit_price', header: '단가', required: true, format: '금액(원)', help: '쉼표 가능(예: 32,000)' },
      { key: 'producer', header: '생산자', format: '거래처명', help: '유형이 생산자인 거래처. 비워도 됩니다.' },
      { key: 'origin_region', header: '산지', format: '글자', help: '비우면 생산자의 산지가 들어갑니다.' },
      { key: 'payee', header: '지급 대상', format: '목록', allowed: '제공처, 생산자', help: '비우면 제공처. 생산자에게 직접 줄 때는 생산자 칸도 채웁니다.' },
      { key: 'source_name', header: '출처', format: '글자', help: '화면의 출처 칸(선택)' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      [D('2026-11-20'), '서울청과', '홍고추', 10, 32000, '해남 농가', '', '제공처', '', '경매 낙찰'],
      [D('2026-11-20'), '해남 농가', '해남 꿀고구마', 20, 15000, '해남 농가', '전남 해남', '생산자', '', '산지 직송'],
      [D('2026-11-20'), '부농', '청양고추', 5, 36000, '', '', '', '', ''],
    ],
    async toBody(row, ctx) {
      const date = dateCol(row, 'purchase_date', '매입일', true);
      const partner = await ctx.partner(need(row, 'partner', '제공처'), '제공처');
      const product = await ctx.product(need(row, 'product', '품목'));
      const quantity = numCol(row, 'quantity', '수량', true, { maxDecimals: 3 });
      const unitPrice = numCol(row, 'unit_price', '단가', true);
      const body = { purchase_date: date, partner_id: partner.id, product_id: product.id, quantity, unit_price: unitPrice };
      const prodName = textOf(row.producer);
      if (prodName) body.producer_id = (await ctx.partner(prodName, '생산자')).id;
      const origin = optText(row, 'origin_region');
      if (origin !== undefined) body.origin_region = origin;
      const payee = enumCol(row, 'payee', '지급 대상', PAYEE_IN, '제공처, 생산자');
      if (payee) body.payee = payee;
      const src = optText(row, 'source_name');
      if (src !== undefined) body.source_name = src;
      const memo = optText(row, 'memo');
      if (memo !== undefined) body.memo = memo;
      return { body, summary: `${date} · ${partner.name} · ${product.name} ${quantity} × ${won(unitPrice)}`, amount: Number(quantity) * Number(unitPrice) };
    },
    resultOf: (data) => ({ id: data && data.id }),
  },

  sale: {
    label: '판매(재고 기준)',
    endpoint: ['POST', '/api/sales'],
    columns: [
      { key: 'sale_date', header: '판매일', required: true, format: '날짜' },
      { key: 'partner', header: '판매처', required: true, format: '거래처명', help: '판매처·같은 시장·도매상·시장도매인' },
      { key: 'product', header: '품목', required: true, format: '품목명', help: '재고에서 먼저 들어온 매입부터 꺼냅니다(선입선출).' },
      { key: 'quantity', header: '수량', required: true, format: '숫자' },
      { key: 'unit_price', header: '단가', required: true, format: '금액(원)' },
      { key: 'source_partner', header: '매입처 한정', format: '거래처명', help: '이 매입처에서 산 재고만 꺼낼 때(선택)' },
      { key: 'memo', header: '메모', format: '글자' },
      { key: 'credit_confirmed', header: '외상한도 넘김 확인', format: 'Y/N', allowed: 'Y, N', help: '외상 한도를 넘는 판매를 저장하려면 Y(주인만)' },
    ],
    examples: [
      [D('2026-11-21'), '하나로마트', '홍고추', 4, 38000, '', '', 'N'],
      [D('2026-11-21'), '부농', '해남 꿀고구마', 5, 18000, '', '', 'N'],
      [D('2026-11-21'), '하나로마트', '청양고추', 2, 42000, '부농', '', 'N'],
    ],
    async toBody(row, ctx) {
      const date = dateCol(row, 'sale_date', '판매일', true);
      const partner = await ctx.partner(need(row, 'partner', '판매처'), '판매처');
      const product = await ctx.product(need(row, 'product', '품목'));
      const quantity = numCol(row, 'quantity', '수량', true, { maxDecimals: 3 });
      const unitPrice = numCol(row, 'unit_price', '단가', true);
      const item = { product_id: product.id, quantity, unit_price: unitPrice };
      const sp = textOf(row.source_partner);
      if (sp) item.partner_id_filter = (await ctx.partner(sp, '매입처 한정')).id;
      const body = { partner_id: partner.id, sale_date: date, items: [item] };
      const memo = optText(row, 'memo');
      if (memo !== undefined) body.memo = memo;
      const cc = readYesNo(row.credit_confirmed);
      if (cc === undefined) throw rowErr('외상한도 넘김 확인은 Y 또는 N으로 입력하세요.');
      if (cc) body.credit_confirmed = true;
      return { body, summary: `${date} · ${partner.name} · ${product.name} ${quantity} × ${won(unitPrice)}`, amount: Number(quantity) * Number(unitPrice) };
    },
    resultOf: (data) => ({ id: data && Array.isArray(data.sales) && data.sales[0] ? (data.sales[0].sale_id || data.sales[0].id) : null }),
  },

  convert: {
    label: '매입→판매 전환',
    endpoint: ['POST', '/api/purchases/convert-to-sales'],
    columns: [
      { key: 'purchase_id', header: '매입번호', format: '숫자', help: '매입정보의 번호. 비우면 매입일·매입처·품목으로 남은 수량이 있는 가장 오래된 매입을 찾습니다.' },
      { key: 'purchase_date', header: '매입일', format: '날짜', help: '매입번호를 비울 때 필수' },
      { key: 'purchase_partner', header: '매입처', format: '거래처명', help: '매입번호를 비울 때 필수' },
      { key: 'product', header: '품목', format: '품목명', help: '매입번호를 비울 때 필수' },
      { key: 'sale_date', header: '판매일', required: true, format: '날짜' },
      { key: 'partner', header: '판매처', required: true, format: '거래처명' },
      { key: 'quantity', header: '수량', required: true, format: '숫자' },
      { key: 'unit_price', header: '단가', required: true, format: '금액(원)' },
      { key: 'memo', header: '메모', format: '글자' },
      { key: 'credit_confirmed', header: '외상한도 넘김 확인', format: 'Y/N', allowed: 'Y, N', help: '외상 한도를 넘는 판매를 저장하려면 Y(주인만)' },
    ],
    examples: [
      ['', D('2026-11-20'), '서울청과', '홍고추', D('2026-11-21'), '하나로마트', 2, 38000, '전환 예시', 'N'],
    ],
    async toBody(row, ctx) {
      let purchaseId = null;
      let label = '';
      const pidText = textOf(row.purchase_id);
      const quantity = numCol(row, 'quantity', '수량', true, { maxDecimals: 3 });
      if (pidText) {
        if (!/^\d{1,9}$/.test(pidText)) throw rowErr('매입번호는 숫자로 입력하세요.');
        purchaseId = Number(pidText);
        label = `매입 #${purchaseId}`;
      } else {
        const pdate = dateCol(row, 'purchase_date', '매입일', false);
        const pname = textOf(row.purchase_partner);
        const prname = textOf(row.product);
        if (!pdate || !pname || !prname) throw rowErr('매입번호를 비우면 매입일·매입처·품목을 모두 입력하세요.');
        const pp = await ctx.partner(pname, '매입처');
        const pr = await ctx.product(prname);
        const r = await ctx.client.query(
          `SELECT p.id, p.quantity - COALESCE((SELECT SUM(a.quantity) FROM purchase_allocation a WHERE a.purchase_id = p.id), 0) AS remaining
             FROM purchase p
            WHERE p.user_id = $1 AND p.partner_id = $2 AND p.product_id = $3 AND p.purchase_date = $4 AND p.status <> 'cancelled'
            ORDER BY p.id`,
          [ctx.userId, pp.id, pr.id, pdate]
        );
        if (!r.rows.length) throw rowErr(`${pdate} ${pp.name} ${pr.name} 매입을 찾을 수 없습니다.`);
        const hit = r.rows.find((x) => Number(x.remaining) >= Number(quantity)) || r.rows.find((x) => Number(x.remaining) > 0);
        if (!hit) throw rowErr(`${pdate} ${pp.name} ${pr.name} 매입에 남은 수량이 없습니다.`);
        purchaseId = hit.id;
        label = `${pdate} ${pp.name} ${pr.name}(#${purchaseId})`;
      }
      const date = dateCol(row, 'sale_date', '판매일', true);
      const partner = await ctx.partner(need(row, 'partner', '판매처'), '판매처');
      const unitPrice = numCol(row, 'unit_price', '단가', true);
      const item = { purchase_id: purchaseId, partner_id: partner.id, quantity, unit_price: unitPrice, sale_date: date };
      const memo = optText(row, 'memo');
      if (memo !== undefined) item.memo = memo;
      const body = { items: [item] };
      const cc = readYesNo(row.credit_confirmed);
      if (cc === undefined) throw rowErr('외상한도 넘김 확인은 Y 또는 N으로 입력하세요.');
      if (cc) body.credit_confirmed = true;
      return { body, summary: `${label} → ${partner.name} ${quantity} × ${won(unitPrice)}`, amount: Number(quantity) * Number(unitPrice) };
    },
    resultOf: (data) => ({ id: Array.isArray(data) && data[0] ? data[0].sale_id : null }),
  },

  payment: {
    label: '수금',
    endpoint: ['POST', '/api/payments'],
    columns: [
      { key: 'paid_at', header: '수금일', required: true, format: '날짜' },
      { key: 'partner', header: '거래처', required: true, format: '거래처명' },
      { key: 'amount', header: '금액', required: true, format: '금액(원)', help: '오래된 미수 매출부터 자동으로 나눠 넣습니다.' },
      { key: 'entry_kind', header: '구분', format: '목록', allowed: '수금, 할인', help: '비우면 수금(현금). 할인 = 받지 않고 깎아 준 금액(주인만)' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      [D('2026-11-21'), '하나로마트', 100000, '수금', '계좌 입금'],
      [D('2026-11-21'), '하나로마트', 2000, '할인', '끝전 할인'],
    ],
    async toBody(row, ctx) {
      const date = dateCol(row, 'paid_at', '수금일', true);
      const partner = await ctx.partner(need(row, 'partner', '거래처'), '거래처');
      const amount = numCol(row, 'amount', '금액', true);
      if (!(Number(amount) > 0)) throw rowErr('금액은 0보다 커야 합니다.');
      const kind = enumCol(row, 'entry_kind', '구분', RECEIVE_KIND_IN, '수금, 할인') || 'receive';
      // 배분: 남은 미수가 있는 매출을 오래된 순으로(같은 업로드의 앞 줄 결과까지 본다)
      const r = await ctx.client.query(
        `SELECT id, (total_amount - returned_amount - paid_amount - discount_amount - offset_amount)::text AS due
           FROM sale WHERE user_id = $1 AND partner_id = $2 AND status <> 'cancelled'
            AND total_amount - returned_amount - paid_amount - discount_amount - offset_amount > 0
          ORDER BY sale_date, id`,
        [ctx.userId, partner.id]
      );
      let left = Math.round(Number(amount) * 100);
      const allocations = [];
      for (const s of r.rows) {
        if (left <= 0) break;
        const take = Math.min(left, Math.round(Number(s.due) * 100));
        if (take > 0) allocations.push({ sale_id: s.id, amount: (take / 100).toFixed(2) });
        left -= take;
      }
      if (left > 0) {
        const due = r.rows.reduce((t, s) => t + Math.round(Number(s.due) * 100), 0);
        throw rowErr(`${partner.name}의 남은 미수(${won(due / 100)}원)보다 큰 금액입니다.`);
      }
      const body = { partner_id: partner.id, amount, paid_at: date, allocations };
      if (kind !== 'receive') body.entry_kind = kind;
      const memo = optText(row, 'memo');
      if (memo !== undefined) body.memo = memo;
      return { body, summary: `${date} · ${partner.name} · ${kind === 'discount' ? '할인' : '수금'} ${won(amount)}원`, amount: Number(amount) };
    },
    resultOf: (data) => ({ id: data && data.id }),
  },

  supplier_payment: {
    label: '매입처 지급',
    endpoint: ['POST', '/api/supplier-payments'],
    columns: [
      { key: 'paid_at', header: '지급일', required: true, format: '날짜' },
      { key: 'partner', header: '매입처', required: true, format: '거래처명', help: '지급 대상인 거래처(생산자 포함)' },
      { key: 'amount', header: '금액', required: true, format: '금액(원)', help: '오래된 미지급 매입부터 자동으로 나눠 넣습니다.' },
      { key: 'kind', header: '구분', format: '목록', allowed: '지급, 할인', help: '비우면 지급(현금). 할인 = 깎아 받은 금액' },
      { key: 'method', header: '지급 방법', format: '목록', allowed: '현금, 계좌이체, 어음, 기타', help: '비우면 계좌이체. 할인 줄은 비웁니다.' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      [D('2026-11-21'), '서울청과', 200000, '지급', '계좌이체', ''],
      [D('2026-11-21'), '해남 농가', 1000, '할인', '', '끝전 할인'],
    ],
    async toBody(row, ctx) {
      const date = dateCol(row, 'paid_at', '지급일', true);
      const partner = await ctx.partner(need(row, 'partner', '매입처'), '매입처');
      const amount = numCol(row, 'amount', '금액', true);
      const kind = enumCol(row, 'kind', '구분', PAY_KIND_IN, '지급, 할인') || 'pay';
      const method = enumCol(row, 'method', '지급 방법', PAY_METHOD_IN, '현금, 계좌이체, 어음, 기타');
      const body = { partner_id: partner.id, amount, paid_at: date, kind };
      if (method) body.method = method;
      const memo = optText(row, 'memo');
      if (memo !== undefined) body.memo = memo;
      return { body, summary: `${date} · ${partner.name} · ${kind === 'discount' ? '할인' : '지급'} ${won(amount)}원`, amount: Number(amount) };
    },
    resultOf: (data) => ({ id: data && data.id }),
  },

  offset: {
    label: '상계',
    endpoint: ['POST', '/api/offsets'],
    columns: [
      { key: 'offset_at', header: '상계일', required: true, format: '날짜' },
      { key: 'partner', header: '거래처', required: true, format: '거래처명', help: '같은 시장·도매상·시장도매인 — 받을 돈과 줄 돈을 같은 금액만큼 지웁니다.' },
      { key: 'amount', header: '금액', required: true, format: '금액(원)', help: '오래된 미수·미지급부터 자동으로 나눠 넣습니다.' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      [D('2026-11-21'), '부농', 50000, '월말 상계'],
    ],
    async toBody(row, ctx) {
      const date = dateCol(row, 'offset_at', '상계일', true);
      const partner = await ctx.partner(need(row, 'partner', '거래처'), '거래처');
      const amount = numCol(row, 'amount', '금액', true);
      const body = { partner_id: partner.id, amount, offset_at: date };
      const memo = optText(row, 'memo');
      if (memo !== undefined) body.memo = memo;
      return { body, summary: `${date} · ${partner.name} · 상계 ${won(amount)}원`, amount: Number(amount) };
    },
    resultOf: (data) => ({ id: data && data.id }),
  },
};

/** 직원(입력) 업로드 허용 — 매입·판매·수금(현금)·전환. 거래처·품목·지급·상계는 주인만(지휘 지시). 품목은 단건 규칙(U-6)을 따른다 */
const INPUT_KINDS = new Set(['purchase', 'sale', 'convert', 'payment']);

// ---------------------------------------------------------------------------
// 4. 템플릿(.xlsx)
// ---------------------------------------------------------------------------
const HEAD_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
const REQ_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE8CC' } };

async function buildTemplate(kind) {
  const def = KINDS[kind];
  const wb = new ExcelJS.Workbook();
  wb.creator = '판매툴';
  wb.created = new Date(Date.UTC(2026, 10, 21));
  const ws = wb.addWorksheet(INPUT_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = def.columns.map((c) => ({
    header: c.required ? `${c.header}*` : c.header,
    key: c.key,
    width: Math.max(10, c.header.length * 2 + 6, c.format === '날짜' ? 13 : 0, c.format === '거래처명' || c.format === '품목명' ? 16 : 0),
    style: c.format === '날짜' ? { numFmt: 'yyyy-mm-dd' } : c.format === '금액(원)' ? { numFmt: '#,##0' } : {},
  }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  def.columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.fill = c.required ? REQ_FILL : HEAD_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.note = [c.required ? '필수' : '선택', c.format, c.allowed ? `허용: ${c.allowed}` : '', c.help || ''].filter(Boolean).join('\n');
  });
  for (const ex of def.examples) ws.addRow(ex);
  // 목록 값은 드롭다운으로(2~1001행)
  def.columns.forEach((c, i) => {
    if (!c.allowed) return;
    const col = ws.getColumn(i + 1).letter;
    for (let r = 2; r <= MAX_ROWS + 1; r += 1) {
      ws.getCell(`${col}${r}`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`"${c.allowed.split(',').map((s) => s.trim()).join(',')}"`],
        showErrorMessage: true, errorTitle: '허용 값', error: `허용: ${c.allowed}`,
      };
    }
  });

  const g = wb.addWorksheet(GUIDE_SHEET);
  g.columns = [
    { header: '열 이름', key: 'h', width: 18 },
    { header: '필수', key: 'r', width: 7 },
    { header: '형식', key: 'f', width: 14 },
    { header: '허용 값', key: 'a', width: 36 },
    { header: '설명', key: 'd', width: 70 },
  ];
  g.getRow(1).font = { bold: true };
  g.getRow(1).eachCell((cell) => { cell.fill = HEAD_FILL; });
  for (const c of def.columns) g.addRow({ h: c.header, r: c.required ? '필수' : '', f: c.format, a: c.allowed || '', d: c.help || '' });
  g.addRow({});
  const notes = [
    `[${def.label}] 업로드 작성 방법`,
    `· '${INPUT_SHEET}' 시트의 1행(머리글)은 바꾸지 마세요. 열 순서는 바꿔도 됩니다. * 표시(주황) 열은 필수입니다.`,
    '· 2행부터 한 줄에 한 건씩 씁니다. 예시 줄은 지우고 쓰세요(그대로 올리면 예시도 저장됩니다).',
    '· 거래처·품목은 화면에 등록된 이름 그대로 씁니다(앞뒤 공백·대소문자는 무시). 없는 이름은 그 줄이 오류가 됩니다.',
    '· 날짜는 엑셀 날짜 또는 2026-11-21 / 2026.11.21 / 20261121. 금액은 쉼표를 넣어도 됩니다(32,000).',
    `· 최대 ${MAX_ROWS.toLocaleString('ko-KR')}줄 · 파일 2MB. 올리면 먼저 미리보기로 줄별 결과를 보여 주고, 오류가 하나도 없을 때만 [저장]할 수 있습니다.`,
    '· 저장은 전부 아니면 전무입니다(한 줄이라도 실패하면 아무것도 저장하지 않음). 같은 파일은 두 번 저장되지 않습니다.',
  ];
  for (const n of notes) {
    const r = g.addRow({ h: n });
    g.mergeCells(`A${r.number}:E${r.number}`);
    if (n.startsWith('[')) r.font = { bold: true };
  }
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// 5. 파일 읽기
// ---------------------------------------------------------------------------
const normHeader = (s) => String(s || '').replace(/\(필수\)|\*|\s/g, '').trim();

async function parseWorkbook(kind, buffer) {
  const def = KINDS[kind];
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    return { error: '엑셀(.xlsx) 파일을 읽을 수 없습니다. 템플릿을 내려받아 .xlsx 로 저장해 올려 주세요.' };
  }
  const ws = wb.getWorksheet(INPUT_SHEET) || wb.worksheets[0];
  if (!ws) return { error: '시트가 없습니다.' };
  const head = ws.getRow(1);
  const colOf = {};
  const byHeader = new Map(def.columns.map((c) => [normHeader(c.header), c.key]));
  head.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const key = byHeader.get(normHeader(textOf(cell.value)));
    if (key && !(key in colOf)) colOf[key] = colNumber;
  });
  const missing = def.columns.filter((c) => c.required && !(c.key in colOf)).map((c) => c.header);
  if (missing.length) {
    return { error: `필수 열이 없습니다: ${missing.join(', ')} — 템플릿 1행 머리글을 그대로 써 주세요.` };
  }
  const rows = [];
  const last = ws.actualRowCount ? ws.rowCount : 0;
  for (let r = 2; r <= last; r += 1) {
    const row = ws.getRow(r);
    const vals = {};
    let any = false;
    for (const [key, col] of Object.entries(colOf)) {
      const v = row.getCell(col).value;
      vals[key] = v;
      const raw = rawCell(v);
      if (raw != null && String(raw instanceof Date ? 'd' : raw).trim() !== '') any = true;
    }
    if (!any) continue; // 빈 줄은 건너뜀
    rows.push({ line: r, vals });
    if (rows.length > MAX_ROWS) return { error: `한 번에 ${MAX_ROWS.toLocaleString('ko-KR')}줄까지 올릴 수 있습니다. 파일을 나눠 올려 주세요.` };
  }
  if (!rows.length) return { error: '올릴 줄이 없습니다. 2행부터 입력해 주세요.' };
  return { rows };
}

// ---------------------------------------------------------------------------
// 6. 같은 프로세스 안에서 기존 라우트 부르기
// ---------------------------------------------------------------------------
function findRoute(app, method, path) {
  const m = method.toLowerCase();
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[m]) {
      return layer.route.stack.filter((l) => !l.method || l.method === m).map((l) => l.handle);
    }
  }
  return null;
}

function fakeReqRes(parent, method, path, body) {
  const headers = {
    'content-type': 'application/json',
    ...(parent.headers.authorization ? { authorization: parent.headers.authorization } : {}),
    ...(parent.headers['user-agent'] ? { 'user-agent': parent.headers['user-agent'] } : {}),
  };
  const req = {
    method, url: path, originalUrl: path, path, baseUrl: '', body, query: {}, params: {}, headers,
    ip: parent.ip, ips: parent.ips, socket: parent.socket, connection: parent.connection, protocol: parent.protocol,
    get(name) { return headers[String(name).toLowerCase()]; },
    header(name) { return headers[String(name).toLowerCase()]; },
    excelBulk: true,
  };
  const res = {
    statusCode: 200, body: undefined, headersSent: false, locals: {},
    status(c) { this.statusCode = c; return this; },
    set() { return this; }, setHeader() { return this; }, getHeader() { return undefined; }, type() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
    sendStatus(c) { this.statusCode = c; this.headersSent = true; return this; },
    end() { this.headersSent = true; return this; },
  };
  return { req, res };
}

async function invoke(app, authorize, parent, method, path, body) {
  const handlers = findRoute(app, method, path);
  if (!handlers) throw new Error(`route not found ${method} ${path}`);
  const { req, res } = fakeReqRes(parent, method, path, body);
  let passed = false;
  await authorize(req, res, () => { passed = true; });
  if (!passed) return res;
  for (const h of handlers) {
    let nextCalled = false;
    // eslint-disable-next-line no-await-in-loop
    await h(req, res, () => { nextCalled = true; });
    if (res.headersSent || !nextCalled) break;
  }
  if (!res.headersSent) { res.statusCode = 500; res.body = { ok: false, message: '처리 결과가 없습니다.' }; }
  return res;
}

// ---------------------------------------------------------------------------
// 7. 라우트
// ---------------------------------------------------------------------------
function registerExcelRoutes(app, deps) {
  const { pool, authorize, getUserId, recordAudit } = deps;
  patchPool(pool);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
  const receiveFile = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE', message: '파일은 2MB까지 올릴 수 있습니다.' });
    return res.status(400).json({ ok: false, code: 'BAD_FILE', message: '파일을 받지 못했습니다. 엑셀 파일 하나를 골라 주세요.' });
  });

  app.get('/api/excel/:kind/template', async (req, res) => {
    const kind = String(req.params.kind || '');
    const def = KINDS[kind];
    if (!def) return res.status(404).json({ ok: false, message: '없는 업로드 종류입니다.' });
    try {
      const buf = await buildTemplate(kind);
      const name = `엑셀템플릿_${def.label.replace(/[()→\s]/g, '')}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="template_${kind}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
      res.send(Buffer.from(buf));
    } catch (err) {
      console.error('excel template error:', err);
      res.status(500).json({ ok: false, message: '템플릿을 만들지 못했습니다.' });
    }
  });

  async function run(req, res, kind, commit) {
    const def = KINDS[kind];
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ ok: false, code: 'NO_FILE', message: '엑셀 파일을 골라 주세요.' });
    const parsed = await parseWorkbook(kind, file.buffer);
    if (parsed.error) return res.status(400).json({ ok: false, code: 'BAD_FILE', message: parsed.error });
    const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
    const fileName = Buffer.from(file.originalname || '', 'latin1').toString('utf8').slice(0, 200) || null;
    const started = Date.now();

    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      console.error('[DB] connect error:', err.message);
      return res.status(503).json({ ok: false, message: 'DB 연결이 잠시 원활하지 않습니다. 잠시 후 다시 시도해 주세요.' });
    }
    const ctx = makeBulkContext(client);
    try {
      await client.query('BEGIN');
      // 같은 회원의 업로드 저장을 줄 세운다(같은 파일 동시 저장·재고 경합)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`excel-upload:${userId}`]);
      const dup = await client.query(
        `SELECT id, kind, row_count, created_at FROM excel_upload WHERE user_id = $1 AND file_hash = $2 LIMIT 1`,
        [userId, hash]
      );
      const duplicate = dup.rows[0]
        ? { id: dup.rows[0].id, kind: dup.rows[0].kind, row_count: dup.rows[0].row_count, created_at: dup.rows[0].created_at }
        : null;
      if (duplicate && commit) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, code: 'DUPLICATE_FILE', message: '이미 저장한 파일입니다. 같은 내용을 다시 넣으려면 파일을 고쳐서 올리세요.', duplicate });
      }

      // 이름 → id 찾기(같은 업로드 안에서 캐시)
      const pCache = new Map();
      const prCache = new Map();
      const lookup = {
        client,
        userId,
        async partner(name, label) {
          const k = name.trim().toLowerCase();
          if (!pCache.has(k)) {
            const r = await client.query(
              `SELECT id, name, type::text AS type FROM account WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) ORDER BY id LIMIT 1`,
              [userId, name]
            );
            pCache.set(k, r.rows[0] || null);
          }
          const p = pCache.get(k);
          if (!p) throw rowErr(`${label} 「${name}」을(를) 내 거래처에서 찾을 수 없습니다.`);
          return p;
        },
        async product(name) {
          const k = name.trim().toLowerCase();
          if (!prCache.has(k)) {
            const r = await client.query(
              `SELECT id, name FROM product WHERE (owner_user_id IS NULL OR owner_user_id = $1) AND lower(btrim(name)) = lower(btrim($2))
                ORDER BY (owner_user_id IS NULL) DESC, id LIMIT 1`,
              [userId, name]
            );
            prCache.set(k, r.rows[0] || null);
          }
          const p = prCache.get(k);
          if (!p) throw rowErr(`품목 「${name}」을(를) 찾을 수 없습니다(공용 품목·내 개인 품목).`);
          return p;
        },
      };

      const results = [];
      let i = 0;
      for (const row of parsed.rows) {
        i += 1;
        const sp = `xl_row_${i}`;
        // eslint-disable-next-line no-await-in-loop
        await client.query(`SAVEPOINT ${sp}`);
        let out;
        try {
          // eslint-disable-next-line no-await-in-loop
          const mapped = await def.toBody(row.vals, lookup);
          const [method, path] = def.endpoint;
          // eslint-disable-next-line no-await-in-loop
          const r = await bulkStore.run(ctx, () => invoke(app, authorize, req, method, path, mapped.body));
          const okRes = r.statusCode < 400 && r.body && r.body.ok !== false;
          if (okRes) {
            out = { line: row.line, ok: true, summary: mapped.summary, amount: mapped.amount ?? null, ...def.resultOf(r.body.data) };
            if (r.body.credit_warnings) out.warning = '외상 한도를 넘었습니다(확인 Y로 저장).';
          } else {
            let msg = (r.body && r.body.message) || `처리하지 못했습니다(${r.statusCode}).`;
            if (r.body && r.body.code === 'CREDIT_LIMIT') msg += ' — 그래도 저장하려면 「외상한도 넘김 확인」 열에 Y(주인만).';
            out = { line: row.line, ok: false, summary: mapped.summary, amount: mapped.amount ?? null, message: msg, code: r.body && r.body.code };
          }
        } catch (err) {
          if (err instanceof RowError) out = { line: row.line, ok: false, message: err.message };
          else {
            console.error('excel row error:', err);
            out = { line: row.line, ok: false, message: '이 줄을 처리하는 중 오류가 났습니다.' };
          }
        }
        // eslint-disable-next-line no-await-in-loop
        if (out.ok) await client.query(`RELEASE SAVEPOINT ${sp}`);
        else {
          // eslint-disable-next-line no-await-in-loop
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          // eslint-disable-next-line no-await-in-loop
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          // 오류 줄 뒤의 이름 찾기 캐시는 되돌린 내용(예: 같은 파일의 거래처)을 믿지 않게 비운다
          pCache.clear();
          prCache.clear();
        }
        results.push(out);
      }
      const okCount = results.filter((r) => r.ok).length;
      const errCount = results.length - okCount;
      const amountSum = results.reduce((t, r) => t + (r.ok && r.amount ? Number(r.amount) : 0), 0);
      const summary = {
        kind, label: def.label, file_name: fileName, file_hash: hash, total: results.length, ok: okCount, errors: errCount,
        amount_total: Math.round(amountSum * 100) / 100, duplicate, elapsed_ms: 0,
      };

      if (!commit || errCount > 0 || duplicate) {
        await client.query('ROLLBACK');
        summary.elapsed_ms = Date.now() - started;
        const status = commit ? 422 : 200;
        return res.status(status).json({
          ok: !commit, code: commit ? 'HAS_ERRORS' : undefined,
          message: commit ? `오류가 ${errCount}줄 있어 아무것도 저장하지 않았습니다.` : undefined,
          saved: false, summary, rows: results,
        });
      }

      const staffId = req.auth && req.auth.staffId ? req.auth.staffId : null;
      const up = await client.query(
        `INSERT INTO excel_upload (user_id, kind, file_hash, file_name, row_count, amount_total, result, created_by_staff_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING id, created_at`,
        [userId, kind, hash, fileName, okCount, summary.amount_total,
          JSON.stringify(results.map((r) => ({ line: r.line, id: r.id ?? null, summary: r.summary }))), staffId]
      );
      const uploadId = up.rows[0].id;
      // 변경 이력(019): "엑셀 업로드 N건" 한 줄 — 건별 행은 excel_upload.result 와 각 원천 행(매입·매출·수금 …)에 남는다
      await recordAudit(client, {
        userId, entityType: 'upload', entityId: uploadId, action: 'upload', partnerId: null,
        before: null, after: { kind: def.label, rows: okCount, file_name: fileName, amount_total: summary.amount_total },
        note: `엑셀 업로드 ${def.label} ${okCount}건`, actorStaffId: staffId || undefined,
      });
      await client.query('COMMIT');
      summary.elapsed_ms = Date.now() - started;
      return res.status(201).json({ ok: true, saved: true, upload_id: uploadId, summary, rows: results });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        return res.status(409).json({ ok: false, code: 'DUPLICATE_FILE', message: '이미 저장한 파일입니다. 같은 내용을 다시 넣으려면 파일을 고쳐서 올리세요.' });
      }
      console.error('excel upload error:', err);
      return res.status(500).json({ ok: false, message: '엑셀 업로드를 처리하지 못했습니다.' });
    } finally {
      client.release();
    }
  }

  for (const kind of Object.keys(KINDS)) {
    app.post(`/api/excel/${kind}/preview`, receiveFile, (req, res) => run(req, res, kind, false));
    app.post(`/api/excel/${kind}/commit`, receiveFile, (req, res) => run(req, res, kind, true));
  }
}

module.exports = {
  registerExcelRoutes, buildTemplate, parseWorkbook, KINDS, INPUT_KINDS, MAX_ROWS, MAX_BYTES,
  readDate, readNumber, textOf, patchPool,
};
