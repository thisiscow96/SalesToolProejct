// 매입·매출 정정(수정·취소) 화면 — T-103 W-08 (설계: T-103_정정_설계.md 7장)
// - 목록 행 끝 "관리(⋯)" 메뉴 → 수정 / 취소
// - 메뉴 활성 여부는 화면이 미리 판단하고(툴팁으로 이유 표시), 최종 판정은 서버(409 code)가 한다
// - 서버 409 는 모달 안 오류 영역에 이유와 먼저 할 일을 보여 준다
// Main.jsx 의 매입 등록·CSV 툴바 등 병행 작업과 겹치지 않게 별도 파일로 둔다(API 호출도 이 파일 안에서).
import { useEffect, useRef, useState } from 'react';
import { API_BASE, getToken, fetchInventory } from '../api';
import CreditLimitWarning, { creditWarningsOf, creditLine } from '../components/CreditLimitWarning';
import './TradeCorrection.css';

const CANCEL_REASONS = ['오입력', '중복 입력', '거래 취소'];
const CANCEL_REASON_OTHER = '기타';

const fmt = (n) => {
  if (n == null || n === '') return '—';
  const x = Number(n);
  return Number.isNaN(x) ? String(n) : x.toLocaleString('ko-KR');
};
/** 날짜 칸 → YYYY-MM-DD. 서버가 DATE 를 "YYYY-MM-DD" 로 주든, JS Date(UTC ISO, 예: 전날 15:00Z)로 주든 같은 날로 보이게 로컬 날짜로 맞춘다 */
const ymd = (v) => {
  if (v == null || v === '') return '';
  const s = String(v);
  if (/^d{4}-d{2}-d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 정정 API 오류 — 서버의 code·detail 을 같이 넘긴다 */
class CorrectionError extends Error {
  constructor(status, body) {
    super(body?.message || '처리에 실패했습니다.');
    this.status = status;
    this.code = body?.code || null;
    this.detail = body?.detail || null;
  }
}

async function correctionRequest(method, path, body) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    try { window.sessionStorage.removeItem('user'); } catch { /* 무시 */ }
    window.location.href = '/login';
  }
  let data = {};
  try { data = await res.json(); } catch { /* 빈 응답 */ }
  if (!res.ok) throw new CorrectionError(res.status, data);
  return data;
}

export const cancelPurchase = (id, body) => correctionRequest('POST', `/purchases/${id}/cancel`, body);
export const updatePurchase = (id, body) => correctionRequest('PATCH', `/purchases/${id}`, body);
export const cancelSale = (id, body) => correctionRequest('POST', `/sales/${id}/cancel`, body);
export const updateSale = (id, body) => correctionRequest('PATCH', `/sales/${id}`, body);

const toIso = (v) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

// ---------------------------------------------------------------------------
// 화면 미리 판단 (7.1·7.2) — 비활성 이유는 툴팁으로
// ---------------------------------------------------------------------------
export function purchaseMenuState(row) {
  if (row.status === 'cancelled') {
    return { edit: false, cancel: false, editTip: '취소된 매입입니다.', cancelTip: '취소된 매입입니다.' };
  }
  const alloc = Number(row.allocated_qty || 0);
  // T-201 RULE-07: 지급이 걸린 매입은 취소 불가 — 지급정보에서 지급을 먼저 취소
  const paid = Number(row.paid_amount || 0);
  let cancelTip = '';
  if (alloc > 0) cancelTip = '매출로 전환된 수량이 있어 취소할 수 없습니다. 연결된 매출을 먼저 취소하세요.';
  else if (paid > 0) cancelTip = '지급 기록이 있어 취소할 수 없습니다 — 지급정보에서 지급을 먼저 취소하세요.';
  return {
    edit: true,
    cancel: alloc <= 0 && paid <= 0,
    editTip: '',
    cancelTip,
  };
}

export function saleMenuState(row) {
  if (row.status === 'cancelled') {
    return { edit: false, cancel: false, editTip: '취소된 매출입니다.', cancelTip: '취소된 매출입니다.' };
  }
  const paid = Number(row.paid_amount || 0) > 0;
  const refunded = Number(row.refunded_qty || 0) > 0 || row.status === 'refunded';
  let cancelTip = '';
  if (paid) cancelTip = '수금된 매출은 취소할 수 없습니다. 반품(환불)으로 처리하세요.';
  else if (refunded) cancelTip = '반품 이력이 있어 취소할 수 없습니다. 남은 수량은 반품으로 처리하세요.';
  return { edit: true, cancel: !paid && !refunded, editTip: '', cancelTip };
}

// ---------------------------------------------------------------------------
// 행 메뉴 (⋯)
// ---------------------------------------------------------------------------
export function RowActionMenu({ label, state, onEdit, onCancel }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const btnRef = useRef(null);
  // 표 영역(overflow)에 잘리지 않게 화면 기준(fixed)으로 띄운다
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const below = window.innerHeight - r.bottom > 180;
      setPos({ right: Math.max(8, window.innerWidth - r.right), ...(below ? { top: r.bottom + 4 } : { bottom: window.innerHeight - r.top + 4 }) });
    }
    setOpen((v) => !v);
  };
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    const off = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', off, true);
    window.addEventListener('resize', off);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', off, true);
      window.removeEventListener('resize', off);
    };
  }, [open]);
  const disabledAll = !state.edit && !state.cancel;
  return (
    <div className="tc-menu" ref={ref}>
      <button
        type="button"
        ref={btnRef}
        className="tc-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} 관리`}
        title={disabledAll ? state.cancelTip : `${label} 수정·취소`}
        disabled={disabledAll}
        onClick={toggle}
      >
        ⋯
      </button>
      {open && (
        <div className="tc-menu-list" role="menu" style={pos || undefined}>
          <button
            type="button"
            role="menuitem"
            className="tc-menu-item"
            disabled={!state.edit}
            title={state.editTip || undefined}
            onClick={() => { setOpen(false); onEdit(); }}
          >
            수정
          </button>
          <button
            type="button"
            role="menuitem"
            className="tc-menu-item tc-menu-item--danger"
            disabled={!state.cancel}
            aria-disabled={!state.cancel}
            title={state.cancelTip || undefined}
            onClick={() => { setOpen(false); onCancel(); }}
          >
            취소
          </button>
          {!state.cancel && state.cancelTip && <p className="tc-menu-tip">{state.cancelTip}</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 모달 틀 (Main.jsx Modal 과 같은 클래스 — 같은 모양)
// ---------------------------------------------------------------------------
function CorrectionModal({ title, onClose, formId, saveLabel, submitting, saveDisabled, danger, children }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e) => e.key === 'Escape' && !submitting && onClose();
    document.addEventListener('keydown', esc);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener('keydown', esc);
    };
  }, [onClose, submitting]);
  return (
    <div className="main-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="main-modal tc-modal" role="dialog" aria-modal="true" aria-labelledby="tc-modal-title">
        <div className="main-modal-header">
          <h2 id="tc-modal-title">{title}</h2>
        </div>
        <div className="main-modal-body">{children}</div>
        <div className="main-modal-footer">
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={submitting}>
            닫기
          </button>
          <button
            type="submit"
            form={formId}
            className={'main-modal-btn primary' + (danger ? ' tc-btn-danger' : '')}
            disabled={submitting || saveDisabled}
          >
            {submitting ? '처리 중…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 서버 409·400 안내 — 코드별로 먼저 할 일을 보여 준다 (7.1-6) */
function CorrectionAlert({ error, onGoSales }) {
  if (!error) return null;
  return (
    <div className="main-alert-banner tc-alert" role="alert">
      <p className="tc-alert-msg">{error.message}</p>
      {error.code === 'PURCHASE_HAS_SALES' && Array.isArray(error.detail?.sales) && error.detail.sales.length > 0 && (
        <>
          <table className="tc-linked-table">
            <caption>연결된 매출 — 매출정보에서 먼저 취소하세요</caption>
            <thead>
              <tr><th>매출</th><th>매출일</th><th>판매처</th><th className="num">수량</th><th>수금</th></tr>
            </thead>
            <tbody>
              {error.detail.sales.map((s) => (
                <tr key={s.id}>
                  <td>#{s.id}</td>
                  <td>{ymd(s.sale_date)}</td>
                  <td>{s.partner_name}</td>
                  <td className="num">{fmt(s.quantity)}</td>
                  <td>{s.payment_status === 'paid' ? '완료' : s.payment_status === 'partial' ? '일부' : '미수'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {onGoSales && (
            <button type="button" className="main-btn main-btn--secondary tc-go-sales" onClick={() => onGoSales(error.detail.sales)}>
              매출정보에서 보기
            </button>
          )}
        </>
      )}
      {error.code === 'PURCHASE_HAS_PAYMENT' && Array.isArray(error.detail?.payments) && error.detail.payments.length > 0 && (
        <table className="tc-linked-table">
          <caption>걸린 지급 — 지급정보에서 먼저 취소하세요</caption>
          <thead>
            <tr><th>지급</th><th>지급일</th><th className="num">이 매입 몫</th></tr>
          </thead>
          <tbody>
            {error.detail.payments.map((x) => (
              <tr key={x.id}>
                <td>#{x.id}{x.kind === 'opening' ? ' (기초 정리)' : ''}</td>
                <td>{ymd(x.paid_at)}</td>
                <td className="num">{fmt(x.allocated)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error.code === 'PAID_OVER_TOTAL' && error.detail && (
        <p className="tc-alert-sub">이미 지급 {fmt(error.detail.paid_amount)} — 매입 금액은 이 금액 이상이어야 합니다. 줄이려면 지급을 먼저 취소하세요.</p>
      )}
      {error.code === 'INVENTORY_SHORT' && error.detail && (
        <p className="tc-alert-sub">현재 재고 {fmt(error.detail.inventory_qty)} — 폐기정보·매출정보를 확인하세요.</p>
      )}
      {error.code === 'STALE_DATA' && <p className="tc-alert-sub">목록을 최신 내용으로 다시 불러왔습니다. 값을 확인한 뒤 다시 저장하세요.</p>}
    </div>
  );
}

function CancelReasonField({ code, other, onCode, onOther }) {
  return (
    <fieldset className="tc-reason">
      <legend>취소 사유</legend>
      <div className="tc-reason-options">
        {[...CANCEL_REASONS, CANCEL_REASON_OTHER].map((r) => (
          <label key={r} className="tc-reason-option">
            <input type="radio" name="tc-cancel-reason" value={r} checked={code === r} onChange={() => onCode(r)} />
            {r}
          </label>
        ))}
      </div>
      {code === CANCEL_REASON_OTHER && (
        <input
          type="text"
          className="tc-input"
          aria-label="기타 사유 직접 입력"
          maxLength={200}
          value={other}
          placeholder="사유를 입력하세요"
          onChange={(e) => onOther(e.target.value)}
        />
      )}
    </fieldset>
  );
}

function buildCancelReason(code, other) {
  if (code === CANCEL_REASON_OTHER) return String(other || '').trim();
  return code;
}

// ---------------------------------------------------------------------------
// 취소 확인 모달 (매입·매출 공용)
// ---------------------------------------------------------------------------
export function CancelTradeModal({ kind, row, onClose, onDone, onReload, onGoSales }) {
  const [code, setCode] = useState(CANCEL_REASONS[0]);
  const [other, setOther] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [invQty, setInvQty] = useState(null);
  const isPurchase = kind === 'purchase';

  const [invTick, setInvTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetchInventory()
      .then((rows) => {
        if (!alive) return;
        const r = rows.find((x) => x.product_id === row.product_id);
        setInvQty(r ? Number(r.quantity) : 0);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [row.product_id, invTick]);

  const qty = Number(row.quantity);
  const after = invQty == null ? null : isPurchase ? invQty - qty : invQty + qty;
  const dateText = ymd(isPurchase ? row.purchase_date : row.sale_date);

  const submit = async (e) => {
    e.preventDefault();
    const reason = buildCancelReason(code, other);
    if (!reason) {
      setError({ message: '취소 사유를 입력하세요.' });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body = { reason, expected_updated_at: toIso(row.updated_at) };
      const r = isPurchase ? await cancelPurchase(row.id, body) : await cancelSale(row.id, body);
      onDone(`${isPurchase ? '매입' : '매출'} #${row.id}를 취소했습니다.`, r.data);
    } catch (er) {
      setError(er);
      setInvTick((t) => t + 1);
      if (er.code === 'STALE_DATA' || er.code === 'ALREADY_CANCELLED') onReload?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CorrectionModal
      title={`${isPurchase ? '매입' : '매출'} 취소`}
      onClose={onClose}
      formId="tc-cancel-form"
      saveLabel="취소 실행"
      submitting={submitting}
      danger
    >
      <form id="tc-cancel-form" className="main-modal-form tc-form" onSubmit={submit}>
        <CorrectionAlert error={error} onGoSales={isPurchase ? onGoSales : undefined} />
        <p className="tc-summary">
          <strong>{isPurchase ? '매입' : '매출'} #{row.id}</strong> · {row.product_name} {fmt(row.quantity)}{row.unit || ''} · {dateText}
          {!isPurchase && row.partner_name ? ` · ${row.partner_name}` : ''} 을(를) 취소합니다.
        </p>
        <p className="tc-effect">
          재고 {row.product_name}{' '}
          <span className="tc-effect-num">{invQty == null ? '…' : fmt(invQty)}</span> →{' '}
          <span className={'tc-effect-num' + (after != null && after < 0 ? ' tc-effect-num--bad' : '')}>{after == null ? '…' : fmt(after)}</span>
        </p>
        <ul className="tc-notes">
          {isPurchase ? (
            <li>지우지 않고 「취소」 상태로 남깁니다. 재고에서 빠지고 매입처로 되돌린 이동 이력이 남습니다.</li>
          ) : (
            <>
              <li>지우지 않고 「취소」 상태로 남깁니다. 재고로 되돌리고, 매입 잔여도 {fmt(row.quantity)} 돌아옵니다.</li>
              <li>미수·매출 집계에서 빠집니다.</li>
            </>
          )}
          <li>취소한 거래는 되살릴 수 없습니다. 필요하면 새로 등록하세요.</li>
        </ul>
        <CancelReasonField code={code} other={other} onCode={setCode} onOther={setOther} />
      </form>
    </CorrectionModal>
  );
}

// ---------------------------------------------------------------------------
// 수정 모달 — 매입
// ---------------------------------------------------------------------------
export function EditPurchaseModal({ row, products, partners, onClose, onDone, onReload, onGoSales }) {
  const alloc = Number(row.allocated_qty || 0);
  const paidAmt = Number(row.paid_amount || 0); // T-201 지급액 — 매입처 잠금·금액 하한
  const init = {
    quantity: String(Number(row.quantity)),
    unit_price: String(Number(row.unit_price)),
    partner_id: String(row.partner_id),
    product_id: String(row.product_id),
    source_name: row.source_name || '',
    purchase_date: ymd(row.purchase_date),
    memo: row.memo || '',
  };
  const [v, setV] = useState(init);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const set = (k) => (e) => setV((s) => ({ ...s, [k]: e.target.value }));

  const changes = {};
  if (Number(v.quantity) !== Number(init.quantity)) changes.quantity = Number(v.quantity);
  if (Number(v.unit_price) !== Number(init.unit_price)) changes.unit_price = Number(v.unit_price);
  if (v.partner_id !== init.partner_id) changes.partner_id = Number(v.partner_id);
  if (v.product_id !== init.product_id) changes.product_id = Number(v.product_id);
  if (v.source_name.trim() !== init.source_name.trim()) changes.source_name = v.source_name.trim();
  if (v.purchase_date !== init.purchase_date) changes.purchase_date = v.purchase_date;
  if (v.memo.trim() !== init.memo.trim()) changes.memo = v.memo.trim();
  const changedCount = Object.keys(changes).length;

  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError({ message: '수정 사유를 입력하세요.' });
      return;
    }
    if (alloc > 0 && Number(v.quantity) < alloc) {
      setError({ message: `매출로 전환된 수량(${fmt(alloc)})보다 적게 바꿀 수 없습니다.` });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await updatePurchase(row.id, { reason: reason.trim(), expected_updated_at: toIso(row.updated_at), changes });
      onDone(`매입 #${row.id}를 수정했습니다.`);
    } catch (er) {
      setError(er);
      if (er.code === 'STALE_DATA' || er.code === 'ALREADY_CANCELLED') onReload?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CorrectionModal title={`매입 #${row.id} 수정`} onClose={onClose} formId="tc-edit-purchase" saveLabel="저장" submitting={submitting} saveDisabled={changedCount === 0}>
      <form id="tc-edit-purchase" className="main-modal-form tc-form" onSubmit={submit}>
        <CorrectionAlert error={error} onGoSales={onGoSales} />
        {alloc > 0 && (
          <p className="tc-lock-note">매출 반영 {fmt(alloc)} — 수량은 {fmt(alloc)} 이상으로만 바꿀 수 있고, 상품은 바꿀 수 없습니다.</p>
        )}
        {paidAmt > 0 && (
          <p className="tc-lock-note">지급 {fmt(paidAmt)} — 매입처는 바꿀 수 없고, 금액(수량×단가)은 {fmt(paidAmt)} 이상으로만 바꿀 수 있습니다.</p>
        )}
        <div className="tc-grid">
          <label>
            상품
            <select value={v.product_id} onChange={set('product_id')} disabled={alloc > 0} title={alloc > 0 ? '매출로 전환된 매입은 상품을 바꿀 수 없습니다.' : undefined}>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            매입 거래처
            <select value={v.partner_id} onChange={set('partner_id')} disabled={paidAmt > 0} title={paidAmt > 0 ? '지급 기록이 있는 매입은 매입처를 바꿀 수 없습니다.' : undefined}>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            수량
            <input type="number" inputMode="decimal" min={alloc > 0 ? alloc : 0.001} step="any" value={v.quantity} onChange={set('quantity')} required />
          </label>
          <label>
            단가
            <input type="number" inputMode="decimal" min={0} step="any" value={v.unit_price} onChange={set('unit_price')} required />
          </label>
          <label>
            매입일
            <input type="date" value={v.purchase_date} onChange={set('purchase_date')} required />
          </label>
          <label>
            출처
            <input type="text" maxLength={200} value={v.source_name} onChange={set('source_name')} />
          </label>
          <label className="tc-grid-wide">
            메모
            <input type="text" value={v.memo} onChange={set('memo')} />
          </label>
          <label className="tc-grid-wide">
            <span>수정 사유 <span className="tc-required">(필수)</span></span>
            <input type="text" maxLength={200} value={reason} placeholder="예: 수량 오타" onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <p className="tc-hint">{changedCount === 0 ? '바꿀 값을 고치면 저장할 수 있습니다.' : `바뀐 칸 ${changedCount}개만 저장합니다. 총액은 수량×단가로 다시 계산됩니다.`}</p>
      </form>
    </CorrectionModal>
  );
}

// ---------------------------------------------------------------------------
// 수정 모달 — 매출 (수금·반품 여부에 따라 잠긴 칸, 3.2)
// ---------------------------------------------------------------------------
export function EditSaleModal({ row, partners, onClose, onDone, onReload }) {
  const paid = Number(row.paid_amount || 0) > 0;
  const refunded = Number(row.refunded_qty || 0) > 0 || row.status === 'refunded';
  const lockMoney = paid || refunded; // 수량·단가·판매처
  const lockDate = refunded; // 판매일
  const init = {
    quantity: String(Number(row.quantity)),
    unit_price: String(Number(row.unit_price)),
    partner_id: String(row.partner_id),
    sale_date: ymd(row.sale_date),
    memo: row.memo || '',
  };
  const [v, setV] = useState(init);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [creditWarn, setCreditWarn] = useState(null); // T-207 외상 한도 경고(서버 409 CREDIT_LIMIT)
  const set = (k) => (e) => {
    setCreditWarn(null); // 값을 고치면 이전 경고는 맞지 않는다
    setV((s) => ({ ...s, [k]: e.target.value }));
  };

  const changes = {};
  if (Number(v.quantity) !== Number(init.quantity)) changes.quantity = Number(v.quantity);
  if (Number(v.unit_price) !== Number(init.unit_price)) changes.unit_price = Number(v.unit_price);
  if (v.partner_id !== init.partner_id) changes.partner_id = Number(v.partner_id);
  if (v.sale_date !== init.sale_date) changes.sale_date = v.sale_date;
  if (v.memo.trim() !== init.memo.trim()) changes.memo = v.memo.trim();
  const changedCount = Object.keys(changes).length;

  const lockTip = refunded
    ? '반품 이력이 있는 매출은 메모만 고칠 수 있습니다.'
    : paid
      ? '수금이 있는 매출은 판매일·메모만 고칠 수 있습니다. 금액을 바꾸려면 반품(환불)으로 처리하세요.'
      : '';

  const submit = (e) => {
    e.preventDefault();
    save(false);
  };
  /** confirmed=true 는 외상 한도 경고를 보고 「한도 넘어도 저장」을 누른 경우(T-207) */
  const save = async (confirmed) => {
    if (!reason.trim()) {
      setError({ message: '수정 사유를 입력하세요.' });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await updateSale(row.id, {
        reason: reason.trim(),
        expected_updated_at: toIso(row.updated_at),
        changes,
        ...(confirmed ? { credit_confirmed: true } : {}),
      });
      const over = res?.credit_warnings?.length ? ` 외상 한도를 넘겨 저장했습니다 — ${res.credit_warnings.map(creditLine).join(' · ')}` : '';
      onDone(`매출 #${row.id}를 수정했습니다.${over}`);
    } catch (er) {
      const cw = creditWarningsOf(er);
      if (cw) {
        setCreditWarn(cw);
        return;
      }
      setError(er);
      if (er.code === 'STALE_DATA' || er.code === 'ALREADY_CANCELLED') onReload?.();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <CorrectionModal title={`매출 #${row.id} 수정`} onClose={onClose} formId="tc-edit-sale" saveLabel="저장" submitting={submitting} saveDisabled={changedCount === 0}>
      <form id="tc-edit-sale" className="main-modal-form tc-form" onSubmit={submit}>
        <CreditLimitWarning warnings={creditWarn} busy={submitting} onConfirm={() => save(true)} onCancel={() => setCreditWarn(null)} />
        <CorrectionAlert error={error} />
        {lockTip && <p className="tc-lock-note">{lockTip}</p>}
        <div className="tc-grid">
          <label>
            상품
            <input type="text" value={row.product_name || ''} disabled title="매출의 상품은 바꿀 수 없습니다. 매출을 취소한 뒤 다시 전환하세요." />
          </label>
          <label>
            판매처
            <select value={v.partner_id} onChange={set('partner_id')} disabled={lockMoney} title={lockMoney ? lockTip : undefined}>
              {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            수량
            <input type="number" inputMode="decimal" min={0.001} step="any" value={v.quantity} onChange={set('quantity')} disabled={lockMoney} title={lockMoney ? lockTip : undefined} required />
          </label>
          <label>
            단가
            <input type="number" inputMode="decimal" min={0} step="any" value={v.unit_price} onChange={set('unit_price')} disabled={lockMoney} title={lockMoney ? lockTip : undefined} required />
          </label>
          <label>
            판매일
            <input type="date" value={v.sale_date} onChange={set('sale_date')} disabled={lockDate} title={lockDate ? lockTip : undefined} required />
          </label>
          <label>
            메모
            <input type="text" value={v.memo} onChange={set('memo')} />
          </label>
          <label className="tc-grid-wide">
            <span>수정 사유 <span className="tc-required">(필수)</span></span>
            <input type="text" maxLength={200} value={reason} placeholder="예: 단가 오입력" onChange={(e) => setReason(e.target.value)} />
          </label>
        </div>
        <p className="tc-hint">
          {changedCount === 0 ? '바꿀 값을 고치면 저장할 수 있습니다.' : `바뀐 칸 ${changedCount}개만 저장합니다. 수량을 바꾸면 재고·매입 잔여도 같이 맞춥니다.`}
        </p>
      </form>
    </CorrectionModal>
  );
}

/** 상단 알림(성공) — 몇 초 뒤 사라짐 */
export function CorrectionNotice({ text, onClear }) {
  useEffect(() => {
    if (!text) return undefined;
    const t = setTimeout(onClear, 4000);
    return () => clearTimeout(t);
  }, [text, onClear]);
  if (!text) return null;
  return (
    <div className="tc-notice" role="status">
      {text}
    </div>
  );
}
