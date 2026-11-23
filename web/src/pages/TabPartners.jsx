// 거래처 탭 (T-102) — 목록·검색·등록·수정, 매입·매출 모달에서 쓰는 빠른 등록 모달
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { fetchPartners, fetchReceivablesAging, getToken, getUser, API_BASE } from '../api';
import { PartnerLedgerModal, ReceivablesAgingView, won } from './PartnerLedger';
import CardMoreToggle from '../components/CardMoreToggle';
import '../components/CreditLimitWarning.css';
import { can } from '../lib/staffAccess';
import './TabPartners.css';
import ExcelUploadBar from '../components/ExcelUpload'; // T-402

/** 거래처 유형 — 서버 partner_type enum 과 같은 값. 표시 이름은 화면용 */
export const PARTNER_TYPE_OPTIONS = [
  // T-401 RQ-08: 도매시장법인(청과)을 알아보게 — 저장 값은 그대로 supplier (enum 추가 없음, 설계 3.10)
  { value: 'supplier', label: '매입처 (도매시장법인·청과)', hint: '경매 낙찰분을 사 오는 곳 — 예: ○○청과 · 매입에서 선택' },
  { value: 'customer', label: '판매처', hint: '매출에서 선택' },
  { value: 'same_market', label: '같은 시장', hint: '같은 시장 중매인 — 매입·매출 모두 · 상계 가능' },
  { value: 'wholesaler', label: '도매상', hint: '매입·매출 모두 · 상계 가능' },
  { value: 'market_wholesaler', label: '시장도매인', hint: '매입·매출 모두 · 상계 가능' },
  { value: 'producer', label: '생산자(출하주·농가)', hint: '실제 재배 농가 — 매입의 생산자·산지, 직접 입금 대상' },
];
/** 받을 돈(미수) 장부가 있는 유형 — 서버 SALE_PARTNER_TYPES 와 같음. 매입처는 원장 버튼을 숨긴다(T-104 RULE-10) */
const RECEIVABLE_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);
/** 줄 돈(미지급) 장부가 있는 유형 — 서버 PURCHASE_PARTNER_TYPES 와 같음 (T-201). 둘 다 되는 유형은 원장 버튼 2개 */
const PAYABLE_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer']); // T-401 producer
const VIEW_KEY = 'partners.view';
function readView() {
  try {
    const v = window.localStorage.getItem(VIEW_KEY);
    return v === 'aging' || v === 'payaging' ? v : 'list';
  } catch {
    return 'list';
  }
}
const TYPE_LABEL = Object.fromEntries(PARTNER_TYPE_OPTIONS.map((o) => [o.value, o.label]));
export const partnerTypeLabel = (type) => TYPE_LABEL[type] || type || '-';

/* ── API (api.js 는 이 작업 범위 밖이라 같은 인증 방식으로 여기서 호출) ── */
async function sendPartner(method, url, body) {
  const token = getToken();
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && getUser()) {
    try {
      window.sessionStorage.removeItem('user');
    } catch {
      /* 저장소 접근 불가 — 무시 */
    }
    window.location.href = '/login';
  }
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* 본문 없음 */
  }
  if (!res.ok) throw new Error(data.message || '저장하지 못했습니다.');
  return data.data;
}
export const createPartner = (body) => sendPartner('POST', `${API_BASE}/partners`, body);
export const updatePartner = (id, body) => sendPartner('PUT', `${API_BASE}/partners/${encodeURIComponent(id)}`, body);

const EMPTY_FORM = { name: '', type: 'supplier', contact: '', phone: '', email: '', location: '', address: '', memo: '', credit_limit: '',
  origin_region: '', bank_name: '', bank_account: '', bank_holder: '' };
const FIELDS = ['name', 'type', 'contact', 'phone', 'email', 'location', 'address', 'memo', 'credit_limit',
  'origin_region', 'bank_name', 'bank_account', 'bank_holder']; // T-401 10장 산지·입금 계좌
const BANK_FIELDS = ['bank_name', 'bank_account', 'bank_holder'];
const EMAIL_RE = /^[^s@]+@[^s@]+.[^s@]+$/; // T-214 입금 안내 받는 주소

/* ── 외상 한도 (T-207) — 서버는 NUMERIC 문자열("10000.00")로 준다. 입력은 콤마 허용, 비우면 한도 없음 ── */
/** 서버 값 → 입력칸 문자열("10000.00" → "10,000", null → "") */
const limitToInput = (v) => (v == null || v === '' ? '' : Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 2 }));
/** 입력칸 → 비교·전송용 정규 문자열("10,000" → "10000", "" → "") */
const normLimit = (s) => {
  const t = String(s ?? '').replace(/,/g, '').trim();
  return t === '' ? '' : String(Number(t));
};
const LIMIT_RE = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * 거래처 등록·수정 모달.
 * - partner 가 있으면 수정, 없으면 등록(defaultType 으로 유형 기본값)
 * - 매입·매출 모달 위에 겹쳐 띄울 수 있도록 Main.jsx 의 Modal 과 같은 클래스를 쓰고 스크롤 잠금은 원래 값으로 되돌린다
 * - 수정 시 바뀐 항목만 보낸다(목록 API 가 메모를 주지 않아도 기존 메모를 지우지 않게)
 */
export function PartnerFormModal({ open, partner, defaultType = 'supplier', allowedTypes, onClose, onSaved }) {
  const titleId = useId();
  const formId = `partner-form-${titleId.replace(/:/g, '')}`;
  const [form, setForm] = useState(EMPTY_FORM);
  const [err, setErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  submittingRef.current = submitting;
  const isEdit = !!partner;
  const typeOptions = allowedTypes ? PARTNER_TYPE_OPTIONS.filter((o) => allowedTypes.has(o.value)) : PARTNER_TYPE_OPTIONS;

  useEffect(() => {
    if (!open) return;
    setErr('');
    setSubmitting(false);
    if (partner) {
      const f = {};
      for (const k of FIELDS) f[k] = partner[k] == null ? '' : String(partner[k]);
      f.credit_limit = limitToInput(partner.credit_limit);
      setForm(f);
    } else {
      setForm({ ...EMPTY_FORM, type: defaultType });
    }
  }, [open, partner, defaultType]);

  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      // T-404: 저장 요청 중에는 Esc 로 닫지 않는다(닫혀도 요청은 끝까지 가서 새로 연 창에 결과가 섞였다)
      if (e.key === 'Escape' && !submittingRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setErr('');
    if (!form.name.trim()) {
      setErr('거래처 이름을 입력하세요.');
      return;
    }
    if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) {
      setErr('이메일 형식이 올바르지 않습니다.');
      return;
    }
    const limitText = String(form.credit_limit ?? '').replace(/,/g, '').trim();
    const bankFilled = BANK_FIELDS.filter((k) => String(form[k] ?? '').trim());
    if (bankFilled.length && bankFilled.length !== 3) {
      setErr('입금 계좌는 은행·계좌번호·예금주를 모두 넣거나 모두 비우세요.');
      return;
    }
    if (String(form.bank_account ?? '').trim() && !/^[0-9-]{4,50}$/.test(String(form.bank_account).trim())) {
      setErr('계좌번호는 숫자와 하이픈(-)만 4~50자로 입력하세요.');
      return;
    }
    if (limitText !== '' && !LIMIT_RE.test(limitText)) {
      setErr('외상 한도는 0 이상의 금액으로 입력하세요(비우면 한도 없음).');
      return;
    }
    let body;
    if (isEdit) {
      body = {};
      for (const k of FIELDS) {
        if (k === 'credit_limit') {
          const before = partner.credit_limit == null ? '' : String(Number(partner.credit_limit));
          if (normLimit(form.credit_limit) !== before) body.credit_limit = limitText === '' ? null : limitText;
          continue;
        }
        const before = partner[k] == null ? '' : String(partner[k]);
        if (k in partner || form[k] !== '') {
          if (form[k].trim() !== before.trim()) body[k] = form[k];
        }
      }
      // T-401 PR-01: 계좌는 세 칸을 함께 보낸다(서버가 셋 다 있거나 셋 다 없게 검사)
      if (BANK_FIELDS.some((k) => k in body)) BANK_FIELDS.forEach((k) => { body[k] = form[k]; });
      if (Object.keys(body).length === 0) {
        onClose();
        return;
      }
    } else {
      body = { ...form, credit_limit: limitText === '' ? null : limitText };
    }
    setSubmitting(true);
    (isEdit ? updatePartner(partner.id, body) : createPartner(body))
      .then((saved) => {
        setSubmitting(false);
        onSaved(saved);
      })
      .catch((ex) => {
        setSubmitting(false);
        setErr(ex.message);
      });
  };

  return (
    <div className="main-modal-backdrop partner-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="main-modal partner-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="main-modal-header">
          <h2 id={titleId}>{isEdit ? '거래처 수정' : '새 거래처 등록'}</h2>
        </div>
        <div className="main-modal-body">
          <form id={formId} className="main-modal-form" onSubmit={submit} noValidate>
            {err && (
              <div className="main-alert-banner" role="alert" style={{ marginBottom: '0.75rem' }}>
                {err}
              </div>
            )}
            <div className="main-modal-fields partner-form-grid">
              <label className="partner-field-wide">
                <span className="partner-label">거래처 이름 <span className="partner-required" aria-hidden="true">*</span></span>
                <input
                  type="text"
                  required
                  aria-required="true"
                  maxLength={200}
                  autoFocus
                  autoComplete="off"
                  placeholder="예: 한국청과"
                  value={form.name}
                  onChange={set('name')}
                />
              </label>
              <label>
                <span className="partner-label">유형 <span className="partner-required" aria-hidden="true">*</span></span>
                <select required value={form.type} onChange={set('type')}>
                  {typeOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label} — {o.hint}
                    </option>
                  ))}
                  {isEdit && !typeOptions.some((o) => o.value === form.type) && (
                    <option value={form.type}>{partnerTypeLabel(form.type)}</option>
                  )}
                </select>
              </label>
              <label>
                담당자
                <input type="text" maxLength={100} autoComplete="off" value={form.contact} onChange={set('contact')} />
              </label>
              <label>
                연락처
                <input type="text" inputMode="tel" maxLength={50} autoComplete="off" placeholder="010-0000-0000" value={form.phone} onChange={set('phone')} />
              </label>
              {RECEIVABLE_TYPES.has(form.type) && (
                <label className="partner-field-wide">
                  <span className="partner-label">이메일(입금 안내 받는 곳)</span>
                  <input
                    type="email"
                    inputMode="email"
                    maxLength={255}
                    autoComplete="off"
                    placeholder="예: account@example.com"
                    aria-describedby={`${formId}-email-hint`}
                    value={form.email}
                    onChange={set('email')}
                  />
                  <span id={`${formId}-email-hint`} className="partner-hint">
                    원장의 [입금 안내 보내기]가 이 주소로 미수 금액을 보냅니다. 비워도 됩니다.
                  </span>
                </label>
              )}
              <label>
                위치
                <input type="text" maxLength={200} autoComplete="off" placeholder="예: 가락시장 청과동" value={form.location} onChange={set('location')} />
              </label>
              <label className="partner-field-wide">
                주소
                <input type="text" maxLength={2000} autoComplete="off" value={form.address} onChange={set('address')} />
              </label>
              {RECEIVABLE_TYPES.has(form.type) && (
                <label className="partner-field-wide">
                  <span className="partner-label">외상 한도(원)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    maxLength={20}
                    autoComplete="off"
                    placeholder="비우면 한도 없음"
                    aria-describedby={`${formId}-limit-hint`}
                    value={form.credit_limit}
                    onChange={set('credit_limit')}
                  />
                  <span id={`${formId}-limit-hint`} className="partner-hint">
                    판매·매출 수정 후 미수가 이 금액을 넘으면 저장 전에 경고합니다(막지는 않음). 0 = 외상 없음.
                  </span>
                </label>
              )}
              {form.type === 'producer' && (
                <label>
                  산지(시·군)
                  <input type="text" maxLength={100} autoComplete="off" placeholder="예: 해남군" value={form.origin_region} onChange={set('origin_region')} />
                </label>
              )}
              <fieldset className="partner-field-full partner-bank">
                <legend>입금 계좌(선택 — 셋 다 넣거나 모두 비움)</legend>
                <label>
                  은행
                  <input type="text" maxLength={50} autoComplete="off" placeholder="예: 농협" value={form.bank_name} onChange={set('bank_name')} />
                </label>
                <label>
                  계좌번호
                  <input type="text" inputMode="numeric" maxLength={50} autoComplete="off" placeholder="숫자·하이픈" value={form.bank_account} onChange={set('bank_account')} />
                </label>
                <label>
                  예금주
                  <input type="text" maxLength={100} autoComplete="off" value={form.bank_holder} onChange={set('bank_holder')} />
                </label>
              </fieldset>
              <label className="partner-field-full">
                메모
                <textarea rows={3} maxLength={2000} value={form.memo} onChange={set('memo')} />
              </label>
            </div>
          </form>
        </div>
        <div className="main-modal-footer">
          <button type="button" className="main-modal-btn secondary" onClick={() => !submitting && onClose()} disabled={submitting}>
            취소
          </button>
          <button type="submit" form={formId} className="main-modal-btn primary" disabled={submitting} aria-busy={submitting}>
            {submitting ? '처리 중…' : isEdit ? '저장' : '등록'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 미수 칸 아래 한도 한 줄 — 한도 없는 거래처는 표시 안 함. 넘으면 빨간 글자 (T-207) */
function creditLine(p, due) {
  if (p.credit_limit == null || !RECEIVABLE_TYPES.has(p.type)) return null;
  const limit = Number(p.credit_limit);
  const over = Math.round(Number(due || 0) * 100) > Math.round(limit * 100);
  const pct = limit > 0 ? ` · ${Math.round((Number(due || 0) / limit) * 1000) / 10}%` : '';
  return (
    <span className={'credit-limit-line' + (over ? ' credit-limit-line--over' : '')}>
      {over ? '한도 초과 · ' : ''}한도 {won(limit)}{pct}
    </span>
  );
}

export default function TabPartners() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  // T-104 원장·미수 연령
  const [view, setView] = useState(readView);
  const [dueMap, setDueMap] = useState(() => new Map());
  const [dueErr, setDueErr] = useState('');
  const [sortByDue, setSortByDue] = useState(false);
  const [ledgerPartner, setLedgerPartner] = useState(null);
  // T-201: 원장 종류 — 'receivable'(받을 돈) | 'payable'(지급 원장)
  const [ledgerMode, setLedgerMode] = useState('receivable');
  const [agingFocus, setAgingFocus] = useState(null);
  const openLedger = (partner, mode) => {
    setLedgerMode(mode);
    setLedgerPartner(partner);
  };

  const switchView = (v) => {
    setView(v);
    if (v === 'list') setAgingFocus(null);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* 저장소 접근 불가 — 이번 화면에서만 유지 */
    }
  };
  // 미수 칸은 거래처마다 부르지 않고 미수 연령 API 한 번으로 채운다
  const loadDue = () => {
    setDueErr('');
    fetchReceivablesAging()
      .then((d) => setDueMap(new Map(d.rows.map((r) => [r.partner_id, r]))))
      .catch((e) => setDueErr(e.message));
  };

  const load = () => {
    setLoading(true);
    setErr('');
    fetchPartners()
      .then((rows) =>
        setList((prev) => {
          // 목록 API 가 주지 않는 메모는 이번 화면에서 저장한 값으로 채워 둔다
          const memo = new Map(prev.filter((p) => 'memo' in p).map((p) => [p.id, p.memo]));
          return rows.map((r) => ('memo' in r || !memo.has(r.id) ? r : { ...r, memo: memo.get(r.id) }));
        })
      )
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
    loadDue();
  }, []);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    const rows = list.filter((p) => {
      if (typeFilter && p.type !== typeFilter) return false;
      if (!k) return true;
      return [p.name, p.contact, p.phone, p.location, p.address, p.memo].some((v) => v && String(v).toLowerCase().includes(k));
    });
    if (!sortByDue) return rows;
    const due = (p) => dueMap.get(p.id)?.total_due || 0;
    return [...rows].sort((a, b) => due(b) - due(a));
  }, [list, q, typeFilter, sortByDue, dueMap]);

  const closeLedger = useCallback(() => setLedgerPartner(null), []);
  const close = () => {
    setShowForm(false);
    setEditing(null);
  };
  const onSaved = (saved) => {
    const wasEdit = !!editing;
    close();
    setList((prev) => {
      const next = wasEdit ? prev.map((p) => (p.id === saved.id ? { ...p, ...saved } : p)) : [...prev, saved];
      return next.sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));
    });
    setNotice(wasEdit ? `'${saved.name}' 거래처를 수정했습니다.` : `'${saved.name}' 거래처를 등록했습니다.`);
  };

  return (
    <>
      {notice && (
        <div className="partner-notice" role="status">
          {notice}
        </div>
      )}
      <div className="partner-view-switch" role="tablist" aria-label="거래처 보기">
        <button type="button" role="tab" aria-selected={view === 'list'} onClick={() => switchView('list')}>
          거래처 목록
        </button>
        <button type="button" role="tab" aria-selected={view === 'aging'} onClick={() => switchView('aging')}>
          미수 연령
        </button>
        <button type="button" role="tab" aria-selected={view === 'payaging'} onClick={() => switchView('payaging')}>
          미지급 연령
        </button>
      </div>
      {view === 'aging' ? (
        <ReceivablesAgingView focusPartnerId={agingFocus} onOpenLedger={(p) => openLedger(p, 'receivable')} />
      ) : view === 'payaging' ? (
        <ReceivablesAgingView mode="payable" focusPartnerId={agingFocus} onOpenLedger={(p) => openLedger(p, 'payable')} />
      ) : (
      <>
      <ExcelUploadBar kinds={['partner']} onDone={() => { load(); loadDue(); }} />
      <div className="main-filters">
        <label>
          검색
          <input
            type="search"
            className="partner-search"
            placeholder="이름·담당자·연락처·위치"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="거래처 검색"
          />
        </label>
        <label>
          유형
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">전체</option>
            {PARTNER_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="main-btn main-btn--secondary"
          onClick={() => {
            load();
            loadDue();
          }}
        >
          새로고침
        </button>
        {can('partner.create') && (
        <button
          type="button"
          className="main-btn"
          onClick={() => {
            setNotice('');
            setEditing(null);
            setShowForm(true);
          }}
        >
          거래처 등록
        </button>
        )}
      </div>
      {loading ? (
        <p className="main-loading">불러오는 중…</p>
      ) : err ? (
        <p className="main-error">{err}</p>
      ) : list.length === 0 ? (
        <p className="main-empty">등록된 거래처가 없습니다. 「거래처 등록」으로 첫 매입처·판매처를 추가하세요.</p>
      ) : shown.length === 0 ? (
        <p className="main-empty">조건에 맞는 거래처가 없습니다.</p>
      ) : (
        <>
        {dueErr && <p className="main-error">미수를 불러오지 못했습니다: {dueErr}</p>}
        <p className="partner-count">{shown.length === list.length ? `${list.length}곳` : `${shown.length}곳 / 전체 ${list.length}곳`}</p>
        <div className="main-table-wrap">
          <table className="main-table partner-table main-table--cards">
            <thead>
              <tr>
                <th>거래처</th>
                <th>유형</th>
                <th>담당자</th>
                <th>연락처</th>
                <th>위치</th>
                <th>주소</th>
                <th className="main-col-memo">메모</th>
                <th className="num" aria-sort={sortByDue ? 'descending' : 'none'}>
                  <button type="button" className="partner-sort-btn" onClick={() => setSortByDue((v) => !v)} title="미수 큰 순으로 정렬">
                    미수{sortByDue ? ' ▾' : ''}
                  </button>
                </th>
                <th className="num">미지급</th>
                <th aria-label="관리" />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id}>
                  <td data-card="title" data-label="거래처" className="partner-name">{p.name}</td>
                  <td data-card="sub" data-label="유형">
                    <span className={`partner-type partner-type--${p.type}`}>{partnerTypeLabel(p.type)}</span>
                  </td>
                  <td data-card="key" data-label="담당자">{p.contact || '-'}</td>
                  <td data-card="key" data-label="연락처">{p.phone || '-'}</td>
                  <td data-card="key" data-label="위치">{p.location || '-'}</td>
                  <td data-card="extra" data-label="주소" className="partner-address">{p.address || '-'}</td>
                  <td data-card="extra" data-label="메모" className="main-col-memo">{p.memo || '-'}</td>
                  <td data-card="key" data-label="미수" className="partner-due">
                    {(() => {
                      const d = dueMap.get(p.id);
                      if (!d || !d.total_due) {
                        return (
                          <>
                            <span className="partner-due-none">—</span>
                            {creditLine(p, 0)}
                          </>
                        );
                      }
                      return (
                        <>
                          <span className="partner-due-amt">{won(d.total_due)}</span>
                          {d.d91p > 0 && <span className="partner-due-over">90일 초과 {won(d.d91p)}</span>}
                          {creditLine(p, d.total_due)}
                        </>
                      );
                    })()}
                  </td>
                  <td data-card="key" data-label="미지급" className="partner-due">
                    {PAYABLE_TYPES.has(p.type) && Number(p.payable_amount) > 0 ? (
                      <span className="partner-due-amt">{won(p.payable_amount)}</span>
                    ) : (
                      <span className="partner-due-none">—</span>
                    )}
                  </td>
                  <td data-card="action">
                    <span className="partner-actions">
                    {RECEIVABLE_TYPES.has(p.type) && (
                      <button
                        type="button"
                        className="main-btn main-btn--secondary partner-edit-btn"
                        aria-label={`${p.name} 원장`}
                        onClick={() => openLedger(p, 'receivable')}
                      >
                        원장
                      </button>
                    )}
                    {PAYABLE_TYPES.has(p.type) && (
                      <button
                        type="button"
                        className="main-btn main-btn--secondary partner-edit-btn"
                        aria-label={`${p.name} 지급 원장`}
                        onClick={() => openLedger(p, 'payable')}
                      >
                        지급 원장
                      </button>
                    )}
                    {can('partner.update') && (
                    <button
                      type="button"
                      className="main-btn main-btn--secondary partner-edit-btn"
                      aria-label={`${p.name} 수정`}
                      onClick={() => {
                        setNotice('');
                        setEditing(p);
                        setShowForm(true);
                      }}
                    >
                      수정
                    </button>
                    )}
                    </span>
                  </td>
                  <td className="main-card-more" data-card="more"><CardMoreToggle /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      </>
      )}
      <PartnerFormModal open={showForm} partner={editing} onClose={close} onSaved={onSaved} />
      {ledgerPartner && (
        <PartnerLedgerModal
          partner={ledgerPartner}
          mode={ledgerMode}
          onClose={closeLedger}
          onShowAging={(p) => {
            setLedgerPartner(null);
            setAgingFocus(p.id);
            switchView(ledgerMode === 'payable' ? 'payaging' : 'aging');
          }}
        />
      )}
    </>
  );
}
