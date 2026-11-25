'use strict';
/**
 * T-203 Idempotency-Key (설계 3.7) — api_idempotency 표, 업무 트랜잭션과 같은 연결·같은 트랜잭션에서 쓴다
 *  1) BEGIN 직후 begin(): INSERT … ON CONFLICT DO NOTHING
 *     - 새 키 → { fresh:true }
 *     - 이미 있음 → route·request_hash 가 다르면 { reused:true }(422 IDEMPOTENCY_KEY_REUSED), 같으면 { replay:{status, body} }
 *     - 같은 키 동시 요청: 뒤 INSERT 는 앞 트랜잭션이 끝날 때까지 기다렸다가 충돌로 끝난다 → 앞 응답 재생
 *       (앞 요청이 ROLLBACK 이면 뒤 요청이 새로 처리)
 *  2) 업무가 끝나면 complete(): 응답을 저장하고 COMMIT. 실패(4xx·5xx)로 ROLLBACK 하면 키도 사라져 같은 키로 다시 시도할 수 있다.
 */
const crypto = require('crypto');

const KEY_RE = /^[A-Za-z0-9_-]{8,80}$/;

/** 헤더 읽기 — 없으면 { missing }, 형식 오류면 { bad } */
function readKey(req) {
  const raw = req.headers['idempotency-key'];
  if (raw == null || String(raw).trim() === '') return { missing: true };
  const k = String(raw).trim();
  if (!KEY_RE.test(k)) return { bad: true };
  return { key: k };
}

/** 같은 요청인지 볼 해시 — 키 순서와 무관하게 */
function requestHash(route, body) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
    return v;
  };
  return crypto.createHash('sha256').update(`${route}\n${JSON.stringify(canon(body ?? null))}`).digest('hex');
}

const REQUIRED = { ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED', message: '요청 키(Idempotency-Key)가 필요합니다. 화면을 새로고침해 다시 시도하세요.' };
const BAD = { ok: false, code: 'VALIDATION', field: 'Idempotency-Key', message: '요청 키 형식이 올바르지 않습니다(8~80자 영문·숫자·_-).' };
const REUSED = { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', message: '같은 요청 키로 다른 내용을 보냈습니다. 화면을 새로고침해 다시 시도하세요.' };

/** 헤더 검사 — 문제가 있으면 응답을 보내고 null */
function requireKey(req, res) {
  const k = readKey(req);
  if (k.missing) { res.status(400).json(REQUIRED); return null; }
  if (k.bad) { res.status(400).json(BAD); return null; }
  return k.key;
}

async function begin(client, { userId, key, route, body }) {
  const hash = requestHash(route, body);
  const ins = await client.query(
    `INSERT INTO api_idempotency (user_id, idem_key, route, request_hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, idem_key) DO NOTHING RETURNING idem_key`,
    [userId, key, String(route).slice(0, 80), hash]
  );
  if (ins.rows[0]) return { fresh: true };
  const r = await client.query(`SELECT route, request_hash, status_code, response FROM api_idempotency WHERE user_id = $1 AND idem_key = $2`, [userId, key]);
  const row = r.rows[0];
  if (!row) return { fresh: false, retry: true };
  if (row.route !== String(route).slice(0, 80) || row.request_hash !== hash) return { reused: true };
  if (row.response == null) return { fresh: false, retry: true };
  return { replay: { status: row.status_code || 200, body: row.response } };
}

async function complete(client, { userId, key, status, body }) {
  await client.query(
    `UPDATE api_idempotency SET status_code = $3, response = $4::jsonb, completed_at = NOW() WHERE user_id = $1 AND idem_key = $2`,
    [userId, key, status, JSON.stringify(body)]
  );
}

function sendReplay(res, replay) {
  res.setHeader('Idempotent-Replay', 'true');
  return res.status(replay.status).json(replay.body);
}

module.exports = { readKey, requireKey, requestHash, begin, complete, sendReplay, REQUIRED, REUSED, KEY_RE };
