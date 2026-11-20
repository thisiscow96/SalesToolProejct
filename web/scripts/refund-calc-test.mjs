// 환불 계산 시험 (T-106) — 실행: web 폴더에서 node scripts/refund-calc-test.mjs
import assert from 'node:assert';
import { computeAutoRefundAmount, computeRefundPossibleQty } from '../src/lib/refund.js';

// 수정 전 식(분모 = 총 수량) — 재현 비교용
const oldCalc = (s, rq) => Math.round((rq / Number(s.quantity)) * Number(s.paid_amount) * 100) / 100;

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(true); console.log(`○ ${name}`); } catch (e) { results.push(false); console.log(`× ${name} — ${e.message}`); }
};

// 10개·1,000원 수금 매출
const first = { quantity: 10, refunded_qty: 0, paid_amount: 1000 };
const second = { quantity: 10, refunded_qty: 5, paid_amount: 500 }; // 5개 500원 환불 후
const third = { quantity: 10, refunded_qty: 7, paid_amount: 300 };

check('재현: 수정 전 식으로 두 번째 5개 환불 = 250원(적게 나옴)', () => assert.strictEqual(oldCalc(second, 5), 250));
check('첫 번째 부분 환불 5개 = 500원', () => assert.strictEqual(computeAutoRefundAmount(first, 5), 500));
check('두 번째 부분 환불 5개 = 500원 (단가 100 × 5)', () => assert.strictEqual(computeAutoRefundAmount(second, 5), 500));
check('세 번 나눠도 합계 = 수금액 (5→2→3)', () => {
  const a = computeAutoRefundAmount(first, 5);
  const b = computeAutoRefundAmount({ quantity: 10, refunded_qty: 5, paid_amount: 1000 - a }, 2);
  const c = computeAutoRefundAmount({ quantity: 10, refunded_qty: 7, paid_amount: 1000 - a - b }, 3);
  assert.deepStrictEqual([a, b, c], [500, 200, 300]);
});
check('남은 수량 전부 환불 = 남은 수금 전부', () => assert.strictEqual(computeAutoRefundAmount(third, 3), 300));
check('소수 수량 0.5 / 남은 3 × 300 = 50', () => assert.strictEqual(computeAutoRefundAmount(third, 0.5), 50));
check('요청 0·음수·수금 0 → 0', () => {
  assert.strictEqual(computeAutoRefundAmount(first, 0), 0);
  assert.strictEqual(computeAutoRefundAmount(first, -1), 0);
  assert.strictEqual(computeAutoRefundAmount({ ...first, paid_amount: 0 }, 5), 0);
});
check('남은 수량 초과 요청은 남은 수금까지만', () => assert.strictEqual(computeAutoRefundAmount(second, 9), 500));
check('환불 가능 수량 = 총 − 환불', () => assert.strictEqual(computeRefundPossibleQty(third), 3));

const bad = results.filter((x) => !x).length;
console.log(`\n통과 ${results.length - bad} / ${results.length}`);
process.exit(bad ? 1 : 0);
