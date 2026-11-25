// T-203 화면 문구·표시 형식 — 상태·사유 코드(설계 3.4·3.5·4.4) → 한국어
// 금액은 서버가 정수 원으로 준다. 화면은 표시만 하고 금액을 계산해 보내지 않는다(서버가 계산, AC-35).

export const won = (n) => (n === null || n === undefined || n === '' ? '-' : Number(n).toLocaleString('ko-KR'));
/** 소수 문자열("3500.00", "12.000") 표시 — 계산하지 않고 자리만 줄인다 */
export function dec(s, max = 3) {
  if (s === null || s === undefined || s === '') return '-';
  const n = Number(s);
  if (!Number.isFinite(n)) return String(s);
  return n.toLocaleString('ko-KR', { maximumFractionDigits: max });
}
export const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
export function kstAddDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export const md = (ymd) => (ymd ? String(ymd).slice(5, 10) : '-');
/** ISO 시각 → KST "MM-DD HH:mm" */
export function kstTime(iso, withDate = true) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const k = new Date(d.getTime() + 9 * 3600e3).toISOString();
  return withDate ? `${k.slice(5, 10)} ${k.slice(11, 16)}` : k.slice(11, 16);
}
export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400e3);
}

export const FAMILY = [
  { value: '', label: '전체' },
  { value: 'PEPPER', label: '고추' },
  { value: 'PAPRIKA', label: '파프리카' },
];
export const GRADE = [
  { value: '', label: '전체' },
  { value: 'SPECIAL', label: '특' },
  { value: 'HIGH', label: '상' },
  { value: 'MID', label: '중' },
  { value: 'LOW', label: '하' },
  { value: 'OFF', label: '등외' },
  { value: 'NONE', label: '등급 없음' },
];
export const GRADE_LABEL = Object.fromEntries(GRADE.filter((g) => g.value).map((g) => [g.value, g.label]));

export const SOURCE_LABEL = {
  AT_REALTIME: 'aT 실시간 경매',
  AT_SETTLE: 'aT 정산정보',
  GARAK_PRICE: '가락 주요품목 가격',
  AT_CODE: 'aT 표준코드',
  MOCK: '목업',
};
export const PHASE_LABEL = { INTRADAY: '당일 집계(확정 전)', FINAL: '확정', SETTLE_VERIFY: '정산 검증' };
export const PHASE_SHORT = { INTRADAY: '당일', FINAL: '확정', SETTLE_VERIFY: '검증' };
export const SNAPSHOT_STATUS = {
  COMPLETE: { label: '완료', tone: 'ok' },
  PARTIAL: { label: '일부만', tone: 'warn' },
  EMPTY: { label: '데이터 없음', tone: 'warn' },
  NOT_YET: { label: '집계 전', tone: 'info' },
  HOLIDAY: { label: '휴장', tone: 'neutral' },
  FAILED: { label: '실패', tone: 'bad' },
  RUNNING: { label: '수집 중', tone: 'info' },
};
/** 빈 결과 문구(설계 6.2) */
export const EMPTY_REASON = {
  NOT_YET: '아직 경매 전·집계 전입니다. 다음 수집 뒤 다시 보세요.',
  HOLIDAY: '휴장일입니다. 이 날은 경매가 없습니다.',
  EMPTY: '데이터 없음(확인 필요) — 수집은 끝났지만 받은 건이 없습니다.',
};
export const CIRCUIT = {
  CLOSED: { label: '정상', tone: 'ok' },
  HALF_OPEN: { label: '시험 호출 중', tone: 'info' },
  OPEN: { label: '잠시 멈춤', tone: 'warn' },
};
export const DISABLED_REASON = {
  AUTH_ERROR: 'API 키 확인 필요',
  QUOTA: '하루 호출 한도 초과(내일 00:10 재개)',
  NO_KEY: '키 없음(목업)',
};
export const JOB_STATUS = {
  QUEUED: { label: '대기', tone: 'info' },
  RUNNING: { label: '실행 중', tone: 'info' },
  DONE: { label: '완료', tone: 'ok' },
  FAILED: { label: '실패', tone: 'bad' },
  DEAD: { label: '실패(DEAD)', tone: 'bad' },
  CANCELLED: { label: '취소', tone: 'neutral' },
};
export const ERROR_KIND = {
  TIMEOUT: '응답 시간 초과',
  RATE_LIMIT: '호출 한도(429)',
  SERVER_ERROR: '외부 서버 오류(5xx)',
  AUTH_ERROR: '인증 오류',
  QUOTA: '하루 한도 초과',
  BAD_RESPONSE: '응답 형식 오류',
  NETWORK: '네트워크 오류',
};

export const DOC_STATUS = {
  PENDING: { label: '대조 대기', tone: 'info' },
  HOLD: { label: '보류', tone: 'warn' },
  PARTIAL_CONVERTED: { label: '일부 전환', tone: 'info' },
  CONVERTED: { label: '전환 완료', tone: 'ok' },
  REJECTED: { label: '매입 아님', tone: 'neutral' },
  CANCELLED: { label: '취소', tone: 'neutral' },
};
export const LINE_STATUS = {
  PENDING: { label: '대조 대기', tone: 'info' },
  HOLD: { label: '검토 대기', tone: 'warn' },
  CONVERTED: { label: '매입 등록됨', tone: 'ok' },
  REJECTED: { label: '매입 아님', tone: 'neutral' },
  CANCELLED: { label: '전환 취소', tone: 'neutral' },
};
export const MATCH_RESULT = {
  EXACT: { label: '완전', tone: 'ok' },
  PARTIAL: { label: '부분', tone: 'warn' },
  UNMATCHED: { label: '미매칭', tone: 'bad' },
};
export const MODE_LABEL = { AUTO: '자동', MANUAL: '수동 확정', FORCED: '강제 확정(차이 확인)' };

/** 사유·경고 코드(설계 3.4 판정·점수표, 4.3 줄 경고) */
export const REASON = {
  ITEM_UNMAPPED: '품목을 찾지 못함(매핑 없음)',
  BASE_NOT_READY: '기준 데이터 아직 없음',
  NO_BASE_DATA: '기준 데이터 없음(확인 필요)',
  BASE_NOT_FINAL: '확정 전(당일 집계) — 확정 수집 뒤 자동 재대조',
  NO_TRADE_IN_DATE_RANGE: '그 기간에 이 품목 경락 없음',
  NO_TRADE_SAME_VARIETY: '같은 품종 경락 없음',
  CORP_MISMATCH: '법인 다름',
  ALL_CANDIDATES_TAKEN: '후보를 다른 줄이 이미 매입 등록에 씀',
  PRICE_QTY_OUT_OF_RANGE: '단가·수량이 후보 범위 밖',
  MULTI_CANDIDATE: '후보 여러 건',
  LOW_SCORE: '점수 부족',
  AMBIGUOUS: '1·2위 점수 차이 작음',
  NO_PRODUCT_LINK: '품목 연결 없음(대조 설정에서 연결)',
  MOCK_SOURCE: '목업 데이터라 자동 등록 안 함',
  BASE_REVISED: '경락 값 바뀜(전환 뒤 정정)',
  CANDIDATE_TAKEN: '같은 매입서 다른 줄이 먼저 가져감',
  DUP_LINE_OTHER_DOC: '다른 매입서에 같은 줄 있음',
  AMOUNT_CALC_DIFF: '금액 ≠ 수량×단가',
  AMOUNT_MISMATCH: '금액 ≠ 수량×단가',
  PRICE_OUT: '단가 허용 밖',
  QTY_OUT: '수량 허용 밖',
  QTY_PARTIAL: '나눠 낙찰(매입서 수량이 적음)',
  UNIT_CONVERTED: '규격 다름(kg 단가로 비교)',
  WEIGHT_UNKNOWN: '중량 모름',
  GRADE_DIFF: '등급 다름',
  CORRECTED_AFTER_CONVERT: '전환 뒤 매입정보에서 정정됨',
  // C D03: 서버 엔진·전환이 넣는 코드(score.js 후보 flags, engine.js 사유, convert.js 경고, doc-parse.js 줄 경고)
  BUYER_MISMATCH: '내 중매인 번호로 낙찰된 경락 없음',
  NOT_STRICT: '허용오차 안 후보 없음(주인 확인)',
  UNIT_ROUNDING: '규격 환산 시 수량·금액이 딱 맞지 않음',
  GRADE_UNKNOWN: '등급 모름(한쪽 등급 없음)',
  PRICE_DIFF: '단가 차이(검토 범위 안)',
  NO_BASE_TRADE: '경락 근거 없이 등록',
  CORP_UNKNOWN: '법인 확인 안 됨',
  DATE_DIFF: '날짜 차이(자동 범위 밖)',
  QTY_DIFF: '수량 차이(검토 범위 안)',
  VARIETY_UNKNOWN: '품종 모름(한쪽 품종 없음)',
  // T-203 실 API(m2) — 실 경락에만 붙는 코드
  GRADE_NOT_IN_SOURCE: '경락 자료에 등급 없음(등급은 비교 안 함)',
  PRICE_OUTLIER: '경락 단가가 그날 같은 품목 kg 단가와 10배 넘게 차이(자동 등록 안 함)',
  UNIQUE_NO_ID: '번호 없이 조건이 맞는 경락이 1건뿐이라 자동 일치',
  AUCTION_REF_WEAK: '경매번호만으로는 한 건을 못 정함(출하번호 함께 적기)',
};
export const reasonText = (code) => REASON[code] || code;

/** 검토 대기 사유 필터(설계 6.5) */
export const REVIEW_FILTER = [
  { value: '', label: '전체' },
  { value: 'MULTI_CANDIDATE', label: '후보 여러 건' },
  { value: 'PRICE_OUT', label: '단가 차이' },
  { value: 'UNIT_CONVERTED', label: '규격 다름' },
  { value: 'BASE_NOT_READY', label: '기준 데이터 없음' },
  { value: 'NO_PRODUCT_LINK', label: '품목 연결 없음' },
  { value: 'BASE_REVISED', label: '경락 값 바뀜' },
  { value: 'ITEM_UNMAPPED', label: '품목 매핑 없음' },
  { value: 'NOT_STRICT', label: '허용오차 안 후보 없음' },
  { value: 'BUYER_MISMATCH', label: '내 중매인 번호 경락 없음' },
];

/** R-127 줄 결과 코드 */
export const CONVERT_RESULT = {
  CONVERTED: '매입 등록됨',
  ALREADY_CONVERTED: '이미 매입 등록됨',
  NEEDS_CONFIRM: '수동 확정 필요(주인)',
  NO_PRODUCT_LINK: '품목 연결 없음',
  TRADE_TAKEN: '그 경락 건을 다른 줄이 먼저 씀',
  LINE_NOT_CONVERTIBLE: '재대조 먼저(매입 아님·취소 줄)',
  PURCHASE_FAILED: '매입 등록 실패',
  NOT_FOUND: '줄을 찾지 못함',
};

const BLOCKING = new Set(['NO_PRODUCT_LINK', 'BASE_NOT_FINAL', 'MOCK_SOURCE', 'DUP_LINE_OTHER_DOC', 'AMOUNT_CALC_DIFF', 'AMOUNT_MISMATCH']);

/**
 * 서버 줄 행을 화면 모양으로 맞춘다 — DB 칸 이름(item_name_raw·match_score·warning_flags)과
 * 설계 응답 예시 이름(item_name·score·warnings) 둘 다 받는다(서버와 맞출 것 #1).
 */
export function normLine(l = {}) {
  const reasons = l.reason_codes || [];
  const warnings = l.warning_flags || l.warnings || [];
  const convertible =
    typeof l.convertible === 'boolean'
      ? l.convertible
      : l.status === 'PENDING' && l.match_result === 'EXACT' && ![...reasons, ...warnings].some((c) => BLOCKING.has(c));
  return {
    ...l,
    item_name: l.item_name ?? l.item_name_raw ?? '',
    grade: l.grade ?? l.grade_raw ?? (l.grade_norm ? GRADE_LABEL[l.grade_norm] : ''),
    spec: l.spec ?? l.pkg_raw ?? '',
    score: l.score ?? l.match_score ?? null,
    reason_codes: reasons,
    warnings,
    convertible,
  };
}

/** 헤더 줄 상태 건수 표시 "전환/대기/보류/아님/취소" */
export function countsText(c = {}) {
  return `${c.converted ?? 0}/${c.pending ?? 0}/${c.hold ?? 0}/${c.rejected ?? 0}/${c.cancelled ?? 0}`;
}

/** 서버 검증 오류 → { field: message } */
export function fieldErrors(e) {
  const out = {};
  if (!e) return out;
  if (Array.isArray(e.errors)) for (const x of e.errors) if (x.field) out[x.field] = x.message;
  if (e.field) out[e.field] = e.message;
  return out;
}
