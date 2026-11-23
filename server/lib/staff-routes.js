'use strict';
/**
 * T-213 직원 계정 — 로그인·초대·비밀번호·직원 관리 (설계: 산출물/T-213_직원계정_설계.md 7장)
 *
 *  POST /api/auth/login  (본문에 login_id 가 있을 때)  직원 로그인 → staffLogin()
 *  POST /api/auth/staff/setup-password  초대 코드로 비밀번호 설정(공개, 로그인 제한 키 공유)
 *  GET  /api/me                내 역할·이름·주인 상호·화면 허용 기능
 *  POST /api/me/password       본인 비밀번호 변경(직원: 새 토큰 발급, 옛 토큰 무효)
 *  GET/POST /api/staff, PATCH/DELETE /api/staff/:id, POST /api/staff/:id/{suspend,resume,reset-password,resend-invite}  (주인만)
 *
 * 권한은 lib/access.js 미들웨어가 먼저 막는다. 여기서는 req.auth(주인 id = 데이터 주인)만 쓴다.
 * 비밀번호·초대 코드·토큰은 어떤 기록(audit_log·로그)에도 남기지 않는다(RULE-22).
 *
 * 사용자 확인 기본값(설계 13장 권고) — 환경 변수로 바꿀 수 있다:
 *   U-4 STAFF_MAX_PER_OWNER (기본 10)   주인당 직원 수 상한(삭제된 직원은 세지 않음)
 *   U-5 STAFF_INVITE_HOURS  (기본 24)   초대 코드 유효 시간
 *   U-7 STAFF_TOKEN_TTL_HOURS (기본 = AUTH_TOKEN_TTL_HOURS, 12)  직원 로그인 유지 시간
 *   (U-3·U-6 은 lib/access.js)
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const INVITE_MAX_FAILS = 5;
const LOGIN_ID_RE = /^[a-z0-9_.]{3,30}$/;
const ROLES = ['input', 'view'];
const ROLE_LABEL = { input: '입력 전용', view: '조회 전용', owner: '중매인' };

function envNum(name, def, env = process.env) {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const staffMax = () => Math.floor(envNum('STAFF_MAX_PER_OWNER', 10));
const inviteHours = () => envNum('STAFF_INVITE_HOURS', 24);

const SELECT_STAFF = `id, login_id, name, role, status, email, must_change_password, last_login_at, suspended_at,
  deleted_at, invite_expires_at, created_at, updated_at, (EXTRACT(EPOCH FROM credentials_changed_at) * 1000)::bigint::text AS cv`;

/** 화면에 내보내는 모양 — 해시·코드·cv 는 빼고 */
function publicStaff(r) {
  if (!r) return null;
  return {
    id: r.id,
    login_id: r.login_id,
    name: r.name,
    role: r.role,
    role_label: ROLE_LABEL[r.role] || r.role,
    status: r.status,
    email: r.email,
    must_change_password: !!r.must_change_password,
    last_login_at: r.last_login_at,
    invite_expires_at: r.status === 'invited' ? r.invite_expires_at : null,
    suspended_at: r.suspended_at,
    deleted_at: r.deleted_at,
    created_at: r.created_at,
  };
}
/** 감사 기록용 — 비밀값 없음 */
function auditView(r) {
  return r ? { login_id: r.login_id, name: r.name, role: r.role, status: r.status, email: r.email } : null;
}

function v400(field, message, code = 'VALIDATION') {
  return { status: 400, body: { ok: false, code, field, message } };
}

function registerStaffRoutes(app, deps) {
  const {
    pool, connectOr503, recordAudit, authToken, AUTH, AUTH_TTL_SEC, loginThrottle, loginLockMessage,
    DUMMY_PASSWORD_HASH, passwordProblem, isValidEmail, sendMail, configuredProviders, EXPOSE_DEV_CODE, allowedUi,
  } = deps;
  const staffTtl = () => Math.round(envNum('STAFF_TOKEN_TTL_HOURS', AUTH_TTL_SEC / 3600) * 3600);
  const mailReady = () => configuredProviders().length > 0;

  function throttleKey(agentNo, loginId) {
    return `staff:${String(agentNo).trim().toLowerCase().slice(0, 64)}:${String(loginId).trim().toLowerCase().slice(0, 64)}`;
  }
  function locked(res, key) {
    const ms = loginThrottle.lockedFor(key);
    if (ms <= 0) return false;
    res.setHeader('Retry-After', String(Math.ceil(ms / 1000)));
    res.status(429).json({ ok: false, message: loginLockMessage(ms) });
    return true;
  }
  function signStaffToken(ownerId, agentNo, staffId, cv) {
    return authToken.signToken(AUTH.secret, { userId: ownerId, agentNo, staffId, credVersion: cv }, staffTtl());
  }
  function ownerOnly(req, res) {
    if (req.auth && req.auth.role === 'owner') return req.auth.userId;
    res.status(403).json({ ok: false, code: 'FORBIDDEN_ROLE', message: '권한이 없습니다. 중매인(주인) 계정에 요청하세요.' });
    return null;
  }
  function parseId(raw) {
    const s = String(raw ?? '').trim();
    return /^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null;
  }
  async function newInviteCode() {
    const code = String(crypto.randomInt(100000, 1000000));
    return { code, hash: await bcrypt.hash(code, 10), expiresAt: new Date(Date.now() + inviteHours() * 3600 * 1000) };
  }
  async function sendInvite({ email, ownerName, agentNo, loginId, code }) {
    const base = String(process.env.APP_URL || '').trim().replace(/\/$/, '');
    const text = [
      `판매툴 직원 초대 — ${ownerName}`,
      '',
      `중매인 번호 : ${agentNo}`,
      `직원 ID : ${loginId}`,
      `초대 코드 : ${code}`,
      '',
      `${inviteHours()}시간 안에 판매툴 로그인 화면의 "초대 코드로 비밀번호 설정"${base ? ` (${base}/staff-setup)` : ''}에서 비밀번호를 정해 주세요.`,
    ].join('\n');
    try {
      const r = await sendMail({ to: email, subject: '판매툴 직원 초대', text });
      return { sent: !!r.sent };
    } catch (err) {
      console.error('[staff] 초대 메일 실패:', err.message);
      return { sent: false };
    }
  }
  /** 초대 코드를 만든 뒤의 응답 칸 — 메일 결과·개발용 코드 */
  async function inviteResult(row, code, owner) {
    const out = {};
    if (mailReady()) {
      const m = await sendInvite({ email: row.email, ownerName: owner.name, agentNo: owner.agent_no, loginId: row.login_id, code });
      out.mail_sent = m.sent;
      if (!m.sent) out.message = '초대 메일을 보내지 못했습니다. 임시 비밀번호로 바꾸거나 다시 보내 주세요.';
    } else {
      out.mail_sent = false;
    }
    if (!out.mail_sent && EXPOSE_DEV_CODE) out.dev_code = code; // 개발 환경만(가입 인증과 같은 규칙)
    return out;
  }
  async function ownerInfo(db, ownerId) {
    const r = await db.query('SELECT id, name, agent_no FROM "user" WHERE id = $1', [ownerId]);
    return r.rows[0];
  }

  // ---------- 직원 로그인 (7.1) ----------
  async function staffLogin(req, res) {
    const { agent_no, login_id, password } = req.body || {};
    const key = throttleKey(agent_no, login_id);
    if (locked(res, key)) return undefined;
    const fail = () => {
      if (loginThrottle.fail(key)) console.warn('[login] 직원 연속 실패로 잠시 막음', key.slice(0, 80));
      return res.status(401).json({ ok: false, message: '중매인 번호, 직원 ID 또는 비밀번호가 올바르지 않습니다.' });
    };
    try {
      const r = await pool.query(
        `SELECT u.id AS owner_id, u.user_key, u.name AS owner_name, u.agent_no, u.status AS owner_status,
                s.id, s.login_id, s.name, s.role, s.status, s.password_hash, s.must_change_password,
                (EXTRACT(EPOCH FROM s.credentials_changed_at) * 1000)::bigint::text AS cv
           FROM "user" u
           JOIN staff_account s ON s.owner_user_id = u.id AND s.login_id = $2 AND s.status <> 'deleted'
          WHERE u.agent_no = $1`,
        [String(agent_no).trim(), String(login_id).trim().toLowerCase().slice(0, 30)]
      );
      const row = r.rows[0];
      // 없는 번호·없는 직원·초대 중(비밀번호 없음)도 bcrypt 1회 → 같은 401 (RULE-23)
      const match = await bcrypt.compare(String(password), row && row.password_hash ? row.password_hash : DUMMY_PASSWORD_HASH);
      if (!row || !row.password_hash || !match) return fail();
      // 상태는 비밀번호가 맞을 때만 알려 준다 (RULE-14·18)
      if (row.owner_status !== 'active') return res.status(403).json({ ok: false, message: '중매인 계정이 사용 중지되었습니다.' });
      if (row.status !== 'active') return res.status(403).json({ ok: false, message: '정지된 직원 계정입니다.' });
      loginThrottle.reset(key);
      await pool.query('UPDATE staff_account SET last_login_at = NOW() WHERE id = $1', [row.id]);
      await recordAudit(pool, { userId: row.owner_id, entityType: 'auth', action: 'login', note: `직원 로그인(${row.name})`, actorStaffId: row.id });
      const token = signStaffToken(row.owner_id, row.agent_no, row.id, row.cv);
      return res.json({
        ok: true,
        token,
        expires_in: staffTtl(),
        user: {
          id: row.owner_id,
          user_key: row.user_key,
          name: row.owner_name,
          agent_no: row.agent_no,
          is_admin: false,
          staff: { id: row.id, login_id: row.login_id, name: row.name, role: row.role, role_label: ROLE_LABEL[row.role], must_change_password: !!row.must_change_password },
        },
      });
    } catch (err) {
      console.error('Staff login error:', err.message);
      return res.status(500).json({ ok: false, message: '로그인 처리 중 오류가 발생했습니다.' });
    }
  }

  // ---------- 초대 코드로 비밀번호 설정 (7.3) ----------
  app.post('/api/auth/staff/setup-password', async (req, res) => {
    const { agent_no, login_id, code, new_password } = req.body || {};
    if (!agent_no || !login_id || !code || new_password === undefined) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', message: '중매인 번호, 직원 ID, 초대 코드, 새 비밀번호를 입력하세요.' });
    }
    const pw = passwordProblem(new_password);
    if (pw) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'new_password', message: pw });
    const key = throttleKey(agent_no, login_id);
    if (locked(res, key)) return undefined;
    const BAD = '초대 코드가 맞지 않거나 만료되었습니다.';
    const client = await connectOr503(res);
    if (!client) return undefined;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `SELECT s.id, s.owner_user_id, s.name, s.invite_code_hash, s.invite_fail_count, (s.invite_expires_at > NOW()) AS alive
           FROM staff_account s JOIN "user" u ON u.id = s.owner_user_id
          WHERE u.agent_no = $1 AND s.login_id = $2 AND s.status = 'invited'
          FOR UPDATE OF s`,
        [String(agent_no).trim(), String(login_id).trim().toLowerCase().slice(0, 30)]
      );
      const row = r.rows[0];
      const usable = row && row.invite_code_hash && row.alive;
      const match = await bcrypt.compare(String(code).trim(), usable ? row.invite_code_hash : DUMMY_PASSWORD_HASH);
      if (!usable || !match) {
        loginThrottle.fail(key);
        if (row && row.invite_code_hash) {
          const u = await client.query(
            `UPDATE staff_account SET invite_fail_count = invite_fail_count + 1,
                    invite_code_hash = CASE WHEN invite_fail_count + 1 >= $2 THEN NULL ELSE invite_code_hash END,
                    invite_expires_at = CASE WHEN invite_fail_count + 1 >= $2 THEN NULL ELSE invite_expires_at END,
                    updated_at = NOW()
              WHERE id = $1 RETURNING invite_fail_count`,
            [row.id, INVITE_MAX_FAILS]
          );
          await client.query('COMMIT');
          const n = u.rows[0].invite_fail_count;
          if (n >= INVITE_MAX_FAILS) {
            return res.status(400).json({ ok: false, code: 'INVITE_INVALID', message: `초대 코드를 ${INVITE_MAX_FAILS}회 잘못 입력했습니다. 중매인(주인)에게 초대를 다시 보내 달라고 하세요.` });
          }
          return res.status(400).json({ ok: false, code: 'INVITE_INVALID', message: `${BAD} (남은 시도 ${INVITE_MAX_FAILS - n}회)` });
        }
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, code: 'INVITE_INVALID', message: BAD });
      }
      const hash = await bcrypt.hash(String(new_password), 10);
      await client.query(
        `UPDATE staff_account SET password_hash = $2, status = 'active', must_change_password = false,
                invite_code_hash = NULL, invite_expires_at = NULL, invite_fail_count = 0,
                credentials_changed_at = NOW(), updated_at = NOW()
          WHERE id = $1`,
        [row.id, hash]
      );
      await recordAudit(client, {
        userId: row.owner_user_id, entityType: 'staff', entityId: row.id, action: 'password_set', actorStaffId: row.id,
        before: { status: 'invited' }, after: { status: 'active' }, note: `초대 수락·비밀번호 설정(${row.name})`,
      });
      await client.query('COMMIT');
      loginThrottle.reset(key);
      return res.json({ ok: true, message: '비밀번호를 정했습니다. 로그인해 주세요.' });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('setup-password error:', err.message);
      return res.status(500).json({ ok: false, message: '비밀번호를 설정하지 못했습니다.' });
    } finally {
      client.release();
    }
  });

  // ---------- 내 정보 (R-44) ----------
  app.get('/api/me', async (req, res) => {
    const a = req.auth;
    if (!a) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    let staff = null;
    if (a.staffId) {
      const r = await pool.query('SELECT id, login_id, name, role FROM staff_account WHERE id = $1', [a.staffId]).catch(() => ({ rows: [] }));
      const s = r.rows[0];
      staff = s ? { id: s.id, login_id: s.login_id, name: s.name, role: s.role, role_label: ROLE_LABEL[s.role] } : null;
    }
    return res.json({
      ok: true,
      owner: { id: a.userId, name: a.ownerName, agent_no: a.agentNo },
      staff,
      role: a.role,
      role_label: ROLE_LABEL[a.role],
      is_admin: !!a.isAdmin,
      must_change_password: !!a.mustChangePassword,
      allow: allowedUi(a.role),
    });
  });

  // ---------- 본인 비밀번호 변경 (R-45) ----------
  app.post('/api/me/password', async (req, res) => {
    const a = req.auth;
    if (!a) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const { current_password, new_password } = req.body || {};
    if (current_password === undefined || new_password === undefined) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', message: '현재 비밀번호와 새 비밀번호를 입력하세요.' });
    }
    const pw = passwordProblem(new_password);
    if (pw) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'new_password', message: pw });
    if (String(current_password) === String(new_password)) {
      return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'new_password', message: '새 비밀번호가 지금 비밀번호와 같습니다.' });
    }
    const client = await connectOr503(res);
    if (!client) return undefined;
    try {
      await client.query('BEGIN');
      if (a.role === 'owner') {
        const r = await client.query('SELECT password_hash FROM "user" WHERE id = $1 FOR UPDATE', [a.userId]);
        if (!r.rows[0] || !(await bcrypt.compare(String(current_password), r.rows[0].password_hash))) {
          await client.query('ROLLBACK');
          return res.status(400).json({ ok: false, code: 'WRONG_PASSWORD', field: 'current_password', message: '현재 비밀번호가 맞지 않습니다.' });
        }
        await client.query('UPDATE "user" SET password_hash = $2, updated_at = NOW() WHERE id = $1', [a.userId, await bcrypt.hash(String(new_password), 10)]);
        await client.query('COMMIT');
        return res.json({ ok: true, message: '비밀번호를 바꿨습니다.' });
      }
      const r = await client.query('SELECT id, name, password_hash FROM staff_account WHERE id = $1 AND owner_user_id = $2 FOR UPDATE', [a.staffId, a.userId]);
      const s = r.rows[0];
      if (!s || !s.password_hash || !(await bcrypt.compare(String(current_password), s.password_hash))) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, code: 'WRONG_PASSWORD', field: 'current_password', message: '현재 비밀번호가 맞지 않습니다.' });
      }
      const u = await client.query(
        `UPDATE staff_account SET password_hash = $2, must_change_password = false, credentials_changed_at = clock_timestamp(), updated_at = NOW()
          WHERE id = $1 RETURNING (EXTRACT(EPOCH FROM credentials_changed_at) * 1000)::bigint::text AS cv`,
        [s.id, await bcrypt.hash(String(new_password), 10)]
      );
      await recordAudit(client, {
        userId: a.userId, entityType: 'staff', entityId: s.id, action: 'password_set', actorStaffId: s.id,
        before: { must_change_password: !!a.mustChangePassword, credentials_changed: false },
        after: { must_change_password: false, credentials_changed: true }, note: `직원 비밀번호 변경(${s.name})`,
      });
      await client.query('COMMIT');
      // 옛 토큰은 cv 가 달라 무효 → 화면이 계속 쓰도록 새 토큰을 준다
      const token = signStaffToken(a.userId, a.agentNo, s.id, u.rows[0].cv);
      return res.json({ ok: true, message: '비밀번호를 바꿨습니다.', token, expires_in: staffTtl() });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('me/password error:', err.message);
      return res.status(500).json({ ok: false, message: '비밀번호를 바꾸지 못했습니다.' });
    } finally {
      client.release();
    }
  });

  // ---------- 직원 목록 (R-46) ----------
  app.get('/api/staff', async (req, res) => {
    const ownerId = ownerOnly(req, res);
    if (!ownerId) return undefined;
    const withDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true';
    try {
      const r = await pool.query(
        `SELECT ${SELECT_STAFF} FROM staff_account WHERE owner_user_id = $1 ${withDeleted ? '' : "AND status <> 'deleted'"}
          ORDER BY (status = 'deleted'), created_at, id`,
        [ownerId]
      );
      return res.json({
        ok: true,
        data: r.rows.map(publicStaff),
        limit: staffMax(),
        mail_ready: mailReady(),
        invite_hours: inviteHours(),
      });
    } catch (err) {
      console.error('GET staff error:', err.message);
      return res.status(500).json({ ok: false, message: '직원 목록을 불러오지 못했습니다.' });
    }
  });

  // ---------- 직원 만들기 (R-47, 7.2) ----------
  app.post('/api/staff', async (req, res) => {
    const ownerId = ownerOnly(req, res);
    if (!ownerId) return undefined;
    const b = req.body || {};
    const loginId = String(b.login_id ?? '').trim().toLowerCase();
    const name = String(b.name ?? '').trim();
    const role = String(b.role ?? '').trim();
    const email = b.email != null && String(b.email).trim() ? String(b.email).trim() : null;
    const temp = b.temp_password != null && String(b.temp_password) !== '' ? String(b.temp_password) : null;
    let bad = null;
    if (!LOGIN_ID_RE.test(loginId)) bad = v400('login_id', '직원 ID는 영문 소문자·숫자·밑줄(_)·점(.)으로 3~30자입니다.');
    else if (!name || [...name].length > 50) bad = v400('name', '이름을 50자 이내로 입력하세요.');
    else if (!ROLES.includes(role)) bad = v400('role', '역할은 입력 전용(input) 또는 조회 전용(view)입니다.');
    else if (email && (!isValidEmail(email) || email.length > 255)) bad = v400('email', '이메일 형식이 올바르지 않습니다.');
    else if (temp && passwordProblem(temp)) bad = v400('temp_password', passwordProblem(temp));
    else if (!temp && !email) bad = v400('temp_password', '임시 비밀번호나 이메일 중 하나를 넣으세요.');
    else if (!temp && !mailReady() && !EXPOSE_DEV_CODE) {
      bad = { status: 400, body: { ok: false, code: 'MAIL_NOT_CONFIGURED', field: 'email', message: '메일 발송이 설정되어 있지 않습니다. 임시 비밀번호로 만드세요.' } };
    }
    if (bad) return res.status(bad.status).json(bad.body);

    const client = await connectOr503(res);
    if (!client) return undefined;
    let row;
    let code = null;
    let owner;
    try {
      await client.query('BEGIN');
      // 상한 검사와 INSERT 를 주인 행 잠금 뒤 한 트랜잭션으로 — 동시에 만들어 상한을 넘는 것 방지
      owner = (await client.query('SELECT id, name, agent_no FROM "user" WHERE id = $1 FOR UPDATE', [ownerId])).rows[0];
      const cnt = await client.query(`SELECT COUNT(*)::int AS n FROM staff_account WHERE owner_user_id = $1 AND status <> 'deleted'`, [ownerId]);
      if (cnt.rows[0].n >= staffMax()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ ok: false, code: 'STAFF_LIMIT', message: `직원은 ${staffMax()}명까지 만들 수 있습니다.` });
      }
      if (temp) {
        const hash = await bcrypt.hash(temp, 10);
        row = (await client.query(
          `INSERT INTO staff_account (owner_user_id, login_id, name, role, email, password_hash, must_change_password, status)
           VALUES ($1,$2,$3,$4,$5,$6,true,'active') RETURNING ${SELECT_STAFF}`,
          [ownerId, loginId, name, role, email, hash]
        )).rows[0];
      } else {
        const inv = await newInviteCode();
        code = inv.code;
        row = (await client.query(
          `INSERT INTO staff_account (owner_user_id, login_id, name, role, email, status, invite_code_hash, invite_expires_at)
           VALUES ($1,$2,$3,$4,$5,'invited',$6,$7) RETURNING ${SELECT_STAFF}`,
          [ownerId, loginId, name, role, email, inv.hash, inv.expiresAt]
        )).rows[0];
      }
      await recordAudit(client, {
        userId: ownerId, entityType: 'staff', entityId: row.id, action: 'create', after: auditView(row),
        note: temp ? '직원 추가(임시 비밀번호)' : '직원 추가(이메일 초대)',
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') return res.status(409).json({ ok: false, code: 'LOGIN_ID_TAKEN', field: 'login_id', message: '이미 쓰고 있는 직원 ID입니다.' });
      console.error('POST staff error:', err.message);
      return res.status(500).json({ ok: false, message: '직원을 만들지 못했습니다.' });
    } finally {
      client.release();
    }
    const extra = code ? await inviteResult(row, code, owner) : {};
    return res.status(201).json({ ok: true, data: publicStaff(row), ...extra });
  });

  /** :id 직원을 잠그고 읽는다 — 남의 직원·삭제된 직원은 404 */
  async function lockStaff(client, ownerId, id) {
    const r = await client.query(
      `SELECT ${SELECT_STAFF} FROM staff_account WHERE id = $1 AND owner_user_id = $2 AND status <> 'deleted' FOR UPDATE`,
      [id, ownerId]
    );
    return r.rows[0] || null;
  }
  const NOT_FOUND = { ok: false, code: 'NOT_FOUND', message: '직원을 찾을 수 없습니다.' };

  /** 직원 하나를 바꾸는 라우트 공통 틀 — fn(client, row) 이 { status?, body } 또는 바뀐 row 를 돌려준다 */
  function staffAction(method, path, fn) {
    app[method](path, async (req, res) => {
      const ownerId = ownerOnly(req, res);
      if (!ownerId) return undefined;
      const id = parseId(req.params.id);
      if (!id) return res.status(404).json(NOT_FOUND);
      const client = await connectOr503(res);
      if (!client) return undefined;
      let out;
      try {
        await client.query('BEGIN');
        const row = await lockStaff(client, ownerId, id);
        if (!row) {
          await client.query('ROLLBACK');
          return res.status(404).json(NOT_FOUND);
        }
        out = await fn({ client, row, ownerId, body: req.body || {} });
        if (out.error) {
          await client.query('ROLLBACK');
          return res.status(out.error.status).json(out.error.body);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err.code === '23505') return res.status(409).json({ ok: false, code: 'LOGIN_ID_TAKEN', message: '이미 쓰고 있는 직원 ID입니다.' });
        console.error(`${method.toUpperCase()} ${path} error:`, err.message);
        return res.status(500).json({ ok: false, message: '직원 정보를 바꾸지 못했습니다.' });
      } finally {
        client.release();
      }
      const extra = out.after ? await out.after() : {};
      return res.json({ ok: true, data: publicStaff(out.row), ...extra });
    });
  }
  const invalidState = (message) => ({ error: { status: 409, body: { ok: false, code: 'INVALID_STATE', message } } });

  // 이름·역할·이메일 수정 (R-48) — 역할 변경은 다음 요청부터(토큰 그대로, RULE-02)
  staffAction('patch', '/api/staff/:id', async ({ client, row, ownerId, body }) => {
    const set = {};
    if (body.name !== undefined) {
      const n = String(body.name ?? '').trim();
      if (!n || [...n].length > 50) return { error: v400('name', '이름을 50자 이내로 입력하세요.') };
      set.name = n;
    }
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) return { error: v400('role', '역할은 입력 전용(input) 또는 조회 전용(view)입니다.') };
      set.role = body.role;
    }
    if (body.email !== undefined) {
      const e = body.email != null && String(body.email).trim() ? String(body.email).trim() : null;
      if (e && (!isValidEmail(e) || e.length > 255)) return { error: v400('email', '이메일 형식이 올바르지 않습니다.') };
      if (!e && row.status === 'invited') return { error: v400('email', '초대 중인 직원은 이메일을 지울 수 없습니다.') };
      set.email = e;
    }
    const keys = Object.keys(set);
    if (!keys.length) return { row };
    const params = [row.id, ...keys.map((k) => set[k])];
    const upd = (await client.query(
      `UPDATE staff_account SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING ${SELECT_STAFF}`,
      params
    )).rows[0];
    await recordAudit(client, { userId: ownerId, entityType: 'staff', entityId: row.id, action: 'update', before: auditView(row), after: auditView(upd), note: '직원 정보 수정' });
    return { row: upd };
  });

  // 정지 (R-49, RULE-14) — 이미 받은 토큰도 다음 요청부터 401
  staffAction('post', '/api/staff/:id/suspend', async ({ client, row, ownerId }) => {
    if (row.status !== 'active') return invalidState(row.status === 'invited' ? '초대 중인 직원은 정지 대신 삭제하세요.' : '이미 정지된 직원입니다.');
    const upd = (await client.query(
      `UPDATE staff_account SET status = 'suspended', suspended_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING ${SELECT_STAFF}`,
      [row.id]
    )).rows[0];
    await recordAudit(client, { userId: ownerId, entityType: 'staff', entityId: row.id, action: 'suspend', before: auditView(row), after: auditView(upd), note: '직원 정지' });
    return { row: upd };
  });

  // 되살리기 (R-50)
  staffAction('post', '/api/staff/:id/resume', async ({ client, row, ownerId }) => {
    if (row.status !== 'suspended') return invalidState('정지된 직원만 되살릴 수 있습니다.');
    const upd = (await client.query(
      `UPDATE staff_account SET status = 'active', suspended_at = NULL, updated_at = NOW() WHERE id = $1 RETURNING ${SELECT_STAFF}`,
      [row.id]
    )).rows[0];
    await recordAudit(client, { userId: ownerId, entityType: 'staff', entityId: row.id, action: 'resume', before: auditView(row), after: auditView(upd), note: '직원 되살리기' });
    return { row: upd };
  });

  // 임시 비밀번호 재설정 (R-51, RULE-16) — 기존 토큰 전부 무효, 다음 로그인 때 변경 강제
  staffAction('post', '/api/staff/:id/reset-password', async ({ client, row, ownerId, body }) => {
    const temp = body.temp_password != null ? String(body.temp_password) : '';
    const pw = passwordProblem(temp);
    if (pw) return { error: v400('temp_password', pw) };
    const upd = (await client.query(
      `UPDATE staff_account SET password_hash = $2, must_change_password = true, credentials_changed_at = clock_timestamp(),
              status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
              invite_code_hash = NULL, invite_expires_at = NULL, invite_fail_count = 0, updated_at = NOW()
        WHERE id = $1 RETURNING ${SELECT_STAFF}`,
      [row.id, await bcrypt.hash(temp, 10)]
    )).rows[0];
    await recordAudit(client, {
      userId: ownerId, entityType: 'staff', entityId: row.id, action: 'password_reset',
      before: { ...auditView(row), password_reset: false }, after: { ...auditView(upd), password_reset: true }, note: '직원 임시 비밀번호 재설정',
    });
    return { row: upd };
  });

  // 초대 코드 다시 보내기 (R-52) — 이전 코드는 무효
  staffAction('post', '/api/staff/:id/resend-invite', async ({ client, row, ownerId }) => {
    if (row.status !== 'invited') return invalidState('초대 중인 직원에게만 다시 보낼 수 있습니다.');
    if (!row.email) return { error: v400('email', '이메일이 없습니다. 이메일을 넣거나 임시 비밀번호로 바꾸세요.') };
    if (!mailReady() && !EXPOSE_DEV_CODE) {
      return { error: { status: 400, body: { ok: false, code: 'MAIL_NOT_CONFIGURED', message: '메일 발송이 설정되어 있지 않습니다. 임시 비밀번호로 바꾸세요.' } } };
    }
    const inv = await newInviteCode();
    const upd = (await client.query(
      `UPDATE staff_account SET invite_code_hash = $2, invite_expires_at = $3, invite_fail_count = 0, updated_at = NOW()
        WHERE id = $1 RETURNING ${SELECT_STAFF}`,
      [row.id, inv.hash, inv.expiresAt]
    )).rows[0];
    await recordAudit(client, {
      userId: ownerId, entityType: 'staff', entityId: row.id, action: 'invite',
      before: { invite_sent: false }, after: { invite_sent: true }, note: '직원 초대 다시 보내기',
    });
    const owner = await ownerInfo(client, ownerId);
    return { row: upd, after: () => inviteResult(upd, inv.code, owner) };
  });

  // 삭제 (R-53, RULE-15) — 되돌릴 수 없음. 행은 남기고(입력자 표시) 이메일·비밀번호·코드를 지운다. 같은 ID 를 다시 쓸 수 있다
  staffAction('delete', '/api/staff/:id', async ({ client, row, ownerId }) => {
    const upd = (await client.query(
      `UPDATE staff_account SET status = 'deleted', deleted_at = NOW(), email = NULL, password_hash = NULL,
              invite_code_hash = NULL, invite_expires_at = NULL, must_change_password = false, updated_at = NOW()
        WHERE id = $1 RETURNING ${SELECT_STAFF}`,
      [row.id]
    )).rows[0];
    await recordAudit(client, {
      userId: ownerId, entityType: 'staff', entityId: row.id, action: 'delete',
      before: { login_id: row.login_id, name: row.name, role: row.role, status: row.status }, after: { login_id: upd.login_id, name: upd.name, role: upd.role, status: 'deleted' },
      note: '직원 삭제',
    });
    return { row: upd };
  });

  return { staffLogin };
}

module.exports = { registerStaffRoutes, ROLE_LABEL };
