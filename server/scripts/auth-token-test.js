/**
 * 로그인 토큰 단위 시험 (T-101) — DB·서버 없이 실행: node scripts/auth-token-test.js
 * 발급·검증, 만료, 서명 위조, 내용 변조, alg=none, 다른 비밀, 운영에서 AUTH_SECRET 없을 때 시작 거부를 확인한다.
 */
const assert = require('assert');
const crypto = require('crypto');
const t = require('../lib/auth-token');

const SECRET = crypto.randomBytes(32).toString('hex');
const NOW = 1_800_000_000;
const cases = [];
function check(name, fn) {
  try {
    fn();
    cases.push([name, true]);
    console.log(`○ ${name}`);
  } catch (e) {
    cases.push([name, false]);
    console.log(`× ${name} — ${e.message}`);
  }
}

const tok = t.signToken(SECRET, { userId: 7, agentNo: 'A007' }, 3600, NOW);

check('정상 토큰 검증 성공, sub·agent_no 포함', () => {
  const v = t.verifyToken(SECRET, tok, NOW + 10);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.payload.sub, '7');
  assert.strictEqual(v.payload.agent_no, 'A007');
  assert.strictEqual(v.payload.exp, NOW + 3600);
});
check('만료 시각이 지나면 expired', () => {
  assert.deepStrictEqual(t.verifyToken(SECRET, tok, NOW + 3600), { ok: false, reason: 'expired' });
});
check('서명 위조 → signature', () => {
  const [h, p] = tok.split('.');
  assert.strictEqual(t.verifyToken(SECRET, `${h}.${p}.${'A'.repeat(43)}`, NOW).reason, 'signature');
});
check('내용 변조(sub 7→8) → signature', () => {
  const [h, p, s] = tok.split('.');
  const pl = JSON.parse(Buffer.from(p, 'base64url').toString());
  pl.sub = '8';
  const p2 = Buffer.from(JSON.stringify(pl)).toString('base64url');
  assert.strictEqual(t.verifyToken(SECRET, `${h}.${p2}.${s}`, NOW).reason, 'signature');
});
check('alg=none 토큰 거절', () => {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = tok.split('.')[1];
  assert.strictEqual(t.verifyToken(SECRET, `${h}.${p}.`, NOW).ok, false);
});
check('다른 비밀로 서명한 토큰 거절', () => {
  const other = t.signToken('x'.repeat(40), { userId: 7, agentNo: 'A007' }, 3600, NOW);
  assert.strictEqual(t.verifyToken(SECRET, other, NOW).reason, 'signature');
});
check('빈 값·형식 오류 거절', () => {
  assert.strictEqual(t.verifyToken(SECRET, null, NOW).reason, 'missing');
  assert.strictEqual(t.verifyToken(SECRET, 'abc', NOW).reason, 'malformed');
  assert.strictEqual(t.verifyToken(SECRET, 'a.b.c', NOW).reason, 'malformed');
});
check('Bearer 헤더 파싱', () => {
  assert.strictEqual(t.bearerFrom({ headers: { authorization: 'Bearer abc.def.ghi' } }), 'abc.def.ghi');
  assert.strictEqual(t.bearerFrom({ headers: { 'x-agent-no': 'admin001' } }), null);
});
check('운영에서 AUTH_SECRET 없으면 throw(서버 시작 거부)', () => {
  assert.throws(() => t.resolveAuthSecret({ NODE_ENV: 'production' }), /AUTH_SECRET/);
  assert.throws(() => t.resolveAuthSecret({ NODE_ENV: 'production', AUTH_SECRET: 'short' }), /짧/);
});
check('개발에서 AUTH_SECRET 없으면 임시 비밀(경고)', () => {
  const r = t.resolveAuthSecret({ NODE_ENV: 'development' });
  assert.strictEqual(r.temporary, true);
  assert.ok(r.secret.length >= t.MIN_SECRET_LENGTH);
});
check('만료 시간 기본 12시간, AUTH_TOKEN_TTL_HOURS 반영', () => {
  assert.strictEqual(t.ttlSeconds({}), 12 * 3600);
  assert.strictEqual(t.ttlSeconds({ AUTH_TOKEN_TTL_HOURS: '2' }), 7200);
});

const failed = cases.filter((c) => !c[1]).length;
console.log(`\n통과 ${cases.length - failed} / ${cases.length}`);
process.exit(failed ? 1 : 0);
