'use strict';
/**
 * T-203 소스 어댑터 5종 + 목업 (D 3.2)
 *   AT_REALTIME  aT 전국 공영도매시장 실시간 경매정보(data.go.kr 15141808, katRealTime2) — 건별, 대조의 주 소스
 *   AT_SETTLE    aT 정산정보(15141809, katSale) — 집계, 누락 검증(SETTLE_VERIFY)
 *   AT_CODE      aT 표준코드(15141818, katCode) — code_master
 *   GARAK_PRICE  가락시장 주요품목 가격(15004517) — 참고 시세(집계)
 *   MOCK         키가 없거나 AUCTION_SOURCE_MODE=mock 이면 위 넷이 목업 파일(lib/auction/mock/)로 돈다. 저장 source = 'MOCK'
 *
 * FIELD_MAP: 왼쪽 = 내부 필드(D 0.2), 오른쪽 = 원천 필드. 공개 명세에 있는 이름(trd_clcln_ymd·scsbd_dt·whsl_mrkt_cd·corp_cd·
 *   gds_*clsf_cd·grd_cd·pkg_cd·sz_cd·unit_cd·plor_cd)은 확인된 이름, 나머지(auc_seq·*_nm·scsbd_prc·qty·unit_qty·shpr_nm·
 *   mdlmrchnt_no)는 [가정] 이름 — 키 발급 후 첫 호출일에 실제 응답과 다르면 이 표와 mock 파일만 고친다(내부 스키마는 그대로).
 */
const fs = require('fs');
const path = require('path');
const { SourceAdapter, timeoutMs } = require('./base');

const MOCK_DIR = path.join(__dirname, '..', 'mock');

class AtRealtimeAdapter extends SourceAdapter {
  get source() { return 'AT_REALTIME'; }
  buildParams({ tradeDate, marketCode, itemL, itemM, itemS, pageNo = 1, numOfRows = 1000 }) {
    return {
      'cond[trd_clcln_ymd::EQ]': tradeDate,
      'cond[whsl_mrkt_cd::EQ]': marketCode,
      'cond[gds_lclsf_cd::EQ]': itemL,
      'cond[gds_mclsf_cd::EQ]': itemM,
      'cond[gds_sclsf_cd::EQ]': itemS,
      pageNo, numOfRows, returnType: 'json',
    };
  }
}
AtRealtimeAdapter.BASE_URL = 'https://apis.data.go.kr/B552845/katRealTime2/trades2';
AtRealtimeAdapter.FIELD_MAP = {
  source_id: 'auc_seq',
  trade_date: 'trd_clcln_ymd', auction_at: 'scsbd_dt',
  market_code: 'whsl_mrkt_cd', market_name: 'whsl_mrkt_nm',
  corp_code: 'corp_cd', corp_name: 'corp_nm',
  item_l_code: 'gds_lclsf_cd', item_m_code: 'gds_mclsf_cd', item_m_name: 'gds_mclsf_nm', item_s_code: 'gds_sclsf_cd', item_name_raw: 'gds_sclsf_nm',
  grade_code: 'grd_cd', grade_name: 'grd_nm',
  pkg_code: 'pkg_cd', pkg_name: 'pkg_nm',
  size_code: 'sz_cd', size_name: 'sz_nm',
  unit_code: 'unit_cd', unit_name: 'unit_nm', unit_qty: 'unit_qty',
  qty: 'qty', unit_price: 'scsbd_prc',
  origin_code: 'plor_cd', origin_name: 'plor_nm',
  shipper_name: 'shpr_nm', buyer_code: 'mdlmrchnt_no',
};

class AtSettleAdapter extends SourceAdapter {
  get source() { return 'AT_SETTLE'; }
  buildParams({ tradeDate, marketCode, pageNo = 1, numOfRows = 1000 }) {
    return { 'cond[trd_clcln_ymd::EQ]': tradeDate, 'cond[whsl_mrkt_cd::EQ]': marketCode, pageNo, numOfRows, returnType: 'json' };
  }
}
AtSettleAdapter.BASE_URL = 'https://apis.data.go.kr/B552845/katSale/trades';
AtSettleAdapter.FIELD_MAP = {
  trade_date: 'trd_clcln_ymd', market_code: 'whsl_mrkt_cd', corp_code: 'corp_cd', corp_name: 'corp_nm',
  item_m_code: 'gds_mclsf_cd', item_m_name: 'gds_mclsf_nm', item_s_code: 'gds_sclsf_cd', item_name_raw: 'gds_sclsf_nm',
  trade_qty: 'trd_qty', min_price: 'min_prc', max_price: 'max_prc', avg_price: 'avg_prc', total_amount: 'tot_amt',
};

class AtCodeAdapter extends SourceAdapter {
  get source() { return 'AT_CODE'; }
  buildParams({ pageNo = 1, numOfRows = 1000 }) { return { pageNo, numOfRows, returnType: 'json' }; }
}
AtCodeAdapter.BASE_URL = 'https://apis.data.go.kr/B552845/katCode/items';
AtCodeAdapter.FIELD_MAP = {
  item_l_code: 'gds_lclsf_cd', item_l_name: 'gds_lclsf_nm', item_m_code: 'gds_mclsf_cd', item_m_name: 'gds_mclsf_nm',
  item_s_code: 'gds_sclsf_cd', item_s_name: 'gds_sclsf_nm',
};

/** 가락 주요품목 가격 — XML(<lists><list>…</list></lists>). 의존성 없이 정규식으로 읽는다 */
class GarakPriceAdapter extends SourceAdapter {
  get source() { return 'GARAK_PRICE'; }
  buildParams({ tradeDate, pageNo = 1, numOfRows = 1000 }) {
    return { date: tradeDate ? tradeDate.replace(/-/g, '') : undefined, pageNo, numOfRows };
  }
  interpret(r, meta) {
    const base = { httpStatus: r.status, retryAfterSec: null, totalCount: 0, pageNo: meta.pageNo, items: [], rawBody: r.body || '', requestUrlMasked: meta.masked, requestParams: meta.requestParams, durationMs: r.durationMs ?? null };
    if (r.error) return { ...base, kind: 'TIMEOUT', message: '응답 시간 초과' };
    if (/<returnReasonCode>/i.test(r.body || '') || r.status !== 200) return super.interpret(r, meta);
    const rows = [];
    const re = /<list>([\s\S]*?)<\/list>/gi;
    let m;
    while ((m = re.exec(r.body || ''))) {
      const o = {};
      const fre = /<([A-Z_]+)>([^<]*)<\/\1>/g;
      let f;
      while ((f = fre.exec(m[1]))) o[f[1]] = f[2].trim();
      rows.push(o);
    }
    const tc = /<list_total_count>\s*(\d+)/i.exec(r.body || '');
    if (!rows.length) return { ...base, kind: tc && tc[1] === '0' ? 'EMPTY' : 'BAD_RESPONSE' };
    return { ...base, kind: 'OK', totalCount: tc ? parseInt(tc[1], 10) : rows.length, items: rows };
  }
}
GarakPriceAdapter.BASE_URL = process.env.GARAK_API_URL || 'https://apis.data.go.kr/B552845/garakPrice/items'; // [가정] 첫 호출로 확인
GarakPriceAdapter.FIELD_MAP = {
  item_name_raw: 'PUM_NM', item_code: 'PUM_CD', grade_name: 'G_NAME', unit_qty: 'U_QTY', unit_name: 'U_NAME', avg_price: 'AV_P', prev_price: 'P_AV_P',
};

const CLASSES = { AT_REALTIME: AtRealtimeAdapter, AT_SETTLE: AtSettleAdapter, AT_CODE: AtCodeAdapter, GARAK_PRICE: GarakPriceAdapter };
const KEY_ENV = { AT_REALTIME: 'AT_AUCTION_API_KEY', AT_SETTLE: 'AT_AUCTION_API_KEY', AT_CODE: 'AT_AUCTION_API_KEY', GARAK_PRICE: 'GARAK_API_KEY' };

// ---------------------------------------------------------------------------
// 목업 — 파일을 HTTP 응답처럼 돌려주고, 같은 interpret() 로 분류한다(분류 코드를 테스트가 그대로 지난다)
// ---------------------------------------------------------------------------
const MOCK_BASE_DATE = '2026-11-23';
const SCENARIOS = {
  AT_REALTIME: {
    normal: () => ({ file: 'at_realtime_normal.json' }),
    paged: ({ pageNo }) => ({ file: pageNo >= 2 ? 'at_realtime_paged_p2.json' : 'at_realtime_paged_p1.json' }),
    paged_changed: ({ pageNo }) => ({ file: pageNo >= 2 ? 'at_realtime_paged_p2_count_changed.json' : 'at_realtime_paged_p1.json' }),
    empty: () => ({ file: 'at_realtime_empty.json' }),
    revised: () => ({ file: 'at_realtime_revised.json' }),
    bad: () => ({ file: 'at_realtime_bad_fields.json' }),
  },
  AT_SETTLE: { normal: () => ({ file: 'at_settle_normal.json' }), settle: () => ({ file: 'at_settle_normal.json' }), empty: () => ({ file: 'at_realtime_empty.json' }) },
  AT_CODE: { normal: () => ({ file: 'at_code_items.json' }), code: () => ({ file: 'at_code_items.json' }) },
  GARAK_PRICE: { normal: () => ({ file: 'garak_price_normal.xml', type: 'text/xml' }), garak: () => ({ file: 'garak_price_normal.xml', type: 'text/xml' }) },
};
const ERROR_SCENARIOS = {
  auth: () => ({ file: 'at_error_auth.xml', type: 'text/xml' }),
  auth401: () => ({ file: 'at_error_auth.xml', type: 'text/xml', status: 401 }),
  quota: () => ({ file: 'at_error_quota.xml', type: 'text/xml' }),
  rate429: () => ({ file: 'at_error_429.json', status: 429, headers: { 'retry-after': '120' } }),
  '5xx': () => ({ file: 'at_error_502.html', type: 'text/html', status: 502 }),
  unknown: () => ({ file: 'at_error_unknown.xml', type: 'text/xml' }),
  timeout: () => ({ timeout: true }),
};

function readMock(file) {
  return fs.readFileSync(path.join(MOCK_DIR, file), 'utf8');
}

class MockAdapter {
  constructor(real, { scenario } = {}) {
    this.real = real;
    this.scenario = scenario || process.env.AUCTION_MOCK_SCENARIO || 'normal';
    this.calls = 0;
  }
  get source() { return this.real.source; }
  get mode() { return 'MOCK'; }
  buildParams(p) { return this.real.buildParams(p); }
  toNormalized(item) { return this.real.toNormalized(item); }

  /** 시나리오 이름 하나 또는 'a,b,c'(호출마다 다음 것, 마지막 것 반복) */
  pickScenario() {
    const list = String(this.scenario).split(',').map((s) => s.trim()).filter(Boolean);
    const s = list[Math.min(this.calls, list.length - 1)] || 'normal';
    this.calls += 1;
    return s;
  }

  async fetchPage(params) {
    const pageNo = params.pageNo || 1;
    const requestParams = this.buildParams(params);
    const masked = `mock://${this.source}?serviceKey=****&${new URLSearchParams(requestParams).toString()}`;
    const name = this.pickScenario();
    const table = SCENARIOS[this.source] || {};
    const spec = (table[name] || ERROR_SCENARIOS[name] || table.normal)({ pageNo });
    const started = Date.now();
    if (spec.timeout) {
      const wait = timeoutMs() + 150;
      await new Promise((r) => setTimeout(r, wait));
      return this.real.interpret({ status: 0, body: '', headers: {}, error: 'TIMEOUT', durationMs: Date.now() - started }, { masked, pageNo, requestParams });
    }
    let body = readMock(spec.file);
    if (params.tradeDate && params.tradeDate !== MOCK_BASE_DATE) {
      body = body.split(MOCK_BASE_DATE).join(params.tradeDate).split(MOCK_BASE_DATE.replace(/-/g, '')).join(params.tradeDate.replace(/-/g, ''));
    }
    return this.real.interpret({ status: spec.status || 200, body, headers: spec.headers || {}, durationMs: Date.now() - started }, { masked, pageNo, requestParams });
  }
}

/** 소스 모드 — 키가 없거나 AUCTION_SOURCE_MODE=mock 이면 MOCK. 키 값은 절대 밖으로 내보내지 않는다 */
function sourceMode(source, env = process.env) {
  if (String(env.AUCTION_SOURCE_MODE || '').toLowerCase() === 'mock') return 'MOCK';
  const k = KEY_ENV[source];
  return k && env[k] && String(env[k]).trim() ? 'LIVE' : 'MOCK';
}

/** @param opts.scenario 목업 시나리오(작업 params.mock_scenario — 테스트 DB 전용) */
function createAdapter(source, opts = {}, env = process.env) {
  const C = CLASSES[source];
  if (!C) throw new Error(`unknown source ${source}`);
  const mode = sourceMode(source, env);
  if (mode === 'MOCK') return new MockAdapter(new C({ mode: 'MOCK' }), { scenario: opts.scenario });
  return new C({ apiKey: String(env[KEY_ENV[source]]).trim(), fetchImpl: opts.fetchImpl, mode: 'LIVE' });
}

/** 외부 키 값 목록(오류 문구에서 지울 때만 씀) */
function secretValues(env = process.env) {
  return [env.AT_AUCTION_API_KEY, env.GARAK_API_KEY, env.COLLECT_TRIGGER_TOKEN].filter(Boolean);
}

module.exports = {
  createAdapter, sourceMode, secretValues, MockAdapter, AtRealtimeAdapter, AtSettleAdapter, AtCodeAdapter, GarakPriceAdapter,
  MOCK_DIR, MOCK_BASE_DATE, SCENARIOS, ERROR_SCENARIOS,
};
