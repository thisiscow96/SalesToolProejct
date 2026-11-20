/**
 * T-204 목록별 CSV 열 정의 — 화면 표의 열 순서·표시 규칙을 따른다.
 * 날짜는 화면과 같은 규칙으로 YYYY-MM-DD(날짜 문자열 앞 10자리, 없으면 등록 시각의 로컬 날짜),
 * 화면에 시:분이 보이는 목록은 "시각" 열(HH:mm)을 따로 둔다(엑셀에서 날짜 열로 정렬·필터 가능).
 * 숫자는 type: 'number' → 콤마 없이 저장.
 */
import { downloadCsv, csvFileName, todayYmd } from './csv';

const pad2 = (n) => String(n).padStart(2, '0');

function toYmd(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return todayYmd(v);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function validDate(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 화면 formatXxxDateTime 과 같은 규칙: 날짜 = 업무일 필드(없으면 등록 시각 날짜) */
function datePart(dateField, createdAt) {
  const ymd = toYmd(dateField);
  if (ymd) return ymd;
  const d = validDate(createdAt);
  return d ? todayYmd(d) : '';
}

function timePart(ts) {
  const d = validDate(ts);
  return d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
}

const trimOrEmpty = (v) => (v == null ? '' : String(v).trim());

const PAY_STATUS = { paid: '완료', partial: '일부' };
const PURCHASE_PAY_STATUS = { paid: '완료', partial: '일부', unpaid: '미지급' };
const PAY_METHOD = { cash: '현금', transfer: '계좌이체', bill: '어음', other: '기타' };
const SALE_STATUS = { refunded: '전액환불', cancelled: '취소' };

const LISTS = {
  inventory: {
    name: '재고현황',
    columns: [
      { header: '상품명', value: (r) => r.product_name },
      { header: '출처', value: (r) => trimOrEmpty(r.last_source_name) },
      { header: '매입 거래처', value: (r) => trimOrEmpty(r.last_partner_name) },
      { header: '수량', type: 'number', value: (r) => r.quantity },
      { header: '단위', value: (r) => r.unit },
      { header: '최근 매입일', value: (r) => datePart(r.last_purchase_date, r.last_purchase_created_at) },
      { header: '경과일', type: 'number', value: (r) => r.aging_days },
    ],
  },
  purchases: {
    name: '매입정보',
    columns: [
      { header: '매입일', value: (r) => datePart(r.purchase_date, r.created_at) },
      { header: '등록 시각', value: (r) => timePart(r.created_at) },
      { header: '출처', value: (r) => trimOrEmpty(r.source_name) },
      { header: '매입 거래처', value: (r) => r.partner_name },
      { header: '상품', value: (r) => r.product_name },
      { header: '수량', type: 'number', value: (r) => r.quantity },
      { header: '매출 반영', type: 'number', value: (r) => r.allocated_qty || 0 },
      { header: '잔여', type: 'number', value: (r) => (r.remaining_qty != null ? r.remaining_qty : r.quantity) },
      { header: '단가', type: 'number', value: (r) => r.unit_price },
      { header: '총액', type: 'number', value: (r) => r.total_amount },
      // T-201 지급 — 취소 매입은 빈칸
      { header: '지급', value: (r) => (r.status === 'cancelled' ? '' : PURCHASE_PAY_STATUS[r.payment_status] || '') },
      { header: '미지급액', type: 'number', value: (r) => (r.status === 'cancelled' ? '' : Number(r.unpaid_amount) || 0) },
    ],
  },
  sales: {
    name: '매출정보',
    columns: [
      { header: '매출일', value: (r) => datePart(r.sale_date, r.created_at) },
      { header: '등록 시각', value: (r) => timePart(r.created_at) },
      { header: '거래처', value: (r) => r.partner_name },
      { header: '상품', value: (r) => r.product_name },
      { header: '총 수량', type: 'number', value: (r) => r.quantity },
      { header: '환불된 수량', type: 'number', value: (r) => r.refunded_qty || 0 },
      { header: '단가', type: 'number', value: (r) => r.unit_price },
      { header: '총액', type: 'number', value: (r) => r.total_amount },
      { header: '수금', value: (r) => PAY_STATUS[r.payment_status] || '미수' },
      { header: '상태', value: (r) => SALE_STATUS[r.status] || '정상' },
    ],
  },
  payments: {
    name: '수금정보',
    columns: [
      { header: '수금일', value: (r) => { const d = validDate(r.paid_at); return d ? todayYmd(d) : ''; } },
      { header: '시각', value: (r) => timePart(r.paid_at) },
      { header: '구분', value: (r) => ((r.entry_kind || 'receive') === 'refund' ? '환불' : '수금') },
      { header: '거래처', value: (r) => r.partner_name },
      { header: '금액', type: 'number', value: (r) => r.amount },
      { header: '비고', value: (r) => r.memo || '' },
    ],
  },
  /** T-201 지급정보 — 지급일시(KST)·배분 요약. 취소 지급은 상태 열에 '취소' */
  supplierPayments: {
    name: '지급정보',
    columns: [
      { header: '지급일', value: (r) => { const d = validDate(r.paid_at); return d ? todayYmd(d) : ''; } },
      { header: '시각', value: (r) => timePart(r.paid_at) },
      { header: '구분', value: (r) => (r.kind === 'opening' ? '기초 정리' : '지급') },
      { header: '매입처', value: (r) => r.partner_name },
      { header: '금액', type: 'number', value: (r) => r.amount },
      { header: '방법', value: (r) => PAY_METHOD[r.method] || '' },
      { header: '배분', value: (r) => (r.allocations || []).map((a) => `#${a.purchase_id} ${a.amount}`).join(' / ') },
      { header: '비고', value: (r) => r.memo || '' },
      { header: '상태', value: (r) => (r.status === 'cancelled' ? '취소' : '정상') },
      { header: '취소 사유', value: (r) => r.cancel_reason || '' },
    ],
  },
  disposals: {
    name: '폐기정보',
    columns: [
      { header: '폐기일', value: (r) => datePart(r.disposal_date, r.created_at) },
      { header: '등록 시각', value: (r) => timePart(r.created_at) },
      { header: '상품', value: (r) => r.product_name },
      { header: '수량', type: 'number', value: (r) => r.quantity },
      { header: '사유', value: (r) => r.reason || '' },
    ],
  },
  /** 일별 매입·매출: 화면 아래 "상품·거래처별 내역" 표 + 일자 열. 원가를 모르는 행은 원가·이익·이익률을 빈칸 */
  dailyTrade: {
    name: '일별매입매출',
    columns: [
      { header: '일자', value: (r) => r.__date || '' },
      { header: '상품', value: (r) => r.product_name || '' },
      { header: '거래처', value: (r) => r.partner_name || '' },
      { header: '구분', value: (r) => (r.line_kind === 'purchase' ? '매입' : '매출') },
      { header: '건수', type: 'number', value: (r) => r.line_count },
      { header: '수량', type: 'number', value: (r) => r.qty_sum },
      { header: '금액', type: 'number', value: (r) => r.amount_sum },
      { header: '미수', type: 'number', value: (r) => (r.line_kind === 'purchase' ? '' : Number(r.receivable_sum) || 0) },
      { header: '원가', type: 'number', value: (r) => (dailyCostKnown(r) ? r.cost_sum : '') },
      { header: '이익', type: 'number', value: (r) => (dailyCostKnown(r) ? Number(r.profit_sum) || 0 : '') },
      { header: '이익률(%)', type: 'number', value: (r) => dailyMarginPct(r) },
      { header: '원가 미확인 건수', type: 'number', value: (r) => (r.line_kind === 'purchase' ? '' : Number(r.cost_missing_count) || 0) },
    ],
  },
};

/** 매출 행 중 원가를 하나라도 아는가(화면: 전부 미확인이면 '원가 미확인', 일부면 미확인 제외 원가 표시) */
function dailyCostKnown(r) {
  if (r.line_kind === 'purchase') return false;
  const lineCount = Number(r.line_count) || 0;
  const missing = Number(r.cost_missing_count) || 0;
  return !(missing > 0 && missing >= lineCount);
}

/** 화면과 같게: 원가 미확인이 섞인 행은 이익률을 계산하지 않는다. 소수 1자리 */
function dailyMarginPct(r) {
  if (r.line_kind === 'purchase' || (Number(r.cost_missing_count) || 0) > 0) return '';
  const amt = Number(r.amount_sum) || 0;
  if (!(amt > 0)) return '';
  return Math.round(((Number(r.profit_sum) || 0) / amt) * 1000) / 10;
}

/** 목록 키(inventory·purchases·sales·payments·disposals·dailyTrade)와 화면 rows로 CSV 저장 */
export function downloadListCsv(key, rows, { date } = {}) {
  const def = LISTS[key];
  if (!def) throw new Error(`알 수 없는 목록: ${key}`);
  downloadCsv(csvFileName(def.name, date || todayYmd()), def.columns, rows);
}

export const CSV_LIST_DEFS = LISTS;
