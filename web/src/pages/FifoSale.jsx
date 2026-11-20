// 재고에서 바로 판매(선입선출) — T-205 W-05 (설계: T-205_FIFO_설계.md 6장)
// - 재고현황 행의 "판매" 버튼 → 이 모달. 판매처·수량·단가·판매일만 넣으면 서버가 오래된 매입부터 배분한다.
// - 입력이 바뀌면 300ms 뒤 미리보기(GET /api/inventory/:id/fifo-preview)를 다시 불러 배분·원가·이익을 보여 준다(저장 없음).
// - 판매 가능 수량을 넘으면 저장 비활성 + "최대 n까지" + [n으로 채우기]. 원가보다 낮은 단가는 경고만(저장 가능, U-3).
// Main.jsx 병행 작업과 겹치지 않게 별도 파일로 둔다(API 호출도 이 파일 안에서).
import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, getToken, fetchPartners } from '../api';
import CreditLimitWarning, { creditWarningsOf, creditLine } from '../components/CreditLimitWarning';
import './FifoSale.css';

const SALE_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);

const fmt = (n) => {
  if (n == null || n === '') return '—';
  const x = Number(n);
  return Number.isNaN(x) ? String(n) : x.toLocaleString('ko-KR');
};
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const mmdd = (ymd) => (ymd && ymd.length >= 10 ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : ymd || '');

class FifoError extends Error {
  constructor(status, body) {
    super(body?.message || '처리에 실패했습니다.');
    this.status = status;
    this.code = body?.code || null;
    this.detail = body?.detail || null;
  }
}

async function fifoRequest(method, path, body) {
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
  if (!res.ok) throw new FifoError(res.status, data);
  return data;
}

export const fetchFifoPreview = (productId, params) =>
  fifoRequest('GET', `/inventory/${productId}/fifo-preview?${new URLSearchParams(params).toString()}`).then((d) => d.data);
export const createFifoSale = (body) => fifoRequest('POST', '/sales', body).then((d) => d.data);

/** 재고현황 행의 판매 버튼 — 판매 가능 0 이면 비활성 + 이유 */
export function FifoSellButton({ row, onClick }) {
  const sellable = Number(row.sellable_qty || 0);
  const unlinked = Number(row.unlinked_qty || 0);
  const disabled = !(sellable > 0);
  const why = disabled
    ? unlinked > 0
      ? `반품으로 들어온 ${fmt(unlinked)}은(는) 매입과 연결이 없어 자동 판매할 수 없습니다.`
      : '판매할 수 있는 재고가 없습니다.'
    : `${row.product_name} 판매 — 오래된 매입부터 나갑니다`;
  return (
    <button
      type="button"
      className="main-btn main-btn--secondary fifo-sell-btn"
      onClick={() => onClick(row)}
      disabled={disabled}
      title={why}
      aria-label={disabled ? `${row.product_name} 판매 불가: ${why}` : `${row.product_name} 판매`}
    >
      판매
    </button>
  );
}

/** "판매 가능" 칸 — 재고와 같으면 그대로, 다르면 값 + 이유 툴팁 */
export function SellableCell({ row }) {
  const sellable = Number(row.sellable_qty || 0);
  const qty = Number(row.quantity || 0);
  const unlinked = Number(row.unlinked_qty || 0);
  if (Math.abs(sellable - qty) < 0.0005) return <span>{fmt(sellable)}</span>;
  const tip = unlinked > 0
    ? `반품으로 들어온 ${fmt(unlinked)}은(는) 매입과 연결이 없어 자동 판매에서 빠집니다.`
    : '오늘 이후 날짜로 등록한 매입은 오늘 판매에 쓰지 않습니다.';
  return (
    <span className="fifo-sellable-diff" title={tip}>
      {fmt(sellable)}
      <span className="fifo-sellable-note">{unlinked > 0 ? `미연결 ${fmt(unlinked)}` : '날짜 제한'}</span>
    </span>
  );
}

/**
 * 판매 모달. props: row(재고현황 행), onClose, onDone(message, result)
 */
export function FifoSaleModal({ row, onClose, onDone }) {
  const [partners, setPartners] = useState([]);
  const [partnerId, setPartnerId] = useState('');
  const [saleDate, setSaleDate] = useState(kstToday());
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [memo, setMemo] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(null); // 저장 결과(이어서 판매용)
  const [creditWarn, setCreditWarn] = useState(null); // T-207 외상 한도 경고(서버 409 CREDIT_LIMIT)
  const [stock, setStock] = useState(null); // 저장 뒤 다시 읽은 재고·판매 가능 { inventory_qty, sellable_qty }
  const seq = useRef(0);
  const qtyRef = useRef(null);

  useEffect(() => {
    fetchPartners()
      .then((list) => setPartners((list || []).filter((p) => SALE_TYPES.has(p.type))))
      .catch(() => setPartners([]));
  }, []);

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

  // 미리보기: 입력이 멈추고 300ms 뒤. 늦게 온 이전 응답은 버린다
  const loadPreview = useCallback(() => {
    const q = Number(quantity);
    const my = ++seq.current;
    if (!(q > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) {
      setPreview(null);
      setPreviewErr('');
      return;
    }
    setPreviewLoading(true);
    fetchFifoPreview(row.product_id, { quantity: String(quantity), unit_price: unitPrice === '' ? '0' : String(unitPrice), sale_date: saleDate })
      .then((d) => {
        if (seq.current !== my) return;
        setPreview(d);
        setPreviewErr('');
      })
      .catch((e) => {
        if (seq.current !== my) return;
        setPreview(null);
        setPreviewErr(e.message);
      })
      .finally(() => {
        if (seq.current === my) setPreviewLoading(false);
      });
  }, [quantity, unitPrice, saleDate, row.product_id]);

  useEffect(() => {
    const t = setTimeout(loadPreview, 300);
    return () => clearTimeout(t);
  }, [loadPreview]);

  const sellable = preview ? preview.sellable_qty : stock ? stock.sellable_qty : Number(row.sellable_qty || 0);
  const invQty = preview ? preview.inventory_qty : stock ? stock.inventory_qty : row.quantity;
  const qtyNum = Number(quantity);
  const over = qtyNum > 0 && preview && !preview.enough;
  const priceOk = unitPrice !== '' && Number(unitPrice) >= 0;
  const canSave = !!partnerId && qtyNum > 0 && priceOk && preview && preview.enough && !previewLoading && !submitting;
  const saleAmount = qtyNum > 0 && priceOk ? Math.round(qtyNum * Number(unitPrice) * 100) / 100 : null;

  const fillMax = () => {
    setQuantity(String(sellable));
    qtyRef.current?.focus();
  };

  // 판매처·수량·단가·판매일을 고치면 이전 한도 경고는 맞지 않으므로 지운다
  useEffect(() => setCreditWarn(null), [partnerId, quantity, unitPrice, saleDate]);

  const submit = (e) => {
    e.preventDefault();
    save(false);
  };
  /** confirmed=true 는 외상 한도 경고를 보고 「한도 넘어도 저장」을 누른 경우(T-207) */
  const save = async (confirmed) => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fifoRequest('POST', '/sales', {
        partner_id: Number(partnerId),
        sale_date: saleDate,
        memo: memo.trim() || undefined,
        items: [{ product_id: row.product_id, quantity: String(quantity), unit_price: String(unitPrice) }],
        ...(confirmed ? { credit_confirmed: true } : {}),
      }).then((d) => ({ ...d.data, credit_warnings: d.credit_warnings }));
      const s = { ...res.sales[0], credit_warnings: res.credit_warnings || null };
      setCreditWarn(null);
      setDone(s);
      setPreview(null);
      // 머리말의 재고·판매 가능을 저장 뒤 값으로(이어서 판매할 때 최대치도 이 값)
      fetchFifoPreview(row.product_id, { quantity: '0.001', unit_price: '0', sale_date: saleDate })
        .then((d) => setStock({ inventory_qty: d.inventory_qty, sellable_qty: d.sellable_qty }))
        .catch(() => setStock(null));
      onDone?.(`${row.product_name} ${fmt(s.quantity)}${row.unit ? ' ' + row.unit : ''} 판매 저장(매출 #${s.sale_id})`, res);
    } catch (er) {
      const cw = creditWarningsOf(er);
      if (cw) {
        setCreditWarn(cw);
        return;
      }
      setError(er);
      if (er.code === 'STOCK_SHORT') loadPreview();
    } finally {
      setSubmitting(false);
    }
  };

  const continueSelling = () => {
    setDone(null);
    setQuantity('');
    setMemo('');
    setError(null);
    setPreview(null);
    setTimeout(() => qtyRef.current?.focus(), 0);
  };

  const title = `${row.product_name} 판매`;
  return (
    <div className="main-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !submitting && onClose()}>
      <div className="main-modal tc-modal fifo-modal" role="dialog" aria-modal="true" aria-labelledby="fifo-modal-title">
        <div className="main-modal-header fifo-modal-header">
          <h2 id="fifo-modal-title">{title}</h2>
          <p className="fifo-stock-line" aria-live="polite">
            재고 {fmt(invQty)} · 판매 가능 <strong>{fmt(sellable)}</strong>
            {row.unit ? ` ${row.unit}` : ''}
          </p>
        </div>
        <div className="main-modal-body">
          {done ? (
            <div className="fifo-done" role="status">
              <p className="fifo-done-title">
                {row.product_name} {fmt(done.quantity)}{row.unit ? ` ${row.unit}` : ''} 판매를 저장했습니다 (매출 #{done.sale_id})
              </p>
              <p className="fifo-done-sub">
                매출 {fmt(done.total_amount)}원 · 원가 {fmt(done.cost)}원 · 이익 {fmt(done.profit)}원
                {done.margin_pct != null ? ` (${done.margin_pct}%)` : ''}
              </p>
              {done.credit_warnings && (
                <p className="credit-saved-note">외상 한도를 넘겨 저장했습니다 — {done.credit_warnings.map(creditLine).join(' · ')}</p>
              )}
              <p className="fifo-hint">거래명세서는 매출정보 탭 또는 거래처 탭에서 볼 수 있습니다.</p>
            </div>
          ) : (
            <form id="fifo-sale-form" className="main-modal-form tc-form fifo-form" onSubmit={submit}>
              <CreditLimitWarning warnings={creditWarn} busy={submitting} onConfirm={() => save(true)} onCancel={() => setCreditWarn(null)} />
              {error && (
                <div className="main-alert-banner tc-alert" role="alert">
                  <p className="tc-alert-msg">{error.message}</p>
                </div>
              )}
              <div className="tc-grid fifo-grid">
                <label>
                  판매처
                  <select required value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                    <option value="">선택</option>
                    {partners.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  판매일
                  <input type="date" required value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
                </label>
                <label>
                  수량{row.unit ? ` (${row.unit})` : ''}
                  <input
                    ref={qtyRef}
                    type="number"
                    inputMode="decimal"
                    min={0.001}
                    step="any"
                    required
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    aria-invalid={over ? 'true' : undefined}
                    aria-describedby="fifo-qty-msg"
                  />
                </label>
                <label>
                  단가(원)
                  <input type="number" inputMode="decimal" min={0} step="any" required value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
                </label>
                <label className="tc-grid-wide">
                  메모
                  <input type="text" maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 오전 주문" />
                </label>
              </div>

              <div id="fifo-qty-msg" aria-live="polite">
                {over && (
                  <div className="fifo-over" role="alert">
                    <span>최대 {fmt(sellable)}까지 팔 수 있습니다.</span>
                    {sellable > 0 && (
                      <button type="button" className="main-btn main-btn--secondary fifo-fill-btn" onClick={fillMax}>
                        {fmt(sellable)}(으)로 채우기
                      </button>
                    )}
                    {preview && preview.unlinked_qty > 0 && (
                      <p className="fifo-hint">반품으로 들어온 {fmt(preview.unlinked_qty)}은(는) 매입과 연결이 없어 자동 판매에서 빠집니다.</p>
                    )}
                  </div>
                )}
              </div>

              <section className="fifo-preview" aria-label="배분 미리보기">
                <div className="fifo-preview-head">
                  <span>오래된 매입부터 나갑니다</span>
                  {saleAmount != null && <span className="fifo-amount">매출액 {fmt(saleAmount)}원</span>}
                </div>
                {previewErr && <p className="main-error">{previewErr}</p>}
                {!preview && !previewErr && <p className="fifo-hint">수량을 넣으면 어느 매입에서 나가는지 보여 줍니다.</p>}
                {preview && preview.allocations.length > 0 && (
                  <ul className="fifo-lots">
                    {preview.allocations.map((a) => (
                      <li key={a.purchase_id}>
                        <span className="fifo-lot-name">
                          {mmdd(a.purchase_date)} {a.partner_name || '매입'}{a.source_name ? `(${a.source_name})` : ''}
                        </span>
                        <span className="fifo-lot-calc num">
                          {fmt(a.quantity)} × {fmt(a.unit_cost)} = {fmt(a.cost)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {preview && preview.allocations.length === 0 && <p className="fifo-hint">이 판매일에 쓸 수 있는 매입이 없습니다.</p>}
                {preview && preview.enough && priceOk && (
                  <p className="fifo-money">
                    원가 {fmt(preview.cost)} · 이익 <strong className={preview.profit < 0 ? 'fifo-loss' : undefined}>{fmt(preview.profit)}</strong>
                    {preview.margin_pct != null ? ` (${preview.margin_pct}%)` : ''}
                  </p>
                )}
                {preview && preview.enough && priceOk && preview.below_cost && (
                  <p className="fifo-warn" role="status">원가({fmt(preview.avg_cost)})보다 낮은 단가입니다. 저장은 할 수 있습니다.</p>
                )}
                {previewLoading && <p className="fifo-hint">계산 중…</p>}
              </section>
            </form>
          )}
        </div>
        <div className="main-modal-footer">
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={submitting}>
            {done ? '닫기' : '취소'}
          </button>
          {done ? (
            <button type="button" className="main-modal-btn primary" onClick={continueSelling}>
              이어서 판매
            </button>
          ) : (
            <button type="submit" form="fifo-sale-form" className="main-modal-btn primary" disabled={!canSave}>
              {submitting ? '저장 중…' : '판매 저장'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
