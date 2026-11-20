// 환불 요청수량 검증 시험 (T-107) — 실행: web 폴더에서 node scripts/refund-qty-test.mjs
import assert from 'node:assert';
import { validateRefundQty, defaultRefundQty } from '../src/lib/refund.js';

// 수정 전 규칙(문자열 최소 3자리) — 재현 비교용
const oldRule = (v) => (String(v ?? '').trim().length < 3 ? '최소 3자리' : null);

const results = [];
const check = (name, fn) => {
  try { fn(); results.push(true); console.log(`○ ${name}`); } catch (e) { results.push(false); console.log(`× ${name} — ${e.message}`); }
};

const sale10 = { quantity: '10.000', refunded_qty: '0' };
const sale5 = { quantity: '10.000', refunded_qty: '5.000' };
const saleFrac = { quantity: '3.3', refunded_qty: '1.1' };

check('재현: 수정 전 규칙은 기본값 "10"·"5"·"1"을 거절', () => {
  assert.ok(oldRule(defaultRefundQty(sale10)));
  assert.ok(oldRule(defaultRefundQty(sale5)));
  assert.ok(oldRule('1'));
});
check('기본값 = 환불 가능 수량 ("10", "5")', () => {
  assert.strictEqual(defaultRefundQty(sale10), '10');
  assert.strictEqual(defaultRefundQty(sale5), '5');
});
check('기본값에 부동소수 오차 없음 (3.3 − 1.1 = "2.2")', () => assert.strictEqual(defaultRefundQty(saleFrac), '2.2'));
check('기본값 그대로 저장 가능', () => {
  assert.strictEqual(validateRefundQty(defaultRefundQty(sale10), 10), null);
  assert.strictEqual(validateRefundQty(defaultRefundQty(sale5), 5), null);
  assert.strictEqual(validateRefundQty(defaultRefundQty(saleFrac), 2.2), null);
});
check('한 자리·소수 입력 허용 (1, 0.5, 2.125, 1,000)', () => {
  for (const v of ['1', '0.5', '.5', '2.125']) assert.strictEqual(validateRefundQty(v, 10), null, v);
  assert.strictEqual(validateRefundQty('1,000', 1000), null);
});
check('0·음수·빈 값·문자 거절', () => {
  for (const v of ['0', '0.000', '-1', '', '  ', 'abc', '1e3', '1.2.3']) assert.ok(validateRefundQty(v, 10), JSON.stringify(v));
});
check('소수 넷째 자리 거절 (0.0001)', () => assert.match(validateRefundQty('0.0001', 10), /소수 3자리/));
check('환불 가능 수량 초과 거절 (5.001 > 5), 표시용 숫자 사용', () => assert.match(validateRefundQty('5.001', 5, '5'), /초과/));
check('최대값이 숫자가 아니면 거절(안전)', () => assert.ok(validateRefundQty('1', '1,000')));

const bad = results.filter((x) => !x).length;
console.log(`\n통과 ${results.length - bad} / ${results.length}`);
process.exit(bad ? 1 : 0);
