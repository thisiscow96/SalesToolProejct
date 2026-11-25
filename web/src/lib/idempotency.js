// T-203 Idempotency-Key 도우미 (설계 4장 머리말·3.7, 화면 6.7)
// 규칙: 폼 하나(직접 입력 창) = 키 하나 — 저장에 성공할 때까지 같은 키로 다시 보낸다.
//       클릭 하나(매입 등록·수동 확정·전환 취소) = 키 하나 — 누를 때마다 새 키.
//       서버가 409 RETRY(다른 작업과 겹침)를 주면 같은 키로 한 번만 자동 재시도한다.
// 키 형식: 8~80자 [A-Za-z0-9_-] (서버 검사와 같음)

export function newIdempotencyKey(prefix = 'w') {
  let rand = '';
  try {
    const a = new Uint8Array(12);
    window.crypto.getRandomValues(a);
    rand = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    rand = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  }
  return `${prefix}_${Date.now().toString(36)}_${rand}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
}

export const RETRY_DELAY_MS = 700;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 같은 키로 요청을 보내고, 409 RETRY 면 잠깐 쉬었다가 같은 키로 1회만 다시 보낸다.
 *   await withIdempotency((key) => purchaseDocApi.convert(lines, key), key?)
 * key 를 넘기지 않으면 새 키를 만든다(클릭 하나에 키 하나).
 */
export async function withIdempotency(send, key = newIdempotencyKey()) {
  try {
    return await send(key);
  } catch (e) {
    if (e && e.status === 409 && e.code === 'RETRY') {
      await sleep(RETRY_DELAY_MS);
      return send(key);
    }
    throw e;
  }
}
