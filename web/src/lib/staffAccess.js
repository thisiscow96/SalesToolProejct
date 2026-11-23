// T-213 직원 계정 — 화면이 역할을 아는 방법 (설계 6.4)
// 로그인 응답의 user.staff 와 GET /api/me 의 allow(쓰기 기능 이름 목록)를 sessionStorage 'user' 에 함께 둔다.
// 화면 숨김은 편의다. 막는 것은 서버 미들웨어(server/lib/access.js)다.
import { API_BASE, getUser, getToken } from '../api';

/** 직원으로 로그인했는지 */
export function isStaff() {
  return !!getUser()?.staff;
}

/** 이 기능 버튼을 보여 줄지 — 주인은 언제나 true, 직원은 서버가 준 allow 목록에 있을 때만 */
export function can(ui) {
  const u = getUser();
  if (!u?.staff) return true;
  return Array.isArray(u.allow) && u.allow.includes(ui);
}

export const ROLE_LABEL = { input: '입력 전용', view: '조회 전용' };

function saveUser(patch) {
  try {
    const u = getUser();
    if (!u) return;
    window.sessionStorage.setItem('user', JSON.stringify({ ...u, ...patch }));
  } catch {
    /* 저장소 접근 불가 */
  }
}

async function call(method, path, body) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && getUser()) {
    window.sessionStorage.removeItem('user');
    window.location.href = '/login';
  }
  if (!res.ok || data.ok === false) {
    const e = new Error(data.message || '요청을 처리하지 못했습니다.');
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

/** GET /api/me 를 다시 읽어 저장값(역할·allow)을 갱신 — 역할이 중간에 바뀌었을 때 */
export async function refreshMe() {
  const me = await call('GET', '/me');
  saveUser({
    staff: me.staff ? { ...me.staff, must_change_password: me.must_change_password } : null,
    allow: me.allow,
    is_admin: !!me.is_admin,
  });
  return me;
}

export async function changeMyPassword(current_password, new_password) {
  const d = await call('POST', '/me/password', { current_password, new_password });
  const u = getUser();
  if (d.token && u) saveUser({ token: d.token, staff: u.staff ? { ...u.staff, must_change_password: false } : null });
  return d;
}

export async function setupStaffPassword(body) {
  return call('POST', '/auth/staff/setup-password', body);
}

export const staffApi = {
  list: () => call('GET', '/staff'),
  create: (body) => call('POST', '/staff', body),
  update: (id, body) => call('PATCH', `/staff/${id}`, body),
  suspend: (id) => call('POST', `/staff/${id}/suspend`),
  resume: (id) => call('POST', `/staff/${id}/resume`),
  resetPassword: (id, temp_password) => call('POST', `/staff/${id}/reset-password`, { temp_password }),
  resendInvite: (id) => call('POST', `/staff/${id}/resend-invite`),
  remove: (id) => call('DELETE', `/staff/${id}`),
};
