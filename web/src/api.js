// 배포 시: Vercel 등에서 VITE_API_URL=https://백엔드주소 설정하면 해당 URL 사용
const API_BASE = import.meta.env.VITE_API_URL
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

export { getUser, API_BASE };
