import { useState, useEffect } from 'react';
import {
  fetchInventory,
  fetchPurchases,
  fetchSales,
  fetchPayments,
  fetchProducts,
  fetchPartners,
  getUser,
} from '../api';
import './Main.css';

const today = () => new Date().toISOString().slice(0, 10);
const firstDayOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};

function TabReorder() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  useEffect(() => {
    setLoading(true);
    setErr('');
    fetchInventory()
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);
  if (loading) return <p className="main-loading">불러오는 중…</p>;
  if (err) return <p className="main-error">{err}</p>;
  if (list.length === 0) return <p className="main-empty">등록된 재고가 없습니다.</p>;
  return (
    <div className="main-table-wrap">
      <table className="main-table">
        <thead>
          <tr>
            <th>상품명</th>
            <th>수량</th>
            <th>단위</th>
            <th>최종 반영</th>
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr key={row.id}>
              <td>{row.product_name}</td>
              <td className="num">{Number(row.quantity).toLocaleString()}</td>
              <td>{row.unit}</td>
              <td>{row.updated_at ? new Date(row.updated_at).toLocaleString('ko-KR') : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabPurchases() {
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [fromDate, setFromDate] = useState(today());
  const [toDate, setToDate] = useState(today());
  const [productId, setProductId] = useState('');
  const load = () => {
    setLoading(true);
    setErr('');
    const params = { from_date: fromDate, to_date: toDate };
    if (productId) params.product_id = productId;
    fetchPurchases(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    fetchProducts().then(setProducts).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [fromDate, toDate, productId]);
  return (
    <>
      <div className="main-filters">
        <label>기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /> ~ <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        <label>제품 <select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">전체</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      </div>
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">매입 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>매입일</th>
                <th>거래처</th>
                <th>상품</th>
                <th>수량</th>
                <th>단가</th>
                <th>총액</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>{row.purchase_date}</td>
                  <td>{row.partner_name}</td>
                  <td>{row.product_name}</td>
                  <td className="num">{Number(row.quantity).toLocaleString()}</td>
                  <td className="num">{Number(row.unit_price).toLocaleString()}</td>
                  <td className="num">{Number(row.total_amount).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TabSales() {
  const [list, setList] = useState([]);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [fromDate, setFromDate] = useState(firstDayOfMonth());
  const [toDate, setToDate] = useState(today());
  const [partnerId, setPartnerId] = useState('');
  const load = () => {
    setLoading(true);
    setErr('');
    const params = {};
    if (fromDate) params.from_date = fromDate;
    if (toDate) params.to_date = toDate;
    if (partnerId) params.partner_id = partnerId;
    fetchSales(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchPartners().then(setPartners).catch(() => {}); }, []);
  useEffect(() => { load(); }, [fromDate, toDate, partnerId]);
  return (
    <>
      <div className="main-filters">
        <label>기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /> ~ <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        <label>거래처 <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}><option value="">전체</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button type="button" onClick={load}>검색</button>
      </div>
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">매출 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>판매일</th>
                <th>거래처</th>
                <th>상품</th>
                <th>수량</th>
                <th>단가</th>
                <th>총액</th>
                <th>수금상태</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>{row.sale_date}</td>
                  <td>{row.partner_name}</td>
                  <td>{row.product_name}</td>
                  <td className="num">{Number(row.quantity).toLocaleString()}</td>
                  <td className="num">{Number(row.unit_price).toLocaleString()}</td>
                  <td className="num">{Number(row.total_amount).toLocaleString()}</td>
                  <td>{row.payment_status === 'paid' ? '완료' : row.payment_status === 'partial' ? '일부' : '미수'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TabPayments() {
  const [list, setList] = useState([]);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [fromDate, setFromDate] = useState(firstDayOfMonth());
  const [toDate, setToDate] = useState(today());
  const [partnerId, setPartnerId] = useState('');
  const load = () => {
    setLoading(true);
    setErr('');
    const params = {};
    if (fromDate) params.from_date = fromDate;
    if (toDate) params.to_date = toDate;
    if (partnerId) params.partner_id = partnerId;
    fetchPayments(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchPartners().then(setPartners).catch(() => {}); }, []);
  useEffect(() => { load(); }, [fromDate, toDate, partnerId]);
  return (
    <>
      <div className="main-filters">
        <label>기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /> ~ <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        <label>거래처 <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}><option value="">전체</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button type="button" onClick={load}>검색</button>
      </div>
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">수금 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>수금일</th>
                <th>거래처</th>
                <th>금액</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>{row.paid_at}</td>
                  <td>{row.partner_name}</td>
                  <td className="num">{Number(row.amount).toLocaleString()}</td>
                  <td>{row.memo || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TabProductMaster() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  useEffect(() => {
    setLoading(true);
    setErr('');
    fetchProducts()
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);
  if (loading) return <p className="main-loading">불러오는 중…</p>;
  if (err) return <p className="main-error">{err}</p>;
  if (list.length === 0) return <p className="main-empty">등록된 상품이 없습니다.</p>;
  return (
    <div className="main-table-wrap">
      <table className="main-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>상품명</th>
            <th>단위</th>
            <th>카테고리</th>
            <th>비고</th>
            <th>등록일</th>
            <th>수정일</th>
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr key={row.id}>
              <td className="num">{row.id}</td>
              <td>{row.name}</td>
              <td>{row.unit}</td>
              <td>{row.category || '-'}</td>
              <td>{row.memo || '-'}</td>
              <td>{row.created_at ? new Date(row.created_at).toLocaleString('ko-KR') : '-'}</td>
              <td>{row.updated_at ? new Date(row.updated_at).toLocaleString('ko-KR') : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const BASE_TABS = [
  { id: 'inventory', label: '재고현황', Component: TabReorder },
  { id: 'purchases', label: '매입정보', Component: TabPurchases },
  { id: 'sales', label: '매출정보', Component: TabSales },
  { id: 'payments', label: '수금정보', Component: TabPayments },
];
const ADMIN_TAB = { id: 'products', label: '상품 마스터', Component: TabProductMaster };

export default function Main() {
  const user = getUser();
  const tabs = user?.is_admin ? [...BASE_TABS, ADMIN_TAB] : BASE_TABS;
  const [activeTab, setActiveTab] = useState('inventory');
  const TabContent = tabs.find((t) => t.id === activeTab)?.Component;

  return (
    <div className="main-page">
      <header className="main-header">
        <h1 className="main-logo">판매툴</h1>
        <span className="main-user">{user?.name}님</span>
        <button
          type="button"
          className="main-logout"
          onClick={() => {
            window.sessionStorage.removeItem('user');
            window.location.href = '/login';
          }}
        >
          로그아웃
        </button>
      </header>
      <nav className="main-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={'main-tab ' + (activeTab === t.id ? 'active' : '')}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="main-content">
        {TabContent && <TabContent />}
      </main>
    </div>
  );
}
