import { useCallback, useEffect, useState } from 'react';
import { fetchDashboard } from '../api';
import { PartnerLedgerModal, won } from './PartnerLedger';
import './TabDashboard.css';

/**
 * 첫 화면 "오늘" (T-208) — 출근해서 1분 안에 오늘 할 일을 본다.
 * 서버 GET /api/dashboard 한 번으로 그린다. 숫자 규칙은 server/lib/dashboard-routes.js 머리말 참고.
 * props: onNavigate(tabId) — 카드·목록에서 해당 탭으로 이동
 */

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
function dateLabel(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y}년 ${m}월 ${d}일 (${wd})`;
}

const qty = (n) => Number(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: 3 });

/** 연령 구간 막대 색 단계 — 오래될수록 진하게 */
const BUCKET_TONE = { d0_30: 'ok', d31_60: 'info', d61_90: 'warn', d91p: 'danger' };

function TodayCard({ label, amount, count, unit, onOpen, actionLabel }) {
  return (
    <section className="dash-card dash-kpi" aria-label={label}>
      <h3 className="dash-kpi-label">{label}</h3>
      <p className="dash-kpi-amount">
        {won(amount)}
        <span className="dash-kpi-unit">원</span>
      </p>
      <p className="dash-kpi-count">
        {count > 0 ? `${count.toLocaleString('ko-KR')}${unit}` : `오늘 ${label.replace('오늘 ', '')} 없음`}
      </p>
      <button type="button" className="dash-link" onClick={onOpen}>
        {actionLabel} <span aria-hidden="true">›</span>
      </button>
    </section>
  );
}

function AgingBar({ rv }) {
  const total = Number(rv.total_due) || 0;
  return (
    <div className="dash-aging">
      <div className="dash-aging-bar" role="img" aria-label={rv.buckets.map((b) => `${b.label} ${won(rv[b.key])}원`).join(', ')}>
        {total > 0 &&
          rv.buckets.map((b) =>
            Number(rv[b.key]) > 0 ? (
              <span
                key={b.key}
                className={`dash-aging-seg dash-tone--${BUCKET_TONE[b.key]}`}
                style={{ flexGrow: Number(rv[b.key]) }}
                title={`${b.label} ${won(rv[b.key])}원`}
              />
            ) : null
          )}
      </div>
      <dl className="dash-aging-legend">
        {rv.buckets.map((b) => (
          <div key={b.key} className="dash-aging-item">
            <dt>
              <span className={`dash-dot dash-tone--${BUCKET_TONE[b.key]}`} aria-hidden="true" />
              {b.label}
            </dt>
            <dd className={b.key === 'd91p' && Number(rv[b.key]) > 0 ? 'dash-num dash-num--danger' : 'dash-num'}>{won(rv[b.key])}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export default function TabDashboard({ onNavigate }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [ledgerPartner, setLedgerPartner] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setErr('');
    fetchDashboard()
      .then(setData)
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  const go = (tab) => onNavigate && onNavigate(tab);
  const closeLedger = useCallback(() => setLedgerPartner(null), []);

  if (loading && !data) return <p className="main-loading">불러오는 중…</p>;
  if (err && !data) {
    return (
      <div className="dash-error-wrap">
        <p className="main-error">{err}</p>
        <button type="button" className="main-btn main-btn--secondary" onClick={load}>다시 불러오기</button>
      </div>
    );
  }
  if (!data) return null;

  const { today, receivables: rv, top_receivable_partners: topPartners, stale_inventory: stale } = data;
  const nothingToday = today.purchases.count + today.sales.count + today.receipts.count === 0;

  return (
    <div className="dash">
      <div className="dash-toolbar">
        <p className="dash-date">
          <strong>{dateLabel(data.as_of)}</strong> 기준
          {nothingToday && <span className="dash-hint"> · 오늘 등록한 거래가 아직 없습니다</span>}
        </p>
        <button type="button" className="main-btn main-btn--secondary" onClick={load} disabled={loading}>
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>
      {err && <p className="main-error main-error--inline">{err}</p>}

      <div className="dash-kpis">
        <TodayCard label="오늘 매입" amount={today.purchases.amount} count={today.purchases.count} unit="건" actionLabel="매입정보" onOpen={() => go('purchases')} />
        <TodayCard label="오늘 매출" amount={today.sales.amount} count={today.sales.count} unit="건" actionLabel="매출정보" onOpen={() => go('sales')} />
        <TodayCard label="오늘 수금" amount={today.receipts.amount} count={today.receipts.count} unit="건" actionLabel="수금정보" onOpen={() => go('payments')} />
        {today.payments && <TodayCard label="오늘 지급" amount={today.payments.amount} count={today.payments.count} unit="건" actionLabel="지급정보" onOpen={() => go('supplier-payments')} />}
      </div>

      <section className="dash-card dash-recv" aria-labelledby="dash-recv-title">
        <div className="dash-card-head">
          <h3 id="dash-recv-title" className="dash-card-title">받을 돈(총미수)</h3>
          <button type="button" className="dash-link" onClick={() => go('partners')}>
            거래처별 미수 연령 <span aria-hidden="true">›</span>
          </button>
        </div>
        {rv.total_due > 0 ? (
          <>
            <p className="dash-recv-total">
              {won(rv.total_due)}
              <span className="dash-kpi-unit">원</span>
              <span className="dash-recv-meta">
                거래처 {rv.partner_count.toLocaleString('ko-KR')}곳 · 매출 {rv.sale_count.toLocaleString('ko-KR')}건
              </span>
            </p>
            <AgingBar rv={rv} />
            <p className="dash-foot">경과일 = 오늘 − 매출일</p>
          </>
        ) : (
          <p className="dash-empty">받을 돈이 없습니다.</p>
        )}
      </section>

      <div className="dash-lists">
        <section className="dash-card" aria-labelledby="dash-stale-title">
          <div className="dash-card-head">
            <h3 id="dash-stale-title" className="dash-card-title">오래된 재고</h3>
            <button type="button" className="dash-link" onClick={() => go('inventory')}>
              재고현황 <span aria-hidden="true">›</span>
            </button>
          </div>
          {stale.product_count > 0 && (
            <p className="dash-badges" role="status">
              <span className="main-aging-badge main-aging-badge--danger">{stale.danger_days}일 이상 {stale.danger_count}건</span>
              <span className="main-aging-badge main-aging-badge--warn">{stale.warn_days}일 이상 {stale.warn_count}건</span>
            </p>
          )}
          {stale.items.length === 0 ? (
            <p className="dash-empty">
              {stale.product_count === 0 ? '남은 재고가 없습니다.' : `${stale.warn_days}일 넘은 재고가 없습니다.`}
            </p>
          ) : (
            <ol className="dash-list">
              {stale.items.map((it) => (
                <li key={it.product_id} className="dash-row">
                  <span className="dash-row-main">
                    <span className="dash-row-name">{it.product_name}</span>
                    <span className="dash-row-sub">
                      {qty(it.quantity)}
                      {it.unit ? ` ${it.unit}` : ''} · {it.aging_base_date} 매입분부터
                    </span>
                  </span>
                  <span className={`dash-days dash-days--${it.level}`}>{it.aging_days}일</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="dash-card" aria-labelledby="dash-top-title">
          <div className="dash-card-head">
            <h3 id="dash-top-title" className="dash-card-title">미수 많은 거래처</h3>
            <button type="button" className="dash-link" onClick={() => go('partners')}>
              거래처 <span aria-hidden="true">›</span>
            </button>
          </div>
          {topPartners.length === 0 ? (
            <p className="dash-empty">미수가 있는 거래처가 없습니다.</p>
          ) : (
            <ol className="dash-list">
              {topPartners.map((p) => (
                <li key={p.partner_id} className="dash-row">
                  <button
                    type="button"
                    className="dash-row-btn"
                    onClick={() => setLedgerPartner({ id: p.partner_id, name: p.partner_name, type: p.partner_type })}
                    aria-label={`${p.partner_name} 원장 보기, 미수 ${won(p.total_due)}원`}
                  >
                    <span className="dash-row-main">
                      <span className="dash-row-name">{p.partner_name}</span>
                      <span className="dash-row-sub">
                        매출 {p.sale_count}건 · {p.oldest_days > 0 ? `가장 오래된 매출 ${p.oldest_days}일 전` : '오늘 매출'}
                        {p.d91p > 0 && <span className="dash-num--danger"> · 90일 초과 {won(p.d91p)}</span>}
                      </span>
                    </span>
                    <span className="dash-row-amount dash-num">{won(p.total_due)}</span>
                    <span className="dash-row-go" aria-hidden="true">원장 ›</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {ledgerPartner && (
        <PartnerLedgerModal
          partner={ledgerPartner}
          onClose={closeLedger}
          onShowAging={() => {
            setLedgerPartner(null);
            go('partners');
          }}
        />
      )}
    </div>
  );
}
