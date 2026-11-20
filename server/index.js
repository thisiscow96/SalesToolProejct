const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const crypto = require('crypto');
const { getPgConfig } = require('./lib/db-config');
const { sendMail, configuredProviders } = require('./lib/mailer');
const authToken = require('./lib/auth-token');
const { parseListOptions, searchClause, runList } = require('./lib/list-query'); // T-211 목록 검색·페이지
const { recordAudit, registerAuditRoutes } = require('./lib/audit-log'); // T-212 변경 이력
const { Pool } = require('pg');

// ---------- 입력값 검증 ----------
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidEmail(email) {
  return typeof email === 'string' && EMAIL_REGEX.test(email.trim());
}
// 휴대폰: 010/011/016 등으로 시작, 숫자 10~11자리 (하이픈 허용)
const PHONE_REGEX = /^01[0-9]-?[0-9]{3,4}-?[0-9]{4}$/;
function isValidPhone(phone) {
  const s = String(phone).trim().replace(/\s/g, '');
  return /^01[0-9][0-9]{7,8}$/.test(s) || PHONE_REGEX.test(s);
}
function normalizePhone(phone) {
  return String(phone).trim().replace(/[-\s]/g, '');
}

// 로그인 토큰 서명 비밀 (T-101) — 운영에서 AUTH_SECRET 이 없으면 여기서 throw 되어 서버가 시작하지 않는다
let AUTH;
try {
  AUTH = authToken.resolveAuthSecret();
} catch (err) {
  console.error('[auth] ' + err.message);
  process.exit(1);
}
const AUTH_TTL_SEC = authToken.ttlSeconds();

const app = express();
const port = process.env.PORT || 3000;

// CORS: 로컬 개발 + ALLOWED_ORIGINS(쉼표 구분, 예: https://salestool.pages.dev) — 프론트가 API를 직접 부를 때
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:') || ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// PostgreSQL 연결 설정 — lib/db-config.js (Neon·Supabase 등 무료 Postgres의 SSL·연결 대기 처리 포함)
// DATE 열은 lib/db-config.js의 전역 파서로 'YYYY-MM-DD' 문자열로 받는다 — 서버 시간대와 상관없이 DB 저장값 그대로 (T-116)
const pool = new Pool(getPgConfig({ pool: true }));
pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

// 트랜잭션용 연결 얻기 — 연결 대기 시간 초과(Neon이 깨어나는 중, 풀이 가득 참) 때 처리되지 않은 Promise 거부로
// 서버 프로세스가 죽지 않게 503으로 응답한다 (T-03)
async function connectOr503(res) {
  try {
    return await pool.connect();
  } catch (err) {
    console.error('[DB] connect error:', err.message);
    res.status(503).json({ ok: false, message: 'DB 연결이 잠시 원활하지 않습니다. 잠시 후 다시 시도해 주세요.' });
    return null;
  }
}

// 이메일 발송 — lib/mailer.js (Resend → Brevo → SMTP 순서로 무료 한도를 이어 씀)
async function sendVerificationEmail(email, code) {
  const text = `판매툴 인증\n\n인증번호 : ${code}\n\n5분 안에 입력해 주세요.`;
  const r = await sendMail({ to: email, subject: '판매툴 인증', text });
  return r.sent ? { sent: true, provider: r.provider } : { sent: false, code, error: r.errors.join(' | ') };
}
// 메일을 못 보냈을 때 인증번호를 응답에 실어 주는 것은 개발 환경에서만 (운영에서 켜면 이메일 인증을 우회할 수 있음)
const EXPOSE_DEV_CODE = process.env.EXPOSE_DEV_CODE ? process.env.EXPOSE_DEV_CODE === 'true' : process.env.NODE_ENV !== 'production';

app.use(express.json());

// T-213 권한 미들웨어 — 모든 /api 요청을 라우트 권한 표(lib/access.js)로 먼저 검사한다(직원 기본 거부).
// 본문 조건(credit_confirmed·entry_kind)을 보려면 express.json 다음이어야 한다. multipart(파일 전송)는 본문을 읽기 전에 401/404.
const access = require('./lib/access');
const authorize = access.createAuthorize({ resolveAuth: (req) => getAuthUser(req) });
app.use(authorize);

// Salesforce 파일 전송 테스트 경로 (T-114, D 리뷰 R-02)
// 예전에는 로그인 확인 전에 최대 2GB 를 서버 메모리에 받아, 누구나 큰 파일을 보내 무료 인스턴스를 멈출 수 있었다.
// - 기본은 꺼짐: ENABLE_SF_UPLOAD=true 일 때만 경로를 연다(업무 화면에서 쓰지 않는 테스트 기능)
// - 켜도 로그인 확인을 파일 받기(multer)보다 먼저 하고, 한도는 SF_UPLOAD_MAX_MB(기본 10MB [가정])
const ENABLE_SF_UPLOAD = process.env.ENABLE_SF_UPLOAD === 'true';
const SF_UPLOAD_MAX_MB = (() => {
  const n = Number(process.env.SF_UPLOAD_MAX_MB);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 10;
})();
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.floor(SF_UPLOAD_MAX_MB * 1024 * 1024), files: 1 },
});

async function uploadContentVersionToSalesforce({
  fileName,
  fileSize,
  fileBuffer,
  mimeType,
  titleRaw,
  firstPublishLocationId,
}) {
  const apiVersion = String(process.env.SF_API_VERSION || 'v60.0').trim();
  const auth = await getSalesforceAccessToken();
  const title = String(titleRaw || '').trim() || fileName.replace(/\.[^.]+$/, '').slice(0, 255) || 'upload';
  const pathOnClient = fileName.slice(0, 500) || 'upload.bin';

  const entity = {
    Title: title,
    PathOnClient: pathOnClient,
  };
  if (firstPublishLocationId) entity.FirstPublishLocationId = firstPublishLocationId;

  const boundary = `sf-boundary-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const jsonPart =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="entity_content"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(entity)}\r\n`;
  const fileHead =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="VersionData"; filename="${fileName.replace(/"/g, '')}"\r\n` +
    `Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`;
  const endPart = `\r\n--${boundary}--\r\n`;
  const multipartBody = Buffer.concat([
    Buffer.from(jsonPart, 'utf8'),
    Buffer.from(fileHead, 'utf8'),
    fileBuffer,
    Buffer.from(endPart, 'utf8'),
  ]);

  const uploadUrl = `${auth.instanceUrl}/services/data/${apiVersion}/sobjects/ContentVersion`;
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body: multipartBody,
  });
  const upJson = await up.json().catch(() => ({}));
  if (!up.ok || !upJson.id) {
    const errMsg = upJson?.[0]?.message || upJson?.message || 'Salesforce ContentVersion 업로드 실패';
    const e = new Error(errMsg);
    e.statusCode = 502;
    e.detail = upJson;
    throw e;
  }

  const cvId = upJson.id;
  let contentDocumentId = null;
  try {
    const q = encodeURIComponent(`SELECT ContentDocumentId FROM ContentVersion WHERE Id = '${cvId}'`);
    const qUrl = `${auth.instanceUrl}/services/data/${apiVersion}/query?q=${q}`;
    const qr = await fetch(qUrl, { headers: { Authorization: `Bearer ${auth.accessToken}` } });
    const qj = await qr.json().catch(() => ({}));
    contentDocumentId = qj?.records?.[0]?.ContentDocumentId || null;
  } catch (_) {
    // 조회 실패는 업로드 실패가 아니므로 무시
  }

  return {
    content_version_id: cvId,
    content_document_id: contentDocumentId,
    file_name: fileName,
    file_size: fileSize,
    salesforce_instance_url: auth.instanceUrl,
  };
}

function getSalesforceAuthConfig() {
  return {
    tokenUrl: (process.env.SF_TOKEN_URL || '').trim(),
    clientId: (process.env.SF_CLIENT_ID || '').trim(),
    clientSecret: (process.env.SF_CLIENT_SECRET || '').trim(),
    username: (process.env.SF_USERNAME || '').trim(),
    password: (process.env.SF_PASSWORD || '').trim(),
    securityToken: (process.env.SF_SECURITY_TOKEN || '').trim(),
    accessToken: (process.env.SF_ACCESS_TOKEN || '').trim(),
    instanceUrl: (process.env.SF_INSTANCE_URL || '').trim(),
  };
}

async function getSalesforceAccessToken() {
  const cfg = getSalesforceAuthConfig();
  if (cfg.accessToken && cfg.instanceUrl) {
    return {
      accessToken: cfg.accessToken,
      instanceUrl: cfg.instanceUrl,
      source: 'env-token',
    };
  }

  if (!cfg.tokenUrl || !cfg.clientId || !cfg.clientSecret || !cfg.username || !cfg.password) {
    const e = new Error(
      'Salesforce 인증정보가 부족합니다. SF_TOKEN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET, SF_USERNAME, SF_PASSWORD(필요 시 SF_SECURITY_TOKEN)를 설정하세요.'
    );
    e.statusCode = 500;
    throw e;
  }

  const body = new URLSearchParams();
  body.set('grant_type', 'password');
  body.set('client_id', cfg.clientId);
  body.set('client_secret', cfg.clientSecret);
  body.set('username', cfg.username);
  body.set('password', `${cfg.password}${cfg.securityToken || ''}`);

  const r = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token || !data.instance_url) {
    const msg = data.error_description || data.error || 'Salesforce OAuth 토큰 발급 실패';
    const e = new Error(msg);
    e.statusCode = 502;
    throw e;
  }
  return {
    accessToken: data.access_token,
    instanceUrl: data.instance_url,
    source: 'oauth-password',
  };
}

// 로그인 사용자 확인 (T-101) — Authorization: Bearer <토큰> 만 믿는다.
// 예전에는 X-Agent-No 헤더(중매인 번호)만으로 사용자를 정해, 번호만 알면 남의 매입·매출·미수를 볼 수 있었다.
// 토큰 서명·만료를 확인한 뒤, 계정이 지금도 활성인지·관리자인지는 DB에서 다시 읽는다(비활성화 즉시 반영).
// T-213 직원: 토큰 sub = 주인 id(데이터 주인), act = 직원 id. 역할·상태는 요청마다 DB에서 읽는다(역할 변경·정지 즉시 반영).
//   결과 auth = { userId(주인), role: owner|input|view, staffId, staffName, ownerName, agentNo, isAdmin, mustChangePassword }
//   직원은 isAdmin 이 언제나 false(RULE-19). 주인이 비활성이면 직원도 null(RULE-18). cv 가 바뀌었으면(비밀번호 변경) null(RULE-17)
async function getAuthUser(req) {
  const v = authToken.verifyToken(AUTH.secret, authToken.bearerFrom(req));
  if (!v.ok) return null;
  const p = v.payload;
  try {
    if (p.act == null) {
      const r = await pool.query('SELECT id, is_admin, name, agent_no FROM "user" WHERE id = $1 AND status = $2', [p.sub, 'active']);
      const row = r.rows[0];
      return row
        ? { userId: row.id, isAdmin: !!row.is_admin, role: 'owner', staffId: null, staffName: null, ownerName: row.name, agentNo: row.agent_no, mustChangePassword: false }
        : null;
    }
    if (!/^\d{1,9}$/.test(String(p.act))) return null;
    const r = await pool.query(
      `SELECT u.id AS owner_id, u.name AS owner_name, u.agent_no,
              s.id AS staff_id, s.name AS staff_name, s.role, s.status, s.must_change_password,
              (EXTRACT(EPOCH FROM s.credentials_changed_at) * 1000)::bigint::text AS cv
         FROM "user" u
         JOIN staff_account s ON s.id = $2 AND s.owner_user_id = u.id
        WHERE u.id = $1 AND u.status = 'active'`,
      [p.sub, p.act]
    );
    const row = r.rows[0];
    if (!row || row.status !== 'active' || String(p.cv) !== row.cv) return null;
    return {
      userId: row.owner_id,
      isAdmin: false,
      role: row.role,
      staffId: row.staff_id,
      staffName: row.staff_name,
      ownerName: row.owner_name,
      agentNo: row.agent_no,
      mustChangePassword: !!row.must_change_password,
    };
  } catch (err) {
    console.error('getAuthUser error:', err.message);
    return null;
  }
}

// 라우트가 부르는 두 함수는 미들웨어(lib/access.js)가 이미 확인한 req.auth 를 그대로 쓴다(요청당 DB 조회 1회).
// req.auth 가 없는데 직원 토큰이면 거부한다 — 미들웨어를 거치지 않은 길로 직원이 주인 권한을 얻지 못하게(기본 거부)
async function resolveRouteAuth(req) {
  if (req.auth) return req.auth;
  const auth = await getAuthUser(req);
  return auth && auth.role === 'owner' ? auth : null;
}

async function getUserId(req) {
  const auth = await resolveRouteAuth(req);
  return auth ? auth.userId : null;
}

async function getUserIdAndAdmin(req) {
  return resolveRouteAuth(req);
}

/** 이 요청을 한 직원 id — 주인이면 null. 데이터 주인(user_id)이 아니라 기록 칸(created_by_staff_id)에만 쓴다(T-213 K-3) */
function staffIdOf(req) {
  return req.auth && req.auth.staffId ? req.auth.staffId : null;
}

// 서버 상태 확인 (DB 없이도 동작)
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Sales tool backend is running' });
});

// DB 연결 확인용 API
app.get('/health', async (req, res) => {
  try {
    // pool.query 는 오류가 나도 연결을 반납한다 (D-04)
    const result = await pool.query('SELECT NOW() as now');
    res.json({
      ok: true,
      db: 'connected',
      serverTime: result.rows[0].now,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      db: 'disconnected',
      error: err.message,
    });
  }
});

// 이메일 중복 확인 (형식 검사 포함, 대소문자 구분 없음) — public."user" 테이블만 조회
app.post('/api/auth/check-email', async (req, res) => {
  const raw = req.body?.email?.trim();
  if (!raw) return res.status(400).json({ ok: false, available: false, message: '이메일을 입력하세요.' });
  if (!isValidEmail(raw)) return res.status(400).json({ ok: false, available: false, message: '이메일 형식이 올바르지 않습니다.' });
  const emailLower = raw.toLowerCase();
  try {
    const r = await pool.query('SELECT 1 FROM public."user" WHERE LOWER(email) = $1', [emailLower]);
    const count = r.rows.length;
    const available = count === 0;
    console.log('[check-email]', emailLower, '→ public."user" 조회 결과 행 수:', count, available ? '(사용 가능)' : '(중복)');
    res.json({ ok: true, available, message: available ? undefined : '이미 사용 중인 이메일입니다.' });
  } catch (err) {
    console.error('check-email error:', err.message);
    res.status(500).json({
      ok: false,
      available: false,
      message: '확인할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      error: err.message,
    });
  }
});

// 휴대폰번호 중복 확인 (양식 검사: 010 등 10~11자리)
// 휴대폰 중복 확인(check-phone)은 2026-11-20 제거 — 가입 본인 확인은 이메일 인증만 사용

// ---------- 로그인·번호 확인 시도 제한 (T-114, D 리뷰 R-03 · ADR-05) ----------
// 수치는 [가정] — 사용자 확인 전 기본값. 환경 변수로 바꿀 수 있다(테스트도 이 값으로 짧게 돌린다).
//  - 로그인: 같은 중매인 번호로 LOGIN_MAX_FAILS(5)회 연속 실패하면 LOGIN_LOCK_MINUTES(15)분 동안 로그인 시도를 막는다.
//    없는 번호도 똑같이 세고 막으므로 "막혔다"는 응답으로 계정 존재를 알 수 없다. 영구 잠금이 아니라 지연이다.
//  - 가입용 번호 중복 확인: 접속 주소당 CHECK_AGENT_MAX(20)회 / CHECK_AGENT_WINDOW_MINUTES(10)분.
//    접속 주소는 Cloudflare 가 붙이는 CF-Connecting-IP → 없으면 연결 주소. Render 주소로 직접 부르면 헤더를 꾸밀 수 있어
//    완전한 차단은 아니다(번호 수집 속도를 늦추는 용도). IP 기준 정식 제한은 다음 스프린트(ADR-05 ①).
const { createFailThrottle, createRateLimiter, envNumber } = require('./lib/login-throttle');
const LOGIN_MAX_FAILS = Math.floor(envNumber('LOGIN_MAX_FAILS', 5));
const LOGIN_LOCK_MS = envNumber('LOGIN_LOCK_MINUTES', 15) * 60 * 1000;
const loginThrottle = createFailThrottle({ maxFails: LOGIN_MAX_FAILS, lockMs: LOGIN_LOCK_MS });
const checkAgentLimiter = createRateLimiter({
  max: Math.floor(envNumber('CHECK_AGENT_MAX', 20)),
  windowMs: envNumber('CHECK_AGENT_WINDOW_MINUTES', 10) * 60 * 1000,
});
function clientKey(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  return (cf || req.socket?.remoteAddress || 'unknown').slice(0, 64);
}
function loginLockMessage(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  return `로그인 시도가 너무 많습니다. ${min}분 뒤에 다시 시도해 주세요.`;
}
// 계정이 없을 때도 bcrypt 비교를 한 번 하기 위한 더미 해시 (DEF-T112-02: 응답 시간으로 계정 존재를 알 수 없게)
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

// 비밀번호 규칙 (T-114, D 리뷰 R-04): 8자 이상, bcrypt 가 앞 72바이트만 쓰므로 72바이트 이하(한글은 1자 3바이트)
const PASSWORD_MIN_CHARS = 8;
const PASSWORD_MAX_BYTES = 72;
function passwordProblem(password) {
  if (typeof password !== 'string') return '비밀번호를 입력하세요.';
  if ([...password].length < PASSWORD_MIN_CHARS) return `비밀번호는 ${PASSWORD_MIN_CHARS}자 이상이어야 합니다.`;
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) return '비밀번호가 너무 깁니다. (영문·숫자 72자, 한글 24자 이내)';
  return null;
}

app.post('/api/auth/check-agent-no', async (req, res) => {
  const agent_no = req.body?.agent_no?.trim();
  if (!agent_no) return res.status(400).json({ ok: false, available: false, message: '중매인 번호를 입력하세요.' });
  const hit = checkAgentLimiter.hit(clientKey(req));
  if (!hit.ok) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(hit.retryMs / 1000))));
    return res.status(429).json({ ok: false, available: false, message: '확인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  }
  try {
    const r = await pool.query('SELECT 1 FROM "user" WHERE agent_no = $1', [agent_no]);
    res.json({ ok: true, available: r.rows.length === 0 });
  } catch (err) {
    console.error('check-agent-no error:', err);
    res.status(500).json({ ok: false, available: false, message: '확인할 수 없습니다.' });
  }
});

// 이메일 인증번호 발송 (중복 확인 통과한 이메일, 5분 유효)
app.post('/api/auth/send-email-verification', async (req, res) => {
  const email = req.body?.email?.trim();
  if (!email) return res.status(400).json({ ok: false, message: '이메일을 입력하세요.' });
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, message: '이메일 형식이 올바르지 않습니다.' });
  const emailLower = email.toLowerCase();
  try {
    const r = await pool.query('SELECT 1 FROM "user" WHERE LOWER(email) = $1', [emailLower]);
    if (r.rows.length > 0) return res.status(409).json({ ok: false, message: '이미 가입된 이메일입니다.' });
    verifyFails.delete(emailLower);
    // 만료된 지 하루 넘은 인증번호는 쓸 일이 없으므로 발송할 때마다 정리 (D-10, 무료 DB 용량)
    // 가입은 인증 후 15분 안에만 가능하므로 하루 지난 행은 가입 확인에도 쓰이지 않는다
    await pool.query(`DELETE FROM email_verification WHERE expires_at < NOW() - INTERVAL '1 day'`).catch((e) => console.error('email_verification 정리 실패:', e.message));
    const code = String(crypto.randomInt(100000, 1000000)); // 예측 어려운 난수
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    // 이메일은 소문자로 저장·조회 — 발송·확인·가입에서 대소문자를 다르게 입력해도 같은 인증으로 본다 (D-09)
    await pool.query(
      `INSERT INTO email_verification (email, code, expires_at) VALUES ($1, $2, $3)`,
      [emailLower, code, expiresAt]
    );
    let sendResult;
    try {
      sendResult = await sendVerificationEmail(email, code);
    } catch (mailErr) {
      console.error('Send verification email failed:', mailErr);
      sendResult = { sent: false, code, error: mailErr.message || String(mailErr) };
    }
    const payload = { ok: true, message: sendResult.sent ? '인증번호가 발송되었습니다. 5분 안에 입력하세요.' : '인증번호가 생성되었습니다. 아래 번호를 입력하세요. (이메일 미발송)' };
    if (!sendResult.sent && sendResult.code && EXPOSE_DEV_CODE) payload.dev_code = sendResult.code;
    if (!sendResult.sent && sendResult.error && EXPOSE_DEV_CODE) payload.smtp_error = sendResult.error;
    if (!sendResult.sent && !EXPOSE_DEV_CODE) { payload.ok = false; payload.message = '인증 메일을 보내지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.'; }
    res.status(payload.ok === false ? 503 : 200).json(payload);
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ ok: false, message: err.message || '인증번호 발송에 실패했습니다.' });
  }
});

// 이메일 인증번호 확인 (5분 이내 입력) — 이메일이 유일한 본인 확인이므로 오입력 5회면 그 번호를 무효로 하고 재발송을 요구한다
const VERIFY_MAX_FAILS = 5;
const verifyFails = new Map(); // email(소문자) → 실패 횟수, 새 인증번호를 보내면 초기화
app.post('/api/auth/verify-email-code', async (req, res) => {
  const email = req.body?.email?.trim();
  const code = req.body?.code?.trim();
  if (!email || !code) return res.status(400).json({ ok: false, message: '이메일과 인증번호를 입력하세요.' });
  const failKey = email.toLowerCase();
  if ((verifyFails.get(failKey) || 0) >= VERIFY_MAX_FAILS) {
    return res.status(429).json({ ok: false, message: '인증번호를 5회 잘못 입력했습니다. 인증번호를 다시 받아 주세요.' });
  }
  try {
    const r = await pool.query(
      `SELECT id FROM email_verification WHERE email = $1 AND code = $2 AND expires_at > NOW() AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [failKey, code]
    );
    if (r.rows.length === 0) {
      const n = (verifyFails.get(failKey) || 0) + 1;
      verifyFails.set(failKey, n);
      if (n >= VERIFY_MAX_FAILS) {
        await pool.query(`UPDATE email_verification SET expires_at = NOW() WHERE email = $1 AND verified_at IS NULL`, [failKey]);
        return res.status(429).json({ ok: false, message: '인증번호를 5회 잘못 입력했습니다. 인증번호를 다시 받아 주세요.' });
      }
      return res.status(400).json({ ok: false, message: `인증번호가 맞지 않거나 만료되었습니다. (남은 시도 ${VERIFY_MAX_FAILS - n}회)` });
    }
    verifyFails.delete(failKey);
    await pool.query(`UPDATE email_verification SET verified_at = NOW() WHERE id = $1`, [r.rows[0].id]);
    res.json({ ok: true, message: '이메일 인증이 완료되었습니다.' });
  } catch (err) {
    console.error('Verify email error:', err);
    res.status(500).json({ ok: false, message: err.message || '인증 처리에 실패했습니다.' });
  }
});

// 회원가입 (user_key는 DB DEFAULT로 자동 생성. name=상호명, agent_no=중매인 번호)
app.post('/api/auth/register', async (req, res) => {
  const { name, email, phone, agent_no, password, terms_agreed } = req.body || {};
  if (!name?.trim() || !email?.trim() || !agent_no?.trim() || password === undefined) {
    return res.status(400).json({ ok: false, message: '상호명, 이메일, 중매인 번호, 비밀번호를 모두 입력하세요.' });
  }
  if (!terms_agreed) return res.status(400).json({ ok: false, message: '개인정보약관에 동의해 주세요.' });
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, message: '이메일 형식이 올바르지 않습니다.' });
  // 비밀번호 길이 (T-114, R-04) — 예전에는 1자도 받았다. 기존 회원은 강제 변경하지 않는다(사용자 결정)
  const pwProblem = passwordProblem(password);
  if (pwProblem) return res.status(400).json({ ok: false, message: pwProblem });
  // 휴대폰번호는 선택 항목 (보내면 형식만 확인해 저장, 없으면 NULL — migrations/008)
  if (phone?.trim() && !isValidPhone(phone)) return res.status(400).json({ ok: false, message: '휴대폰번호 형식이 올바르지 않습니다.' });
  const phoneNorm = phone?.trim() ? normalizePhone(phone) : null;
  // 회원 행과 약관 동의 행을 한 트랜잭션으로 — 둘 중 하나만 남지 않게 (T-01)
  const client = await connectOr503(res);
  if (!client) return;
  try {
    const v = await client.query(
      `SELECT 1 FROM email_verification WHERE email = $1 AND verified_at IS NOT NULL AND verified_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    if (v.rows.length === 0) {
      return res.status(400).json({ ok: false, message: '이메일 인증을 먼저 완료해 주세요. (인증번호 발송 후 5분 안에 입력)' });
    }
    const hash = await bcrypt.hash(String(password), 10);
    await client.query('BEGIN');
    const r = await client.query(
      `INSERT INTO "user" (name, phone, email, agent_no, password_hash, terms_agreed_at, status)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'active')
       RETURNING id, user_key, name, email, agent_no`,
      [name.trim(), phoneNorm, email.trim(), agent_no.trim(), hash]
    );
    const user = r.rows[0];
    await client.query(
      `INSERT INTO terms_agreement (user_id, terms_type, agreed_at) VALUES ($1, 'privacy', NOW())`,
      [user.id]
    );
    await client.query('COMMIT');
    res.json({ ok: true, user: { id: user.id, user_key: user.user_key, name: user.name, email: user.email, agent_no: user.agent_no } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      const msg = err.constraint === 'user_email_key' || err.constraint === 'ux_user_email_lower' ? '이미 사용 중인 이메일입니다.'
        : err.constraint === 'user_phone_key' ? '이미 사용 중인 휴대폰번호입니다.'
        : err.constraint === 'user_agent_no_key' ? '이미 사용 중인 중매인 번호입니다.' : '이미 등록된 정보가 있습니다.';
      return res.status(409).json({ ok: false, message: msg });
    }
    console.error('Register error:', err);
    res.status(500).json({ ok: false, message: '회원가입 처리 중 오류가 발생했습니다.' });
  } finally {
    client.release();
  }
});

// 로그인 API (중매인 번호 + 비밀번호 → 사용자 정보 + 로그인 토큰 반환)
app.post('/api/auth/login', async (req, res) => {
  const { agent_no, password } = req.body || {};
  // 요청 본문 전체(비밀번호 포함)를 로그에 남기지 않는다 (S-01) — 중매인 번호만 기록
  console.log('[login] agent_no =', String(agent_no ?? '').trim().slice(0, 50));
  if (!agent_no || password === undefined) {
    return res.status(400).json({ ok: false, message: '중매인 번호와 비밀번호를 입력하세요.' });
  }
  // T-213: 본문에 login_id 가 있으면 직원 로그인(lib/staff-routes.js). 없으면 아래 주인 로그인 그대로(RULE-21)
  if (req.body.login_id !== undefined && req.body.login_id !== null && String(req.body.login_id).trim() !== '') {
    return staffRoutes.staffLogin(req, res);
  }
  // 시도 제한 키: 중매인 번호(대소문자 구분 없이, 길이 제한) — 계정 존재와 무관하게 센다 (T-114, R-03)
  const throttleKey = String(agent_no).trim().toLowerCase().slice(0, 64);
  const lockedMs = loginThrottle.lockedFor(throttleKey);
  if (lockedMs > 0) {
    res.setHeader('Retry-After', String(Math.ceil(lockedMs / 1000)));
    return res.status(429).json({ ok: false, message: loginLockMessage(lockedMs) });
  }
  const failLogin = () => {
    const nowLocked = loginThrottle.fail(throttleKey);
    if (nowLocked) console.warn('[login] 연속 실패로 잠시 막음 agent_no =', throttleKey.slice(0, 50));
    return res.status(401).json({ ok: false, message: '중매인 번호 또는 비밀번호가 올바르지 않습니다.' });
  };
  try {
    // pool.query 는 조회 오류가 나도 연결을 반납한다 — 예전 코드는 오류 시 release 를 건너뛰어 5번이면 풀이 바닥났다 (D-04)
    const r = await pool.query(
      `SELECT id, user_key, name, agent_no, password_hash, status, is_admin FROM "user" WHERE agent_no = $1`,
      [String(agent_no).trim()]
    );
    const row = r.rows[0];
    // 계정이 없어도 더미 해시로 bcrypt 비교를 한 번 한다 — 응답 시간 차이로 계정 존재를 알 수 없게 (DEF-T112-02)
    const match = await bcrypt.compare(String(password), row ? row.password_hash : DUMMY_PASSWORD_HASH);
    if (!row || !match) return failLogin();
    // 계정 상태는 비밀번호가 맞을 때만 알려 준다 — 틀린 비밀번호로 정지 여부를 알 수 없게 (DEF-T112-01, R-14)
    if (row.status !== 'active') {
      return res.status(403).json({ ok: false, message: '비활성화된 계정입니다.' });
    }
    loginThrottle.reset(throttleKey);
    await recordAudit(pool, { userId: row.id, entityType: 'auth', action: 'login', note: '로그인' }); // T-212
    const token = authToken.signToken(AUTH.secret, { userId: row.id, agentNo: row.agent_no }, AUTH_TTL_SEC);
    res.json({
      ok: true,
      token,
      expires_in: AUTH_TTL_SEC,
      user: { id: row.id, user_key: row.user_key, name: row.name, agent_no: row.agent_no, is_admin: !!row.is_admin, staff: null },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ ok: false, message: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

// ---------- API 기능 확인 (스모크·배포 검증용, 인증 불필요) ----------
app.get('/api/capabilities', (req, res) => {
  res.json({
    ok: true,
    app: 'sales-tool-server',
    /** 거래 흐름 POST 라우트가 포함된 빌드면 true — 구버전 서버는 이 경로 자체가 없을 수 있음 */
    tradeFlowPost: true,
    /** 설정된 인증 메일 발송 수단(순서대로 시도) — 키 값은 노출하지 않음 */
    mailProviders: configuredProviders(),
    hints: ['POST /api/purchases', 'POST /api/purchases/convert-to-sales', 'POST /api/payments', 'POST /api/sales/:id/refund', 'POST /api/disposals', 'POST /api/purchases/:id/cancel', 'PATCH /api/purchases/:id', 'POST /api/sales/:id/cancel', 'PATCH /api/sales/:id'],
    /** 매입·매출 정정(T-103) 라우트 포함 */
    tradeCorrection: true,
  });
});

// ---------- 직원 계정·권한 (T-213) — lib/staff-routes.js ----------
// GET /api/me · POST /api/me/password · /api/staff* · POST /api/auth/staff/setup-password, 직원 로그인(staffLogin)
const staffRoutes = require('./lib/staff-routes').registerStaffRoutes(app, {
  pool, connectOr503, recordAudit, authToken, AUTH, AUTH_TTL_SEC, loginThrottle, loginLockMessage,
  DUMMY_PASSWORD_HASH, passwordProblem, isValidEmail, sendMail, configuredProviders, EXPOSE_DEV_CODE, allowedUi: access.allowedUi,
});

// ---------- 메인 화면용 API (Authorization: Bearer <로그인 토큰> 필수, 토큰의 사용자 데이터만 조회) ----------

// 상품 목록 (대분류/중분류/소분류/이름 검색 가능)
// T-216: 공용 품목(owner_user_id NULL) + 로그인한 본인의 개인 품목만. 토큰이 없으면 공용만(기존 S-005 동작 유지).
//        scope=public 이면 공용만(관리자 상품 마스터), scope=personal 이면 내 개인 품목만.
app.get('/api/products', async (req, res) => {
  try {
    const auth = req.headers.authorization ? await getUserIdAndAdmin(req) : null;
    const me = auth ? auth.userId : null;
    const scope = String(req.query.scope || '');
    const categoryLarge = req.query.category_large?.trim();
    const categoryMid = req.query.category_mid?.trim();
    const categorySmall = req.query.category_small?.trim();
    const nameSearch = req.query.name?.trim();
    const params = [me];
    let q = `SELECT p.id, p.name, p.unit, p.category, p.category_large, p.category_mid, p.category_small, p.product_key, p.memo, p.created_at, p.updated_at,
                    (p.owner_user_id IS NOT NULL) AS is_personal, rq.status AS request_status, rq.reject_reason AS request_reject_reason
               FROM product p
               LEFT JOIN LATERAL (
                 SELECT r.status, r.reject_reason FROM product_request r
                  WHERE r.product_id = p.id AND p.owner_user_id IS NOT NULL ORDER BY r.created_at DESC, r.id DESC LIMIT 1
               ) rq ON true
              WHERE (p.owner_user_id IS NULL OR p.owner_user_id = $1::int)`;
    if (scope === 'public') q += ' AND p.owner_user_id IS NULL';
    else if (scope === 'personal') q += ' AND p.owner_user_id = $1::int';
    if (categoryLarge) { params.push(categoryLarge); q += ` AND p.category_large = $${params.length}`; }
    if (categoryMid) { params.push(categoryMid); q += ` AND p.category_mid = $${params.length}`; }
    if (categorySmall) { params.push(categorySmall); q += ` AND p.category_small = $${params.length}`; }
    if (nameSearch) { params.push('%' + nameSearch + '%'); q += ` AND p.name ILIKE $${params.length}`; }
    q += ' ORDER BY p.category_large, p.category_mid, p.category_small, p.name';
    const r = await pool.query(q, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ ok: false, message: err.message || '상품 목록을 불러오지 못했습니다.' });
  }
});

async function generateProductKey(client) {
  const hasSeq = await client.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.sequences
      WHERE sequence_schema = 'public' AND sequence_name = 'product_key_seq'
    ) AS ok`
  );
  if (hasSeq.rows[0]?.ok) {
    const k = await client.query(`SELECT 'P' || LPAD(nextval('product_key_seq')::text, 5, '0') AS product_key`);
    return k.rows[0].product_key;
  }
  const m = await client.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(product_key FROM '[0-9]+$') AS INTEGER)), 0) AS n
     FROM product
     WHERE product_key ~ '^P[0-9]+$'`
  );
  const nextN = Number(m.rows[0]?.n || 0) + 1;
  return `P${String(nextN).padStart(5, '0')}`;
}

// 상품 단건 등록 (관리자)
app.post('/api/products', async (req, res) => {
  const auth = await getUserIdAndAdmin(req);
  if (!auth) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  if (!auth.isAdmin) return res.status(403).json({ ok: false, message: '관리자만 등록할 수 있습니다.' });
  const { name, unit, category_large, category_mid, category_small, memo } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ ok: false, message: '상품명을 입력하세요.' });
  const client = await connectOr503(res);
  if (!client) return;
  try {
    const productKey = await generateProductKey(client);
    const r = await client.query(
      `INSERT INTO product (name, unit, category_large, category_mid, category_small, product_key, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, unit, category_large, category_mid, category_small, product_key, memo, created_at`,
      [name.trim(), (unit || 'kg').trim(), category_large?.trim() || null, category_mid?.trim() || null, category_small?.trim() || null, productKey, memo?.trim() || null]
    );
    res.status(201).json({ ok: true, data: r.rows[0] });
  } catch (err) {
    console.error('Product create error:', err);
    res.status(500).json({ ok: false, message: err.message || '등록에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// 상품 다건 등록 (관리자)
app.post('/api/products/bulk', async (req, res) => {
  const auth = await getUserIdAndAdmin(req);
  if (!auth) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  if (!auth.isAdmin) return res.status(403).json({ ok: false, message: '관리자만 등록할 수 있습니다.' });
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  if (products.length === 0) return res.status(400).json({ ok: false, message: '등록할 상품 목록을 입력하세요.' });
  const created = [];
  const client = await connectOr503(res);
  if (!client) return;
  try {
    // 중간에 한 건이 실패하면 앞 건들만 등록되어 남지 않게 전체를 한 트랜잭션으로 (T-02)
    await client.query('BEGIN');
    for (const p of products) {
      const name = (p.name != null && String(p.name)).trim();
      if (!name) continue;
      const productKey = await generateProductKey(client);
      const r = await client.query(
        `INSERT INTO product (name, unit, category_large, category_mid, category_small, product_key, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, unit, category_large, category_mid, category_small, product_key, memo, created_at`,
        [
          name,
          (p.unit != null ? String(p.unit) : 'kg').trim(),
          (p.category_large != null ? String(p.category_large) : '').trim() || null,
          (p.category_mid != null ? String(p.category_mid) : '').trim() || null,
          (p.category_small != null ? String(p.category_small) : '').trim() || null,
          productKey,
          (p.memo != null ? String(p.memo) : '').trim() || null,
        ]
      );
      created.push(r.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: created, count: created.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Product bulk create error:', err);
    res.status(500).json({ ok: false, message: err.message || '다건 등록에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// 거래처 목록 (중매인 번호 기준 — 내 회원)
app.get('/api/partners', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  try {
    // payable_amount: 매입 가능 유형만 미지급 합(T-201 W-08), 그 밖은 null
    const r = await pool.query(
      `SELECT a.id, a.name, a.type, a.contact, a.phone, a.email, a.location, a.address, a.credit_limit,
              (CASE WHEN a.type IN ('supplier', 'wholesaler', 'market_wholesaler', 'same_market')
                    THEN COALESCE((SELECT SUM(pu.total_amount - pu.paid_amount) FROM purchase pu
                                    WHERE pu.user_id = a.user_id AND pu.partner_id = a.id AND pu.status = 'active'
                                      AND pu.payment_status IN ('unpaid', 'partial')), 0)
               END)::numeric AS payable_amount
         FROM account a WHERE a.user_id = $1 ORDER BY a.name`,
      [userId]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Partners error:', err);
    res.status(500).json({ ok: false, message: err.message || '거래처 목록을 불러오지 못했습니다.' });
  }
});

// 거래처 등록·수정 (T-102) — 유형은 partner_type enum(001·004)과 같게 유지
const PARTNER_TYPES = ['supplier', 'customer', 'same_market', 'wholesaler', 'market_wholesaler'];
const PARTNER_TEXT_LIMITS = { name: 200, contact: 100, phone: 50, email: 255, location: 200, address: 2000, memo: 2000 };

/** 본문에서 거래처 필드를 읽어 검증한다. partial=true(수정)면 본문에 없는 필드는 건드리지 않는다. */
function readPartnerBody(body, partial) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const key of ['name', 'type', 'contact', 'phone', 'email', 'location', 'address', 'memo']) {
    if (!(key in b)) continue;
    const v = b[key] == null ? '' : String(b[key]).trim();
    out[key] = v;
  }
  if (!partial || 'name' in out) {
    if (!out.name) return { error: '거래처 이름을 입력하세요.' };
  }
  if (!partial || 'type' in out) {
    if (!PARTNER_TYPES.includes(out.type)) return { error: '거래처 유형을 선택하세요.' };
  }
  for (const [key, max] of Object.entries(PARTNER_TEXT_LIMITS)) {
    if (out[key] != null && out[key].length > max) return { error: `${key} 값은 ${max}자 이하로 입력하세요.` };
  }
  // 입금 안내 이메일 (T-214) — 비우면 없음
  if (out.email && !isValidEmail(out.email)) return { error: '이메일 형식이 올바르지 않습니다.' };
  // 선택 항목은 빈 문자열 대신 NULL 로 저장
  for (const key of ['contact', 'phone', 'email', 'location', 'address', 'memo']) {
    if (key in out && out[key] === '') out[key] = null;
  }
  // 외상 한도 (T-207) — 비우면 한도 없음(NULL)
  const cl = credit.readCreditLimit(b);
  if (cl.error) return { error: cl.error };
  if (!cl.absent) out.credit_limit = cl.value;
  return { fields: out };
}

const PARTNER_RETURNING = 'id, name, type, contact, phone, email, location, address, memo, credit_limit, created_at, updated_at';
// 외상 한도 (T-207) — 판매·매출 수정 저장 후 미수가 한도를 넘으면 409 CREDIT_LIMIT(확인 후 저장)
const credit = require('./lib/credit-limit');

/** 같은 사용자의 같은 이름(앞뒤 공백·대소문자 무시) 거래처가 있으면 그 행을 돌려준다 */
async function findDuplicatePartner(client, userId, name, exceptId) {
  const r = await client.query(
    `SELECT id, name FROM account
      WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND ($3::int IS NULL OR id <> $3)
      LIMIT 1`,
    [userId, name, exceptId == null ? null : exceptId]
  );
  return r.rows[0] || null;
}

app.post('/api/partners', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const parsed = readPartnerBody(req.body, false);
  if (parsed.error) return res.status(400).json({ ok: false, message: parsed.error });
  const f = parsed.fields;
  const client = await connectOr503(res);
  if (!client) return;
  try {
    await client.query('BEGIN');
    // 같은 사용자의 동시 등록이 중복 검사를 함께 통과하지 않게 사용자 단위로 줄 세운다
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`account-name:${userId}`]);
    const dup = await findDuplicatePartner(client, userId, f.name, null);
    if (dup) {
      await client.query('ROLLBACK');
      return res.status(409).json({ ok: false, message: `이미 같은 이름의 거래처가 있습니다: ${dup.name}`, data: { duplicate_id: dup.id } });
    }
    const r = await client.query(
      `INSERT INTO account (user_id, name, type, contact, phone, location, address, memo, credit_limit, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10)
       RETURNING ${PARTNER_RETURNING}`,
      [userId, f.name, f.type, f.contact ?? null, f.phone ?? null, f.location ?? null, f.address ?? null, f.memo ?? null, f.credit_limit ?? null, f.email ?? null]
    );
    await recordAudit(client, { userId, entityType: 'account', entityId: r.rows[0].id, partnerId: r.rows[0].id, action: 'create', before: null, after: r.rows[0] }); // T-212
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ ok: false, message: '이미 같은 이름의 거래처가 있습니다.' });
    console.error('Partner create error:', err);
    res.status(500).json({ ok: false, message: '거래처를 등록하지 못했습니다.' });
  } finally {
    client.release();
  }
});

app.put('/api/partners/:id', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(req.params.id).trim()) {
    return res.status(400).json({ ok: false, message: '거래처 번호가 올바르지 않습니다.' });
  }
  const parsed = readPartnerBody(req.body, true);
  if (parsed.error) return res.status(400).json({ ok: false, message: parsed.error });
  const f = parsed.fields;
  const keys = Object.keys(f);
  if (keys.length === 0) return res.status(400).json({ ok: false, message: '수정할 항목이 없습니다.' });
  const client = await connectOr503(res);
  if (!client) return;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`account-name:${userId}`]);
    // 다른 사용자의 거래처는 존재 여부도 드러내지 않고 404
    const cur = await client.query('SELECT * FROM account WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]); // * = T-212 변경 전 값
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, message: '거래처를 찾을 수 없습니다.' });
    }
    if ('name' in f) {
      const dup = await findDuplicatePartner(client, userId, f.name, id);
      if (dup) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, message: `이미 같은 이름의 거래처가 있습니다: ${dup.name}`, data: { duplicate_id: dup.id } });
      }
    }
    // 컬럼 이름은 readPartnerBody 의 고정 목록에서만 오므로 그대로 써도 안전하다
    const sets = keys.map((k, i) => `${k} = $${i + 3}`);
    const r = await client.query(
      `UPDATE account SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND user_id = $2
        RETURNING ${PARTNER_RETURNING}`,
      [id, userId, ...keys.map((k) => f[k])]
    );
    await recordAudit(client, { userId, entityType: 'account', entityId: id, partnerId: id, action: 'update', before: cur.rows[0], after: f }); // T-212
    await client.query('COMMIT');
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return res.status(409).json({ ok: false, message: '이미 같은 이름의 거래처가 있습니다.' });
    console.error('Partner update error:', err);
    res.status(500).json({ ok: false, message: '거래처를 수정하지 못했습니다.' });
  } finally {
    client.release();
  }
});

// 거래처 원장·미수 연령 (T-104) — 라우트는 lib/ledger-routes.js (kstToday 는 아래 함수 선언, 호이스팅됨)
require('./lib/ledger-routes').registerLedgerRoutes(app, { pool, getUserId, kstToday });
// 첫 화면 대시보드 "오늘" (T-208) — lib/dashboard-routes.js
require('./lib/dashboard-routes').registerDashboardRoutes(app, { pool, getUserId, kstToday });
// 변경 이력(감사 로그) 화면 (T-212) — lib/audit-log.js
registerAuditRoutes(app, { pool, getUserId });
// 월 정산 보고서 (T-215) — lib/monthly-report-routes.js
require('./lib/monthly-report-routes').registerMonthlyReportRoutes(app, { pool, getUserId, kstToday });
// 미수 입금 안내 메일 (T-214) — lib/payment-reminder-routes.js (메일은 lib/mailer.js, 테스트는 MAIL_DRY_RUN)
require('./lib/payment-reminder-routes').registerPaymentReminderRoutes(app, { pool, getUserId, kstToday, connectOr503, mailer: { sendMail, configuredProviders } });
// 중매인 개인 품목·공용 등록 요청 (T-216) — lib/product-request-routes.js
require('./lib/product-request-routes').registerProductRequestRoutes(app, { pool, getUserIdAndAdmin, connectOr503, generateProductKey });
// 매입처 지급·지급 원장·미지급 연령 (T-201) — 라우트는 lib/payable-routes.js
const { registerPayableRoutes, syncPurchasePaymentStatus, activePaymentsOfPurchase } = require('./lib/payable-routes');
registerPayableRoutes(app, { pool, getUserId, kstToday, connectOr503, parsePaidAtInput });

// 재고현황 (중매인 번호 기준)
// T-209 재고 경과일: 남은 재고 중 "가장 오래된 매입일" 기준 (KST 오늘 − 그 매입일).
//   남은 재고 = 매출로 배분되지 않은 매입 묶음(purchase.quantity − purchase_allocation 합).
//   폐기·환불은 매입 묶음을 줄이거나 늘리지 않으므로, 최근 매입부터 재고 수량만큼만 남아 있다고 보고
//   (오래된 것부터 나간다고 가정) 그 범위에서 가장 오래된 매입일을 쓴다. 남은 묶음이 없으면(환불로만 생긴 재고 등) 마지막 매입일.
// T-211: q(품목·출처·최근 매입 거래처), partner_id(최근 매입 거래처), limit·offset — 없으면 예전과 같은 전체 목록
app.get('/api/inventory', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const opts = parseListOptions(req.query);
  if (opts.error) return res.status(400).json(opts.error);
  const partnerFilter = req.query.partner_id ? parsePositiveIdParam(req.query.partner_id) : null;
  if (req.query.partner_id && !partnerFilter) {
    return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'partner_id', message: '거래처 번호가 올바르지 않습니다.' });
  }
  try {
    const params = [userId, kstToday()];
    let where = '';
    if (partnerFilter) { params.push(partnerFilter); where += ` AND lp.partner_id = $${params.length}`; }
    where += searchClause(opts, params, ['p.name', 'lp.source_name', 'pt.name']);
    const payload = await runList(
      pool,
      `SELECT i.id, i.product_id, i.quantity, i.updated_at, p.name AS product_name, p.unit,
              lp.purchase_date AS last_purchase_date,
              lp.created_at AS last_purchase_created_at,
              NULLIF(BTRIM(lp.source_name::text), '') AS last_source_name,
              NULLIF(BTRIM(pt.name::text), '') AS last_partner_name,
              to_char(COALESCE(op.oldest_date, lp.purchase_date), 'YYYY-MM-DD') AS aging_base_date,
              ($2::date - COALESCE(op.oldest_date, lp.purchase_date))::int AS aging_days,
              COALESCE(fl.sellable, 0)::numeric AS sellable_qty,
              GREATEST(0, i.quantity - COALESCE(fl.lot_total, 0))::numeric AS unlinked_qty
       FROM inventory i
       JOIN product p ON p.id = i.product_id
       LEFT JOIN LATERAL (
         SELECT pu.purchase_date, pu.created_at, pu.partner_id, pu.source_name
         FROM purchase pu
         WHERE pu.user_id = i.user_id AND pu.product_id = i.product_id AND pu.status = 'active' -- 취소된 매입 제외 (T-103)
         ORDER BY pu.purchase_date DESC, pu.created_at DESC NULLS LAST, pu.id DESC
         LIMIT 1
       ) lp ON true
       LEFT JOIN LATERAL (
         SELECT MIN(lot.purchase_date) AS oldest_date
         FROM (
           SELECT pu.purchase_date,
                  SUM(pu.quantity - COALESCE(al.q, 0))
                    OVER (ORDER BY pu.purchase_date DESC, pu.id DESC) AS cum_newest,
                  (pu.quantity - COALESCE(al.q, 0)) AS remain
           FROM purchase pu
           LEFT JOIN (
             SELECT pa.purchase_id, SUM(pa.quantity) AS q
             FROM purchase_allocation pa
             WHERE pa.user_id = i.user_id
             GROUP BY pa.purchase_id
           ) al ON al.purchase_id = pu.id
           WHERE pu.user_id = i.user_id AND pu.product_id = i.product_id AND pu.status = 'active'
             AND pu.quantity - COALESCE(al.q, 0) > 0
         ) lot
         WHERE lot.cum_newest - lot.remain < i.quantity
       ) op ON true
       -- T-205 판매 가능(오늘 판매 기준)·매입 미연결 수량 — 015 뷰 inventory_lot_available
       LEFT JOIN LATERAL (
         SELECT MAX(v.lot_total) AS lot_total, SUM(v.available) FILTER (WHERE v.purchase_date <= $2::date) AS sellable
         FROM inventory_lot_available v
         WHERE v.user_id = i.user_id AND v.product_id = i.product_id
       ) fl ON true
       LEFT JOIN account pt ON pt.id = lp.partner_id AND pt.user_id = i.user_id
       WHERE i.user_id = $1 AND i.quantity > 0${where}`,
      params,
      ' ORDER BY p.name, i.id',
      opts
    );
    res.json(payload);
  } catch (err) {
    console.error('Inventory error:', err);
    res.status(500).json({ ok: false, message: err.message || '재고현황을 불러오지 못했습니다.' });
  }
});

// ---------- T-213 입력자(직원) 칸 — 매입·매출·수금 목록 공통 ----------
// 응답 행에 created_by_staff_id, created_by_name(직원 이름, 주인이 넣었으면 NULL, 삭제된 직원은 "이름(삭제됨)")
// 쿼리 created_by=staff(직원 입력만) | created_by=<직원 id>. 없으면 예전과 같은 행
const CREATED_BY_NAME = `CASE WHEN cs.id IS NULL THEN NULL WHEN cs.status = 'deleted' THEN cs.name || '(삭제됨)' ELSE cs.name END AS created_by_name`;
/** @returns null(조건 없음) | 'staff' | 숫자 | false(400 응답을 이미 보냄) */
function readCreatedBy(query, res) {
  const raw = String(query.created_by ?? '').trim();
  if (!raw) return null;
  if (raw === 'staff') return 'staff';
  if (/^d{1,9}$/.test(raw) && Number(raw) > 0) return Number(raw);
  res.status(400).json({ ok: false, code: 'VALIDATION', field: 'created_by', message: '입력자 조건이 올바르지 않습니다(staff 또는 직원 번호).' });
  return false;
}
function createdByClause(createdBy, params, alias) {
  if (createdBy === 'staff') return ` AND ${alias}.created_by_staff_id IS NOT NULL`;
  if (typeof createdBy === 'number') {
    params.push(createdBy);
    return ` AND ${alias}.created_by_staff_id = $${params.length}`;
  }
  return '';
}

// 매입정보 (중매인 번호 기준, 기간·제품별 검색)
app.get('/api/purchases', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const today = kstToday();
  const from = req.query.from_date || today;
  const to = req.query.to_date || today;
  const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
  const unpaidOnly = req.query.unpaid_only === '1' || req.query.unpaid_only === 'true';
  const createdBy = readCreatedBy(req.query, res); // T-213 입력자 필터
  if (createdBy === false) return undefined;
  const partnerFilter = req.query.partner_id ? parsePositiveIdParam(req.query.partner_id) : null;
  if (req.query.partner_id && !partnerFilter) {
    return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'partner_id', message: '거래처 번호가 올바르지 않습니다.' });
  }
  const opts = parseListOptions(req.query); // T-211: q(품목·메모·출처·거래처), limit·offset
  if (opts.error) return res.status(400).json(opts.error);
  try {
    let q = `SELECT pu.id, pu.partner_id, pu.product_id, pu.purchase_date, pu.created_at, pu.quantity, pu.unit_price, pu.total_amount, pu.memo, pu.source_name,
             pu.status, pu.cancelled_at, pu.cancel_reason, pu.updated_at,
             pu.paid_amount, pu.payment_status,
             (CASE WHEN pu.status = 'active' THEN GREATEST(pu.total_amount - pu.paid_amount, 0) ELSE 0 END)::numeric AS unpaid_amount,
             p.name AS product_name, p.unit, pt.name AS partner_name,
             COALESCE((SELECT SUM(pa.quantity) FROM purchase_allocation pa WHERE pa.purchase_id = pu.id), 0)::numeric AS allocated_qty,
             (pu.quantity - COALESCE((SELECT SUM(pa.quantity) FROM purchase_allocation pa WHERE pa.purchase_id = pu.id), 0))::numeric AS remaining_qty,
             pu.created_by_staff_id, ${CREATED_BY_NAME}
             FROM purchase pu
             JOIN product p ON p.id = pu.product_id
             JOIN account pt ON pt.id = pu.partner_id
             LEFT JOIN staff_account cs ON cs.id = pu.created_by_staff_id AND cs.owner_user_id = pu.user_id
             WHERE pu.user_id = $1`;
    const params = [userId];
    // T-201: unpaid_only=1 이면 미지급·일부 지급(취소 제외)만 전체 기간(매출 unpaid_only 와 같음) — 지급 등록 모달용
    if (unpaidOnly) {
      q += ` AND pu.status = 'active' AND pu.payment_status IN ('unpaid', 'partial') AND pu.total_amount - pu.paid_amount > 0`;
    } else {
      params.push(from, to);
      q += ' AND pu.purchase_date BETWEEN $2 AND $3';
    }
    if (partnerFilter) {
      params.push(partnerFilter);
      q += ` AND pu.partner_id = $${params.length}`;
    }
    if (productId && Number.isFinite(productId)) {
      params.push(productId);
      q += ` AND pu.product_id = $${params.length}`;
    }
    q += createdByClause(createdBy, params, 'pu');
    q += searchClause(opts, params, ['p.name', 'pu.memo', 'pu.source_name', 'pt.name']);
    const orderBy = unpaidOnly ? ' ORDER BY pu.purchase_date, pu.id' : ' ORDER BY pu.purchase_date DESC, pu.id DESC';
    res.json(await runList(pool, q, params, orderBy, opts));
  } catch (err) {
    console.error('Purchases error:', err);
    res.status(500).json({ ok: false, message: err.message || '매입정보를 불러오지 못했습니다.' });
  }
});

/** 쿼리 문자열의 양의 정수 id — 숫자가 아니거나 0 이하면 null */
function parsePositiveIdParam(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n > 0 && n <= 2147483647 ? n : null;
}

// 매입 등록 모달 — 같은 상품(+거래처)의 최근 매입 단가 1건 (T-210)
// 로그인 회원 소유 매입만 본다. 남의 상품·거래처 id를 넣어도 user_id 조건 때문에 data: null.
// 거래처를 주면 그 거래처 기록을 먼저 찾고, 없으면 같은 상품의 전체 거래처 기록으로 대신한다(scope로 구분).
// 인덱스: idx_purchase_user_product_date (user_id, product_id, purchase_date DESC) — 009
app.get('/api/purchases/last-price', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const productId = parsePositiveIdParam(req.query.product_id);
  if (!productId) return res.status(400).json({ ok: false, message: '상품을 지정하세요.' });
  const hasPartner = req.query.partner_id != null && String(req.query.partner_id).trim() !== '';
  const partnerId = hasPartner ? parsePositiveIdParam(req.query.partner_id) : null;
  if (hasPartner && !partnerId) return res.status(400).json({ ok: false, message: '거래처 값이 올바르지 않습니다.' });
  const sql = `SELECT pu.unit_price, pu.quantity, to_char(pu.purchase_date, 'YYYY-MM-DD') AS purchase_date,
                      pu.partner_id, pt.name AS partner_name
                 FROM purchase pu
                 JOIN account pt ON pt.id = pu.partner_id AND pt.user_id = pu.user_id
                WHERE pu.user_id = $1 AND pu.product_id = $2 AND ($3::int IS NULL OR pu.partner_id = $3::int)
                ORDER BY pu.purchase_date DESC, pu.id DESC
                LIMIT 1`;
  try {
    let scope = partnerId ? 'partner' : 'product';
    let r = await pool.query(sql, [userId, productId, partnerId]);
    if (r.rows.length === 0 && partnerId) {
      scope = 'product';
      r = await pool.query(sql, [userId, productId, null]);
    }
    if (r.rows.length === 0) return res.json({ ok: true, data: null });
    const row = r.rows[0];
    res.json({
      ok: true,
      data: {
        scope,
        unit_price: Number(row.unit_price),
        quantity: Number(row.quantity),
        purchase_date: row.purchase_date,
        partner_id: row.partner_id,
        partner_name: row.partner_name,
      },
    });
  } catch (err) {
    console.error('Last purchase price error:', err);
    res.status(500).json({ ok: false, message: '최근 단가를 불러오지 못했습니다.' });
  }
});

// 매입 등록 모달 — 최근에 매입한 거래처 순서 (T-210, 자주 쓰는 거래처를 목록 위로)
// 최근 180일 매입 기준, 마지막 매입일 내림차순 → 건수 내림차순. 인덱스: idx_purchase_user_date (user_id, purchase_date) — 009
const RECENT_PARTNER_DAYS = 180;
app.get('/api/purchases/recent-partners', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  try {
    const r = await pool.query(
      `SELECT pu.partner_id, to_char(MAX(pu.purchase_date), 'YYYY-MM-DD') AS last_date, COUNT(*)::int AS cnt
         FROM purchase pu
        WHERE pu.user_id = $1 AND pu.purchase_date >= ($2::date - $3::int)
        GROUP BY pu.partner_id
        ORDER BY MAX(pu.purchase_date) DESC, COUNT(*) DESC, pu.partner_id
        LIMIT 50`,
      [userId, kstToday(), RECENT_PARTNER_DAYS]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Recent purchase partners error:', err);
    res.status(500).json({ ok: false, message: '최근 거래처를 불러오지 못했습니다.' });
  }
});

function parsePaidAtInput(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00+09:00`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    const withSec = s.length === 16 ? `${s}:00` : s;
    if (/[Z+-]\d{2}:?\d{2}$/.test(withSec) || withSec.endsWith('Z')) return new Date(withSec);
    return new Date(`${withSec}+09:00`);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// 매출정보 (중매인 번호 기준, 기간·거래처별 검색)
// unpaid_only=1 이면 미수·일부만 전체 기간(날짜 필터 무시)
// paid_only=1 이면 수금 완료만 (기간·거래처 필터 적용)
// refundable_only=1 이면 환불 가능 잔여 수량 있음(수금 여부 무관 — 반품 규칙 B) (환불 처리 모달용)
// 응답 칸: returned_amount(누적 반품액), unpaid_amount(미수 = 총액 − 반품액 − 수금, 0 미만은 0)
app.get('/api/sales', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = req.query.from_date || '';
  const to = req.query.to_date || '';
  const partnerId = req.query.partner_id ? parseInt(req.query.partner_id, 10) : null;
  const unpaidOnly = req.query.unpaid_only === '1' || req.query.unpaid_only === 'true';
  const paidOnly = req.query.paid_only === '1' || req.query.paid_only === 'true';
  const refundableOnly = req.query.refundable_only === '1' || req.query.refundable_only === 'true';
  const createdBy = readCreatedBy(req.query, res); // T-213 입력자 필터
  if (createdBy === false) return undefined;
  const opts = parseListOptions(req.query); // T-211: q(품목·메모·거래처), limit·offset
  if (opts.error) return res.status(400).json(opts.error);
  try {
    let q = `SELECT s.id, s.partner_id, s.product_id, s.sale_date, s.created_at, s.quantity, s.unit_price, s.total_amount,
             s.payment_status, s.paid_amount, s.status, s.memo,
             s.returned_amount, s.overpaid_amount, s.cancelled_at, s.cancel_reason, s.updated_at, s.entry_mode,
             (SELECT COUNT(*)::int FROM purchase_allocation pa WHERE pa.sale_id = s.id) AS allocation_count,
             GREATEST(s.total_amount - s.returned_amount - s.paid_amount, 0)::numeric AS unpaid_amount,
             p.name AS product_name, p.unit, pt.name AS partner_name, pt.location AS partner_location,
             COALESCE((SELECT SUM(r.quantity) FROM refund r WHERE r.sale_id = s.id), 0)::numeric AS refunded_qty,
             s.created_by_staff_id, ${CREATED_BY_NAME}
             FROM sale s
             JOIN product p ON p.id = s.product_id
             JOIN account pt ON pt.id = s.partner_id
             LEFT JOIN staff_account cs ON cs.id = s.created_by_staff_id AND cs.owner_user_id = s.user_id
             WHERE s.user_id = $1`;
    const params = [userId];
    if (unpaidOnly) {
      // 미수는 상태가 아니라 금액으로 판단한다(T-219 R-06·F-3): 전량 반품(refunded)인데 미수가 남은 이전 기록도 보이고 받을 수 있게
      q += ` AND s.payment_status IN ('unpaid', 'partial') AND s.status <> 'cancelled' AND s.total_amount - s.returned_amount - s.paid_amount > 0.005`;
    } else if (refundableOnly) {
      // 반품 규칙 B(T-108): 외상(수금 0원) 매출도 반품할 수 있다 — 반품 금액은 미수에서 먼저 빠진다 (U3: 예전엔 수금 있는 매출만)
      q += ` AND s.status NOT IN ('refunded', 'cancelled')`;
      q += ` AND (s.quantity - COALESCE((SELECT SUM(r.quantity) FROM refund r WHERE r.sale_id = s.id), 0)) > 0.0001`;
      if (from) { params.push(from); q += ` AND s.sale_date >= $${params.length}`; }
      if (to) { params.push(to); q += ` AND s.sale_date <= $${params.length}`; }
    } else if (paidOnly) {
      q += ` AND s.payment_status = 'paid'`;
      if (from) { params.push(from); q += ` AND s.sale_date >= $${params.length}`; }
      if (to) { params.push(to); q += ` AND s.sale_date <= $${params.length}`; }
    } else {
      if (from) { params.push(from); q += ` AND s.sale_date >= $${params.length}`; }
      if (to) { params.push(to); q += ` AND s.sale_date <= $${params.length}`; }
    }
    if (partnerId && Number.isFinite(partnerId)) { params.push(partnerId); q += ` AND s.partner_id = $${params.length}`; }
    q += createdByClause(createdBy, params, 's');
    q += searchClause(opts, params, ['p.name', 's.memo', 'pt.name']);
    res.json(await runList(pool, q, params, ' ORDER BY s.sale_date DESC, s.id DESC', opts));
  } catch (err) {
    console.error('Sales error:', err);
    res.status(500).json({ ok: false, message: err.message || '매출정보를 불러오지 못했습니다.' });
  }
});

// 거래명세서 (T-105) — 한 거래처·기간의 매출을 명세서 형태로 돌려준다.
// 쿼리: partner_id(필수), from_date·to_date(또는 from·to, 하루만이면 date). 기간이 없으면 오늘 하루.
// 본인(토큰 사용자) 거래처만 — 남의 거래처·없는 거래처는 같은 403(존재 여부를 알려 주지 않음).
// 미수 = 총액 − 반품액 − 수금 (반품 규칙 B, 원장·거래처 탭과 같은 식 — T-219 R-07). 반품액 = 현금 환불 + 미수 차감.
// 항목의 refunded_amount 는 현금으로 돌려준 돈(참고), returned_amount 는 매출에서 뺀 반품액.
app.get('/api/sales/statement', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const partnerId = parseInt(req.query.partner_id, 10);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return res.status(400).json({ ok: false, message: '거래처를 선택하세요.' });
  }
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  const day = String(req.query.date || '').trim();
  const from = String(req.query.from_date || req.query.from || day || kstToday()).trim();
  const to = String(req.query.to_date || req.query.to || day || from).trim();
  if (!ymd.test(from) || !ymd.test(to)) {
    return res.status(400).json({ ok: false, message: '기간은 YYYY-MM-DD 형식으로 입력하세요.' });
  }
  if (from > to) return res.status(400).json({ ok: false, message: '시작일이 종료일보다 늦습니다.' });
  try {
    const pr = await pool.query(
      'SELECT id, name, type, contact, phone, location, address FROM account WHERE id = $1 AND user_id = $2',
      [partnerId, userId]
    );
    const partner = pr.rows[0];
    if (!partner) return res.status(403).json({ ok: false, message: '이 거래처의 거래명세서를 볼 수 없습니다.' });
    const ur = await pool.query('SELECT name, agent_no, phone, email FROM "user" WHERE id = $1', [userId]);
    const items = await pool.query(
      // sale_date 는 문자열(YYYY-MM-DD)로 — DATE 를 JS Date 로 받으면 서버 시간대(KST)에서 JSON(UTC)으로 바뀌며 하루 앞당겨 보인다
      `SELECT s.id, s.sale_date::text AS sale_date, s.created_at, s.quantity, s.unit_price, s.total_amount,
              s.paid_amount, s.payment_status, s.status, s.memo, s.returned_amount,
              GREATEST(s.total_amount - s.returned_amount - s.paid_amount, 0)::numeric AS unpaid_amount,
              p.name AS product_name, p.unit,
              COALESCE((SELECT SUM(r.quantity) FROM refund r WHERE r.sale_id = s.id), 0)::numeric AS refunded_qty,
              COALESCE((SELECT SUM(r.refund_amount) FROM refund r WHERE r.sale_id = s.id), 0)::numeric AS refunded_amount
       FROM sale s
       JOIN product p ON p.id = s.product_id
       WHERE s.user_id = $1 AND s.partner_id = $2 AND s.sale_date BETWEEN $3 AND $4
         AND s.status <> 'cancelled'
       ORDER BY s.sale_date, s.created_at NULLS LAST, s.id`,
      [userId, partnerId, from, to]
    );
    // 합계는 DB NUMERIC 으로 계산해 소수 오차 없이 돌려준다
    const tot = await pool.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(SUM(s.total_amount), 0)::numeric AS total_amount,
              COALESCE(SUM(s.paid_amount), 0)::numeric AS paid_amount,
              COALESCE(SUM(s.returned_amount), 0)::numeric AS returned_amount,
              COALESCE(SUM(GREATEST(s.total_amount - s.returned_amount - s.paid_amount, 0)), 0)::numeric AS unpaid_amount
       FROM sale s
       WHERE s.user_id = $1 AND s.partner_id = $2 AND s.sale_date BETWEEN $3 AND $4
         AND s.status <> 'cancelled'`,
      [userId, partnerId, from, to]
    );
    res.json({
      ok: true,
      data: {
        supplier: ur.rows[0] || null,
        partner,
        from_date: from,
        to_date: to,
        issued_on: kstToday(),
        items: items.rows,
        totals: tot.rows[0],
      },
    });
  } catch (err) {
    console.error('Statement error:', err);
    res.status(500).json({ ok: false, message: err.message || '거래명세서를 불러오지 못했습니다.' });
  }
});

// 일별 매입·매출 집계 (기간 필수, 거래처 선택 시 매입=구입처·매출=판매처 기준)
// T-202 원가·이익: 원가 = 그날 매출에 배분된 매입(purchase_allocation 수량 × 해당 매입 단가) 합. 조회 계산만(저장값 변경 없음).
//   배분이 없는 매출(이전 데이터 등)은 원가를 알 수 없어 cost_missing_count 로 세고 이익 계산(costed_sales_amount)에서 뺀다.
//   환불은 sale.total_amount·배분을 바꾸지 않으므로 매출액과 같은 기준(환불 차감 없음)으로 둔다 — T-103·T-108 결정 뒤 다시 본다.
app.get('/api/reports/daily-purchase-sales', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = String(req.query.from_date ?? '').trim();
  const to = String(req.query.to_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ ok: false, message: 'from_date, to_date(YYYY-MM-DD)가 필요합니다.' });
  }
  if (from > to) {
    return res.status(400).json({ ok: false, message: '시작일이 종료일보다 늦을 수 없습니다.' });
  }
  const partnerRaw = req.query.partner_id;
  const partnerId = partnerRaw !== undefined && partnerRaw !== '' ? parseInt(partnerRaw, 10) : null;
  const pid = partnerId && Number.isFinite(partnerId) ? partnerId : null;
  try {
    const r = await pool.query(
      `WITH days AS (
         SELECT generate_series($2::date, $3::date, '1 day'::interval)::date AS d
       ),
       p AS (
         SELECT pu.purchase_date::date AS d,
                COALESCE(SUM(pu.total_amount), 0)::numeric AS purchase_amount,
                COUNT(*)::int AS purchase_count
         FROM purchase pu
         WHERE pu.user_id = $1
           AND pu.purchase_date >= $2::date AND pu.purchase_date <= $3::date
           AND pu.status = 'active' -- 취소된 매입 제외 (T-103)
           AND ($4::int IS NULL OR pu.partner_id = $4)
         GROUP BY pu.purchase_date::date
       ),
       s AS (
         SELECT sa.sale_date::date AS d,
                COALESCE(SUM(sa.total_amount), 0)::numeric AS sales_amount,
                COUNT(*)::int AS sales_count
         FROM sale sa
         WHERE sa.user_id = $1
           AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date
           AND sa.status NOT IN ('cancelled')
           AND ($4::int IS NULL OR sa.partner_id = $4)
         GROUP BY sa.sale_date::date
       ),
       alc AS (
         SELECT pa.sale_id, ROUND(SUM(pa.quantity * pu.unit_price), 2) AS cost
         FROM purchase_allocation pa
         JOIN purchase pu ON pu.id = pa.purchase_id AND pu.user_id = pa.user_id
         WHERE pa.user_id = $1
           AND pa.sale_id IN (
             SELECT sa.id FROM sale sa
             WHERE sa.user_id = $1 AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date
           )
         GROUP BY pa.sale_id
       ),
       c AS (
         SELECT sa.sale_date::date AS d,
                COALESCE(SUM(alc.cost), 0)::numeric AS cost_amount,
                COALESCE(SUM(sa.total_amount) FILTER (WHERE alc.sale_id IS NOT NULL), 0)::numeric AS costed_sales_amount,
                COUNT(*) FILTER (WHERE alc.sale_id IS NULL)::int AS cost_missing_count
         FROM sale sa
         LEFT JOIN alc ON alc.sale_id = sa.id
         WHERE sa.user_id = $1
           AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date
           AND sa.status NOT IN ('cancelled')
           AND ($4::int IS NULL OR sa.partner_id = $4)
         GROUP BY sa.sale_date::date
       )
       SELECT days.d AS date,
              COALESCE(p.purchase_amount, 0)::numeric AS purchase_amount,
              COALESCE(p.purchase_count, 0)::int AS purchase_count,
              COALESCE(s.sales_amount, 0)::numeric AS sales_amount,
              COALESCE(s.sales_count, 0)::int AS sales_count,
              COALESCE(c.cost_amount, 0)::numeric AS cost_amount,
              COALESCE(c.costed_sales_amount, 0)::numeric AS costed_sales_amount,
              (COALESCE(c.costed_sales_amount, 0) - COALESCE(c.cost_amount, 0))::numeric AS profit_amount,
              COALESCE(c.cost_missing_count, 0)::int AS cost_missing_count
       FROM days
       LEFT JOIN p ON p.d = days.d
       LEFT JOIN s ON s.d = days.d
       LEFT JOIN c ON c.d = days.d
       ORDER BY days.d`,
      [userId, from, to, pid]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('daily-purchase-sales error:', err);
    res.status(500).json({ ok: false, message: err.message || '일별 집계를 불러오지 못했습니다.' });
  }
});

// 일별 매입·매출 — 상품 × 거래처(구입처/판매처)별 건수·수량·금액·미수(매출만)
// T-202: 매출 행에 원가(cost_sum)·이익(profit_sum)·원가 미확인 건수 추가 — 요약 API와 같은 계산(배분 매입 단가 기준, 조회만)
app.get('/api/reports/daily-purchase-sales-breakdown', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = String(req.query.from_date ?? '').trim();
  const to = String(req.query.to_date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ ok: false, message: 'from_date, to_date(YYYY-MM-DD)가 필요합니다.' });
  }
  if (from > to) {
    return res.status(400).json({ ok: false, message: '시작일이 종료일보다 늦을 수 없습니다.' });
  }
  const partnerRaw = req.query.partner_id;
  const partnerId = partnerRaw !== undefined && partnerRaw !== '' ? parseInt(partnerRaw, 10) : null;
  const pid = partnerId && Number.isFinite(partnerId) ? partnerId : null;
  try {
    const r = await pool.query(
      `SELECT * FROM (
         SELECT pr.id AS product_id,
                pr.name AS product_name,
                ac.id AS partner_id,
                ac.name AS partner_name,
                'purchase'::text AS line_kind,
                COUNT(*)::int AS line_count,
                COALESCE(SUM(pu.quantity), 0)::numeric AS qty_sum,
                COALESCE(SUM(pu.total_amount), 0)::numeric AS amount_sum,
                0::numeric AS receivable_sum,
                NULL::numeric AS cost_sum,
                NULL::numeric AS profit_sum,
                0::int AS cost_missing_count
         FROM purchase pu
         JOIN product pr ON pr.id = pu.product_id
         JOIN account ac ON ac.id = pu.partner_id
         WHERE pu.user_id = $1
           AND pu.purchase_date >= $2::date AND pu.purchase_date <= $3::date
           AND pu.status = 'active' -- 취소된 매입 제외 (T-103)
           AND ($4::int IS NULL OR ac.id = $4)
         GROUP BY pr.id, pr.name, ac.id, ac.name
         UNION ALL
         SELECT pr.id,
                pr.name,
                ac.id,
                ac.name,
                'sale'::text,
                COUNT(*)::int,
                COALESCE(SUM(sa.quantity), 0)::numeric,
                COALESCE(SUM(sa.total_amount), 0)::numeric,
                COALESCE(SUM(GREATEST(sa.total_amount - sa.returned_amount - sa.paid_amount, 0)), 0)::numeric, -- 미수 = 순매출 − 수금 (T-108 B)
                COALESCE(SUM(alc.cost), 0)::numeric,
                (COALESCE(SUM(sa.total_amount) FILTER (WHERE alc.sale_id IS NOT NULL), 0) - COALESCE(SUM(alc.cost), 0))::numeric,
                COUNT(*) FILTER (WHERE alc.sale_id IS NULL)::int
         FROM sale sa
         JOIN product pr ON pr.id = sa.product_id
         JOIN account ac ON ac.id = sa.partner_id
         LEFT JOIN LATERAL (
           SELECT pa.sale_id, ROUND(SUM(pa.quantity * pu2.unit_price), 2) AS cost
           FROM purchase_allocation pa
           JOIN purchase pu2 ON pu2.id = pa.purchase_id AND pu2.user_id = pa.user_id
           WHERE pa.sale_id = sa.id AND pa.user_id = $1
           GROUP BY pa.sale_id
         ) alc ON true
         WHERE sa.user_id = $1
           AND sa.sale_date >= $2::date AND sa.sale_date <= $3::date
           AND sa.status NOT IN ('cancelled')
           AND ($4::int IS NULL OR ac.id = $4)
         GROUP BY pr.id, pr.name, ac.id, ac.name
       ) sub
       ORDER BY product_name ASC, line_kind ASC, partner_name ASC`,
      [userId, from, to, pid]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('daily-purchase-sales-breakdown error:', err);
    res.status(500).json({ ok: false, message: err.message || '상세 집계를 불러오지 못했습니다.' });
  }
});

// 수금정보 (중매인 번호 기준, 기간·거래처별 검색)
app.get('/api/payments', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = req.query.from_date || '';
  const to = req.query.to_date || '';
  const partnerId = req.query.partner_id ? parseInt(req.query.partner_id, 10) : null;
  const createdBy = readCreatedBy(req.query, res); // T-213 입력자 필터
  if (createdBy === false) return undefined;
  const opts = parseListOptions(req.query); // T-211: q(메모·거래처), limit·offset
  if (opts.error) return res.status(400).json(opts.error);
  try {
    let q = `SELECT py.id, py.paid_at, py.created_at, py.amount, py.entry_kind, py.memo, pt.name AS partner_name,
             py.created_by_staff_id, ${CREATED_BY_NAME}
             FROM payment py
             JOIN account pt ON pt.id = py.partner_id
             LEFT JOIN staff_account cs ON cs.id = py.created_by_staff_id AND cs.owner_user_id = py.user_id
             WHERE py.user_id = $1`;
    const params = [userId];
    // 수금일시는 timestamptz — 날짜 필터는 DB 세션 시간대(Neon 기본 UTC)와 상관없이 한국 날짜 기준 (D-05)
    // 범위 비교라 (user_id, paid_at) 인덱스도 쓴다
    if (from) { params.push(from); q += ` AND py.paid_at >= ($${params.length}::date::timestamp AT TIME ZONE 'Asia/Seoul')`; }
    if (to) { params.push(to); q += ` AND py.paid_at < (($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')`; }
    if (partnerId && Number.isFinite(partnerId)) { params.push(partnerId); q += ` AND py.partner_id = $${params.length}`; }
    q += createdByClause(createdBy, params, 'py');
    q += searchClause(opts, params, ['py.memo', 'pt.name']);
    res.json(await runList(pool, q, params, ' ORDER BY py.paid_at DESC, py.id DESC', opts));
  } catch (err) {
    console.error('Payments error:', err);
    res.status(500).json({ ok: false, message: err.message || '수금정보를 불러오지 못했습니다.' });
  }
});

// ---------- 거래 흐름: 매입·매출 전환·수금·환불·폐기 ----------
const PURCHASE_PARTNER_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market']);
const SALE_PARTNER_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);

function accountLocationLine(row) {
  if (!row) return '';
  const name = row.name != null ? String(row.name).trim() : '';
  const loc = row.location != null ? String(row.location).trim() : '';
  if (loc && name) return `${name} · ${loc}`;
  return loc || name || '';
}

async function getUserWarehouseLabel(client, userId) {
  const u = await client.query(`SELECT name, agent_no FROM "user" WHERE id = $1`, [userId]);
  const r = u.rows[0];
  if (!r) return '내 창고';
  return `${r.name} (중매 ${r.agent_no})`;
}

// 미수 상태 — 반품 규칙 B(T-108): 받을 돈 = 순매출(총액 − 반품액). 반품으로 순매출이 줄면 미수도 같이 줄어든다(T-111 가짜 미수 방지)
async function syncSalePaymentStatus(client, saleId) {
  await client.query(
    `UPDATE sale SET payment_status =
      CASE
        WHEN paid_amount >= total_amount - returned_amount THEN 'paid'::payment_status
        WHEN paid_amount > 0 THEN 'partial'::payment_status
        ELSE 'unpaid'::payment_status
      END,
      updated_at = NOW()
     WHERE id = $1`,
    [saleId]
  );
}

// 재고 증감 — 계산은 DB(NUMERIC)에서 한 문장으로 한다 (2026-11-20 DB 점검 D-01)
// - 증가: INSERT … ON CONFLICT 로 "재고 행이 아직 없는 상품"에 동시 매입이 와도 중복 키 오류가 나지 않음
// - 감소: 조건부 UPDATE 로 남은 재고가 모자라면 0행 → 재고 부족 (JS 부동소수 계산 없음)
async function upsertInventoryDelta(client, userId, productId, delta) {
  const d = String(delta);
  if (Number(d) > 0) {
    await client.query(
      `INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1, $2, $3::numeric)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = inventory.quantity + EXCLUDED.quantity, updated_at = NOW()`,
      [userId, productId, d]
    );
    return;
  }
  const r = await client.query(
    `UPDATE inventory SET quantity = quantity + $3::numeric, updated_at = NOW()
     WHERE user_id = $1 AND product_id = $2 AND quantity + $3::numeric >= 0`,
    [userId, productId, d]
  );
  if (r.rowCount === 0) {
    const e = new Error('재고가 부족합니다.');
    e.code = 'NEGATIVE_INVENTORY';
    throw e;
  }
}

// 수량(소수 3자리)·단가(2자리)를 컬럼과 같은 자릿수로 맞추고, 금액은 맞춘 값으로 DB에서 계산 (D-03)
// 반환: { qty, price, total } — qty·total 은 NUMERIC 문자열(그대로 SQL에 넘김), 응답에는 Number(total)
async function roundQtyPrice(client, quantity, unitPrice) {
  const r = await client.query(
    `SELECT ROUND($1::numeric, 3) AS qty, ROUND($2::numeric, 2) AS price,
            ROUND(ROUND($1::numeric, 3) * ROUND($2::numeric, 2), 2) AS total`,
    [String(quantity), String(unitPrice)]
  );
  return r.rows[0];
}

// 오늘 날짜(한국 시간) — 서버가 UTC로 돌아도 00~09시에 어제 날짜가 되지 않게 (D-06)
function kstToday() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function insertTransfer(client, row) {
  await client.query(
    `INSERT INTO product_transfer (
       user_id, product_id, quantity, action_type, from_type, to_type,
       from_partner_id, to_partner_id, before_location, after_location,
       transferred_at, purchase_id, sale_id, disposal_id, refund_id, memo
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, NOW()), $12,$13,$14,$15,$16)`,
    [
      row.userId,
      row.productId,
      row.quantity,
      row.actionType,
      row.fromType,
      row.toType,
      row.fromPartnerId ?? null,
      row.toPartnerId ?? null,
      row.beforeLocation ?? null,
      row.afterLocation ?? null,
      row.transferredAt ?? null,
      row.purchaseId ?? null,
      row.saleId ?? null,
      row.disposalId ?? null,
      row.refundId ?? null,
      row.memo ?? null,
    ]
  );
}

// 매입 등록 (입고 + 재고 증가 + 이동 이력)
app.post('/api/purchases', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const { partner_id, product_id, quantity, unit_price, purchase_date, memo, source_name } = req.body || {};
  const pid = parseInt(partner_id, 10);
  const prid = parseInt(product_id, 10);
  const qty = Number(quantity);
  const up = Number(unit_price);
  if (!Number.isFinite(pid) || !Number.isFinite(prid) || !(qty > 0) || !(up >= 0) || !purchase_date) {
    return res.status(400).json({ ok: false, message: '거래처·상품·수량·단가·매입일을 올바르게 입력하세요.' });
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    const n = await roundQtyPrice(client, quantity, unit_price);
    if (!(Number(n.qty) > 0)) {
      return res.status(400).json({ ok: false, message: '거래처·상품·수량·단가·매입일을 올바르게 입력하세요.' });
    }
    const total = Number(n.total);
    await client.query('BEGIN');
    const acc = await client.query(`SELECT id, type, name, location, address FROM account WHERE id = $1 AND user_id = $2`, [pid, userId]);
    const a = acc.rows[0];
    if (!a || !PURCHASE_PARTNER_TYPES.has(a.type)) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ ok: false, message: '매입 가능한 거래처(공급/도매 등)를 선택하세요.' });
    }
    // 공용 품목 또는 내 개인 품목만 (T-216) — 남의 개인 품목은 "없음"과 같게
    const pr = await client.query(`SELECT id FROM product WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2)`, [prid, userId]);
    if (!pr.rows[0]) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ ok: false, message: '상품을 찾을 수 없습니다.' });
    }
    const src = source_name != null && String(source_name).trim() ? String(source_name).trim().slice(0, 200) : null;
    const ins = await client.query(
      `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo, source_name, payment_status, created_by_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6::numeric <= 0 THEN 'paid'::payment_status ELSE 'unpaid'::payment_status END, $10)
       RETURNING id`,
      [userId, pid, prid, n.qty, n.price, n.total, String(purchase_date).slice(0, 10), memo?.trim() || null, src, staffIdOf(req)]
    );
    const purchaseId = ins.rows[0].id;
    await upsertInventoryDelta(client, userId, prid, n.qty);
    const wh = await getUserWarehouseLabel(client, userId);
    await insertTransfer(client, {
      userId,
      productId: prid,
      quantity: n.qty,
      actionType: 'purchase',
      fromType: 'supplier',
      toType: 'inventory',
      fromPartnerId: pid,
      toPartnerId: null,
      beforeLocation: accountLocationLine(a),
      afterLocation: wh,
      purchaseId,
      memo: memo?.trim() || null,
    });
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: { id: purchaseId, total_amount: total } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST purchases error:', err);
    if (err.code === 'NEGATIVE_INVENTORY') {
      return res.status(400).json({ ok: false, message: err.message });
    }
    res.status(500).json({ ok: false, message: err.message || '매입 등록에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// 매입 → 매출 전환 (배분 + 재고 감소 + 매출·이동)
app.post('/api/purchases/convert-to-sales', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (items.length === 0) return res.status(400).json({ ok: false, message: '전환할 매입 행을 입력하세요.' });
  const client = await connectOr503(res);
  if (!client) return;
  const created = [];
  // 입력·소유 오류는 4xx 로 돌려준다 (T-114, DEF-T112-03 — 예전에는 남의 매입 ID·판매처도 500 이었다)
  const reqError = (status, message) => Object.assign(new Error(message), { httpStatus: status });
  try {
    await client.query('BEGIN');
    const wh = await getUserWarehouseLabel(client, userId);
    // 교착 방지 (D-11): 이 요청이 건드릴 매입 행과 재고 행을 처음에 id 순서로 한꺼번에 잠근다.
    // 여러 요청이 행 순서를 서로 반대로 보내도 잠그는 순서가 같아 deadlock 이 나지 않는다. (응답 순서는 요청 순서 그대로)
    const lockIds = [...new Set(items.map((it) => parseInt(it.purchase_id, 10)).filter(Number.isFinite))];
    if (lockIds.length) {
      await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`, [userId, lockIds]);
      await client.query(
        `SELECT product_id FROM inventory
         WHERE user_id = $1 AND product_id IN (SELECT product_id FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]))
         ORDER BY product_id FOR UPDATE`,
        [userId, lockIds]
      );
    }
    // T-207 외상 한도: 저장 전 미수를 기억해 두고, COMMIT 직전에 넘었는지 본다(lib/credit-limit.js)
    const creditPrev = await credit.creditBefore(client, userId, items.map((it) => parseInt(it.partner_id, 10)));
    for (const it of items) {
      const purchaseId = parseInt(it.purchase_id, 10);
      const custId = parseInt(it.partner_id, 10);
      const qtyIn = Number(it.quantity);
      const upIn = Number(it.unit_price);
      const saleDate = it.sale_date;
      const smemo = it.memo?.trim() || null;
      if (!Number.isFinite(purchaseId) || !Number.isFinite(custId) || !(qtyIn > 0) || !(upIn >= 0) || !saleDate) {
        throw reqError(400, '각 행에 매입 ID, 판매처, 수량, 단가, 판매일이 필요합니다.');
      }
      const n = await roundQtyPrice(client, it.quantity, it.unit_price);
      const qty = Number(n.qty);
      if (!(qty > 0)) throw reqError(400, '각 행에 매입 ID, 판매처, 수량, 단가, 판매일이 필요합니다.');
      const pu = await client.query(
        `SELECT id, partner_id, product_id, quantity, status FROM purchase WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [purchaseId, userId]
      );
      const p = pu.rows[0];
      // 남의 매입 ID 도 '없음'과 같은 404 — 다른 회원 매입의 존재를 알려 주지 않는다
      if (!p) throw reqError(404, `매입 ${purchaseId} 를 찾을 수 없습니다.`);
      if (p.status === 'cancelled') throw reqError(400, `매입 ${purchaseId} 는 취소된 매입이라 전환할 수 없습니다.`); // T-103 AC-03
      const al = await client.query(`SELECT COALESCE(SUM(quantity),0) AS s FROM purchase_allocation WHERE purchase_id = $1`, [purchaseId]);
      const allocated = Number(al.rows[0].s);
      const remaining = Number(p.quantity) - allocated;
      if (qty > remaining + 1e-9) throw reqError(400, `매입 ${purchaseId} 의 남은 수량(${remaining})보다 많게 판매할 수 없습니다.`);

      const cust = await client.query(`SELECT id, type, name, location, address FROM account WHERE id = $1 AND user_id = $2`, [custId, userId]);
      const c = cust.rows[0];
      if (!c) throw reqError(404, '판매처를 찾을 수 없습니다.');
      if (!SALE_PARTNER_TYPES.has(c.type)) throw reqError(400, '판매 가능한 거래처를 선택하세요.');

      await upsertInventoryDelta(client, userId, p.product_id, `-${n.qty}`);

      const saleIns = await client.query(
        `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date, payment_status, paid_amount, status, memo, created_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'unpaid',0,'active',$8,$9)
         RETURNING id`,
        [userId, custId, p.product_id, n.qty, n.price, n.total, String(saleDate).slice(0, 10), smemo, staffIdOf(req)]
      );
      const saleId = saleIns.rows[0].id;
      await client.query(
        `INSERT INTO purchase_allocation (user_id, purchase_id, sale_id, quantity) VALUES ($1,$2,$3,$4)`,
        [userId, purchaseId, saleId, n.qty]
      );
      await insertTransfer(client, {
        userId,
        productId: p.product_id,
        quantity: n.qty,
        actionType: 'sale',
        fromType: 'inventory',
        toType: 'customer',
        fromPartnerId: null,
        toPartnerId: custId,
        beforeLocation: wh,
        afterLocation: accountLocationLine(c),
        saleId,
        purchaseId,
        memo: smemo,
      });
      created.push({ sale_id: saleId, purchase_id: purchaseId });
    }
    const creditWarnings = await credit.assertCreditOrConfirmed(client, userId, creditPrev, req.body);
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: created, ...(creditWarnings.length ? { credit_warnings: creditWarnings } : {}) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 외상 한도 초과(T-207) — 저장하지 않고 경고 내용을 돌려준다. credit_confirmed=true 로 다시 보내면 저장
    if (err.corrCode === 'CREDIT_LIMIT') return res.status(409).json({ ok: false, code: err.corrCode, message: err.message, detail: err.detail });
    const code = err.httpStatus || (err.code === 'NEGATIVE_INVENTORY' ? 400 : 500);
    if (code >= 500) console.error('convert-to-sales error:', err);
    // 500 은 DB 오류 문구를 그대로 내보내지 않는다
    const msg = code >= 500 ? '매출 전환에 실패했습니다.' : err.message || '매출 전환에 실패했습니다.';
    res.status(code).json({ ok: false, message: msg });
  } finally {
    client.release();
  }
});

// 재고 기준 판매(선입선출) (T-205) — lib/fifo-routes.js. 위 함수·상수(SALE_PARTNER_TYPES 등)가 정의된 뒤에 등록한다
const fifo = require('./lib/fifo-routes');
fifo.registerFifoRoutes(app, {
  pool, getUserId, kstToday, connectOr503, upsertInventoryDelta, insertTransfer,
  getUserWarehouseLabel, accountLocationLine, SALE_PARTNER_TYPES,
});

/** 입력 검증 실패 — 400으로 응답하기 위한 오류 */
function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

// 수금 등록 (배분 + 매출 paid 갱신)
app.post('/api/payments', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const { partner_id, amount, paid_at, memo, allocations, entry_kind } = req.body || {};
  const kind = entry_kind === 'refund' ? 'refund' : 'receive';
  const pid = parseInt(partner_id, 10);
  const amt = Number(amount);
  const paidAt = parsePaidAtInput(paid_at);
  const allocs = Array.isArray(allocations) ? allocations : [];
  if (!Number.isFinite(pid) || !(amt > 0) || !paidAt) {
    return res.status(400).json({ ok: false, message: '거래처·금액·수금일시를 입력하세요.' });
  }
  if (kind === 'receive' && allocs.length === 0) {
    return res.status(400).json({ ok: false, message: '수금 배분(매출별 금액)을 입력하세요.' });
  }
  let sumAlloc = 0;
  for (const a of allocs) {
    sumAlloc += Number(a.amount);
  }
  if (kind === 'receive' && Math.abs(sumAlloc - amt) > 0.01) {
    return res.status(400).json({ ok: false, message: `배분 합계(${sumAlloc})가 수금액(${amt})과 일치해야 합니다.` });
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    await client.query('BEGIN');
    const acc = await client.query(`SELECT id, type FROM account WHERE id = $1 AND user_id = $2`, [pid, userId]);
    if (!acc.rows[0]) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ ok: false, message: '거래처를 찾을 수 없습니다.' });
    }
    const payIns = await client.query(
      `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo, created_by_staff_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [userId, pid, amt, paidAt, kind, memo?.trim() || null, staffIdOf(req)]
    );
    const paymentId = payIns.rows[0].id;
    if (kind === 'receive') {
      for (const a of allocs) {
        const sid = parseInt(a.sale_id, 10);
        const al = Number(a.amount);
        if (!Number.isFinite(sid) || !(al > 0)) {
          throw badRequest('배분 행에 매출 ID와 금액이 필요합니다.');
        }
        const s = await client.query(
          `SELECT id, partner_id, total_amount, returned_amount, paid_amount, status FROM sale WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [sid, userId]
        );
        const sale = s.rows[0];
        if (!sale || sale.partner_id !== pid) throw badRequest(`매출 ${sid} 는 선택한 거래처와 맞지 않습니다.`);
        // 수금은 미수 매출에만, 남은 미수까지만 배분한다 (매뉴얼 4.2 · D-02) — 화면(Main.jsx)·DB CHECK(009·010)와 같은 규칙
        // 취소 매출만 막는다. 전량 반품(refunded)이라도 미수가 남았으면 받을 수 있다(T-219 R-06) — 미수 0이면 아래 금액 검사가 막는다
        if (sale.status === 'cancelled') {
          throw badRequest(`매출 ${sid} 는 취소된 매출이라 수금을 배분할 수 없습니다.`);
        }
        // 남은 미수 = 총액 − 반품액 − 받은 돈 (반품 규칙 B, T-108)
        const dueCents = Math.round(Number(sale.total_amount) * 100)
          - Math.round(Number(sale.returned_amount || 0) * 100)
          - Math.round(Number(sale.paid_amount) * 100);
        if (Math.round(al * 100) > dueCents) {
          throw badRequest(`매출 ${sid} 의 남은 미수(${(dueCents / 100).toLocaleString('ko-KR')})보다 많이 배분할 수 없습니다.`);
        }
        await client.query(`UPDATE sale SET paid_amount = paid_amount + $1, updated_at = NOW() WHERE id = $2`, [al, sid]);
        await syncSalePaymentStatus(client, sid);
        await client.query(`INSERT INTO payment_allocation (payment_id, sale_id, amount) VALUES ($1,$2,$3)`, [paymentId, sid, al]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: { id: paymentId } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST payments error:', err);
    if (!err.statusCode && sendDataNeedsFix(res, err)) return;
    res.status(err.statusCode || 500).json({ ok: false, message: err.message || '수금 등록에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// 환불(반품) — 반품 규칙 B (T-108 사용자 결정, T-111): "반품 = 미수 먼저 차감, 넘친 돈만 환불"
//   반품 금액 V: 요청의 return_amount(0 ≤ V ≤ 순매출), 없으면 순매출 × (반품 수량 ÷ 반품 가능 수량), 남은 수량 전부면 남은 순매출 전부
//   미수 차감 credit = MIN(V, 반품 전 미수),  현금 환불 = V − credit  (받은 돈보다 많이 돌려주지 않음 — R-01)
//   sale.returned_amount += V, sale.paid_amount −= 현금 환불, 현금 환불이 있을 때만 payment(entry_kind=refund) 기록 (외상 반품에 환불금 기록 안 함 — R2·U3)
//   요청의 refund_amount(이전 화면이 보내던 값)는 계산에 쓰지 않는다 — 환불금은 서버가 위 규칙으로 정하고 응답에 돌려준다.
app.post('/api/sales/:saleId/refund', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const saleId = parseInt(req.params.saleId, 10);
  if (!Number.isFinite(saleId)) return res.status(400).json({ ok: false, message: '매출 ID가 올바르지 않습니다.' });
  const { quantity, return_amount, refunded_at, reason, memo } = req.body || {};
  const qty = Number(quantity);
  const va = return_amount != null && return_amount !== '' ? Number(return_amount) : null;
  const rAt = refunded_at ? String(refunded_at).slice(0, 10) : '';
  if (!(qty > 0) || !rAt) {
    return res.status(400).json({ ok: false, message: '반품 수량과 환불일을 입력하세요.' });
  }
  if (va != null && (!Number.isFinite(va) || va < 0)) {
    return res.status(400).json({ ok: false, message: '반품 금액이 올바르지 않습니다.' });
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    await client.query('BEGIN');
    const s = await client.query(
      `SELECT id, partner_id, product_id, quantity, status, total_amount, returned_amount, paid_amount
       FROM sale WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [saleId, userId]
    );
    const sale = s.rows[0];
    if (!sale) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(404).json({ ok: false, message: '매출을 찾을 수 없습니다.' });
    }
    if (sale.status === 'cancelled') {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ ok: false, message: '이미 취소된 매출입니다.' });
    }
    const rf = await client.query(`SELECT COALESCE(SUM(quantity),0) AS s FROM refund WHERE sale_id = $1`, [saleId]);
    const already = Number(rf.rows[0].s);
    const maxQty = Number(sale.quantity) - already;
    if (qty > maxQty + 1e-9) {
      await client.query('ROLLBACK').catch(() => {});
      return res.status(400).json({ ok: false, message: `환불 가능 수량은 최대 ${maxQty} 입니다.` });
    }
    // 금액은 원 단위 소수 2자리(센트)로 정수 계산
    const netCents = Math.round(Number(sale.total_amount) * 100) - Math.round(Number(sale.returned_amount || 0) * 100);
    const paidCents = Math.round(Number(sale.paid_amount) * 100);
    const dueCents = Math.max(0, netCents - paidCents);
    let vCents;
    if (va != null) {
      vCents = Math.round(va * 100);
      if (vCents > netCents) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(400).json({ ok: false, message: `반품 금액은 남은 매출액(${(netCents / 100).toLocaleString('ko-KR')})을 넘을 수 없습니다.` });
      }
      // F-3(T104-U-5 A안, T-219 R-06): 남은 수량을 모두 반품하면 남은 순매출 전부가 반품액이다.
      // 일부만 빼면 물건은 다 돌아왔는데 미수가 남아 "환불" 매출에 받을 돈이 생긴다 — 그런 손해 청구는 반품이 아니라 별도 매출로 처리
      if (qty >= maxQty - 1e-9 && vCents !== netCents) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(400).json({
          ok: false,
          code: 'FULL_RETURN_AMOUNT',
          message: `남은 수량을 모두 반품하면 반품 금액은 남은 매출액(${(netCents / 100).toLocaleString('ko-KR')}) 전부여야 합니다. 일부만 빼려면 수량을 줄이세요.`,
        });
      }
    } else if (qty >= maxQty - 1e-9) {
      vCents = netCents; // 남은 수량 전부 반품 → 남은 순매출 전부
    } else {
      vCents = Math.round((netCents * qty) / maxQty);
    }
    const creditCents = Math.min(vCents, dueCents);
    // 010 이전 데이터에 받은 돈 > 순매출인 매출이 있으면(010 확인 SQL ②) 그 초과분도 이번 환불에 함께 돌려줘 CHECK를 맞춘다
    const excessCents = Math.max(0, paidCents - netCents);
    const cashCents = vCents - creditCents + excessCents;
    const wh = await getUserWarehouseLabel(client, userId);
    const cust = await client.query(`SELECT id, name, location, address FROM account WHERE id = $1 AND user_id = $2`, [sale.partner_id, userId]);
    const c = cust.rows[0];
    await upsertInventoryDelta(client, userId, sale.product_id, qty);
    const refIns = await client.query(
      `INSERT INTO refund (user_id, sale_id, quantity, refund_amount, credit_amount, return_amount, reason, refunded_at, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      // return_amount = 반품액 V(원장 반품 행) — 현금 환불에는 이전 기록의 초과 수금 반환분이 더해질 수 있다(T-219 R-02)
      [userId, saleId, qty, (cashCents / 100).toFixed(2), (creditCents / 100).toFixed(2), (vCents / 100).toFixed(2), reason?.trim() || null, rAt, memo?.trim() || null]
    );
    const refundId = refIns.rows[0].id;
    await insertTransfer(client, {
      userId,
      productId: sale.product_id,
      quantity: qty,
      actionType: 'refund',
      fromType: 'customer',
      toType: 'inventory',
      fromPartnerId: sale.partner_id,
      toPartnerId: null,
      beforeLocation: accountLocationLine(c),
      afterLocation: wh,
      saleId,
      refundId,
      memo: reason?.trim() || null,
    });
    // 반품액만큼 순매출을 줄이고, 넘친 돈(현금 환불)만큼 받은 돈을 줄인다 — CHECK sale_paid_not_over_net(010)과 같은 규칙
    await client.query(
      // 초과분을 돌려주면 "돌려줄 돈"(overpaid_amount, 013)은 0이 된다 — 반품 뒤 받은 돈 ≤ 순매출
      `UPDATE sale SET returned_amount = returned_amount + $1::numeric, paid_amount = paid_amount - $2::numeric,
              overpaid_amount = 0, updated_at = NOW()
       WHERE id = $3`,
      [(vCents / 100).toFixed(2), (cashCents / 100).toFixed(2), saleId] // paid − cash ≥ 0: cash ≤ (V − credit) + 초과분 ≤ paid
    );
    if (cashCents > 0) {
      const refundPaidAt = parsePaidAtInput(rAt) || new Date();
      await client.query(
        `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo) VALUES ($1,$2,$3,$4,'refund',$5)`,
        [userId, sale.partner_id, (cashCents / 100).toFixed(2), refundPaidAt, `환불 #${refundId} ${reason || ''}`.trim().slice(0, 500)]
      );
    }
    await syncSalePaymentStatus(client, saleId);
    const newRefunded = already + qty;
    if (newRefunded >= Number(sale.quantity) - 1e-9) {
      await client.query(`UPDATE sale SET status = 'refunded', updated_at = NOW() WHERE id = $1`, [saleId]);
    }
    await client.query('COMMIT');
    res.status(201).json({
      ok: true,
      data: {
        refund_id: refundId,
        return_amount: vCents / 100, // 반품 금액(매출 차감)
        credit_amount: creditCents / 100, // 그중 미수에서 뺀 금액
        refund_amount: cashCents / 100, // 그중 현금으로 돌려준 금액(환불 지급 기록)
        unpaid_after: Math.max(0, netCents - vCents - (paidCents - cashCents)) / 100,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('refund error:', err);
    if (sendDataNeedsFix(res, err)) return;
    const code = err.code === 'NEGATIVE_INVENTORY' ? 400 : 500;
    res.status(code).json({ ok: false, message: err.message || '환불 처리에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// ======================================================================
// 매입·매출 정정 (T-103) — 설계: T-103_정정_설계.md 3장(경우별 허용·거절)·4장(역처리)·6장(API)·8장(잠금)
//   취소는 지우지 않고 status='cancelled' + 되돌리는 이동 이력 1건 + 정정 이력(trade_correction) 1건
//   잠금 순서(모든 거래 API 공통): purchase(id 오름차순) → sale(id 오름차순) → inventory(product_id 오름차순)
//   규칙 검사(수금·반품·전환 수량·재고)는 행을 잠근 뒤 다시 읽어 판정한다(8.2)
//   오류 응답: { ok:false, code, message, detail } — 기존 화면 호환을 위해 message 유지
// ======================================================================

/** 정정 API 오류 — httpStatus·code·detail 을 그대로 응답으로 보낸다 */
function corrError(httpStatus, code, message, detail) {
  return Object.assign(new Error(message), { httpStatus, corrCode: code, detail: detail ?? undefined });
}

/**
 * DB CHECK 위반(23514) — 이전 기록이 지금 규칙과 맞지 않을 때. 500 대신 409 로 이유를 알려 준다 (T-118 D-1, T-219 R-01)
 * 013 이후에는 받은 돈 > 순매출 매출도 고칠 수 있어 보통 생기지 않는다. 생기면 관리자가 확인 SQL 로 정리한다.
 */
function sendDataNeedsFix(res, err) {
  if (!err || err.code !== '23514') return false;
  console.error('[data-needs-fix]', err.constraint || '', err.message);
  res.status(409).json({
    ok: false,
    code: 'DATA_NEEDS_FIX',
    message: '이전 기록이 지금 규칙과 맞지 않아 처리할 수 없습니다. 관리자에게 정리를 요청하세요.',
    detail: err.constraint ? { constraint: err.constraint } : undefined,
  });
  return true;
}

function sendCorrError(res, err, fallbackMessage) {
  if (err && err.httpStatus) {
    const body = { ok: false, code: err.corrCode, message: err.message };
    if (err.detail !== undefined) body.detail = err.detail;
    return res.status(err.httpStatus).json(body);
  }
  if (err && err.code === 'NEGATIVE_INVENTORY') {
    return res.status(409).json({ ok: false, code: 'INVENTORY_SHORT', message: '재고가 부족해 되돌릴 수 없습니다.' });
  }
  if (sendDataNeedsFix(res, err)) return undefined;
  console.error(fallbackMessage, err);
  // 500 은 DB 오류 문구를 그대로 내보내지 않는다
  return res.status(500).json({ ok: false, message: fallbackMessage });
}

const CORRECTION_REASON_MAX = 200;

/** RULE-X2 사유 필수 (1~200자) */
function readCorrectionReason(body) {
  const r = body?.reason != null ? String(body.reason).trim() : '';
  if (!r) throw corrError(400, 'VALIDATION', '정정 사유를 입력하세요.', { field: 'reason' });
  if (r.length > CORRECTION_REASON_MAX) {
    throw corrError(400, 'VALIDATION', `정정 사유는 ${CORRECTION_REASON_MAX}자 이내로 입력하세요.`, { field: 'reason' });
  }
  return r;
}

/**
 * 화면이 본 시점 확인(8.3) — expected_updated_at 이 왔을 때만 비교한다.
 * pg 가 timestamptz 를 밀리초 Date 로 바꿔 응답하므로(F9) 밀리초 단위로 비교(1ms 미만 차이는 같은 값).
 * row.updated_epoch_ms 는 SELECT 에서 (EXTRACT(EPOCH FROM updated_at) * 1000) 으로 읽은 값.
 */
function assertNotStale(row, expected) {
  if (expected === undefined || expected === null || expected === '') return;
  const exp = Date.parse(String(expected));
  if (!Number.isFinite(exp)) throw corrError(400, 'VALIDATION', 'expected_updated_at 형식이 올바르지 않습니다.', { field: 'expected_updated_at' });
  const cur = row.updated_epoch_ms == null ? null : Number(row.updated_epoch_ms);
  if (cur == null || Math.abs(Math.floor(cur) - exp) >= 1) {
    throw corrError(409, 'STALE_DATA', '다른 곳에서 먼저 바뀌었습니다. 최신 내용으로 다시 불러온 뒤 시도하세요.', {
      current_updated_at: cur == null ? null : new Date(Math.floor(cur)).toISOString(),
    });
  }
}

async function insertCorrection(client, c) {
  await client.query(
    `INSERT INTO trade_correction (user_id, target_type, target_id, action, changed_fields, before_data, after_data, reason)
     VALUES ($1,$2,$3,$4,$5::text[],$6::jsonb,$7::jsonb,$8)`,
    [c.userId, c.targetType, c.targetId, c.action, c.changedFields, JSON.stringify(c.before), JSON.stringify(c.after), c.reason]
  );
}

/** 재고 행 잠금(product_id 오름차순) — 없으면 0 으로 본다. 반환: Map(product_id → 수량 문자열) */
async function lockInventoryRows(client, userId, productIds) {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  const r = await client.query(
    `SELECT product_id, quantity::text AS quantity FROM inventory
     WHERE user_id = $1 AND product_id = ANY($2::int[]) ORDER BY product_id FOR UPDATE`,
    [userId, ids]
  );
  const m = new Map(ids.map((id) => [id, '0']));
  r.rows.forEach((row) => m.set(row.product_id, row.quantity));
  return m;
}

/** RULE-X1 재고를 줄이는 정정 — 현재 재고 < 필요 수량이면 409 INVENTORY_SHORT (NUMERIC 비교는 DB에서) */
async function assertInventoryEnough(client, productId, invQty, needQty) {
  const r = await client.query(`SELECT $1::numeric >= $2::numeric AS ok`, [invQty, String(needQty)]);
  if (!r.rows[0].ok) {
    throw corrError(409, 'INVENTORY_SHORT', `현재 재고 ${Number(invQty)}(으)로 ${Number(needQty)}을(를) 되돌릴 수 없습니다. 폐기·매출 내역을 확인하세요.`, {
      product_id: productId,
      inventory_qty: Number(invQty),
      need_qty: Number(needQty),
    });
  }
}

const PURCHASE_ROW_SQL = `SELECT pu.id, pu.partner_id, pu.product_id, pu.purchase_date, pu.created_at, pu.quantity, pu.unit_price, pu.total_amount, pu.memo, pu.source_name,
       pu.status, pu.cancelled_at, pu.cancel_reason, pu.updated_at,
       pu.paid_amount, pu.payment_status,
       (CASE WHEN pu.status = 'active' THEN GREATEST(pu.total_amount - pu.paid_amount, 0) ELSE 0 END)::numeric AS unpaid_amount,
       p.name AS product_name, p.unit, pt.name AS partner_name,
       COALESCE((SELECT SUM(pa.quantity) FROM purchase_allocation pa WHERE pa.purchase_id = pu.id), 0)::numeric AS allocated_qty,
       (pu.quantity - COALESCE((SELECT SUM(pa.quantity) FROM purchase_allocation pa WHERE pa.purchase_id = pu.id), 0))::numeric AS remaining_qty
  FROM purchase pu
  JOIN product p ON p.id = pu.product_id
  JOIN account pt ON pt.id = pu.partner_id`;

const SALE_ROW_SQL = `SELECT s.id, s.partner_id, s.product_id, s.sale_date, s.created_at, s.quantity, s.unit_price, s.total_amount,
       s.payment_status, s.paid_amount, s.status, s.memo, s.returned_amount, s.overpaid_amount,
       s.cancelled_at, s.cancel_reason, s.updated_at, s.entry_mode,
       GREATEST(s.total_amount - s.returned_amount - s.paid_amount, 0)::numeric AS unpaid_amount,
       p.name AS product_name, p.unit, pt.name AS partner_name, pt.location AS partner_location,
       COALESCE((SELECT SUM(r.quantity) FROM refund r WHERE r.sale_id = s.id), 0)::numeric AS refunded_qty
  FROM sale s
  JOIN product p ON p.id = s.product_id
  JOIN account pt ON pt.id = s.partner_id`;

// 정정 이력에 남길 행 모양 — DATE 는 문자열(YYYY-MM-DD)로 남겨 시간대에 따라 하루 밀리지 않게
const PURCHASE_LOCK_SQL = `SELECT id, partner_id, product_id, quantity::text AS quantity, unit_price::text AS unit_price,
       total_amount::text AS total_amount, purchase_date::text AS purchase_date, memo, source_name, status,
       (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_epoch_ms
  FROM purchase WHERE id = $1 AND user_id = $2 FOR UPDATE`;
const SALE_LOCK_SQL = `SELECT id, partner_id, product_id, quantity::text AS quantity, unit_price::text AS unit_price,
       total_amount::text AS total_amount, sale_date::text AS sale_date, memo, status, payment_status,
       paid_amount::text AS paid_amount, returned_amount::text AS returned_amount,
       (EXTRACT(EPOCH FROM updated_at) * 1000)::float8 AS updated_epoch_ms
  FROM sale WHERE id = $1 AND user_id = $2 FOR UPDATE`;

function stripLockMeta(row) {
  const { updated_epoch_ms, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
}

function parseIdParam(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && String(n) === String(raw).trim() ? n : null;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidYmd(s) {
  if (!YMD_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 매입 상태 확인용 — 연결된(취소 안 된) 매출 목록 */
async function linkedSalesOfPurchase(client, userId, purchaseId) {
  const r = await client.query(
    `SELECT s.id, s.sale_date::text AS sale_date, pt.name AS partner_name, pa.quantity::numeric AS quantity,
            s.payment_status, s.status
     FROM purchase_allocation pa
     JOIN sale s ON s.id = pa.sale_id AND s.user_id = pa.user_id
     JOIN account pt ON pt.id = s.partner_id
     WHERE pa.purchase_id = $1 AND pa.user_id = $2
     ORDER BY s.sale_date, s.id`,
    [purchaseId, userId]
  );
  return r.rows.map((x) => ({ ...x, quantity: Number(x.quantity) }));
}

// ---------- 6.1 매입 취소 ----------
app.post('/api/purchases/:id/cancel', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const id = parseIdParam(req.params.id);
  let reason;
  try {
    if (!id) throw corrError(400, 'VALIDATION', '매입 ID가 올바르지 않습니다.', { field: 'id' });
    reason = readCorrectionReason(req.body);
  } catch (err) {
    return sendCorrError(res, err, '매입 취소에 실패했습니다.');
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    await client.query('BEGIN');
    const pr = await client.query(PURCHASE_LOCK_SQL, [id, userId]);
    const p = pr.rows[0];
    if (!p) throw corrError(404, 'NOT_FOUND', '매입을 찾을 수 없습니다.');
    if (p.status === 'cancelled') throw corrError(409, 'ALREADY_CANCELLED', '이미 취소된 매입입니다.');
    assertNotStale(p, req.body?.expected_updated_at);
    // RULE-P2·P3 — 전환된 수량이 있으면 매출 취소가 먼저
    const sales = await linkedSalesOfPurchase(client, userId, id);
    if (sales.length > 0) {
      throw corrError(409, 'PURCHASE_HAS_SALES', `연결된 매출 ${sales.length}건을 먼저 취소하세요.`, { sales });
    }
    // T-201 RULE-07 ① — 지급이 걸린 매입은 취소 불가(지급정보에서 지급을 먼저 취소)
    const paidNow = await client.query('SELECT paid_amount > 0 AS has_paid FROM purchase WHERE id = $1', [id]);
    if (paidNow.rows[0]?.has_paid) {
      const payments = await activePaymentsOfPurchase(client, userId, id);
      throw corrError(409, 'PURCHASE_HAS_PAYMENT', `지급 ${payments.length}건이 있어 취소할 수 없습니다. 지급정보에서 지급을 먼저 취소하세요.`, { payments });
    }
    // RULE-X1 — 재고는 상품 단위라 현재 재고로만 판단(F1·F4)
    const inv = await lockInventoryRows(client, userId, [p.product_id]);
    await assertInventoryEnough(client, p.product_id, inv.get(p.product_id), p.quantity);
    await upsertInventoryDelta(client, userId, p.product_id, `-${p.quantity}`);
    const up = await client.query(
      `UPDATE purchase SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1, updated_at = NOW()
       WHERE id = $2 RETURNING status, cancelled_at, cancel_reason`,
      [reason, id]
    );
    const wh = await getUserWarehouseLabel(client, userId);
    const acc = await client.query(`SELECT name, location FROM account WHERE id = $1 AND user_id = $2`, [p.partner_id, userId]);
    await insertTransfer(client, {
      userId,
      productId: p.product_id,
      quantity: p.quantity,
      actionType: 'purchase_cancel',
      fromType: 'inventory',
      toType: 'supplier',
      fromPartnerId: null,
      toPartnerId: p.partner_id,
      beforeLocation: wh,
      afterLocation: accountLocationLine(acc.rows[0]),
      purchaseId: id,
      memo: `매입 취소: ${reason}`.slice(0, 500),
    });
    await insertCorrection(client, {
      userId,
      targetType: 'purchase',
      targetId: id,
      action: 'cancel',
      changedFields: ['status'],
      before: stripLockMeta(p),
      after: { status: 'cancelled', cancelled_at: up.rows[0].cancelled_at, cancel_reason: reason },
      reason,
    });
    const invAfter = await client.query(`SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2`, [userId, p.product_id]);
    await client.query('COMMIT');
    res.json({
      ok: true,
      data: {
        id,
        status: 'cancelled',
        cancelled_at: up.rows[0].cancelled_at,
        inventory_qty_after: Number(invAfter.rows[0]?.quantity ?? 0),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendCorrError(res, err, '매입 취소에 실패했습니다.');
  } finally {
    client.release();
  }
});

const PURCHASE_EDITABLE = ['quantity', 'unit_price', 'partner_id', 'source_name', 'purchase_date', 'memo', 'product_id'];
const SALE_EDITABLE = ['quantity', 'unit_price', 'partner_id', 'sale_date', 'memo'];

/** changes 객체 확인 — 허용 칸만, 빈 객체는 400 */
function readChanges(body, allowed) {
  const ch = body?.changes;
  if (!ch || typeof ch !== 'object' || Array.isArray(ch)) {
    throw corrError(400, 'VALIDATION', '바꿀 내용(changes)을 입력하세요.', { field: 'changes' });
  }
  const keys = Object.keys(ch);
  if (keys.length === 0) throw corrError(400, 'VALIDATION', '바꿀 내용(changes)을 입력하세요.', { field: 'changes' });
  const bad = keys.find((k) => !allowed.includes(k));
  if (bad) {
    const msg = bad === 'product_id' ? '매출의 상품은 바꿀 수 없습니다. 매출을 취소한 뒤 다시 전환하세요.' : `바꿀 수 없는 칸입니다: ${bad}`;
    throw corrError(400, 'VALIDATION', msg, { field: bad });
  }
  return ch;
}

function readQty(v) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || !(n > 0)) throw corrError(400, 'VALIDATION', '수량은 0보다 커야 합니다.', { field: 'quantity' });
  return v;
}
function readPrice(v) {
  const n = Number(v);
  if (v === null || v === '' || !Number.isFinite(n) || n < 0) throw corrError(400, 'VALIDATION', '단가는 0 이상이어야 합니다.', { field: 'unit_price' });
  return v;
}
function readDate(v, field) {
  const s = String(v ?? '').trim();
  if (!isValidYmd(s)) throw corrError(400, 'VALIDATION', '날짜는 YYYY-MM-DD 형식으로 입력하세요.', { field });
  return s;
}
function readMemo(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function readIntField(v, field) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== String(v).trim()) throw corrError(400, 'VALIDATION', `${field} 값이 올바르지 않습니다.`, { field });
  return n;
}

// ---------- 6.2 매입 수정 ----------
app.patch('/api/purchases/:id', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const id = parseIdParam(req.params.id);
  let reason;
  let ch;
  try {
    if (!id) throw corrError(400, 'VALIDATION', '매입 ID가 올바르지 않습니다.', { field: 'id' });
    reason = readCorrectionReason(req.body);
    ch = readChanges(req.body, PURCHASE_EDITABLE);
  } catch (err) {
    return sendCorrError(res, err, '매입 수정에 실패했습니다.');
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    // 입력 형식 검사(잠그기 전)
    const want = {};
    if ('quantity' in ch) want.quantity = readQty(ch.quantity);
    if ('unit_price' in ch) want.unit_price = readPrice(ch.unit_price);
    if ('partner_id' in ch) want.partner_id = readIntField(ch.partner_id, 'partner_id');
    if ('product_id' in ch) want.product_id = readIntField(ch.product_id, 'product_id');
    if ('purchase_date' in ch) want.purchase_date = readDate(ch.purchase_date, 'purchase_date');
    if ('memo' in ch) want.memo = readMemo(ch.memo);
    if ('source_name' in ch) {
      const s = readMemo(ch.source_name);
      if (s && s.length > 200) throw corrError(400, 'VALIDATION', '출처는 200자 이내로 입력하세요.', { field: 'source_name' });
      want.source_name = s;
    }

    await client.query('BEGIN');
    const pr = await client.query(PURCHASE_LOCK_SQL, [id, userId]);
    const p = pr.rows[0];
    if (!p) throw corrError(404, 'NOT_FOUND', '매입을 찾을 수 없습니다.');
    if (p.status === 'cancelled') throw corrError(409, 'ALREADY_CANCELLED', '이미 취소된 매입입니다.');
    assertNotStale(p, req.body?.expected_updated_at);

    const al = await client.query(`SELECT COALESCE(SUM(quantity), 0)::text AS s FROM purchase_allocation WHERE purchase_id = $1`, [id]);
    const allocated = al.rows[0].s;
    const hasSales = Number(allocated) > 0;

    // 새 값 계산(수량·단가는 컬럼 자릿수로 반올림 — 등록과 같은 함수)
    const n = await roundQtyPrice(client, want.quantity ?? p.quantity, want.unit_price ?? p.unit_price);
    if (!(Number(n.qty) > 0)) throw corrError(400, 'VALIDATION', '수량은 0보다 커야 합니다.', { field: 'quantity' });
    const next = {
      quantity: n.qty,
      unit_price: n.price,
      total_amount: n.total,
      partner_id: want.partner_id ?? p.partner_id,
      product_id: want.product_id ?? p.product_id,
      purchase_date: want.purchase_date ?? p.purchase_date,
      memo: 'memo' in want ? want.memo : p.memo,
      source_name: 'source_name' in want ? want.source_name : p.source_name,
    };
    const cmp = await client.query(
      `SELECT $1::numeric <> $2::numeric AS qty_changed, $3::numeric <> $4::numeric AS price_changed,
              $5::numeric <> $6::numeric AS total_changed, ($1::numeric - $2::numeric)::text AS delta,
              $1::numeric < $7::numeric AS below_alloc`,
      [n.qty, p.quantity, n.price, p.unit_price, n.total, p.total_amount, allocated]
    );
    const c = cmp.rows[0];
    const changed = [];
    if (c.qty_changed) changed.push('quantity');
    if (c.price_changed) changed.push('unit_price');
    if (c.total_changed) changed.push('total_amount');
    if (next.partner_id !== p.partner_id) changed.push('partner_id');
    if (next.product_id !== p.product_id) changed.push('product_id');
    if (next.purchase_date !== p.purchase_date) changed.push('purchase_date');
    if ((next.memo ?? null) !== (p.memo ?? null)) changed.push('memo');
    if ((next.source_name ?? null) !== (p.source_name ?? null)) changed.push('source_name');
    if (changed.length === 0) throw corrError(400, 'VALIDATION', '바뀐 내용이 없습니다.', { field: 'changes' });

    // RULE-P2·P3 — 전환된 매입은 상품 변경 불가, 수량은 전환 수량 이상만
    if (changed.includes('product_id') && hasSales) {
      const sales = await linkedSalesOfPurchase(client, userId, id);
      throw corrError(409, 'PURCHASE_HAS_SALES', `연결된 매출 ${sales.length}건이 있어 상품을 바꿀 수 없습니다. 매출을 먼저 취소하세요.`, { sales });
    }
    if (c.qty_changed && c.below_alloc) {
      throw corrError(409, 'QTY_BELOW_ALLOCATED', `매출로 전환된 수량(${Number(allocated)})보다 적게 바꿀 수 없습니다.`, { allocated_qty: Number(allocated) });
    }
    // T-201 RULE-07 ②③ — 지급이 걸린 매입은 매입처 변경 불가, 총액을 지급액 아래로 줄이기 불가
    const paidQ = await client.query(
      `SELECT paid_amount::text AS paid_amount, paid_amount > 0 AS has_paid, $2::numeric < paid_amount AS below_paid
         FROM purchase WHERE id = $1`,
      [id, n.total]
    );
    const paidRow = paidQ.rows[0];
    if (paidRow.has_paid && changed.includes('partner_id')) {
      const payments = await activePaymentsOfPurchase(client, userId, id);
      throw corrError(409, 'PURCHASE_HAS_PAYMENT', `지급 ${payments.length}건이 있어 매입처를 바꿀 수 없습니다. 지급정보에서 지급을 먼저 취소하세요.`, { payments });
    }
    if (c.total_changed && paidRow.below_paid) {
      throw corrError(409, 'PAID_OVER_TOTAL', `이미 지급한 금액(${Number(paidRow.paid_amount).toLocaleString('ko-KR')})보다 매입 금액을 적게 바꿀 수 없습니다.`, {
        paid_amount: Number(paidRow.paid_amount),
        new_total: Number(n.total),
      });
    }
    let partnerRow = null;
    if (changed.includes('partner_id')) {
      const acc = await client.query(`SELECT id, type, name, location FROM account WHERE id = $1 AND user_id = $2`, [next.partner_id, userId]);
      partnerRow = acc.rows[0];
      if (!partnerRow || !PURCHASE_PARTNER_TYPES.has(partnerRow.type)) {
        throw corrError(400, 'VALIDATION', '매입 가능한 거래처(공급/도매 등)를 선택하세요.', { field: 'partner_id' });
      }
    } else {
      const acc = await client.query(`SELECT id, type, name, location FROM account WHERE id = $1 AND user_id = $2`, [next.partner_id, userId]);
      partnerRow = acc.rows[0];
    }
    if (changed.includes('product_id')) {
      const prd = await client.query(`SELECT id FROM product WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2)`, [next.product_id, userId]);
      if (!prd.rows[0]) throw corrError(400, 'VALIDATION', '상품을 찾을 수 없습니다.', { field: 'product_id' });
    }

    // 재고·이동 이력 (잠금: purchase → inventory product_id 순서)
    const wh = await getUserWarehouseLabel(client, userId);
    const supLoc = accountLocationLine(partnerRow);
    const memoT = `매입 정정: ${reason}`.slice(0, 500);
    if (changed.includes('product_id')) {
      const inv = await lockInventoryRows(client, userId, [p.product_id, next.product_id]);
      await assertInventoryEnough(client, p.product_id, inv.get(p.product_id), p.quantity);
      await upsertInventoryDelta(client, userId, p.product_id, `-${p.quantity}`);
      await upsertInventoryDelta(client, userId, next.product_id, n.qty);
      await insertTransfer(client, {
        userId, productId: p.product_id, quantity: p.quantity, actionType: 'correction',
        fromType: 'inventory', toType: 'supplier', toPartnerId: p.partner_id,
        beforeLocation: wh, afterLocation: supLoc, purchaseId: id, memo: memoT,
      });
      await insertTransfer(client, {
        userId, productId: next.product_id, quantity: n.qty, actionType: 'correction',
        fromType: 'supplier', toType: 'inventory', fromPartnerId: next.partner_id,
        beforeLocation: supLoc, afterLocation: wh, purchaseId: id, memo: memoT,
      });
    } else if (c.qty_changed) {
      const delta = c.delta; // 새 − 옛 (NUMERIC 문자열)
      const inv = await lockInventoryRows(client, userId, [p.product_id]);
      if (Number(delta) < 0) {
        const need = delta.replace(/^-/, '');
        await assertInventoryEnough(client, p.product_id, inv.get(p.product_id), need);
        await upsertInventoryDelta(client, userId, p.product_id, delta);
        await insertTransfer(client, {
          userId, productId: p.product_id, quantity: need, actionType: 'correction',
          fromType: 'inventory', toType: 'supplier', toPartnerId: next.partner_id,
          beforeLocation: wh, afterLocation: supLoc, purchaseId: id, memo: memoT,
        });
      } else {
        await upsertInventoryDelta(client, userId, p.product_id, delta);
        await insertTransfer(client, {
          userId, productId: p.product_id, quantity: delta, actionType: 'correction',
          fromType: 'supplier', toType: 'inventory', fromPartnerId: next.partner_id,
          beforeLocation: supLoc, afterLocation: wh, purchaseId: id, memo: memoT,
        });
      }
    }

    await client.query(
      `UPDATE purchase SET quantity = $1::numeric, unit_price = $2::numeric, total_amount = $3::numeric,
              partner_id = $4, product_id = $5, purchase_date = $6::date, memo = $7, source_name = $8, updated_at = NOW()
       WHERE id = $9`,
      [n.qty, n.price, n.total, next.partner_id, next.product_id, next.purchase_date, next.memo, next.source_name, id]
    );
    // T-201 RULE-06 — 총액이 바뀌면 지급 상태 다시 계산(지급 0이어도 0원 ↔ 양수 매입 상태가 바뀜)
    if (c.total_changed) await syncPurchasePaymentStatus(client, [id]);
    const before = stripLockMeta(p);
    const after = {};
    const beforePick = {};
    changed.forEach((k) => {
      beforePick[k] = before[k];
      after[k] = next[k];
    });
    await insertCorrection(client, {
      userId, targetType: 'purchase', targetId: id, action: 'update', changedFields: changed,
      before: { ...beforePick, _row: before }, after, reason,
    });
    const row = await client.query(`${PURCHASE_ROW_SQL} WHERE pu.id = $1 AND pu.user_id = $2`, [id, userId]);
    await client.query('COMMIT');
    res.json({ ok: true, data: row.rows[0], changed_fields: changed });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendCorrError(res, err, '매입 수정에 실패했습니다.');
  } finally {
    client.release();
  }
});

/**
 * 매출 정정 잠금(8.1): ① 배분에서 purchase_id 조회(잠금 없음) → ② purchase FOR UPDATE → ③ sale FOR UPDATE
 * → ④ 배분을 다시 읽어 purchase_id 가 같은지 확인(다르면 롤백 후 1회 재시도). 호출 측이 BEGIN 을 한 상태여야 한다.
 * 반환: { sale, purchase(없을 수 있음), allocations }
 */
async function lockSaleForCorrection(client, userId, saleId) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const a0 = await client.query(
      `SELECT DISTINCT purchase_id FROM purchase_allocation WHERE sale_id = $1 AND user_id = $2 ORDER BY purchase_id`,
      [saleId, userId]
    );
    const pids = a0.rows.map((r) => r.purchase_id);
    let purchases = [];
    if (pids.length) {
      const pr = await client.query(
        `SELECT id, product_id, quantity::text AS quantity, status FROM purchase
         WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`,
        [userId, pids]
      );
      purchases = pr.rows;
    }
    const sr = await client.query(SALE_LOCK_SQL, [saleId, userId]);
    const sale = sr.rows[0];
    if (!sale) throw corrError(404, 'NOT_FOUND', '매출을 찾을 수 없습니다.');
    const a1 = await client.query(
      `SELECT id, purchase_id, sale_id, quantity::text AS quantity, created_at FROM purchase_allocation
       WHERE sale_id = $1 AND user_id = $2 ORDER BY id`,
      [saleId, userId]
    );
    const pids1 = [...new Set(a1.rows.map((r) => r.purchase_id))].sort((x, y) => x - y);
    if (pids1.join(',') === pids.join(',')) {
      return { sale, purchases, allocations: a1.rows };
    }
    // 잠그는 사이 배분이 바뀜 — 처음부터 다시(1회)
    await client.query('ROLLBACK');
    await client.query('BEGIN');
  }
  throw corrError(409, 'STALE_DATA', '다른 곳에서 먼저 바뀌었습니다. 다시 시도하세요.', {});
}

/** 매출의 수금·반품 여부(잠근 뒤 판정) */
async function saleMoneyState(client, sale) {
  const r = await client.query(
    `SELECT EXISTS (SELECT 1 FROM payment_allocation WHERE sale_id = $1) AS has_alloc,
            COALESCE((SELECT SUM(quantity) FROM refund WHERE sale_id = $1), 0)::numeric AS refunded_qty,
            EXISTS (SELECT 1 FROM refund WHERE sale_id = $1) AS has_refund`,
    [sale.id]
  );
  const x = r.rows[0];
  return {
    hasPayment: Number(sale.paid_amount) > 0 || x.has_alloc,
    hasRefund: x.has_refund || sale.status === 'refunded',
    refundedQty: Number(x.refunded_qty),
  };
}

// ---------- 6.3 매출 취소 ----------
app.post('/api/sales/:id/cancel', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const id = parseIdParam(req.params.id);
  let reason;
  try {
    if (!id) throw corrError(400, 'VALIDATION', '매출 ID가 올바르지 않습니다.', { field: 'id' });
    reason = readCorrectionReason(req.body);
  } catch (err) {
    return sendCorrError(res, err, '매출 취소에 실패했습니다.');
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    await client.query('BEGIN');
    const { sale, allocations } = await lockSaleForCorrection(client, userId, id);
    if (sale.status === 'cancelled') throw corrError(409, 'ALREADY_CANCELLED', '이미 취소된 매출입니다.');
    assertNotStale(sale, req.body?.expected_updated_at);
    const m = await saleMoneyState(client, sale);
    if (m.hasPayment) {
      throw corrError(409, 'SALE_HAS_PAYMENT', '수금 배분이 있는 매출은 취소할 수 없습니다. 반품(환불)으로 처리하세요.', {
        paid_amount: Number(sale.paid_amount),
      });
    }
    if (m.hasRefund) {
      throw corrError(409, 'SALE_HAS_REFUND', '반품 이력이 있어 취소할 수 없습니다. 남은 수량은 반품으로 처리하세요.', {
        refunded_qty: m.refundedQty,
      });
    }
    await lockInventoryRows(client, userId, [sale.product_id]);
    await upsertInventoryDelta(client, userId, sale.product_id, sale.quantity);
    // 배분 행 삭제 → 매입 잔여가 자동으로 돌아온다(4장 "배분 행을 지우는 이유")
    await client.query(`DELETE FROM purchase_allocation WHERE sale_id = $1 AND user_id = $2`, [id, userId]);
    const up = await client.query(
      `UPDATE sale SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1, updated_at = NOW()
       WHERE id = $2 RETURNING cancelled_at`,
      [reason, id]
    );
    const wh = await getUserWarehouseLabel(client, userId);
    const acc = await client.query(`SELECT name, location FROM account WHERE id = $1 AND user_id = $2`, [sale.partner_id, userId]);
    const purchaseId = allocations[0]?.purchase_id ?? null;
    await insertTransfer(client, {
      userId,
      productId: sale.product_id,
      quantity: sale.quantity,
      actionType: 'sale_cancel',
      fromType: 'customer',
      toType: 'inventory',
      fromPartnerId: sale.partner_id,
      toPartnerId: null,
      beforeLocation: accountLocationLine(acc.rows[0]),
      afterLocation: wh,
      saleId: id,
      purchaseId,
      memo: `매출 취소: ${reason}`.slice(0, 500),
    });
    await insertCorrection(client, {
      userId,
      targetType: 'sale',
      targetId: id,
      action: 'cancel',
      changedFields: ['status'],
      before: { ...stripLockMeta(sale), allocations },
      after: { status: 'cancelled', cancelled_at: up.rows[0].cancelled_at, cancel_reason: reason },
      reason,
    });
    let remainingAfter = null;
    if (purchaseId) {
      const rr = await client.query(
        `SELECT (pu.quantity - COALESCE((SELECT SUM(quantity) FROM purchase_allocation WHERE purchase_id = pu.id), 0))::numeric AS r
         FROM purchase pu WHERE pu.id = $1`,
        [purchaseId]
      );
      remainingAfter = Number(rr.rows[0]?.r ?? 0);
    }
    const invAfter = await client.query(`SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2`, [userId, sale.product_id]);
    await client.query('COMMIT');
    res.json({
      ok: true,
      data: {
        id,
        status: 'cancelled',
        cancelled_at: up.rows[0].cancelled_at,
        purchase_id: purchaseId,
        purchase_remaining_qty_after: remainingAfter,
        inventory_qty_after: Number(invAfter.rows[0]?.quantity ?? 0),
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendCorrError(res, err, '매출 취소에 실패했습니다.');
  } finally {
    client.release();
  }
});

// ---------- 6.4 매출 수정 ----------
app.patch('/api/sales/:id', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const id = parseIdParam(req.params.id);
  let reason;
  let ch;
  try {
    if (!id) throw corrError(400, 'VALIDATION', '매출 ID가 올바르지 않습니다.', { field: 'id' });
    reason = readCorrectionReason(req.body);
    ch = readChanges(req.body, SALE_EDITABLE);
  } catch (err) {
    return sendCorrError(res, err, '매출 수정에 실패했습니다.');
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    const want = {};
    if ('quantity' in ch) want.quantity = readQty(ch.quantity);
    if ('unit_price' in ch) want.unit_price = readPrice(ch.unit_price);
    if ('partner_id' in ch) want.partner_id = readIntField(ch.partner_id, 'partner_id');
    if ('sale_date' in ch) want.sale_date = readDate(ch.sale_date, 'sale_date');
    if ('memo' in ch) want.memo = readMemo(ch.memo);

    await client.query('BEGIN');
    // T-205 RULE-10·14: 수량을 바꿀 때는 늘릴 때 쓸 수 있는 로트까지 매입 행을 먼저 id 순으로 잠근다(매입 → 매출 → 재고 순서 유지)
    if ('quantity' in want) await fifo.prelockLotsForSale(client, userId, id);
    const { sale, purchases, allocations } = await lockSaleForCorrection(client, userId, id);
    if (sale.status === 'cancelled') throw corrError(409, 'ALREADY_CANCELLED', '이미 취소된 매출입니다.');
    assertNotStale(sale, req.body?.expected_updated_at);

    const n = await roundQtyPrice(client, want.quantity ?? sale.quantity, want.unit_price ?? sale.unit_price);
    if (!(Number(n.qty) > 0)) throw corrError(400, 'VALIDATION', '수량은 0보다 커야 합니다.', { field: 'quantity' });
    const next = {
      quantity: n.qty,
      unit_price: n.price,
      total_amount: n.total,
      partner_id: want.partner_id ?? sale.partner_id,
      sale_date: want.sale_date ?? sale.sale_date,
      memo: 'memo' in want ? want.memo : sale.memo,
    };
    const cmp = await client.query(
      `SELECT $1::numeric <> $2::numeric AS qty_changed, $3::numeric <> $4::numeric AS price_changed,
              $5::numeric <> $6::numeric AS total_changed, ($1::numeric - $2::numeric)::text AS delta`,
      [n.qty, sale.quantity, n.price, sale.unit_price, n.total, sale.total_amount]
    );
    const c = cmp.rows[0];
    const changed = [];
    if (c.qty_changed) changed.push('quantity');
    if (c.price_changed) changed.push('unit_price');
    if (c.total_changed) changed.push('total_amount');
    if (next.partner_id !== sale.partner_id) changed.push('partner_id');
    if (next.sale_date !== sale.sale_date) changed.push('sale_date');
    if ((next.memo ?? null) !== (sale.memo ?? null)) changed.push('memo');
    if (changed.length === 0) throw corrError(400, 'VALIDATION', '바뀐 내용이 없습니다.', { field: 'changes' });

    // RULE-S2·S3·S4 — 수금이 있으면 판매일·메모만, 반품이 있으면 메모만
    const m = await saleMoneyState(client, sale);
    if (m.hasRefund && changed.some((k) => k !== 'memo')) {
      throw corrError(409, 'SALE_HAS_REFUND', '반품 이력이 있는 매출은 메모만 고칠 수 있습니다. 남은 수량은 반품으로 처리하세요.', {
        refunded_qty: m.refundedQty,
      });
    }
    if (m.hasPayment && changed.some((k) => k !== 'memo' && k !== 'sale_date')) {
      throw corrError(409, 'SALE_HAS_PAYMENT', '수금이 있는 매출은 판매일·메모만 고칠 수 있습니다.', {
        paid_amount: Number(sale.paid_amount),
      });
    }
    let partnerRow;
    {
      const acc = await client.query(`SELECT id, type, name, location FROM account WHERE id = $1 AND user_id = $2`, [next.partner_id, userId]);
      partnerRow = acc.rows[0];
      if (changed.includes('partner_id') && (!partnerRow || !SALE_PARTNER_TYPES.has(partnerRow.type))) {
        throw corrError(400, 'VALIDATION', '판매 가능한 거래처를 선택하세요.', { field: 'partner_id' });
      }
    }

    if (c.qty_changed) {
      const delta = c.delta; // 새 − 옛
      const alloc = allocations[0] || null;
      const memoT = `매출 정정: ${reason}`.slice(0, 500);
      const wh = await getUserWarehouseLabel(client, userId);
      const custLoc = accountLocationLine(partnerRow);
      const fifoQty = await fifo.usesFifoQtyRule(client, id, allocations);
      if (fifoQty) {
        // T-205 RULE-10: 재고 판매(fifo) 매출·여러 매입에 걸친 매출 — 줄이면 최근 로트부터, 늘리면 FIFO 로 추가 배분
        await fifo.adjustFifoSaleQty(client, {
          userId, sale, newQty: n.qty, delta,
          h: { upsertInventoryDelta, insertTransfer, wh, custLoc, memo: memoT, partnerId: next.partner_id, saleDate: next.sale_date },
        });
      } else if (Number(delta) > 0) {
        if (alloc) {
          const pu = purchases.find((x) => x.id === alloc.purchase_id);
          const rr = await client.query(
            `SELECT ($1::numeric + $2::numeric - COALESCE((SELECT SUM(quantity) FROM purchase_allocation WHERE purchase_id = $3), 0))::text AS max_qty,
                    $4::numeric > ($1::numeric + $2::numeric - COALESCE((SELECT SUM(quantity) FROM purchase_allocation WHERE purchase_id = $3), 0)) AS over`,
            [alloc.quantity, pu.quantity, alloc.purchase_id, n.qty]
          );
          if (rr.rows[0].over) {
            throw corrError(409, 'QTY_OVER_PURCHASE', `매입의 남은 수량을 넘습니다. 최대 ${Number(rr.rows[0].max_qty)}까지 바꿀 수 있습니다.`, {
              max_qty: Number(rr.rows[0].max_qty),
            });
          }
        }
        const inv = await lockInventoryRows(client, userId, [sale.product_id]);
        await assertInventoryEnough(client, sale.product_id, inv.get(sale.product_id), delta);
        await upsertInventoryDelta(client, userId, sale.product_id, `-${delta}`);
        await insertTransfer(client, {
          userId, productId: sale.product_id, quantity: delta, actionType: 'correction',
          fromType: 'inventory', toType: 'customer', toPartnerId: next.partner_id,
          beforeLocation: wh, afterLocation: custLoc, saleId: id, purchaseId: alloc?.purchase_id ?? null, memo: memoT,
        });
      } else {
        const back = delta.replace(/^-/, '');
        await lockInventoryRows(client, userId, [sale.product_id]);
        await upsertInventoryDelta(client, userId, sale.product_id, back);
        await insertTransfer(client, {
          userId, productId: sale.product_id, quantity: back, actionType: 'correction',
          fromType: 'customer', toType: 'inventory', fromPartnerId: sale.partner_id,
          beforeLocation: custLoc, afterLocation: wh, saleId: id, purchaseId: alloc?.purchase_id ?? null, memo: memoT,
        });
      }
      if (alloc && !fifoQty) {
        await client.query(`UPDATE purchase_allocation SET quantity = $1::numeric WHERE id = $2`, [n.qty, alloc.id]);
      }
    }
    // T-205 RULE-11: 재고 판매 매출의 판매일은 배분된 로트의 가장 늦은 매입일보다 앞설 수 없다(전환 매출은 지금 규칙 그대로)
    if (changed.includes('sale_date')) {
      await fifo.assertFifoSaleDate(client, { userId, saleId: id, saleDate: next.sale_date });
    }

    // T-207 외상 한도: 바뀐 뒤 판매처의 미수를 수정 전후로 비교한다(늘었고 한도를 넘으면 경고)
    const creditPrev = await credit.creditBefore(client, userId, [next.partner_id]);
    await client.query(
      `UPDATE sale SET quantity = $1::numeric, unit_price = $2::numeric, total_amount = $3::numeric,
              partner_id = $4, sale_date = $5::date, memo = $6, updated_at = NOW()
       WHERE id = $7`,
      [n.qty, n.price, n.total, next.partner_id, next.sale_date, next.memo, id]
    );
    await syncSalePaymentStatus(client, id); // 수금 0이라 unpaid 유지 — 안전 차원(6.4)
    const creditWarnings = await credit.assertCreditOrConfirmed(client, userId, creditPrev, req.body);
    const before = { ...stripLockMeta(sale), allocations };
    const beforePick = {};
    const after = {};
    changed.forEach((k) => {
      beforePick[k] = before[k];
      after[k] = next[k];
    });
    await insertCorrection(client, {
      userId, targetType: 'sale', targetId: id, action: 'update', changedFields: changed,
      before: { ...beforePick, _row: before }, after, reason,
    });
    const row = await client.query(`${SALE_ROW_SQL} WHERE s.id = $1 AND s.user_id = $2`, [id, userId]);
    await client.query('COMMIT');
    res.json({ ok: true, data: row.rows[0], changed_fields: changed, ...(creditWarnings.length ? { credit_warnings: creditWarnings } : {}) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    sendCorrError(res, err, '매출 수정에 실패했습니다.');
  } finally {
    client.release();
  }
});

// ---------- 6.5 정정 이력 (W-09) ----------
app.get('/api/corrections', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const tt = String(req.query.target_type || '');
  const tid = parseIdParam(req.query.target_id);
  if (!['purchase', 'sale'].includes(tt) || !tid) {
    return res.status(400).json({ ok: false, code: 'VALIDATION', message: 'target_type(purchase|sale)·target_id가 필요합니다.' });
  }
  try {
    const r = await pool.query(
      `SELECT id, action, changed_fields, before_data, after_data, reason, created_at
       FROM trade_correction WHERE user_id = $1 AND target_type = $2 AND target_id = $3
       ORDER BY created_at DESC, id DESC`,
      [userId, tt, tid]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('GET corrections error:', err);
    res.status(500).json({ ok: false, message: '정정 이력을 불러오지 못했습니다.' });
  }
});

// 폐기
app.post('/api/disposals', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const { product_id, quantity, disposal_date, reason, memo } = req.body || {};
  const prid = parseInt(product_id, 10);
  const qty = Number(quantity);
  const ddate = disposal_date ? String(disposal_date).slice(0, 10) : '';
  if (!Number.isFinite(prid) || !(qty > 0) || !ddate) {
    return res.status(400).json({ ok: false, message: '상품·수량·폐기일을 입력하세요.' });
  }
  const client = await connectOr503(res);
  if (!client) return;
  try {
    await client.query('BEGIN');
    const wh = await getUserWarehouseLabel(client, userId);
    await upsertInventoryDelta(client, userId, prid, `-${qty}`);
    const dIns = await client.query(
      `INSERT INTO disposal (user_id, product_id, quantity, disposal_date, reason, memo)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, prid, qty, ddate, reason?.trim() || null, memo?.trim() || null]
    );
    const disposalId = dIns.rows[0].id;
    await insertTransfer(client, {
      userId,
      productId: prid,
      quantity: qty,
      actionType: 'disposal',
      fromType: 'inventory',
      toType: 'disposal',
      fromPartnerId: null,
      toPartnerId: null,
      beforeLocation: wh,
      afterLocation: '폐기',
      disposalId,
      memo: reason?.trim() || null,
    });
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: { id: disposalId } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('disposal error:', err);
    const code = err.code === 'NEGATIVE_INVENTORY' ? 400 : 500;
    res.status(code).json({ ok: false, message: err.message || '폐기 등록에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// 파일 전송 테스트: Salesforce ContentVersion 단건 multipart 업로드
// 순서: ① 기능 꺼짐이면 본문을 읽지 않고 404 ② 로그인 확인 ③ 그 뒤에만 파일을 메모리로 받음(한도 초과는 413)
app.post(
  '/api/file-transfer/salesforce/content-version',
  (req, res, next) => {
    if (!ENABLE_SF_UPLOAD) return res.status(404).json({ ok: false, message: '파일 전송 기능이 꺼져 있습니다.' });
    next();
  },
  async (req, res, next) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    req.authUserId = userId;
    next();
  },
  (req, res, next) => {
    uploadMemory.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ ok: false, message: `파일은 ${SF_UPLOAD_MAX_MB}MB 까지 올릴 수 있습니다.` });
      }
      return res.status(400).json({ ok: false, message: '업로드 형식이 올바르지 않습니다.' });
    });
  },
  async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, message: 'file 필드로 파일을 업로드하세요.' });
    if (!file.originalname) return res.status(400).json({ ok: false, message: '파일명이 필요합니다.' });

    const titleRaw = String(req.body?.title || '').trim();
    const firstPublishLocationId = String(req.body?.first_publish_location_id || '').trim() || null;
    const result = await uploadContentVersionToSalesforce({
      fileName: file.originalname,
      fileSize: file.size,
      fileBuffer: file.buffer,
      mimeType: file.mimetype,
      titleRaw,
      firstPublishLocationId,
    });

    return res.status(201).json({
      ok: true,
      data: result,
    });
  } catch (err) {
    console.error('Salesforce ContentVersion upload error:', err);
    const status = err.statusCode || 500;
    res.status(status).json({ ok: false, message: err.message || '파일 전송 실패', detail: err.detail || null });
  }
  }
);

app.get('/api/disposals', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = req.query.from_date || '';
  const to = req.query.to_date || '';
  const opts = parseListOptions(req.query); // T-211: q(품목·사유·메모), limit·offset (폐기는 거래처 없음)
  if (opts.error) return res.status(400).json(opts.error);
  try {
    let q = `SELECT d.id, d.disposal_date, d.created_at, d.quantity, d.reason, d.memo, p.name AS product_name, p.unit
             FROM disposal d JOIN product p ON p.id = d.product_id WHERE d.user_id = $1`;
    const params = [userId];
    if (from) {
      params.push(from);
      q += ` AND d.disposal_date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      q += ` AND d.disposal_date <= $${params.length}`;
    }
    q += searchClause(opts, params, ['p.name', 'd.reason', 'd.memo']);
    res.json(await runList(pool, q, params, ' ORDER BY d.disposal_date DESC, d.id DESC', opts));
  } catch (err) {
    console.error('GET disposals error:', err);
    res.status(500).json({ ok: false, message: err.message || '폐기 목록을 불러오지 못했습니다.' });
  }
});

// T-213: 라우트 점검 테스트가 서버를 띄우지 않고 라우트 목록을 읽을 수 있게 app 을 내보낸다(node index.js 로 실행할 때만 listen)
module.exports = { app, pool };
const host = process.env.HOST || '0.0.0.0';
if (require.main === module) app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
  console.log('  Health: GET /health   Capabilities: GET /api/capabilities (최신 빌드 확인용)');
  const hasDb = process.env.DATABASE_URL || (process.env.PG_HOST && process.env.PG_PASSWORD);
  if (!hasDb) {
    console.warn('DB not configured. Set .env (DATABASE_URL or PG_HOST/PG_PASSWORD) and restart.');
  }
});
