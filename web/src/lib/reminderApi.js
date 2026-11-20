// 미수 입금 안내 (T-214) — api.js 와 같은 토큰·401 처리. 병행 작업과 api.js 충돌을 줄이려고 파일을 나눴다.
// 오류는 서버의 code(MAIL_NOT_CONFIGURED·DAILY_LIMIT·MAIL_FAILED·NO_RECEIVABLE)와 data 를 같이 넘긴다.
import { API_BASE, getToken } from '../api';

export class ReminderError extends Error {
  constructor(status, body) {
    super(body?.message || '처리에 실패했습니다.');
    this.status = status;
    this.code = body?.code || null;
    this.field = body?.field || null;
    this.data = body?.data || null;
  }
}

async function req(method, path, body) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    try { window.sessionStorage.removeItem('user'); } catch { /* 무시 */ }
    window.location.href = '/login';
  }
  let data = {};
  try { data = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) throw new ReminderError(res.status, data);
  return data.data;
}

const base = (partnerId) => `/partners/${encodeURIComponent(partnerId)}/reminder`;

/** 미리보기 — 미수·연령, 받는 주소, 기본 문구, 메일 준비 여부(mail_ready), 오늘 발송(sent_today), 최근 이력 */
export const fetchReminderPreview = (partnerId) => req('GET', base(partnerId));
/** 메일 발송 — body: to_email, subject, body, bank_text, save_email */
export const sendReminder = (partnerId, body) => req('POST', base(partnerId), body);
/** 문구 복사 기록 — body: subject, body, bank_text */
export const recordReminderCopy = (partnerId, body) => req('POST', `${base(partnerId)}/copy`, body);
