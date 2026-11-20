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
