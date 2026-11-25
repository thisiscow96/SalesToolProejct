'use strict';
/**
 * T-203 경락 목록(R-92) 원표번호 검색·열 정렬 규칙 — 한 곳에 모음 (A 설계 1·2절, I 검토 2.3·3.3)
 *
 * 원표번호 매칭 방식은 SHIPMENT_MATCH 하나로 바꾼다(사용자 확인 U-T7):
 *   'exact'    (기본) 앞자리 0 무시 정확 일치 — 입력 30252 = 저장값 030252. `t.shipment_no = ANY(후보)` 라 032 인덱스를 그대로 탄다
 *   'contains' 포함(가운데·끝자리) 일치 — `t.shipment_no LIKE '%x%'`. I 실측 31일 20ms 이하(인덱스 없이)
 *   환경 변수 AUCTION_SHIPMENT_MATCH=exact|contains 로도 바꿀 수 있다.
 * 정렬 키는 아래 SORTS 표의 고정 문자열만 SQL 에 붙인다(사용자 값을 ORDER BY 에 잇지 않음 — SQL 인젝션 차단).
 */

const SHIPMENT_MAX = 20; // auction_trade.shipment_no VARCHAR(20)
const shipmentMatchMode = (env = process.env) => (String(env.AUCTION_SHIPMENT_MATCH || '').toLowerCase() === 'contains' ? 'contains' : 'exact');

/**
 * 원표번호 입력 정리 — 공백·하이픈·점 제거 후 숫자 1~20자리. 숫자로 바꾸지 않는다(앞자리 0 보존)
 * @returns { value } | { error }
 */
function normalizeShipmentNo(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\s\-.]/g, '');
  if (!/^[0-9]{1,20}$/.test(s)) return { error: '원표번호는 숫자 20자리 이내로 입력하세요.' };
  return { value: s };
}

/** 앞자리 0 무시 정확 일치 후보: '30252' → ['30252','030252','0030252', … 20자리까지] ('000' → '0','00',…) */
function shipmentVariants(value) {
  const core = value.replace(/^0+/, '') || '0';
  const out = [];
  for (let n = core.length; n <= SHIPMENT_MAX; n += 1) out.push('0'.repeat(n - core.length) + core);
  return out;
}

/**
 * WHERE 조각 — add(sqlWithQuestionMark, value) 로 파라미터를 붙인다
 * @returns 정리한 값(meta 용)
 */
function addShipmentFilter(add, value, mode = shipmentMatchMode()) {
  if (mode === 'contains') {
    add("t.shipment_no LIKE ?", `%${value}%`); // 숫자만이라 이스케이프할 글자 없음
  } else {
    add('t.shipment_no = ANY(?::text[])', shipmentVariants(value));
  }
  return value;
}

// 정렬 표: 키 → { def: 기본 방향, sql(D) } — D 는 'ASC'|'DESC' 고정 문자열. 모든 정렬은 NULLS LAST, 마지막은 t.id 같은 방향(쪽 넘김 중복·누락 0)
const GRADE_ORDER = "CASE t.grade_norm WHEN 'SPECIAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'MID' THEN 3 WHEN 'LOW' THEN 4 WHEN 'OFF' THEN 5 WHEN 'NONE' THEN 6 END";
const SORTS = {
  trade_date: { def: 'desc', sql: (D) => `t.trade_date ${D}, t.auction_at ${D} NULLS LAST, t.id ${D}` },
  auction_at: { def: 'desc', sql: (D) => `t.auction_at ${D} NULLS LAST, t.id ${D}` },
  corp: { def: 'asc', sql: (D) => `t.corp_name ${D} NULLS LAST, t.trade_date DESC, t.auction_at DESC NULLS LAST, t.id ${D}` },
  // 길이 → 문자열: 같은 법인(같은 자릿수) 안에서 숫자 순, 앞자리 0 보존. 같은 원표 안은 경매번호 오름차순
  shipment_no: { def: 'asc', sql: (D) => `length(t.shipment_no) ${D} NULLS LAST, t.shipment_no ${D}, length(t.auction_seq) ASC NULLS LAST, t.auction_seq ASC NULLS LAST, t.id ${D}` },
  auction_seq: { def: 'asc', sql: (D) => `length(t.auction_seq) ${D} NULLS LAST, t.auction_seq ${D}, t.id ${D}` },
  item: { def: 'asc', sql: (D) => `mi.family_name ${D} NULLS LAST, mi.variety_name ${D} NULLS LAST, t.item_name_raw ${D} NULLS LAST, t.id ${D}` },
  grade: { def: 'asc', sql: (D) => `${GRADE_ORDER} ${D} NULLS LAST, t.id ${D}` },
  unit_kg: { def: 'asc', sql: (D) => `t.unit_qty_kg ${D} NULLS LAST, t.pkg_norm ${D} NULLS LAST, t.id ${D}` },
  qty: { def: 'desc', sql: (D) => `t.qty ${D} NULLS LAST, t.id ${D}` },
  unit_price: { def: 'desc', sql: (D) => `t.unit_price ${D} NULLS LAST, t.id ${D}` },
  price_per_kg: { def: 'desc', sql: (D) => `t.price_per_kg ${D} NULLS LAST, t.id ${D}` },
  origin: { def: 'asc', sql: (D) => `t.origin_name ${D} NULLS LAST, t.id ${D}` },
};
const SORT_KEYS = Object.keys(SORTS);

/**
 * @returns { order, sort, dir } | { error: { field, message } }
 */
function resolveSort(sortRaw, dirRaw) {
  const sort = sortRaw == null || sortRaw === '' ? 'trade_date' : String(sortRaw);
  if (!Object.prototype.hasOwnProperty.call(SORTS, sort)) return { error: { field: 'sort', message: '정렬 값이 올바르지 않습니다.' } };
  let dir = SORTS[sort].def;
  if (dirRaw != null && dirRaw !== '') {
    const d = String(dirRaw).toLowerCase();
    if (d !== 'asc' && d !== 'desc') return { error: { field: 'dir', message: '정렬 방향은 asc 또는 desc 입니다.' } };
    dir = d;
  }
  return { order: ` ORDER BY ${SORTS[sort].sql(dir === 'asc' ? 'ASC' : 'DESC')}`, sort, dir };
}

module.exports = { normalizeShipmentNo, shipmentVariants, addShipmentFilter, shipmentMatchMode, resolveSort, SORT_KEYS, SHIPMENT_MAX };
