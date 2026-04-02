import { useState, useEffect, useMemo } from 'react';
import {
  fetchInventory,
  fetchPurchases,
  fetchSales,
  fetchPayments,
  fetchProducts,
  fetchPartners,
  getUser,
  createProductsBulk,
  createPurchase,
  convertPurchasesToSales,
  createPayment,
  refundSale,
  createDisposal,
  fetchDisposals,
} from '../api';
import './Main.css';

const pad2 = (n) => String(n).padStart(2, '0');
/** 오늘 날짜 yyyy-mm-dd (로컬) */
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - Number(n || 0));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const firstDayOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/** 검색 파라미터용 — 유효한 yyyy-mm-dd 만 통과 */
function sanitizeYmd(s, fallback) {
  const t = String(s ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return fallback;
}

/** 검색 기간: yyyy-mm-dd — 브라우저 달력(type=date) + 키보드 입력 */
function DateSearchField({ value, onChange, id }) {
  const v = String(value ?? '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
  return (
    <input
      id={id}
      type="date"
      className="main-date-input-ymd"
      autoComplete="off"
      value={normalized}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 날짜만 yyyy-mm-dd (DB/Date/문자열 모두 처리) */
function toYmd(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/** 매입정보 목록 — YYYY-MM-DD HH:mm (매입일 + 등록시각) */
function formatPurchaseTableDateTime(row) {
  const datePart = toYmd(row.purchase_date);
  const ts = row.created_at;
  if (ts) {
    const t = new Date(ts);
    if (!Number.isNaN(t.getTime())) {
      const dp = datePart || toYmd(t);
      return `${dp} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
    }
  }
  return `${datePart || today()} 00:00`;
}

/** 매출 — YYYY-MM-DD HH:mm */
function formatSaleDateTime(row) {
  const datePart = toYmd(row.sale_date);
  const ts = row.created_at;
  if (ts) {
    const t = new Date(ts);
    if (!Number.isNaN(t.getTime())) {
      const dp = datePart || toYmd(t);
      return `${dp} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
    }
  }
  return `${datePart || today()} 00:00`;
}

/** 폐기 — YYYY-MM-DD HH:mm */
function formatDisposalDateTime(row) {
  const ymd = toYmd(row.disposal_date);
  const ts = row.created_at;
  if (ts) {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) {
      return `${ymd || toYmd(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
  }
  return `${ymd || today()} 00:00`;
}

/** 수금 — 수금일시 YYYY-MM-DD HH:mm */
function formatPaymentDateTime(row) {
  const ts = row.paid_at;
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatProductCreatedYmd(row) {
  if (!row.created_at) return '—';
  return toYmd(row.created_at);
}

/** 표시용 숫자(천단위 콤마, ko-KR) */
function formatKoNumber(n) {
  if (n == null || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString('ko-KR');
}

function formatMb(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0.00';
  return (n / (1024 * 1024)).toFixed(2);
}

/** 금액·단가 입력: 콤마 제거 후 숫자·소수점만 */
function normalizeMoneyInputString(s) {
  let t = String(s ?? '').replace(/,/g, '');
  t = t.replace(/[^\d.]/g, '');
  const first = t.indexOf('.');
  if (first !== -1) {
    t = t.slice(0, first + 1) + t.slice(first + 1).replace(/\./g, '');
  }
  return t;
}

/** 금액·단가 입력란 비포커스 시 천단위 콤마 표시 */
function formatMoneyInputDisplay(raw) {
  if (raw === '' || raw == null) return '';
  const s = String(raw);
  if (s === '.') return '0.';
  const parts = s.split('.');
  const intPart = parts[0] ?? '';
  const dec = parts.length > 1 ? parts.slice(1).join('.') : undefined;
  if (intPart === '' && dec !== undefined) return dec === '' ? '0.' : `0.${dec}`;
  const intNum = intPart === '' ? 0 : Number(intPart);
  if (Number.isNaN(intNum)) return s;
  const intFmt = intNum.toLocaleString('ko-KR');
  if (dec === undefined) return intFmt;
  return `${intFmt}.${dec}`;
}

function parseMoneyToNumber(s) {
  const t = normalizeMoneyInputString(s);
  if (t === '' || t === '.') return NaN;
  const n = Number(t);
  return Number.isNaN(n) ? NaN : n;
}

/** 재고 — 매입일만 YYYY-MM-DD */
function formatInventoryDateOnly(row) {
  if (row.last_purchase_date) return toYmd(row.last_purchase_date);
  if (row.last_purchase_created_at) {
    const d = new Date(row.last_purchase_created_at);
    if (!Number.isNaN(d.getTime())) {
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    }
  }
  return '—';
}

/** 수금 등록 — 숫자만, 최대 9자리 */
function CollectAmountInput({ value, onChange, disabled, placeholder, className, max }) {
  const raw = String(value ?? '').replace(/\D/g, '').slice(0, 9);
  const maxNum = Number(max);
  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      className={'main-input-collect-amount ' + (className || '')}
      value={raw}
      maxLength={9}
      onChange={(e) => {
        const nextRaw = e.target.value.replace(/\D/g, '').slice(0, 9);
        const nextNum = Number(nextRaw || 0);
        if (Number.isFinite(maxNum) && maxNum >= 0 && nextRaw && nextNum > maxNum) {
          onChange(String(Math.floor(maxNum)));
          return;
        }
        onChange(nextRaw);
      }}
      disabled={disabled}
      placeholder={placeholder}
    />
  );
}

/** 단가·금액: 입력 시 천단위 콤마, 저장값은 숫자 문자열(콤마 없음) */
function UnitPriceInput({ value, onChange, disabled, placeholder, className }) {
  const [focused, setFocused] = useState(false);
  const raw = normalizeMoneyInputString(value);
  const display = focused ? raw : formatMoneyInputDisplay(raw);
  return (
    <input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      className={'main-input-unit-price ' + (className || '')}
      value={display}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => onChange(normalizeMoneyInputString(e.target.value))}
      disabled={disabled}
      placeholder={placeholder}
    />
  );
}

/** 긴 텍스트: hover 시 전체(title), 가로 스크롤로 전체 확인 */
function CellText({ children, className }) {
  const text = children == null || children === false ? '' : String(children);
  return (
    <span className={'main-cell-text-scroll ' + (className || '')} title={text}>
      {text}
    </span>
  );
}

/** 수금 모달 — datetime-local 용 기본값 (yyyy-mm-ddTHH:mm) */
function defaultCollectDateTime() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 열린 모달 개수 — body 스크롤 잠금 (중첩 모달 대응) */
let mainModalScrollLockCount = 0;

function Modal({
  open,
  title,
  onClose,
  children,
  formId,
  saveLabel = '저장',
  submitting,
  saveDisabled,
  wide,
  fill,
  modalClassName = '',
}) {
  useEffect(() => {
    if (!open) return;
    mainModalScrollLockCount += 1;
    if (mainModalScrollLockCount === 1) document.body.style.overflow = 'hidden';
    return () => {
      mainModalScrollLockCount -= 1;
      if (mainModalScrollLockCount <= 0) {
        mainModalScrollLockCount = 0;
        document.body.style.overflow = '';
      }
    };
  }, [open]);

  if (!open) return null;
  const disabled = submitting || saveDisabled;
  return (
    <div
      className="main-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={
          'main-modal' +
          (wide ? ' main-modal--wide' : '') +
          (fill ? ' main-modal--fill' : '') +
          (modalClassName ? ` ${modalClassName}` : '')
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="main-modal-title"
      >
        <div className="main-modal-header">
          <h2 id="main-modal-title">{title}</h2>
        </div>
        <div className="main-modal-body">{children}</div>
        <div className="main-modal-footer">
          <button type="button" className="main-modal-btn secondary" onClick={onClose}>
            취소
          </button>
          <button type="submit" form={formId} className="main-modal-btn primary" disabled={disabled}>
            {submitting ? '처리 중…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const PURCHASE_ACCOUNT_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market']);
const SALE_ACCOUNT_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);

/** 환불 사유 픽리스트 */
const REFUND_REASON_CUSTOMER = 'customer';
const REFUND_REASON_QUALITY = 'quality';
const REFUND_REASON_CUSTOM = 'custom';

/** 폐기 사유 픽리스트 */
const DISPOSAL_REASON_SPOIL = 'spoil';
const DISPOSAL_REASON_DISPOSE = 'dispose';
const DISPOSAL_REASON_CUSTOM = 'custom';

function newDisposalInventoryDraft() {
  return {
    quantity: '',
    disposal_date: today(),
    reasonCode: DISPOSAL_REASON_SPOIL,
    reasonOther: '',
  };
}

function buildDisposalReasonFromDraft(d) {
  const c = d.reasonCode || DISPOSAL_REASON_SPOIL;
  if (c === DISPOSAL_REASON_SPOIL) return '상품 변질';
  if (c === DISPOSAL_REASON_DISPOSE) return '상품 폐기';
  if (c === DISPOSAL_REASON_CUSTOM) {
    const t = String(d.reasonOther ?? '').trim();
    return t || '직접 입력';
  }
  return '';
}

/** 수금 반영 수량(비율): 총 수량 × (수금액/매출금액) */
function computeCollectedQty(s) {
  const q = Number(s.quantity);
  const ta = Number(s.total_amount);
  const pa = Number(s.paid_amount);
  if (!Number.isFinite(q) || ta <= 0 || !Number.isFinite(pa)) return 0;
  return (pa / ta) * q;
}

/** 환불 가능 수량 = 총 수량 − 환불된 수량(환불 누적) */
function computeRefundPossibleQty(s) {
  const q = Number(s.quantity);
  const rf = Number(s.refunded_qty || 0);
  if (!Number.isFinite(q)) return 0;
  return Math.max(0, q - rf);
}

/** 반품(환불) 금액 = (환불 요청수량 / 총 수량) × 매출 금액(수금 발생액) */
function computeAutoRefundAmount(s, requestQty) {
  const tot = Number(s.quantity);
  const paid = Number(s.paid_amount);
  const rq = Number(requestQty);
  if (!Number.isFinite(tot) || tot <= 0 || !Number.isFinite(rq) || rq <= 0 || !Number.isFinite(paid)) return 0;
  return Math.round((rq / tot) * paid * 100) / 100;
}

function buildRefundReasonFromDraft(d) {
  const c = d.reasonCode || REFUND_REASON_CUSTOMER;
  if (c === REFUND_REASON_CUSTOMER) return '고객변심';
  if (c === REFUND_REASON_QUALITY) return '품질 문제';
  if (c === REFUND_REASON_CUSTOM) {
    const t = String(d.reasonOther ?? '').trim();
    return t || '직접 기입';
  }
  return '';
}

function newPurchaseRow() {
  return {
    key: `pur-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    partner_id: '',
    product_id: '',
    quantity: '',
    unit_price: '',
    purchase_date: today(),
    selected: false,
  };
}

function newProductMasterRow() {
  return {
    key: `pm-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    name: '',
    unit: '',
    category_large: '',
    category_mid: '',
    category_small: '',
    memo: '',
  };
}

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
            <th className="main-col-product">상품명</th>
            <th className="main-col-partner">매입 거래처</th>
            <th className="main-col-qty">수량</th>
            <th>단위</th>
            <th className="main-col-date">매입일</th>
          </tr>
        </thead>
        <tbody>
          {list.map((row) => (
            <tr key={row.id}>
              <td className="main-td-scroll main-col-product"><CellText>{row.product_name}</CellText></td>
              <td className="main-td-scroll main-col-partner"><CellText>{(row.last_partner_name && String(row.last_partner_name).trim()) || '—'}</CellText></td>
              <td className="num main-col-qty">{formatKoNumber(row.quantity)}</td>
              <td>{row.unit}</td>
              <td className="main-col-date">{formatInventoryDateOnly(row)}</td>
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
  const [purchaseRows, setPurchaseRows] = useState([newPurchaseRow()]);
  const [convertCustomer, setConvertCustomer] = useState('');
  const [convertDate, setConvertDate] = useState(today());
  const [convertRows, setConvertRows] = useState([]);
  const [actionErr, setActionErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    setLoading(true);
    setErr('');
    const params = {
      from_date: sanitizeYmd(fromDate, firstDayOfMonth()),
      to_date: sanitizeYmd(toDate, today()),
    };
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
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 진입 시 필터 기준 1회 검색만; 이후는 검색 버튼
  }, []);

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

  const updatePurchaseRow = (key, patch) => {
    setPurchaseRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const addPurchaseRow = () => {
    setActionErr('');
    setPurchaseRows((rows) => [...rows, newPurchaseRow()]);
  };

  const removePurchaseRow = (key) => {
    setPurchaseRows((rows) => (rows.length <= 1 ? rows : rows.filter((r) => r.key !== key)));
  };

  const cloneSelectedPurchaseRows = () => {
    const picked = purchaseRows.filter((r) => r.selected);
    if (picked.length === 0) {
      setActionErr('복제할 행을 선택하세요.');
      return;
    }
    setActionErr('');
    const clones = picked.map((r) => ({
      ...newPurchaseRow(),
      partner_id: r.partner_id,
      product_id: r.product_id,
      quantity: r.quantity,
      unit_price: r.unit_price,
      purchase_date: r.purchase_date,
      selected: false,
    }));
    setPurchaseRows((prev) => [...prev, ...clones]);
  };

  const togglePurchaseRowSelect = (key) => {
    setPurchaseRows((rows) => rows.map((r) => (r.key === key ? { ...r, selected: !r.selected } : r)));
  };

  const togglePurchaseSelectAll = () => {
    const allOn = purchaseRows.length > 0 && purchaseRows.every((r) => r.selected);
    setPurchaseRows((rows) => rows.map((r) => ({ ...r, selected: !allOn })));
  };

  const submitPurchase = async (e) => {
    e.preventDefault();
    setActionErr('');
    const partial = purchaseRows.some((r) => {
      const any = r.partner_id || r.product_id || r.quantity !== '' || r.unit_price !== '';
      const full =
        r.partner_id &&
        r.product_id &&
        r.quantity !== '' &&
        r.unit_price !== '' &&
        r.purchase_date;
      return any && !full;
    });
    if (partial) {
      setActionErr('입력이 완료되지 않은 행이 있습니다. 비우거나 모두 채워 주세요.');
      return;
    }
    const toSubmit = purchaseRows.filter(
      (r) => r.partner_id && r.product_id && r.quantity !== '' && r.unit_price !== '' && r.purchase_date,
    );
    if (toSubmit.length === 0) {
      setActionErr('최소 1행을 입력하세요.');
      return;
    }
    setSubmitting(true);
    try {
      for (const r of toSubmit) {
        await createPurchase({
          partner_id: parseInt(r.partner_id, 10),
          product_id: parseInt(r.product_id, 10),
          quantity: Number(r.quantity),
          unit_price: parseMoneyToNumber(r.unit_price),
          purchase_date: r.purchase_date,
        });
      }
      setShowForm(false);
      setPurchaseRows([newPurchaseRow()]);
      load();
    } catch (er) {
      setActionErr(er.message || '매입 등록 실패');
    } finally {
      setSubmitting(false);
    }
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
      unit_price: parseMoneyToNumber(r.unit_price),
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
      {actionErr && (
        <div className="main-alert-banner" role="alert">
          {actionErr}
        </div>
      )}
      <div className="main-filters" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <label className="main-date-filter">
          기간 <DateSearchField value={fromDate} onChange={setFromDate} id="pur-from" /> ~{' '}
          <DateSearchField value={toDate} onChange={setToDate} id="pur-to" />
        </label>
        <label>제품 <select value={productId} onChange={(e) => setProductId(e.target.value)}><option value="">전체</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button type="button" className="main-btn" onClick={load}>검색</button>
        <button
          type="button"
          className="main-btn"
          onClick={() => {
            setActionErr('');
            setShowForm(true);
          }}
        >
          매입 등록
        </button>
        <button type="button" className="main-btn" onClick={openConvert}>선택 매출 전환</button>
      </div>
      <Modal
        open={showForm}
        title="매입 등록"
        wide
        fill
        modalClassName="main-modal--purchase"
        onClose={() => {
          setShowForm(false);
          setActionErr('');
        }}
        formId="form-purchase-modal"
        submitting={submitting}
      >
        <form id="form-purchase-modal" className="main-modal-form" onSubmit={submitPurchase}>
          <div className="main-modal-toolbar">
            <button type="button" className="main-modal-toolbar-btn" onClick={addPurchaseRow}>
              ＋ 행 추가
            </button>
            <button type="button" className="main-modal-toolbar-btn" onClick={cloneSelectedPurchaseRows}>
              복제
            </button>
          </div>
          <div className="main-table-wrap main-modal-table-wrap">
            <table className="main-table main-table--purchase-modal">
              <thead>
                <tr>
                  <th className="main-col-check">
                    <input type="checkbox" checked={purchaseRows.length > 0 && purchaseRows.every((r) => r.selected)} onChange={togglePurchaseSelectAll} title="전체 선택" />
                  </th>
                  <th className="main-col-partner">매입처</th>
                  <th className="main-col-product">상품</th>
                  <th className="main-col-qty main-col-qty--purchase-input">수량</th>
                  <th className="main-col-unit-price main-col-unit-price--purchase-input">단가</th>
                  <th className="main-col-date main-col-date--purchase-input">매입일</th>
                  <th className="main-col-row-actions" aria-label="행 삭제" />
                </tr>
              </thead>
              <tbody>
                {purchaseRows.map((row) => (
                  <tr key={row.key}>
                    <td className="main-col-check">
                      <input type="checkbox" checked={!!row.selected} onChange={() => togglePurchaseRowSelect(row.key)} />
                    </td>
                    <td className="main-col-partner">
                      <select
                        value={row.partner_id}
                        title={
                          row.partner_id
                            ? (() => {
                                const p = purchasePartners.find((x) => String(x.id) === String(row.partner_id));
                                return p ? `${p.name} (${p.type})` : '';
                              })()
                            : ''
                        }
                        onChange={(e) => updatePurchaseRow(row.key, { partner_id: e.target.value })}
                      >
                        <option value="">선택</option>
                        {purchasePartners.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} ({p.type})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="main-col-product">
                      <select
                        value={row.product_id}
                        title={row.product_id ? products.find((x) => String(x.id) === String(row.product_id))?.name || '' : ''}
                        onChange={(e) => updatePurchaseRow(row.key, { product_id: e.target.value })}
                      >
                        <option value="">선택</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="main-col-qty main-col-qty--purchase-input">
                      <input
                        className="main-input-qty main-input-qty--purchase"
                        type="number"
                        step="0.001"
                        min="0"
                        value={row.quantity}
                        onChange={(e) => updatePurchaseRow(row.key, { quantity: e.target.value })}
                      />
                    </td>
                    <td className="main-col-unit-price main-col-unit-price--purchase-input">
                      <UnitPriceInput
                        className="main-input-unit-price--purchase"
                        value={row.unit_price}
                        onChange={(v) => updatePurchaseRow(row.key, { unit_price: v })}
                      />
                    </td>
                    <td className="main-col-date main-col-date--purchase-input">
                      <input
                        className="main-input-date main-input-date--purchase"
                        type="date"
                        value={row.purchase_date}
                        onChange={(e) => updatePurchaseRow(row.key, { purchase_date: e.target.value })}
                      />
                    </td>
                    <td className="main-col-row-actions">
                      <button
                        type="button"
                        className="main-modal-row-del"
                        title="행 삭제"
                        onClick={() => removePurchaseRow(row.key)}
                        disabled={purchaseRows.length <= 1}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </form>
      </Modal>
      <Modal
        open={showConvert}
        title="매출 전환"
        wide
        fill
        onClose={() => {
          setShowConvert(false);
          setActionErr('');
        }}
        formId="form-convert-modal"
        saveLabel="저장"
        submitting={submitting}
      >
        <form id="form-convert-modal" className="main-modal-form" onSubmit={submitConvert}>
          <div className="main-modal-fields main-modal-fields--collect">
            <label className="main-modal-field-select-wide">
              판매처
              <select required value={convertCustomer} onChange={(e) => setConvertCustomer(e.target.value)}>
                <option value="">선택</option>
                {salePartners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.type})
                  </option>
                ))}
              </select>
            </label>
            <label>
              판매일 <input required className="main-input-date" type="date" value={convertDate} onChange={(e) => setConvertDate(e.target.value)} />
            </label>
          </div>
          <div className="main-table-wrap main-modal-table-wrap">
            <table className="main-table main-table--convert-modal">
              <thead>
                <tr>
                  <th className="main-col-purchase-id">매입 ID</th>
                  <th className="main-col-product main-col-product--convert">상품</th>
                  <th className="main-col-qty main-col-qty--convert">남은 수량</th>
                  <th className="main-col-qty main-col-qty--convert">전환 수량</th>
                  <th className="main-col-unit-price main-col-unit-price--convert">판매 단가</th>
                </tr>
              </thead>
              <tbody>
                {convertRows.map((r) => (
                  <tr key={r.purchase_id}>
                    <td className="num main-col-purchase-id" title={`매입 ID ${r.purchase_id}`}>{r.purchase_id}</td>
                    <td className="main-td-scroll main-col-product main-col-product--convert"><CellText>{r.product_name}</CellText></td>
                    <td className="num main-col-qty main-col-qty--convert">{formatKoNumber(r.remaining_qty)}</td>
                    <td className="main-col-qty main-col-qty--convert">
                      <input
                        className="main-input-qty main-input-qty--convert"
                        type="number"
                        step="0.001"
                        min="0"
                        max={r.remaining_qty}
                        value={r.quantity}
                        onChange={(e) =>
                          setConvertRows((rows) => rows.map((x) => (x.purchase_id === r.purchase_id ? { ...x, quantity: e.target.value } : x)))
                        }
                      />
                    </td>
                    <td className="main-col-unit-price main-col-unit-price--convert">
                      <UnitPriceInput
                        className="main-input-unit-price--convert"
                        value={r.unit_price}
                        onChange={(v) =>
                          setConvertRows((rows) => rows.map((x) => (x.purchase_id === r.purchase_id ? { ...x, unit_price: v } : x)))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </form>
      </Modal>
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">매입 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th className="main-col-check">선택</th>
                <th className="main-col-datetime">매입일</th>
                <th className="main-col-partner">거래처</th>
                <th className="main-col-product">상품</th>
                <th className="main-col-qty">수량</th>
                <th className="main-col-qty">매출 반영</th>
                <th className="main-col-qty">잔여</th>
                <th className="main-col-unit-price">단가</th>
                <th className="main-col-amount">총액</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td className="main-col-check">
                    <input
                      type="checkbox"
                      checked={!!selected[row.id]}
                      onChange={() => toggleRow(row.id)}
                      disabled={Number(row.remaining_qty) <= 0}
                    />
                  </td>
                  <td className="main-col-datetime">{formatPurchaseTableDateTime(row)}</td>
                  <td className="main-td-scroll main-col-partner"><CellText>{row.partner_name}</CellText></td>
                  <td className="main-td-scroll main-col-product"><CellText>{row.product_name}</CellText></td>
                  <td className="num main-col-qty">{formatKoNumber(row.quantity)}</td>
                  <td className="num main-col-qty">{formatKoNumber(row.allocated_qty || 0)}</td>
                  <td className="num main-col-qty">{formatKoNumber(row.remaining_qty != null ? row.remaining_qty : row.quantity)}</td>
                  <td className="num main-col-unit-price">{formatKoNumber(row.unit_price)}</td>
                  <td className="num main-col-amount">{formatKoNumber(row.total_amount)}</td>
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
  const [collectDateTime, setCollectDateTime] = useState(() => defaultCollectDateTime());
  const [unpaidSales, setUnpaidSales] = useState([]);
  const [loadingUnpaid, setLoadingUnpaid] = useState(false);
  const [collectSaleSelected, setCollectSaleSelected] = useState({});
  const [collectAlloc, setCollectAlloc] = useState({});
  const [saleErr, setSaleErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** false: 최초·기본은 수금 완료 매출만 목록 */
  const [showAllSales, setShowAllSales] = useState(false);
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundableSales, setRefundableSales] = useState([]);
  const [loadingRefundable, setLoadingRefundable] = useState(false);
  /** 거래처 이름·납품지 like 검색 (소문자 부분 일치) */
  const [refundPartnerSearch, setRefundPartnerSearch] = useState('');
  /** true면 한 행 사유 변경 시 표시 중인 모든 행에 동일 적용 */
  const [refundReasonUnified, setRefundReasonUnified] = useState(false);
  const [refundSaleSelected, setRefundSaleSelected] = useState({});
  /** [saleId]: { quantity, reasonCode, reasonOther } */
  const [refundDraft, setRefundDraft] = useState({});

  const load = () => {
    setLoading(true);
    setErr('');
    const params = {};
    if (fromDate) params.from_date = sanitizeYmd(fromDate, firstDayOfMonth());
    if (toDate) params.to_date = sanitizeYmd(toDate, today());
    if (partnerId) params.partner_id = partnerId;
    if (!showAllSales) params.paid_only = '1';
    fetchSales(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchPartners().then(setPartners).catch(() => {}); }, []);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 진입 시 필터 기준 1회 검색만; 이후는 검색 버튼
  }, []);

  const refundableFiltered = useMemo(() => {
    const q = refundPartnerSearch.trim().toLowerCase();
    if (!q) return refundableSales;
    return refundableSales.filter((s) => {
      const name = String(s.partner_name || '').toLowerCase();
      const loc = String(s.partner_location || '').toLowerCase();
      return name.includes(q) || loc.includes(q);
    });
  }, [refundableSales, refundPartnerSearch]);

  const newRefundDraft = (s) => {
    const maxQ = computeRefundPossibleQty(s);
    return {
      quantity: String(maxQ > 0 ? maxQ : ''),
      reasonCode: REFUND_REASON_CUSTOMER,
      reasonOther: '',
    };
  };

  const salePartners = partners.filter((p) => SALE_ACCOUNT_TYPES.has(p.type));

  const unpaidForPartner = unpaidSales.filter(
    (s) => String(s.partner_id) === String(collectPartner)
      && s.payment_status !== 'paid'
      && s.status !== 'refunded'
      && s.status !== 'cancelled',
  );

  const allocSum = unpaidForPartner.reduce((acc, s) => {
    if (!collectSaleSelected[s.id]) return acc;
    const n = parseMoneyToNumber(collectAlloc[s.id]);
    return acc + (Number.isNaN(n) ? 0 : n);
  }, 0);

  const openCollect = async () => {
    setSaleErr('');
    setCollectPartner(partnerId || '');
    setCollectDateTime(defaultCollectDateTime());
    setCollectAlloc({});
    setCollectSaleSelected({});
    setShowCollect(true);
    setLoadingUnpaid(true);
    try {
      const rows = await fetchSales({ unpaid_only: '1' });
      setUnpaidSales(rows);
      const sel = {};
      rows.forEach((r) => {
        sel[r.id] = true;
      });
      setCollectSaleSelected(sel);
    } catch (e) {
      setSaleErr(e.message);
    } finally {
      setLoadingUnpaid(false);
    }
  };

  const submitCollect = (e) => {
    e.preventDefault();
    if (!collectPartner) {
      setSaleErr('거래처를 선택하세요.');
      return;
    }
    const allocations = unpaidForPartner
      .filter((s) => collectSaleSelected[s.id])
      .map((s) => {
        const n = parseMoneyToNumber(collectAlloc[s.id]);
        return {
          sale_id: s.id,
          amount: Number.isNaN(n) ? 0 : n,
          max_due: Math.max(0, Number(s.total_amount) - Number(s.paid_amount)),
          max_total: Math.max(0, Number(s.total_amount)),
        };
      })
      .filter((a) => a.amount > 0);
    if (allocations.length === 0) {
      setSaleErr('체크한 매출에 수금 금액을 입력하세요.');
      return;
    }
    const invalid = allocations.find((a) => a.amount > a.max_due + 1e-9 || a.amount > a.max_total + 1e-9);
    if (invalid) {
      setSaleErr(`매출 #${invalid.sale_id}: 현재 수금금액은 최대 미수금(${formatKoNumber(invalid.max_due)})까지만 입력할 수 있습니다.`);
      return;
    }
    const paySum = allocations.reduce((a, x) => a + x.amount, 0);
    if (Math.abs(paySum - allocSum) > 0.02) {
      setSaleErr('배분 합계와 입력 금액이 맞지 않습니다. 행마다 입력했는지 확인하세요.');
      return;
    }
    let paidAtPayload = collectDateTime;
    if (paidAtPayload && paidAtPayload.length === 16) paidAtPayload = `${paidAtPayload}:00`;
    setSaleErr('');
    setSubmitting(true);
    createPayment({
      partner_id: parseInt(collectPartner, 10),
      amount: paySum,
      paid_at: paidAtPayload,
      entry_kind: 'receive',
      allocations,
    })
      .then(() => {
        setShowCollect(false);
        setUnpaidSales([]);
        load();
      })
      .catch((er) => setSaleErr(er.message))
      .finally(() => setSubmitting(false));
  };

  const openRefundModal = async () => {
    setSaleErr('');
    setRefundPartnerSearch('');
    setRefundReasonUnified(false);
    setRefundSaleSelected({});
    setRefundDraft({});
    setShowRefundModal(true);
    setLoadingRefundable(true);
    try {
      const rows = await fetchSales({ refundable_only: '1' });
      setRefundableSales(rows);
    } catch (e) {
      setSaleErr(e.message);
    } finally {
      setLoadingRefundable(false);
    }
  };

  const submitRefundBatch = async (e) => {
    e.preventDefault();
    const rows = refundableFiltered.filter((s) => refundSaleSelected[s.id]);
    if (rows.length === 0) {
      setSaleErr('환불할 매출을 선택하세요.');
      return;
    }
    setSaleErr('');
    setSubmitting(true);
    const refundedAt = today();
    try {
      for (const s of rows) {
        const d = refundDraft[s.id] || newRefundDraft(s);
        const qtyStr = String(d.quantity ?? '').trim();
        if (qtyStr.length < 3) {
          throw new Error(`매출 #${s.id}: 환불 요청수량은 최소 3자리로 입력하세요. (예: 0.001, 10.5)`);
        }
        const qty = Number(d.quantity);
        const maxQ = computeRefundPossibleQty(s);
        if (!Number.isFinite(qty) || qty <= 0) {
          throw new Error(`매출 #${s.id}: 환불 요청수량을 입력하세요.`);
        }
        if (qty > maxQ + 1e-9) {
          throw new Error(`매출 #${s.id}: 환불 요청수량이 환불 가능 수량(${formatKoNumber(maxQ)})을 초과합니다.`);
        }
        const rc = d.reasonCode || REFUND_REASON_CUSTOMER;
        if (rc === REFUND_REASON_CUSTOM && !String(d.reasonOther ?? '').trim()) {
          throw new Error(`매출 #${s.id}: 직접 기입 사유를 입력하세요.`);
        }
        const reasonText = buildRefundReasonFromDraft(d);
        const autoAmt = computeAutoRefundAmount(s, qty);
        const body = {
          quantity: qty,
          refunded_at: refundedAt,
          reason: reasonText || undefined,
        };
        if (autoAmt > 0) body.refund_amount = autoAmt;
        await refundSale(s.id, body);
      }
      setShowRefundModal(false);
      setRefundableSales([]);
      setRefundDraft({});
      setRefundPartnerSearch('');
      setRefundReasonUnified(false);
      load();
    } catch (er) {
      setSaleErr(er.message || '환불 실패');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="main-filters" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <label className="main-date-filter">
          기간 <DateSearchField value={fromDate} onChange={setFromDate} id="sale-from" /> ~{' '}
          <DateSearchField value={toDate} onChange={setToDate} id="sale-to" />
        </label>
        <label>거래처 <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}><option value="">전체</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="main-filter-checkbox">
          <input type="checkbox" checked={showAllSales} onChange={(e) => setShowAllSales(e.target.checked)} />
          미수·일부 포함
        </label>
        <button type="button" onClick={load}>검색</button>
        <button type="button" className="main-btn" onClick={openCollect}>수금 등록</button>
        <button type="button" className="main-btn" onClick={openRefundModal}>
          환불 처리
        </button>
      </div>
      {!showCollect && !showRefundModal && saleErr && <p className="main-error">{saleErr}</p>}
      <Modal
        open={showCollect}
        title="수금 등록 (미수 매출 배분)"
        wide
        fill
        modalClassName="main-modal--collect"
        onClose={() => {
          setShowCollect(false);
          setSaleErr('');
          setUnpaidSales([]);
        }}
        formId="form-collect-modal"
        submitting={submitting}
        saveDisabled={!collectPartner || unpaidForPartner.length === 0 || loadingUnpaid}
      >
        <form id="form-collect-modal" className="main-modal-form" onSubmit={submitCollect}>
          {saleErr && (
            <div className="main-alert-banner" role="alert" style={{ marginBottom: '0.75rem' }}>
              {saleErr}
            </div>
          )}
          <div className="main-modal-fields">
            <label className="main-modal-field-select-wide">
              거래처
              <select
                required
                value={collectPartner}
                onChange={(e) => {
                  setCollectPartner(e.target.value);
                  setCollectAlloc({});
                }}
              >
                <option value="">선택</option>
                {salePartners.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="main-modal-field-collect-datetime">
              <span>수금일시</span>
              <input
                required
                className="main-input-datetime-local main-input-datetime-local--collect"
                type="datetime-local"
                step="60"
                value={collectDateTime}
                onChange={(e) => setCollectDateTime(e.target.value)}
              />
              <small className="main-modal-hint">형식: YYYY-MM-DD HH:mm</small>
            </label>
            <span className="main-modal-hint">배분 합계: <strong>{allocSum.toLocaleString('ko-KR')}</strong> 원 (체크한 행만)</span>
          </div>
          {loadingUnpaid && <p className="main-loading">미수 매출 불러오는 중…</p>}
          {!loadingUnpaid && collectPartner && unpaidForPartner.length === 0 && (
            <p className="main-empty">이 거래처의 미수 매출이 없습니다.</p>
          )}
          {!loadingUnpaid && unpaidForPartner.length > 0 && (
            <div className="main-table-wrap main-modal-table-wrap">
              <table className="main-table">
                <thead>
                  <tr>
                    <th className="main-col-check">
                      <input
                        type="checkbox"
                        title="전체 선택"
                        checked={unpaidForPartner.length > 0 && unpaidForPartner.every((s) => collectSaleSelected[s.id])}
                        onChange={() => {
                          const allOn = unpaidForPartner.every((s) => collectSaleSelected[s.id]);
                          setCollectSaleSelected((prev) => {
                            const next = { ...prev };
                            unpaidForPartner.forEach((s) => {
                              next[s.id] = !allOn;
                            });
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th className="main-col-datetime">매출일</th>
                    <th className="main-col-partner">판매처</th>
                    <th className="main-col-partner">납품/위치</th>
                    <th className="main-col-product">상품</th>
                    <th className="main-col-qty">총 수량</th>
                    <th className="main-col-amount">총액</th>
                    <th className="main-col-amount">기수금</th>
                    <th className="main-col-amount">미수</th>
                    <th className="main-col-amount">현재 수금금액</th>
                  </tr>
                </thead>
                <tbody>
                  {unpaidForPartner.map((s) => {
                    const due = Number(s.total_amount) - Number(s.paid_amount);
                    return (
                      <tr key={s.id}>
                        <td className="main-col-check">
                          <input
                            type="checkbox"
                            checked={!!collectSaleSelected[s.id]}
                            onChange={() => setCollectSaleSelected((m) => ({ ...m, [s.id]: !m[s.id] }))}
                          />
                        </td>
                        <td className="main-col-datetime main-collect-datetime-cell">{formatSaleDateTime(s)}</td>
                        <td className="main-td-scroll main-col-partner"><CellText>{s.partner_name}</CellText></td>
                        <td className="main-td-scroll main-col-partner"><CellText>{s.partner_location || '—'}</CellText></td>
                        <td className="main-td-scroll main-col-product"><CellText>{s.product_name}</CellText></td>
                        <td className="num main-col-qty">{formatKoNumber(s.quantity)}</td>
                        <td className="num main-col-amount">{formatKoNumber(s.total_amount)}</td>
                        <td className="num main-col-amount">{formatKoNumber(s.paid_amount)}</td>
                        <td className="num main-col-amount">{formatKoNumber(due)}</td>
                        <td className="main-col-amount">
                          <CollectAmountInput
                            disabled={!collectSaleSelected[s.id]}
                            placeholder={`최대 ${formatKoNumber(due)}`}
                            max={due}
                            value={collectAlloc[s.id] ?? ''}
                            onChange={(v) => setCollectAlloc((m) => ({ ...m, [s.id]: v }))}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </form>
      </Modal>
      <Modal
        open={showRefundModal}
        title="환불 처리 (수금 발생 매출)"
        wide
        fill
        modalClassName="main-modal--refund"
        onClose={() => {
          setShowRefundModal(false);
          setSaleErr('');
          setRefundableSales([]);
          setRefundPartnerSearch('');
          setRefundReasonUnified(false);
        }}
        formId="form-refund-batch-modal"
        submitting={submitting}
        saveDisabled={loadingRefundable || refundableSales.length === 0}
      >
        <form id="form-refund-batch-modal" className="main-modal-form" onSubmit={submitRefundBatch}>
          {saleErr && (
            <div className="main-alert-banner" role="alert" style={{ marginBottom: '0.75rem' }}>
              {saleErr}
            </div>
          )}
          <div className="main-modal-fields main-modal-fields--refund-toolbar">
            <label className="main-modal-field-refund-search">
              거래처 검색
              <input
                type="search"
                autoComplete="off"
                placeholder="거래처명·납품/위치 일부 입력"
                value={refundPartnerSearch}
                onChange={(e) => setRefundPartnerSearch(e.target.value)}
              />
            </label>
            <label className="main-filter-checkbox main-modal-refund-unify">
              <input
                type="checkbox"
                checked={refundReasonUnified}
                onChange={(e) => {
                  const on = e.target.checked;
                  setRefundReasonUnified(on);
                  if (on && refundableFiltered.length > 0) {
                    const first = refundableFiltered[0];
                    const tpl = refundDraft[first.id] || newRefundDraft(first);
                    setRefundDraft((prev) => {
                      const next = { ...prev };
                      refundableFiltered.forEach((row) => {
                        next[row.id] = {
                          ...(prev[row.id] || newRefundDraft(row)),
                          reasonCode: tpl.reasonCode,
                          reasonOther: tpl.reasonOther,
                        };
                      });
                      return next;
                    });
                  }
                }}
              />
              사유 통일
            </label>
            <span className="main-modal-hint main-modal-hint--refund">
              수금이 한 번이라도 발생한 매출만 표시됩니다. 체크한 행만 순서대로 환불 처리됩니다. 환불일은 저장 시 오늘 날짜로 적용됩니다.
            </span>
          </div>
          {loadingRefundable && <p className="main-loading">환불 가능 매출 불러오는 중…</p>}
          {!loadingRefundable && refundableSales.length === 0 && (
            <p className="main-empty">표시할 매출이 없습니다. (수금 발생·잔여 수량 필요)</p>
          )}
          {!loadingRefundable && refundableSales.length > 0 && refundableFiltered.length === 0 && (
            <p className="main-empty">검색 조건에 맞는 거래처 매출이 없습니다.</p>
          )}
          {!loadingRefundable && refundableFiltered.length > 0 && (
            <div className="main-table-wrap main-modal-table-wrap main-modal-refund-wrap">
              <table className="main-table main-table--refund-modal">
                <thead>
                  <tr>
                    <th className="main-col-check">
                      <input
                        type="checkbox"
                        title="전체 선택"
                        checked={
                          refundableFiltered.length > 0 && refundableFiltered.every((s) => refundSaleSelected[s.id])
                        }
                        onChange={() => {
                          const allOn = refundableFiltered.every((s) => refundSaleSelected[s.id]);
                          setRefundSaleSelected((prev) => {
                            const next = { ...prev };
                            refundableFiltered.forEach((s) => {
                              next[s.id] = !allOn;
                            });
                            return next;
                          });
                          if (!allOn) {
                            setRefundDraft((prev) => {
                              const n = { ...prev };
                              refundableFiltered.forEach((s) => {
                                if (!n[s.id]) n[s.id] = newRefundDraft(s);
                              });
                              return n;
                            });
                          }
                        }}
                      />
                    </th>
                    <th className="main-col-partner main-th-refund">거래처</th>
                    <th className="main-col-datetime main-col-datetime-full">매출일</th>
                    <th className="main-col-product">상품</th>
                    <th className="main-col-qty">총 수량</th>
                    <th className="main-col-qty" title="총 수량 × (수금액 ÷ 매출금액)">
                      수금 수량
                    </th>
                    <th className="main-col-qty">환불된 수량</th>
                    <th className="main-col-qty" title="총 수량 − 환불된 수량">
                      환불 가능 수량
                    </th>
                    <th className="main-col-qty">환불 요청수량</th>
                    <th className="main-col-amount">매출 금액</th>
                    <th className="main-col-amount" title="(환불 요청수량 ÷ 총 수량) × 매출 금액">
                      반품 금액
                    </th>
                    <th className="main-th-refund-reason">사유</th>
                  </tr>
                </thead>
                <tbody>
                  {refundableFiltered.map((s) => {
                    const maxQ = computeRefundPossibleQty(s);
                    const collected = computeCollectedQty(s);
                    const d = refundDraft[s.id] || newRefundDraft(s);
                    const reqQty = Number(d.quantity);
                    const autoReturn = computeAutoRefundAmount(s, Number.isFinite(reqQty) ? reqQty : 0);
                    const applyReason = (patch) => {
                      setRefundDraft((prev) => {
                        if (!refundReasonUnified) {
                          return { ...prev, [s.id]: { ...(prev[s.id] || newRefundDraft(s)), ...patch } };
                        }
                        const next = { ...prev };
                        refundableFiltered.forEach((row) => {
                          next[row.id] = { ...(prev[row.id] || newRefundDraft(row)), ...patch };
                        });
                        return next;
                      });
                    };
                    return (
                      <tr key={s.id}>
                        <td className="main-col-check">
                          <input
                            type="checkbox"
                            checked={!!refundSaleSelected[s.id]}
                            onChange={() => {
                              setRefundSaleSelected((m) => {
                                const on = !m[s.id];
                                if (on) {
                                  setRefundDraft((prev) => ({
                                    ...prev,
                                    [s.id]: prev[s.id] || newRefundDraft(s),
                                  }));
                                }
                                return { ...m, [s.id]: on };
                              });
                            }}
                          />
                        </td>
                        <td className="main-col-partner main-td-partner">
                          <CellText>{s.partner_name}</CellText>
                        </td>
                        <td className="main-col-datetime main-col-datetime-full">
                          <span className="main-sale-datetime-line">{formatSaleDateTime(s)}</span>
                        </td>
                        <td className="main-td-scroll main-col-product">
                          <CellText>{s.product_name}</CellText>
                        </td>
                        <td className="num main-col-qty">{formatKoNumber(s.quantity)}</td>
                        <td className="num main-col-qty">{formatKoNumber(collected)}</td>
                        <td className="num main-col-qty">{formatKoNumber(s.refunded_qty || 0)}</td>
                        <td className="num main-col-qty">{formatKoNumber(maxQ)}</td>
                        <td className="main-col-qty">
                          <input
                            className="main-input-qty main-input-qty-refund"
                            type="text"
                            inputMode="decimal"
                            placeholder="0.001"
                            disabled={!refundSaleSelected[s.id]}
                            value={d.quantity}
                            onChange={(e) =>
                              setRefundDraft((prev) => ({
                                ...prev,
                                [s.id]: { ...(prev[s.id] || newRefundDraft(s)), quantity: e.target.value },
                              }))
                            }
                          />
                        </td>
                        <td className="num main-col-amount">{formatKoNumber(s.paid_amount)}</td>
                        <td className="num main-col-amount main-col-amount-readonly">
                          {refundSaleSelected[s.id] && Number.isFinite(reqQty) && reqQty > 0
                            ? formatKoNumber(autoReturn)
                            : '—'}
                        </td>
                        <td className="main-td-refund-reason">
                          <div className="main-refund-reason-cell">
                            <select
                              className="main-refund-reason-select"
                              value={d.reasonCode || REFUND_REASON_CUSTOMER}
                              onChange={(e) =>
                                applyReason({
                                  reasonCode: e.target.value,
                                  reasonOther: e.target.value === REFUND_REASON_CUSTOM ? d.reasonOther || '' : '',
                                })
                              }
                            >
                              <option value={REFUND_REASON_CUSTOMER}>고객변심</option>
                              <option value={REFUND_REASON_QUALITY}>품질 문제</option>
                              <option value={REFUND_REASON_CUSTOM}>직접 기입</option>
                            </select>
                            {d.reasonCode === REFUND_REASON_CUSTOM && (
                              <input
                                type="text"
                                className="main-refund-reason-custom"
                                value={d.reasonOther || ''}
                                placeholder="직접 입력"
                                onChange={(e) => {
                                  const v = e.target.value;
                                  if (!refundReasonUnified) {
                                    setRefundDraft((prev) => ({
                                      ...prev,
                                      [s.id]: { ...(prev[s.id] || newRefundDraft(s)), reasonOther: v },
                                    }));
                                  } else {
                                    setRefundDraft((prev) => {
                                      const next = { ...prev };
                                      refundableFiltered.forEach((row) => {
                                        next[row.id] = {
                                          ...(prev[row.id] || newRefundDraft(row)),
                                          reasonCode: REFUND_REASON_CUSTOM,
                                          reasonOther: v,
                                        };
                                      });
                                      return next;
                                    });
                                  }
                                }}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </form>
      </Modal>
      {loading ? (
        <p className="main-loading">불러오는 중…</p>
      ) : err ? (
        <p className="main-error">{err}</p>
      ) : list.length === 0 ? (
        <p className="main-empty">
          매출 내역이 없습니다.
          {!showAllSales && ' 수금 완료 건만 보이는 중입니다. 미수·일부 매출은 위 「미수·일부 포함」을 체크하세요.'}
        </p>
      ) : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th className="main-col-datetime">매출일</th>
                <th className="main-col-partner">거래처</th>
                <th className="main-col-product">상품</th>
                <th className="main-col-qty">총 수량</th>
                <th className="main-col-qty">환불된 수량</th>
                <th className="main-col-unit-price">단가</th>
                <th className="main-col-amount">총액</th>
                <th>수금</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => {
                const rf = Number(row.refunded_qty || 0);
                return (
                  <tr key={row.id}>
                    <td className="main-col-datetime main-col-datetime-full">{formatSaleDateTime(row)}</td>
                    <td className="main-td-scroll main-col-partner"><CellText>{row.partner_name}</CellText></td>
                    <td className="main-td-scroll main-col-product"><CellText>{row.product_name}</CellText></td>
                    <td className="num main-col-qty">{formatKoNumber(row.quantity)}</td>
                    <td className="num main-col-qty">{formatKoNumber(rf)}</td>
                    <td className="num main-col-unit-price">{formatKoNumber(row.unit_price)}</td>
                    <td className="num main-col-amount">{formatKoNumber(row.total_amount)}</td>
                    <td>{row.payment_status === 'paid' ? '완료' : row.payment_status === 'partial' ? '일부' : '미수'}</td>
                    <td>{row.status === 'refunded' ? '전액환불' : row.status === 'cancelled' ? '취소' : '정상'}</td>
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
    if (fromDate) params.from_date = sanitizeYmd(fromDate, firstDayOfMonth());
    if (toDate) params.to_date = sanitizeYmd(toDate, today());
    if (partnerId) params.partner_id = partnerId;
    fetchPayments(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { fetchPartners().then(setPartners).catch(() => {}); }, []);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 진입 시 필터 기준 1회 검색만; 이후는 검색 버튼
  }, []);
  return (
    <>
      <div className="main-filters">
        <label className="main-date-filter">
          기간 <DateSearchField value={fromDate} onChange={setFromDate} id="pay-from" /> ~{' '}
          <DateSearchField value={toDate} onChange={setToDate} id="pay-to" />
        </label>
        <label>거래처 <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}><option value="">전체</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <button type="button" onClick={load}>검색</button>
      </div>
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">수금 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th className="main-col-datetime">수금일</th>
                <th>구분</th>
                <th className="main-col-partner">거래처</th>
                <th className="main-col-amount">금액</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td className="main-col-datetime">{formatPaymentDateTime(row)}</td>
                  <td>{(row.entry_kind || 'receive') === 'refund' ? '환불' : '수금'}</td>
                  <td className="main-td-scroll main-col-partner"><CellText>{row.partner_name}</CellText></td>
                  <td className="num main-col-amount">{formatKoNumber(row.amount)}</td>
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
  const [productRows, setProductRows] = useState([newProductMasterRow()]);
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
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 진입 시 필터 기준 1회 검색만; 이후는 검색 버튼
  }, []);

  const updateProductRow = (key, patch) => {
    setProductRows((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const addProductRow = () => {
    setSubmitErr('');
    setProductRows((rows) => [...rows, newProductMasterRow()]);
  };
  const removeProductRow = (key) => {
    setProductRows((rows) => (rows.length <= 1 ? rows : rows.filter((r) => r.key !== key)));
  };

  const submitProducts = async (e) => {
    e.preventDefault();
    const partial = productRows.some((r) => {
      const any = r.name?.trim() || r.unit || r.category_large || r.category_mid || r.category_small || r.memo?.trim();
      const full = r.name?.trim();
      return any && !full;
    });
    if (partial) {
      setSubmitErr('입력이 완료되지 않은 행이 있습니다. 비우거나 상품명을 채워 주세요.');
      return;
    }
    const valid = productRows.filter((r) => r.name?.trim());
    if (valid.length === 0) {
      setSubmitErr('상품명을 입력한 행이 최소 1개 필요합니다.');
      return;
    }
    const products = valid.map((r) => ({
      name: r.name.trim(),
      unit: r.unit?.trim() || undefined,
      category_large: r.category_large?.trim() || undefined,
      category_mid: r.category_mid?.trim() || undefined,
      category_small: r.category_small?.trim() || undefined,
      memo: r.memo?.trim() || undefined,
    }));
    setSubmitErr('');
    setSubmitting(true);
    try {
      await createProductsBulk(products);
      setShowForm(false);
      setProductRows([newProductMasterRow()]);
      load();
    } catch (er) {
      setSubmitErr(er.message || '등록 실패');
    } finally {
      setSubmitting(false);
    }
  };

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
        <button type="button" className="main-btn" onClick={load}>
          검색
        </button>
        <button
          type="button"
          className="main-btn"
          onClick={() => {
            setSubmitErr('');
            setProductRows([newProductMasterRow()]);
            setShowForm(true);
          }}
        >
          상품 등록
        </button>
      </div>

      <Modal
        open={showForm}
        title="상품 등록"
        wide
        fill
        onClose={() => {
          setShowForm(false);
          setSubmitErr('');
        }}
        formId="form-product-modal"
        submitting={submitting}
      >
        <form id="form-product-modal" className="main-modal-form product-master-form product-master-form--modal" onSubmit={submitProducts}>
          {submitErr && <p className="main-error" style={{ marginBottom: '8px' }}>{submitErr}</p>}
          <div className="main-modal-toolbar">
            <button type="button" className="main-modal-toolbar-btn" onClick={addProductRow}>
              ＋ 행 추가
            </button>
          </div>
          <div className="main-table-wrap main-modal-table-wrap">
            <table className="main-table">
              <thead>
                <tr>
                  <th className="main-col-product">상품명 *</th>
                  <th>단위</th>
                  <th>대분류</th>
                  <th>중분류</th>
                  <th>소분류</th>
                  <th>비고</th>
                  <th className="main-col-row-actions" aria-label="행 삭제" />
                </tr>
              </thead>
              <tbody>
                {productRows.map((row) => (
                  <tr key={row.key}>
                    <td className="main-col-product"><input value={row.name} onChange={(e) => updateProductRow(row.key, { name: e.target.value })} placeholder="필수" /></td>
                    <td><input value={row.unit} onChange={(e) => updateProductRow(row.key, { unit: e.target.value })} /></td>
                    <td><input value={row.category_large} onChange={(e) => updateProductRow(row.key, { category_large: e.target.value })} /></td>
                    <td><input value={row.category_mid} onChange={(e) => updateProductRow(row.key, { category_mid: e.target.value })} /></td>
                    <td><input value={row.category_small} onChange={(e) => updateProductRow(row.key, { category_small: e.target.value })} /></td>
                    <td><input value={row.memo} onChange={(e) => updateProductRow(row.key, { memo: e.target.value })} /></td>
                    <td className="main-col-row-actions">
                      <button
                        type="button"
                        className="main-modal-row-del"
                        title="행 삭제"
                        onClick={() => removeProductRow(row.key)}
                        disabled={productRows.length <= 1}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </form>
      </Modal>

      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">등록된 상품이 없습니다. 검색 조건을 바꾸거나 상품 등록으로 추가하세요.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>상품 키</th>
                <th className="main-col-product">상품명</th>
                <th>단위</th>
                <th>대분류</th>
                <th>중분류</th>
                <th>소분류</th>
                <th>비고</th>
                <th className="main-col-date">등록일</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td className="num">{row.id}</td>
                  <td>{row.product_key || '-'}</td>
                  <td className="main-td-scroll main-col-product"><CellText>{row.name}</CellText></td>
                  <td>{row.unit}</td>
                  <td>{row.category_large || '-'}</td>
                  <td>{row.category_mid || '-'}</td>
                  <td>{row.category_small || '-'}</td>
                  <td>{row.memo || '-'}</td>
                  <td className="main-col-date">{formatProductCreatedYmd(row)}</td>
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
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [fromDate, setFromDate] = useState(firstDayOfMonth());
  const [toDate, setToDate] = useState(today());
  const [inventoryForDisposal, setInventoryForDisposal] = useState([]);
  const [loadingInventory, setLoadingInventory] = useState(false);
  const [dispPartnerSearch, setDispPartnerSearch] = useState('');
  const [dispPurchaseFromDate, setDispPurchaseFromDate] = useState(daysAgo(7));
  const [dispPurchaseToDate, setDispPurchaseToDate] = useState(today());
  const [disposalSelected, setDisposalSelected] = useState({});
  const [disposalDraft, setDisposalDraft] = useState({});
  const [actionErr, setActionErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showDisposalModal, setShowDisposalModal] = useState(false);

  const load = () => {
    setLoading(true);
    setErr('');
    const params = {};
    if (fromDate) params.from_date = sanitizeYmd(fromDate, firstDayOfMonth());
    if (toDate) params.to_date = sanitizeYmd(toDate, today());
    fetchDisposals(params)
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 진입 시 필터 기준 1회 검색만; 이후는 검색 버튼
  }, []);

  const invFiltered = useMemo(() => {
    const rows = inventoryForDisposal || [];
    const q = dispPartnerSearch.trim().toLowerCase();
    const from = dispPurchaseFromDate.trim();
    const to = dispPurchaseToDate.trim();
    const hasDate = !!(from || to);
    if (!q && !hasDate) return rows;
    return rows.filter((row) => {
      const partnerOk = !q || String(row.last_partner_name || '').toLowerCase().includes(q);
      const dateStr = formatInventoryDateOnly(row);
      const dateOk =
        !hasDate ||
        (dateStr !== '—' &&
          (!from || dateStr >= from) &&
          (!to || dateStr <= to));
      return partnerOk && dateOk;
    });
  }, [inventoryForDisposal, dispPartnerSearch, dispPurchaseFromDate, dispPurchaseToDate]);

  const openDisposalModal = async () => {
    setActionErr('');
    setDispPartnerSearch('');
    setDispPurchaseFromDate(daysAgo(7));
    setDispPurchaseToDate(today());
    setDisposalSelected({});
    setDisposalDraft({});
    setShowDisposalModal(true);
    setLoadingInventory(true);
    try {
      const rows = await fetchInventory();
      setInventoryForDisposal(rows);
    } catch (e) {
      setActionErr(e.message || '재고 조회 실패');
    } finally {
      setLoadingInventory(false);
    }
  };

  const toggleDisposalRowSelect = (productId) => {
    const key = String(productId);
    setDisposalSelected((prev) => {
      const on = !prev[key];
      if (on) {
        setDisposalDraft((d) => {
          if (d[key]) return d;
          return { ...d, [key]: newDisposalInventoryDraft() };
        });
      }
      return { ...prev, [key]: on };
    });
  };

  const toggleDisposalSelectAll = () => {
    const ids = invFiltered.map((r) => String(r.product_id));
    const allOn = ids.length > 0 && ids.every((id) => disposalSelected[id]);
    setDisposalSelected((prev) => {
      const next = { ...prev };
      ids.forEach((id) => {
        next[id] = !allOn;
      });
      return next;
    });
    if (!allOn) {
      setDisposalDraft((prev) => {
        const next = { ...prev };
        ids.forEach((id) => {
          if (!next[id]) next[id] = newDisposalInventoryDraft();
        });
        return next;
      });
    }
  };

  const submitDisposals = async (e) => {
    e.preventDefault();
    setActionErr('');
    const selectedIds = Object.keys(disposalSelected).filter((id) => disposalSelected[id]);
    if (selectedIds.length === 0) {
      setActionErr('폐기할 상품을 선택하세요.');
      return;
    }
    const payload = [];
    for (const id of selectedIds) {
      const row = inventoryForDisposal.find((r) => String(r.product_id) === String(id));
      if (!row) continue;
      const d = disposalDraft[id] || newDisposalInventoryDraft();
      const qty = Number(d.quantity);
      const maxQ = Number(row.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        setActionErr(`「${row.product_name}」: 폐기 수량을 입력하세요.`);
        return;
      }
      if (qty > maxQ + 1e-9) {
        setActionErr(`「${row.product_name}」: 폐기 수량이 재고(${formatKoNumber(maxQ)})를 초과합니다.`);
        return;
      }
      const rc = d.reasonCode || DISPOSAL_REASON_SPOIL;
      if (rc === DISPOSAL_REASON_CUSTOM && !String(d.reasonOther ?? '').trim()) {
        setActionErr(`「${row.product_name}」: 직접 입력 사유를 작성하세요.`);
        return;
      }
      const reasonText = buildDisposalReasonFromDraft(d);
      payload.push({
        product_id: parseInt(id, 10),
        quantity: qty,
        disposal_date: d.disposal_date,
        reason: reasonText,
      });
    }
    if (payload.length === 0) {
      setActionErr('처리할 항목이 없습니다.');
      return;
    }
    setSubmitting(true);
    try {
      for (const p of payload) {
        await createDisposal(p);
      }
      setShowDisposalModal(false);
      setInventoryForDisposal([]);
      setDisposalSelected({});
      setDisposalDraft({});
      load();
    } catch (er) {
      setActionErr(er.message || '폐기 등록 실패');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="main-filters" style={{ flexWrap: 'wrap', gap: '8px' }}>
        <label className="main-date-filter">
          기간 <DateSearchField value={fromDate} onChange={setFromDate} id="disp-from" /> ~{' '}
          <DateSearchField value={toDate} onChange={setToDate} id="disp-to" />
        </label>
        <button type="button" onClick={load}>검색</button>
        <button type="button" className="main-btn" onClick={openDisposalModal}>
          폐기 등록
        </button>
      </div>
      <Modal
        open={showDisposalModal}
        title="폐기 등록"
        wide
        fill
        modalClassName="main-modal--disposal"
        onClose={() => {
          setShowDisposalModal(false);
          setActionErr('');
          setInventoryForDisposal([]);
          setDispPartnerSearch('');
          setDispPurchaseFromDate(daysAgo(7));
          setDispPurchaseToDate(today());
          setDisposalSelected({});
          setDisposalDraft({});
        }}
        formId="form-disposal-modal"
        submitting={submitting}
        saveDisabled={loadingInventory || inventoryForDisposal.length === 0}
      >
        <form id="form-disposal-modal" className="main-modal-form" onSubmit={submitDisposals}>
          {actionErr && <p className="main-error" style={{ marginBottom: '8px' }}>{actionErr}</p>}
          <div className="main-modal-fields main-modal-fields--disposal-search">
            <label className="main-modal-field-disposal-search">
              판매처(매입처) 검색
              <input
                type="search"
                autoComplete="off"
                placeholder="거래처명 일부"
                value={dispPartnerSearch}
                onChange={(e) => setDispPartnerSearch(e.target.value)}
              />
            </label>
            <label className="main-modal-field-disposal-date">
              매입일 기준 (From)
              <input
                className="main-input-date"
                type="date"
                value={dispPurchaseFromDate}
                onChange={(e) => setDispPurchaseFromDate(e.target.value)}
              />
            </label>
            <label className="main-modal-field-disposal-date">
              매입일 기준 (To)
              <input
                className="main-input-date"
                type="date"
                value={dispPurchaseToDate}
                onChange={(e) => setDispPurchaseToDate(e.target.value)}
              />
            </label>
            <span className="main-modal-hint main-modal-hint--disposal">
              판매처·날짜 중 값이 있는 조건만 적용됩니다. 둘 다 비우면 전체 재고가 표시됩니다. 체크한 행만 저장됩니다.
            </span>
          </div>
          {loadingInventory && <p className="main-loading">재고 불러오는 중…</p>}
          {!loadingInventory && inventoryForDisposal.length === 0 && (
            <p className="main-empty">폐기할 재고가 없습니다.</p>
          )}
          {!loadingInventory && inventoryForDisposal.length > 0 && invFiltered.length === 0 && (
            <p className="main-empty">검색 조건에 맞는 재고가 없습니다.</p>
          )}
          {!loadingInventory && invFiltered.length > 0 && (
            <div className="main-table-wrap main-modal-table-wrap main-modal-disposal-wrap">
              <table className="main-table main-table--disposal-modal">
                <thead>
                  <tr>
                    <th className="main-col-check">
                      <input
                        type="checkbox"
                        checked={invFiltered.length > 0 && invFiltered.every((r) => disposalSelected[String(r.product_id)])}
                        onChange={toggleDisposalSelectAll}
                        title="전체 선택"
                      />
                    </th>
                    <th className="main-col-product main-col-product--disposal">상품</th>
                    <th className="main-col-qty">재고 수량</th>
                    <th className="main-col-partner">판매처(매입처)</th>
                    <th className="main-col-date">매입일</th>
                    <th className="main-col-qty main-col-disposal-qty-input">폐기 수량</th>
                    <th className="main-col-date main-col-disposal-date-col">폐기일</th>
                    <th>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {invFiltered.map((row) => {
                    const pid = String(row.product_id);
                    const d = disposalDraft[pid] || newDisposalInventoryDraft();
                    return (
                      <tr key={row.product_id}>
                        <td className="main-col-check">
                          <input
                            type="checkbox"
                            checked={!!disposalSelected[pid]}
                            onChange={() => toggleDisposalRowSelect(row.product_id)}
                          />
                        </td>
                        <td className="main-td-scroll main-col-product main-col-product--disposal">
                          <CellText>{row.product_name}</CellText>
                        </td>
                        <td className="num main-col-qty">
                          <span className="main-qty-unit-inline">
                            {formatKoNumber(row.quantity)}
                          </span>
                        </td>
                        <td className="main-td-scroll main-col-partner">
                          <CellText>{(row.last_partner_name && String(row.last_partner_name).trim()) || '—'}</CellText>
                        </td>
                        <td className="main-col-date">{formatInventoryDateOnly(row)}</td>
                        <td className="main-col-qty main-col-disposal-qty-input">
                          <input
                            className="main-input-qty main-input-qty--disposal"
                            type="number"
                            step="0.001"
                            min="0"
                            disabled={!disposalSelected[pid]}
                            value={d.quantity}
                            onChange={(e) =>
                              setDisposalDraft((prev) => ({
                                ...prev,
                                [pid]: { ...(prev[pid] || newDisposalInventoryDraft()), quantity: e.target.value },
                              }))
                            }
                          />
                        </td>
                        <td className="main-col-date main-col-disposal-date-col">
                          <input
                            className="main-input-date main-input-date--disposal"
                            type="date"
                            disabled={!disposalSelected[pid]}
                            value={d.disposal_date}
                            onChange={(e) =>
                              setDisposalDraft((prev) => ({
                                ...prev,
                                [pid]: { ...(prev[pid] || newDisposalInventoryDraft()), disposal_date: e.target.value },
                              }))
                            }
                          />
                        </td>
                        <td className="main-td-disposal-reason">
                          <div className="main-disposal-reason-cell">
                            <select
                              value={d.reasonCode || DISPOSAL_REASON_SPOIL}
                              onChange={(e) =>
                                setDisposalDraft((prev) => ({
                                  ...prev,
                                  [pid]: {
                                    ...(prev[pid] || newDisposalInventoryDraft()),
                                    reasonCode: e.target.value,
                                    reasonOther:
                                      e.target.value === DISPOSAL_REASON_CUSTOM ? (prev[pid]?.reasonOther || '') : '',
                                  },
                                }))
                              }
                            >
                              <option value={DISPOSAL_REASON_SPOIL}>상품 변질</option>
                              <option value={DISPOSAL_REASON_DISPOSE}>상품 폐기</option>
                              <option value={DISPOSAL_REASON_CUSTOM}>직접 입력</option>
                            </select>
                            {d.reasonCode === DISPOSAL_REASON_CUSTOM && (
                              <input
                                type="text"
                                placeholder="직접 입력"
                                value={d.reasonOther || ''}
                                onChange={(e) =>
                                  setDisposalDraft((prev) => ({
                                    ...prev,
                                    [pid]: { ...(prev[pid] || newDisposalInventoryDraft()), reasonOther: e.target.value },
                                  }))
                                }
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </form>
      </Modal>
      {loading ? <p className="main-loading">불러오는 중…</p> : err ? <p className="main-error">{err}</p> : list.length === 0 ? <p className="main-empty">폐기 내역이 없습니다.</p> : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th className="main-col-datetime">폐기일</th>
                <th className="main-col-product">상품</th>
                <th className="main-col-qty main-col-qty--singleline">수량</th>
                <th>사유</th>
              </tr>
            </thead>
            <tbody>
              {list.map((row) => (
                <tr key={row.id}>
                  <td className="main-col-datetime">{formatDisposalDateTime(row)}</td>
                  <td className="main-td-scroll main-col-product"><CellText>{row.product_name}</CellText></td>
                  <td className="num main-col-qty main-col-qty--singleline">
                    <span className="main-qty-unit-inline">
                      {formatKoNumber(row.quantity)}
                    </span>
                  </td>
                  <td className="main-td-scroll"><CellText>{row.reason || '—'}</CellText></td>
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
