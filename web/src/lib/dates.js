/**
 * 날짜 도우미 (T-116) — 화면 날짜는 한국 시간(KST, UTC+9) 기준.
 *
 * - DATE 열(매입일·매출일·폐기일 등)은 서버가 'YYYY-MM-DD' 문자열로 준다 → 그대로 쓴다(시간대 변환 없음).
 * - timestamptz 열(created_at·paid_at)은 ISO 문자열(UTC) → KST로 바꿔 날짜·시각을 뽑는다.
 *   브라우저 시간대가 KST가 아니어도(해외 접속·테스트 PC) 같은 값이 보인다.
 * KST는 서머타임이 없어 +9시간 고정으로 계산한다.
 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad2 = (n) => String(n).padStart(2, '0');

/** 순간(Date·ISO 문자열·ms) → KST 기준 { ymd, hm } · 잘못된 값이면 null */
export function kstParts(v) {
  if (v == null || v === '') return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  if (Number.isNaN(t)) return null;
  const k = new Date(t + KST_OFFSET_MS);
  return {
    ymd: `${k.getUTCFullYear()}-${pad2(k.getUTCMonth() + 1)}-${pad2(k.getUTCDate())}`,
    hm: `${pad2(k.getUTCHours())}:${pad2(k.getUTCMinutes())}`,
  };
}

/** 오늘(KST) 'YYYY-MM-DD' */
export function kstTodayYmd(now = Date.now()) {
  return kstParts(now).ymd;
}

/** 지금(KST) — datetime-local 입력값 'YYYY-MM-DDTHH:mm' (서버는 시간대 없는 값을 KST로 해석) */
export function kstNowLocalInput(now = Date.now()) {
  const p = kstParts(now);
  return `${p.ymd}T${p.hm}`;
}

/**
 * 날짜만 'YYYY-MM-DD'
 * - 'YYYY-MM-DD' 문자열(DATE 열) → 그대로
 * - 시각이 붙은 문자열·Date(timestamptz) → KST 날짜
 */
export function toYmd(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (YMD_RE.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
      const p = kstParts(s);
      return p ? p.ymd : s.slice(0, 10);
    }
    return s.length >= 10 ? s.slice(0, 10) : s;
  }
  const p = kstParts(v);
  return p ? p.ymd : String(v);
}

/** DATE 문자열 + timestamptz 의 KST 시각 → 'YYYY-MM-DD HH:mm' (DATE가 없으면 timestamptz 의 KST 날짜) */
export function joinDateAndKstTime(dateValue, ts, fallbackYmd) {
  const datePart = toYmd(dateValue);
  const p = kstParts(ts);
  if (p) return `${datePart || p.ymd} ${p.hm}`;
  return `${datePart || fallbackYmd || kstTodayYmd()} 00:00`;
}
