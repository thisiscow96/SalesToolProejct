// T-203 경락 시세 API — 설계서 4.1·4.2 (R-92~R-112, R-132~R-136). 서버 lib/auction/routes.js 가 계약대로 답한다.
import { request, qs } from './matchHttp';

export const auctionApi = {
  /** R-92 경락 목록 → { data, meta, days, total, limit, offset } */
  trades: (params) => request('GET', `/auction/trades${qs(params)}`, { fallback: '경락 목록을 불러오지 못했습니다.' }),
  /** R-93 경락 상세(revision·이전 값) */
  trade: (id) => request('GET', `/auction/trades/${encodeURIComponent(id)}`, { fallback: '경락 상세를 불러오지 못했습니다.' }),
  /** R-94 참고 시세(가락 주요품목 평균가) */
  dailyPrices: (params) => request('GET', `/auction/daily-prices${qs(params)}`, { fallback: '참고 시세를 불러오지 못했습니다.' }),
  /** R-95 내부 품목(품종) 목록 */
  items: () => request('GET', '/auction/items', { fallback: '품목 목록을 불러오지 못했습니다.' }),
  /** R-137 법인 목록(경락 조회 [법인] 선택지 — 이 시장의 전체 법인) */
  corps: () => request('GET', '/auction/corps', { fallback: '법인 목록을 불러오지 못했습니다.' }),
  /** R-96 수집 현황(서킷·날짜별·대기 작업·source_mode) */
  syncStatus: (params) => request('GET', `/auction/sync/status${qs(params)}`, { fallback: '수집 현황을 불러오지 못했습니다.' }),
  /** R-97 수집 작업 목록 */
  jobs: (params) => request('GET', `/auction/jobs${qs(params)}`, { fallback: '수집 작업을 불러오지 못했습니다.' }),
  /** R-136 DB 사용량·경락 보관 기간(관리자) */
  storage: () => request('GET', '/auction/storage', { fallback: 'DB 사용량을 불러오지 못했습니다.' }),
  /** R-98 지금 받기(주인) { source, date_from, date_to, phase, force } → 202 { queued, skipped } */
  sync: (body) => request('POST', '/auction/sync', { body, fallback: '수집을 요청하지 못했습니다.' }),
  /** R-99 대기 작업 취소(관리자) */
  cancelJob: (id) => request('POST', `/auction/jobs/${encodeURIComponent(id)}/cancel`, { body: {}, fallback: '작업을 취소하지 못했습니다.' }),
  /** R-132 실패 작업 다시 실행(주인) */
  retryJob: (id) => request('POST', `/auction/jobs/${encodeURIComponent(id)}/retry`, { body: {}, fallback: '작업을 다시 넣지 못했습니다.' }),
  /** R-101 / R-102 시장 달력(휴장일) */
  calendar: (params) => request('GET', `/auction/calendar${qs(params)}`, { fallback: '시장 달력을 불러오지 못했습니다.' }),
  saveCalendar: (body) => request('PUT', '/auction/calendar', { body, fallback: '시장 달력을 저장하지 못했습니다.' }),
  /** R-134 / R-135 수집 일정 */
  schedules: () => request('GET', '/auction/schedules', { fallback: '수집 일정을 불러오지 못했습니다.' }),
  saveSchedule: (body) => request('PUT', '/auction/schedules', { body, fallback: '수집 일정을 저장하지 못했습니다.' }),
  /** R-103~R-106 품목 매핑(관리자) */
  mappings: (params) => request('GET', `/auction/item-mappings${qs(params)}`, { fallback: '품목 매핑을 불러오지 못했습니다.' }),
  createMapping: (body) => request('POST', '/auction/item-mappings', { body, fallback: '품목 매핑을 추가하지 못했습니다.' }),
  updateMapping: (id, body) => request('PUT', `/auction/item-mappings/${encodeURIComponent(id)}`, { body, fallback: '품목 매핑을 고치지 못했습니다.' }),
  removeMapping: (id) => request('DELETE', `/auction/item-mappings/${encodeURIComponent(id)}`, { fallback: '품목 매핑을 끄지 못했습니다.' }),
  /** R-107 매핑 안 된 이름(관리자) */
  unmapped: (params) => request('GET', `/auction/unmapped${qs(params)}`, { fallback: '매핑 안 된 이름을 불러오지 못했습니다.' }),
  /** R-108~R-110 품목 연결(내부 품종 → 내 품목) */
  productLinks: () => request('GET', '/auction/product-links', { fallback: '품목 연결을 불러오지 못했습니다.' }),
  saveProductLinks: (links) => request('PUT', '/auction/product-links', { body: { links }, fallback: '품목 연결을 저장하지 못했습니다.' }),
  removeProductLink: (id) => request('DELETE', `/auction/product-links/${encodeURIComponent(id)}`, { fallback: '품목 연결을 지우지 못했습니다.' }),
  /** R-111 / R-112 법인 연결(경락 법인 코드 → 내 거래처) */
  corpLinks: () => request('GET', '/auction/corp-links', { fallback: '법인 연결을 불러오지 못했습니다.' }),
  saveCorpLinks: (links) => request('PUT', '/auction/corp-links', { body: { links }, fallback: '법인 연결을 저장하지 못했습니다.' }),
};
