const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
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

// 이메일 발송 (SMTP 미설정 시 콘솔에 인증번호만 출력)
function getMailTransporter() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (host && user && pass) {
    return nodemailer.createTransport({ host, port: Number(process.env.SMTP_PORT) || 587, secure: false, auth: { user, pass } });
  }
  return null;
}
async function sendVerificationEmail(email, code) {
  const transporter = getMailTransporter();
  const subject = '판매툴 인증';
  const text = `판매툴 인증\n\n인증번호 : ${code}\n\n5분 안에 입력해 주세요.`;
  if (transporter) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject,
      text,
    });
    return { sent: true };
  }
  console.log('[이메일 인증] SMTP 미설정 — 인증번호:', code, '→', email);
  return { sent: false, code };
}

app.use(express.json());

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
    res.status(500).json({ ok: false, available: false });
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
    res.status(500).json({ ok: false, available: false });
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
      sendResult = { sent: false, code };
    }
    const payload = { ok: true, message: sendResult.sent ? '인증번호가 발송되었습니다. 5분 안에 입력하세요.' : '인증번호가 생성되었습니다. 아래 번호를 입력하세요. (이메일 미발송)' };
    if (!sendResult.sent && sendResult.code) payload.dev_code = sendResult.code;
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
    res.status(500).json({ ok: false, message: '인증 처리에 실패했습니다.' });
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

// ---------- 메인 화면용 API (X-Agent-No 헤더 필수, 중매인 번호 기준으로 해당 회원 데이터 조회) ----------

// 상품 목록 (전체 공통, 관리자 탭에서도 사용)
app.get('/api/products', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, unit, category, memo, created_at, updated_at FROM product ORDER BY name');
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ ok: false });
  }
});

// 거래처 목록 (중매인 번호 기준 — 내 회원)
app.get('/api/partners', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  try {
    const r = await pool.query('SELECT id, name, type, contact, phone FROM account WHERE user_id = $1 ORDER BY name', [userId]);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Partners error:', err);
    res.status(500).json({ ok: false });
  }
});

// 재고현황 (중매인 번호 기준)
app.get('/api/inventory', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  try {
    const r = await pool.query(
      `SELECT i.id, i.product_id, i.quantity, i.updated_at, p.name AS product_name, p.unit
       FROM inventory i
       JOIN product p ON p.id = i.product_id
       WHERE i.user_id = $1 AND i.quantity > 0
       ORDER BY p.name`,
      [userId]
    );
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Inventory error:', err);
    res.status(500).json({ ok: false });
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
    let q = `SELECT pu.id, pu.purchase_date, pu.quantity, pu.unit_price, pu.total_amount, pu.memo,
             p.name AS product_name, p.unit, pt.name AS partner_name
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
    res.status(500).json({ ok: false });
  }
});

// 매출정보 (중매인 번호 기준, 기간·거래처별 검색)
app.get('/api/sales', async (req, res) => {
  const userId = await getUserId(req);
  if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
  const from = req.query.from_date || '';
  const to = req.query.to_date || '';
  const partnerId = req.query.partner_id ? parseInt(req.query.partner_id, 10) : null;
  try {
    let q = `SELECT s.id, s.sale_date, s.quantity, s.unit_price, s.total_amount, s.payment_status, s.paid_amount, s.memo,
             p.name AS product_name, p.unit, pt.name AS partner_name
             FROM sale s
             JOIN product p ON p.id = s.product_id
             JOIN account pt ON pt.id = s.partner_id
             WHERE s.user_id = $1`;
    const params = [userId];
    if (from) { params.push(from); q += ` AND s.sale_date >= $${params.length}`; }
    if (to) { params.push(to); q += ` AND s.sale_date <= $${params.length}`; }
    if (partnerId && Number.isFinite(partnerId)) { params.push(partnerId); q += ` AND s.partner_id = $${params.length}`; }
    q += ' ORDER BY s.sale_date DESC, s.id DESC';
    const r = await pool.query(q, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Sales error:', err);
    res.status(500).json({ ok: false });
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
    let q = `SELECT py.id, py.paid_at, py.amount, py.memo, pt.name AS partner_name
             FROM payment py
             JOIN account pt ON pt.id = py.partner_id
             WHERE py.user_id = $1`;
    const params = [userId];
    if (from) { params.push(from); q += ` AND py.paid_at >= $${params.length}`; }
    if (to) { params.push(to); q += ` AND py.paid_at <= $${params.length}`; }
    if (partnerId && Number.isFinite(partnerId)) { params.push(partnerId); q += ` AND py.partner_id = $${params.length}`; }
    q += ' ORDER BY py.paid_at DESC, py.id DESC';
    const r = await pool.query(q, params);
    res.json({ ok: true, data: r.rows });
  } catch (err) {
    console.error('Payments error:', err);
    res.status(500).json({ ok: false });
  }
});

const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => {
  console.log(`Server listening on http://${host}:${port}`);
  const hasDb = process.env.DATABASE_URL || (process.env.PG_HOST && process.env.PG_PASSWORD);
  if (!hasDb) {
    console.warn('DB not configured. Set .env (DATABASE_URL or PG_HOST/PG_PASSWORD) and restart.');
  }
});
