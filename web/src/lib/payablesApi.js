// 매입처 지급(미지급금) API (T-201) — api.js 와 같은 토큰·401 처리를 쓰되, 병행 작업(T-216)과 api.js 충돌을 줄이려고 파일을 나눴다.
// 오류는 서버의 code·field·detail 을 같이 넘긴다(화면이 OVERPAY 의 max_amount 등을 보여 줌).
import { API_BASE, getToken } from '../api';

export class PayableError extends Error {
  constructor(status, body) {
    super(body?.message || '처리에 실패했습니다.');
    this.status = status;
    this.code = body?.code || null;
    this.field = body?.field || null;
    this.body = body || {};
    this.detail = body?.detail || null;
  }
}

async function req(method, path, body) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    try { window.sessionStorage.removeItem('user'); } catch { /* 무시 */ }
    window.location.href = '/login';
  }
  let data = {};
  try { data = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) throw new PayableError(res.status, data);
  return data.data;
}

const qs = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  return q ? `?${q}` : '';
};

/** 지급 등록 — body: partner_id, amount, paid_at, method, memo, allocations?[{purchase_id, amount}] / 기초 정리 kind:'opening', through_date */
export const createSupplierPayment = (body) => req('POST', '/supplier-payments', body);
/** 지급 목록 — params: from_date, to_date, partner_id, include_cancelled(1) */
export const fetchSupplierPayments = (params) => req('GET', `/supplier-payments${qs(params)}`);
/** 지급 취소 — body: reason, expected_updated_at? */
export const cancelSupplierPayment = (id, body) => req('POST', `/supplier-payments/${encodeURIComponent(id)}/cancel`, body);
/** 지급 원장 — params: from, to, include_cancelled */
export const fetchPayableLedger = (partnerId, params) => req('GET', `/partners/${encodeURIComponent(partnerId)}/payable-ledger${qs(params)}`);
/** 미지급 연령 — params: partner_id(주면 매입별 상세 purchases) */
export const fetchPayablesAging = (params) => req('GET', `/payables/aging${qs(params)}`);
/** 매입처의 미지급 매입(오래된 순) — 지급 등록 모달용 */
export const fetchUnpaidPurchases = (partnerId) => req('GET', `/purchases${qs({ unpaid_only: 1, payee_id: partnerId })}`); // T-401 PR-05 지급 대상 기준

export const PAY_METHOD_OPTIONS = [
  { value: 'transfer', label: '계좌이체' },
  { value: 'cash', label: '현금' },
  { value: 'bill', label: '어음' },
  { value: 'other', label: '기타' },
];
export const PAY_METHOD_LABEL = Object.fromEntries(PAY_METHOD_OPTIONS.map((o) => [o.value, o.label]));
export const PAYMENT_STATUS_LABEL = { unpaid: '미지급', partial: '일부', paid: '완료' };
