import { useState, useEffect } from 'react';
import {
  fetchInventory,
  fetchPurchases,
  fetchSales,
  fetchPayments,
  fetchProducts,
  fetchPartners,
  getUser,
  createProduct,
  createProductsBulk,
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
  const [categoryLarge, setCategoryLarge] = useState('');
  const [categoryMid, setCategoryMid] = useState('');
  const [categorySmall, setCategorySmall] = useState('');
  const [nameSearch, setNameSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState('single'); // 'single' | 'bulk'
  const [singleRow, setSingleRow] = useState({ product_key: '', name: '', unit: '', category_large: '', category_mid: '', category_small: '', memo: '' });
  const [bulkRows, setBulkRows] = useState([{ product_key: '', name: '', unit: '', category_large: '', category_mid: '', category_small: '', memo: '' }]);
  const [submitErr, setSubmitErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    setErr('');
    const params = {};
    if (categoryLarge) params.category_large = categoryLarge;
    if (categoryMid) params.category_mid = categoryMid;
    if (categorySmall) params.category_small = categorySmall;
    if (nameSearch) params.name = nameSearch;
    fetchProducts(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [categoryLarge, categoryMid, categorySmall, nameSearch]);

  const handleCreateSingle = (e) => {
    e.preventDefault();
    if (!singleRow.product_key?.trim()) {
      setSubmitErr('상품 키를 입력하세요.');
      return;
    }
    if (!singleRow.name?.trim()) {
      setSubmitErr('상품명을 입력하세요.');
      return;
    }
    setSubmitErr('');
    setSubmitting(true);
    createProduct(singleRow)
      .then(() => {
        setSingleRow({ product_key: '', name: '', unit: '', category_large: '', category_mid: '', category_small: '', memo: '' });
        load();
        setShowForm(false);
      })
      .catch((e) => setSubmitErr(e.message))
      .finally(() => setSubmitting(false));
  };

  const handleCreateBulk = (e) => {
    e.preventDefault();
    const products = bulkRows.filter((r) => r.product_key?.trim() && r.name?.trim());
    if (products.length === 0) {
      setSubmitErr('상품 키와 상품명을 모두 입력한 행이 없습니다.');
      return;
    }
    setSubmitErr('');
    setSubmitting(true);
    createProductsBulk(products)
      .then((data) => {
        setBulkRows([{ product_key: '', name: '', unit: '', category_large: '', category_mid: '', category_small: '', memo: '' }]);
        load();
        setShowForm(false);
        if (data.count) setErr(''); // clear any previous err
      })
      .catch((e) => setSubmitErr(e.message))
      .finally(() => setSubmitting(false));
  };

  const addBulkRow = () => setBulkRows((prev) => [...prev, { product_key: '', name: '', unit: '', category_large: '', category_mid: '', category_small: '', memo: '' }]);
  const setBulkRow = (idx, field, value) => setBulkRows((prev) => {
    const next = [...prev];
    next[idx] = { ...next[idx], [field]: value };
    return next;
  });

  const distinct = (key) => [...new Set(list.map((r) => r[key]).filter(Boolean))].sort();

  return (
    <>
      <div className="main-filters" style={{ flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        <label>대분류
          <select value={categoryLarge} onChange={(e) => setCategoryLarge(e.target.value)}>
            <option value="">전체</option>
            {distinct('category_large').map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>중분류
          <select value={categoryMid} onChange={(e) => setCategoryMid(e.target.value)}>
            <option value="">전체</option>
            {distinct('category_mid').map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>소분류
          <select value={categorySmall} onChange={(e) => setCategorySmall(e.target.value)}>
            <option value="">전체</option>
            {distinct('category_small').map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label>이름 검색
          <input type="text" value={nameSearch} onChange={(e) => setNameSearch(e.target.value)} placeholder="상품명" style={{ width: '140px' }} />
        </label>
        <button type="button" className="main-btn" onClick={() => { setShowForm(!showForm); setSubmitErr(''); }}>
          {showForm ? '취소' : '새로만들기'}
        </button>
      </div>

      {showForm && (
        <div className="product-master-form">
          <div className="product-master-form-tabs">
            <button type="button" className={'main-tab-toggle ' + (formMode === 'single' ? 'active' : '')} onClick={() => setFormMode('single')}>단건 등록</button>
            <button type="button" className={'main-tab-toggle ' + (formMode === 'bulk' ? 'active' : '')} onClick={() => setFormMode('bulk')}>다건 등록</button>
          </div>
          {submitErr && <p className="main-error" style={{ marginBottom: '8px' }}>{submitErr}</p>}
          {formMode === 'single' && (
            <form onSubmit={handleCreateSingle}>
              <div className="main-table-wrap product-master-single-table">
                <table className="main-table">
                  <thead>
                    <tr>
                      <th>상품 키 *</th>
                      <th>상품명 *</th>
                      <th>단위</th>
                      <th>대분류</th>
                      <th>중분류</th>
                      <th>소분류</th>
                      <th>비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td><input value={singleRow.product_key} onChange={(e) => setSingleRow((s) => ({ ...s, product_key: e.target.value }))} placeholder="필수" /></td>
                      <td><input value={singleRow.name} onChange={(e) => setSingleRow((s) => ({ ...s, name: e.target.value }))} placeholder="필수" /></td>
                      <td><input value={singleRow.unit} onChange={(e) => setSingleRow((s) => ({ ...s, unit: e.target.value }))} /></td>
                      <td><input value={singleRow.category_large} onChange={(e) => setSingleRow((s) => ({ ...s, category_large: e.target.value }))} /></td>
                      <td><input value={singleRow.category_mid} onChange={(e) => setSingleRow((s) => ({ ...s, category_mid: e.target.value }))} /></td>
                      <td><input value={singleRow.category_small} onChange={(e) => setSingleRow((s) => ({ ...s, category_small: e.target.value }))} /></td>
                      <td><input value={singleRow.memo} onChange={(e) => setSingleRow((s) => ({ ...s, memo: e.target.value }))} /></td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <button type="submit" disabled={submitting}>{submitting ? '등록 중…' : '등록'}</button>
            </form>
          )}
          {formMode === 'bulk' && (
            <form onSubmit={handleCreateBulk}>
              <div className="main-table-wrap product-master-bulk-table">
                <table className="main-table">
                  <thead>
                    <tr>
                      <th>상품 키 *</th>
                      <th>상품명 *</th>
                      <th>단위</th>
                      <th>대분류</th>
                      <th>중분류</th>
                      <th>소분류</th>
                      <th>비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((row, idx) => (
                      <tr key={idx}>
                        <td><input value={row.product_key} onChange={(e) => setBulkRow(idx, 'product_key', e.target.value)} placeholder="필수" /></td>
                        <td><input value={row.name} onChange={(e) => setBulkRow(idx, 'name', e.target.value)} placeholder="필수" /></td>
                        <td><input value={row.unit} onChange={(e) => setBulkRow(idx, 'unit', e.target.value)} /></td>
                        <td><input value={row.category_large} onChange={(e) => setBulkRow(idx, 'category_large', e.target.value)} /></td>
                        <td><input value={row.category_mid} onChange={(e) => setBulkRow(idx, 'category_mid', e.target.value)} /></td>
                        <td><input value={row.category_small} onChange={(e) => setBulkRow(idx, 'category_small', e.target.value)} /></td>
                        <td><input value={row.memo} onChange={(e) => setBulkRow(idx, 'memo', e.target.value)} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <button type="button" onClick={addBulkRow} style={{ marginRight: '8px' }}>행 추가</button>
              <button type="submit" disabled={submitting}>{submitting ? '등록 중…' : '일괄 등록'}</button>
            </form>
          )}
        </div>
      )}

      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">등록된 상품이 없습니다. 검색 조건을 바꾸거나 새로만들기로 등록하세요.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>상품 키</th>
                <th>상품명</th>
                <th>단위</th>
                <th>대분류</th>
                <th>중분류</th>
                <th>소분류</th>
                <th>비고</th>
                <th>등록일</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td className="num">{row.id}</td>
                  <td>{row.product_key || '-'}</td>
                  <td>{row.name}</td>
                  <td>{row.unit}</td>
                  <td>{row.category_large || '-'}</td>
                  <td>{row.category_mid || '-'}</td>
                  <td>{row.category_small || '-'}</td>
                  <td>{row.memo || '-'}</td>
                  <td>{row.created_at ? new Date(row.created_at).toLocaleString('ko-KR') : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
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
