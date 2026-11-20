/**
 * 거래처 외상 한도 (T-207, 기능 제안 P12)
 *
 * 한도: account.credit_limit (마이그레이션 018). NULL = 한도 없음, 0 = 외상 없음.
 * 미수: receivables_by_partner 뷰(012) — 원장·미수 연령·대시보드와 같은 정의(취소 안 된 매출의 total − 반품 − 수금, 음수는 0).
 *
 * 경고 규칙 (RULE-C1~C4)
 *  C1. 판매(매출 전환·재고 판매)·매출 수정을 저장한 "뒤의" 미수가 한도를 넘으면(미수 > 한도, 같으면 넘지 않음) 경고한다.
 *  C2. 이번 저장으로 미수가 늘지 않았으면 경고하지 않는다 — 이미 넘은 거래처의 메모·판매일만 고쳐도 묻지 않게.
 *  C3. 막지 않는다. 서버는 저장을 되돌리고 409 CREDIT_LIMIT 로 알리며, 같은 요청에 credit_confirmed=true 를 붙여
 *      다시 보내면 저장한다(확인 후 저장). 저장 응답에는 credit_warnings 로 무엇을 넘겼는지 남긴다.
 *  C4. 금액 비교는 원 단위 정수(전 = 0.01원 × 100)로 한다 — 부동소수 오차로 경계값이 흔들리지 않게.
 *
 * 쓰는 곳: index.js 매출 전환·매출 수정, lib/fifo-routes.js 재고 판매, lib/ledger-routes.js 원장, lib/dashboard-routes.js
 * 거래처 한도 입력·검증(readCreditLimit)은 index.js 거래처 등록·수정이 쓴다.
 */

/** NUMERIC(14,2) 의 최댓값보다 작게 — 정수부 12자리 */
const CREDIT_LIMIT_MAX = 999999999999.99;

const cents = (v) => Math.round(Number(v ?? 0) * 100);
const won = (c) => c / 100;

/**
 * 본문의 credit_limit 을 읽는다. 없으면 { absent: true }, 빈 값·null 은 한도 없음(null).
 * 숫자(소수 2자리까지, 0 이상, 최대 12자리)만 받는다. 콤마는 지운다(화면에서 1,000,000 처럼 넣어도 되게).
 */
function readCreditLimit(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!('credit_limit' in b)) return { absent: true };
  const raw = b.credit_limit;
  if (raw == null) return { value: null };
  const s = String(raw).replace(/,/g, '').trim();
  if (s === '') return { value: null };
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) {
    return { error: '외상 한도는 0 이상의 금액(소수 둘째 자리까지, 최대 12자리)으로 입력하세요. 한도를 두지 않으려면 비워 두세요.' };
  }
  const n = Number(s);
  if (!(n >= 0) || n > CREDIT_LIMIT_MAX) return { error: '외상 한도가 너무 큽니다.' };
  return { value: s };
}

/** 사용자가 경고를 보고 "그래도 저장"을 눌렀는지 */
function isCreditConfirmed(body) {
  const v = body && typeof body === 'object' ? body.credit_confirmed : undefined;
  return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * 거래처들의 한도와 지금(같은 트랜잭션 기준) 미수를 읽는다. 한도가 있는 거래처만 돌려준다.
 * @returns Map<partnerId, { partner_id, partner_name, limit_c, recv_c }>
 */
async function readCredit(db, userId, partnerIds) {
  const ids = [...new Set((partnerIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (ids.length === 0) return out;
  const r = await db.query(
    `SELECT a.id, a.name, a.credit_limit, COALESCE(rv.receivable_amount, 0) AS receivable
       FROM account a
       LEFT JOIN receivables_by_partner rv ON rv.user_id = a.user_id AND rv.partner_id = a.id
      WHERE a.user_id = $1 AND a.id = ANY($2::int[]) AND a.credit_limit IS NOT NULL`,
    [userId, ids]
  );
  for (const x of r.rows) {
    out.set(x.id, { partner_id: x.id, partner_name: x.name, limit_c: cents(x.credit_limit), recv_c: cents(x.receivable) });
  }
  return out;
}

/**
 * 저장 전에 부른다 — 한도가 있는 거래처의 지금 미수를 기억해 둔다.
 * 한도가 있는 거래처가 하나도 없으면 빈 Map(이후 검사도 쿼리 없이 끝난다).
 */
async function creditBefore(db, userId, partnerIds) {
  return readCredit(db, userId, partnerIds);
}

/**
 * 저장 뒤(COMMIT 전, 같은 트랜잭션)에 부른다. 한도를 넘긴 거래처 목록을 돌려준다(RULE-C1·C2).
 * @param before creditBefore 결과
 * @returns [{ partner_id, partner_name, credit_limit, receivable_before, receivable_after, over_amount, added_amount }]
 */
async function creditWarningsAfter(db, userId, before) {
  if (!before || before.size === 0) return [];
  const after = await readCredit(db, userId, [...before.keys()]);
  const warnings = [];
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) continue;
    const over = a.recv_c - a.limit_c;
    const added = a.recv_c - b.recv_c;
    if (over > 0 && added > 0) {
      warnings.push({
        partner_id: id,
        partner_name: a.partner_name,
        credit_limit: won(a.limit_c),
        receivable_before: won(b.recv_c),
        receivable_after: won(a.recv_c),
        added_amount: won(added),
        over_amount: won(over),
      });
    }
  }
  return warnings;
}

const fmtWon = (n) => `${Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`;

/** 409 응답 문구 — 첫 거래처 기준, 여러 곳이면 "외 N곳" */
function creditMessage(warnings) {
  const w = warnings[0];
  const more = warnings.length > 1 ? ` 외 ${warnings.length - 1}곳` : '';
  return `${w.partner_name}${more}의 외상 한도를 넘습니다. 저장하면 미수 ${fmtWon(w.receivable_after)} / 한도 ${fmtWon(w.credit_limit)} (${fmtWon(w.over_amount)} 초과). 확인 후 다시 저장하세요.`;
}

/** 409 CREDIT_LIMIT 응답 본문 — fifo·정정 API 의 오류 모양({ ok, code, message, detail })과 같다 */
function creditLimitBody(warnings) {
  return { ok: false, code: 'CREDIT_LIMIT', message: creditMessage(warnings), detail: { credit_warnings: warnings } };
}

/**
 * fifo·정정 API 처럼 오류를 throw 하는 라우트용 — httpStatus/corrCode/detail 모양(sendFifoError·sendCorrError 가 그대로 보냄)
 */
function creditLimitError(warnings) {
  const body = creditLimitBody(warnings);
  return Object.assign(new Error(body.message), { httpStatus: 409, corrCode: body.code, detail: body.detail });
}

/**
 * 저장 직전 검사 한 번에: 넘었고 확인 안 했으면 throw, 확인했으면 경고 목록을 돌려준다(응답에 붙임).
 */
async function assertCreditOrConfirmed(db, userId, before, body) {
  const warnings = await creditWarningsAfter(db, userId, before);
  if (warnings.length && !isCreditConfirmed(body)) throw creditLimitError(warnings);
  return warnings;
}

/** 원장·거래처 화면용 한도 요약. limit 이 null 이면 null */
function creditSummary(limit, receivable) {
  if (limit == null) return null;
  const l = cents(limit);
  const r = cents(receivable);
  return {
    credit_limit: won(l),
    receivable: won(r),
    available: won(Math.max(l - r, 0)),
    // 한도 0 은 사용률을 계산하지 않는다(나눗셈 불가) — over 로만 판단
    usage_pct: l > 0 ? Math.round((r / l) * 1000) / 10 : null,
    over: r > l,
    over_amount: won(Math.max(r - l, 0)),
  };
}

/**
 * 한도 넘은 거래처 — 대시보드용. 넘은 금액이 큰 순서로 topN, 전체 곳 수와 함께.
 */
async function overLimitPartners(db, userId, topN) {
  const r = await db.query(
    `SELECT a.id AS partner_id, a.name AS partner_name, a.type AS partner_type, a.credit_limit,
            rv.receivable_amount AS receivable, COUNT(*) OVER ()::int AS total_count
       FROM account a
       JOIN receivables_by_partner rv ON rv.user_id = a.user_id AND rv.partner_id = a.id
      WHERE a.user_id = $1 AND a.credit_limit IS NOT NULL AND rv.receivable_amount > a.credit_limit
      ORDER BY rv.receivable_amount - a.credit_limit DESC, a.name, a.id
      LIMIT $2`,
    [userId, topN]
  );
  return {
    count: r.rows[0]?.total_count || 0,
    items: r.rows.map((x) => ({
      partner_id: x.partner_id,
      partner_name: x.partner_name,
      partner_type: x.partner_type,
      ...creditSummary(x.credit_limit, x.receivable),
    })),
  };
}

module.exports = {
  CREDIT_LIMIT_MAX,
  readCreditLimit,
  isCreditConfirmed,
  creditBefore,
  creditWarningsAfter,
  creditLimitBody,
  creditLimitError,
  assertCreditOrConfirmed,
  creditSummary,
  overLimitPartners,
};
