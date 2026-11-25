'use strict';
/**
 * T-203 대조 점수식·판정 (설계 3.4) — 순수 함수. engine_version 'm1'
 *
 * 입력 후보 c 는 SQL 이 계산한 비교값을 문자열/정수로 갖고 온다(금액 곱셈·나눗셈은 SQL NUMERIC — AC-35):
 *   c.price_diff_pct  단가 차 %(절대값, kg 이 다르면 kg 단가로)    c.qty_diff_pct 수량 차 %(절대값)
 *   c.date_diff       경락일 − 거래일(일)                         c.qty_cmp      -1(매입서<경락) 0 1
 *   c.same_kg c.kg_known_both c.same_pkg c.same_grade c.grade_one_null c.grade_both_null
 *   c.same_item c.variety_unknown_one c.ident ('AUCTION'|'BUYER'|null) c.corp_same c.corp_one_null
 * 여기서 하는 것은 점수 더하기와 % 비교(금액 아님)뿐이다.
 *
 * T-203 m2(A_실API보정 4.2) — **실 API 경락(c.source = 'AT_REALTIME')에만** 적용. 목업(MOCK) 후보는 m1 그대로(기존 기대값 유지)
 *   R1 식별: SQL 이 ident 'AUCTION' 을 (출하번호+경매번호) 또는 (경매번호 + 하루 유일 순번 법인)일 때만 준다. 그 밖 경매번호만 → AUCTION_REF_WEAK(점수 0, 필터만)
 *   R2 등급: 원천에 등급이 없으면 비교하지 않음(10점, strict 유지, GRADE_NOT_IN_SOURCE)
 *   R3 유일 후보: 식별 0점이라도 strict 후보 1건 + 범위 안 다른 후보 0건 + 법인 같음 + tol.auto_unique_no_id → EXACT(UNIQUE_NO_ID)
 *   R4 이상 단가: PRICE_OUTLIER 후보는 strict 불가
 */
const ENGINE_VERSION = 'm1';
const ENGINE_VERSION_REAL = 'm2';
const isReal = (c) => c && c.source === 'AT_REALTIME';

const num = (v) => (v == null ? null : Number(v));

/** 후보 한 건 점수(100점)·strict·flags */
function scoreCandidate(c, line, tol) {
  const flags = [];
  const b = {};
  let strict = true;

  // 식별 근거 35
  b.ident = c.ident === 'AUCTION' ? 35 : c.ident === 'BUYER' ? 25 : 0;

  // 품목(품종) 15
  if (c.same_item && !c.variety_unknown_one) b.item = 15;
  else if (c.variety_unknown_one) { b.item = 5; strict = false; flags.push('VARIETY_UNKNOWN'); }
  else { b.item = 0; strict = false; }

  // 등급 10 (m2 R2: 실 API 원천엔 등급 칸이 없다 — 비교하지 않음)
  if (isReal(c) && c.grade_not_in_source) { b.grade = 10; flags.push('GRADE_NOT_IN_SOURCE'); }
  else if (c.same_grade || c.grade_both_null) b.grade = 10;
  else if (c.grade_one_null) { b.grade = 4; strict = false; flags.push('GRADE_UNKNOWN'); }
  else { b.grade = 0; strict = false; flags.push('GRADE_DIFF'); }

  // 포장·중량 10
  if (!c.kg_known_both) { b.pkg = 3; strict = false; flags.push('WEIGHT_UNKNOWN'); }
  else if (c.same_kg && c.same_pkg) b.pkg = 10;
  else if (c.same_kg) b.pkg = 8;
  else { b.pkg = 5; strict = false; flags.push('UNIT_CONVERTED'); }

  // 단가 15
  const pp = num(c.price_diff_pct);
  const pAuto = num(tol.price_pct_auto);
  const pRev = num(tol.price_pct_review);
  let priceOut = false;
  if (pp === 0) b.price = 15;
  else if (pp <= pAuto) b.price = 12;
  else if (pp <= pRev) { b.price = 6; strict = false; flags.push('PRICE_DIFF'); }
  else { b.price = 0; strict = false; flags.push('PRICE_OUT'); priceOut = true; }

  // 수량 5
  const qp = num(c.qty_diff_pct);
  const qAuto = num(tol.qty_pct_auto);
  const qRev = num(tol.qty_pct_review);
  let qtyOut = false;
  if (qp === 0) b.qty = 5;
  else if (qp <= qAuto) b.qty = 4;
  else if (c.qty_cmp < 0) { b.qty = 3; strict = false; flags.push('QTY_PARTIAL'); }
  else if (qp <= qRev) { b.qty = 2; strict = false; flags.push('QTY_DIFF'); }
  else { b.qty = 0; strict = false; flags.push('QTY_OUT'); qtyOut = true; }

  // 날짜 5 — date_diff = 경락일 − 거래일
  const dd = Number(c.date_diff);
  const inAuto = dd >= -Number(tol.date_before_auto) && dd <= Number(tol.date_after_auto);
  if (dd === 0) b.date = 5;
  else if (inAuto) b.date = 4;
  else { b.date = 2; strict = false; flags.push('DATE_DIFF'); }

  // 법인 5 (다르면 SQL 이 후보에서 뺀다)
  if (c.corp_same) b.corp = 5;
  else { b.corp = 2; if (!line.doc_corp_null) strict = false; flags.push('CORP_UNKNOWN'); }

  // m2 R1·R4
  if (isReal(c) && c.auction_ref_weak) flags.push('AUCTION_REF_WEAK');
  if (isReal(c) && c.price_outlier) { strict = false; flags.push('PRICE_OUTLIER'); }

  // 공통 strict — 매입서 금액 ≠ 수량×단가, 다른 매입서에 같은 줄
  if (Math.abs(Number(line.amount_calc_diff || 0)) > Number(tol.amount_abs_auto)) { strict = false; if (!flags.includes('AMOUNT_CALC_DIFF')) flags.push('AMOUNT_CALC_DIFF'); }
  if (line.dup_other_doc) { strict = false; flags.push('DUP_LINE_OTHER_DOC'); }

  const score = b.ident + b.item + b.grade + b.pkg + b.price + b.qty + b.date + b.corp;
  return { score, strict, flags, breakdown: b, out_of_range: priceOut || qtyOut };
}

/**
 * 줄 하나 판정
 * @param scored  [{ trade_id, score, strict, flags, out_of_range, ... }] (이미 다른 줄이 가져간 건은 빠져 있음)
 * @returns { result:'EXACT'|'PARTIAL'|'UNMATCHED', score, best, reasons[], ranked[] }
 */
function decide(scored, tol) {
  const ranked = [...scored].sort((a, b) => b.score - a.score || Number(a.trade_id) - Number(b.trade_id));
  if (!ranked.length) return { result: 'UNMATCHED', score: null, best: null, reasons: [], ranked };
  const inRange = ranked.filter((c) => !c.out_of_range);
  if (!inRange.length) {
    return { result: 'UNMATCHED', score: ranked[0].score, best: ranked[0], reasons: ['PRICE_QTY_OUT_OF_RANGE'], ranked };
  }
  const strict = ranked.filter((c) => c.strict);
  const top = ranked[0];
  const second = ranked[1];
  const reasons = [];
  if (strict.length === 1) {
    const s = strict[0];
    const others = ranked.filter((c) => c !== s);
    const runner = others[0];
    const okScore = s.score >= Number(tol.auto_min_score);
    const okGap = !runner || runner.score <= s.score - Number(tol.ambiguity_margin);
    if (okScore && okGap) return { result: 'EXACT', score: s.score, best: s, reasons: [], ranked };
    // m2 R3 유일 후보(실 API 경락만): 식별 근거 없이도 범위 안 후보가 이 1건뿐이고 법인이 같으면 자동(설정으로 끔 — U-03)
    const uniqueOn = tol.auto_unique_no_id == null ? true : tol.auto_unique_no_id === true || String(tol.auto_unique_no_id) === 'true';
    if (!okScore && uniqueOn && isReal(s) && !s.ident && s.corp_same && !others.some((c) => !c.out_of_range)) {
      if (!s.flags.includes('UNIQUE_NO_ID')) s.flags.push('UNIQUE_NO_ID');
      return { result: 'EXACT', score: s.score, best: s, reasons: [], ranked, unique_no_id: true };
    }
    if (!okScore) reasons.push('LOW_SCORE');
    if (!okGap) reasons.push('AMBIGUOUS');
    return { result: 'PARTIAL', score: s.score, best: s, reasons, ranked };
  }
  if (strict.length > 1) reasons.push('MULTI_CANDIDATE');
  else if (second && second.score === top.score) reasons.push('MULTI_CANDIDATE');
  else reasons.push('NOT_STRICT');
  return { result: 'PARTIAL', score: top.score, best: top, reasons, ranked };
}

/**
 * 같은 매입서 안에서 같은 경락 건을 두 줄이 노리면 — 점수 높은 줄(같으면 line_no 작은 줄)이 갖는다(설계 3.4-6).
 * @param lines  [{ line_id, line_no, scored:[...] }]
 * @returns Map(line_id → { ...decide(), taken_flag })
 */
function assignWithinDoc(lines, tol) {
  const prelim = lines.map((l) => ({ l, d: decide(l.scored, tol) }));
  prelim.sort((a, b) => (b.d.score ?? -1) - (a.d.score ?? -1) || a.l.line_no - b.l.line_no);
  const claimed = new Set();
  const out = new Map();
  for (const { l } of prelim) {
    const avail = l.scored.filter((c) => !claimed.has(String(c.trade_id)));
    const lost = avail.length < l.scored.length;
    const d = decide(avail, tol);
    if (lost) d.taken = true;
    if (lost && !avail.length) d.reasons = ['ALL_CANDIDATES_TAKEN'];
    if (d.result === 'EXACT') claimed.add(String(d.best.trade_id));
    out.set(String(l.line_id), d);
  }
  return out;
}

module.exports = { ENGINE_VERSION, ENGINE_VERSION_REAL, scoreCandidate, decide, assignWithinDoc };
