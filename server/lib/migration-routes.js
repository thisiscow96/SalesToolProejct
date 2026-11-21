'use strict';
/**
 * T-403 데이터 이관(마이그레이션) — 설계: AI 팀 산출물 T-403_데이터이관_설계.md
 *
 * 이관 묶음(migration_batch) = 기준일(cutover, D) 1개 + 대상별 파일 7종. 상태 draft → saved → rolled_back
 *   ① partner 거래처   ② product 품목   ③ opening_ar 기초 미수   ④ opening_ap 기초 미지급
 *   ⑤ opening_stock 기초 재고   ⑥ history 과거 거래(기록)   ⑦ disposal 폐기(D 이전 = 기록, D 이후 = 재고 차감)
 *
 * 저장 순서(한 트랜잭션, 전부 아니면 전무): ① → ② → ③ → ④ → ⑤ → ⑦ → ⑥ (⑦ D 이후 폐기는 ⑤ 이관 재고에서 빠져야 해서 ⑤ 다음)
 * 검증 = 같은 순서로 실제 저장해 본 뒤 ROLLBACK(T-402 미리보기와 같은 방식) → 검증 결과 = 저장 결과
 *
 * T-402 재사용: 템플릿(buildTemplate)·파일 읽기(parseWorkbook)·셀 읽기·한 연결 실행(bulkStore/makeBulkContext)·
 *   기존 단건 핸들러 호출(invoke — 거래처 POST /api/partners, 품목 POST /api/products(/personal), 폐기 POST /api/disposals).
 *   기초 미수·미지급·이관 재고·이관 기록은 해당 단건 API가 없으므로 여기서 여러 줄 INSERT(500줄 단위)로 저장한다.
 *
 * 라우트(전부 주인만 — lib/access.js R-79~R-91)
 *   GET    /api/migrations/template/:kind     템플릿 7종
 *   GET    /api/migrations                    내 묶음 목록
 *   POST   /api/migrations                    묶음 만들기 {cutover_date, memo}
 *   GET    /api/migrations/:id                묶음 상세
 *   DELETE /api/migrations/:id                draft 삭제
 *   POST   /api/migrations/:id/files/:kind    파일 올리기(교체)
 *   DELETE /api/migrations/:id/files/:kind    파일 빼기
 *   POST   /api/migrations/:id/validate       전체 검증(저장해 본 뒤 ROLLBACK)
 *   POST   /api/migrations/:id/commit         저장 {confirm_warnings}
 *   GET    /api/migrations/:id/rollback-check 되돌리기 가능 여부·막는 참조
 *   POST   /api/migrations/:id/rollback       되돌리기 {reason}
 *   GET    /api/migrations/:id/reconcile      대조 리포트(?format=xlsx)
 *   GET    /api/migration-history             이관 기록 조회
 */
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const multer = require('multer');
const xl = require('./excel-upload');
const { parseListOptions, runList } = require('./list-query');

const MAX_ROWS = 5000; // U-403-02
const MAX_BYTES = 5 * 1024 * 1024;
const CHUNK = 500;
const SYSTEM_PRODUCT_NAME = '이관 기초 잔액';
const SALE_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);
const PAY_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer']);
const ORDER = ['partner', 'product', 'opening_ar', 'opening_ap', 'opening_stock', 'disposal', 'history'];
const HISTORY_KIND_IN = {
  매입: 'purchase', purchase: 'purchase', 매출: 'sale', 판매: 'sale', sale: 'sale',
  수금: 'receipt', 입금: 'receipt', receipt: 'receipt', 지급: 'supplier_payment', supplier_payment: 'supplier_payment',
};
const HISTORY_KIND_LABEL = { purchase: '매입', sale: '매출', receipt: '수금', supplier_payment: '지급', disposal: '폐기' };

const { textOf, readNumber, readDate, rowErr, RowError, need, dateCol, numCol, optText, won } = xl;
const D = (s) => new Date(`${s}T00:00:00Z`);

// ---------------------------------------------------------------------------
// 1. 대상 정의 (템플릿 열·예시) — 예시는 가락시장, 기준일 2026-11-01 기준
// ---------------------------------------------------------------------------
const CODE_COL = { key: 'external_code', header: '기존 코드', format: '글자(50자 이내)', help: '쓰던 장부·프로그램의 거래처/품목 코드(선택). 뒤 파일에서 이름 대신 이 코드로 찾을 수 있습니다.' };
const MK = {
  partner: {
    label: '① 거래처',
    file: '이관_1_거래처',
    columns: [...xl.KINDS.partner.columns, CODE_COL],
    examples: xl.KINDS.partner.examples.map((r, i) => [...r, `C-00${i + 1}`]),
  },
  product: {
    label: '② 품목',
    file: '이관_2_품목',
    columns: [
      { key: 'name', header: '품목명', required: true, format: '글자', help: '공용 품목·내 품목과 이름이 같으면 새로 만들지 않고 그 품목을 씁니다(기존 사용).' },
      { key: 'unit', header: '단위', format: '글자', help: '비우면 kg' },
      { key: 'category_large', header: '대분류', format: '글자' },
      { key: 'category_mid', header: '중분류', format: '글자' },
      { key: 'category_small', header: '소분류', format: '글자' },
      { key: 'memo', header: '메모', format: '글자' },
      CODE_COL,
      { key: 'is_public', header: '공용', format: 'Y/N', allowed: 'Y, N', help: 'Y = 모든 중매인이 쓰는 공용 품목(관리자만). 비우면 N(내 개인 품목)' },
    ],
    examples: [
      ['해남 꿀고구마', '10kg', '채소', '고구마', '', '해남 농가 출하', 'P-101', 'N'],
      ['부농 대추방울토마토', '5kg', '과일', '토마토', '', '', 'P-102', 'N'],
    ],
  },
  opening_ar: {
    label: '③ 기초 미수',
    file: '이관_3_기초미수',
    columns: [
      { key: 'partner', header: '거래처', required: true, format: '거래처명 또는 기존 코드', help: '판매처·같은 시장·도매상·시장도매인' },
      { key: 'amount', header: '미수 금액', required: true, format: '금액(원)', help: '기준일 시작 시점에 받을 돈(0보다 큼)' },
      { key: 'orig_date', header: '원래 매출일', format: '날짜', help: '기준일보다 앞. 미수 연령을 이 날짜로 셉니다. 비우면 기준일 전날로 넣습니다(연령이 짧게 보임).' },
      { key: 'external_ref', header: '원 전표번호', format: '글자(50자 이내)', help: '같은 번호는 두 번 이관되지 않습니다.' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      ['하나로마트', 300000, D('2026-10-01'), 'S-0001', '10월 초 외상'],
      ['하나로마트', 200000, D('2026-10-20'), 'S-0002', ''],
      ['부농', 120000, D('2026-10-25'), 'S-0003', '같은 시장'],
    ],
  },
  opening_ap: {
    label: '④ 기초 미지급',
    file: '이관_4_기초미지급',
    columns: [
      { key: 'partner', header: '지급 대상', required: true, format: '거래처명 또는 기존 코드', help: '매입처·같은 시장·도매상·시장도매인·생산자' },
      { key: 'amount', header: '미지급 금액', required: true, format: '금액(원)', help: '기준일 시작 시점에 줄 돈(0보다 큼)' },
      { key: 'orig_date', header: '원래 매입일', format: '날짜', help: '기준일보다 앞. 비우면 기준일 전날' },
      { key: 'external_ref', header: '원 전표번호', format: '글자(50자 이내)' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      ['서울청과', 400000, D('2026-10-28'), 'B-0001', '경매 대금'],
      ['해남 농가', 150000, D('2026-10-30'), 'B-0002', '산지 직송 대금'],
    ],
  },
  opening_stock: {
    label: '⑤ 기초 재고',
    file: '이관_5_기초재고',
    columns: [
      { key: 'product', header: '품목', required: true, format: '품목명 또는 기존 코드' },
      { key: 'quantity', header: '수량', required: true, format: '숫자', help: '기준일 시작 시점에 남은 수량' },
      { key: 'unit_price', header: '원가 단가', required: true, format: '금액(원)', help: '판매 이익을 계산할 원가' },
      { key: 'in_date', header: '입고일', required: true, format: '날짜', help: '기준일보다 앞. 오래된 입고부터 팝니다(선입선출)·경과일 기준' },
      { key: 'partner', header: '제공처', required: true, format: '거래처명 또는 기존 코드', help: '산 곳(매입처 등). 모르면 "기타 매입처" 거래처를 만들어 쓰세요.' },
      { key: 'producer', header: '생산자', format: '거래처명 또는 기존 코드' },
      { key: 'origin_region', header: '산지', format: '글자', help: '비우면 생산자의 산지' },
      { key: 'external_ref', header: '원 전표번호', format: '글자(50자 이내)' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      ['홍고추', 10, 30000, D('2026-10-28'), '서울청과', '', '', 'L-0001', ''],
      ['해남 꿀고구마', 20, 15000, D('2026-10-30'), '해남 농가', '해남 농가', '전남 해남', 'L-0002', ''],
    ],
  },
  history: {
    label: '⑥ 과거 거래(기록)',
    file: '이관_6_과거거래',
    columns: [
      { key: 'kind', header: '구분', required: true, format: '목록', allowed: '매입, 매출, 수금, 지급' },
      { key: 'date', header: '날짜', required: true, format: '날짜', help: '기준일보다 앞' },
      { key: 'partner', header: '거래처', required: true, format: '거래처명 또는 기존 코드', help: '등록 안 된 거래처면 이름만 기록합니다(경고).' },
      { key: 'product', header: '품목', format: '품목명 또는 기존 코드', help: '매입·매출만' },
      { key: 'quantity', header: '수량', format: '숫자' },
      { key: 'unit_price', header: '단가', format: '금액(원)' },
      { key: 'amount', header: '금액', format: '금액(원)', help: '수금·지급은 필수. 매입·매출은 비우면 수량 × 단가' },
      { key: 'cost', header: '원가', format: '금액(원)', help: '매출만(선택)' },
      { key: 'external_ref', header: '원 전표번호', format: '글자' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      ['매출', D('2026-10-15'), '하나로마트', '홍고추', 2, 38000, '', 60000, 'H-0001', ''],
      ['수금', D('2026-10-20'), '하나로마트', '', '', '', 76000, '', 'H-0002', '계좌 입금'],
      ['매입', D('2026-10-10'), '서울청과', '홍고추', 5, 30000, '', '', 'H-0003', ''],
    ],
  },
  disposal: {
    label: '⑦ 폐기',
    file: '이관_7_폐기',
    columns: [
      { key: 'date', header: '폐기일', required: true, format: '날짜', help: '기준일 이전 = 기록만 / 기준일~오늘 = 이관 재고에서 차감' },
      { key: 'product', header: '품목', required: true, format: '품목명 또는 기존 코드' },
      { key: 'quantity', header: '수량', required: true, format: '숫자' },
      { key: 'reason', header: '사유', format: '글자' },
      { key: 'memo', header: '메모', format: '글자' },
    ],
    examples: [
      [D('2026-10-29'), '홍고추', 3, '무름', '기준일 전 — 기록만'],
      [D('2026-11-01'), '홍고추', 2, '시듦', '기준일 이후 — 재고 차감'],
    ],
  },
};
for (const k of Object.keys(MK)) MK[k].kind = k;

const GUIDE = (def) => [
  `[데이터 이관 ${def.label}] 작성 방법`,
  '· 기준일 = 이 프로그램으로 장부를 시작하는 날. 기초 잔액·기초 재고는 "기준일 업무 시작 시점(= 전날 마감)" 값입니다.',
  '· 저장 순서: ① 거래처 → ② 품목 → ③ 기초 미수 → ④ 기초 미지급 → ⑤ 기초 재고 → ⑦ 폐기 → ⑥ 과거 거래. 뒤 파일은 앞 파일이 만든 거래처·품목을 이름 또는 기존 코드로 찾습니다.',
  '· 받을 돈·줄 돈 잔액은 ③④ 파일로만, 재고는 ⑤ 파일로만 정해집니다. ⑥ 과거 거래는 참고 기록이라 잔액·재고를 바꾸지 않습니다.',
  `· '입력' 시트 1행(머리글)은 바꾸지 마세요. * 표시(주황) 열은 필수입니다. 예시 줄은 지우고 쓰세요(기준일 2026-11-01 기준 예시).`,
  '· 날짜는 엑셀 날짜 또는 2026-10-31 / 2026.10.31 / 20261031. 금액은 쉼표를 넣어도 됩니다.',
  `· 최대 ${MAX_ROWS.toLocaleString('ko-KR')}줄 · 파일 5MB. 넘으면 파일을 나눠 같은 기준일의 묶음 여러 개로 올리세요.`,
  '· [전체 검증]으로 줄별 결과를 본 뒤 오류가 0일 때만 저장됩니다(전부 아니면 전무). 저장 뒤 틀린 것은 묶음 [되돌리기]로 고칩니다.',
];

// ---------------------------------------------------------------------------
// 2. 도우미
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const ymdOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && readDate(s) === s;
const norm = (s) => String(s || '').trim().toLowerCase();
const cents = (v) => Math.round(Number(v || 0) * 100);
const money = (c) => Math.round(c) / 100;

/** exceljs 셀 값 → JSON 으로 보관할 값(날짜는 YYYY-MM-DD 문자열 — readDate 가 그대로 읽는다) */
function cellToJson(v) {
  const r = xl.rawCell(v);
  if (r == null) return null;
  if (r instanceof Date) return Number.isNaN(r.getTime()) ? null : r.toISOString().slice(0, 10);
  if (typeof r === 'object') return null;
  return r;
}
function lenCheck(s, max, label) {
  if (s && s.length > max) throw rowErr(`${label}은(는) ${max}자까지 입력할 수 있습니다.`);
  return s;
}

/** 파일 합(대조 리포트의 "파일 합"·올릴 때 표시) — 보관한 줄에서 따로 계산. 형식이 틀린 칸은 0 */
function fileTotals(kind, rows) {
  let amount = 0;
  let qty = 0;
  for (const r of rows) {
    const v = r.vals || {};
    if (kind === 'opening_ar' || kind === 'opening_ap') amount += cents(readNumber(v.amount) || 0);
    if (kind === 'history') {
      const a = readNumber(v.amount);
      amount += a != null && a !== undefined ? cents(a) : Math.round(Number(readNumber(v.quantity, { maxDecimals: 3 }) || 0) * Number(readNumber(v.unit_price) || 0) * 100);
    }
    if (kind === 'opening_stock') {
      const q = Number(readNumber(v.quantity, { maxDecimals: 3 }) || 0);
      const p = Number(readNumber(v.unit_price) || 0);
      qty += Math.round(q * 1000);
      amount += Math.round(q * p * 100);
    }
    if (kind === 'disposal') qty += Math.round(Number(readNumber(v.quantity, { maxDecimals: 3 }) || 0) * 1000);
  }
  return { amount: money(amount), qty: qty / 1000 };
}

// ---------------------------------------------------------------------------
// 3. 대상별 처리 — 결과 줄: {line, ok, status, summary, message?, warning?, amount?, qty?}
//    status: created(새로 만듦) · existing(기존 사용) · saved(기초·재고 저장) · history(이관 기록) · disposed(재고 차감) · error
// ---------------------------------------------------------------------------
function errLine(row, def, err) {
  const raw = def.columns.slice(0, 4).map((c) => textOf(row.vals[c.key])).filter(Boolean).join(' · ').slice(0, 120);
  if (err instanceof RowError) return { line: row.line, ok: false, status: 'error', summary: raw || undefined, message: err.message };
  console.error('migration row error:', err);
  return { line: row.line, ok: false, status: 'error', summary: raw || undefined, message: '이 줄을 처리하는 중 오류가 났습니다.' };
}

async function callHandler(ctx, method, path, body) {
  const r = await xl.bulkStore.run(ctx.bulk, () => xl.invoke(ctx.app, ctx.authorize, ctx.req, method, path, body));
  const ok = r.statusCode < 400 && r.body && r.body.ok !== false;
  return { ok, status: r.statusCode, body: r.body, message: (r.body && r.body.message) || `처리하지 못했습니다(${r.statusCode}).` };
}

/** 거래처 찾기: 이 묶음 파일의 코드 → DB 기존 코드 → 이름 */
async function findPartner(ctx, text) {
  const k = norm(text);
  if (ctx.pAlias.has(k)) return ctx.pAlias.get(k);
  if (!ctx.pCache.has(k)) {
    const r = await ctx.client.query(
      `SELECT id, name, type::text AS type, origin_region, external_code FROM account
        WHERE user_id = $1 AND (external_code = btrim($2) OR lower(btrim(name)) = lower(btrim($2)))
        ORDER BY (external_code = btrim($2)) DESC NULLS LAST, id LIMIT 1`,
      [ctx.userId, text]
    );
    ctx.pCache.set(k, r.rows[0] || null);
  }
  return ctx.pCache.get(k);
}
async function needPartner(ctx, text, label) {
  const p = await findPartner(ctx, text);
  if (!p) throw rowErr(`${label} 「${text}」을(를) 내 거래처(이름·기존 코드)에서 찾을 수 없습니다. ① 거래처 파일에 넣거나 먼저 등록하세요.`);
  return p;
}
async function findProduct(ctx, text) {
  const k = norm(text);
  if (ctx.prAlias.has(k)) return ctx.prAlias.get(k);
  if (!ctx.prCache.has(k)) {
    const r = await ctx.client.query(
      `SELECT id, name, owner_user_id, external_code FROM product
        WHERE (owner_user_id IS NULL OR owner_user_id = $1) AND NOT is_system
          AND (external_code = btrim($2) OR lower(btrim(name)) = lower(btrim($2)))
        ORDER BY (external_code = btrim($2)) DESC NULLS LAST, (owner_user_id IS NULL) DESC, id LIMIT 1`,
      [ctx.userId, text]
    );
    ctx.prCache.set(k, r.rows[0] || null);
  }
  return ctx.prCache.get(k);
}
async function needProduct(ctx, text) {
  if (norm(text) === norm(SYSTEM_PRODUCT_NAME)) throw rowErr(`「${SYSTEM_PRODUCT_NAME}」은(는) 시스템 품목이라 쓸 수 없습니다.`);
  const p = await findProduct(ctx, text);
  if (!p) throw rowErr(`품목 「${text}」을(를) 찾을 수 없습니다(공용 품목·내 품목·기존 코드). ② 품목 파일에 넣으세요.`);
  return p;
}
function clearCaches(ctx) {
  ctx.pCache.clear();
  ctx.prCache.clear();
}

async function withSavepoint(ctx, i, fn) {
  const sp = `mg_row_${ctx.seq += 1}`;
  await ctx.client.query(`SAVEPOINT ${sp}`);
  try {
    const out = await fn();
    if (out.ok) await ctx.client.query(`RELEASE SAVEPOINT ${sp}`);
    else {
      await ctx.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await ctx.client.query(`RELEASE SAVEPOINT ${sp}`);
      clearCaches(ctx);
    }
    return out;
  } catch (err) {
    await ctx.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    await ctx.client.query(`RELEASE SAVEPOINT ${sp}`);
    clearCaches(ctx);
    throw err;
  }
}

// ① 거래처
async function doPartners(rows, ctx) {
  const def = MK.partner;
  const out = [];
  const seenName = new Map();
  const seenCode = new Map();
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await withSavepoint(ctx, row.line, async () => {
      try {
        const mapped = await xl.KINDS.partner.toBody(row.vals);
        const name = mapped.body.name;
        const code = lenCheck(optText(row.vals, 'external_code'), 50, '기존 코드');
        if (seenName.has(norm(name))) throw rowErr(`같은 파일 ${seenName.get(norm(name))}줄과 거래처명이 같습니다.`);
        if (code && seenCode.has(code)) throw rowErr(`같은 파일 ${seenCode.get(code)}줄과 기존 코드가 같습니다.`);
        seenName.set(norm(name), row.line);
        if (code) seenCode.set(code, row.line);
        const byName = (await ctx.client.query(
          `SELECT id, name, type::text AS type, origin_region, external_code FROM account WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) ORDER BY id LIMIT 1`,
          [ctx.userId, name]
        )).rows[0];
        const byCode = code ? (await ctx.client.query(
          `SELECT id, name, type::text AS type, external_code FROM account WHERE user_id = $1 AND external_code = $2`, [ctx.userId, code]
        )).rows[0] : null;
        if (byCode && (!byName || byName.id !== byCode.id)) throw rowErr(`기존 코드 「${code}」는 이미 거래처 「${byCode.name}」에 쓰였습니다.`);
        if (byName) {
          if (code && byName.external_code && byName.external_code !== code) {
            throw rowErr(`거래처 「${byName.name}」의 기존 코드는 「${byName.external_code}」입니다.`);
          }
          if (code && !byName.external_code) { // MP-03 코드만 채움 → 되돌리기 때 다시 비움
            await ctx.client.query(`UPDATE account SET external_code = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2`, [byName.id, ctx.userId, code]);
            ctx.restore.account.push(byName.id);
          }
          const p = { ...byName, external_code: code || byName.external_code };
          ctx.pAlias.set(norm(name), p);
          if (code) ctx.pAlias.set(norm(code), p);
          return { line: row.line, ok: true, status: 'existing', id: byName.id, summary: `${byName.name} — 기존 거래처 사용` };
        }
        const r = await callHandler(ctx, 'POST', '/api/partners', mapped.body);
        if (!r.ok) throw rowErr(r.message);
        const id = r.body.data.id;
        await ctx.client.query(`UPDATE account SET migration_batch_id = $3, external_code = $4 WHERE id = $1 AND user_id = $2`, [id, ctx.userId, ctx.batchId, code || null]);
        const p = { id, name, type: mapped.body.type, origin_region: mapped.body.origin_region || null, external_code: code || null };
        ctx.pAlias.set(norm(name), p);
        if (code) ctx.pAlias.set(norm(code), p);
        return { line: row.line, ok: true, status: 'created', id, summary: mapped.summary };
      } catch (err) {
        return errLine(row, def, err);
      }
    }));
  }
  return out;
}

// ② 품목
async function doProducts(rows, ctx) {
  const def = MK.product;
  const out = [];
  const seenName = new Map();
  const seenCode = new Map();
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await withSavepoint(ctx, row.line, async () => {
      try {
        const name = lenCheck(need(row.vals, 'name', '품목명'), 100, '품목명');
        if (norm(name) === norm(SYSTEM_PRODUCT_NAME)) throw rowErr(`「${SYSTEM_PRODUCT_NAME}」은(는) 시스템 품목 이름이라 쓸 수 없습니다.`);
        const code = lenCheck(optText(row.vals, 'external_code'), 50, '기존 코드');
        const pub = xl.readYesNo(row.vals.is_public);
        if (pub === undefined) throw rowErr('공용은 Y 또는 N으로 입력하세요.');
        if (pub && !ctx.isAdmin) throw rowErr('공용 품목은 관리자만 만들 수 있습니다. 공용 칸을 N으로 바꾸면 내 품목으로 만듭니다.');
        if (seenName.has(norm(name))) throw rowErr(`같은 파일 ${seenName.get(norm(name))}줄과 품목명이 같습니다.`);
        if (code && seenCode.has(code)) throw rowErr(`같은 파일 ${seenCode.get(code)}줄과 기존 코드가 같습니다.`);
        seenName.set(norm(name), row.line);
        if (code) seenCode.set(code, row.line);
        const byName = (await ctx.client.query(
          `SELECT id, name, owner_user_id, external_code FROM product
            WHERE (owner_user_id IS NULL OR owner_user_id = $1) AND NOT is_system AND lower(btrim(name)) = lower(btrim($2))
            ORDER BY (owner_user_id IS NULL) DESC, id LIMIT 1`, [ctx.userId, name]
        )).rows[0];
        const byCode = code ? (await ctx.client.query(
          `SELECT id, name, external_code FROM product WHERE (owner_user_id IS NULL OR owner_user_id = $1) AND NOT is_system AND external_code = $2 LIMIT 1`,
          [ctx.userId, code]
        )).rows[0] : null;
        if (byCode && (!byName || byName.id !== byCode.id)) throw rowErr(`기존 코드 「${code}」는 이미 품목 「${byCode.name}」에 쓰였습니다.`);
        if (byName) {
          // 내 품목(또는 관리자의 공용 품목)에만 코드를 채운다. 남의 공용 품목은 이 묶음 안에서만 코드로 찾는다
          const canFill = byName.owner_user_id === ctx.userId || ctx.isAdmin;
          if (code && byName.external_code && byName.external_code !== code && canFill) {
            throw rowErr(`품목 「${byName.name}」의 기존 코드는 「${byName.external_code}」입니다.`);
          }
          if (code && !byName.external_code && canFill) {
            await ctx.client.query(`UPDATE product SET external_code = $2, updated_at = NOW() WHERE id = $1`, [byName.id, code]);
            ctx.restore.product.push(byName.id);
          }
          ctx.prAlias.set(norm(name), byName);
          if (code) ctx.prAlias.set(norm(code), byName);
          return { line: row.line, ok: true, status: 'existing', id: byName.id, summary: `${byName.name} — 기존 품목 사용${byName.owner_user_id == null ? '(공용)' : ''}` };
        }
        const body = { name };
        for (const k of ['unit', 'category_large', 'category_mid', 'category_small', 'memo']) {
          const v = optText(row.vals, k);
          if (v !== undefined) body[k] = v;
        }
        const r = await callHandler(ctx, 'POST', pub ? '/api/products' : '/api/products/personal', body);
        if (!r.ok) throw rowErr(r.message);
        const id = r.body.data.id;
        await ctx.client.query(`UPDATE product SET migration_batch_id = $2, external_code = $3 WHERE id = $1`, [id, ctx.batchId, code || null]);
        const p = { id, name, owner_user_id: pub ? null : ctx.userId, external_code: code || null };
        ctx.prAlias.set(norm(name), p);
        if (code) ctx.prAlias.set(norm(code), p);
        return { line: row.line, ok: true, status: 'created', id, summary: `${name}${body.unit ? ` (${body.unit})` : ''}${pub ? ' · 공용' : ''}` };
      } catch (err) {
        return errLine(row, def, err);
      }
    }));
  }
  return out;
}

/** 기초 미수·미지급 공통 — 줄 검사 후 500줄씩 여러 줄 INSERT */
async function doOpeningMoney(rows, ctx, kind) {
  const def = MK[kind];
  const isAr = kind === 'opening_ar';
  const out = [];
  const good = [];
  const seenRef = isAr ? ctx.seenSaleRef : ctx.seenPurchaseRef;
  const existingRefs = isAr ? ctx.dbSaleRefs : ctx.dbPurchaseRefs;
  const dayBefore = addDays(ctx.D, -1);
  for (const row of rows) {
    try {
      const ptext = need(row.vals, 'partner', isAr ? '거래처' : '지급 대상');
      // eslint-disable-next-line no-await-in-loop
      const p = await needPartner(ctx, ptext, isAr ? '거래처' : '지급 대상');
      if (isAr && !SALE_TYPES.has(p.type)) throw rowErr(`「${p.name}」은(는) 판매 거래처(판매처·같은 시장·도매상·시장도매인)가 아니라 받을 돈을 넣을 수 없습니다.`);
      if (!isAr && !PAY_TYPES.has(p.type)) throw rowErr(`「${p.name}」은(는) 지급 대상(매입처·같은 시장·도매상·시장도매인·생산자)이 아닙니다.`);
      const amount = numCol(row.vals, 'amount', isAr ? '미수 금액' : '미지급 금액', true);
      if (!(Number(amount) > 0)) throw rowErr('금액은 0보다 커야 합니다. 받을 돈이 음수(선수금)인 거래처는 이관하지 않습니다.');
      if (Number(amount) >= 1e12) throw rowErr('금액이 너무 큽니다.');
      let d = dateCol(row.vals, 'orig_date', isAr ? '원래 매출일' : '원래 매입일', false);
      let warning;
      if (!d) {
        d = dayBefore;
        warning = `${isAr ? '원래 매출일' : '원래 매입일'}이 비어 기준일 전날(${d})로 넣었습니다 — 연령이 실제보다 짧게 보입니다.`;
      } else if (d >= ctx.D) throw rowErr(`${isAr ? '원래 매출일' : '원래 매입일'}(${d})은 기준일(${ctx.D})보다 앞이어야 합니다.`);
      const ref = lenCheck(optText(row.vals, 'external_ref'), 50, '원 전표번호');
      if (ref) {
        if (seenRef.has(ref)) throw rowErr(`원 전표번호 「${ref}」가 같은 묶음 ${seenRef.get(ref)}에 이미 있습니다.`);
        if (existingRefs.has(ref)) throw rowErr(`원 전표번호 「${ref}」는 이미 이관했습니다(DM-02).`);
        seenRef.set(ref, `${def.label} ${row.line}줄`);
      }
      const memo = optText(row.vals, 'memo');
      good.push({ partnerId: p.id, amount, d, ref: ref || null, memo: memo ? `이관 기초 · ${memo}` : '이관 기초' });
      if (ctx.priorOpening[kind].has(p.id)) ctx.dm03[kind].add(p.name);
      if (isAr) ctx.arPartners.add(p.id);
      out.push({ line: row.line, ok: true, status: 'saved', summary: `${p.name} · ${d} · ${won(amount)}원`, amount: Number(amount), ...(warning ? { warning } : {}) });
    } catch (err) {
      out.push(errLine(row, def, err));
    }
  }
  for (let i = 0; i < good.length; i += CHUNK) {
    const part = good.slice(i, i + CHUNK);
    const params = [ctx.userId, ctx.systemProductId, ctx.batchId,
      part.map((g) => g.partnerId), part.map((g) => g.amount), part.map((g) => g.d), part.map((g) => g.memo), part.map((g) => g.ref)];
    if (isAr) {
      // eslint-disable-next-line no-await-in-loop
      await ctx.client.query(
        `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date, payment_status, paid_amount, status, memo,
                           entry_mode, migration_batch_id, external_ref, cost_at_sale)
         SELECT $1, x.pid, $2, 1, ROUND(x.amt, 2), ROUND(x.amt, 2), x.d, 'unpaid', 0, 'active', x.memo, 'opening', $3, x.ref, NULL
           FROM unnest($4::int[], $5::numeric[], $6::date[], $7::text[], $8::text[]) AS x(pid, amt, d, memo, ref)`,
        params
      );
    } else {
      // eslint-disable-next-line no-await-in-loop
      await ctx.client.query(
        `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo, payment_status, paid_amount,
                               payee_partner_id, entry_kind, migration_batch_id, external_ref)
         SELECT $1, x.pid, $2, 1, ROUND(x.amt, 2), ROUND(x.amt, 2), x.d, x.memo, 'unpaid', 0, x.pid, 'opening_ap', $3, x.ref
           FROM unnest($4::int[], $5::numeric[], $6::date[], $7::text[], $8::text[]) AS x(pid, amt, d, memo, ref)`,
        params
      );
    }
  }
  return out;
}

// ⑤ 기초 재고 — 매입 로트(지급 완료) + 재고 증가 + 이동 이력
async function doOpeningStock(rows, ctx) {
  const def = MK.opening_stock;
  const out = [];
  const good = [];
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const pr = await needProduct(ctx, need(row.vals, 'product', '품목'));
      const qty = numCol(row.vals, 'quantity', '수량', true, { maxDecimals: 3 });
      if (!(Number(qty) > 0)) throw rowErr('수량은 0보다 커야 합니다.');
      const price = numCol(row.vals, 'unit_price', '원가 단가', true);
      if (!(Number(price) >= 0)) throw rowErr('원가 단가는 0 이상이어야 합니다.');
      const d = dateCol(row.vals, 'in_date', '입고일', true);
      if (d >= ctx.D) throw rowErr(`입고일(${d})은 기준일(${ctx.D})보다 앞이어야 합니다.`);
      // eslint-disable-next-line no-await-in-loop
      const sup = await needPartner(ctx, need(row.vals, 'partner', '제공처'), '제공처');
      if (!PAY_TYPES.has(sup.type)) throw rowErr(`「${sup.name}」은(는) 매입 가능한 거래처(매입처·같은 시장·도매상·시장도매인·생산자)가 아닙니다.`);
      let producer = null;
      const prodText = textOf(row.vals.producer);
      if (prodText) {
        // eslint-disable-next-line no-await-in-loop
        producer = await needPartner(ctx, prodText, '생산자');
        if (producer.type !== 'producer') throw rowErr(`「${producer.name}」은(는) 유형이 생산자인 거래처가 아닙니다.`);
      }
      const origin = lenCheck(optText(row.vals, 'origin_region'), 100, '산지') || (producer && producer.origin_region) || null;
      const ref = lenCheck(optText(row.vals, 'external_ref'), 50, '원 전표번호');
      if (ref) {
        if (ctx.seenPurchaseRef.has(ref)) throw rowErr(`원 전표번호 「${ref}」가 같은 묶음 ${ctx.seenPurchaseRef.get(ref)}에 이미 있습니다.`);
        if (ctx.dbPurchaseRefs.has(ref)) throw rowErr(`원 전표번호 「${ref}」는 이미 이관했습니다(DM-02).`);
        ctx.seenPurchaseRef.set(ref, `${def.label} ${row.line}줄`);
      }
      const memo = optText(row.vals, 'memo');
      good.push({ productId: pr.id, qty, price, d, partnerId: sup.id, producerId: producer ? producer.id : null, origin, ref: ref || null, memo: memo ? `이관 재고 · ${memo}` : '이관 재고' });
      if (ctx.priorOpening.opening_stock.has(pr.id)) ctx.dm03.opening_stock.add(pr.name);
      out.push({ line: row.line, ok: true, status: 'saved', summary: `${pr.name} ${qty} × ${won(price)} · 입고 ${d} · ${sup.name}`, qty: Number(qty), amount: Math.round(Number(qty) * Number(price) * 100) / 100 });
    } catch (err) {
      out.push(errLine(row, def, err));
    }
  }
  for (let i = 0; i < good.length; i += CHUNK) {
    const part = good.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    const ins = await ctx.client.query(
      `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo, payment_status, paid_amount,
                             payee_partner_id, producer_id, origin_region, entry_kind, migration_batch_id, external_ref)
       -- 이관 재고는 돈이 아니다: total_amount = paid_amount = 0 → 상태식(paid)·지급 배분 합(0) 불변식이 그대로 맞고 미지급에 안 잡힌다.
       -- 원가는 unit_price 에 둔다(판매 원가 = 배분 수량 × 매입 단가 — 기존 식 그대로). 재고 금액이 필요하면 quantity × unit_price
       SELECT $1, x.pid, x.prid, ROUND(x.q, 3), ROUND(x.p, 2), 0, x.d, x.memo, 'paid',
              0, x.pid, x.producer, x.origin, 'opening_stock', $2, x.ref
         FROM unnest($3::int[], $4::int[], $5::numeric[], $6::numeric[], $7::date[], $8::text[], $9::int[], $10::text[], $11::text[])
              AS x(pid, prid, q, p, d, memo, producer, origin, ref)
       RETURNING id, product_id, quantity, partner_id`,
      [ctx.userId, ctx.batchId, part.map((g) => g.partnerId), part.map((g) => g.productId), part.map((g) => g.qty), part.map((g) => g.price),
        part.map((g) => g.d), part.map((g) => g.memo), part.map((g) => g.producerId), part.map((g) => g.origin), part.map((g) => g.ref)]
    );
    const rws = ins.rows;
    // eslint-disable-next-line no-await-in-loop
    await ctx.client.query(
      `INSERT INTO product_transfer (user_id, product_id, quantity, action_type, from_type, to_type, from_partner_id, after_location, purchase_id, memo)
       SELECT $1, x.prid, x.q, 'purchase', 'supplier', 'inventory', x.pid, $2, x.puid, '이관 재고'
         FROM unnest($3::int[], $4::numeric[], $5::int[], $6::int[]) AS x(prid, q, pid, puid)`,
      [ctx.userId, ctx.warehouse, rws.map((r) => r.product_id), rws.map((r) => r.quantity), rws.map((r) => r.partner_id), rws.map((r) => r.id)]
    );
    // eslint-disable-next-line no-await-in-loop
    await ctx.client.query(
      `INSERT INTO inventory (user_id, product_id, quantity)
       SELECT $1, x.prid, SUM(x.q) FROM unnest($2::int[], $3::numeric[]) AS x(prid, q) GROUP BY x.prid
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [ctx.userId, rws.map((r) => r.product_id), rws.map((r) => r.quantity)]
    );
  }
  return out;
}

// ⑦ 폐기 — D 이전 = 이관 기록, D~오늘 = 기존 폐기 API(재고 차감), 오늘 이후 = 오류
async function doDisposals(rows, ctx) {
  const def = MK.disposal;
  const out = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await withSavepoint(ctx, row.line, async () => {
      try {
        const d = dateCol(row.vals, 'date', '폐기일', true);
        if (d > ctx.today) throw rowErr(`폐기일(${d})이 오늘(${ctx.today})보다 뒤입니다.`);
        const ptext = need(row.vals, 'product', '품목');
        const qty = numCol(row.vals, 'quantity', '수량', true, { maxDecimals: 3 });
        if (!(Number(qty) > 0)) throw rowErr('수량은 0보다 커야 합니다.');
        const reason = lenCheck(optText(row.vals, 'reason'), 100, '사유');
        const memo = optText(row.vals, 'memo');
        if (d < ctx.D) {
          if (norm(ptext) === norm(SYSTEM_PRODUCT_NAME)) throw rowErr(`「${SYSTEM_PRODUCT_NAME}」은(는) 쓸 수 없습니다.`);
          const pr = await findProduct(ctx, ptext);
          ctx.historyRows.push({ kind: 'disposal', d, partnerId: null, partnerName: null, productId: pr ? pr.id : null, productName: pr ? pr.name : ptext.slice(0, 100),
            qty, price: null, amount: '0', cost: null, ref: null, memo: [reason, memo].filter(Boolean).join(' · ') || null, line: row.line });
          return { line: row.line, ok: true, status: 'history', summary: `${d} · ${pr ? pr.name : ptext} ${qty} — 기준일 전(기록만)`, qty: Number(qty),
            ...(pr ? {} : { warning: `품목 「${ptext}」을(를) 찾지 못해 이름만 기록합니다.` }) };
        }
        const pr = await needProduct(ctx, ptext);
        const r = await callHandler(ctx, 'POST', '/api/disposals', { product_id: pr.id, quantity: qty, disposal_date: d, reason, memo });
        if (!r.ok) throw rowErr(r.status === 400 && /재고/.test(r.message) ? `재고가 부족합니다(${pr.name} ${qty}) — 기준일 이후 폐기는 ⑤ 기초 재고에서 빠집니다.` : r.message);
        await ctx.client.query(`UPDATE disposal SET migration_batch_id = $2 WHERE id = $1`, [r.body.data.id, ctx.batchId]);
        return { line: row.line, ok: true, status: 'disposed', id: r.body.data.id, summary: `${d} · ${pr.name} ${qty} — 재고 차감`, qty: Number(qty) };
      } catch (err) {
        return errLine(row, def, err);
      }
    }));
  }
  return out;
}

// ⑥ 과거 거래 — 이관 기록(잔액·재고 영향 없음)
async function doHistory(rows, ctx) {
  const def = MK.history;
  const out = [];
  for (const row of rows) {
    try {
      const kind = xl.enumCol(row.vals, 'kind', '구분', HISTORY_KIND_IN, '매입, 매출, 수금, 지급');
      if (!kind) throw rowErr('구분을 입력하세요.');
      const d = dateCol(row.vals, 'date', '날짜', true);
      if (d >= ctx.D) throw rowErr(`과거 거래 날짜(${d})는 기준일(${ctx.D})보다 앞이어야 합니다.`);
      const ptext = need(row.vals, 'partner', '거래처');
      // eslint-disable-next-line no-await-in-loop
      const p = await findPartner(ctx, ptext);
      const warnings = [];
      if (!p) warnings.push(`거래처 「${ptext}」을(를) 찾지 못해 이름만 기록합니다.`);
      let pr = null;
      let productName = null;
      let qty = null;
      let price = null;
      let cost = null;
      const isGoods = kind === 'purchase' || kind === 'sale';
      if (isGoods) {
        const prt = textOf(row.vals.product);
        if (prt) {
          // eslint-disable-next-line no-await-in-loop
          pr = norm(prt) === norm(SYSTEM_PRODUCT_NAME) ? null : await findProduct(ctx, prt);
          productName = pr ? pr.name : prt.slice(0, 100);
          if (!pr) warnings.push(`품목 「${prt}」을(를) 찾지 못해 이름만 기록합니다.`);
        }
        qty = numCol(row.vals, 'quantity', '수량', false, { maxDecimals: 3 });
        price = numCol(row.vals, 'unit_price', '단가', false);
        if (kind === 'sale') cost = numCol(row.vals, 'cost', '원가', false);
      }
      let amount = numCol(row.vals, 'amount', '금액', false);
      if (amount == null) {
        if (!isGoods) throw rowErr('수금·지급은 금액을 입력하세요.');
        if (qty == null || price == null) throw rowErr('금액을 비우려면 수량과 단가를 입력하세요.');
        amount = String(Math.round(Number(qty) * Number(price) * 100) / 100);
      }
      if (Number(amount) < 0) throw rowErr('금액은 0 이상이어야 합니다.');
      const ref = lenCheck(optText(row.vals, 'external_ref'), 50, '원 전표번호');
      ctx.historyRows.push({ kind, d, partnerId: p ? p.id : null, partnerName: p ? p.name : ptext.slice(0, 100), productId: pr ? pr.id : null, productName,
        qty, price, amount, cost, ref: ref || null, memo: optText(row.vals, 'memo') || null, line: row.line });
      out.push({ line: row.line, ok: true, status: 'history', summary: `${HISTORY_KIND_LABEL[kind]} · ${d} · ${p ? p.name : ptext} · ${won(amount)}원`, amount: Number(amount),
        ...(warnings.length ? { warning: warnings.join(' ') } : {}) });
    } catch (err) {
      out.push(errLine(row, def, err));
    }
  }
  return out;
}

async function flushHistory(ctx) {
  const h = ctx.historyRows;
  for (let i = 0; i < h.length; i += CHUNK) {
    const part = h.slice(i, i + CHUNK);
    // eslint-disable-next-line no-await-in-loop
    await ctx.client.query(
      `INSERT INTO migration_history (user_id, batch_id, kind, txn_date, partner_id, partner_name, product_id, product_name, quantity, unit_price, amount, cost_amount, external_ref, memo, line_no)
       SELECT $1, $2, x.k, x.d, x.pid, x.pname, x.prid, x.prname, x.q, x.p, ROUND(x.amt, 2), x.cost, x.ref, x.memo, x.line
         FROM unnest($3::text[], $4::date[], $5::int[], $6::text[], $7::int[], $8::text[], $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::text[], $14::text[], $15::int[])
              AS x(k, d, pid, pname, prid, prname, q, p, amt, cost, ref, memo, line)`,
      [ctx.userId, ctx.batchId, part.map((r) => r.kind), part.map((r) => r.d), part.map((r) => r.partnerId), part.map((r) => r.partnerName),
        part.map((r) => r.productId), part.map((r) => r.productName), part.map((r) => r.qty), part.map((r) => r.price), part.map((r) => r.amount),
        part.map((r) => r.cost), part.map((r) => r.ref), part.map((r) => r.memo), part.map((r) => r.line)]
    );
  }
}

/**
 * 묶음 하나를 3.3 순서로 저장한다(바깥 트랜잭션 안). 결과 줄·경고·건수를 돌려준다. 커밋·롤백은 부르는 쪽
 */
async function processBatch(base) {
  const { client, batch, files, userId } = base;
  const ctx = {
    ...base,
    D: ymdOf(batch.cutover_date),
    batchId: batch.id,
    bulk: xl.makeBulkContext(client),
    seq: 0,
    pAlias: new Map(), prAlias: new Map(), pCache: new Map(), prCache: new Map(),
    restore: { account: [], product: [] },
    historyRows: [],
    seenSaleRef: new Map(), seenPurchaseRef: new Map(),
    arPartners: new Set(),
    dm03: { opening_ar: new Set(), opening_ap: new Set(), opening_stock: new Set() },
  };
  const sys = await client.query(`SELECT id FROM product WHERE is_system ORDER BY id LIMIT 1`);
  ctx.systemProductId = sys.rows[0] && sys.rows[0].id;
  if (!ctx.systemProductId) throw new Error('system product missing (025)');
  ctx.dbSaleRefs = new Set((await client.query(
    `SELECT external_ref FROM sale WHERE user_id = $1 AND entry_mode = 'opening' AND external_ref IS NOT NULL AND status <> 'cancelled'`, [userId]
  )).rows.map((r) => r.external_ref));
  ctx.dbPurchaseRefs = new Set((await client.query(
    `SELECT external_ref FROM purchase WHERE user_id = $1 AND entry_kind <> 'normal' AND external_ref IS NOT NULL AND status = 'active'`, [userId]
  )).rows.map((r) => r.external_ref));
  // DM-03: 다른 저장 묶음에 이미 기초가 있는 거래처·품목
  const prior = await client.query(
    `SELECT 'opening_ar' AS k, partner_id AS id FROM sale WHERE user_id = $1 AND entry_mode = 'opening' AND status <> 'cancelled'
     UNION SELECT 'opening_ap', payee_partner_id FROM purchase WHERE user_id = $1 AND entry_kind = 'opening_ap' AND status = 'active'
     UNION SELECT 'opening_stock', product_id FROM purchase WHERE user_id = $1 AND entry_kind = 'opening_stock' AND status = 'active'`, [userId]
  );
  ctx.priorOpening = { opening_ar: new Set(), opening_ap: new Set(), opening_stock: new Set() };
  for (const r of prior.rows) ctx.priorOpening[r.k].add(r.id);

  const results = {};
  for (const kind of ORDER) {
    const f = files.find((x) => x.kind === kind);
    if (!f) continue;
    const rows = f.rows || [];
    // eslint-disable-next-line no-await-in-loop
    if (kind === 'partner') results[kind] = await doPartners(rows, ctx);
    // eslint-disable-next-line no-await-in-loop
    else if (kind === 'product') results[kind] = await doProducts(rows, ctx);
    // eslint-disable-next-line no-await-in-loop
    else if (kind === 'opening_ar' || kind === 'opening_ap') results[kind] = await doOpeningMoney(rows, ctx, kind);
    // eslint-disable-next-line no-await-in-loop
    else if (kind === 'opening_stock') results[kind] = await doOpeningStock(rows, ctx);
    // eslint-disable-next-line no-await-in-loop
    else if (kind === 'disposal') results[kind] = await doDisposals(rows, ctx);
    // eslint-disable-next-line no-await-in-loop
    else if (kind === 'history') results[kind] = await doHistory(rows, ctx);
  }
  await flushHistory(ctx);

  // 묶음 경고
  const warnings = [];
  const labels = { opening_ar: '기초 미수', opening_ap: '기초 미지급', opening_stock: '이관 재고' };
  for (const k of Object.keys(ctx.dm03)) {
    const names = [...ctx.dm03[k]];
    if (names.length) {
      warnings.push({ code: 'DM03_ALREADY_MIGRATED', message: `이미 다른 묶음에 ${labels[k]}가 있는 ${k === 'opening_stock' ? '품목' : '거래처'} ${names.length}곳: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''} — 추가로 넣는 것이 맞는지 확인하세요.` });
    }
  }
  if (ctx.arPartners.size) {
    const ov = await client.query(
      `SELECT a.name, a.credit_limit, rv.receivable_amount FROM account a
         JOIN receivables_by_partner rv ON rv.user_id = a.user_id AND rv.partner_id = a.id
        WHERE a.user_id = $1 AND a.id = ANY($2::int[]) AND a.credit_limit IS NOT NULL AND rv.receivable_amount > a.credit_limit
        ORDER BY a.name`, [userId, [...ctx.arPartners]]
    );
    if (ov.rows.length) {
      warnings.push({ code: 'CREDIT_OVER', message: `저장 뒤 외상 한도를 넘는 거래처 ${ov.rows.length}곳: ${ov.rows.slice(0, 5).map((r) => `${r.name}(한도 ${won(r.credit_limit)} / 미수 ${won(r.receivable_amount)})`).join(', ')} — 이관은 그대로 저장되고, 이후 판매에서 한도 확인이 필요합니다.` });
    }
  }
  const pre = await client.query(
    `SELECT (SELECT COUNT(*) FROM purchase WHERE user_id = $1 AND entry_kind = 'normal' AND status = 'active' AND purchase_date < $2::date)
          + (SELECT COUNT(*) FROM sale WHERE user_id = $1 AND entry_mode <> 'opening' AND status <> 'cancelled' AND sale_date < $2::date)
          + (SELECT COUNT(*) FROM payment WHERE user_id = $1 AND status = 'active' AND (paid_at AT TIME ZONE 'Asia/Seoul')::date < $2::date)
          + (SELECT COUNT(*) FROM supplier_payment WHERE user_id = $1 AND status = 'active' AND (paid_at AT TIME ZONE 'Asia/Seoul')::date < $2::date)
          + (SELECT COUNT(*) FROM disposal WHERE user_id = $1 AND migration_batch_id IS NULL AND disposal_date < $2::date) AS n`,
    [userId, ctx.D]
  );
  const preN = Number(pre.rows[0].n);
  if (preN > 0) warnings.push({ code: 'DM07_PRE_CUTOVER', message: `기준일(${ctx.D}) 이전 날짜의 일반 거래가 ${preN}건 있습니다 — 이관 재고·잔액과 겹칠 수 있습니다.` });

  // 건수
  const counts = {};
  let errors = 0;
  let rowWarnings = 0;
  for (const [kind, rs] of Object.entries(results)) {
    const c = { rows: rs.length, created: 0, existing: 0, saved: 0, history: 0, disposed: 0, errors: 0, warnings: 0, amount: 0, qty: 0 };
    for (const r of rs) {
      if (!r.ok) c.errors += 1;
      else c[r.status] += 1;
      if (r.warning) c.warnings += 1;
      if (r.ok && r.amount) c.amount = Math.round((c.amount + Number(r.amount)) * 100) / 100;
      if (r.ok && r.qty) c.qty = Math.round((c.qty + Number(r.qty)) * 1000) / 1000;
    }
    errors += c.errors;
    rowWarnings += c.warnings;
    counts[kind] = c;
  }
  return { results, warnings, counts, errors, rowWarnings, restore: ctx.restore };
}

// ---------------------------------------------------------------------------
// 4. 되돌리기 — 막는 참조
// ---------------------------------------------------------------------------
async function rollbackBlockers(db, userId, batchId) {
  const blockers = [];
  const add = async (type, label, sql) => {
    const r = await db.query(sql, [userId, batchId]);
    if (r.rows.length) {
      const n = Number(r.rows[0].total_n || r.rows.length);
      blockers.push({ type, label, count: n, samples: r.rows.slice(0, 5).map((x) => ({ id: x.id, date: x.d ? (typeof x.d === 'string' ? x.d.slice(0, 10) : `${x.d.getFullYear()}-${pad2(x.d.getMonth() + 1)}-${pad2(x.d.getDate())}`) : null, summary: x.summary })) });
    }
  };
  const S = `(SELECT id FROM sale WHERE user_id = $1 AND migration_batch_id = $2)`;
  const PU = `(SELECT id FROM purchase WHERE user_id = $1 AND migration_batch_id = $2)`;
  const DI = `(SELECT id FROM disposal WHERE user_id = $1 AND migration_batch_id = $2)`;
  const A = `(SELECT id FROM account WHERE user_id = $1 AND migration_batch_id = $2)`;
  const PR = `(SELECT id FROM product WHERE migration_batch_id = $2)`;
  const lim = 'COUNT(*) OVER () AS total_n';
  await add('payment_allocation', '기초 미수에 수금·할인·상계 배분', `
    SELECT pa.id, to_char(p.paid_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS d, ${lim}, '수금 #' || p.id || ' ' || to_char(pa.amount, 'FM999,999,999,990') || '원' || CASE WHEN p.status = 'cancelled' THEN ' (취소됨)' ELSE '' END AS summary
      FROM payment_allocation pa JOIN payment p ON p.id = pa.payment_id WHERE pa.sale_id IN ${S} ORDER BY pa.id LIMIT 50`);
  await add('sale_discount_offset', '기초 미수에 할인·상계', `
    SELECT s.id, s.sale_date AS d, ${lim}, '매출 #' || s.id || ' 할인 ' || s.discount_amount || ' · 상계 ' || s.offset_amount AS summary
      FROM sale s WHERE s.id IN ${S} AND (s.discount_amount > 0 OR s.offset_amount > 0) ORDER BY s.id LIMIT 50`);
  await add('refund', '반품', `
    SELECT r.id, r.refunded_at AS d, ${lim}, '반품 #' || r.id AS summary FROM refund r WHERE r.sale_id IN ${S} OR r.sale_id IN (SELECT sale_id FROM purchase_allocation WHERE purchase_id IN ${PU}) ORDER BY r.id LIMIT 50`);
  await add('supplier_payment_allocation', '기초 미지급에 지급·할인·상계 배분', `
    SELECT a.id, to_char(sp.paid_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS d, ${lim}, '지급 #' || sp.id || ' ' || to_char(a.amount, 'FM999,999,999,990') || '원' || CASE WHEN sp.status = 'cancelled' THEN ' (취소됨)' ELSE '' END AS summary
      FROM supplier_payment_allocation a JOIN supplier_payment sp ON sp.id = a.supplier_payment_id WHERE a.purchase_id IN ${PU} ORDER BY a.id LIMIT 50`);
  await add('purchase_allocation', '이관 재고에서 판매', `
    SELECT pa.id, s.sale_date AS d, ${lim}, '매출 #' || s.id || ' 수량 ' || pa.quantity AS summary
      FROM purchase_allocation pa JOIN sale s ON s.id = pa.sale_id WHERE pa.purchase_id IN ${PU} ORDER BY pa.id LIMIT 50`);
  await add('trade_correction', '정정 기록', `
    SELECT tc.id, to_char(tc.created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS d, ${lim}, tc.target_type || ' #' || tc.target_id || ' ' || tc.action AS summary
      FROM trade_correction tc WHERE tc.user_id = $1 AND ((tc.target_type = 'sale' AND tc.target_id IN ${S}) OR (tc.target_type = 'purchase' AND tc.target_id IN ${PU})) ORDER BY tc.id LIMIT 50`);
  await add('inventory', '되돌리면 재고가 모자람(이미 판매·폐기됨)', `
    WITH need AS (
      SELECT product_id, SUM(q) AS q FROM (
        SELECT product_id, quantity AS q FROM purchase WHERE user_id = $1 AND migration_batch_id = $2 AND entry_kind = 'opening_stock'
        UNION ALL SELECT product_id, -quantity FROM disposal WHERE user_id = $1 AND migration_batch_id = $2
      ) t GROUP BY product_id)
    SELECT n.product_id AS id, NULL::date AS d, ${lim}, p.name || ' 되돌릴 수량 ' || n.q || ' / 현재 재고 ' || COALESCE(i.quantity, 0) AS summary
      FROM need n JOIN product p ON p.id = n.product_id LEFT JOIN inventory i ON i.user_id = $1 AND i.product_id = n.product_id
     WHERE n.q > COALESCE(i.quantity, 0) ORDER BY n.product_id LIMIT 50`);
  await add('partner_used', '이 묶음이 만든 거래처를 다른 거래가 사용', `
    SELECT x.id, x.d, ${lim}, x.summary FROM (
      SELECT pu.id, pu.purchase_date AS d, '매입 #' || pu.id AS summary FROM purchase pu
       WHERE pu.user_id = $1 AND pu.migration_batch_id IS DISTINCT FROM $2 AND (pu.partner_id IN ${A} OR pu.producer_id IN ${A} OR pu.payee_partner_id IN ${A})
      UNION ALL SELECT s.id, s.sale_date, '매출 #' || s.id FROM sale s WHERE s.user_id = $1 AND s.migration_batch_id IS DISTINCT FROM $2 AND s.partner_id IN ${A}
      UNION ALL SELECT p.id, (p.paid_at AT TIME ZONE 'Asia/Seoul')::date, '수금 #' || p.id FROM payment p WHERE p.user_id = $1 AND p.partner_id IN ${A}
      UNION ALL SELECT sp.id, (sp.paid_at AT TIME ZONE 'Asia/Seoul')::date, '지급 #' || sp.id FROM supplier_payment sp WHERE sp.user_id = $1 AND sp.partner_id IN ${A}
      UNION ALL SELECT so.id, (so.offset_at AT TIME ZONE 'Asia/Seoul')::date, '상계 #' || so.id FROM settlement_offset so WHERE so.user_id = $1 AND so.partner_id IN ${A}
      UNION ALL SELECT pr.id, pr.sent_on, '입금 안내 #' || pr.id FROM payment_reminder pr WHERE pr.user_id = $1 AND pr.partner_id IN ${A}
      UNION ALL SELECT mh.id::int, mh.txn_date, '다른 묶음의 이관 기록 #' || mh.id FROM migration_history mh WHERE mh.batch_id <> $2 AND mh.partner_id IN ${A}
      UNION ALL SELECT t.id, (t.transferred_at AT TIME ZONE 'Asia/Seoul')::date, '재고 이동 #' || t.id FROM product_transfer t
       WHERE t.user_id = $1 AND (t.from_partner_id IN ${A} OR t.to_partner_id IN ${A})
         AND (t.purchase_id IS NULL OR t.purchase_id NOT IN ${PU}) AND (t.disposal_id IS NULL OR t.disposal_id NOT IN ${DI})
    ) x ORDER BY x.d, x.id LIMIT 50`);
  await add('product_used', '이 묶음이 만든 품목을 다른 거래가 사용(공용 품목은 다른 회원 포함)', `
    SELECT x.id, x.d, ${lim}, x.summary FROM (
      SELECT pu.id, pu.purchase_date AS d, '매입 #' || pu.id || CASE WHEN pu.user_id <> $1 THEN ' (다른 회원)' ELSE '' END AS summary FROM purchase pu
       WHERE pu.migration_batch_id IS DISTINCT FROM $2 AND pu.product_id IN ${PR}
      UNION ALL SELECT s.id, s.sale_date, '매출 #' || s.id || CASE WHEN s.user_id <> $1 THEN ' (다른 회원)' ELSE '' END FROM sale s
       WHERE s.migration_batch_id IS DISTINCT FROM $2 AND s.product_id IN ${PR}
      UNION ALL SELECT d.id, d.disposal_date, '폐기 #' || d.id FROM disposal d WHERE d.migration_batch_id IS DISTINCT FROM $2 AND d.product_id IN ${PR}
      UNION ALL SELECT dp.id, dp.price_date, '시세 #' || dp.id FROM product_daily_price dp WHERE dp.product_id IN ${PR}
      UNION ALL SELECT rq.id, rq.created_at::date, '품목 요청 #' || rq.id FROM product_request rq WHERE rq.product_id IN ${PR}
      UNION ALL SELECT mh.id::int, mh.txn_date, '다른 묶음의 이관 기록 #' || mh.id FROM migration_history mh WHERE mh.batch_id <> $2 AND mh.product_id IN ${PR}
      UNION ALL SELECT i.id, NULL::date, '다른 회원 재고' FROM inventory i WHERE i.user_id <> $1 AND i.product_id IN ${PR} AND i.quantity > 0
    ) x ORDER BY x.d NULLS LAST, x.id LIMIT 50`);
  return blockers;
}

async function doRollback(client, userId, batch) {
  const B = batch.id;
  // 기준일 이후 폐기: 재고를 되돌리고 이동 이력·폐기 삭제
  const dis = await client.query(`SELECT id, product_id, quantity FROM disposal WHERE user_id = $1 AND migration_batch_id = $2 ORDER BY id`, [userId, B]);
  if (dis.rows.length) {
    await client.query(`DELETE FROM product_transfer WHERE user_id = $1 AND disposal_id = ANY($2::int[])`, [userId, dis.rows.map((r) => r.id)]);
    await client.query(
      `INSERT INTO inventory (user_id, product_id, quantity) SELECT $1, x.prid, SUM(x.q) FROM unnest($2::int[], $3::numeric[]) x(prid, q) GROUP BY x.prid
       ON CONFLICT (user_id, product_id) DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [userId, dis.rows.map((r) => r.product_id), dis.rows.map((r) => r.quantity)]
    );
    await client.query(`DELETE FROM disposal WHERE user_id = $1 AND migration_batch_id = $2`, [userId, B]);
  }
  // 이관 재고: 이동 이력·재고 차감·매입 삭제
  const lots = await client.query(
    `SELECT product_id, SUM(quantity) AS q FROM purchase WHERE user_id = $1 AND migration_batch_id = $2 AND entry_kind = 'opening_stock' GROUP BY product_id ORDER BY product_id`,
    [userId, B]
  );
  await client.query(`DELETE FROM product_transfer WHERE user_id = $1 AND purchase_id IN (SELECT id FROM purchase WHERE user_id = $1 AND migration_batch_id = $2)`, [userId, B]);
  for (const l of lots.rows) {
    // eslint-disable-next-line no-await-in-loop
    const r = await client.query(
      `UPDATE inventory SET quantity = quantity - $3::numeric, updated_at = NOW() WHERE user_id = $1 AND product_id = $2 AND quantity - $3::numeric >= 0`,
      [userId, l.product_id, l.q]
    );
    if (r.rowCount === 0) {
      const e = new Error('재고가 부족해 되돌릴 수 없습니다.');
      e.code = 'ROLLBACK_INVENTORY';
      throw e;
    }
  }
  const delPu = await client.query(`DELETE FROM purchase WHERE user_id = $1 AND migration_batch_id = $2`, [userId, B]);
  const delSa = await client.query(`DELETE FROM sale WHERE user_id = $1 AND migration_batch_id = $2`, [userId, B]);
  const delH = await client.query(`DELETE FROM migration_history WHERE batch_id = $1`, [B]);
  // 품목: 0 재고 행 정리 후 삭제(공용 품목은 다른 회원의 0 재고 행도)
  await client.query(`DELETE FROM inventory WHERE quantity = 0 AND product_id IN (SELECT id FROM product WHERE migration_batch_id = $1)`, [B]);
  const delPr = await client.query(`DELETE FROM product WHERE migration_batch_id = $1`, [B]);
  const delA = await client.query(`DELETE FROM account WHERE user_id = $1 AND migration_batch_id = $2`, [userId, B]);
  const restore = batch.restore || {};
  if (Array.isArray(restore.account) && restore.account.length) {
    await client.query(`UPDATE account SET external_code = NULL, updated_at = NOW() WHERE user_id = $1 AND id = ANY($2::int[])`, [userId, restore.account]);
  }
  if (Array.isArray(restore.product) && restore.product.length) {
    await client.query(`UPDATE product SET external_code = NULL, updated_at = NOW() WHERE id = ANY($1::int[])`, [restore.product]);
  }
  return { purchases: delPu.rowCount, sales: delSa.rowCount, history: delH.rowCount, products: delPr.rowCount, partners: delA.rowCount, disposals: dis.rows.length };
}

// ---------------------------------------------------------------------------
// 5. 대조 리포트 — "파일 합"은 보관한 줄에서, "저장 합"은 DB 에서 따로 계산
// ---------------------------------------------------------------------------
async function buildReconcile(db, userId, batch, files) {
  const B = batch.id;
  const fileOf = (k) => files.find((f) => f.kind === k);
  const resolvePartner = async (text) => {
    const r = await db.query(
      `SELECT id, name FROM account WHERE user_id = $1 AND (external_code = btrim($2) OR lower(btrim(name)) = lower(btrim($2)))
        ORDER BY (external_code = btrim($2)) DESC NULLS LAST, id LIMIT 1`, [userId, text]
    );
    return r.rows[0] || null;
  };
  const resolveProduct = async (text) => {
    const r = await db.query(
      `SELECT id, name FROM product WHERE (owner_user_id IS NULL OR owner_user_id = $1) AND NOT is_system AND (external_code = btrim($2) OR lower(btrim(name)) = lower(btrim($2)))
        ORDER BY (external_code = btrim($2)) DESC NULLS LAST, (owner_user_id IS NULL) DESC, id LIMIT 1`, [userId, text]
    );
    return r.rows[0] || null;
  };
  const cache = new Map();
  const memo = async (fn, key) => {
    if (!cache.has(key)) cache.set(key, await fn(key.slice(2)));
    return cache.get(key);
  };

  async function moneySection(kind) {
    const f = fileOf(kind);
    const groups = new Map();
    if (f) {
      for (const r of f.rows || []) {
        const t = textOf((r.vals || {}).partner);
        // eslint-disable-next-line no-await-in-loop
        const p = t ? await memo(resolvePartner, `p:${t}`) : null;
        const key = p ? `id:${p.id}` : `t:${t}`;
        const g = groups.get(key) || { partner_id: p ? p.id : null, partner_name: p ? p.name : t, file_c: 0, file_lines: 0 };
        g.file_c += cents(readNumber((r.vals || {}).amount) || 0);
        g.file_lines += 1;
        groups.set(key, g);
      }
    }
    const saved = kind === 'opening_ar'
      ? await db.query(`SELECT partner_id, SUM(total_amount) AS amt, COUNT(*)::int AS n FROM sale WHERE user_id = $1 AND migration_batch_id = $2 AND entry_mode = 'opening' GROUP BY partner_id`, [userId, B])
      : await db.query(`SELECT payee_partner_id AS partner_id, SUM(total_amount) AS amt, COUNT(*)::int AS n FROM purchase WHERE user_id = $1 AND migration_batch_id = $2 AND entry_kind = 'opening_ap' GROUP BY payee_partner_id`, [userId, B]);
    for (const s of saved.rows) {
      const key = `id:${s.partner_id}`;
      if (!groups.has(key)) {
        const n = await db.query(`SELECT name FROM account WHERE id = $1`, [s.partner_id]);
        groups.set(key, { partner_id: s.partner_id, partner_name: n.rows[0] ? n.rows[0].name : String(s.partner_id), file_c: 0, file_lines: 0 });
      }
      groups.get(key).saved_c = cents(s.amt);
      groups.get(key).saved_lines = s.n;
    }
    const ids = [...groups.values()].map((g) => g.partner_id).filter(Boolean);
    const cur = ids.length
      ? await db.query(kind === 'opening_ar'
        ? `SELECT partner_id, receivable_amount AS v FROM receivables_by_partner WHERE user_id = $1 AND partner_id = ANY($2::int[])`
        : `SELECT partner_id, payable_amount AS v FROM payables_by_partner WHERE user_id = $1 AND partner_id = ANY($2::int[])`, [userId, ids])
      : { rows: [] };
    const curMap = new Map(cur.rows.map((r) => [r.partner_id, Number(r.v)]));
    const rows = [...groups.values()].map((g) => ({
      partner_id: g.partner_id, partner_name: g.partner_name, file_lines: g.file_lines, saved_lines: g.saved_lines || 0,
      file_amount: money(g.file_c), saved_amount: money(g.saved_c || 0), diff: money(g.file_c - (g.saved_c || 0)),
      current: g.partner_id ? (curMap.get(g.partner_id) ?? 0) : null,
    })).sort((a, b) => String(a.partner_name).localeCompare(String(b.partner_name), 'ko'));
    const sum = (k) => Math.round(rows.reduce((t, r) => t + cents(r[k] || 0), 0)) / 100;
    return { rows, total: { file_amount: sum('file_amount'), saved_amount: sum('saved_amount'), diff: sum('diff'), current: sum('current') } };
  }

  async function stockSection() {
    const f = fileOf('opening_stock');
    const groups = new Map();
    if (f) {
      for (const r of f.rows || []) {
        const v = r.vals || {};
        const t = textOf(v.product);
        // eslint-disable-next-line no-await-in-loop
        const p = t ? await memo(resolveProduct, `r:${t}`) : null;
        const key = p ? `id:${p.id}` : `t:${t}`;
        const g = groups.get(key) || { product_id: p ? p.id : null, product_name: p ? p.name : t, fq: 0, fa: 0 };
        const q = Number(readNumber(v.quantity, { maxDecimals: 3 }) || 0);
        const pr = Number(readNumber(v.unit_price) || 0);
        g.fq += Math.round(q * 1000);
        g.fa += Math.round(q * pr * 100);
        groups.set(key, g);
      }
    }
    const saved = await db.query(
      `SELECT product_id, SUM(quantity) AS q, SUM(ROUND(quantity * unit_price, 2)) AS a, COUNT(*)::int AS lots FROM purchase
        WHERE user_id = $1 AND migration_batch_id = $2 AND entry_kind = 'opening_stock' GROUP BY product_id`, [userId, B]
    );
    for (const s of saved.rows) {
      const key = `id:${s.product_id}`;
      if (!groups.has(key)) {
        const n = await db.query(`SELECT name FROM product WHERE id = $1`, [s.product_id]);
        groups.set(key, { product_id: s.product_id, product_name: n.rows[0] ? n.rows[0].name : String(s.product_id), fq: 0, fa: 0 });
      }
      Object.assign(groups.get(key), { sq: Math.round(Number(s.q) * 1000), sa: cents(s.a), lots: s.lots });
    }
    const disp = await db.query(`SELECT product_id, SUM(quantity) AS q FROM disposal WHERE user_id = $1 AND migration_batch_id = $2 GROUP BY product_id`, [userId, B]);
    const dMap = new Map(disp.rows.map((r) => [r.product_id, Number(r.q)]));
    const ids = [...groups.values()].map((g) => g.product_id).filter(Boolean);
    const inv = ids.length ? await db.query(`SELECT product_id, quantity FROM inventory WHERE user_id = $1 AND product_id = ANY($2::int[])`, [userId, ids]) : { rows: [] };
    const iMap = new Map(inv.rows.map((r) => [r.product_id, Number(r.quantity)]));
    const rows = [...groups.values()].map((g) => ({
      product_id: g.product_id, product_name: g.product_name, lots: g.lots || 0,
      file_qty: g.fq / 1000, saved_qty: (g.sq || 0) / 1000, diff_qty: (g.fq - (g.sq || 0)) / 1000,
      file_amount: money(g.fa), saved_amount: money(g.sa || 0), diff_amount: money(g.fa - (g.sa || 0)),
      disposed_after: g.product_id ? (dMap.get(g.product_id) || 0) : 0,
      current_qty: g.product_id ? (iMap.get(g.product_id) ?? 0) : null,
    })).sort((a, b) => String(a.product_name).localeCompare(String(b.product_name), 'ko'));
    const sumC = (k) => Math.round(rows.reduce((t, r) => t + cents(r[k] || 0), 0)) / 100;
    const sumQ = (k) => Math.round(rows.reduce((t, r) => t + Math.round(Number(r[k] || 0) * 1000), 0)) / 1000;
    return { rows, total: { file_qty: sumQ('file_qty'), saved_qty: sumQ('saved_qty'), diff_qty: sumQ('diff_qty'), file_amount: sumC('file_amount'), saved_amount: sumC('saved_amount'), diff_amount: sumC('diff_amount'), disposed_after: sumQ('disposed_after'), current_qty: sumQ('current_qty') } };
  }

  const counts = batch.counts || {};
  const summary = ORDER.map((k) => {
    const f = fileOf(k);
    const c = counts[k] || {};
    return {
      kind: k, label: MK[k].label, file_name: f ? f.file_name : null, file_rows: f ? f.row_count : 0,
      created: c.created || 0, existing: c.existing || 0, saved: c.saved || 0, history: c.history || 0, disposed: c.disposed || 0, errors: c.errors || 0,
      matched: f ? f.row_count === (c.created || 0) + (c.existing || 0) + (c.saved || 0) + (c.history || 0) + (c.disposed || 0) : true,
    };
  });
  const ar = await moneySection('opening_ar');
  const ap = await moneySection('opening_ap');
  const stock = await stockSection();
  const allZero = ar.rows.every((r) => r.diff === 0) && ap.rows.every((r) => r.diff === 0)
    && stock.rows.every((r) => r.diff_qty === 0 && r.diff_amount === 0) && summary.every((s) => s.matched);
  return {
    batch: { id: batch.id, cutover_date: ymdOf(batch.cutover_date), status: batch.status, saved_at: batch.saved_at },
    all_zero: allZero, summary, receivable: ar, payable: ap, stock,
  };
}

async function reconcileXlsx(rep) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '판매툴';
  const red = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD6D6' } };
  const sheet = (name, cols, rows, total, diffKeys) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width: width || 14, style: fmt ? { numFmt: fmt } : {} }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).eachCell((c) => { c.fill = xl.HEAD_FILL; });
    for (const r of rows) {
      const row = ws.addRow(r);
      if (diffKeys.some((k) => Number(r[k] || 0) !== 0 || r[k] === false)) row.eachCell((c) => { c.fill = red; });
    }
    if (total) {
      const t = ws.addRow(total);
      t.font = { bold: true };
    }
  };
  const W = '#,##0';
  sheet('요약', [['대상', 'label', 18], ['파일', 'file_name', 28], ['파일 줄', 'file_rows', 9], ['새로 만듦', 'created', 10], ['기존 사용', 'existing', 10],
    ['기초·재고 저장', 'saved', 13], ['이관 기록', 'history', 10], ['재고 차감 폐기', 'disposed', 13], ['오류', 'errors', 7], ['줄 수 일치', 'matched', 10]],
  rep.summary, null, ['errors']);
  const moneyCols = [['거래처', 'partner_name', 22], ['파일 줄', 'file_lines', 9], ['파일 합', 'file_amount', 15, W], ['저장 합', 'saved_amount', 15, W], ['차이', 'diff', 12, W], ['현재 잔액', 'current', 15, W]];
  sheet('기초 미수', moneyCols, rep.receivable.rows, { partner_name: '합계', ...rep.receivable.total }, ['diff']);
  sheet('기초 미지급', moneyCols, rep.payable.rows, { partner_name: '합계', ...rep.payable.total }, ['diff']);
  sheet('기초 재고', [['품목', 'product_name', 22], ['로트', 'lots', 7], ['파일 수량', 'file_qty', 11], ['저장 수량', 'saved_qty', 11], ['수량 차이', 'diff_qty', 10],
    ['파일 금액', 'file_amount', 14, W], ['저장 금액', 'saved_amount', 14, W], ['금액 차이', 'diff_amount', 12, W], ['기준일 이후 폐기', 'disposed_after', 14], ['현재 재고', 'current_qty', 11]],
  rep.stock.rows, { product_name: '합계', ...rep.stock.total }, ['diff_qty', 'diff_amount']);
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------------------
// 6. 라우트
// ---------------------------------------------------------------------------
function registerMigrationRoutes(app, deps) {
  const { pool, authorize, getUserId, recordAudit, kstToday, getUserWarehouseLabel } = deps;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
  const receiveFile = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE', message: '파일은 5MB까지 올릴 수 있습니다.' });
    return res.status(400).json({ ok: false, code: 'BAD_FILE', message: '파일을 받지 못했습니다. 엑셀 파일 하나를 골라 주세요.' });
  });
  const fail = (res, status, code, message, extra) => res.status(status).json({ ok: false, code, message, ...(extra || {}) });
  const parseBatchId = (raw) => (/^\d{1,12}$/.test(String(raw || '')) ? String(raw) : null);

  async function loadBatch(db, userId, id, lock) {
    const r = await db.query(`SELECT * FROM migration_batch WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, userId]);
    return r.rows[0] || null;
  }
  async function loadFiles(db, batchId, withRows) {
    const r = await db.query(
      `SELECT id, kind, file_hash, file_name, row_count, amount_total, qty_total, active, created_at, result${withRows ? ', rows' : ''}
         FROM migration_batch_file WHERE batch_id = $1 ORDER BY id`, [batchId]
    );
    return r.rows;
  }
  const batchOut = (b) => ({
    id: Number(b.id), cutover_date: ymdOf(b.cutover_date), status: b.status, memo: b.memo, counts: b.counts, warnings: b.warnings,
    saved_at: b.saved_at, rolled_back_at: b.rolled_back_at, rollback_reason: b.rollback_reason, created_at: b.created_at,
  });
  const fileOut = (f) => ({
    kind: f.kind, label: MK[f.kind].label, file_name: f.file_name, row_count: f.row_count,
    amount_total: f.amount_total == null ? null : Number(f.amount_total), qty_total: f.qty_total == null ? null : Number(f.qty_total),
    created_at: f.created_at, result: f.result || null,
  });

  // R-79 템플릿
  app.get('/api/migrations/template/:kind', async (req, res) => {
    const def = MK[String(req.params.kind || '')];
    if (!def) return fail(res, 404, 'NOT_FOUND', '없는 이관 대상입니다.');
    try {
      const buf = await xl.buildTemplate(def, { maxRows: MAX_ROWS, notes: GUIDE(def) });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="migration_${def.kind}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${def.file}.xlsx`)}`);
      return res.send(Buffer.from(buf));
    } catch (err) {
      console.error('migration template error:', err);
      return fail(res, 500, 'SERVER', '템플릿을 만들지 못했습니다.');
    }
  });

  // R-80 목록
  app.get('/api/migrations', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    try {
      const r = await pool.query(
        `SELECT b.*, (SELECT COUNT(*)::int FROM migration_batch_file f WHERE f.batch_id = b.id) AS file_count
           FROM migration_batch b WHERE b.user_id = $1 ORDER BY b.created_at DESC, b.id DESC LIMIT 200`, [userId]
      );
      return res.json({ ok: true, data: r.rows.map((b) => ({ ...batchOut(b), file_count: b.file_count })), kinds: ORDER.map((k) => ({ kind: k, label: MK[k].label })) });
    } catch (err) {
      console.error('migration list error:', err);
      return fail(res, 500, 'SERVER', '이관 묶음을 불러오지 못했습니다.');
    }
  });

  // R-81 묶음 만들기
  app.post('/api/migrations', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const d = String((req.body || {}).cutover_date || '').trim();
    if (!isYmd(d)) return fail(res, 400, 'VALIDATION', '기준일을 YYYY-MM-DD 형식으로 입력하세요.', { field: 'cutover_date' });
    if (d > kstToday()) return fail(res, 400, 'CUTOVER_FUTURE', `기준일은 오늘(${kstToday()})까지만 정할 수 있습니다.`, { field: 'cutover_date' });
    const memo = (req.body || {}).memo == null ? null : String(req.body.memo).trim().slice(0, 200) || null;
    try {
      const other = await pool.query(`SELECT id, cutover_date FROM migration_batch WHERE user_id = $1 AND status = 'saved' AND cutover_date <> $2::date LIMIT 1`, [userId, d]);
      if (other.rows[0]) {
        return fail(res, 400, 'CUTOVER_MISMATCH', `이미 저장한 묶음 #${other.rows[0].id}의 기준일(${ymdOf(other.rows[0].cutover_date)})과 같아야 합니다.`, { field: 'cutover_date' });
      }
      const r = await pool.query(`INSERT INTO migration_batch (user_id, cutover_date, memo) VALUES ($1, $2, $3) RETURNING *`, [userId, d, memo]);
      return res.status(201).json({ ok: true, data: batchOut(r.rows[0]) });
    } catch (err) {
      console.error('migration create error:', err);
      return fail(res, 500, 'SERVER', '이관 묶음을 만들지 못했습니다.');
    }
  });

  // R-82 상세
  app.get('/api/migrations/:id', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
    try {
      const b = await loadBatch(pool, userId, id);
      if (!b) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      const files = await loadFiles(pool, id, false);
      return res.json({ ok: true, data: { ...batchOut(b), files: files.map(fileOut) }, kinds: ORDER.map((k) => ({ kind: k, label: MK[k].label })) });
    } catch (err) {
      console.error('migration detail error:', err);
      return fail(res, 500, 'SERVER', '이관 묶음을 불러오지 못했습니다.');
    }
  });

  // R-83 draft 삭제
  app.delete('/api/migrations/:id', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
    try {
      const b = await loadBatch(pool, userId, id);
      if (!b) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      if (b.status !== 'draft') return fail(res, 409, 'NOT_DRAFT', '저장한 묶음은 삭제하지 않고 되돌립니다.');
      await pool.query(`DELETE FROM migration_batch WHERE id = $1 AND user_id = $2 AND status = 'draft'`, [id, userId]);
      return res.json({ ok: true });
    } catch (err) {
      console.error('migration delete error:', err);
      return fail(res, 500, 'SERVER', '이관 묶음을 삭제하지 못했습니다.');
    }
  });

  // R-84 파일 올리기(같은 대상은 교체)
  app.post('/api/migrations/:id/files/:kind', receiveFile, async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    const kind = String(req.params.kind || '');
    if (!id) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
    if (!MK[kind]) return fail(res, 404, 'NOT_FOUND', '없는 이관 대상입니다.');
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return fail(res, 400, 'NO_FILE', '엑셀 파일을 골라 주세요.');
    try {
      const b = await loadBatch(pool, userId, id);
      if (!b) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      if (b.status !== 'draft') return fail(res, 409, 'NOT_DRAFT', '저장한 묶음에는 파일을 더 올릴 수 없습니다. 새 묶음을 만드세요.');
      const parsed = await xl.parseWorkbook(MK[kind], file.buffer, { maxRows: MAX_ROWS });
      if (parsed.error) return fail(res, 400, parsed.code === 'TOO_MANY_ROWS' ? 'TOO_MANY_ROWS' : 'BAD_FILE', parsed.error);
      const rows = parsed.rows.map((r) => ({ line: r.line, vals: Object.fromEntries(Object.entries(r.vals).map(([k, v]) => [k, cellToJson(v)])) }));
      const hash = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const fileName = Buffer.from(file.originalname || '', 'latin1').toString('utf8').slice(0, 200) || null;
      const tot = fileTotals(kind, rows);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`migration-file:${userId}`]);
        const dup = await client.query(
          `SELECT f.batch_id, f.kind FROM migration_batch_file f WHERE f.user_id = $1 AND f.file_hash = $2 AND f.active AND NOT (f.batch_id = $3 AND f.kind = $4) LIMIT 1`,
          [userId, hash, id, kind]
        );
        if (dup.rows[0]) {
          await client.query('ROLLBACK');
          return fail(res, 409, 'DUPLICATE_FILE', `묶음 #${dup.rows[0].batch_id}에 이미 올린 파일입니다(${MK[dup.rows[0].kind].label}).`, { duplicate: { batch_id: Number(dup.rows[0].batch_id), kind: dup.rows[0].kind } });
        }
        await client.query(`DELETE FROM migration_batch_file WHERE batch_id = $1 AND kind = $2`, [id, kind]);
        await client.query(
          `INSERT INTO migration_batch_file (batch_id, user_id, kind, file_hash, file_name, row_count, amount_total, qty_total, rows)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [id, userId, kind, hash, fileName, rows.length, tot.amount, tot.qty, JSON.stringify(rows)]
        );
        // 파일이 바뀌면 이전 검증 결과는 무효
        await client.query(`UPDATE migration_batch_file SET result = NULL WHERE batch_id = $1`, [id]);
        await client.query(`UPDATE migration_batch SET counts = '{}'::jsonb, warnings = '[]'::jsonb, updated_at = NOW() WHERE id = $1`, [id]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return fail(res, 409, 'DUPLICATE_FILE', '이미 올린 파일입니다.');
        throw err;
      } finally {
        client.release();
      }
      return res.status(201).json({ ok: true, data: { kind, label: MK[kind].label, file_name: fileName, row_count: rows.length, amount_total: tot.amount, qty_total: tot.qty } });
    } catch (err) {
      console.error('migration file error:', err);
      return fail(res, 500, 'SERVER', '파일을 처리하지 못했습니다.');
    }
  });

  // R-85 파일 빼기
  app.delete('/api/migrations/:id/files/:kind', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    const kind = String(req.params.kind || '');
    if (!id || !MK[kind]) return fail(res, 404, 'NOT_FOUND', '파일을 찾을 수 없습니다.');
    try {
      const b = await loadBatch(pool, userId, id);
      if (!b) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      if (b.status !== 'draft') return fail(res, 409, 'NOT_DRAFT', '저장한 묶음의 파일은 뺄 수 없습니다.');
      const r = await pool.query(`DELETE FROM migration_batch_file WHERE batch_id = $1 AND kind = $2`, [id, kind]);
      if (!r.rowCount) return fail(res, 404, 'NOT_FOUND', '올린 파일이 없습니다.');
      await pool.query(`UPDATE migration_batch_file SET result = NULL WHERE batch_id = $1`, [id]);
      await pool.query(`UPDATE migration_batch SET counts = '{}'::jsonb, warnings = '[]'::jsonb, updated_at = NOW() WHERE id = $1`, [id]);
      return res.json({ ok: true });
    } catch (err) {
      console.error('migration file delete error:', err);
      return fail(res, 500, 'SERVER', '파일을 빼지 못했습니다.');
    }
  });

  /** 검증·저장 공통 */
  async function runBatch(req, res, commit) {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
    const started = Date.now();
    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      return fail(res, 503, 'DB_UNAVAILABLE', 'DB 연결이 잠시 원활하지 않습니다. 잠시 후 다시 시도해 주세요.');
    }
    let payload;
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`migration:${userId}`]);
      if (!lock.rows[0].ok) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'MIGRATION_BUSY', '이 계정의 다른 이관 작업(검증·저장·되돌리기)이 진행 중입니다. 잠시 후 다시 시도하세요.');
      }
      const batch = await loadBatch(client, userId, id, true);
      if (!batch) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      }
      if (batch.status !== 'draft') {
        await client.query('ROLLBACK');
        return fail(res, 409, batch.status === 'saved' ? 'ALREADY_SAVED' : 'NOT_DRAFT', batch.status === 'saved' ? '이미 저장한 묶음입니다.' : '되돌린 묶음입니다. 새 묶음을 만드세요.');
      }
      const files = await loadFiles(client, id, true);
      if (!files.length) {
        await client.query('ROLLBACK');
        return fail(res, 400, 'NO_FILES', '올린 파일이 없습니다.');
      }
      const today = kstToday();
      const warehouse = getUserWarehouseLabel ? await getUserWarehouseLabel(client, userId) : null;
      const out = await processBatch({
        client, app, authorize, req, userId, isAdmin: !!(req.auth && req.auth.isAdmin), batch, files, today, warehouse,
      });
      const allWarnings = out.warnings.length + out.rowWarnings;
      payload = {
        batch_id: Number(id), cutover_date: ymdOf(batch.cutover_date),
        summary: { errors: out.errors, warnings: allWarnings, counts: out.counts, elapsed_ms: 0 },
        warnings: out.warnings,
        files: Object.fromEntries(Object.entries(out.results).map(([k, rs]) => [k, { label: MK[k].label, rows: rs }])),
      };
      const confirmed = (req.body || {}).confirm_warnings === true || (req.body || {}).confirm_warnings === 'true';
      const canSave = commit && out.errors === 0 && (allWarnings === 0 || confirmed);
      if (!canSave) {
        await client.query('ROLLBACK');
        // 검증 결과는 묶음에 남겨 둔다(화면이 다시 열 때 보이게) — 저장과 다른 문장(롤백 뒤)
        await pool.query(`UPDATE migration_batch SET counts = $2::jsonb, warnings = $3::jsonb, updated_at = NOW() WHERE id = $1 AND status = 'draft'`,
          [id, JSON.stringify(out.counts), JSON.stringify(out.warnings)]);
        for (const [k, rs] of Object.entries(out.results)) {
          // eslint-disable-next-line no-await-in-loop
          await pool.query(`UPDATE migration_batch_file SET result = $3::jsonb WHERE batch_id = $1 AND kind = $2`, [id, k, JSON.stringify(rs)]);
        }
        payload.summary.elapsed_ms = Date.now() - started;
        if (!commit) return res.json({ ok: true, saved: false, ...payload });
        if (out.errors > 0) return res.status(400).json({ ok: false, code: 'HAS_ERRORS', message: `오류가 ${out.errors}줄 있어 아무것도 저장하지 않았습니다.`, saved: false, ...payload });
        return res.status(409).json({ ok: false, code: 'CONFIRM_REQUIRED', message: `경고 ${allWarnings}건을 확인해야 저장할 수 있습니다.`, saved: false, ...payload });
      }
      await client.query(
        `UPDATE migration_batch SET status = 'saved', saved_at = NOW(), counts = $2::jsonb, warnings = $3::jsonb, restore = $4::jsonb, updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify(out.counts), JSON.stringify(out.warnings), JSON.stringify(out.restore)]
      );
      for (const [k, rs] of Object.entries(out.results)) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(`UPDATE migration_batch_file SET result = $3::jsonb WHERE batch_id = $1 AND kind = $2`, [id, k, JSON.stringify(rs)]);
      }
      const c = out.counts;
      const g = (k, f) => (c[k] ? c[k][f] || 0 : 0);
      const note = `데이터 이관 저장 — 기준일 ${ymdOf(batch.cutover_date)}, 거래처 ${g('partner', 'created')}·품목 ${g('product', 'created')}·`
        + `기초 미수 ${g('opening_ar', 'saved')}건(${won(g('opening_ar', 'amount'))})·기초 미지급 ${g('opening_ap', 'saved')}건(${won(g('opening_ap', 'amount'))})·`
        + `이관 재고 ${g('opening_stock', 'saved')}로트·기록 ${g('history', 'history') + g('disposal', 'history')}건·폐기 ${g('disposal', 'disposed')}건`;
      await recordAudit(client, {
        userId, entityType: 'migration', entityId: Number(id), action: 'migrate', partnerId: null, before: null,
        after: { batch_id: Number(id), cutover_date: ymdOf(batch.cutover_date), counts: c }, note,
      });
      await client.query('COMMIT');
      payload.summary.elapsed_ms = Date.now() - started;
      return res.status(201).json({ ok: true, saved: true, ...payload });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('migration run error:', err);
      return fail(res, 500, 'SERVER', '이관을 처리하지 못했습니다.');
    } finally {
      client.release();
    }
  }
  // R-86 검증 · R-87 저장
  app.post('/api/migrations/:id/validate', (req, res) => runBatch(req, res, false));
  app.post('/api/migrations/:id/commit', (req, res) => runBatch(req, res, true));

  // R-88 되돌리기 확인
  app.get('/api/migrations/:id/rollback-check', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
    try {
      const b = await loadBatch(pool, userId, id);
      if (!b) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      if (b.status !== 'saved') return res.json({ ok: true, data: { can_rollback: false, status: b.status, blockers: [] } });
      const blockers = await rollbackBlockers(pool, userId, b.id);
      return res.json({ ok: true, data: { can_rollback: blockers.length === 0, status: b.status, blockers } });
    } catch (err) {
      console.error('migration rollback-check error:', err);
      return fail(res, 500, 'SERVER', '되돌리기 가능 여부를 확인하지 못했습니다.');
    }
  });

  // R-89 되돌리기
  app.post('/api/migrations/:id/rollback', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
    const reason = String((req.body || {}).reason || '').trim();
    if (!reason) return fail(res, 400, 'VALIDATION', '되돌리는 사유를 입력하세요.', { field: 'reason' });
    if (reason.length > 200) return fail(res, 400, 'VALIDATION', '사유는 200자까지 입력할 수 있습니다.', { field: 'reason' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [`migration:${userId}`]);
      if (!lock.rows[0].ok) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'MIGRATION_BUSY', '이 계정의 다른 이관 작업이 진행 중입니다. 잠시 후 다시 시도하세요.');
      }
      const b = await loadBatch(client, userId, id, true);
      if (!b) {
        await client.query('ROLLBACK');
        return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      }
      if (b.status !== 'saved') {
        await client.query('ROLLBACK');
        return fail(res, 409, 'NOT_SAVED', b.status === 'draft' ? '저장하지 않은 묶음은 삭제하면 됩니다.' : '이미 되돌린 묶음입니다.');
      }
      // 잠금 순서: 묶음 → 매출·매입(id 순) → 재고
      await client.query(`SELECT id FROM sale WHERE user_id = $1 AND migration_batch_id = $2 ORDER BY id FOR UPDATE`, [userId, id]);
      await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND migration_batch_id = $2 ORDER BY id FOR UPDATE`, [userId, id]);
      await client.query(
        `SELECT id FROM inventory WHERE user_id = $1 AND product_id IN (SELECT product_id FROM purchase WHERE user_id = $1 AND migration_batch_id = $2
           UNION SELECT product_id FROM disposal WHERE user_id = $1 AND migration_batch_id = $2) ORDER BY product_id FOR UPDATE`, [userId, id]
      );
      const blockers = await rollbackBlockers(client, userId, id);
      if (blockers.length) {
        await client.query('ROLLBACK');
        return fail(res, 409, 'ROLLBACK_BLOCKED', '이 묶음의 데이터를 이후 거래가 사용하고 있어 되돌릴 수 없습니다.', { blockers });
      }
      const removed = await doRollback(client, userId, b);
      await client.query(`UPDATE migration_batch_file SET active = false, rows = '[]'::jsonb WHERE batch_id = $1`, [id]);
      await client.query(
        `UPDATE migration_batch SET status = 'rolled_back', rolled_back_at = NOW(), rollback_reason = $2, updated_at = NOW() WHERE id = $1`, [id, reason]
      );
      await recordAudit(client, {
        userId, entityType: 'migration', entityId: Number(id), action: 'rollback', partnerId: null,
        before: { status: 'saved' }, after: { status: 'rolled_back', removed },
        note: `데이터 이관 되돌림 — 묶음 #${id}, ${reason}`,
      });
      await client.query('COMMIT');
      return res.json({ ok: true, data: { id: Number(id), status: 'rolled_back', removed } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === 'ROLLBACK_INVENTORY') return fail(res, 409, 'ROLLBACK_BLOCKED', err.message, { blockers: [{ type: 'inventory', label: err.message, count: 1, samples: [] }] });
      if (err.code === '23503') return fail(res, 409, 'ROLLBACK_BLOCKED', '다른 데이터가 이 묶음의 거래처·품목을 사용하고 있어 되돌릴 수 없습니다.', { blockers: [{ type: 'reference', label: err.detail || err.message, count: 1, samples: [] }] });
      console.error('migration rollback error:', err);
      return fail(res, 500, 'SERVER', '되돌리지 못했습니다.');
    } finally {
      client.release();
    }
  });

  // R-90 대조 리포트
  app.get('/api/migrations/:id/reconcile', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const id = parseBatchId(req.params.id);
    if (!id) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
    try {
      const b = await loadBatch(pool, userId, id);
      if (!b) return fail(res, 404, 'NOT_FOUND', '이관 묶음을 찾을 수 없습니다.');
      if (b.status !== 'saved') return fail(res, 409, 'NOT_SAVED', '대조 리포트는 저장한 묶음만 볼 수 있습니다.');
      const files = await loadFiles(pool, id, true);
      const rep = await buildReconcile(pool, userId, b, files);
      if (String(req.query.format || '') === 'xlsx') {
        const buf = await reconcileXlsx(rep);
        const name = `이관대조_${id}_${rep.batch.cutover_date}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="reconcile_${id}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
        return res.send(Buffer.from(buf));
      }
      return res.json({ ok: true, data: rep });
    } catch (err) {
      console.error('migration reconcile error:', err);
      return fail(res, 500, 'SERVER', '대조 리포트를 만들지 못했습니다.');
    }
  });

  // R-91 이관 기록 조회
  app.get('/api/migration-history', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return fail(res, 401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    const q = req.query || {};
    const opts = parseListOptions({ limit: q.limit, offset: q.offset, q: q.q });
    if (opts.error) return res.status(400).json(opts.error);
    if (!opts.paged) {
      opts.paged = true;
      opts.limit = 50;
    }
    const params = [userId];
    let where = 'WHERE h.user_id = $1';
    const from = String(q.from_date || '').trim();
    const to = String(q.to_date || '').trim();
    if (from) {
      if (!isYmd(from)) return fail(res, 400, 'VALIDATION', '시작일 형식이 올바르지 않습니다(YYYY-MM-DD).', { field: 'from_date' });
      params.push(from);
      where += ` AND h.txn_date >= $${params.length}::date`;
    }
    if (to) {
      if (!isYmd(to)) return fail(res, 400, 'VALIDATION', '종료일 형식이 올바르지 않습니다(YYYY-MM-DD).', { field: 'to_date' });
      params.push(to);
      where += ` AND h.txn_date <= $${params.length}::date`;
    }
    const kind = String(q.kind || '').trim();
    if (kind) {
      if (!HISTORY_KIND_LABEL[kind]) return fail(res, 400, 'VALIDATION', '구분이 올바르지 않습니다.', { field: 'kind' });
      params.push(kind);
      where += ` AND h.kind = $${params.length}`;
    }
    for (const [key, col] of [['partner_id', 'h.partner_id'], ['batch_id', 'h.batch_id']]) {
      if (q[key] != null && String(q[key]).trim() !== '') {
        const s = String(q[key]).trim();
        if (!/^\d{1,12}$/.test(s)) return fail(res, 400, 'VALIDATION', '번호가 올바르지 않습니다.', { field: key });
        params.push(s);
        where += ` AND ${col} = $${params.length}`;
      }
    }
    if (opts.like) {
      params.push(opts.like);
      where += ` AND (h.partner_name ILIKE $${params.length} OR h.product_name ILIKE $${params.length} OR h.memo ILIKE $${params.length} OR h.external_ref ILIKE $${params.length})`;
    }
    try {
      const base = `SELECT h.id, h.batch_id, h.kind, h.txn_date, h.partner_id, h.partner_name, h.product_id, h.product_name, h.quantity, h.unit_price, h.amount,
                           h.cost_amount, h.external_ref, h.memo, h.line_no
                      FROM migration_history h JOIN migration_batch b ON b.id = h.batch_id AND b.status = 'saved' ${where}`;
      const out = await runList(pool, base, params, ' ORDER BY h.txn_date DESC, h.id DESC', opts);
      out.data = out.data.map((r) => ({ ...r, batch_id: Number(r.batch_id), id: Number(r.id), txn_date: ymdOf(r.txn_date), kind_label: HISTORY_KIND_LABEL[r.kind] }));
      return res.json(out);
    } catch (err) {
      console.error('migration history error:', err);
      return fail(res, 500, 'SERVER', '이관 기록을 불러오지 못했습니다.');
    }
  });
}

module.exports = { registerMigrationRoutes, MK, ORDER, MAX_ROWS, MAX_BYTES, SYSTEM_PRODUCT_NAME, buildReconcile, rollbackBlockers };
