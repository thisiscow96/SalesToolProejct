'use strict';
/**
 * T-203 정규화 순수 함수 — 경락(수집)·매입서(업로드) 양쪽이 같은 규칙을 쓴다 (설계 3.1)
 *  - DB 를 읽지 않는다. 매핑 표·등급 표는 호출하는 쪽이 읽어 넘긴다(단위 테스트가 그대로 부를 수 있게).
 *  - 금액 계산은 여기서 하지 않는다(원 정수 검사만). 곱셈·반올림은 SQL NUMERIC 으로(AC-35).
 */
const crypto = require('crypto');

/** 키워드 정규화 — 공백 제거·소문자 (item_mapping.keyword_norm CHECK 와 같은 규칙) */
function normalizeKeyword(s) {
  if (s == null) return '';
  return String(s).replace(/\s/g, '').toLowerCase();
}

/** 이름 후보 — 괄호를 풀어 앞뒤를 바꾼 이름까지('파프리카(적)' → '적파프리카'), 중분류명을 앞뒤로 붙인 이름 */
function nameCandidates(name, parentName) {
  const out = new Set();
  const add = (s) => { const n = normalizeKeyword(s); if (n) out.add(n); };
  const base = String(name || '').trim();
  const parent = String(parentName || '').trim();
  if (base) {
    add(base);
    const m = base.match(/^([^()]+)\(([^()]+)\)\s*$/);
    if (m) {
      add(`${m[2]}${m[1]}`);
      add(`${m[1]}${m[2]}`);
      add(m[2]);
    }
    const plain = base.replace(/[()]/g, '');
    if (plain !== base) add(plain);
    if (parent) {
      add(`${base}${parent}`);
      add(`${parent}${base}`);
      if (m) {
        add(`${m[2]}${parent}`);
        add(`${m[2]}${m[1]}`);
      }
    }
  } else if (parent) add(parent);
  return [...out];
}

/**
 * 키워드 매핑 — 후보 이름 중 하나라도 **포함하는** 키워드 중 가장 긴 것, 같으면 priority 작은 것, 같으면 id 작은 것
 * @param names  nameCandidates() 결과(정규화된 문자열 배열) 또는 문자열 하나
 * @param rules  [{ id, keyword_norm, item_key, priority }]
 * @returns { item_key, rule_id, keyword } | null
 */
function matchKeyword(names, rules) {
  const list = Array.isArray(names) ? names : [normalizeKeyword(names)];
  let best = null;
  for (const r of rules) {
    const kw = r.keyword_norm;
    if (!kw) continue;
    if (!list.some((n) => n.includes(kw))) continue;
    const better = !best
      || kw.length > best.keyword.length
      || (kw.length === best.keyword.length && (r.priority < best.priority || (r.priority === best.priority && r.id < best.rule_id)));
    if (better) best = { item_key: r.item_key, rule_id: r.id, keyword: kw, priority: r.priority };
  }
  return best ? { item_key: best.item_key, rule_id: best.rule_id, keyword: best.keyword } : null;
}

/** 코드 매핑 — (source, code_l, code_m, code_s) 와일드카드(NULL) 허용, 더 구체적인 행 → priority 순 */
function matchCode({ source, l, m, s }, rules) {
  let best = null;
  for (const r of rules) {
    if (!r.code_m) continue;
    if (r.source && r.source !== source) continue;
    if (r.code_m !== m) continue;
    if (r.code_l && r.code_l !== l) continue;
    if (r.code_s && r.code_s !== s) continue;
    const spec = (r.source ? 1 : 0) + (r.code_l ? 1 : 0) + (r.code_s ? 2 : 0);
    if (!best || spec > best.spec || (spec === best.spec && r.priority < best.priority)) best = { item_key: r.item_key, rule_id: r.id, spec, priority: r.priority, action: r.action || 'MAP' };
  }
  return best ? { item_key: best.item_key, rule_id: best.rule_id, action: best.action } : null; // action: MAP | IGNORE(030)
}

/** 등급 → SPECIAL/HIGH/MID/LOW/OFF/NONE | null.  aliases = Map(alias_norm → grade_norm) */
function normalizeGrade(raw, aliases) {
  const k = normalizeKeyword(raw);
  if (!k) return null;
  return aliases.get(k) || null;
}

const PKG_WORDS = [
  [/상자|박스|box|bx|c\/t|ct/i, 'BOX'],
  [/망|넷|net/i, 'NET'],
  [/봉|봉지|bag|팩|pack/i, 'BAG'],
  [/개|ea|낱개/i, 'EA'],
];
/** 포장 이름 → BOX/NET/BAG/KG/EA/ETC | null */
function normalizePkg(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  for (const [re, v] of PKG_WORDS) if (re.test(s)) return v;
  if (/^(kg|키로|킬로|킬로그램)$/i.test(s)) return 'KG';
  return 'ETC';
}

/**
 * 규격 문자열 파싱 — '10kg 상자' → { kg:'10.000', pkg:'BOX' }, '500g 봉' → { kg:'0.500', pkg:'BAG' }, '5키로' → { kg:'5.000', pkg:'KG' }
 * kg 은 문자열(소수 3자리) — NUMERIC 으로 그대로 넣는다
 */
function parseSpec(raw) {
  const s = String(raw || '').trim();
  if (!s) return { kg: null, pkg: null };
  const m = s.match(/(\d+(?:\.\d+)?)\s*(kg|키로|킬로그램|킬로|g|그램)(?![a-z])/i);
  let kg = null;
  if (m) {
    const unit = m[2].toLowerCase();
    const isGram = unit === 'g' || unit === '그램';
    kg = decimalDiv(m[1], isGram ? 1000 : 1, 3);
    if (!(Number(kg) > 0)) kg = null;
  }
  const rest = m ? (s.slice(0, m.index) + s.slice(m.index + m[0].length)).trim() : s;
  let pkg = null;
  for (const [re, v] of PKG_WORDS) if (re.test(rest)) { pkg = v; break; }
  if (!pkg) pkg = kg ? 'KG' : normalizePkg(rest);
  return { kg, pkg };
}

/** 문자열 10진 나눗셈(소수 digits 자리, HALF_UP) — 정수/1000 같은 단순 환산용. 금액에는 쓰지 않음 */
function decimalDiv(numStr, div, digits) {
  const [i, f = ''] = String(numStr).split('.');
  const scale = 10n ** BigInt(digits);
  const n = BigInt(i + f.padEnd(digits + 1, '0').slice(0, digits + 1)); // digits+1 자리 정수
  const q = n / BigInt(div);
  const rounded = (q + 5n) / 10n; // HALF_UP (양수만)
  const ip = rounded / scale;
  const fp = (rounded % scale).toString().padStart(digits, '0');
  return `${ip}.${fp}`;
}

/** 원 단위 정수 금액 검사 — '35,000' → '35000', '35000.5' → { error:'NOT_INTEGER_WON' } */
function readWon(v) {
  if (v == null || v === '') return { value: null };
  let s;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { error: 'NOT_NUMBER' };
    if (!Number.isInteger(v)) return { error: 'NOT_INTEGER_WON', raw: String(v) };
    if (!Number.isSafeInteger(v)) return { error: 'NOT_NUMBER' };
    s = String(v);
  } else {
    s = String(v).replace(/[,\s원₩]/g, '');
    if (!s) return { value: null };
    if (/^-?\d+\.\d*[1-9]\d*$/.test(s)) return { error: 'NOT_INTEGER_WON', raw: s };
    if (/^-?\d+(\.0*)?$/.test(s)) s = s.replace(/\.0*$/, '');
    else return { error: 'NOT_NUMBER' };
  }
  if (s.startsWith('-')) return { error: 'NOT_POSITIVE' };
  if (s.replace(/^0+(?=\d)/, '').length > 15) return { error: 'TOO_LARGE' };
  return { value: s.replace(/^0+(?=\d)/, '') };
}

/** 수량 — 0보다 큰 수, 소수 3자리까지. 문자열로 돌려줌 */
function readQty(v) {
  if (v == null || v === '') return { value: null };
  let s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v).replace(/[,\s]/g, '');
  if (!s) return { value: null };
  if (/e/i.test(s)) s = Number(s).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { error: 'NOT_NUMBER' };
  const [, f = ''] = s.split('.');
  if (f.replace(/0+$/, '').length > 3) return { error: 'TOO_MANY_DECIMALS' };
  if (s.startsWith('-') || /^0+(\.0+)?$/.test(s)) return { error: 'NOT_POSITIVE' };
  return { value: s };
}

/** 줄 지문 — 다른 매입서에 같은 줄이 있는지(DUP_LINE_OTHER_DOC) */
function lineFingerprint(l) {
  const parts = [l.trade_date, l.corp_code || '', l.item_key || normalizeKeyword(l.item_name_raw), l.grade_norm || '',
    l.pkg_norm || '', l.unit_qty_kg || '', canonNum(l.qty), String(l.unit_price), l.auction_ref || ''];
  if (l.shipment_ref) parts.push(`S:${l.shipment_ref}`); // T-203 030 — 출하번호가 있을 때만(없는 줄의 지문은 예전과 같음)
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}
function canonNum(v) {
  const s = String(v ?? '');
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** 판매툴 품목 단위 → 1단위 중량 kg 문자열 | null(숫자 없는 단위 — 매입서 단위 그대로 1:1). 'kg'→'1.000', '10kg'→'10.000', '500g'→'0.500' */
function productUnitKg(unit) {
  const s = String(unit || '').trim();
  if (!s) return null;
  if (/^(kg|키로|킬로|킬로그램)$/i.test(s)) return '1.000';
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(kg|키로|킬로그램|킬로|g|그램)$/i);
  if (!m) {
    const p = parseSpec(s);
    return p.kg;
  }
  const isGram = /^(g|그램)$/i.test(m[2]);
  return decimalDiv(m[1], isGram ? 1000 : 1, 3);
}

/** 품종이 '모름'(item_key 의 '_') 인지 */
const isUnknownVariety = (k) => !!k && k.endsWith('._');
const familyOf = (k) => (k ? String(k).split('.')[0] : null);

module.exports = {
  normalizeKeyword, nameCandidates, matchKeyword, matchCode, normalizeGrade, normalizePkg, parseSpec,
  decimalDiv, readWon, readQty, lineFingerprint, productUnitKg, isUnknownVariety, familyOf,
};
