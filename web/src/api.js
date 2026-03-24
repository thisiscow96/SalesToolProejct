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

function authHeaders() {
  const user = getUser();
  return {
    'Content-Type': 'application/json',
    ...(user?.agent_no ? { 'X-Agent-No': String(user.agent_no) } : {}),
  };
}

export async function fetchProducts(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/products${q ? '?' + q : ''}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function createProduct(body) {
  const res = await fetch(`${API_BASE}/products`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '등록 실패');
  return data.data;
}

export async function createProductsBulk(products) {
  const res = await fetch(`${API_BASE}/products/bulk`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ products }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '다건 등록 실패');
  return data;
}

export async function fetchPartners() {
  const res = await fetch(`${API_BASE}/partners`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchInventory() {
  const res = await fetch(`${API_BASE}/inventory`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchPurchases(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/purchases?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchSales(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/sales?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function fetchPayments(params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/payments?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function createPurchase(body) {
  const res = await fetch(`${API_BASE}/purchases`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '매입 등록 실패');
  return data.data;
}

export async function convertPurchasesToSales(items) {
  const res = await fetch(`${API_BASE}/purchases/convert-to-sales`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ items }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '매출 전환 실패');
  return data.data;
}

export async function createPayment(body) {
  const res = await fetch(`${API_BASE}/payments`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '수금 등록 실패');
  return data.data;
}

export async function refundSale(saleId, body) {
  const res = await fetch(`${API_BASE}/sales/${saleId}/refund`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '환불 실패');
  return data.data;
}

export async function createDisposal(body) {
  const res = await fetch(`${API_BASE}/disposals`, {
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
  const res = await fetch(`${API_BASE}/disposals?${q}`, { headers: authHeaders() });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || '조회 실패');
  return data.data;
}

export async function uploadSalesforceContentVersion({ file, title, first_publish_location_id, onProgress }) {
  const user = getUser();
  const form = new FormData();
  form.append('file', file);
  if (title) form.append('title', title);
  if (first_publish_location_id) form.append('first_publish_location_id', first_publish_location_id);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}/file-transfer/salesforce/content-version`, true);
    if (user?.agent_no) {
      xhr.setRequestHeader('X-Agent-No', String(user.agent_no));
    }
    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable || typeof onProgress !== 'function') return;
      onProgress({
        loaded: evt.loaded,
        total: evt.total,
        percent: Math.min(100, Math.round((evt.loaded / evt.total) * 100)),
      });
    };
    xhr.onerror = () => reject(new Error('Salesforce 파일 전송 실패'));
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch (_) {
        data = {};
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.message || 'Salesforce 파일 전송 실패'));
        return;
      }
      resolve(data.data);
    };
    xhr.send(form);
  });
}

export { getUser, API_BASE };
