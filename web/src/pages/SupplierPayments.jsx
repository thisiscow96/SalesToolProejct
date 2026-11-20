// 매입처 지급(미지급금) 화면 — T-201 W-09·W-10 (설계: T-201_지급_설계.md 6장)
// - SupplierPaymentModal : 매입정보 탭의 「지급 등록」 — 매입처를 고르면 미지급 매입(오래된 순)이 뜨고,
//                          지급액을 넣으면 오래된 매입부터 자동으로 채운다(사람이 행별로 고칠 수 있음).
//                          배분 합 ≠ 지급액이면 저장 비활성.
// - TabSupplierPayments  : 새 탭 「지급정보」 — 기간·매입처 검색, 목록, CSV, 행별 취소(사유), 「기초 정리」
// 금액 판정의 최종은 서버(DB NUMERIC). 화면은 원 단위 정수(센트)로만 미리 계산해 버튼을 막는다.
// Main.jsx 병행 작업(T-216)과 겹치지 않게 별도 파일로 둔다(API 호출은 lib/payablesApi.js).
import { useEffect, useMemo, useState } from 'react';
import { fetchPartners } from '../api';
import { kstNowLocalInput, kstParts, kstTodayYmd } from '../lib/dates';
import { downloadListCsv } from '../lib/csvLists';
import {
  createSupplierPayment,
  fetchSupplierPayments,
  cancelSupplierPayment,
  fetchUnpaidPurchases,
  PAY_METHOD_OPTIONS,
  PAY_METHOD_LABEL,
  PAYMENT_STATUS_LABEL,
} from '../lib/payablesApi';
import { won } from './PartnerLedger';
import { can } from '../lib/staffAccess';
import './SupplierPayments.css';

/** 매입 가능한 거래처 유형 — 서버 PURCHASE_PARTNER_TYPES 와 같음 */
export const PAYABLE_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer']); // T-401 producer

const toCents = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
};
const fromCents = (c) => c / 100;
const centsStr = (c) => String(fromCents(c));
const ymdOf = (v) => {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return kstParts(v)?.ymd || s.slice(0, 10);
};
const dateTimeText = (ts) => {
  const p = kstParts(ts);
  return p ? `${p.ymd} ${p.hm}` : '—';
};
const firstDayOfMonthKst = () => `${kstTodayYmd().slice(0, 7)}-01`;

/** 지급 종류 표시 (T-401: 매입 할인·상계 추가) */
const KIND_TEXT = { pay: '지급', opening: '기초 정리', discount: '매입 할인', offset: '상계' };
const KIND_CLASS = { pay: 'main-status--entry-receive', opening: 'main-status--pay-partial', discount: 'main-status--entry-discount', offset: 'main-status--entry-offset' };

/** 매입 목록의 지급 상태 배지 (매출의 수금 배지와 같은 색) */
export function PurchasePayBadge({ row }) {
  if (row.status === 'cancelled' || !row.payment_status) return <span className="sp-muted">—</span>;
  return <span className={`main-status main-status--pay-${row.payment_status}`}>{PAYMENT_STATUS_LABEL[row.payment_status] || row.payment_status}</span>;
}

/** 오래된 매입부터 지급액을 채운다. onlyIds 가 있으면 그 매입만 */
function autoFill(rows, amountCents, onlyIds) {
  let left = Number.isFinite(amountCents) && amountCents > 0 ? amountCents : 0;
  const out = {};
  for (const r of rows) {
    if (onlyIds && !onlyIds.has(r.id)) continue;
    const due = toCents(r.unpaid_amount);
    const take = Math.min(due, left);
    if (take > 0) out[r.id] = centsStr(take);
    left -= take;
  }
  return out;
}

/** 공통 모달 틀 — Main.jsx Modal 과 같은 클래스 */
function SpModal({ title, onClose, formId, saveLabel, submitting, saveDisabled, danger, wide, children }) {
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
      <div className={`main-modal sp-modal${wide ? ' main-modal--wide sp-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="sp-modal-title">
        <div className="main-modal-header">
          <h2 id="sp-modal-title">{title}</h2>
        </div>
        <div className="main-modal-body">{children}</div>
        <div className="main-modal-footer">
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={submitting}>
            닫기
          </button>
          <button type="submit" form={formId} className={`main-modal-btn primary${danger ? ' tc-btn-danger' : ''}`} disabled={submitting || saveDisabled}>
            {submitting ? '처리 중…' : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function errorText(er) {
  if (!er) return '';
  if (er.code === 'OVERPAY') return `${er.message} (최대 ${won(er.body?.max_amount)}원)`;
  if (er.code === 'ALLOC_OVER_DUE') return `${er.message}`;
  return er.message || '처리에 실패했습니다.';
}

// ---------------------------------------------------------------------------
// 지급 등록 모달 (W-09)
// props: partners(전체 거래처), initial { partnerId, purchaseIds:[] } — 「선택 매입 지급」, onClose, onDone(message)
// ---------------------------------------------------------------------------
export function SupplierPaymentModal({ partners, initial, onClose, onDone }) {
  const payPartners = useMemo(
    () => partners.filter((p) => PAYABLE_TYPES.has(p.type)).sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')),
    [partners]
  );
  const [partnerId, setPartnerId] = useState(initial?.partnerId ? String(initial.partnerId) : '');
  const [rows, setRows] = useState([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [alloc, setAlloc] = useState({}); // purchase_id → 금액 문자열
  const [paidAt, setPaidAt] = useState(kstNowLocalInput());
  const [method, setMethod] = useState('transfer');
  // T-401 구분: pay(현금 지급) | discount(매입 할인 — 매입처가 깎아 준 금액, 지급 방법 없음)
  const [kind, setKind] = useState(initial?.kind === 'discount' ? 'discount' : 'pay');
  const [memo, setMemo] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const onlyIds = useMemo(() => (initial?.purchaseIds?.length ? new Set(initial.purchaseIds) : null), [initial]);

  useEffect(() => {
    setRows([]);
    setAlloc({});
    setError(null);
    if (!partnerId) return undefined;
    let alive = true;
    setRowsLoading(true);
    fetchUnpaidPurchases(partnerId)
      .then((list) => {
        if (!alive) return;
        setRows(list);
        if (onlyIds && String(initial?.partnerId) === partnerId) {
          // 선택한 매입만 전액 채운 상태로 연다
          const sel = list.filter((r) => onlyIds.has(r.id));
          const total = sel.reduce((s, r) => s + toCents(r.unpaid_amount), 0);
          setAmount(total > 0 ? centsStr(total) : '');
          setAlloc(autoFill(list, total, onlyIds));
        } else {
          setAlloc(autoFill(list, toCents(amount)));
        }
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setRowsLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 매입처가 바뀔 때만 다시 불러온다
  }, [partnerId]);

  const totalDue = rows.reduce((s, r) => s + toCents(r.unpaid_amount), 0);
  const amountC = toCents(amount);
  const sumC = Object.values(alloc).reduce((s, v) => s + (toCents(v) || 0), 0);
  const overRow = rows.find((r) => toCents(alloc[r.id] || 0) > toCents(r.unpaid_amount));
  const badRow = Object.values(alloc).some((v) => v !== '' && !(toCents(v) >= 0));
  const amountOk = Number.isFinite(amountC) && amountC > 0;
  const canSave = !!partnerId && amountOk && sumC === amountC && !overRow && !badRow && amountC <= totalDue;
  const partner = payPartners.find((p) => String(p.id) === partnerId);

  const changeAmount = (v) => {
    setAmount(v);
    setAlloc(autoFill(rows, toCents(v), onlyIds));
  };
  const changeAlloc = (id, v) => setAlloc((a) => ({ ...a, [id]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      const allocations = rows
        .filter((r) => toCents(alloc[r.id] || 0) > 0)
        .map((r) => ({ purchase_id: r.id, amount: centsStr(toCents(alloc[r.id])) }));
      const d = await createSupplierPayment({
        partner_id: Number(partnerId),
        amount: centsStr(amountC),
        paid_at: paidAt,
        ...(kind === 'discount' ? { kind: 'discount' } : { method }),
        memo: memo.trim() || undefined,
        allocations,
      });
      onDone(kind === 'discount'
        ? `${d.partner_name} 매입 할인 ${won(d.amount)}원을 기록했습니다 — 미지급 ${won(d.partner_payable_after)}원 남음.`
        : `${d.partner_name}에 ${won(d.amount)}원을 지급했습니다 — 미지급 ${won(d.partner_payable_after)}원 남음.`);
    } catch (er) {
      setError(er);
    } finally {
      setSubmitting(false);
    }
  };

  let hint = '';
  if (!partnerId) hint = '매입처를 고르세요.';
  else if (!rowsLoading && rows.length === 0) hint = '이 매입처에 지급할 매입이 없습니다.';
  else if (!amountOk) hint = kind === 'discount' ? '할인액을 넣으면 오래된 매입부터 채웁니다.' : '지급액을 넣으면 오래된 매입부터 채웁니다.';
  else if (amountC > totalDue) hint = `지급액이 미지급 합계(${won(fromCents(totalDue))}원)보다 많습니다. 선급금은 아직 기록할 수 없습니다.`;
  else if (overRow) hint = `매입 #${overRow.id}에 남은 미지급보다 많이 넣었습니다.`;
  else if (sumC !== amountC) hint = `배분 합 ${won(fromCents(sumC))}원 / 지급액 ${won(fromCents(amountC))}원 — 같아야 저장할 수 있습니다.`;

  return (
    <SpModal title={kind === 'discount' ? '매입 할인 등록' : '지급 등록'} onClose={onClose} formId="sp-pay-form" saveLabel={kind === 'discount' ? '할인 저장' : '지급 저장'} submitting={submitting} saveDisabled={!canSave} wide>
      <form id="sp-pay-form" className="main-modal-form sp-form" onSubmit={submit}>
        {error && (
          <div className="main-alert-banner" role="alert">
            {errorText(error)}
          </div>
        )}
        <div className="sp-kind" role="radiogroup" aria-label="구분">
          {[['pay', '현금 지급'], ['discount', '매입 할인']].map(([k, label]) => (
            <label key={k} className={`sp-kind-opt${kind === k ? ' is-on' : ''}`}>
              <input type="radio" name="sp-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />
              {label}
            </label>
          ))}
          {kind === 'discount' && <small className="tc-hint">매입처가 깎아 준 금액만 미지급에서 뺍니다. 현금 지급 합계·원가에는 들어가지 않습니다.</small>}
        </div>
        <div className="tc-grid sp-grid">
          <label>
            매입처
            <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} required>
              <option value="">선택</option>
              {payPartners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {Number(p.payable_amount) > 0 ? ` (미지급 ${won(p.payable_amount)})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label>
            {kind === 'discount' ? '할인액' : '지급액'}
            <input type="text" inputMode="decimal" value={amount} onChange={(e) => changeAmount(e.target.value)} placeholder="0" aria-describedby="sp-pay-hint" />
          </label>
          <label>
            지급일시
            <input type="datetime-local" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} required />
          </label>
          {kind !== 'discount' && (
            <label>
              방법
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAY_METHOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="tc-grid-wide">
            메모
            <input type="text" maxLength={500} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 10월분" />
          </label>
        </div>

        {partner?.bank_account && (
          <p className="tc-hint sp-bank" aria-live="polite">
            입금 계좌: <strong>{partner.bank_name} {partner.bank_account}</strong> (예금주 {partner.bank_holder}) — 송금은 은행 앱에서 하세요.
          </p>
        )}
        {partnerId && (
          <div className="sp-alloc">
            <p className="sp-alloc-head">
              <strong>{partner?.name}</strong> 미지급 매입 {rows.length}건 · 합계 <strong>{won(fromCents(totalDue))}</strong>원
              {onlyIds ? ' · 선택한 매입만 채웠습니다' : ' · 오래된 매입부터 채움'}
            </p>
            {rowsLoading ? (
              <p className="main-loading">불러오는 중…</p>
            ) : rows.length > 0 ? (
              <div className="main-table-wrap sp-alloc-wrap">
                <table className="main-table sp-alloc-table">
                  <thead>
                    <tr>
                      <th>매입일</th>
                      <th className="sp-col-product">상품</th>
                      <th className="num sp-col-total">총액</th>
                      <th className="num">남은 미지급</th>
                      <th className="num">이번 지급</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const over = toCents(alloc[r.id] || 0) > toCents(r.unpaid_amount);
                      return (
                        <tr key={r.id}>
                          <td>
                            {ymdOf(r.purchase_date)} <span className="sp-muted">#{r.id}</span>
                            <span className="sp-mobile-product">{r.product_name}</span>
                          </td>
                          <td className="sp-col-product">{r.product_name}</td>
                          <td className="num sp-col-total">{won(r.total_amount)}</td>
                          <td className="num">{won(r.unpaid_amount)}</td>
                          <td className="num">
                            <input
                              type="text"
                              inputMode="decimal"
                              className={`sp-alloc-input${over ? ' sp-alloc-input--bad' : ''}`}
                              value={alloc[r.id] ?? ''}
                              onChange={(e) => changeAlloc(r.id, e.target.value)}
                              aria-label={`매입 #${r.id} 이번 지급`}
                              aria-invalid={over || undefined}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="sp-foot-label">배분 합 / 지급액</td>
                      <td className={`num${sumC !== amountC ? ' sp-bad' : ''}`}>
                        {won(fromCents(sumC))} / {amountOk ? won(fromCents(amountC)) : '-'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : null}
          </div>
        )}
        <p id="sp-pay-hint" className={`tc-hint${hint && amountOk ? ' sp-bad' : ''}`} aria-live="polite">
          {hint || '저장하면 매입별 지급 상태(미지급·일부·완료)가 바뀝니다. 잘못 넣었으면 지급정보에서 취소할 수 있습니다.'}
        </p>
      </form>
    </SpModal>
  );
}

// ---------------------------------------------------------------------------
// 지급 취소 모달 (W-10) — 사유 필수
// ---------------------------------------------------------------------------
const CANCEL_REASONS = ['금액 오입력', '중복 입력', '매입처 오선택'];
function CancelPaymentModal({ row, onClose, onDone }) {
  const [code, setCode] = useState(CANCEL_REASONS[0]);
  const [other, setOther] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const reason = code === '기타' ? other.trim() : code;
    if (!reason) {
      setError({ message: '취소 사유를 입력하세요.' });
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const d = await cancelSupplierPayment(row.id, { reason, expected_updated_at: row.updated_at || undefined });
      onDone(`지급 #${row.id}을(를) 취소했습니다 — ${row.partner_name} 미지급 ${won(d.partner_payable_after)}원.`);
    } catch (er) {
      setError(er);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <SpModal title="지급 취소" onClose={onClose} formId="sp-cancel-form" saveLabel="취소 실행" submitting={submitting} danger>
      <form id="sp-cancel-form" className="main-modal-form tc-form" onSubmit={submit}>
        {error && (
          <div className="main-alert-banner" role="alert">
            {errorText(error)}
          </div>
        )}
        <p className="tc-summary">
          <strong>
            {KIND_TEXT[row.kind] || '지급'} #{row.id}
          </strong>{' '}
          · {row.partner_name} · {won(row.amount)}원 · {dateTimeText(row.paid_at)} 을(를) 취소합니다.
        </p>
        <ul className="tc-notes">
          <li>지우지 않고 「취소」 상태로 남깁니다. 배분된 매입 {row.allocations?.length || 0}건의 미지급이 그만큼 다시 늘어납니다.</li>
          <li>취소한 지급은 되살릴 수 없습니다. 필요하면 새로 등록하세요.</li>
        </ul>
        <fieldset className="tc-reason">
          <legend>취소 사유</legend>
          <div className="tc-reason-options">
            {[...CANCEL_REASONS, '기타'].map((r) => (
              <label key={r} className="tc-reason-option">
                <input type="radio" name="sp-cancel-reason" value={r} checked={code === r} onChange={() => setCode(r)} />
                {r}
              </label>
            ))}
          </div>
          {code === '기타' && (
            <input type="text" className="tc-input" aria-label="기타 사유 직접 입력" maxLength={200} value={other} placeholder="사유를 입력하세요" onChange={(e) => setOther(e.target.value)} />
          )}
        </fieldset>
      </form>
    </SpModal>
  );
}

// ---------------------------------------------------------------------------
// 기초 정리 모달 (RULE-11) — 기준일까지의 미지급 매입을 지급 완료로 처리하는 지급 1건
// ---------------------------------------------------------------------------
function OpeningModal({ partners, onClose, onDone }) {
  const payPartners = useMemo(() => partners.filter((p) => PAYABLE_TYPES.has(p.type) && Number(p.payable_amount) > 0), [partners]);
  const [partnerId, setPartnerId] = useState('');
  const [through, setThrough] = useState(kstTodayYmd());
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    setRows([]);
    if (!partnerId) return undefined;
    let alive = true;
    fetchUnpaidPurchases(partnerId).then((l) => alive && setRows(l)).catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [partnerId]);
  const target = rows.filter((r) => ymdOf(r.purchase_date) <= through);
  const sumC = target.reduce((s, r) => s + toCents(r.unpaid_amount), 0);
  const partner = payPartners.find((p) => String(p.id) === partnerId);
  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const d = await createSupplierPayment({ partner_id: Number(partnerId), kind: 'opening', through_date: through });
      onDone(`${d.partner_name} 기초 정리 — ${through}까지 매입 ${d.allocations.length}건 ${won(d.amount)}원을 지급 완료로 처리했습니다.`);
    } catch (er) {
      setError(er);
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <SpModal title="기초 정리" onClose={onClose} formId="sp-opening-form" saveLabel="지급 완료로 처리" submitting={submitting} saveDisabled={!partnerId || target.length === 0}>
      <form id="sp-opening-form" className="main-modal-form tc-form" onSubmit={submit}>
        {error && (
          <div className="main-alert-banner" role="alert">
            {errorText(error)}
          </div>
        )}
        <p className="tc-hint">지급 기록을 시작하기 전에 이미 대금을 준 매입을 한 번에 정리합니다. 원장에는 「기초 정리」 한 줄로 남고, 오늘 지급 합계에는 넣지 않습니다.</p>
        <div className="tc-grid">
          <label>
            매입처
            <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} required>
              <option value="">선택</option>
              {payPartners.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} (미지급 {won(p.payable_amount)})
                </option>
              ))}
            </select>
          </label>
          <label>
            기준일(이날까지 다 줌)
            <input type="date" value={through} max={kstTodayYmd()} onChange={(e) => setThrough(e.target.value)} required />
          </label>
        </div>
        {partnerId && (
          <p className="tc-summary" aria-live="polite">
            {target.length === 0 ? (
              `${through}까지 미지급 매입이 없습니다.`
            ) : (
              <>
                <strong>{partner?.name}</strong> — {through}까지 매입 <strong>{target.length}건 {won(fromCents(sumC))}원</strong>을 지급 완료로 처리합니다.
              </>
            )}
          </p>
        )}
      </form>
    </SpModal>
  );
}

// ---------------------------------------------------------------------------
// 지급정보 탭 (W-10)
// ---------------------------------------------------------------------------
export default function TabSupplierPayments() {
  const [list, setList] = useState([]);
  const [partners, setPartners] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [fromDate, setFromDate] = useState(firstDayOfMonthKst());
  const [toDate, setToDate] = useState(kstTodayYmd());
  const [partnerId, setPartnerId] = useState('');
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [modal, setModal] = useState(null); // { type: 'pay' | 'opening' | 'cancel', row? }

  const loadPartners = () => fetchPartners().then(setPartners).catch(() => {});
  const load = (opts = {}) => {
    setLoading(true);
    setErr('');
    fetchSupplierPayments({
      from_date: fromDate,
      to_date: toDate,
      partner_id: partnerId,
      include_cancelled: (opts.includeCancelled ?? includeCancelled) ? 1 : '',
    })
      .then(setList)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    loadPartners();
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 1회. 이후는 검색 버튼
  }, []);
  const done = (msg) => {
    setModal(null);
    setNotice(msg);
    loadPartners();
    load();
  };
  const payPartners = partners.filter((p) => PAYABLE_TYPES.has(p.type));
  const shownSum = list.filter((x) => x.status === 'active' && x.kind === 'pay').reduce((s, x) => s + toCents(x.amount), 0);

  return (
    <>
      {notice && (
        <div className="partner-notice" role="status">
          {notice}
        </div>
      )}
      <div className="main-filters">
        <label className="main-date-filter">
          기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="시작일" /> ~{' '}
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="종료일" />
        </label>
        <label>
          매입처{' '}
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
            <option value="">전체</option>
            {payPartners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ledger-check">
          <input
            type="checkbox"
            checked={includeCancelled}
            onChange={(e) => {
              setIncludeCancelled(e.target.checked);
              load({ includeCancelled: e.target.checked });
            }}
          />
          취소 포함
        </label>
        <button type="button" className="main-btn main-btn--secondary" onClick={() => load()}>
          검색
        </button>
        {can('supplier_payment.create') && (
        <button
          type="button"
          className="main-btn"
          onClick={() => {
            setNotice('');
            setModal({ type: 'pay' });
          }}
        >
          지급 등록
        </button>
        )}
        {can('supplier_payment.create') && (
        <button
          type="button"
          className="main-btn main-btn--secondary"
          onClick={() => {
            setNotice('');
            setModal({ type: 'opening' });
          }}
          title="지급 기록을 시작하기 전 매입을 지급 완료로 정리"
        >
          기초 정리
        </button>
        )}
        <button
          type="button"
          className="main-btn main-btn--secondary"
          onClick={() => downloadListCsv('supplierPayments', list)}
          disabled={loading || list.length === 0}
          title="지금 화면에 보이는 목록(마지막 검색 결과)을 저장합니다"
        >
          엑셀(CSV) 다운로드
        </button>
      </div>
      {loading ? (
        <p className="main-loading">불러오는 중…</p>
      ) : err ? (
        <p className="main-error">{err}</p>
      ) : list.length === 0 ? (
        <p className="main-empty">지급 내역이 없습니다. 「지급 등록」으로 매입처에 준 돈을 기록하세요.</p>
      ) : (
        <>
          <p className="partner-count">
            {list.length}건 · 지급 합계 {won(fromCents(shownSum))}원(기초 정리·취소 제외)
          </p>
          <div className="main-table-wrap">
            <table className="main-table main-table--cards sp-table">
              <thead>
                <tr>
                  <th className="main-col-datetime">지급일시</th>
                  <th>구분</th>
                  <th className="main-col-partner">매입처</th>
                  <th className="main-col-amount">금액</th>
                  <th className="sp-method">방법</th>
                  <th>배분</th>
                  <th className="main-col-memo">비고</th>
                  <th className="main-col-manage">관리</th>
                </tr>
              </thead>
              <tbody>
                {list.map((row) => {
                  const cancelled = row.status === 'cancelled';
                  return (
                    <tr key={row.id} className={cancelled ? 'tc-row-cancelled' : undefined}>
                      <td data-card="sub" data-label="지급일시" className="main-col-datetime">
                        {dateTimeText(row.paid_at)}
                        {cancelled && (
                          <span className="tc-badge-cancelled" title={row.cancel_reason ? `취소 사유: ${row.cancel_reason}` : '취소된 지급'}>
                            취소
                          </span>
                        )}
                      </td>
                      <td data-card="key" data-label="구분">
                        <span className={`main-status ${KIND_CLASS[row.kind] || 'main-status--entry-receive'}`}>{KIND_TEXT[row.kind] || '지급'}</span>
                      </td>
                      <td data-card="title" data-label="매입처" className="main-col-partner">
                        {row.partner_name}
                      </td>
                      <td data-card="key" data-label="금액" className="num main-col-amount">
                        {won(row.amount)}
                      </td>
                      <td data-card="key" data-label="방법" className="sp-method">
                        {PAY_METHOD_LABEL[row.method] || '—'}
                      </td>
                      <td data-card="extra" data-label="배분" className="sp-alloc-summary">
                        {(row.allocations || []).map((a) => `#${a.purchase_id} ${a.product_name || ''} ${won(a.amount)}`).join(' · ') || '—'}
                      </td>
                      <td data-card="extra" data-label="비고" className="main-col-memo">
                        {row.memo || '-'}
                        {cancelled && row.cancel_reason ? <span className="sp-muted"> · 취소: {row.cancel_reason}</span> : null}
                      </td>
                      <td data-card="action" className="main-col-manage">
                        {!cancelled && row.kind === 'offset' && <span className="sp-muted" title="상계는 거래처 원장에서 수금 쪽과 함께 취소합니다">원장에서 상계 취소</span>}
                        {!cancelled && row.kind !== 'offset' && can('supplier_payment.cancel') && (
                          <button type="button" className="main-btn main-btn--secondary sp-cancel-btn" onClick={() => setModal({ type: 'cancel', row })} aria-label={`지급 #${row.id} 취소`}>
                            취소
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {modal?.type === 'pay' && <SupplierPaymentModal partners={partners} onClose={() => setModal(null)} onDone={done} />}
      {modal?.type === 'opening' && <OpeningModal partners={partners} onClose={() => setModal(null)} onDone={done} />}
      {modal?.type === 'cancel' && <CancelPaymentModal row={modal.row} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}
