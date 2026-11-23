'use strict';
/**
 * T-211 목록 검색·페이지 나누기 공통 도우미
 *
 * 쿼리 파라미터(모두 선택):
 *   q       — 텍스트 검색(품목명·메모 등, 목록마다 대상 열이 다름). 앞뒤 공백 제거, 최대 100자. 대소문자 무시 부분 일치(ILIKE)
 *   limit   — 한 페이지 건수(1~200). limit 또는 offset 이 있으면 "페이지 모드"
 *   offset  — 건너뛸 건수(0 이상). limit 없이 offset 만 주면 limit = 50
 *
 * 하위 호환: limit·offset 이 없으면 예전처럼 전체 행을 { ok, data } 로 돌려준다(응답 모양 그대로).
 * 페이지 모드면 { ok, data, total, limit, offset } — total 은 같은 조건의 전체 건수.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 1000000;
const MAX_Q_LEN = 100;

function intParam(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,7}$/.test(s)) return null;
  return parseInt(s, 10);
}

/** LIKE 특수문자(\ % _)를 글자 그대로 찾도록 이스케이프 — 기본 ESCAPE 문자는 역슬래시 */
function likePattern(text) {
  return '%' + String(text).replace(/[\\%_]/g, (c) => '\\' + c) + '%';
}

/**
 * @returns {{ error: object } | { q: string, like: string|null, paged: boolean, limit: number|null, offset: number }}
 */
function parseListOptions(query = {}) {
  const rawQ = query.q == null ? '' : String(query.q).trim();
  if (rawQ.length > MAX_Q_LEN) {
    return { error: { ok: false, code: 'VALIDATION', field: 'q', message: `검색어는 ${MAX_Q_LEN}자까지 입력할 수 있습니다.` } };
  }
  const hasLimit = query.limit != null && String(query.limit).trim() !== '';
  const hasOffset = query.offset != null && String(query.offset).trim() !== '';
  let limit = null;
  let offset = 0;
  if (hasLimit) {
    limit = intParam(query.limit);
    if (limit == null || limit < 1 || limit > MAX_LIMIT) {
      return { error: { ok: false, code: 'VALIDATION', field: 'limit', message: `한 페이지 건수는 1~${MAX_LIMIT} 사이로 지정하세요.` } };
    }
  }
  if (hasOffset) {
    offset = intParam(query.offset);
    if (offset == null || offset > MAX_OFFSET) {
      return { error: { ok: false, code: 'VALIDATION', field: 'offset', message: '페이지 위치(offset)가 올바르지 않습니다.' } };
    }
  }
  const paged = hasLimit || hasOffset;
  if (paged && limit == null) limit = DEFAULT_LIMIT;
  return { q: rawQ, like: rawQ ? likePattern(rawQ) : null, paged, limit, offset };
}

/**
 * 검색 조건 추가: 주어진 열 중 하나라도 부분 일치. params 에 패턴을 넣고 SQL 조각을 돌려준다.
 * @param {string[]} columns — 신뢰된 SQL 식(사용자 입력 아님)
 */
function searchClause(opts, params, columns) {
  if (!opts.like) return '';
  params.push(opts.like);
  const n = params.length;
  return ' AND (' + columns.map((c) => `${c} ILIKE $${n}`).join(' OR ') + ')';
}

/**
 * 목록 실행. baseSql 은 ORDER BY 없는 SELECT, orderBy 는 ' ORDER BY ...'.
 * 페이지 모드면 같은 조건의 COUNT 와 LIMIT/OFFSET 조회를 둘 다 실행한다.
 */
async function runList(db, baseSql, params, orderBy, opts) {
  if (!opts.paged) {
    const r = await db.query(baseSql + orderBy, params);
    return { ok: true, data: r.rows };
  }
  const cnt = await db.query(`SELECT COUNT(*)::int AS n FROM (${baseSql}) t`, params);
  const p = params.concat([opts.limit, opts.offset]);
  const r = await db.query(`${baseSql}${orderBy} LIMIT $${p.length - 1} OFFSET $${p.length}`, p);
  return { ok: true, data: r.rows, total: cnt.rows[0].n, limit: opts.limit, offset: opts.offset };
}

module.exports = { parseListOptions, searchClause, runList, likePattern, DEFAULT_LIMIT, MAX_LIMIT, MAX_Q_LEN };
