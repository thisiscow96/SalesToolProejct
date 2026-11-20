// 환불(반품) 계산 — 화면(Main.jsx)과 시험 스크립트(scripts/refund-calc-test.mjs, 서버 시나리오 S-024)가 같이 쓴다.
// 반품 규칙 B (T-108 사용자 결정, T-111): "반품 = 미수 먼저 차감, 넘친 돈만 환불" — 서버 POST /api/sales/:id/refund 와 같은 식.
//   순매출 N = 총액 − 누적 반품액,  미수 = N − 수금액
//   반품 금액 V = N × (반품 수량 ÷ 반품 가능 수량)  (남은 수량 전부면 N 전부)
//   미수 차감 = MIN(V, 미수),  환불금(현금) = V − 미수 차감

/** 환불 가능 수량 = 총 수량 − 환불된 수량(환불 누적) */
export function computeRefundPossibleQty(s) {
  const q = Number(s.quantity);
  const rf = Number(s.refunded_qty || 0);
  if (!Number.isFinite(q)) return 0;
  return Math.max(0, q - rf);
}

const cents = (v) => Math.round((Number(v) || 0) * 100);

/** 순매출(원) = 총액 − 누적 반품액 */
export function computeNetAmount(s) {
  return Math.max(0, cents(s.total_amount) - cents(s.returned_amount)) / 100;
}

/** 미수(원) = 총액 − 반품액 − 수금액 − 할인 − 상계 (0 미만은 0). 서버가 준 unpaid_amount 가 있으면 그 값 */
export function computeUnpaidAmount(s) {
  if (s.unpaid_amount != null && s.unpaid_amount !== '') return Math.max(0, Number(s.unpaid_amount) || 0);
  // T-401: 할인·상계도 미수를 줄인다
  return Math.max(0, cents(s.total_amount) - cents(s.returned_amount) - cents(s.paid_amount) - cents(s.discount_amount) - cents(s.offset_amount)) / 100;
}

/**
 * 반품 미리보기 — { returnAmount: 반품 금액 V, creditAmount: 미수에서 빼는 금액, discountReversal: 되돌리는 할인, refundAmount: 현금으로 돌려줄 금액,
 *                  blockedByOffset: 상계로 정리된 금액까지 닿으면 true(서버 409 SALE_OFFSET_SETTLED) }
 * T-401 3.4: 미수 차감 → 할인 되돌림 → 현금 환불 순서 (서버 POST /api/sales/:id/refund 와 같은 식)
 * 예) 1,000원 완납 10개 중 5개 → V 500, 미수 차감 0, 환불 500 (가짜 미수 없음 — R1)
 *     500원 외상 5개 전부 → V 500, 미수 차감 500, 환불 0 (받은 적 없는 돈은 돌려주지 않음 — R2)
 *     1,000원 중 300원 수금 10개 중 5개 → V 500, 미수 차감 500, 환불 0, 남은 미수 200
 */
export function computeReturnPreview(s, requestQty) {
  const zero = { returnAmount: 0, creditAmount: 0, discountReversal: 0, refundAmount: 0, blockedByOffset: false };
  const remaining = computeRefundPossibleQty(s);
  const rq = Number(requestQty);
  if (!(remaining > 0) || !Number.isFinite(rq) || rq <= 0) return zero;
  const netC = Math.max(0, cents(s.total_amount) - cents(s.returned_amount));
  const paidC = cents(s.paid_amount);
  const vC = rq >= remaining - 1e-9 ? netC : Math.round((netC * rq) / remaining);
  const discC = cents(s.discount_amount);
  const offC = cents(s.offset_amount);
  const dueC = Math.max(0, netC - paidC - discC - offC);
  const creditC = Math.min(vC, dueC);
  const drevC = Math.min(vC - creditC, discC);
  const excessC = Math.max(0, paidC - netC); // 010 이전 데이터의 받은 돈 > 순매출 — 서버와 같이 함께 환불
  const cashC = vC - creditC - drevC + excessC;
  return {
    returnAmount: vC / 100,
    creditAmount: creditC / 100,
    discountReversal: drevC / 100,
    refundAmount: cashC / 100,
    blockedByOffset: cashC > paidC,
  };
}

/**
 * 환불금(현금으로 돌려줄 돈) — 반품 규칙 B. 예전(T-106) 이름을 그대로 둔다.
 * 10개·1,000원 완납 → 5개 반품 500원 → 남은 5개 반품 500원 (두 번째도 적게 나오지 않음 — U2)
 */
export function computeAutoRefundAmount(s, requestQty) {
  return computeReturnPreview(s, requestQty).refundAmount;
}

/** 수량은 DB에 소수 셋째 자리까지(NUMERIC(12,3)) 저장된다 */
export const REFUND_QTY_MAX_DECIMALS = 3;

/** 환불 요청수량 기본값 = 환불 가능 수량 (부동소수 오차 없이 소수 셋째 자리까지) */
export function defaultRefundQty(s) {
  const maxQ = computeRefundPossibleQty(s);
  return maxQ > 0 ? String(Math.round(maxQ * 1000) / 1000) : '';
}

/**
 * 환불 요청수량 검증 (T-107) — 형식(글자 수)이 아니라 범위로 본다: 0 < 수량 ≤ 환불 가능 수량, 소수 셋째 자리까지.
 * 예전 규칙 "문자열 최소 3자리"는 기본값(예: 10, 5)을 그대로 저장하면 거절했다.
 * 반환: 문제가 없으면 null, 있으면 사용자에게 보여 줄 문구(매출 번호는 호출하는 쪽이 붙인다)
 */
export function validateRefundQty(input, maxQ, maxLabel = String(maxQ)) {
  const str = String(input ?? '').trim().replace(/,/g, '');
  if (!str) return '환불 요청수량을 입력하세요.';
  if (!/^\d*\.?\d+$|^\d+\.$/.test(str)) return '환불 요청수량은 숫자로 입력하세요. (예: 10, 0.5, 2.125)';
  const qty = Number(str);
  if (!Number.isFinite(qty) || qty <= 0) return '환불 요청수량은 0보다 커야 합니다.';
  const dec = str.includes('.') ? str.split('.')[1].length : 0;
  if (dec > REFUND_QTY_MAX_DECIMALS) return `환불 요청수량은 소수 ${REFUND_QTY_MAX_DECIMALS}자리까지 입력할 수 있습니다.`;
  if (!Number.isFinite(Number(maxQ)) || qty > Number(maxQ) + 1e-9) return `환불 요청수량이 환불 가능 수량(${maxLabel})을 초과합니다.`;
  return null;
}
