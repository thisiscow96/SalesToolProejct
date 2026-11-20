// 환불 계산 시험 (T-106 → T-111 반품 규칙 B) — 실행: web 폴더에서 node scripts/refund-calc-test.mjs
import assert from 'node:assert';
import { computeAutoRefundAmount, computeRefundPossibleQty, computeReturnPreview, computeUnpaidAmount } from '../src/lib/refund.js';

// T-106 수정 전 식(분모 = 총 수량) — 재현 비교용
const oldCalc = (s, rq) => Math.round((rq / Number(s.quantity)) * Number(s.paid_amount) * 100) / 100;

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(true); console.log(`○ ${name}`); } catch (e) { results.push(false); console.log(`× ${name} — ${e.message}`); }
};

// 10개·1,000원 완납 매출 (반품 규칙 B: 반품하면 returned_amount 가 늘고, 넘친 돈만큼 paid_amount 가 준다)
const first = { quantity: 10, total_amount: 1000, returned_amount: 0, refunded_qty: 0, paid_amount: 1000 };
const second = { quantity: 10, total_amount: 1000, returned_amount: 500, refunded_qty: 5, paid_amount: 500 }; // 5개 반품(500 환불) 후
const third = { quantity: 10, total_amount: 1000, returned_amount: 700, refunded_qty: 7, paid_amount: 300 };

check('재현(T-106): 수정 전 식으로 두 번째 5개 환불 = 250원(적게 나옴)', () => assert.strictEqual(oldCalc(second, 5), 250));
check('U2 첫 번째 부분 반품 5개 = 환불 500원', () => assert.strictEqual(computeAutoRefundAmount(first, 5), 500));
check('U2 두 번째 부분 반품 5개 = 환불 500원', () => assert.strictEqual(computeAutoRefundAmount(second, 5), 500));
check('세 번 나눠도 환불 합계 = 수금액 (5→2→3)', () => {
  const a = computeAutoRefundAmount(first, 5);
  const b = computeAutoRefundAmount({ ...first, returned_amount: 500, refunded_qty: 5, paid_amount: 1000 - a }, 2);
  const c = computeAutoRefundAmount({ ...first, returned_amount: 700, refunded_qty: 7, paid_amount: 1000 - a - b }, 3);
  assert.deepStrictEqual([a, b, c], [500, 200, 300]);
});
check('남은 수량 전부 반품 = 남은 수금 전부 환불', () => assert.strictEqual(computeAutoRefundAmount(third, 3), 300));
check('소수 수량 0.5 / 남은 3, 남은 매출액 300 → 반품 50', () => assert.strictEqual(computeReturnPreview(third, 0.5).returnAmount, 50));
check('요청 0·음수 → 0', () => {
  assert.strictEqual(computeAutoRefundAmount(first, 0), 0);
  assert.strictEqual(computeAutoRefundAmount(first, -1), 0);
});
check('남은 수량 초과 요청은 남은 매출액까지만', () => assert.strictEqual(computeReturnPreview(second, 9).returnAmount, 500));
check('환불 가능 수량 = 총 − 환불', () => assert.strictEqual(computeRefundPossibleQty(third), 3));
// 반품 규칙 B 핵심 3경우 (설계 10.2 표)
check('R1 완납 1,000 / 10개 중 5개 → 반품 500 · 미수 차감 0 · 환불 500, 반품 후 미수 0', () => {
  assert.deepStrictEqual(computeReturnPreview(first, 5), { returnAmount: 500, creditAmount: 0, refundAmount: 500 });
  assert.strictEqual(computeUnpaidAmount(second), 0);
});
check('R2·U3 외상 500 / 5개 전부 → 반품 500 · 미수 차감 500 · 환불 0', () => {
  const s = { quantity: 5, total_amount: 500, returned_amount: 0, refunded_qty: 0, paid_amount: 0 };
  assert.deepStrictEqual(computeReturnPreview(s, 5), { returnAmount: 500, creditAmount: 500, refundAmount: 0 });
});
check('일부 수금 1,000 중 300 / 10개 중 5개 → 반품 500 · 미수 차감 500 · 환불 0, 반품 후 미수 200', () => {
  const s = { quantity: 10, total_amount: 1000, returned_amount: 0, refunded_qty: 0, paid_amount: 300 };
  assert.deepStrictEqual(computeReturnPreview(s, 5), { returnAmount: 500, creditAmount: 500, refundAmount: 0 });
  assert.strictEqual(computeUnpaidAmount({ ...s, returned_amount: 500, refunded_qty: 5 }), 200);
});
check('일부 수금 1,000 중 800 / 10개 중 5개 → 미수 200 먼저 차감, 넘친 300만 환불', () => {
  const s = { quantity: 10, total_amount: 1000, returned_amount: 0, refunded_qty: 0, paid_amount: 800 };
  assert.deepStrictEqual(computeReturnPreview(s, 5), { returnAmount: 500, creditAmount: 200, refundAmount: 300 });
});
check('서버가 준 unpaid_amount 우선', () => assert.strictEqual(computeUnpaidAmount({ unpaid_amount: '123.45', total_amount: 1000, paid_amount: 0 }), 123.45));

const bad = results.filter((x) => !x).length;
console.log(`\n통과 ${results.length - bad} / ${results.length}`);
process.exit(bad ? 1 : 0);
