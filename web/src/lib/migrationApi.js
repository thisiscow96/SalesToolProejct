// T-403 데이터 이관 API — 서버 lib/migration-routes.js (R-79~R-91, 주인만)
// 오류 응답도 본문(줄별 결과·막는 참조)을 함께 돌려준다 — 화면이 그대로 보여 준다.
import { API_BASE, getUser, getToken } from '../api';

function authOnly() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
function onUnauthorized(status) {
  if (status !== 401 || !getUser()) return;
  try {
    window.sessionStorage.removeItem('user');
  } catch {
    /* 무시 */
  }
  window.location.href = '/login';
}

async function call(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...authOnly() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  onUnauthorized(res.status);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ...data };
}
function must(r, fallback) {
  if (r.status >= 400 || r.ok === false) {
    throw Object.assign(new Error(r.message || fallback), { status: r.status, code: r.code, body: r });
  }
  return r;
}

async function download(path, fallbackName) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authOnly() });
  onUnauthorized(res.status);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || '파일을 내려받지 못했습니다.');
  }
  const blob = await res.blob();
  const m = (res.headers.get('content-disposition') || '').match(/filename\*=UTF-8''([^;]+)/i);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const migrationApi = {
  list: async () => must(await call('GET', '/migrations'), '이관 묶음을 불러오지 못했습니다.'),
  create: async (cutoverDate, memo) => must(await call('POST', '/migrations', { cutover_date: cutoverDate, memo }), '이관 묶음을 만들지 못했습니다.'),
  get: async (id) => must(await call('GET', `/migrations/${id}`), '이관 묶음을 불러오지 못했습니다.'),
  remove: async (id) => must(await call('DELETE', `/migrations/${id}`), '이관 묶음을 삭제하지 못했습니다.'),
  removeFile: async (id, kind) => must(await call('DELETE', `/migrations/${id}/files/${kind}`), '파일을 빼지 못했습니다.'),
  /** 검증 — 오류가 있어도 200(줄별 결과) */
  validate: async (id) => must(await call('POST', `/migrations/${id}/validate`, {}), '검증하지 못했습니다.'),
  /** 저장 — 400(오류)·409(경고 확인 필요)도 결과 본문을 돌려준다 */
  commit: async (id, confirmWarnings) => call('POST', `/migrations/${id}/commit`, { confirm_warnings: !!confirmWarnings }),
  rollbackCheck: async (id) => must(await call('GET', `/migrations/${id}/rollback-check`), '되돌리기 가능 여부를 확인하지 못했습니다.'),
  rollback: async (id, reason) => call('POST', `/migrations/${id}/rollback`, { reason }),
  reconcile: async (id) => must(await call('GET', `/migrations/${id}/reconcile`), '대조 리포트를 불러오지 못했습니다.'),
  reconcileXlsx: (id) => download(`/migrations/${id}/reconcile?format=xlsx`, `이관대조_${id}.xlsx`),
  template: (kind) => download(`/migrations/template/${kind}`, `이관_${kind}.xlsx`),
  history: async (params = {}) => must(await call('GET', `/migration-history?${new URLSearchParams(params).toString()}`), '이관 기록을 불러오지 못했습니다.'),
  async upload(id, kind, file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetch(`${API_BASE}/migrations/${id}/files/${kind}`, { method: 'POST', headers: authOnly(), body: fd });
    onUnauthorized(res.status);
    const data = await res.json().catch(() => ({}));
    return must({ status: res.status, ...data }, '파일을 올리지 못했습니다.');
  },
};
