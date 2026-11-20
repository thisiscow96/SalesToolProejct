// 거래처 원장 모달 · 미수 연령 보기 (T-104) — 설계 T-104_원장_설계.md 6장
// - 원장: 매출(+)·반품(−)·수금(−)·환불 지급(+)을 날짜순으로, 행마다 잔액 누계. 기간을 고르면 기초 잔액부터 시작
// - 미수 연령: 거래처별 미수를 매출일 기준 30일 이내 / 31–60 / 61–90 / 90일 초과로. 줄을 누르면 매출별 남은 미수
// 금액 계산은 모두 서버(DB NUMERIC)에서 하고, 화면은 받은 숫자를 그대로 보여 준다.
import { Fragment, useEffect, useId, useState } from 'react';
import { fetchPartnerLedger, fetchReceivablesAging } from '../api';
import { fetchPayableLedger, fetchPayablesAging } from '../lib/payablesApi';
import { kstTodayYmd } from '../lib/dates';
import PaymentReminderModal from '../components/PaymentReminderModal'; // T-214 입금 안내
import { can } from '../lib/staffAccess';
import './PartnerLedger.css';

/** 받을 돈 장부가 있는 거래처 유형(server ledger-routes RECEIVABLE_PARTNER_TYPES 와 같음) — 입금 안내 버튼(T-214) */
const RECEIVABLE_LEDGER_TYPES = new Set(['customer', 'same_market', 'wholesaler', 'market_wholesaler']);

export const won = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 }));
/**
 * 외상 한도·사용률 (T-207) — 사용 금액은 기간과 무관한 지금 미수(매출별 미수 합).
 * 막대는 100%에서 멈추고, 넘으면 빨간색 + 초과 금액.
 */
function CreditUsage({ credit }) {
  const pct = credit.usage_pct;
  const width = pct == null ? (credit.over ? 100 : 0) : Math.min(pct, 100);
  const level = credit.over ? 'over' : pct != null && pct >= 80 ? 'near' : 'ok';
  return (
    <div className={`ledger-credit ledger-credit--${level}`}>
      <div className="ledger-credit-head">
        <span className="ledger-credit-title">외상 한도</span>
        <span className="ledger-credit-nums">
          지금 미수 <strong>{won(credit.receivable)}</strong> / 한도 {won(credit.credit_limit)}
          {pct != null && <> ({pct}%)</>}
        </span>
      </div>
      <div
        className="ledger-credit-bar"
        role="progressbar"
        aria-label="외상 한도 사용률"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(width)}
        aria-valuetext={credit.over ? `한도 초과 ${won(credit.over_amount)}원` : `남은 한도 ${won(credit.available)}원`}
      >
        <span style={{ width: `${width}%` }} />
      </div>
      <p className="ledger-credit-foot">
        {credit.over ? <>한도 초과 <strong>{won(credit.over_amount)}원</strong> — 다음 판매 때 경고합니다.</> : <>남은 한도 {won(credit.available)}원</>}
      </p>
    </div>
  );
}

const qtyText = (n) => (n == null ? '' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 3 }));

const KIND_CLASS = {
  sale: 'sale', return: 'return', receipt: 'receipt', refund_cash: 'refund', sale_cancelled: 'cancelled',
  // T-201 지급 원장 — 매입(+)은 매출과, 지급(−)은 수금과 같은 색
  purchase: 'sale', payment: 'receipt', purchase_cancelled: 'cancelled', payment_cancelled: 'cancelled',
};
const CANCELLED_KINDS = new Set(['sale_cancelled', 'purchase_cancelled', 'payment_cancelled']);

/** 기간 버튼 — 기본은 최근 3개월([가정] 설계 T104-U-7). 날짜는 KST 기준 */
const PERIODS = [
  { key: 'month', label: '이번 달' },
  { key: '3m', label: '최근 3개월' },
  { key: 'year', label: '올해' },
  { key: 'all', label: '전체' },
  { key: 'custom', label: '직접' },
];
function periodRange(key, today = kstTodayYmd()) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (key === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (key === '3m') {
    const d = new Date(Date.UTC(y, m - 1 - 2, 1));
    return { from: d.toISOString().slice(0, 10), to: today };
  }
  if (key === 'year') return { from: `${y}-01-01`, to: today };
  return { from: '', to: '' };
}

/** 모달 공통: Esc 닫기 + 본문 스크롤 잠금(원래 값으로 복원) */
function useModalBehavior(open, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
}

/**
 * 거래처 원장 모달
 * props: partner {id,name,type}, onClose, onShowAging(partner) — 미수 연령 보기로 이동
 *        mode: 'receivable'(기본, 받을 돈) | 'payable'(T-201 지급 원장 — 줄 돈: 매입 + · 지급 −)
 */
export function PartnerLedgerModal({ partner, onClose, onShowAging, mode = 'receivable' }) {
  const payable = mode === 'payable';
  const titleId = useId();
  const [period, setPeriod] = useState('3m');
  const [range, setRange] = useState(() => periodRange('3m'));
  const [includeCancelled, setIncludeCancelled] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [reminderOpen, setReminderOpen] = useState(false); // T-214
  useModalBehavior(!!partner, onClose);

  useEffect(() => {
    if (!partner) return undefined;
    if (range.from && range.to && range.from > range.to) {
      setErr('시작일이 종료일보다 늦습니다.');
      setLoading(false);
      return undefined;
    }
    let alive = true;
    setLoading(true);
    setErr('');
    (payable ? fetchPayableLedger : fetchPartnerLedger)(partner.id, { from: range.from, to: range.to, include_cancelled: includeCancelled ? 1 : '' })
      .then((d) => alive && setData(d))
      .catch((e) => alive && setErr(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [partner, range.from, range.to, includeCancelled, payable]);

  if (!partner) return null;
  const pickPeriod = (key) => {
    setPeriod(key);
    if (key !== 'custom') setRange(periodRange(key));
  };
  const statementHref = () => {
    const q = new URLSearchParams({ partner_id: String(partner.id) });
    const first = data?.entries?.[0]?.date;
    const from = range.from || first || kstTodayYmd();
    const to = range.to || kstTodayYmd();
    q.set('from_date', from);
    q.set('to_date', to);
    return `/statement?${q.toString()}`;
  };
  const t = data?.totals;
  const diff = data?.check?.diff || 0;
  // T-214 입금 안내 — 받을 돈 장부가 있는 거래처만(매입처 제외). 미수 0 이어도 열 수는 있다(모달이 안내)
  const canRemind = !payable && !!data && RECEIVABLE_LEDGER_TYPES.has(data.partner?.type) && can('partner.reminder'); // T-213 주인만

  return (
    <div className="main-modal-backdrop ledger-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="main-modal main-modal--wide ledger-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="main-modal-header ledger-header">
          <h2 id={titleId}>{partner.name} {payable ? '지급 원장' : '원장'}</h2>
          <p className="ledger-sub">{payable ? '줄 돈 장부 · 미지급 잔액 = 매입 − 지급' : '받을 돈 장부 · 잔액 = 매출 − 반품 − 수금 + 환불 지급'}</p>
        </div>
        <div className="main-modal-body">
          <div className="ledger-controls">
            <div className="ledger-periods" role="group" aria-label="기간">
              {PERIODS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`ledger-chip${period === p.key ? ' is-active' : ''}`}
                  aria-pressed={period === p.key}
                  onClick={() => pickPeriod(p.key)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {period === 'custom' && (
              <div className="ledger-dates">
                <label>
                  시작
                  <input type="date" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
                </label>
                <label>
                  종료
                  <input type="date" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
                </label>
              </div>
            )}
            <label className="ledger-check">
              <input type="checkbox" checked={includeCancelled} onChange={(e) => setIncludeCancelled(e.target.checked)} />
              {payable ? '취소 매입·지급 보기' : '취소 매출 보기'}
            </label>
          </div>

          {loading && !data ? (
            <p className="main-loading">불러오는 중…</p>
          ) : err ? (
            <p className="main-error" role="alert">
              {err}
            </p>
          ) : data ? (
            <>
              {payable && Math.abs(diff) >= 0.005 && (
                <div className="ledger-warn" role="alert">
                  기록 차이 {won(Math.abs(diff))}원 — 매입별 미지급 합({won(data.check.purchase_based_due)})과 원장 잔액({won(data.check.ledger_balance)})이 다릅니다. 관리자 확인이 필요합니다.
                </div>
              )}
              {!payable && Math.abs(diff) >= 0.005 && (
                <div className="ledger-warn" role="alert">
                  매출별 미수 합({won(data.check.sale_based_due)})과 원장 잔액({won(data.check.ledger_balance)})이 {won(Math.abs(diff))}원 다릅니다. 이전 기록(받지 않은 돈의 환불 기록 등) 확인이 필요합니다.
                </div>
              )}
              {payable ? (
              <dl className="ledger-summary" aria-busy={loading}>
                <div>
                  <dt>기초 잔액</dt>
                  <dd>{won(data.opening_balance)}</dd>
                </div>
                <div>
                  <dt>매입</dt>
                  <dd className="is-plus">+{won(t.purchases)}</dd>
                </div>
                <div>
                  <dt>지급</dt>
                  <dd className="is-minus">−{won(t.payments)}</dd>
                </div>
                <div className="ledger-summary-closing">
                  <dt>미지급 잔액</dt>
                  <dd>{won(data.closing_balance)}</dd>
                </div>
              </dl>
              ) : (
              <dl className="ledger-summary" aria-busy={loading}>
                <div>
                  <dt>기초 잔액</dt>
                  <dd>{won(data.opening_balance)}</dd>
                </div>
                <div>
                  <dt>매출</dt>
                  <dd className="is-plus">+{won(t.sales)}</dd>
                </div>
                <div>
                  <dt>반품</dt>
                  <dd className="is-minus">−{won(t.returns)}</dd>
                </div>
                <div>
                  <dt>수금</dt>
                  <dd className="is-minus">−{won(t.receipts)}</dd>
                </div>
                <div>
                  <dt>환불 지급</dt>
                  <dd className="is-plus">+{won(t.refunds)}</dd>
                </div>
                <div className="ledger-summary-closing">
                  <dt>기말 잔액</dt>
                  <dd>{won(data.closing_balance)}</dd>
                </div>
              </dl>
              )}
              {!payable && data.credit && <CreditUsage credit={data.credit} />}
              {data.entries.length === 0 && !data.from ? (
                <p className="main-empty">거래 기록이 없습니다.</p>
              ) : (
                <div className="main-table-wrap ledger-table-wrap">
                  <table className="main-table ledger-table">
                    <thead>
                      <tr>
                        <th>날짜</th>
                        <th>구분</th>
                        <th>내용</th>
                        <th className="num">{payable ? '매입(+)' : '늘어남(+)'}</th>
                        <th className="num">{payable ? '지급(−)' : '줄어듦(−)'}</th>
                        <th className="num">잔액</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.from && (
                        <tr className="ledger-row ledger-row--opening">
                          <td className="ledger-date" />
                          <td className="ledger-kind" />
                          <td className="ledger-desc">기초 잔액 ({data.from} 이전)</td>
                          <td className="num ledger-inc" />
                          <td className="num ledger-dec" />
                          <td className="num ledger-bal">{won(data.opening_balance)}</td>
                        </tr>
                      )}
                      {data.entries.map((e) => (
                        <tr key={`${e.kind}-${e.ref_id}`} className={`ledger-row ledger-row--${KIND_CLASS[e.kind] || e.kind}`}>
                          <td className="ledger-date">{e.date}</td>
                          <td className="ledger-kind">
                            <span className={`ledger-badge ledger-badge--${KIND_CLASS[e.kind] || e.kind}`}>{e.kind_label}</span>
                          </td>
                          <td className="ledger-desc">
                            {e.description}
                            {e.memo && e.kind !== 'refund_cash' ? <span className="ledger-memo"> · {e.memo}</span> : null}
                          </td>
                          {CANCELLED_KINDS.has(e.kind) ? (
                            <>
                              <td className="num ledger-inc ledger-cancelled-amt" colSpan={2}>
                                취소 ({won(e.cancelled_amount)})
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="num ledger-inc">{e.increase ? won(e.increase) : ''}</td>
                              <td className="num ledger-dec">{e.decrease ? won(e.decrease) : ''}</td>
                            </>
                          )}
                          <td className="num ledger-bal">{won(e.balance)}</td>
                        </tr>
                      ))}
                      {data.entries.length === 0 && (
                        <tr>
                          <td colSpan={6} className="ledger-none">
                            이 기간에 거래가 없습니다.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : null}
        </div>
        <div className="main-modal-footer ledger-footer">
          <button type="button" className="main-modal-btn secondary" onClick={() => onShowAging && onShowAging(partner)}>
            {payable ? '미지급 연령 보기' : '미수 연령 보기'}
          </button>
          {!payable && (
          <button type="button" className="main-modal-btn secondary" onClick={() => window.open(statementHref(), '_blank', 'noopener')}>
            거래명세서
          </button>
          )}
          {canRemind && (
          <button type="button" className="main-modal-btn secondary ledger-remind-btn" onClick={() => setReminderOpen(true)}>
            입금 안내 보내기
          </button>
          )}
          <button type="button" className="main-modal-btn primary" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
      {reminderOpen && <PaymentReminderModal partner={partner} onClose={() => setReminderOpen(false)} />}
    </div>
  );
}

/**
 * 미수 연령 보기 — 거래처 탭의 [미수 연령] 화면
 * props: focusPartnerId(처음부터 펼칠 거래처), onOpenLedger(partner)
 *        mode: 'receivable'(기본) | 'payable'(T-201 미지급 연령 — 매입일 기준, 매입별 상세)
 */
export function ReceivablesAgingView({ focusPartnerId, onOpenLedger, mode = 'receivable' }) {
  const payable = mode === 'payable';
  const word = payable ? '미지급' : '미수';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [over60, setOver60] = useState(false);
  const [open, setOpen] = useState(focusPartnerId || null);
  const [detail, setDetail] = useState({}); // partner_id → { loading, err, sales }

  const load = () => {
    setLoading(true);
    setErr('');
    (payable ? fetchPayablesAging({}) : fetchReceivablesAging(over60 ? { min_days: 61 } : {}))
      .then((d) => {
        // 미지급 연령 API는 min_days 가 없어 화면에서 거른다(61일 이상 남은 매입이 있는 매입처)
        setData(payable && over60 ? { ...d, rows: d.rows.filter((r) => r.oldest_days >= 61) } : d);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [over60, payable]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDetail = (pid) => {
    setDetail((d) => ({ ...d, [pid]: { loading: true } }));
    (payable ? fetchPayablesAging({ partner_id: pid }) : fetchReceivablesAging({ partner_id: pid }))
      .then((d) => setDetail((x) => ({ ...x, [pid]: { sales: payable ? d.purchases || [] : d.sales || [] } })))
      .catch((e) => setDetail((x) => ({ ...x, [pid]: { err: e.message } })));
  };
  useEffect(() => {
    if (focusPartnerId) {
      setOpen(focusPartnerId);
      loadDetail(focusPartnerId);
    }
  }, [focusPartnerId]);

  const toggle = (pid) => {
    if (open === pid) {
      setOpen(null);
      return;
    }
    setOpen(pid);
    if (!detail[pid] || detail[pid].err) loadDetail(pid);
  };

  return (
    <section className="aging" aria-label={`${word} 연령`}>
      <div className="main-filters aging-filters">
        <label className="ledger-check">
          <input type="checkbox" checked={over60} onChange={(e) => setOver60(e.target.checked)} />
          61일 이상 {word}이 있는 거래처만
        </label>
        <button type="button" className="main-btn main-btn--secondary" onClick={load}>
          새로고침
        </button>
      </div>
      {data && (
        <p className="aging-basis">
          기준일 {data.as_of} · {payable ? '매입일부터 센 날수 · 지급은 매입별로 배분된 금액 기준' : '매출일부터 센 날수 · 수금은 매출별로 배분된 금액 기준'}
        </p>
      )}
      {loading && !data ? (
        <p className="main-loading">불러오는 중…</p>
      ) : err ? (
        <p className="main-error" role="alert">
          {err}
        </p>
      ) : data && data.rows.length === 0 ? (
        <p className="main-empty">{over60 ? `61일 이상 된 ${word}이 없습니다.` : payable ? '줄 돈(미지급)이 없습니다.' : '받을 돈(미수)이 없습니다.'}</p>
      ) : data ? (
        <div className="main-table-wrap">
          <table className="main-table aging-table">
            <thead>
              <tr>
                <th>거래처</th>
                <th className="num">{word} 합</th>
                {data.buckets.map((b) => (
                  <th key={b.key} className="num">
                    {b.label}
                  </th>
                ))}
                <th>{payable ? '가장 오래된 매입' : '가장 오래된 매출'}</th>
                <th>{payable ? '마지막 지급' : '마지막 수금'}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => {
                const isOpen = open === r.partner_id;
                const d = detail[r.partner_id];
                return (
                  <Fragment key={r.partner_id}>
                    <tr className={`aging-row${isOpen ? ' is-open' : ''}`}>
                      <td className="aging-name">
                        <button type="button" className="aging-toggle" aria-expanded={isOpen} onClick={() => toggle(r.partner_id)}>
                          <span className="aging-caret" aria-hidden="true">
                            {isOpen ? '▾' : '▸'}
                          </span>
                          {r.partner_name}
                        </button>
                      </td>
                      <td className="num aging-total">{won(r.total_due)}</td>
                      {data.buckets.map((b) => (
                        <td key={b.key} className={`num${b.key === 'd91p' && r[b.key] > 0 ? ' aging-over' : ''}${r[b.key] === 0 ? ' aging-zero' : ''}`}>
                          {won(r[b.key])}
                        </td>
                      ))}
                      <td className="aging-date">
                        {payable ? r.oldest_purchase_date : r.oldest_sale_date} <span className="aging-days">({r.oldest_days}일)</span>
                      </td>
                      <td className="aging-date">{(payable ? r.last_payment_date : r.last_receipt_date) || '—'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="aging-detail-row">
                        <td colSpan={8}>
                          {!d || d.loading ? (
                            <p className="main-loading">불러오는 중…</p>
                          ) : d.err ? (
                            <p className="main-error">{d.err}</p>
                          ) : (
                            <div className="aging-detail">
                              {payable ? (
                              <table className="aging-sales">
                                <thead>
                                  <tr>
                                    <th>매입일</th>
                                    <th className="num">경과</th>
                                    <th>상품</th>
                                    <th className="num">총액</th>
                                    <th className="num">지급</th>
                                    <th className="num">남은 미지급</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {d.sales.map((s) => (
                                    <tr key={s.purchase_id}>
                                      <td>
                                        {s.purchase_date} <span className="aging-days">#{s.purchase_id}</span>
                                      </td>
                                      <td className={s.bucket === 'd91p' ? 'num aging-over' : 'num'}>{s.days}일</td>
                                      <td>
                                        {s.product_name} {qtyText(s.quantity)}
                                      </td>
                                      <td className="num">{won(s.total)}</td>
                                      <td className="num">{s.paid ? won(s.paid) : '-'}</td>
                                      <td className="num aging-total">{won(s.due)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              ) : (
                              <table className="aging-sales">
                                <thead>
                                  <tr>
                                    <th>매출일</th>
                                    <th className="num">경과</th>
                                    <th>상품</th>
                                    <th className="num">총액</th>
                                    <th className="num">반품</th>
                                    <th className="num">수금</th>
                                    <th className="num">남은 미수</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {d.sales.map((s) => (
                                    <tr key={s.sale_id}>
                                      <td>
                                        {s.sale_date} <span className="aging-days">#{s.sale_id}</span>
                                      </td>
                                      <td className={`num${s.bucket === 'd91p' ? ' aging-over' : ''}`}>{s.days}일</td>
                                      <td>
                                        {s.product_name} {qtyText(s.quantity)}
                                      </td>
                                      <td className="num">{won(s.total_amount)}</td>
                                      <td className="num">{s.returned_amount ? won(s.returned_amount) : '-'}</td>
                                      <td className="num">{s.paid_amount ? won(s.paid_amount) : '-'}</td>
                                      <td className="num aging-total">{won(s.due)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              )}
                              <button
                                type="button"
                                className="main-btn main-btn--secondary aging-ledger-btn"
                                onClick={() => onOpenLedger && onOpenLedger({ id: r.partner_id, name: r.partner_name, type: r.partner_type })}
                              >
                                {r.partner_name} {payable ? '지급 원장' : '원장'} 열기
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="aging-totals">
                <td>합계 ({data.totals.partner_count}곳)</td>
                <td className="num">{won(data.totals.total_due)}</td>
                {data.buckets.map((b) => (
                  <td key={b.key} className={`num${b.key === 'd91p' && data.totals[b.key] > 0 ? ' aging-over' : ''}`}>
                    {won(data.totals[b.key])}
                  </td>
                ))}
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </section>
  );
}
