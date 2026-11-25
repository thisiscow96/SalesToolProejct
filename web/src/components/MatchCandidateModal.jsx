// T-203 ④ 후보 창·수동 확정(R-122·R-128) · 줄 수정(R-126) · 사유 입력(매입 아님 R-129·전환 취소 R-130·매입서 취소 R-131)
// 잠금(T-404): 확정 요청 중 창 닫기·라디오 변경 잠금(guardClose), 확정 버튼 1회. 확정은 클릭 하나에 Idempotency-Key 하나
import { useCallback, useEffect, useId, useState } from 'react';
import { fetchProducts } from '../api';
import { purchaseDocApi } from '../lib/purchaseDocApi';
import { productOptionLabel } from '../pages/ProductRequest';
import { can } from '../lib/staffAccess';
import { newIdempotencyKey, withIdempotency } from '../lib/idempotency';
import { ErrorLine, MatchModal, Tone } from './MatchBits';
import { GRADE_LABEL, MODE_LABEL, dec, fieldErrors, kstTime, md, normLine, reasonText, won } from '../lib/matchLabels';

const OUTSIDE = new Set(['PRICE_OUT', 'QTY_OUT', 'GRADE_DIFF', 'UNIT_CONVERTED', 'WEIGHT_UNKNOWN', 'CORP_MISMATCH']);

/** 후보 행 모양 맞추기 — 경락 칸이 바로 있거나 trade 안에 있거나 */
function normCand(c) {
  const t = c.trade || c;
  const flags = c.flags || [];
  const strict = typeof c.strict === 'boolean' ? c.strict : typeof c.within_tolerance === 'boolean' ? c.within_tolerance : !flags.some((f) => OUTSIDE.has(f));
  return { ...c, t, trade_id: c.trade_id ?? t.id, flags, strict, diff: c.diff || {} };
}

function diffText(d = {}) {
  const parts = [];
  if (d.price != null && Number(d.price) !== 0) parts.push(`단가 ${Number(d.price) > 0 ? '+' : ''}${won(d.price)}원${d.price_pct != null ? `(${Number(d.price_pct) > 0 ? '+' : ''}${dec(d.price_pct, 2)}%)` : ''}`);
  if (d.qty != null && Number(d.qty) !== 0) parts.push(`수량 ${Number(d.qty) > 0 ? '+' : ''}${dec(d.qty)}`);
  if (d.amount != null && Number(d.amount) !== 0) parts.push(`금액 ${Number(d.amount) > 0 ? '+' : ''}${won(d.amount)}원`);
  if (d.days != null && Number(d.days) !== 0) parts.push(`날짜 ${d.days}일`);
  return parts.join(' · ') || '없음';
}

export function lineTitle(l) {
  const n = normLine(l);
  return `${n.item_name} ${n.grade || ''} ${n.spec || ''} ${dec(n.qty)} × ${won(n.unit_price)}원`.replace(/\s+/g, ' ').trim();
}

/**
 * 후보 창. line 은 화면에 있는 줄(version 포함). onDone(result) — 확정 성공, onLine(newLine) — 최신 줄로 바뀜
 */
export function MatchCandidateModal({ line, onClose, onDone, onLine }) {
  const l = normLine(line);
  const canConfirm = can('purchase_doc.confirm');
  const [cands, setCands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [pick, setPick] = useState(null); // trade_id | 'NONE'
  const [accept, setAccept] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [serverDiff, setServerDiff] = useState(null);
  const [version, setVersion] = useState(l.version);
  const reasonId = useId();
  const productSelId = useId();
  // C D02: 품목 연결이 없는 줄도 끝낼 수 있게 판매툴 품목을 고르는 칸(R-128 본문 product_id). '' = 줄·품목 연결대로
  const [products, setProducts] = useState(null);
  const [productId, setProductId] = useState(l.product_id ? String(l.product_id) : '');

  const load = useCallback(async () => {
    setLoading(true);
    setLoadErr(null);
    try {
      const r = await purchaseDocApi.candidates(l.id);
      const list = (r.data?.candidates || r.data || []).map(normCand);
      setCands(list);
      setPick((p) => p ?? (list[0] ? list[0].trade_id : 'NONE'));
    } catch (e) {
      setLoadErr(e);
    } finally {
      setLoading(false);
    }
  }, [l.id]);
  useEffect(() => {
    load();
  }, [load]);

  const showProduct = canConfirm && l.status !== 'CONVERTED' && (pick === 'NONE' || err?.code === 'NO_PRODUCT_LINK' || !!productId && productId !== String(l.product_id ?? ''));
  useEffect(() => {
    if (!showProduct || products) return;
    fetchProducts().then((p) => setProducts(p || [])).catch(() => setProducts([]));
  }, [showProduct, products]);

  const chosen = cands.find((c) => c.trade_id === pick) || null;
  const needAccept = pick === 'NONE' || (chosen && !chosen.strict) || !!serverDiff;
  const needReason = needAccept;
  const ready = !busy && pick != null && (!needAccept || accept) && (!needReason || reason.trim().length >= 2);

  const confirm = async () => {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    const body = {
      ...(pick !== 'NONE' ? { trade_id: pick } : {}),
      version,
      accept_diff: needAccept ? accept : false,
      ...(reason.trim() ? { reason: reason.trim() } : {}),
      ...(productId && productId !== String(l.product_id ?? '') ? { product_id: Number(productId) } : {}),
    };
    try {
      const r = await withIdempotency((key) => purchaseDocApi.confirm(l.id, body, key), newIdempotencyKey('cf'));
      onDone?.(r.data || {});
    } catch (e) {
      if (e.code === 'DIFF_NOT_ACCEPTED') setServerDiff(e.detail?.diff || {});
      if (e.code === 'VERSION_CONFLICT' && e.detail?.line) {
        setVersion(e.detail.line.version);
        onLine?.(e.detail.line);
      }
      if (e.code === 'TRADE_TAKEN') load();
      if (e.code === 'NO_PRODUCT_LINK') {
        // 서버 문구의 "product_id 지정"은 화면 말이 아니라서 바꿔 보여 준다
        setErr(Object.assign(e, { message: '판매툴 품목 연결이 없습니다. 위 "판매툴 품목"에서 고르거나 대조 설정 → 품목 연결에서 연결하세요.' }));
        return;
      }
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <MatchModal
      title="후보"
      sub={`${lineTitle(l)} (${md(l.trade_date)}${l.supplier_name ? `, ${l.supplier_name}` : ''})`}
      busy={busy}
      onClose={onClose}
      testid="pdoc-cand-modal"
      labelId="pdoc-cand-title"
      footer={
        <>
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={busy} data-testid="pdoc-cand-close">닫기</button>
          {canConfirm && l.status !== 'CONVERTED' && (
            <button type="button" className="main-modal-btn primary" onClick={confirm} disabled={!ready} aria-busy={busy} data-testid="pdoc-cand-confirm">
              {busy ? '등록 중…' : pick === 'NONE' ? '경락 근거 없이 매입 등록' : '이 건으로 매입 등록'}
            </button>
          )}
        </>
      }
    >
      {l.reason_codes.length > 0 && (
        <p className="pm-muted">사유: {l.reason_codes.map(reasonText).join(' · ')}</p>
      )}
      <ErrorLine error={loadErr} />
      {loading && <p className="main-loading">후보를 불러오는 중…</p>}
      {!loading && cands.length === 0 && !loadErr && <p className="pm-muted">후보 범위 안에 경락이 없습니다.</p>}
      <fieldset className="pm-cands" disabled={busy || !canConfirm || l.status === 'CONVERTED'} data-testid="pdoc-cand-list">
        <legend className="pm-sr">매입 근거로 쓸 경락 건</legend>
        {cands.map((c, i) => (
          <label key={c.trade_id} className={'pm-cand' + (pick === c.trade_id ? ' on' : '')} data-testid={`pdoc-cand-${c.trade_id}`}>
            <input type="radio" name="pm-cand" checked={pick === c.trade_id} onChange={() => { setPick(c.trade_id); setAccept(false); setServerDiff(null); }} />
            <span className="pm-cand-main">
              <b>{i + 1}위 #{c.trade_id}</b> {md(c.t.trade_date)} {kstTime(c.t.auction_at, false)} {c.t.corp_name || ''} {c.t.item_label ? c.t.item_label.split('·').pop().trim() : c.t.item_name_raw}{' '}
              {c.t.grade_name || GRADE_LABEL[c.t.grade_norm] || ''} {c.t.unit_qty_kg ? `${dec(c.t.unit_qty_kg)}kg` : ''} {c.t.pkg_name || ''} {dec(c.t.qty)} × {won(c.t.unit_price)}원
            </span>
            <span className="pm-cand-side">
              <Tone tone={c.strict ? 'ok' : 'warn'}>점수 {c.score ?? '-'}</Tone>
              {c.strict ? <Tone tone="ok">허용오차 안</Tone> : <Tone tone="warn">허용 밖</Tone>}
            </span>
            <span className="pm-cand-sub">
              차이: {diffText(c.diff)}
              {c.flags.length > 0 && ` · ${c.flags.map(reasonText).join(', ')}`}
              {c.taken_by && <span className="pm-bad-text"> · 다른 줄이 사용 중({c.taken_by})</span>}
            </span>
          </label>
        ))}
        <label className={'pm-cand' + (pick === 'NONE' ? ' on' : '')} data-testid="pdoc-cand-none">
          <input type="radio" name="pm-cand" checked={pick === 'NONE'} onChange={() => { setPick('NONE'); setAccept(false); setServerDiff(null); }} />
          <span className="pm-cand-main">경락 근거 없이 등록(장외 거래 등) — 사유 필수</span>
        </label>
      </fieldset>

      {canConfirm && l.status !== 'CONVERTED' ? (
        <div className="pm-confirm-box">
          {needAccept && (
            <label className="main-filter-checkbox" data-testid="pdoc-cand-accept-wrap">
              <input type="checkbox" checked={accept} disabled={busy} onChange={(e) => setAccept(e.target.checked)} data-testid="pdoc-cand-accept" />
              차이를 확인했습니다{serverDiff ? ` (${diffText(serverDiff)})` : chosen ? ` (${diffText(chosen.diff)})` : ''}
            </label>
          )}
          {showProduct && (
            <label htmlFor={productSelId} className="pm-reason" data-testid="pdoc-cand-product-wrap">
              판매툴 품목{err?.code === 'NO_PRODUCT_LINK' ? '(필수 — 품목 연결이 없는 줄)' : '(선택 — 비우면 품목 연결대로)'}
              <select id={productSelId} value={productId} disabled={busy || products === null} onChange={(e) => { setProductId(e.target.value); if (err?.code === 'NO_PRODUCT_LINK') setErr(null); }}
                aria-invalid={err?.code === 'NO_PRODUCT_LINK' || undefined} data-testid="pdoc-cand-product">
                <option value="">{products === null ? '품목을 불러오는 중…' : '품목 연결대로'}</option>
                {(products || []).map((p) => <option key={p.id} value={p.id}>{productOptionLabel(p)}{p.unit ? ` (${p.unit})` : ''}</option>)}
              </select>
            </label>
          )}
          <label htmlFor={reasonId} className="pm-reason">
            사유{needReason ? '(필수, 2자 이상)' : '(선택)'}
            <input id={reasonId} value={reason} maxLength={200} disabled={busy} placeholder="예: 법인 정산서 단가 정정분 확인(전화)" onChange={(e) => setReason(e.target.value)} data-testid="pdoc-cand-reason" />
          </label>
          <p className="pm-muted">
            {needAccept ? `허용오차 밖·근거 없음 → ${MODE_LABEL.FORCED}으로 남습니다(차액 기록).` : `허용오차 안 → ${MODE_LABEL.MANUAL}으로 남습니다.`}
          </p>
        </div>
      ) : (
        <p className="pm-notice" data-testid="pdoc-cand-owner-only">수동 확정은 중매인(주인) 확인이 필요합니다.</p>
      )}
      <ErrorLine error={err} testid="pdoc-cand-error" />
    </MatchModal>
  );
}

/** 줄 수정(R-126) — version 을 보내고, 409 VERSION_CONFLICT 면 최신 줄로 다시 채운다 */
export function LineEditModal({ line, onClose, onSaved }) {
  const init = normLine(line);
  const [f, setF] = useState(() => ({
    trade_date: init.trade_date || '',
    item_name: init.item_name || '',
    grade: init.grade || '',
    spec: init.spec || '',
    qty: init.qty ?? '',
    unit_price: init.unit_price ?? '',
    amount: init.amount ?? '',
    origin: init.origin_name || init.origin || '',
  }));
  const [version, setVersion] = useState(init.version);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const fe = fieldErrors(err);
  const num = (v) => (String(v).trim() === '' ? null : Number(String(v).replace(/,/g, '')));

  const save = async () => {
    if (busy) return;
    const price = num(f.unit_price);
    if (!(Number.isInteger(price) && price > 0)) return setErr({ field: 'unit_price', message: '단가는 원 단위 정수로 입력하세요.' });
    if (!(num(f.qty) > 0)) return setErr({ field: 'qty', message: '수량은 0보다 커야 합니다.' });
    setBusy(true);
    setErr(null);
    try {
      const r = await purchaseDocApi.updateLine(init.id, {
        version,
        trade_date: f.trade_date,
        item_name: f.item_name.trim(),
        grade: f.grade.trim(),
        spec: f.spec.trim(),
        qty: num(f.qty),
        unit_price: price,
        ...(num(f.amount) !== null ? { amount: num(f.amount) } : {}),
        origin: f.origin.trim(),
      });
      onSaved?.(r.data || {});
    } catch (e) {
      if (e.code === 'VERSION_CONFLICT' && e.detail?.line) {
        const n = normLine(e.detail.line);
        setVersion(n.version);
        setF({ trade_date: n.trade_date || '', item_name: n.item_name, grade: n.grade || '', spec: n.spec || '', qty: n.qty ?? '', unit_price: n.unit_price ?? '', amount: n.amount ?? '', origin: n.origin_name || '' });
      }
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const fld = (k, label, props = {}) => (
    <label>
      {label}
      <input value={f[k]} disabled={busy} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`pdoc-edit-${k}`} {...props} />
      {fe[k] && <span className="pm-field-err">{fe[k]}</span>}
    </label>
  );
  return (
    <MatchModal
      title={`줄 수정 — ${init.line_no}줄`}
      sub="고치면 대조 결과를 지우고 바로 다시 대조합니다."
      busy={busy}
      onClose={onClose}
      wide={false}
      testid="pdoc-edit-modal"
      labelId="pdoc-edit-title"
      footer={
        <>
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={busy}>닫기</button>
          <button type="button" className="main-modal-btn primary" onClick={save} disabled={busy} aria-busy={busy} data-testid="pdoc-edit-save">{busy ? '저장 중…' : '저장하고 다시 대조'}</button>
        </>
      }
    >
      <fieldset className="pm-form-grid" disabled={busy}>
        {fld('trade_date', '거래일', { type: 'date' })}
        {fld('item_name', '품목', { maxLength: 100 })}
        {fld('grade', '등급', { maxLength: 30 })}
        {fld('spec', '규격', { maxLength: 50, placeholder: '10kg 상자' })}
        {fld('qty', '수량', { inputMode: 'decimal' })}
        {fld('unit_price', '단가(원)', { inputMode: 'numeric' })}
        {fld('amount', '금액(선택)', { inputMode: 'numeric' })}
        {fld('origin', '산지', { maxLength: 50 })}
      </fieldset>
      {err?.code === 'VERSION_CONFLICT' && <p className="pm-notice">다른 사람이 먼저 바꾼 최신 값으로 다시 채웠습니다. 확인하고 다시 저장하세요.</p>}
      <ErrorLine error={err} testid="pdoc-edit-error" />
    </MatchModal>
  );
}

/** 사유를 받아 요청을 보내는 작은 창 — window.prompt 대신(브라우저 대화상자 금지) */
export function ReasonModal({ title, sub, confirmLabel, placeholder, onSubmit, onClose, testid, danger }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const id = useId();
  const ok = reason.trim().length >= 2 && !busy;
  const go = async () => {
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(reason.trim());
    } catch (e) {
      setErr(e);
      setBusy(false);
      return;
    }
    setBusy(false);
  };
  return (
    <MatchModal
      title={title}
      sub={sub}
      busy={busy}
      onClose={onClose}
      wide={false}
      testid={testid}
      labelId={`${testid}-title`}
      footer={
        <>
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={busy}>닫기</button>
          <button type="button" className={'main-modal-btn primary' + (danger ? ' pm-danger' : '')} onClick={go} disabled={!ok} aria-busy={busy} data-testid={`${testid}-submit`}>{busy ? '처리 중…' : confirmLabel}</button>
        </>
      }
    >
      <label htmlFor={id} className="pm-reason">
        사유(2자 이상)
        <input id={id} value={reason} maxLength={200} disabled={busy} placeholder={placeholder} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} data-testid={`${testid}-reason`} autoFocus />
      </label>
      <ErrorLine error={err} testid={`${testid}-error`} />
      {Array.isArray(err?.detail?.sales) && err.detail.sales.length > 0 && (
        <p className="pm-muted">연결된 매출: {err.detail.sales.map((s) => `#${s.id ?? s}`).join(', ')} — 매출을 먼저 취소하세요.</p>
      )}
      {Array.isArray(err?.detail?.lines) && err.detail.lines.length > 0 && (
        <p className="pm-muted">매입 등록된 줄: {err.detail.lines.map((x) => `${x.line_no ?? x}줄`).join(', ')} — 줄의 전환을 먼저 취소하세요.</p>
      )}
    </MatchModal>
  );
}
