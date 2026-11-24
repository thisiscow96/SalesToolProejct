// T-203 매입서 대조·매입전환 API — 설계서 4.2(허용오차)·4.3·4.4 (R-113~R-131)
// Idempotency-Key 필수: R-118(화면 입력)·R-127·R-128·R-130·R-131 — 키는 부르는 쪽이 lib/idempotency.js 로 만든다.
import { request, download, qs } from './matchHttp';

export const purchaseDocApi = {
  /** R-116 템플릿(.xlsx) */
  template: () => download('/purchase-docs/template', '매입서_템플릿.xlsx'),
  /** R-117 미리보기(저장 안 함) — 파일 단위 오류(400 BAD_FILE·TOO_MANY_ROWS, 413)는 던진다 */
  preview(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return request('POST', '/purchase-docs/preview', { form: fd, fallback: '매입서를 검사하지 못했습니다.' });
  },
  /** R-118 파일 저장 + 대조(+ 자동 매입 등록). 400 HAS_ERRORS 는 body.data.rows 에 줄별 결과 */
  saveFile(file, autoConvert) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    fd.append('auto_convert', autoConvert ? 'true' : 'false');
    return request('POST', '/purchase-docs', { form: fd, fallback: '매입서를 저장하지 못했습니다.' });
  },
  /** R-118 화면 입력 저장 — 창 하나에 키 하나 */
  saveManual: (body, idemKey) => request('POST', '/purchase-docs', { body, idemKey, fallback: '매입서를 저장하지 못했습니다.' }),
  /** R-119 목록 */
  list: (params) => request('GET', `/purchase-docs${qs(params)}`, { fallback: '매입서 목록을 불러오지 못했습니다.' }),
  /** R-120 상세(헤더 + 줄) */
  get: (id) => request('GET', `/purchase-docs/${encodeURIComponent(id)}`, { fallback: '매입서를 불러오지 못했습니다.' }),
  /** R-121 검토 대기 */
  review: (params) => request('GET', `/purchase-docs/review${qs(params)}`, { fallback: '검토 대기 목록을 불러오지 못했습니다.' }),
  /** R-122 후보 1~5위 */
  candidates: (lineId, runId) => request('GET', `/purchase-docs/lines/${encodeURIComponent(lineId)}/candidates${qs({ run_id: runId })}`, { fallback: '후보를 불러오지 못했습니다.' }),
  /** R-123 이력 */
  events: (id, params) => request('GET', `/purchase-docs/${encodeURIComponent(id)}/events${qs(params)}`, { fallback: '이력을 불러오지 못했습니다.' }),
  /** R-124 매입서 다시 대조 */
  match: (id, autoConvert = false) => request('POST', `/purchase-docs/${encodeURIComponent(id)}/match`, { body: { auto_convert: !!autoConvert }, fallback: '다시 대조하지 못했습니다.' }),
  /** R-125 줄 다시 대조 */
  rematchLine: (lineId) => request('POST', `/purchase-docs/lines/${encodeURIComponent(lineId)}/rematch`, { body: {}, fallback: '줄을 다시 대조하지 못했습니다.' }),
  /** R-126 줄 수정(version 필수, 409 VERSION_CONFLICT 면 detail.line 이 최신) */
  updateLine: (lineId, body) => request('PATCH', `/purchase-docs/lines/${encodeURIComponent(lineId)}`, { body, fallback: '줄을 고치지 못했습니다.' }),
  /** R-127 매입 등록(단건·일괄, 최대 200줄) — 클릭 하나에 키 하나 */
  convert: (lineIds, idemKey) => request('POST', '/purchase-docs/convert', { body: { lines: lineIds.map((id) => ({ line_id: id })) }, idemKey, fallback: '매입 등록을 하지 못했습니다.' }),
  /** R-128 수동 확정(주인) { trade_id?, version, accept_diff, reason } */
  confirm: (lineId, body, idemKey) => request('POST', `/purchase-docs/lines/${encodeURIComponent(lineId)}/confirm`, { body, idemKey, fallback: '수동 확정을 하지 못했습니다.' }),
  /** R-129 매입 아님(주인) */
  reject: (lineId, reason) => request('POST', `/purchase-docs/lines/${encodeURIComponent(lineId)}/reject`, { body: { reason }, fallback: '매입 아님으로 바꾸지 못했습니다.' }),
  /** R-130 전환 취소(주인) */
  cancelLine: (lineId, reason, idemKey) => request('POST', `/purchase-docs/lines/${encodeURIComponent(lineId)}/cancel`, { body: { reason }, idemKey, fallback: '전환을 취소하지 못했습니다.' }),
  /** R-131 매입서 취소(주인) */
  cancelDoc: (id, reason, idemKey) => request('POST', `/purchase-docs/${encodeURIComponent(id)}/cancel`, { body: { reason }, idemKey, fallback: '매입서를 취소하지 못했습니다.' }),
  /** R-113~R-115 허용오차 */
  tolerances: () => request('GET', '/purchase-match/tolerances', { fallback: '허용오차를 불러오지 못했습니다.' }),
  saveTolerance: (body) => request('PUT', '/purchase-match/tolerances', { body, fallback: '허용오차를 저장하지 못했습니다.' }),
  removeTolerance: (id) => request('DELETE', `/purchase-match/tolerances/${encodeURIComponent(id)}`, { fallback: '허용오차를 지우지 못했습니다.' }),
};
