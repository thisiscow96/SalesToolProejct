// 월 정산 보고서 API (T-215) — api.js 와 같은 토큰·401 처리. 병행 작업(T-207)과 api.js 충돌을 줄이려고 파일을 나눴다.
import { API_BASE, getToken } from '../api';

export async function fetchMonthlyReport(month) {
  const token = getToken();
  const res = await fetch(`${API_BASE}/reports/monthly?month=${encodeURIComponent(month)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) {
    try { window.sessionStorage.removeItem('user'); } catch { /* 무시 */ }
    window.location.href = '/login';
  }
  let body = {};
  try { body = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok || !body.ok) throw new Error(body.message || '월 정산 보고서를 불러오지 못했습니다.');
  return body.data;
}
