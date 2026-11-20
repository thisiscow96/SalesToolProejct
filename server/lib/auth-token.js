/**
 * 로그인 토큰 (T-101) — JWT 형식(HS256), 외부 의존성 없이 node crypto로 서명·검증한다.
 * - 비밀: AUTH_SECRET 환경 변수. 운영(NODE_ENV=production)에서 없으면 서버 시작을 거부하고,
 *   개발에서는 경고 후 프로세스마다 새 임시 비밀을 쓴다(서버를 다시 켜면 기존 토큰은 무효).
 * - 만료: AUTH_TOKEN_TTL_HOURS (기본 12시간)
 * - 토큰에는 사용자 ID(sub)·중매인 번호만 담는다. 관리자 여부·활성 상태는 요청마다 DB에서 다시 확인한다.
 */
const crypto = require('crypto');

const MIN_SECRET_LENGTH = 32;

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** AUTH_SECRET 확인 — 운영에서 없거나 짧으면 throw (서버가 시작하지 않게) */
function resolveAuthSecret(env = process.env) {
  const secret = env.AUTH_SECRET ? String(env.AUTH_SECRET) : '';
  const isProd = env.NODE_ENV === 'production';
  if (secret && secret.length >= MIN_SECRET_LENGTH) return { secret, temporary: false };
  if (isProd) {
    throw new Error(
      secret
        ? `AUTH_SECRET 이 너무 짧습니다(${MIN_SECRET_LENGTH}자 이상 필요). 운영 서버를 시작하지 않습니다.`
        : 'AUTH_SECRET 이 설정되지 않았습니다. 운영(NODE_ENV=production) 서버를 시작하지 않습니다.'
    );
  }
  console.warn(
    `[auth] 경고: AUTH_SECRET 이 ${secret ? '너무 짧아' : '없어'} 임시 비밀을 씁니다(개발 전용). 서버를 다시 켜면 로그인이 풀립니다.`
  );
  return { secret: crypto.randomBytes(48).toString('hex'), temporary: true };
}

function ttlSeconds(env = process.env) {
  const h = Number(env.AUTH_TOKEN_TTL_HOURS);
  return Math.round((Number.isFinite(h) && h > 0 ? h : 12) * 3600);
}

function hmac(secret, data) {
  return b64url(crypto.createHmac('sha256', secret).update(data).digest());
}

/** 토큰 발급 */
function signToken(secret, { userId, agentNo }, ttlSec, nowSec = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub: String(userId), agent_no: String(agentNo), iat: nowSec, exp: nowSec + ttlSec }));
  const data = `${header}.${payload}`;
  return `${data}.${hmac(secret, data)}`;
}

/**
 * 토큰 검증 — 성공 시 { ok:true, payload }, 실패 시 { ok:false, reason: 'missing'|'malformed'|'signature'|'expired' }
 * 서명은 길이가 같은 버퍼로 timingSafeEqual 비교, alg 는 HS256 만 받는다(alg=none 우회 차단).
 */
function verifyToken(secret, token, nowSec = Math.floor(Date.now() / 1000)) {
  if (!token) return { ok: false, reason: 'missing' };
  const parts = String(token).split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(b64urlDecode(h));
    payload = JSON.parse(b64urlDecode(p));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!header || header.alg !== 'HS256') return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(hmac(secret, `${h}.${p}`));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'signature' };
  }
  if (!payload || typeof payload.exp !== 'number' || payload.exp <= nowSec) return { ok: false, reason: 'expired' };
  if (!payload.sub) return { ok: false, reason: 'malformed' };
  return { ok: true, payload };
}

/** Authorization: Bearer <토큰> 에서 토큰만 꺼낸다 */
function bearerFrom(req) {
  const v = req.headers?.authorization;
  if (!v || typeof v !== 'string') return null;
  const m = v.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

module.exports = { resolveAuthSecret, ttlSeconds, signToken, verifyToken, bearerFrom, MIN_SECRET_LENGTH };
