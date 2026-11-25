'use strict';
/**
 * T-203 외부 경락 API 어댑터 공통 (D 3.2)
 *  - fetchPage() 는 예외를 던지지 않고 kind 로 분류한다:
 *    OK | EMPTY | AUTH_ERROR | QUOTA | RATE_LIMIT | SERVER_ERROR | TIMEOUT | BAD_RESPONSE
 *  - data.go.kr 게이트웨이는 오류를 HTTP 200 + XML 로 주기도 하므로 상태 코드와 본문을 함께 본다.
 *  - 키는 디코딩 키를 받아 URLSearchParams 로 한 번만 인코딩한다. 로그·원천 기록에는 maskUrl() 값만 남긴다.
 *  - Node 내장 fetch + AbortController 타임아웃(AUCTION_HTTP_TIMEOUT_MS, 기본 10초). 새 의존성 없음.
 */
const { maskUrl } = require('../mask');

const KINDS = ['OK', 'EMPTY', 'AUTH_ERROR', 'QUOTA', 'RATE_LIMIT', 'SERVER_ERROR', 'TIMEOUT', 'BAD_RESPONSE'];
const AUTH_CODES = new Set(['20', '30', '31', '32', '33']);

function timeoutMs(env = process.env) {
  const n = parseInt(env.AUCTION_HTTP_TIMEOUT_MS || '', 10);
  return Number.isFinite(n) && n >= 50 && n <= 120000 ? n : 10000;
}

/** Retry-After — 초 또는 HTTP 날짜 → 초 */
function parseRetryAfter(v, nowMs = Date.now()) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Math.min(parseInt(s, 10), 86400);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.min(Math.ceil((t - nowMs) / 1000), 86400));
}

/** 게이트웨이 XML 오류 본문에서 returnReasonCode */
function gatewayReason(body) {
  const m = /<returnReasonCode>\s*(\d+)\s*<\/returnReasonCode>/i.exec(body || '');
  return m ? m[1] : null;
}

/**
 * HTTP 결과 → kind (본문 JSON 해석 전 단계)
 * @returns { kind, retryAfterSec, json? }
 */
function classifyHttp(status, body, headers = {}) {
  const reason = gatewayReason(body);
  if (status === 401 || status === 403 || (reason && AUTH_CODES.has(reason))) return { kind: 'AUTH_ERROR', reason };
  if (reason === '22') return { kind: 'QUOTA', reason };
  if (status === 429) return { kind: 'RATE_LIMIT', retryAfterSec: parseRetryAfter(headers['retry-after']) };
  if (status >= 500 || reason === '99' || reason === '01' || reason === '04' || reason === '05') return { kind: 'SERVER_ERROR', reason };
  if (reason) return { kind: 'SERVER_ERROR', reason };
  if (status < 200 || status >= 300) return { kind: 'SERVER_ERROR' };
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: 'BAD_RESPONSE', message: 'JSON 해석 실패' };
  }
  return { kind: 'OK', json };
}

/** data.go.kr 표준 응답(JSON) → { kind, totalCount, items, message } */
function readStandardJson(json) {
  const resp = json && (json.response || json);
  const header = resp && resp.header;
  const body = resp && resp.body;
  if (!header || !body) return { kind: 'BAD_RESPONSE', message: '응답 형식(response.header/body)이 다릅니다.' };
  // 실 katRealTime2 는 정상을 "0" 으로 준다(2026-11-25 실호출 확인) — 표준 "00" 과 같게 본다(한 자리 코드는 앞에 0)
  const rawCode = String(header.resultCode ?? '').trim();
  const code = /^\d$/.test(rawCode) ? `0${rawCode}` : rawCode;
  if (code !== '00' && code !== '03') {
    if (AUTH_CODES.has(code)) return { kind: 'AUTH_ERROR', message: `resultCode ${code}` };
    if (code === '22') return { kind: 'QUOTA', message: `resultCode ${code}` };
    return { kind: 'SERVER_ERROR', message: `resultCode ${code} ${header.resultMsg || ''}`.trim() };
  }
  const totalCount = parseInt(body.totalCount ?? 0, 10) || 0;
  let items = body.items;
  if (items && typeof items === 'object' && !Array.isArray(items)) items = items.item;
  if (items == null || items === '') items = [];
  if (!Array.isArray(items)) items = [items];
  if (totalCount === 0 || items.length === 0) return { kind: code === '03' || totalCount === 0 ? 'EMPTY' : 'BAD_RESPONSE', totalCount, items: [], message: totalCount ? 'totalCount>0 인데 items 없음' : undefined };
  return { kind: 'OK', totalCount, items };
}

/** 실제 HTTP GET — 예외 없이 결과를 돌려준다 */
async function httpGet(url, { fetchImpl = globalThis.fetch, timeout = timeoutMs() } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  const started = Date.now();
  try {
    const r = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json, text/xml;q=0.9, */*;q=0.5' } });
    const text = await r.text();
    const headers = {};
    if (r.headers && typeof r.headers.forEach === 'function') r.headers.forEach((v, k) => { headers[String(k).toLowerCase()] = v; });
    return { status: r.status, body: text, headers, durationMs: Date.now() - started };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    return { status: 0, body: '', headers: {}, durationMs: Date.now() - started, error: aborted ? 'TIMEOUT' : 'NETWORK', errorMessage: maskUrl(err && err.message) };
  } finally {
    clearTimeout(t);
  }
}

/** URL 만들기 — 키는 URLSearchParams 가 한 번만 인코딩(디코딩 키를 받는다) */
function buildUrl(base, params, apiKey) {
  const u = new URL(base);
  const sp = new URLSearchParams();
  if (apiKey) sp.set('serviceKey', apiKey);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') sp.set(k, String(v));
  u.search = sp.toString();
  return u.toString();
}

/**
 * 로컬 실테스트 보조(운영에서는 둘 다 비워 둠):
 *  AUCTION_LIVE_CALL_LOG = 실호출 한 번마다 한 줄(시각·소스·조합·쪽·상태·건수 — 키 없음, URL 은 마스킹)
 *  AUCTION_RECORD_DIR    = 응답 원문을 재생(REPLAY) 파일 이름으로 저장(본문에는 키가 없음 — 그래도 serviceKey 패턴은 지움)
 */
function recordLive(source, params, r, masked, env = process.env) {
  if (env.NODE_ENV === 'production') return;
  try {
    const fs = require('fs');
    const path = require('path');
    if (env.AUCTION_LIVE_CALL_LOG) {
      fs.appendFileSync(env.AUCTION_LIVE_CALL_LOG, `${new Date().toISOString()} ${source} ${params.tradeDate || ''} ${params.itemL || 'all'}-${params.itemM || 'all'} p${params.pageNo || 1} http=${r.status} ms=${r.durationMs} bytes=${(r.body || '').length} ${masked}
`);
    }
    if (env.AUCTION_RECORD_DIR && r.status === 200 && r.body) {
      fs.mkdirSync(env.AUCTION_RECORD_DIR, { recursive: true });
      const name = `${params.tradeDate}_${params.itemL || 'all'}-${params.itemM || 'all'}_p${params.pageNo || 1}.json`;
      fs.writeFileSync(path.join(env.AUCTION_RECORD_DIR, name), maskUrl(r.body));
    }
  } catch { /* 보조 기록 실패는 수집에 영향 없음 */ }
}

class SourceAdapter {
  constructor({ apiKey = null, fetchImpl, mode = 'LIVE' } = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this._mode = mode;
  }

  get mode() { return this._mode; }

  /** 원천 행 → 0.2 필드 (FIELD_MAP 적용). 코드 매핑·kg 환산·마스킹은 Normalizer */
  toNormalized(item) {
    const out = {};
    for (const [dst, src] of Object.entries(this.constructor.FIELD_MAP || {})) {
      const v = item[src];
      out[dst] = v == null || v === '' ? null : String(v).trim();
    }
    return out;
  }

  /** 페이지 하나 받기 (LIVE) */
  async fetchPage(params) {
    const url = buildUrl(this.constructor.BASE_URL, this.buildParams(params), this.apiKey);
    const masked = maskUrl(url);
    const r = await httpGet(url, { fetchImpl: this.fetchImpl });
    recordLive(this.source, params, r, masked);
    return this.interpret(r, { masked, pageNo: params.pageNo || 1, requestParams: this.buildParams(params) });
  }

  /** HTTP 결과 → FetchPageResult */
  interpret(r, { masked, pageNo, requestParams }) {
    const base = { httpStatus: r.status, retryAfterSec: null, totalCount: 0, pageNo, items: [], rawBody: r.body || '', requestUrlMasked: masked, requestParams, durationMs: r.durationMs ?? null };
    if (r.error === 'TIMEOUT') return { ...base, kind: 'TIMEOUT', message: '응답 시간 초과' };
    if (r.error) return { ...base, kind: 'TIMEOUT', message: `연결 오류: ${r.errorMessage || ''}`.slice(0, 300) };
    const c = classifyHttp(r.status, r.body, r.headers);
    if (c.kind !== 'OK') return { ...base, kind: c.kind, retryAfterSec: c.retryAfterSec ?? null, message: c.message || (c.reason ? `returnReasonCode ${c.reason}` : `HTTP ${r.status}`) };
    const s = this.readBody(c.json);
    return { ...base, kind: s.kind, totalCount: s.totalCount || 0, items: s.items || [], message: s.message };
  }

  readBody(json) { return readStandardJson(json); }
}

module.exports = { SourceAdapter, KINDS, classifyHttp, readStandardJson, parseRetryAfter, gatewayReason, httpGet, buildUrl, timeoutMs };
