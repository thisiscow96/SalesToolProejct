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
  const res = await apiFetch(`${API_BASE}/products${q ? '?' + q : ''}`);
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

export async function convertPurchasesToSales(items) {
  const res = await apiFetch(`${API_BASE}/purchases/convert-to-sales`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ items }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '매출 전환 실패');
  return data.data;
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

export { getUser, getToken, API_BASE };
