// API BASE URL
// - 로컬 개발( localhost:* )에서는 언제나 Vite 프록시(/api -> 3000)를 타도록 '/api' 고정
// - 배포(Vercel 등)에서는 VITE_API_URL 이 있으면 그 값을 사용, 없으면 현재 origin 기준 '/api'
const isLocalhost =
  typeof window !== 'undefined' &&
  (window.location.origin.startsWith('http://localhost:') ||
    window.location.origin.startsWith('http://127.0.0.1:'));

const API_BASE = isLocalhost
  ? '/api'
  : import.meta.env.VITE_API_URL
    ? import.meta.env.VITE_API_URL.replace(/\/$/, '') + '/api'
    : '/api';

function getUser() {
  try {
    const s = window.sessionStorage.getItem('user');
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

// 로그인 토큰 (T-101) — 로그인 응답의 token 을 sessionStorage 'user' 안에 함께 둔다.
// 로그아웃이 'user' 를 지우면 토큰도 같이 지워진다.
function getToken() {
  return getUser()?.token || null;
}

function authHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** 토큰이 만료·위조돼 서버가 401을 주면 저장된 로그인 정보를 지우고 로그인 화면으로 보낸다 */
function handleUnauthorized(status) {
  if (status !== 401 || !getUser()) return;
  try {
    window.sessionStorage.removeItem('user');
  } catch {
    /* 저장소 접근 불가 — 무시 */
  }
  window.location.href = '/login';
}

async function apiFetch(url, options) {
  const res = await fetch(url, options);
  handleUnauthorized(res.status);
  return res;
}

export async function fetchProducts(params = {}) {
  const q = new URLSearchParams(params).toString();
  // 로그인 토큰을 붙여야 내 개인 품목(T-216)도 함께 온다 — 토큰이 없으면 공용 품목만
  const res = await apiFetch(`${API_BASE}/products${q ? '?' + q : ''}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function createProduct(body) {
  const res = await apiFetch(`${API_BASE}/products`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '등록 실패');
  return data.data;
}

export async function createProductsBulk(products) {
  const res = await apiFetch(`${API_BASE}/products/bulk`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ products }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '다건 등록 실패');
  return data;
}

/** 서버 오류 응답을 code·product 와 함께 던진다 (중복 품목 안내에 쓰임) */
async function jsonOrThrow(res, fallback) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.message || fallback);
    e.code = data.code;
    e.product = data.product;
    throw e;
  }
  return data;
}

// ---------- 개인 품목·공용 등록 요청 (T-216) ----------
/** 목록에 없는 품목을 내 개인 품목으로 추가. request_public=true 면 관리자에게 공용 등록 요청도 함께 */
export async function createPersonalProduct(body) {
  const res = await apiFetch(`${API_BASE}/products/personal`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  return (await jsonOrThrow(res, '개인 품목 등록 실패')).data;
}

export async function requestProductPublic(productId, note) {
  const res = await apiFetch(`${API_BASE}/products/requests`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ product_id: productId, note }),
  });
  return (await jsonOrThrow(res, '공용 등록 요청 실패')).data;
}

export async function fetchProductRequests(status) {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await apiFetch(`${API_BASE}/products/requests${q}`, { headers: authHeaders() });
  return (await jsonOrThrow(res, '요청 목록 조회 실패')).data;
}

export async function approveProductRequest(id, body = {}) {
  const res = await apiFetch(`${API_BASE}/products/requests/${id}/approve`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
  return (await jsonOrThrow(res, '승인 실패')).data;
}

export async function rejectProductRequest(id, reason) {
  const res = await apiFetch(`${API_BASE}/products/requests/${id}/reject`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ reason }) });
  return (await jsonOrThrow(res, '반려 실패')).data;
}

export async function fetchPartners() {
  const res = await apiFetch(`${API_BASE}/partners`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchInventory() {
  const res = await apiFetch(`${API_BASE}/inventory`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchPurchases(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await apiFetch(`${API_BASE}/purchases?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

/** 매입 등록 모달 — 같은 상품(+거래처)의 최근 매입 단가 (T-210). 기록이 없으면 null */
export async function fetchLastPurchasePrice(productId, partnerId) {
  const q = new URLSearchParams({ product_id: String(productId) });
  if (partnerId) q.set('partner_id', String(partnerId));
  const res = await apiFetch(`${API_BASE}/purchases/last-price?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

/** 매입 등록 모달 — 최근 매입한 거래처 순서 [{ partner_id, last_date, cnt }] (T-210) */
export async function fetchRecentPurchasePartners() {
  const res = await apiFetch(`${API_BASE}/purchases/recent-partners`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchSales(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await apiFetch(`${API_BASE}/sales?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

/** 일별 매입·매출 집계: from_date, to_date 필수(같은 날짜면 당일만); partner_id 선택 시 매입=구입처·매출=판매처 기준 */
export async function fetchDailyPurchaseSales(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await apiFetch(`${API_BASE}/reports/daily-purchase-sales?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

/** 상품·거래처별 매입/매출 건수·수량·금액·미수(매출 행만) — 동일 query 규칙 */
export async function fetchDailyPurchaseSalesBreakdown(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await apiFetch(`${API_BASE}/reports/daily-purchase-sales-breakdown?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchPayments(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await apiFetch(`${API_BASE}/payments?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function createPurchase(body) {
  const res = await apiFetch(`${API_BASE}/purchases`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '매입 등록 실패');
  return data.data;
}

/**
 * 매출 전환. opts.credit_confirmed=true 는 외상 한도 경고를 보고 저장하는 경우(T-207).
 * 실패 오류에는 서버 code·detail 을 붙인다(409 CREDIT_LIMIT 이면 detail.credit_warnings).
 * 돌려주는 값은 예전과 같은 data 배열이고, 한도를 넘겨 저장했으면 배열에 credit_warnings 속성이 붙는다.
 */
export async function convertPurchasesToSales(items, opts = {}) {
  const res = await apiFetch(`${API_BASE}/purchases/convert-to-sales`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ items, ...(opts.credit_confirmed ? { credit_confirmed: true } : {}) }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || '매출 전환 실패'), { status: res.status, code: data.code || null, detail: data.detail || null });
  const out = data.data;
  if (Array.isArray(out) && data.credit_warnings) out.credit_warnings = data.credit_warnings;
  return out;
}

export async function createPayment(body) {
  const res = await apiFetch(`${API_BASE}/payments`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '수금 등록 실패');
  return data.data;
}

export async function refundSale(saleId, body) {
  const res = await apiFetch(`${API_BASE}/sales/${saleId}/refund`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '환불 실패');
  return data.data;
}

export async function createDisposal(body) {
  const res = await apiFetch(`${API_BASE}/disposals`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '폐기 등록 실패');
  return data.data;
}

export async function fetchDisposals(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await apiFetch(`${API_BASE}/disposals?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function uploadSalesforceContentVersion({ file, title, first_publish_location_id }) {
  const user = getUser();
  const form = new FormData();
  form.append('file', file);
  if (title) form.append('title', title);
  if (first_publish_location_id) form.append('first_publish_location_id', first_publish_location_id);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/file-transfer/salesforce/content-version`, true);
    if (user?.token) {
      xhr.setRequestHeader('Authorization', `Bearer ${user.token}`);
    }
    xhr.onerror = () => reject(new Error('Salesforce 파일 전송 실패'));
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch (_) {
        data = {};
      }
      handleUnauthorized(xhr.status);
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.message || 'Salesforce 파일 전송 실패'));
        return;
      }
      resolve(data.data);
    };
    xhr.send(form);
  });
}

/** 거래처 원장 (T-104) — params: from, to(YYYY-MM-DD, 선택), include_cancelled(1) */
export async function fetchPartnerLedger(partnerId, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const res = await apiFetch(`${API_BASE}/partners/${encodeURIComponent(partnerId)}/ledger${q ? '?' + q : ''}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '원장을 불러오지 못했습니다.');
  return data.data;
}

/** 미수 연령 (T-104) — params: partner_id(주면 매출별 상세 sales 포함), min_days */
export async function fetchReceivablesAging(params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
  const res = await apiFetch(`${API_BASE}/receivables/aging${q ? '?' + q : ''}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '미수 연령을 불러오지 못했습니다.');
  return data.data;
}

/** 첫 화면 "오늘" (T-208) — 오늘 매입·매출·수금, 총미수·연령, 오래된 재고·미수 거래처 상위 5 */
export async function fetchDashboard() {
  const res = await apiFetch(`${API_BASE}/dashboard`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '오늘 현황을 불러오지 못했습니다.');
  return data.data;
}

export { getUser, getToken, API_BASE };
