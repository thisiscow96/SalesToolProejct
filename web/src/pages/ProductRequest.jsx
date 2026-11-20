// 개인 품목·공용 등록 요청 (T-216, 기능 제안 P21)
//  - PersonalProductModal: 매입 등록 중 목록에 없는 품목을 내 개인 품목으로 바로 추가 (+ 관리자에게 공용 등록 요청)
//  - ProductRequestAdminPanel: 관리자 상품 마스터 안에서 요청 승인(공용으로 승격) · 반려
// 모달 모양은 거래처 빠른 등록(TabPartners.css 의 partner-modal 클래스)을 그대로 쓴다.
import { useEffect, useId, useState } from 'react';
import { createPersonalProduct, fetchProductRequests, approveProductRequest, rejectProductRequest } from '../api';
import './TabPartners.css';
import './ProductRequest.css';

/** 품목 선택 목록에 붙이는 표시 — 공용은 이름만, 개인은 상태를 함께 */
export function productOptionLabel(p) {
  if (!p?.is_personal) return p?.name ?? '';
  const st = p.request_status === 'pending' ? '개인·공용 요청 중' : p.request_status === 'rejected' ? '개인·요청 반려' : '개인';
  return `${p.name} (${st})`;
}

const EMPTY = { name: '', unit: 'kg', category_large: '', memo: '', request_public: true, note: '' };

export function PersonalProductModal({ open, onClose, onSaved, onUsePublic }) {
  const titleId = useId();
  const formId = `personal-product-${titleId.replace(/:/g, '')}`;
  const [form, setForm] = useState(EMPTY);
  const [err, setErr] = useState('');
  const [dupPublic, setDupPublic] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setErr('');
    setDupPublic(null);
    setSubmitting(false);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setErr('');
    setDupPublic(null);
    if (!form.name.trim()) {
      setErr('품목명을 입력하세요.');
      return;
    }
    setSubmitting(true);
    createPersonalProduct(form)
      .then((saved) => {
        setSubmitting(false);
        onSaved(saved);
      })
      .catch((ex) => {
        setSubmitting(false);
        setErr(ex.message);
        if (ex.code === 'DUPLICATE_PUBLIC' && ex.product) setDupPublic(ex.product);
        if (ex.code === 'DUPLICATE_PERSONAL' && ex.product) setDupPublic(ex.product);
      });
  };

  return (
    <div className="main-modal-backdrop partner-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="main-modal partner-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="main-modal-header">
          <h2 id={titleId}>목록에 없는 품목 추가</h2>
        </div>
        <div className="main-modal-body">
          <p className="product-request-help">
            내 <strong>개인 품목</strong>으로 바로 추가되어 지금 매입에 쓸 수 있습니다. 다른 중매인에게는 보이지 않습니다.
          </p>
          <form id={formId} className="main-modal-form" onSubmit={submit} noValidate>
            {err && (
              <div className="main-alert-banner" role="alert" style={{ marginBottom: '0.75rem' }}>
                {err}
                {dupPublic && (
                  <button
                    type="button"
                    className="main-modal-toolbar-btn"
                    style={{ marginLeft: '0.5rem' }}
                    onClick={() => onUsePublic(dupPublic)}
                  >
                    「{dupPublic.name}」 선택
                  </button>
                )}
              </div>
            )}
            <div className="main-modal-fields partner-form-grid">
              <label className="partner-field-wide">
                <span className="partner-label">품목명 <span className="partner-required" aria-hidden="true">*</span></span>
                <input type="text" required aria-required="true" maxLength={200} autoFocus autoComplete="off" placeholder="예: 샤인머스캣 2kg" value={form.name} onChange={set('name')} />
              </label>
              <label>
                단위
                <input type="text" maxLength={50} autoComplete="off" value={form.unit} onChange={set('unit')} />
              </label>
              <label>
                대분류
                <input type="text" maxLength={100} autoComplete="off" placeholder="예: 과일" value={form.category_large} onChange={set('category_large')} />
              </label>
              <label className="partner-field-full product-request-check">
                <input type="checkbox" checked={form.request_public} onChange={set('request_public')} />
                <span>관리자에게 <strong>공용 품목</strong>으로 등록을 요청합니다 (승인되면 모든 중매인이 씁니다. 지금까지의 매입은 그대로 이어집니다)</span>
              </label>
              {form.request_public && (
                <label className="partner-field-full">
                  요청 메모
                  <input type="text" maxLength={2000} autoComplete="off" placeholder="예: 이번 주부터 경매에 자주 나옴" value={form.note} onChange={set('note')} />
                </label>
              )}
            </div>
          </form>
        </div>
        <div className="main-modal-footer">
          <button type="button" className="main-modal-btn secondary" onClick={onClose}>
            취소
          </button>
          <button type="submit" form={formId} className="main-modal-btn primary" disabled={submitting}>
            {submitting ? '처리 중…' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_LABEL = { pending: '대기', approved: '승인', rejected: '반려' };

function fmtDate(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
}

/** 관리자: 품목 등록 요청 목록 — 승인(공용 승격) · 반려. onChanged 는 공용 품목 목록 새로고침 */
export function ProductRequestAdminPanel({ onChanged }) {
  const [status, setStatus] = useState('pending');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null); // { id, reason }

  const load = (st = status) => {
    setLoading(true);
    setErr('');
    fetchProductRequests(st)
      .then(setRows)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 상태 필터가 바뀔 때만 다시 조회
  }, [status]);

  const approve = (row) => {
    setBusyId(row.id);
    setErr('');
    setNotice('');
    approveProductRequest(row.id)
      .then((p) => {
        setNotice(`「${p.name}」을(를) 공용 품목으로 승인했습니다.`);
        load();
        onChanged?.();
      })
      .catch((e) => setErr(e.message))
      .finally(() => setBusyId(null));
  };

  const submitReject = (e) => {
    e.preventDefault();
    if (!rejecting?.reason?.trim()) {
      setErr('반려 사유를 입력하세요.');
      return;
    }
    setBusyId(rejecting.id);
    setErr('');
    setNotice('');
    rejectProductRequest(rejecting.id, rejecting.reason)
      .then(() => {
        setNotice('반려했습니다. 품목은 요청한 중매인의 개인 품목으로 남습니다.');
        setRejecting(null);
        load();
      })
      .catch((ex) => setErr(ex.message))
      .finally(() => setBusyId(null));
  };

  return (
    <section className="product-request-panel" aria-labelledby="product-request-title">
      <div className="product-request-head">
        <h3 id="product-request-title">품목 등록 요청</h3>
        <label>
          상태{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">대기</option>
            <option value="approved">승인</option>
            <option value="rejected">반려</option>
            <option value="all">전체</option>
          </select>
        </label>
      </div>
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      {notice && <div className="product-request-notice" role="status">{notice}</div>}
      {loading ? (
        <p className="main-loading">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="product-request-empty">{status === 'pending' ? '대기 중인 요청이 없습니다.' : '요청이 없습니다.'}</p>
      ) : (
        <div className="main-table-wrap">
          <table className="main-table">
            <thead>
              <tr>
                <th>요청일</th>
                <th>품목명</th>
                <th>단위</th>
                <th>대분류</th>
                <th>요청 중매인</th>
                <th>매입 건수</th>
                <th>메모</th>
                <th>상태</th>
                <th>처리</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="main-col-date">{fmtDate(r.created_at)}</td>
                  <td>
                    {r.product_name}
                    {r.status === 'pending' && r.duplicate_public_id && (
                      <span className="product-request-dup" title="같은 이름의 공용 품목이 있어 승인할 수 없습니다. 반려하고 그 품목을 쓰도록 안내하세요.">
                        {' '}같은 이름 공용 있음
                      </span>
                    )}
                  </td>
                  <td>{r.unit}</td>
                  <td>{r.category_large || '-'}</td>
                  <td>
                    {r.requester_name} ({r.requester_agent_no})
                  </td>
                  <td>{r.purchase_count}</td>
                  <td>{r.status === 'rejected' ? `반려: ${r.reject_reason}` : r.note || '-'}</td>
                  <td>{STATUS_LABEL[r.status] || r.status}</td>
                  <td>
                    {r.status === 'pending' ? (
                      rejecting?.id === r.id ? (
                        <form className="product-request-reject" onSubmit={submitReject}>
                          <input
                            type="text"
                            aria-label="반려 사유"
                            placeholder="반려 사유"
                            maxLength={2000}
                            autoFocus
                            value={rejecting.reason}
                            onChange={(e) => setRejecting({ id: r.id, reason: e.target.value })}
                          />
                          <button type="submit" className="main-modal-toolbar-btn" disabled={busyId === r.id}>반려</button>
                          <button type="button" className="main-modal-toolbar-btn" onClick={() => setRejecting(null)}>취소</button>
                        </form>
                      ) : (
                        <>
                          <button type="button" className="main-modal-toolbar-btn" disabled={busyId === r.id || !!r.duplicate_public_id} onClick={() => approve(r)}>
                            승인
                          </button>{' '}
                          <button type="button" className="main-modal-toolbar-btn" disabled={busyId === r.id} onClick={() => setRejecting({ id: r.id, reason: r.duplicate_public_id ? '같은 이름의 공용 품목이 있습니다. 그 품목을 선택해 쓰세요.' : '' })}>
                            반려
                          </button>
                        </>
                      )
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
