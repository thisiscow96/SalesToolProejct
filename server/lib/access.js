'use strict';
/**
 * T-213 라우트 권한 표 + 기본 거부 미들웨어 (설계: 산출물/T-213_직원계정_설계.md 5·6장)
 *
 * 역할: owner(주인 — 토큰에 act 없음) · input(입력 전용 직원) · view(조회 전용 직원)
 *  - 모든 /api 요청은 이 표를 먼저 지난다(index.js 에서 express.json 바로 다음 app.use).
 *  - 표에 없는 /api 라우트는 직원에게 403 ROUTE_NOT_ALLOWED(기본 거부, RULE-06). 주인은 그대로 통과.
 *  - 관리자 라우트는 주인만 통과시키고, 관리자 여부는 기존 라우트 검사(auth.isAdmin)에 맡긴다 → 기존 문구 그대로.
 *    직원은 주인이 관리자여도 isAdmin=false(RULE-19).
 *  - 새 라우트를 만들면 여기에 한 줄을 꼭 더한다. scripts/staff-access-test.js 의 점검이 빠진 줄·남는 줄을 잡는다.
 *
 * 규칙 한 줄: [id, method, path, allow, opts]
 *   allow: 'public' | 'optional' | ['owner','input','view'] 의 부분집합
 *   opts.check(req) → null | { field, message }   직원(입력)의 본문 조건 — 어기면 403 FIELD_NOT_ALLOWED
 *   opts.gate(req)  → null | { status, body }      토큰 검사보다 먼저 보는 조건(R-43 파일 전송 꺼짐 → 404)
 *   opts.ui         화면이 버튼을 숨길 때 쓰는 이름(GET /api/me 의 allow 목록)
 *
 * 사용자 확인 기본값(설계 13장 U-1~U-9 권고값) — 환경 변수로 바꿀 수 있다:
 *   U-3 STAFF_INPUT_CAN_CONFIRM_CREDIT=true  → 입력 직원도 외상 한도 넘김을 확인·저장(기본 false)
 *   U-6 STAFF_INPUT_EXTRA=partner.create,product.personal,disposal.create → 입력 직원에게 해당 쓰기를 연다(기본 없음)
 *   (U-4 상한·U-5 초대 유효·U-7 로그인 유지는 lib/staff-routes.js)
 */
const { isCreditConfirmed } = require('./credit-limit');

const ALL = ['owner', 'input', 'view'];
const OWNER = ['owner'];
const WRITE = ['owner', 'input'];

function envFlag(name, env = process.env) {
  const v = String(env[name] || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

// RULE-08 (U-3): 입력 직원은 외상 한도 넘김을 스스로 확인해 저장할 수 없다
function noCreditConfirm(req) {
  if (envFlag('STAFF_INPUT_CAN_CONFIRM_CREDIT')) return null;
  if (!isCreditConfirmed(req.body)) return null;
  return { field: 'credit_confirmed', message: '외상 한도를 넘는 판매는 중매인(주인) 확인이 필요합니다.' };
}
// RULE-07: 입력 직원의 수금 등록은 entry_kind 가 없거나 receive 일 때만
function receiveOnly(req) {
  const k = req.body && typeof req.body === 'object' ? req.body.entry_kind : undefined;
  if (k === undefined || k === null || k === '' || k === 'receive') return null;
  return { field: 'entry_kind', message: '환불 등록은 중매인(주인)만 할 수 있습니다.' };
}
// R-43 (F-17): 파일 전송 기능이 꺼져 있으면 로그인 확인보다 먼저 404 — 기존 보안 회귀 N-10 그대로
function sfUploadGate() {
  if (process.env.ENABLE_SF_UPLOAD === 'true') return null;
  return { status: 404, body: { ok: false, message: '파일 전송 기능이 꺼져 있습니다.' } };
}

/** U-6: 입력 직원에게 열 수 있는 설정성 쓰기 */
function inputExtra(ui, env = process.env) {
  const list = String(env.STAFF_INPUT_EXTRA || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(ui) ? WRITE : OWNER;
}

function buildRules(env = process.env) {
  return [
    // ---- 5.1 공개 (토큰 검사 안 함) ----
    ['R-P01', 'GET', '/', 'public'],
    ['R-P02', 'GET', '/health', 'public'],
    ['R-P03', 'POST', '/api/auth/check-email', 'public'],
    ['R-P04', 'POST', '/api/auth/check-agent-no', 'public'],
    ['R-P05', 'POST', '/api/auth/send-email-verification', 'public'],
    ['R-P06', 'POST', '/api/auth/verify-email-code', 'public'],
    ['R-P07', 'POST', '/api/auth/register', 'public'],
    ['R-P08', 'POST', '/api/auth/login', 'public'],
    ['R-P09', 'GET', '/api/capabilities', 'public'],
    ['R-P10', 'POST', '/api/auth/staff/setup-password', 'public'],

    // ---- 5.2 로그인 필요 ----
    ['R-01', 'GET', '/api/products', 'optional'],
    ['R-02', 'POST', '/api/products', OWNER, { ui: 'product.master' }], // 관리자 — 기존 라우트가 isAdmin 검사
    ['R-03', 'POST', '/api/products/bulk', OWNER, { ui: 'product.master' }],
    ['R-04', 'POST', '/api/products/personal', inputExtra('product.personal', env), { ui: 'product.personal' }],
    ['R-05', 'POST', '/api/products/requests', OWNER, { ui: 'product.request' }],
    ['R-06', 'GET', '/api/products/requests', ALL],
    ['R-07', 'POST', '/api/products/requests/:id/approve', OWNER, { ui: 'product.review' }],
    ['R-08', 'POST', '/api/products/requests/:id/reject', OWNER, { ui: 'product.review' }],
    ['R-09', 'GET', '/api/partners', ALL],
    ['R-10', 'POST', '/api/partners', inputExtra('partner.create', env), { ui: 'partner.create' }],
    ['R-11', 'PUT', '/api/partners/:id', OWNER, { ui: 'partner.update' }], // 거래처 수정·외상 한도(T-207)
    ['R-12', 'GET', '/api/partners/:id/ledger', ALL],
    ['R-13', 'GET', '/api/receivables/aging', ALL],
    ['R-14', 'GET', '/api/dashboard', ALL],
    ['R-15', 'GET', '/api/history', OWNER], // RULE-05 로그인·직원 관리 기록
    ['R-16', 'POST', '/api/supplier-payments', OWNER, { ui: 'supplier_payment.create' }],
    ['R-17', 'GET', '/api/supplier-payments', ALL],
    ['R-18', 'POST', '/api/supplier-payments/:id/cancel', OWNER, { ui: 'supplier_payment.cancel' }],
    ['R-19', 'GET', '/api/partners/:id/payable-ledger', ALL],
    ['R-20', 'GET', '/api/payables/aging', ALL],
    ['R-21', 'GET', '/api/inventory', ALL],
    ['R-22', 'GET', '/api/purchases', ALL],
    ['R-23', 'GET', '/api/purchases/last-price', ALL],
    ['R-24', 'GET', '/api/purchases/recent-partners', ALL],
    ['R-25', 'GET', '/api/sales', ALL],
    ['R-26', 'GET', '/api/sales/statement', ALL],
    ['R-27', 'GET', '/api/reports/daily-purchase-sales', ALL],
    ['R-28', 'GET', '/api/reports/daily-purchase-sales-breakdown', ALL],
    ['R-29', 'GET', '/api/payments', ALL],
    ['R-30', 'POST', '/api/purchases', WRITE, { ui: 'purchase.create' }],
    ['R-31', 'POST', '/api/purchases/convert-to-sales', WRITE, { ui: 'sale.convert', check: noCreditConfirm }],
    ['R-32', 'GET', '/api/inventory/:productId/fifo-preview', ALL],
    ['R-33', 'POST', '/api/sales', WRITE, { ui: 'sale.create', check: noCreditConfirm }],
    ['R-34', 'POST', '/api/payments', WRITE, { ui: 'payment.create', check: receiveOnly }],
    ['R-35', 'POST', '/api/sales/:saleId/refund', OWNER, { ui: 'sale.refund' }],
    ['R-36', 'POST', '/api/purchases/:id/cancel', OWNER, { ui: 'purchase.cancel' }],
    ['R-37', 'PATCH', '/api/purchases/:id', OWNER, { ui: 'purchase.update' }],
    ['R-38', 'POST', '/api/sales/:id/cancel', OWNER, { ui: 'sale.cancel' }],
    ['R-39', 'PATCH', '/api/sales/:id', OWNER, { ui: 'sale.update' }],
    ['R-40', 'GET', '/api/corrections', ALL],
    ['R-41', 'POST', '/api/disposals', inputExtra('disposal.create', env), { ui: 'disposal.create' }],
    ['R-42', 'GET', '/api/disposals', ALL],
    ['R-43', 'POST', '/api/file-transfer/salesforce/content-version', OWNER, { gate: sfUploadGate }],

    // ---- 5.3 새 라우트 (T-213) ----
    ['R-44', 'GET', '/api/me', ALL],
    ['R-45', 'POST', '/api/me/password', ALL, { ui: 'me.password' }],
    ['R-46', 'GET', '/api/staff', OWNER],
    ['R-47', 'POST', '/api/staff', OWNER, { ui: 'staff.manage' }],
    ['R-48', 'PATCH', '/api/staff/:id', OWNER, { ui: 'staff.manage' }],
    ['R-49', 'POST', '/api/staff/:id/suspend', OWNER, { ui: 'staff.manage' }],
    ['R-50', 'POST', '/api/staff/:id/resume', OWNER, { ui: 'staff.manage' }],
    ['R-51', 'POST', '/api/staff/:id/reset-password', OWNER, { ui: 'staff.manage' }],
    ['R-52', 'POST', '/api/staff/:id/resend-invite', OWNER, { ui: 'staff.manage' }],
    ['R-53', 'DELETE', '/api/staff/:id', OWNER, { ui: 'staff.manage' }],

    // ---- 설계 뒤에 생긴 라우트 (지휘 지시) ----
    ['R-54', 'GET', '/api/reports/monthly', ALL], // T-215 월 정산 — 조회 허용(이익 노출은 U-2 기본값: 보여 줌)
    ['R-55', 'GET', '/api/partners/:id/reminder', OWNER], // T-214 입금 안내 미리보기·발송 이력 — 주인 전용
    ['R-56', 'POST', '/api/partners/:id/reminder', OWNER, { ui: 'partner.reminder' }],
    ['R-57', 'POST', '/api/partners/:id/reminder/copy', OWNER, { ui: 'partner.reminder' }],
  ];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function compile([id, method, path, allow, opts = {}]) {
  // Express 기본 설정(대소문자 구분 없음·끝 / 허용)과 같게 맞춘다
  const body = path.split('/').map((seg) => (seg.startsWith(':') ? '([^/]+)' : escapeRe(seg))).join('/');
  const re = new RegExp('^' + body + '/?' + '$', 'i');
  return { id, method, path, allow, re, ...opts };
}

const NEED_LOGIN = { ok: false, code: 'UNAUTHENTICATED', message: '로그인이 필요합니다.' };

/**
 * @param resolveAuth async (req) => auth | null   — auth = { userId, role, staffId, isAdmin, mustChangePassword, ... }
 */
function createAuthorize({ resolveAuth, rules = buildRules() }) {
  const compiled = rules.map(compile);
  const find = (req) => compiled.find((r) => r.method === req.method && r.re.test(req.path)) || null;
  const authorize = async function authorize(req, res, next) {
    if (!req.path.toLowerCase().startsWith('/api/')) return next(); // /API/… 로 돌아가는 길 차단
    const rule = find(req);
    if (rule && rule.allow === 'public') return next();
    if (rule && rule.gate) {
      const g = rule.gate(req);
      if (g) return res.status(g.status).json(g.body);
    }
    const auth = req.headers.authorization ? await resolveAuth(req) : null;
    if (rule && rule.allow === 'optional') {
      if (auth) req.auth = auth;
      // 직원이 비밀번호를 아직 안 바꿨으면 선택 인증 라우트도 막는다
      if (auth && auth.mustChangePassword) return res.status(403).json(PASSWORD_CHANGE);
      return next();
    }
    if (!auth) {
      if (!rule) return next(); // 없는 경로 + 토큰 없음/무효 → 지금처럼 Express 404 또는 라우트의 401
      return res.status(401).json(NEED_LOGIN);
    }
    req.auth = auth;
    if (auth.mustChangePassword && !(rule && (rule.id === 'R-44' || rule.id === 'R-45'))) {
      return res.status(403).json(PASSWORD_CHANGE);
    }
    if (!rule) {
      if (auth.role === 'owner') return next();
      return res.status(403).json({ ok: false, code: 'ROUTE_NOT_ALLOWED', message: '이 기능은 사용할 수 없습니다.' });
    }
    if (!rule.allow.includes(auth.role)) {
      return res.status(403).json({
        ok: false,
        code: 'FORBIDDEN_ROLE',
        role: auth.role,
        message: '권한이 없습니다. 중매인(주인) 계정에 요청하세요.',
      });
    }
    if (auth.role !== 'owner' && rule.check) {
      const p = rule.check(req);
      if (p) return res.status(403).json({ ok: false, code: 'FIELD_NOT_ALLOWED', field: p.field, message: p.message });
    }
    return next();
  };
  authorize.rules = compiled;
  return authorize;
}
const PASSWORD_CHANGE = { ok: false, code: 'PASSWORD_CHANGE_REQUIRED', message: '비밀번호를 먼저 바꿔 주세요.' };

/** 그 역할이 쓸 수 있는 쓰기 기능 이름(화면 버튼용) — 규칙과 화면이 같은 원천 */
function allowedUi(role, rules = buildRules()) {
  const out = new Set();
  for (const [, method, , allow, opts] of rules) {
    if (!opts || !opts.ui || method === 'GET' || !Array.isArray(allow)) continue;
    if (allow.includes(role)) out.add(opts.ui);
  }
  if (role !== 'owner') {
    // 본문 조건으로 막히는 부분 기능도 화면에 알려 준다
    out.add('payment.receive_only');
    if (!envFlag('STAFF_INPUT_CAN_CONFIRM_CREDIT')) out.add('credit.confirm_blocked');
  }
  return [...out].sort();
}

/** Express 앱에 등록된 라우트(메서드+경로) — 점검 테스트용 */
function listAppRoutes(app) {
  const out = [];
  const stack = (app._router && app._router.stack) || [];
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      if (m === '_all') continue;
      out.push(`${m.toUpperCase()} ${layer.route.path}`);
    }
  }
  return out;
}

module.exports = { buildRules, createAuthorize, allowedUi, listAppRoutes, noCreditConfirm, receiveOnly };
