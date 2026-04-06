const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { Resend } = require('resend');
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

const app = express();
const port = process.env.PORT || 3000;

// 로컬 개발: 다른 포트(프론트)에서 API 호출 허용
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Agent-No');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// PostgreSQL 연결 설정 (WHATWG URL로 파싱해 deprecation 경고 방지)
// DATABASE_URL은 반드시 postgres(ql):// 로 시작해야 함 (앱 URL 넣으면 DB 포트에 HTTP 요청이 가서 invalid startup packet 에러 발생)
function getPoolConfig() {
  const raw = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  if (raw && (raw.startsWith('postgres://') || raw.startsWith('postgresql://'))) {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: u.username || undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: u.pathname ? u.pathname.slice(1) : undefined,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    };
  }
  if (raw) {
    console.warn('[DB] DATABASE_URL이 postgres:// 또는 postgresql:// 로 시작하지 않습니다. Postgres 연결 정보만 넣어 주세요.');
  }
  return {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD != null ? String(process.env.PG_PASSWORD) : undefined,
    database: process.env.PG_DATABASE || 'sales_tool',
  };
}
const pool = new Pool(getPoolConfig());
pool.on('error', (err) => console.error('[DB] Pool error:', err.message));

// 이메일 발송: RESEND_API_KEY 있으면 Resend(HTTPS), 없으면 Gmail SMTP. Render/Railway는 SMTP 막혀서 Resend 권장.
function getMailTransporter() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = process.env.SMTP_PASS;
  const hasPass = pass != null && String(pass).length > 0;
  if (!host || !user || !hasPass) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = port === 465;
  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass: String(pass) },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });
}
async function sendVerificationEmail(email, code) {
  const subject = '판매툴 인증';
  const text = `판매툴 인증\n\n인증번호 : ${code}\n\n5분 안에 입력해 주세요.`;

  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    try {
      const resend = new Resend(resendKey);
      const from = (process.env.RESEND_FROM || 'onboarding@resend.dev').trim();
      const { data, error } = await resend.emails.send({
        from,
        to: [email],
        subject,
        text,
      });
      if (error) {
        console.error('[이메일 인증] Resend 실패:', error.message);
        return { sent: false, code, error: error.message };
      }
      console.log('[이메일 인증] Resend 발송 성공 →', email);
      return { sent: true };
    } catch (err) {
      const msg = err.message || String(err);
      console.error('[이메일 인증] Resend 오류:', msg);
      return { sent: false, code, error: msg };
    }
  }

  const transporter = getMailTransporter();
  if (transporter) {
    try {
      await transporter.sendMail({
        from: (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim(),
        to: email,
        subject,
        text,
      });
      console.log('[이메일 인증] SMTP 발송 성공 →', email);
      return { sent: true };
    } catch (err) {
      const msg = err.code || err.message || String(err);
      console.error('[이메일 인증] SMTP 발송 실패:', msg);
      return { sent: false, code, error: msg };
    }
  }
  console.log('[이메일 인증] 발송 수단 없음 (RESEND_API_KEY 또는 SMTP 설정 필요) | 인증번호:', code, '→', email);
  return { sent: false, code, error: 'RESEND_API_KEY 또는 SMTP_HOST/SMTP_USER/SMTP_PASS 설정 필요' };
}

app.use(express.json());

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: {
    // 단건 ContentVersion 업로드용; 실질 한도는 Salesforce·서버 메모리에 따름
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB
  },
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

// 로그인 사용자 ID — 중매인 번호(X-Agent-No)로 조회 (데이터는 user_id 기반으로 유지)
async function getUserId(req) {
  const agentNo = req.headers['x-agent-no']?.trim();
  if (!agentNo) return null;
  try {
    const r = await pool.query('SELECT id FROM "user" WHERE agent_no = $1 AND status = $2', [agentNo, 'active']);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (err) {
    console.error('getUserId error:', err.message);
    return null;
  }
}

async function getUserIdAndAdmin(req) {
  const agentNo = req.headers['x-agent-no']?.trim();
  if (!agentNo) return null;
  try {
    const r = await pool.query('SELECT id, is_admin FROM "user" WHERE agent_no = $1 AND status = $2', [agentNo, 'active']);
    const row = r.rows[0];
    return row ? { userId: row.id, isAdmin: !!row.is_admin } : null;
  } catch (err) {
    console.error('getUserIdAndAdmin error:', err.message);
    return null;
  }
}

// 서버 상태 확인 (DB 없이도 동작)
app.get('/', (req, res) => {
  res.json({ ok: true, message: 'Sales tool backend is running' });
});

// DB 연결 확인용 API
app.get('/health', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as now');
    client.release();
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
app.post('/api/auth/check-phone', async (req, res) => {
  const raw = req.body?.phone?.trim();
  if (!raw) return res.status(400).json({ ok: false, available: false, message: '휴대폰번호를 입력하세요.' });
  if (!isValidPhone(raw)) return res.status(400).json({ ok: false, available: false, message: '휴대폰번호 형식이 올바르지 않습니다. (예: 010-1234-5678)' });
  const phone = normalizePhone(raw);
  try {
    const r = await pool.query('SELECT 1 FROM "user" WHERE phone = $1', [phone]);
    res.json({ ok: true, available: r.rows.length === 0 });
  } catch (err) {
    console.error('check-phone error:', err);
    res.status(500).json({ ok: false, available: false, message: err.message || '확인할 수 없습니다.' });
  }
});

// 중매인 번호 중복 확인
app.post('/api/auth/check-agent-no', async (req, res) => {
  const agent_no = req.body?.agent_no?.trim();
  if (!agent_no) return res.status(400).json({ ok: false, available: false, message: '중매인 번호를 입력하세요.' });
  try {
    const r = await pool.query('SELECT 1 FROM "user" WHERE agent_no = $1', [agent_no]);
    res.json({ ok: true, available: r.rows.length === 0 });
  } catch (err) {
    console.error('check-agent-no error:', err);
    res.status(500).json({ ok: false, available: false, message: err.message || '확인할 수 없습니다.' });
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
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await pool.query(
      `INSERT INTO email_verification (email, code, expires_at) VALUES ($1, $2, $3)`,
      [email, code, expiresAt]
    );
    let sendResult;
    try {
      sendResult = await sendVerificationEmail(email, code);
    } catch (mailErr) {
      console.error('Send verification email failed:', mailErr);
      sendResult = { sent: false, code, error: mailErr.message || String(mailErr) };
    }
    const payload = { ok: true, message: sendResult.sent ? '인증번호가 발송되었습니다. 5분 안에 입력하세요.' : '인증번호가 생성되었습니다. 아래 번호를 입력하세요. (이메일 미발송)' };
    if (!sendResult.sent && sendResult.code) payload.dev_code = sendResult.code;
    if (!sendResult.sent && sendResult.error) payload.smtp_error = sendResult.error;
    res.json(payload);
  } catch (err) {
    console.error('Send verification error:', err);
    res.status(500).json({ ok: false, message: err.message || '인증번호 발송에 실패했습니다.' });
  }
});

// 이메일 인증번호 확인 (5분 이내 입력)
app.post('/api/auth/verify-email-code', async (req, res) => {
  const email = req.body?.email?.trim();
  const code = req.body?.code?.trim();
  if (!email || !code) return res.status(400).json({ ok: false, message: '이메일과 인증번호를 입력하세요.' });
  try {
    const r = await pool.query(
      `SELECT id FROM email_verification WHERE email = $1 AND code = $2 AND expires_at > NOW() AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [email, code]
    );
    if (r.rows.length === 0) {
      return res.status(400).json({ ok: false, message: '인증번호가 맞지 않거나 만료되었습니다. 5분 안에 입력해 주세요.' });
    }
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
  if (!name?.trim() || !email?.trim() || !phone?.trim() || !agent_no?.trim() || password === undefined) {
    return res.status(400).json({ ok: false, message: '상호명, 이메일, 휴대폰번호, 중매인 번호, 비밀번호를 모두 입력하세요.' });
  }
  if (!terms_agreed) return res.status(400).json({ ok: false, message: '개인정보약관에 동의해 주세요.' });
  if (!isValidEmail(email)) return res.status(400).json({ ok: false, message: '이메일 형식이 올바르지 않습니다.' });
  if (!isValidPhone(phone)) return res.status(400).json({ ok: false, message: '휴대폰번호 형식이 올바르지 않습니다.' });
  const phoneNorm = normalizePhone(phone);
  const client = await pool.connect();
  try {
    const v = await client.query(
      `SELECT 1 FROM email_verification WHERE email = $1 AND verified_at IS NOT NULL AND verified_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
      [email.trim()]
    );
    if (v.rows.length === 0) {
      client.release();
      return res.status(400).json({ ok: false, message: '이메일 인증을 먼저 완료해 주세요. (인증번호 발송 후 5분 안에 입력)' });
    }
    const hash = await bcrypt.hash(String(password), 10);
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
    client.release();
    res.json({ ok: true, user: { id: user.id, user_key: user.user_key, name: user.name, email: user.email, agent_no: user.agent_no } });
  } catch (err) {
    client.release();
    if (err.code === '23505') {
      const msg = err.constraint === 'user_email_key' ? '이미 사용 중인 이메일입니다.'
        : err.constraint === 'user_phone_key' ? '이미 사용 중인 휴대폰번호입니다.'
        : err.constraint === 'user_agent_no_key' ? '이미 사용 중인 중매인 번호입니다.' : '이미 등록된 정보가 있습니다.';
      return res.status(409).json({ ok: false, message: msg });
    }
    console.error('Register error:', err);
    res.status(500).json({ ok: false, message: '회원가입 처리 중 오류가 발생했습니다.' });
  }
});

// 로그인 API (중매인 번호 + 비밀번호 → 사용자 정보 반환)
app.post('/api/auth/login', async (req, res) => {
  const { agent_no, password } = req.body || {};
  console.log('[login] body =', req.body);
  if (!agent_no || password === undefined) {
    return res.status(400).json({ ok: false, message: '중매인 번호와 비밀번호를 입력하세요.' });
  }
  try {
    const client = await pool.connect();
    const r = await client.query(
      `SELECT id, user_key, name, agent_no, password_hash, status, is_admin FROM "user" WHERE agent_no = $1`,
      [String(agent_no).trim()]
    );
    client.release();
    const row = r.rows[0];
    if (!row) {
      return res.status(401).json({ ok: false, message: '중매인 번호 또는 비밀번호가 올바르지 않습니다.' });
    }
    if (row.status !== 'active') {
      return res.status(403).json({ ok: false, message: '비활성화된 계정입니다.' });
    }
    const match = await bcrypt.compare(String(password), row.password_hash);
    if (!match) {
      return res.status(401).json({ ok: false, message: '중매인 번호 또는 비밀번호가 올바르지 않습니다.' });
    }
    res.json({
      ok: true,
      user: { id: row.id, user_key: row.user_key, name: row.name, agent_no: row.agent_no, is_admin: !!row.is_admin },
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
    hints: ['POST /api/purchases', 'POST /api/purchases/convert-to-sales', 'POST /api/payments', 'POST /api/sales/:id/refund', 'POST /api/disposals'],
  });
});

// ---------- 메인 화면용 API (X-Agent-No 헤더 필수, 중매인 번호 기준으로 해당 회원 데이터 조회) ----------

// 상품 목록 (대분류/중분류/소분류/이름 검색 가능)
app.get('/api/products', async (req, res) => {
  try {
    const categoryLarge = req.query.category_large?.trim();
    const categoryMid = req.query.category_mid?.trim();
    const categorySmall = req.query.category_small?.trim();
    const nameSearch = req.query.name?.trim();
    let q = `SELECT id, name, unit, category, category_large, category_mid, category_small, product_key, memo, created_at, updated_at FROM product WHERE 1=1`;
    const params = [];
    if (categoryLarge) { params.push(categoryLarge); q += ` AND category_large = $${params.length}`; }
    if (categoryMid) { params.push(categoryMid); q += ` AND category_mid = $${params.length}`; }
    if (categorySmall) { params.push(categorySmall); q += ` AND category_small = $${params.length}`; }
    if (nameSearch) { params.push('%' + nameSearch + '%'); q += ` AND name ILIKE $${params.length}`; }
    q += ' ORDER BY category_large, category_mid, category_small, name';
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
  const client = await pool.connect();
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
  const client = await pool.connect();
  try {
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
    client.release();
    res.status(201).json({ ok: true, data: created, count: created.length });
  } catch (err) {
    client.release();
    console.error('Product bulk create error:', err);
    res.status(500).json({ ok: false, message: err.message || '다건 등록에 실패했습니다.' });
  }
});

// 거래처 목록 (중매인 번호 기준 — 내 회원)
app.get('/api/partners', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  try {
    const r = await pool.query(
      'SELECT id, name, type, contact, phone, location, address FROM account WHERE user_id = $1 ORDER BY name',
      [userId]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Partners error:', err);
    res.status(500).json({ ok: false, message: err.message || '거래처 목록을 불러오지 못했습니다.' });
  }
});

// 재고현황 (중매인 번호 기준)
app.get('/api/inventory', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  try {
    const r = await pool.query(
      `SELECT i.id, i.product_id, i.quantity, i.updated_at, p.name AS product_name, p.unit,
              lp.purchase_date AS last_purchase_date,
              lp.created_at AS last_purchase_created_at,
              NULLIF(BTRIM(lp.source_name::text), '') AS last_source_name,
              NULLIF(BTRIM(pt.name::text), '') AS last_partner_name
       FROM inventory i
       JOIN product p ON p.id = i.product_id
       LEFT JOIN LATERAL (
         SELECT pu.purchase_date, pu.created_at, pu.partner_id, pu.source_name
         FROM purchase pu
         WHERE pu.user_id = i.user_id AND pu.product_id = i.product_id
         ORDER BY pu.purchase_date DESC, pu.created_at DESC NULLS LAST, pu.id DESC
         LIMIT 1
       ) lp ON true
       LEFT JOIN account pt ON pt.id = lp.partner_id AND pt.user_id = i.user_id
       WHERE i.user_id = $1 AND i.quantity > 0
       ORDER BY p.name`,
      [userId]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Inventory error:', err);
    res.status(500).json({ ok: false, message: err.message || '재고현황을 불러오지 못했습니다.' });
  }
});

// 매입정보 (중매인 번호 기준, 기간·제품별 검색)
app.get('/api/purchases', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from_date || today;
  const to = req.query.to_date || today;
  const productId = req.query.product_id ? parseInt(req.query.product_id, 10) : null;
  try {
    let q = `SELECT pu.id, pu.partner_id, pu.product_id, pu.purchase_date, pu.created_at, pu.quantity, pu.unit_price, pu.total_amount, pu.memo, pu.source_name,
             p.name AS product_name, p.unit, pt.name AS partner_name,
             COALESCE((SELECT SUM(pa.quantity) FROM purchase_allocation pa WHERE pa.purchase_id = pu.id), 0)::numeric AS allocated_qty,
             (pu.quantity - COALESCE((SELECT SUM(pa.quantity) FROM purchase_allocation pa WHERE pa.purchase_id = pu.id), 0))::numeric AS remaining_qty
             FROM purchase pu
             JOIN product p ON p.id = pu.product_id
             JOIN account pt ON pt.id = pu.partner_id
             WHERE pu.user_id = $1 AND pu.purchase_date BETWEEN $2 AND $3`;
    const params = [userId, from, to];
    if (productId && Number.isFinite(productId)) {
      params.push(productId);
      q += ` AND pu.product_id = $${params.length}`;
    }
    q += ' ORDER BY pu.purchase_date DESC, pu.id DESC';
    const r = await pool.query(q, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Purchases error:', err);
    res.status(500).json({ ok: false, message: err.message || '매입정보를 불러오지 못했습니다.' });
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
// refundable_only=1 이면 수금 발생(paid_amount>0) + 환불 가능 잔여 수량 있음 (환불 처리 모달용)
app.get('/api/sales', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = req.query.from_date || '';
  const to = req.query.to_date || '';
  const partnerId = req.query.partner_id ? parseInt(req.query.partner_id, 10) : null;
  const unpaidOnly = req.query.unpaid_only === '1' || req.query.unpaid_only === 'true';
  const paidOnly = req.query.paid_only === '1' || req.query.paid_only === 'true';
  const refundableOnly = req.query.refundable_only === '1' || req.query.refundable_only === 'true';
  try {
    let q = `SELECT s.id, s.partner_id, s.product_id, s.sale_date, s.created_at, s.quantity, s.unit_price, s.total_amount,
             s.payment_status, s.paid_amount, s.status, s.memo,
             p.name AS product_name, p.unit, pt.name AS partner_name, pt.location AS partner_location,
             COALESCE((SELECT SUM(r.quantity) FROM refund r WHERE r.sale_id = s.id), 0)::numeric AS refunded_qty
             FROM sale s
             JOIN product p ON p.id = s.product_id
             JOIN account pt ON pt.id = s.partner_id
             WHERE s.user_id = $1`;
    const params = [userId];
    if (unpaidOnly) {
      q += ` AND s.payment_status IN ('unpaid', 'partial') AND s.status NOT IN ('refunded', 'cancelled')`;
    } else if (refundableOnly) {
      q += ` AND s.paid_amount > 0`;
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
    q += ' ORDER BY s.sale_date DESC, s.id DESC';
    const r = await pool.query(q, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Sales error:', err);
    res.status(500).json({ ok: false, message: err.message || '매출정보를 불러오지 못했습니다.' });
  }
});

// 일별 매입·매출 집계 (기간 필수, 거래처 선택 시 매입=구입처·매출=판매처 기준)
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
       )
       SELECT days.d AS date,
              COALESCE(p.purchase_amount, 0)::numeric AS purchase_amount,
              COALESCE(p.purchase_count, 0)::int AS purchase_count,
              COALESCE(s.sales_amount, 0)::numeric AS sales_amount,
              COALESCE(s.sales_count, 0)::int AS sales_count
       FROM days
       LEFT JOIN p ON p.d = days.d
       LEFT JOIN s ON s.d = days.d
       ORDER BY days.d`,
      [userId, from, to, pid]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('daily-purchase-sales error:', err);
    res.status(500).json({ ok: false, message: err.message || '일별 집계를 불러오지 못했습니다.' });
  }
});

// 수금정보 (중매인 번호 기준, 기간·거래처별 검색)
app.get('/api/payments', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = req.query.from_date || '';
  const to = req.query.to_date || '';
  const partnerId = req.query.partner_id ? parseInt(req.query.partner_id, 10) : null;
  try {
    let q = `SELECT py.id, py.paid_at, py.created_at, py.amount, py.entry_kind, py.memo, pt.name AS partner_name
             FROM payment py
             JOIN account pt ON pt.id = py.partner_id
             WHERE py.user_id = $1`;
    const params = [userId];
    if (from) { params.push(from); q += ` AND py.paid_at::date >= $${params.length}::date`; }
    if (to) { params.push(to); q += ` AND py.paid_at::date <= $${params.length}::date`; }
    if (partnerId && Number.isFinite(partnerId)) { params.push(partnerId); q += ` AND py.partner_id = $${params.length}`; }
    q += ' ORDER BY py.paid_at DESC, py.id DESC';
    const r = await pool.query(q, params);
    res.json({ ok: true, data: r.rows });
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

async function syncSalePaymentStatus(client, saleId) {
  await client.query(
    `UPDATE sale SET payment_status =
      CASE
        WHEN paid_amount >= total_amount THEN 'paid'::payment_status
        WHEN paid_amount > 0 THEN 'partial'::payment_status
        ELSE 'unpaid'::payment_status
      END,
      updated_at = NOW()
     WHERE id = $1`,
    [saleId]
  );
}

async function upsertInventoryDelta(client, userId, productId, delta) {
  const existing = await client.query(
    `SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2 FOR UPDATE`,
    [userId, productId]
  );
  const cur = existing.rows[0] ? Number(existing.rows[0].quantity) : 0;
  const next = cur + delta;
  if (next < 0) {
    const e = new Error('재고가 부족합니다.');
    e.code = 'NEGATIVE_INVENTORY';
    throw e;
  }
  if (existing.rows[0]) {
    await client.query(
      `UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE user_id = $2 AND product_id = $3`,
      [next, userId, productId]
    );
  } else {
    if (delta <= 0) {
      const e = new Error('재고가 부족합니다.');
      e.code = 'NEGATIVE_INVENTORY';
      throw e;
    }
    await client.query(`INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1,$2,$3)`, [userId, productId, next]);
  }
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
  const total = Math.round(qty * up * 100) / 100;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const acc = await client.query(`SELECT id, type, name, location, address FROM account WHERE id = $1 AND user_id = $2`, [pid, userId]);
    const a = acc.rows[0];
    if (!a || !PURCHASE_PARTNER_TYPES.has(a.type)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, message: '매입 가능한 거래처(공급/도매 등)를 선택하세요.' });
    }
    const pr = await client.query(`SELECT id FROM product WHERE id = $1`, [prid]);
    if (!pr.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, message: '상품을 찾을 수 없습니다.' });
    }
    const src = source_name != null && String(source_name).trim() ? String(source_name).trim().slice(0, 200) : null;
    const ins = await client.query(
      `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo, source_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [userId, pid, prid, qty, up, total, String(purchase_date).slice(0, 10), memo?.trim() || null, src]
    );
    const purchaseId = ins.rows[0].id;
    await upsertInventoryDelta(client, userId, prid, qty);
    const wh = await getUserWarehouseLabel(client, userId);
    await insertTransfer(client, {
      userId,
      productId: prid,
      quantity: qty,
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
    await client.query('ROLLBACK');
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
  const client = await pool.connect();
  const created = [];
  try {
    await client.query('BEGIN');
    const wh = await getUserWarehouseLabel(client, userId);
    for (const it of items) {
      const purchaseId = parseInt(it.purchase_id, 10);
      const custId = parseInt(it.partner_id, 10);
      const qty = Number(it.quantity);
      const up = Number(it.unit_price);
      const saleDate = it.sale_date;
      const smemo = it.memo?.trim() || null;
      if (!Number.isFinite(purchaseId) || !Number.isFinite(custId) || !(qty > 0) || !(up >= 0) || !saleDate) {
        throw new Error('각 행에 매입 ID, 판매처, 수량, 단가, 판매일이 필요합니다.');
      }
      const pu = await client.query(
        `SELECT id, partner_id, product_id, quantity FROM purchase WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [purchaseId, userId]
      );
      const p = pu.rows[0];
      if (!p) throw new Error(`매입 ${purchaseId} 를 찾을 수 없습니다.`);
      const al = await client.query(`SELECT COALESCE(SUM(quantity),0) AS s FROM purchase_allocation WHERE purchase_id = $1`, [purchaseId]);
      const allocated = Number(al.rows[0].s);
      const remaining = Number(p.quantity) - allocated;
      if (qty > remaining + 1e-9) throw new Error(`매입 ${purchaseId} 의 남은 수량(${remaining})보다 많게 판매할 수 없습니다.`);

      const cust = await client.query(`SELECT id, type, name, location, address FROM account WHERE id = $1 AND user_id = $2`, [custId, userId]);
      const c = cust.rows[0];
      if (!c || !SALE_PARTNER_TYPES.has(c.type)) throw new Error('판매 가능한 거래처를 선택하세요.');

      await upsertInventoryDelta(client, userId, p.product_id, -qty);

      const totalAmt = Math.round(qty * up * 100) / 100;
      const saleIns = await client.query(
        `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date, payment_status, paid_amount, status, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'unpaid',0,'active',$8)
         RETURNING id`,
        [userId, custId, p.product_id, qty, up, totalAmt, String(saleDate).slice(0, 10), smemo]
      );
      const saleId = saleIns.rows[0].id;
      await client.query(
        `INSERT INTO purchase_allocation (user_id, purchase_id, sale_id, quantity) VALUES ($1,$2,$3,$4)`,
        [userId, purchaseId, saleId, qty]
      );
      await insertTransfer(client, {
        userId,
        productId: p.product_id,
        quantity: qty,
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
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: created });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('convert-to-sales error:', err);
    const msg = err.message || '매출 전환에 실패했습니다.';
    const code = err.code === 'NEGATIVE_INVENTORY' ? 400 : 500;
    res.status(code).json({ ok: false, message: msg });
  } finally {
    client.release();
  }
});

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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const acc = await client.query(`SELECT id, type FROM account WHERE id = $1 AND user_id = $2`, [pid, userId]);
    if (!acc.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, message: '거래처를 찾을 수 없습니다.' });
    }
    const payIns = await client.query(
      `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, pid, amt, paidAt, kind, memo?.trim() || null]
    );
    const paymentId = payIns.rows[0].id;
    if (kind === 'receive') {
      for (const a of allocs) {
        const sid = parseInt(a.sale_id, 10);
        const al = Number(a.amount);
        if (!Number.isFinite(sid) || !(al > 0)) {
          throw new Error('배분 행에 매출 ID와 금액이 필요합니다.');
        }
        const s = await client.query(
          `SELECT id, partner_id, total_amount, paid_amount FROM sale WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [sid, userId]
        );
        const sale = s.rows[0];
        if (!sale || sale.partner_id !== pid) throw new Error(`매출 ${sid} 는 선택한 거래처와 맞지 않습니다.`);
        await client.query(`UPDATE sale SET paid_amount = paid_amount + $1, updated_at = NOW() WHERE id = $2`, [al, sid]);
        await syncSalePaymentStatus(client, sid);
        await client.query(`INSERT INTO payment_allocation (payment_id, sale_id, amount) VALUES ($1,$2,$3)`, [paymentId, sid, al]);
      }
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: { id: paymentId } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST payments error:', err);
    res.status(500).json({ ok: false, message: err.message || '수금 등록에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// 환불 (반품 입고 + 이력 + 선택적 환불금 기록)
app.post('/api/sales/:saleId/refund', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const saleId = parseInt(req.params.saleId, 10);
  if (!Number.isFinite(saleId)) return res.status(400).json({ ok: false, message: '매출 ID가 올바르지 않습니다.' });
  const { quantity, refund_amount, refunded_at, reason, memo } = req.body || {};
  const qty = Number(quantity);
  const ra = refund_amount != null && refund_amount !== '' ? Number(refund_amount) : null;
  const rAt = refunded_at ? String(refunded_at).slice(0, 10) : '';
  if (!(qty > 0) || !rAt) {
    return res.status(400).json({ ok: false, message: '반품 수량과 환불일을 입력하세요.' });
  }
  if (ra != null && (!Number.isFinite(ra) || ra < 0)) {
    return res.status(400).json({ ok: false, message: '환불금액이 올바르지 않습니다.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await client.query(
      `SELECT id, partner_id, product_id, quantity, status FROM sale WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [saleId, userId]
    );
    const sale = s.rows[0];
    if (!sale) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, message: '매출을 찾을 수 없습니다.' });
    }
    if (sale.status === 'cancelled') {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, message: '이미 취소된 매출입니다.' });
    }
    const rf = await client.query(`SELECT COALESCE(SUM(quantity),0) AS s FROM refund WHERE sale_id = $1`, [saleId]);
    const already = Number(rf.rows[0].s);
    const maxQty = Number(sale.quantity) - already;
    if (qty > maxQty + 1e-9) {
      await client.query('ROLLBACK');
      return res.status(400).json({ ok: false, message: `환불 가능 수량은 최대 ${maxQty} 입니다.` });
    }
    const wh = await getUserWarehouseLabel(client, userId);
    const cust = await client.query(`SELECT id, name, location, address FROM account WHERE id = $1`, [sale.partner_id]);
    const c = cust.rows[0];
    await upsertInventoryDelta(client, userId, sale.product_id, qty);
    const refIns = await client.query(
      `INSERT INTO refund (user_id, sale_id, quantity, refund_amount, reason, refunded_at, memo)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [userId, saleId, qty, ra, reason?.trim() || null, rAt, memo?.trim() || null]
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
    if (ra != null && ra > 0) {
      const refundPaidAt = parsePaidAtInput(rAt) || new Date();
      await client.query(
        `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo) VALUES ($1,$2,$3,$4,'refund',$5)`,
        [userId, sale.partner_id, ra, refundPaidAt, `환불 #${refundId} ${reason || ''}`.trim().slice(0, 500)]
      );
      await client.query(
        `UPDATE sale SET paid_amount = GREATEST(0, paid_amount - $1), updated_at = NOW() WHERE id = $2`,
        [ra, saleId]
      );
      await syncSalePaymentStatus(client, saleId);
    }
    const newRefunded = already + qty;
    if (newRefunded >= Number(sale.quantity) - 1e-9) {
      await client.query(`UPDATE sale SET status = 'refunded', updated_at = NOW() WHERE id = $1`, [saleId]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ok: true, data: { refund_id: refundId } });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('refund error:', err);
    const code = err.code === 'NEGATIVE_INVENTORY' ? 400 : 500;
    res.status(code).json({ ok: false, message: err.message || '환불 처리에 실패했습니다.' });
  } finally {
    client.release();
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wh = await getUserWarehouseLabel(client, userId);
    await upsertInventoryDelta(client, userId, prid, -qty);
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
    await client.query('ROLLBACK');
    console.error('disposal error:', err);
    const code = err.code === 'NEGATIVE_INVENTORY' ? 400 : 500;
    res.status(code).json({ ok: false, message: err.message || '폐기 등록에 실패했습니다.' });
  } finally {
    client.release();
  }
});

// 파일 전송 테스트: Salesforce ContentVersion 단건 multipart 업로드
app.post('/api/file-transfer/salesforce/content-version', uploadMemory.single('file'), async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });

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
});

app.get('/api/disposals', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = req.query.from_date || '';
  const to = req.query.to_date || '';
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
    q += ' ORDER BY d.disposal_date DESC, d.id DESC';
    const r = await pool.query(q, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('GET disposals error:', err);
    res.status(500).json({ ok: false, message: err.message || '폐기 목록을 불러오지 못했습니다.' });
  }
});

const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
  console.log('  Health: GET /health   Capabilities: GET /api/capabilities (최신 빌드 확인용)');
  const hasDb = process.env.DATABASE_URL || (process.env.PG_HOST && process.env.PG_PASSWORD);
  if (!hasDb) {
    console.warn('DB not configured. Set .env (DATABASE_URL or PG_HOST/PG_PASSWORD) and restart.');
  }
});
