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
  createPurchase,
  convertPurchasesToSales,
  createPayment,
  refundSale,
  createDisposal,
  fetchDisposals,
} from '../api';
import './Main.css';

const today = () => new Date().toISOString().slice(0, 10);
const firstDayOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};

const PURCHASE_ACCOUNT_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market']);
const SALE_ACCOUNT_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);

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
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [fromDate, setFromDate] = useState(firstDayOfMonth());
  const [toDate, setToDate] = useState(today());
  const [productId, setProductId] = useState('');
  const [selected, setSelected] = useState({});
  const [showForm, setShowForm] = useState(false);
  const [showConvert, setShowConvert] = useState(false);
  const [form, setForm] = useState({
    partner_id: '',
    product_id: '',
    quantity: '',
    unit_price: '',
    purchase_date: today(),
    memo: '',
  });
  const [convertCustomer, setConvertCustomer] = useState('');
  const [convertDate, setConvertDate] = useState(today());
  const [convertRows, setConvertRows] = useState([]);
  const [actionErr, setActionErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

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
    fetchPartners().then(setPartners).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [fromDate, toDate, productId]);

  const purchasePartners = partners.filter((p) => PURCHASE_ACCOUNT_TYPES.has(p.type));
  const salePartners = partners.filter((p) => SALE_ACCOUNT_TYPES.has(p.type));

  const toggleRow = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }));

  const openConvert = () => {
    setActionErr('');
    const ids = list.filter((r) => selected[r.id] && Number(r.remaining_qty) > 0).map((r) => r.id);
    if (ids.length === 0) {
      setActionErr('남은 수량이 있는 매입을 선택하세요.');
      return;
    }
    const rows = list
      .filter((r) => selected[r.id] && Number(r.remaining_qty) > 0)
      .map((r) => ({
        purchase_id: r.id,
        product_name: r.product_name,
        remaining_qty: Number(r.remaining_qty),
        quantity: String(Number(r.remaining_qty)),
        unit_price: String(Number(r.unit_price)),
      }));
    setConvertRows(rows);
    setConvertCustomer('');
    setConvertDate(today());
    setShowConvert(true);
  };

  const submitPurchase = (e) => {
    e.preventDefault();
    setActionErr('');
    setSubmitting(true);
    createPurchase({
      partner_id: parseInt(form.partner_id, 10),
      product_id: parseInt(form.product_id, 10),
      quantity: Number(form.quantity),
      unit_price: Number(form.unit_price),
      purchase_date: form.purchase_date,
      memo: form.memo || undefined,
    })
      .then(() => {
        setForm({ partner_id: '', product_id: '', quantity: '', unit_price: '', purchase_date: today(), memo: '' });
        setShowForm(false);
        load();
      })
      .catch((er) => setActionErr(er.message))
      .finally(() => setSubmitting(false));
  };

  const submitConvert = (e) => {
    e.preventDefault();
    if (!convertCustomer) {
      setActionErr('판매처를 선택하세요.');
      return;
    }
    setActionErr('');
    setSubmitting(true);
    const items = convertRows.map((r) => ({
      purchase_id: r.purchase_id,
      partner_id: parseInt(convertCustomer, 10),
      quantity: Number(r.quantity),
      unit_price: Number(r.unit_price),
      sale_date: convertDate,
    }));
    convertPurchasesToSales(items)
      .then(() => {
        setShowConvert(false);
        setSelected({});
        load();
      })
      .catch((er) => setActionErr(er.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <>
      <div className="main-filters" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <label>기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /> ~ <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        <label>제품 <select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">전체</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button type="button" className="main-btn" onClick={load}>검색</button>
        <button type="button" onClick={() => { setShowForm(!showForm); setActionErr(''); }}>{showForm ? '매입 등록 닫기' : '매입 등록'}</button>
        <button type="button" onClick={openConvert}>선택 매출 전환</button>
      </div>
      {actionErr && <p className="main-error">{actionErr}</p>}
      {showForm && (
        <form className="main-inline-form" onSubmit={submitPurchase} style={{ marginBottom: '12px', padding: '12px', border: '1px solid #ddd', borderRadius: '8px' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
            <label>매입처
              <select required value={form.partner_id} onChange={(e) => setForm((f) => ({ ...f, partner_id: e.target.value }))}>
                <option value="">선택</option>
                {purchasePartners.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
              </select>
            </label>
            <label>상품
              <select required value={form.product_id} onChange={(e) => setForm((f) => ({ ...f, product_id: e.target.value }))}>
                <option value="">선택</option>
                {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>수량 <input required type="number" step="0.001" min="0" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></label>
            <label>단가 <input required type="number" step="0.01" min="0" value={form.unit_price} onChange={(e) => setForm((f) => ({ ...f, unit_price: e.target.value }))} /></label>
            <label>매입일 <input required type="date" value={form.purchase_date} onChange={(e) => setForm((f) => ({ ...f, purchase_date: e.target.value }))} /></label>
            <label>비고 <input value={form.memo} onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))} /></label>
            <button type="submit" disabled={submitting}>{submitting ? '처리 중…' : '등록'}</button>
          </div>
        </form>
      )}
      {showConvert && (
        <form onSubmit={submitConvert} style={{ marginBottom: '12px', padding: '12px', border: '1px solid #ccc', borderRadius: '8px' }}>
          <h4 style={{ margin: '0 0 8px' }}>매출 전환</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
            <label>판매처
              <select required value={convertCustomer} onChange={(e) => setConvertCustomer(e.target.value)}>
                <option value="">선택</option>
                {salePartners.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
              </select>
            </label>
            <label>판매일 <input required type="date" value={convertDate} onChange={(e) => setConvertDate(e.target.value)} /></label>
          </div>
          <div className="main-table-wrap">
            <table className="main-table">
              <thead>
                <tr>
                  <th>매입 ID</th>
                  <th>상품</th>
                  <th>남은 수량</th>
                  <th>전환 수량</th>
                  <th>판매 단가</th>
                </tr>
              </thead>
              <tbody>
                {convertRows.map((r) => (
                  <tr key={r.purchase_id}>
                    <td className="num">{r.purchase_id}</td>
                    <td>{r.product_name}</td>
                    <td className="num">{r.remaining_qty}</td>
                    <td>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        max={r.remaining_qty}
                        value={r.quantity}
                        onChange={(e) => setConvertRows((rows) => rows.map((x) => (x.purchase_id === r.purchase_id ? { ...x, quantity: e.target.value } : x)))}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={r.unit_price}
                        onChange={(e) => setConvertRows((rows) => rows.map((x) => (x.purchase_id === r.purchase_id ? { ...x, unit_price: e.target.value } : x)))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button type="submit" disabled={submitting} style={{ marginTop: '8px' }}>{submitting ? '처리 중…' : '전환 실행'}</button>
          <button type="button" style={{ marginLeft: '8px' }} onClick={() => setShowConvert(false)}>취소</button>
        </form>
      )}
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">매입 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th style={{ width: '36px' }}>선택</th>
                <th>매입일</th>
                <th>거래처</th>
                <th>상품</th>
                <th>수량</th>
                <th>매출 반영</th>
                <th>잔여</th>
                <th>단가</th>
                <th>총액</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={!!selected[row.id]}
                      onChange={() => toggleRow(row.id)}
                      disabled={Number(row.remaining_qty) <= 0}
                    />
                  </td>
                  <td>{row.purchase_date}</td>
                  <td>{row.partner_name}</td>
                  <td>{row.product_name}</td>
                  <td className="num">{Number(row.quantity).toLocaleString()}</td>
                  <td className="num">{Number(row.allocated_qty || 0).toLocaleString()}</td>
                  <td className="num">{Number(row.remaining_qty != null ? row.remaining_qty : row.quantity).toLocaleString()}</td>
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
  const [showCollect, setShowCollect] = useState(false);
  const [collectPartner, setCollectPartner] = useState('');
  const [collectDate, setCollectDate] = useState(today());
  const [collectAlloc, setCollectAlloc] = useState({});
  const [saleErr, setSaleErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refundRow, setRefundRow] = useState(null);
  const [refundQty, setRefundQty] = useState('');
  const [refundAmt, setRefundAmt] = useState('');
  const [refundDate, setRefundDate] = useState(today());
  const [refundReason, setRefundReason] = useState('');

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

  const salePartners = partners.filter((p) => SALE_ACCOUNT_TYPES.has(p.type));

  const unpaidForCollect = list.filter(
    (s) => String(s.partner_id) === String(collectPartner)
      && s.payment_status !== 'paid'
      && s.status !== 'refunded'
      && s.status !== 'cancelled',
  );

  const allocSum = unpaidForCollect.reduce((acc, s) => acc + (Number(collectAlloc[s.id]) || 0), 0);

  const openCollect = () => {
    setSaleErr('');
    setCollectPartner(partnerId || '');
    setCollectDate(today());
    setCollectAlloc({});
    setShowCollect(true);
  };

  const submitCollect = (e) => {
    e.preventDefault();
    if (!collectPartner) {
      setSaleErr('거래처를 선택하세요.');
      return;
    }
    const allocations = unpaidForCollect
      .map((s) => ({ sale_id: s.id, amount: Number(collectAlloc[s.id]) || 0 }))
      .filter((a) => a.amount > 0);
    if (allocations.length === 0) {
      setSaleErr('배분할 매출과 금액을 입력하세요.');
      return;
    }
    const paySum = allocations.reduce((a, x) => a + x.amount, 0);
    if (Math.abs(paySum - allocSum) > 0.02) {
      setSaleErr('배분 합계와 입력 금액이 맞지 않습니다. 행마다 입력했는지 확인하세요.');
      return;
    }
    setSaleErr('');
    setSubmitting(true);
    createPayment({
      partner_id: parseInt(collectPartner, 10),
      amount: paySum,
      paid_at: collectDate,
      entry_kind: 'receive',
      allocations,
    })
      .then(() => {
        setShowCollect(false);
        load();
      })
      .catch((er) => setSaleErr(er.message))
      .finally(() => setSubmitting(false));
  };

  const openRefund = (row) => {
    const maxQ = Number(row.quantity) - Number(row.refunded_qty || 0);
    setRefundRow(row);
    setRefundQty(String(maxQ > 0 ? maxQ : ''));
    setRefundAmt('');
    setRefundDate(today());
    setRefundReason('');
    setSaleErr('');
  };

  const submitRefund = (e) => {
    e.preventDefault();
    if (!refundRow) return;
    setSaleErr('');
    setSubmitting(true);
    const body = {
      quantity: Number(refundQty),
      refunded_at: refundDate,
      reason: refundReason || undefined,
    };
    if (refundAmt !== '' && refundAmt != null) body.refund_amount = Number(refundAmt);
    refundSale(refundRow.id, body)
      .then(() => {
        setRefundRow(null);
        load();
      })
      .catch((er) => setSaleErr(er.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <>
      <div className="main-filters" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <label>기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /> ~ <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        <label>거래처 <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}><option value="">전체</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button type="button" onClick={load}>검색</button>
        <button type="button" className="main-btn" onClick={openCollect}>수금 등록</button>
      </div>
      {saleErr && <p className="main-error">{saleErr}</p>}
      {showCollect && (
        <form onSubmit={submitCollect} style={{ marginBottom: '12px', padding: '12px', border: '1px solid #ccc', borderRadius: '8px' }}>
          <h4 style={{ margin: '0 0 8px' }}>수금 등록 (미수 매출 배분)</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
            <label>거래처
              <select required value={collectPartner} onChange={(e) => { setCollectPartner(e.target.value); setCollectAlloc({}); }}>
                <option value="">선택</option>
                {salePartners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
            <label>수금일 <input required type="date" value={collectDate} onChange={(e) => setCollectDate(e.target.value)} /></label>
            <span style={{ alignSelf: 'center' }}>배분 합계: <strong>{allocSum.toLocaleString()}</strong> 원</span>
          </div>
          {collectPartner && unpaidForCollect.length === 0 && <p className="main-empty">이 거래처의 미수 매출이 없습니다. 기간·필터를 넓혀 검색하세요.</p>}
          {unpaidForCollect.length > 0 && (
            <div className="main-table-wrap">
              <table className="main-table">
                <thead>
                  <tr>
                    <th>매출 ID</th>
                    <th>일자</th>
                    <th>상품</th>
                    <th>총액</th>
                    <th>기수금</th>
                    <th>이번 수금</th>
                  </tr>
                </thead>
                <tbody>
                  {unpaidForCollect.map((s) => {
                    const due = Number(s.total_amount) - Number(s.paid_amount);
                    return (
                      <tr key={s.id}>
                        <td className="num">{s.id}</td>
                        <td>{s.sale_date}</td>
                        <td>{s.product_name}</td>
                        <td className="num">{Number(s.total_amount).toLocaleString()}</td>
                        <td className="num">{Number(s.paid_amount).toLocaleString()}</td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            max={due}
                            placeholder={`최대 ${due.toLocaleString()}`}
                            value={collectAlloc[s.id] ?? ''}
                            onChange={(e) => setCollectAlloc((m) => ({ ...m, [s.id]: e.target.value }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <button type="submit" disabled={submitting || unpaidForCollect.length === 0} style={{ marginTop: '8px' }}>{submitting ? '처리 중…' : '수금 저장'}</button>
          <button type="button" style={{ marginLeft: '8px' }} onClick={() => setShowCollect(false)}>닫기</button>
        </form>
      )}
      {refundRow && (
        <form onSubmit={submitRefund} style={{ marginBottom: '12px', padding: '12px', border: '1px solid #faa', borderRadius: '8px' }}>
          <h4 style={{ margin: '0 0 8px' }}>환불 — 매출 #{refundRow.id} {refundRow.product_name}</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            <label>반품 수량 <input required type="number" step="0.001" min="0" value={refundQty} onChange={(e) => setRefundQty(e.target.value)} /></label>
            <label>환불 금액(선택) <input type="number" step="0.01" min="0" value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} placeholder="미입력 시 재고만 복귀" /></label>
            <label>환불일 <input required type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)} /></label>
            <label>사유 <input value={refundReason} onChange={(e) => setRefundReason(e.target.value)} style={{ minWidth: '200px' }} /></label>
          </div>
          <button type="submit" disabled={submitting} style={{ marginTop: '8px' }}>{submitting ? '처리 중…' : '환불 실행'}</button>
          <button type="button" style={{ marginLeft: '8px' }} onClick={() => setRefundRow(null)}>취소</button>
        </form>
      )}
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">매출 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>판매일</th>
                <th>거래처</th>
                <th>상품</th>
                <th>수량</th>
                <th>환불</th>
                <th>단가</th>
                <th>총액</th>
                <th>수금</th>
                <th>상태</th>
                <th style={{ width: '72px' }} />
              </tr>
            </thead>
            <tbody>
              {list.map((row) => {
                const rf = Number(row.refunded_qty || 0);
                const canRefund = row.status !== 'refunded' && row.status !== 'cancelled' && Number(row.quantity) - rf > 0;
                return (
                  <tr key={row.id}>
                    <td>{row.sale_date}</td>
                    <td>{row.partner_name}</td>
                    <td>{row.product_name}</td>
                    <td className="num">{Number(row.quantity).toLocaleString()}</td>
                    <td className="num">{rf.toLocaleString()}</td>
                    <td className="num">{Number(row.unit_price).toLocaleString()}</td>
                    <td className="num">{Number(row.total_amount).toLocaleString()}</td>
                    <td>{row.payment_status === 'paid' ? '완료' : row.payment_status === 'partial' ? '일부' : '미수'}</td>
                    <td>{row.status === 'refunded' ? '전액환불' : row.status === 'cancelled' ? '취소' : '정상'}</td>
                    <td>
                      {canRefund ? (
                        <button type="button" className="main-btn" onClick={() => openRefund(row)}>환불</button>
                      ) : (
                        '-'
                      )}
                    </td>
                  </tr>
                );
              })}
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
                <th>구분</th>
                <th>거래처</th>
                <th>금액</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>{row.paid_at}</td>
                  <td>{(row.entry_kind || 'receive') === 'refund' ? '환불' : '수금'}</td>
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

function TabDisposals() {
  const [list, setList] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [fromDate, setFromDate] = useState(firstDayOfMonth());
  const [toDate, setToDate] = useState(today());
  const [form, setForm] = useState({ product_id: '', quantity: '', disposal_date: today(), reason: '', memo: '' });
  const [actionErr, setActionErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    setErr('');
    const params = {};
    if (fromDate) params.from_date = fromDate;
    if (toDate) params.to_date = toDate;
    fetchDisposals(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    fetchProducts().then(setProducts).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [fromDate, toDate]);

  const submit = (e) => {
    e.preventDefault();
    setActionErr('');
    setSubmitting(true);
    createDisposal({
      product_id: parseInt(form.product_id, 10),
      quantity: Number(form.quantity),
      disposal_date: form.disposal_date,
      reason: form.reason || undefined,
      memo: form.memo || undefined,
    })
      .then(() => {
        setForm({ product_id: '', quantity: '', disposal_date: today(), reason: '', memo: '' });
        load();
      })
      .catch((er) => setActionErr(er.message))
      .finally(() => setSubmitting(false));
  };

  return (
    <>
      <div className="main-filters" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <label>기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /> ~ <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
        <button type="button" onClick={load}>검색</button>
      </div>
      <form onSubmit={submit} style={{ marginBottom: '12px', padding: '12px', border: '1px solid #ddd', borderRadius: '8px' }}>
        <h4 style={{ margin: '0 0 8px' }}>폐기 등록</h4>
        {actionErr && <p className="main-error">{actionErr}</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' }}>
          <label>상품
            <select required value={form.product_id} onChange={(e) => setForm((f) => ({ ...f, product_id: e.target.value }))}>
              <option value="">선택</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>수량 <input required type="number" step="0.001" min="0" value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></label>
          <label>폐기일 <input required type="date" value={form.disposal_date} onChange={(e) => setForm((f) => ({ ...f, disposal_date: e.target.value }))} /></label>
          <label>사유 <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></label>
          <label>비고 <input value={form.memo} onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))} /></label>
          <button type="submit" disabled={submitting}>{submitting ? '처리 중…' : '폐기 반영'}</button>
        </div>
      </form>
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">폐기 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>폐기일</th>
                <th>상품</th>
                <th>수량</th>
                <th>사유</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td>{row.disposal_date}</td>
                  <td>{row.product_name}</td>
                  <td className="num">{Number(row.quantity).toLocaleString()} {row.unit || ''}</td>
                  <td>{row.reason || '-'}</td>
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
  { id: 'disposals', label: '폐기정보', Component: TabDisposals },
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
