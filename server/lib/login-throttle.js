/**
 * 로그인·조회 API 시도 제한 (T-114, D 리뷰 R-03 · ADR-05, C 관찰 OBS-T112-01)
 *
 * - createFailThrottle: 키(중매인 번호)별 연속 실패를 세고, 정해진 횟수를 넘으면 일정 시간 동안 시도를 막는다.
 *   계정이 없는 번호도 똑같이 세므로 "막혔는지"로 계정 존재를 알 수 없다.
 * - createRateLimiter: 키(접속 주소)별로 일정 시간 안 요청 수를 제한한다(가입용 중매인 번호 중복 확인).
 *
 * 메모리 카운터라 서버를 다시 띄우면 초기화된다. 영구 카운터(DB 컬럼)는 다음 스프린트(ADR-05).
 * 키 수에 상한(maxKeys)을 두어, 번호를 무작위로 바꿔 보내도 메모리가 끝없이 늘지 않게 한다.
 */

function pruneMap(map, maxKeys, isExpired) {
  if (map.size <= maxKeys) return;
  for (const [k, v] of map) {
    if (isExpired(v)) map.delete(k);
  }
  // 그래도 넘치면 오래 전에 들어온 키부터 지운다(Map 은 넣은 순서를 지킨다)
  while (map.size > maxKeys) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

/**
 * @param {object} opt
 * @param {number} opt.maxFails 연속 실패 허용 횟수 — 이 횟수만큼 실패하면 잠근다
 * @param {number} opt.lockMs   잠그는 시간(ms). 실패를 세는 기간도 같은 값(마지막 실패 뒤 이 시간이 지나면 0부터)
 * @param {number} [opt.maxKeys=10000]
 * @param {() => number} [opt.now]
 */
function createFailThrottle({ maxFails, lockMs, maxKeys = 10000, now = Date.now }) {
  const map = new Map(); // key → { fails, last, lockedUntil }
  const expired = (v) => now() - v.last > lockMs && (!v.lockedUntil || v.lockedUntil <= now());

  function current(key) {
    const v = map.get(key);
    if (!v) return null;
    if (expired(v)) {
      map.delete(key);
      return null;
    }
    return v;
  }

  return {
    /** 잠겨 있으면 남은 ms, 아니면 0 */
    lockedFor(key) {
      const v = current(key);
      if (!v || !v.lockedUntil) return 0;
      const left = v.lockedUntil - now();
      return left > 0 ? left : 0;
    },
    /** 실패 1회 기록. 이번 실패로 잠겼으면 true */
    fail(key) {
      const v = current(key) || { fails: 0, last: 0, lockedUntil: 0 };
      v.fails += 1;
      v.last = now();
      let locked = false;
      if (v.fails >= maxFails) {
        v.lockedUntil = now() + lockMs;
        locked = true;
      }
      map.delete(key); // 순서를 맨 뒤로(최근)
      map.set(key, v);
      pruneMap(map, maxKeys, expired);
      return locked;
    },
    /** 성공하면 기록을 지운다 */
    reset(key) {
      map.delete(key);
    },
    size() {
      return map.size;
    },
  };
}

/**
 * @param {object} opt
 * @param {number} opt.max      windowMs 안에 허용할 요청 수
 * @param {number} opt.windowMs
 * @param {number} [opt.maxKeys=10000]
 * @param {() => number} [opt.now]
 */
function createRateLimiter({ max, windowMs, maxKeys = 10000, now = Date.now }) {
  const map = new Map(); // key → { count, start }
  const expired = (v) => now() - v.start >= windowMs;
  return {
    /** 요청 1회를 세고, 허용이면 { ok:true }, 넘었으면 { ok:false, retryMs } */
    hit(key) {
      let v = map.get(key);
      if (!v || expired(v)) {
        v = { count: 0, start: now() };
        map.delete(key);
        map.set(key, v);
      }
      v.count += 1;
      pruneMap(map, maxKeys, expired);
      if (v.count > max) return { ok: false, retryMs: v.start + windowMs - now() };
      return { ok: true };
    },
    size() {
      return map.size;
    },
  };
}

/** 환경 변수 숫자 읽기 — 없거나 0 이하·숫자 아님이면 기본값 */
function envNumber(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}

module.exports = { createFailThrottle, createRateLimiter, envNumber };
