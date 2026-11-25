// T-203 경락·매입서 대조 화면 공용 HTTP — 오류 응답은 code·field·detail 을 그대로 실어 던진다(설계 4장 오류 형식)
import { API_BASE, getUser, getToken } from '../api';

function authOnly() {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function onAuthStatus(status) {
  if (status === 401 && getUser()) {
    try {
      window.sessionStorage.removeItem('user');
    } catch {
      /* 저장소 접근 불가 */
    }
    window.location.href = '/login';
  }
}

export function qs(params = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** 오류 객체: message(서버 문구) · status · code · field · detail · body(본문 전체) */
export function apiError(status, data, fallback) {
  return Object.assign(new Error((data && data.message) || fallback), {
    status,
    code: data?.code || null,
    field: data?.field || null,
    errors: Array.isArray(data?.errors) ? data.errors : null,
    detail: data?.detail || null,
    body: data || null,
  });
}

/**
 * JSON 요청. opts: { body, idemKey, form(FormData), fallback }
 * 성공이면 본문 전체({ ok, data, meta, total, ... })를 돌려준다.
 */
export async function request(method, path, opts = {}) {
  const { body, idemKey, form, fallback = '요청을 처리하지 못했습니다.' } = opts;
  const headers = { ...authOnly() };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw apiError(0, null, '서버에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.');
  }
  onAuthStatus(res.status);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw apiError(res.status, data, fallback);
  return { ...data, _replay: res.headers.get('Idempotent-Replay') === 'true' };
}

/** 파일 내려받기(템플릿) — 서버가 준 파일 이름을 쓴다 */
export async function download(path, fallbackName) {
  const res = await fetch(`${API_BASE}${path}`, { headers: authOnly() });
  onAuthStatus(res.status);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw apiError(res.status, data, '파일을 내려받지 못했습니다.');
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
