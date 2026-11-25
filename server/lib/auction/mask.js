'use strict';
/**
 * T-203 민감 값 가리기 — 외부 API 키(serviceKey)·출하자 이름
 *  - 원천 로그·오류 메시지·서버 로그에 URL을 남길 때는 이 함수 하나로만 지운다(D 6장).
 *  - 출하자 이름은 저장 전에 마스킹(U-05): 첫 글자 + * + 끝 글자, 2자는 첫 글자 + *, 1자는 *.
 */

/** URL·문자열 안의 serviceKey 값(인코딩 키·디코딩 키 모두)을 **** 로 */
function maskUrl(s) {
  if (s == null) return s;
  return String(s).replace(/(servicekey=)[^&#\s]*/gi, '$1****');
}

/** 오류 메시지 같은 자유 문장에서 키 값처럼 보이는 것을 지운다(키 값 자체를 알고 있으면 그 값도) */
function scrubSecrets(text, secrets = []) {
  let out = maskUrl(text == null ? '' : String(text));
  for (const sec of secrets) {
    if (sec && String(sec).length >= 6) out = out.split(String(sec)).join('****');
  }
  return out;
}

/** 출하자 이름 마스킹 — '출하자A' → '출*A', '김민수' → '김*수', '홍길' → '홍*' */
function maskName(name) {
  if (name == null) return null;
  const s = String(name).trim();
  if (!s) return null;
  const chars = [...s];
  if (chars.length === 1) return '*';
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}*${chars[chars.length - 1]}`;
}

module.exports = { maskUrl, scrubSecrets, maskName };
