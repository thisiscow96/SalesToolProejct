// 환불(반품) 계산 — 화면(Main.jsx)과 시험 스크립트(scripts/refund-calc-test.mjs)가 같이 쓴다.

/** 환불 가능 수량 = 총 수량 − 환불된 수량(환불 누적) */
export function computeRefundPossibleQty(s) {
  const q = Number(s.quantity);
  const rf = Number(s.refunded_qty || 0);
  if (!Number.isFinite(q)) return 0;
  return Math.max(0, q - rf);
}

/**
 * 반품(환불) 금액 = (환불 요청수량 ÷ 환불 가능 수량) × 현재 수금액 (T-106)
 * 환불할 때마다 수금액(paid_amount)에서 환불금이 빠지므로, 분모도 "아직 환불되지 않은 수량"이어야 한다.
 * 예전 식(분모 = 총 수량)은 두 번째 부분 환불부터 금액이 적게 나왔다.
 *   예) 10개·1,000원 수금 → 5개 환불 500원(남은 수금 500) → 남은 5개 환불: 예전 (5÷10)×500 = 250원, 지금 (5÷5)×500 = 500원
 * 남은 수량을 전부 환불하면 남은 수금액 전부가 돌아간다.
 */
export function computeAutoRefundAmount(s, requestQty) {
  const remaining = computeRefundPossibleQty(s);
  const paid = Number(s.paid_amount);
  const rq = Number(requestQty);
  if (!(remaining > 0) || !Number.isFinite(rq) || rq <= 0 || !Number.isFinite(paid) || paid <= 0) return 0;
  const ratio = Math.min(1, rq / remaining);
  return Math.round(ratio * paid * 100) / 100;
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
