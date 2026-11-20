// 월 정산 보고서 — T-215 (기능 제안 P20)
// 월을 고르면 매입·매출·반품·폐기·수금·지급 합계, 매출 이익·이익률, 월초·월말 미수·미지급, 거래처별 상위, 전월 대비를 한 장으로 본다.
// 서버 GET /api/reports/monthly 한 번으로 그린다(숫자 규칙은 server/lib/monthly-report-routes.js 머리말).
// - 탭(TabMonthly): 월 선택 + 보고서 + "인쇄 / PDF 저장" + "엑셀(CSV) 다운로드"
// - 인쇄 화면(MonthlyReportPrint, /monthly-report?month=): 거래명세서(T-105)와 같은 방식 — 같은 탭에서 열고 브라우저 인쇄 → "PDF로 저장"
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getUser } from '../api';
import { fetchMonthlyReport } from '../lib/monthlyApi';
import { kstTodayYmd } from '../lib/dates';
import { downloadCsv, csvFileName } from '../lib/csv';
import { partnerTypeLabel } from './TabPartners';
import { won } from './PartnerLedger';
import './Statement.css';
import './MonthlyReport.css';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const thisMonth = () => kstTodayYmd().slice(0, 7);

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month) {
  const [y, m] = String(month || '').split('-').map(Number);
  return y && m ? `${y}년 ${m}월` : '';
}

/** 증감 표시 — 금액은 +/−, 비율은 %p. 좋아짐/나빠짐 색은 good 방향(up|down)으로 */
function Delta({ diff, pct, unit = '원', good = 'up' }) {
  if (diff == null) return <span className="mr-delta mr-delta--none">—</span>;
  if (diff === 0) return <span className="mr-delta mr-delta--none">변동 없음</span>;
  const up = diff > 0;
  const tone = (up && good === 'up') || (!up && good === 'down') ? 'good' : good === 'none' ? 'none' : 'bad';
  const sign = up ? '+' : '−';
  const amount = unit === '%p' ? `${Math.abs(diff).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%p` : `${won(Math.abs(diff))}${unit}`;
  return (
    <span className={`mr-delta mr-delta--${tone}`}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span> {sign}{amount}
      {pct != null && <span className="mr-delta-pct"> ({sign}{Math.abs(pct).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%)</span>}
    </span>
  );
}

const pctText = (v) => (v == null ? '—' : `${v.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}%`);

/** 표·CSV 공통 행 정의 — 화면과 CSV 숫자가 같은 자리에서 나온다 */
function summaryRows(d) {
  const p = d.previous;
  const c = d.change;
  const rows = [
    { key: 'purchases', label: '매입', cur: d.purchases.amount, count: d.purchases.count, prev: p.purchases.amount, ch: c.purchases, good: 'none' },
    { key: 'sales', label: '매출(총액)', cur: d.sales.amount, count: d.sales.count, prev: p.sales.amount, ch: c.sales, good: 'up' },
    { key: 'returns', label: '반품', sub: d.returns.amount > 0 ? `미수 차감 ${won(d.returns.credit)} · 현금 환불 ${won(d.returns.cash_refund)}` : '', cur: -d.returns.amount, count: d.returns.count, prev: -p.returns.amount, ch: { ...c.returns, diff: -c.returns.diff }, good: 'up', neg: true },
    { key: 'net_sales', label: '순매출', strong: true, cur: d.net_sales, prev: p.net_sales, ch: c.net_sales, good: 'up' },
    { key: 'cost', label: '매출 원가', sub: '팔린 물건의 매입 단가', cur: d.profit.cost, prev: p.profit.cost, ch: { diff: d.profit.cost - p.profit.cost, pct: null }, good: 'none' },
    { key: 'profit', label: '매출 이익', strong: true, cur: d.profit.profit, prev: p.profit.profit, ch: c.profit, good: 'up' },
    { key: 'margin', label: '이익률', cur: d.profit.margin_pct, prev: p.profit.margin_pct, ch: c.margin_pct, good: 'up', pctRow: true },
    { key: 'disposal', label: '폐기 손실(추정)', cur: -d.disposals.cost_estimate, count: d.disposals.count, prev: -p.disposals.cost_estimate, ch: { ...c.disposal_cost, diff: -c.disposal_cost.diff }, good: 'up', neg: true },
    { key: 'receipts', label: '수금', cur: d.receipts.amount, count: d.receipts.count, prev: p.receipts.amount, ch: c.receipts, good: 'up' },
    { key: 'refund_payments', label: '환불 지급', sub: '반품으로 돌려준 돈', cur: d.refund_payments.amount, count: d.refund_payments.count, prev: p.refund_payments.amount, ch: { diff: d.refund_payments.amount - p.refund_payments.amount, pct: null }, good: 'none' },
    { key: 'payments', label: '지급', sub: '매입처에 준 돈', cur: d.payments.amount, count: d.payments.count, prev: p.payments.amount, ch: c.payments, good: 'none' },
  ];
  if (d.payments.opening_amount > 0 || p.payments.opening_amount > 0) {
    rows.push({ key: 'opening', label: '기초 정리', sub: '이전 매입 일괄 정리', cur: d.payments.opening_amount, count: d.payments.opening_count, prev: p.payments.opening_amount, ch: { diff: d.payments.opening_amount - p.payments.opening_amount, pct: null }, good: 'none' });
  }
  // T-401 정산 할인·상계 — 현금이 아니라 수금·지급 줄과 따로. 이번 달·전월 모두 0 이면 숨김
  const z = (o, k = 'amount') => Number(o?.[k]) || 0;
  const diffOnly = (a, b) => ({ diff: a - b, pct: null });
  if (z(d.sale_discounts) || z(p.sale_discounts)) {
    rows.push({ key: 'sale_discounts', label: '매출 할인', sub: '정산 때 깎아 준 금액(현금 아님)', cur: -z(d.sale_discounts), count: d.sale_discounts?.count, prev: -z(p.sale_discounts), ch: diffOnly(-z(d.sale_discounts), -z(p.sale_discounts)), good: 'none', neg: true });
    rows.push({ key: 'profit_after_discount', label: '할인 반영 이익', sub: '매출 이익 − 매출 할인 + 반품 때 되돌린 할인', strong: true, cur: z(d.profit, 'profit_after_discount'), prev: z(p.profit, 'profit_after_discount'), ch: diffOnly(z(d.profit, 'profit_after_discount'), z(p.profit, 'profit_after_discount')), good: 'up' });
  }
  if (z(d.payments, 'discount_amount') || z(p.payments, 'discount_amount')) {
    rows.push({ key: 'pay_discounts', label: '매입 할인', sub: '매입처가 깎아 준 금액(현금 아님, 원가·이익에 넣지 않음)', cur: z(d.payments, 'discount_amount'), count: d.payments.discount_count, prev: z(p.payments, 'discount_amount'), ch: diffOnly(z(d.payments, 'discount_amount'), z(p.payments, 'discount_amount')), good: 'none' });
  }
  if (z(d.offsets) || z(p.offsets)) {
    rows.push({ key: 'offsets', label: '상계', sub: '받을 돈·줄 돈을 같은 금액만큼 지움(현금 아님)', cur: z(d.offsets), count: d.offsets?.count, prev: z(p.offsets), ch: diffOnly(z(d.offsets), z(p.offsets)), good: 'none' });
  }
  return rows;
}

function balanceRows(d) {
  const r = d.balances.receivable;
  const p = d.balances.payable;
  return [
    { key: 'receivable', label: '받을 돈(미수)', opening: r.opening, closing: r.closing, good: 'down' },
    { key: 'payable', label: '줄 돈(미지급)', opening: p.opening, closing: p.closing, good: 'down' },
  ];
}

/** CSV — 한 파일에 요약·잔액·상위 거래처를 구역으로 나눠 담는다(세무사 전달용) */
export function downloadMonthlyCsv(d) {
  const rows = [];
  for (const r of summaryRows(d)) {
    rows.push({ section: '합계', item: r.label, cur: r.cur, count: r.count ?? '', prev: r.prev, diff: r.ch?.diff ?? '', pct: r.ch?.pct ?? '' });
  }
  for (const b of balanceRows(d)) {
    rows.push({ section: '잔액', item: `${b.label} 월초`, cur: b.opening, count: '', prev: '', diff: '', pct: '' });
    rows.push({ section: '잔액', item: `${b.label} 월말`, cur: b.closing, count: '', prev: '', diff: b.closing - b.opening, pct: '' });
  }
  d.top.sales_partners.forEach((t, i) => rows.push({ section: '매출처 상위', item: `${i + 1}. ${t.partner_name}`, cur: t.amount, count: t.count, prev: '', diff: '', pct: '', extra: t.profit }));
  d.top.purchase_partners.forEach((t, i) => rows.push({ section: '매입처 상위', item: `${i + 1}. ${t.partner_name}`, cur: t.amount, count: t.count, prev: '', diff: '', pct: '' }));
  const columns = [
    { header: '구분', value: (x) => x.section },
    { header: '항목', value: (x) => x.item },
    { header: `${d.month} 금액(이익률은 %)`, value: (x) => x.cur, type: 'number' },
    { header: '건수', value: (x) => x.count, type: 'number' },
    { header: `전월(${d.previous.month})`, value: (x) => x.prev, type: 'number' },
    { header: '증감', value: (x) => x.diff, type: 'number' },
    { header: '증감률(%)', value: (x) => x.pct, type: 'number' },
    { header: '이익(매출처)', value: (x) => x.extra ?? '', type: 'number' },
  ];
  downloadCsv(csvFileName(`월정산_${d.month}`, d.generated_on), columns, rows);
}

/** 보고서 본문 — 탭과 인쇄 화면이 같이 쓴다 */
export function MonthlyReportSheet({ data: d }) {
  const user = getUser();
  const rows = summaryRows(d);
  const bal = balanceRows(d);
  const noTrade = d.purchases.count + d.sales.count + d.receipts.count + d.payments.count + d.returns.count + d.disposals.count === 0;
  return (
    <article className="mr-sheet" aria-label={`${monthLabel(d.month)} 월 정산 보고서`}>
      <header className="mr-head">
        <h2 className="mr-title">{monthLabel(d.month)} 정산</h2>
        <p className="mr-sub">
          {d.from} ~ {d.to}{d.is_current_month ? ` (오늘 ${d.generated_on}까지)` : ''} · {user?.name || ''}
          {user?.agent_no ? ` (중매 ${user.agent_no})` : ''} · 작성 {d.generated_on}
        </p>
      </header>

      <section className="mr-kpis" aria-label="핵심 숫자">
        <div className="mr-kpi">
          <h3>순매출</h3>
          <p className="mr-kpi-num">{won(d.net_sales)}<span>원</span></p>
          <Delta diff={d.change.net_sales.diff} pct={d.change.net_sales.pct} />
        </div>
        <div className="mr-kpi">
          <h3>매출 이익 <small>{pctText(d.profit.margin_pct)}</small></h3>
          <p className="mr-kpi-num">{won(d.profit.profit)}<span>원</span></p>
          <Delta diff={d.change.profit.diff} pct={d.change.profit.pct} />
        </div>
        <div className="mr-kpi">
          <h3>수금</h3>
          <p className="mr-kpi-num">{won(d.receipts.amount)}<span>원</span></p>
          <Delta diff={d.change.receipts.diff} pct={d.change.receipts.pct} />
        </div>
        <div className="mr-kpi">
          <h3>월말 미수</h3>
          <p className="mr-kpi-num">{won(d.balances.receivable.closing)}<span>원</span></p>
          <Delta diff={d.balances.receivable.closing - d.balances.receivable.opening} good="down" />
          <span className="mr-kpi-note">월초 대비</span>
        </div>
      </section>

      {noTrade && <p className="mr-empty">이 달에는 거래 기록이 없습니다. 잔액은 이전 거래 기준입니다.</p>}

      <section className="mr-block">
        <h3 className="mr-block-title">거래 합계 <small>전월 {monthLabel(d.previous.month)}과 비교</small></h3>
        <table className="mr-table">
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col" className="num">이번 달</th>
              <th scope="col" className="num mr-col-count">건수</th>
              <th scope="col" className="num">전월</th>
              <th scope="col" className="num">증감</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.strong ? 'mr-row--strong' : undefined}>
                <th scope="row" data-k="label">
                  {r.label}
                  {r.sub && <span className="mr-row-sub">{r.sub}</span>}
                </th>
                <td className="num" data-k="cur">{r.pctRow ? pctText(r.cur) : r.neg && r.cur !== 0 ? `−${won(Math.abs(r.cur))}` : won(r.cur)}</td>
                <td className="num mr-col-count" data-k="count">{r.count != null ? `${r.count.toLocaleString('ko-KR')}건` : ''}</td>
                <td className="num" data-k="prev"><span className="mr-m-label">전월 </span>{r.pctRow ? pctText(r.prev) : r.neg && r.prev !== 0 ? `−${won(Math.abs(r.prev))}` : won(r.prev)}</td>
                <td className="num" data-k="diff">
                  <Delta diff={r.ch?.diff} pct={r.pctRow ? null : r.ch?.pct} unit={r.pctRow ? '%p' : '원'} good={r.good} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.profit.cost_missing_count > 0 && (
          <p className="mr-note mr-note--warn">
            매입과 연결되지 않은 매출 {d.profit.cost_missing_count}건은 원가를 몰라 이익 계산에서 뺐습니다(원가 있는 매출 {won(d.profit.costed_sales)}원 기준).
          </p>
        )}
        {d.disposals.cost_missing_count > 0 && (
          <p className="mr-note mr-note--warn">폐기 {d.disposals.cost_missing_count}건은 그 전에 매입 기록이 없어 손실 금액에 넣지 못했습니다.</p>
        )}
      </section>

      <section className="mr-block">
        <h3 className="mr-block-title">잔액</h3>
        <table className="mr-table mr-table--bal">
          <thead>
            <tr>
              <th scope="col">구분</th>
              <th scope="col" className="num">월초</th>
              <th scope="col" className="num">월말</th>
              <th scope="col" className="num">증감</th>
            </tr>
          </thead>
          <tbody>
            {bal.map((b) => (
              <tr key={b.key}>
                <th scope="row" data-k="label">{b.label}</th>
                <td className="num" data-k="open"><span className="mr-m-label">월초 </span>{won(b.opening)}</td>
                <td className="num" data-k="cur"><span className="mr-m-label">월말 </span>{won(b.closing)}</td>
                <td className="num" data-k="diff"><Delta diff={Math.round((b.closing - b.opening) * 100) / 100} good={b.good} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mr-note">월초 = 전달 말일까지, 월말 = 이달 말일까지의 거래처 원장·지급 원장 잔액입니다.</p>
      </section>

      <div className="mr-tops">
        <section className="mr-block">
          <h3 className="mr-block-title">매출 많은 거래처 <small>상위 {d.notes.top_n}</small></h3>
          {d.top.sales_partners.length === 0 ? (
            <p className="mr-empty">이 달 매출이 없습니다.</p>
          ) : (
            <ol className="mr-rank">
              {d.top.sales_partners.map((t) => (
                <li key={t.partner_id}>
                  <span className="mr-rank-name">{t.partner_name}<small>{partnerTypeLabel(t.partner_type)} · {t.count}건</small></span>
                  <span className="mr-rank-num">{won(t.amount)}원<small>이익 {won(t.profit)}원</small></span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section className="mr-block">
          <h3 className="mr-block-title">매입 많은 거래처 <small>상위 {d.notes.top_n}</small></h3>
          {d.top.purchase_partners.length === 0 ? (
            <p className="mr-empty">이 달 매입이 없습니다.</p>
          ) : (
            <ol className="mr-rank">
              {d.top.purchase_partners.map((t) => (
                <li key={t.partner_id}>
                  <span className="mr-rank-name">{t.partner_name}<small>{partnerTypeLabel(t.partner_type)} · {t.count}건</small></span>
                  <span className="mr-rank-num">{won(t.amount)}원</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <footer className="mr-foot">
        <p>매출 이익 = 원가를 아는 매출액 − 그 매출에 연결된 매입 단가 합(일별 매입·매출 화면과 같은 계산). 반품은 매출 이익에서 빼지 않았습니다.</p>
        <p>폐기 손실은 폐기 수량 × 그 품목의 폐기일까지 평균 매입 단가로 추정한 값입니다.</p>
      </footer>
    </article>
  );
}

function useMonthlyReport(month) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    if (!MONTH_RE.test(month)) {
      setErr('월을 YYYY-MM 형식으로 고르세요.');
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    setErr('');
    fetchMonthlyReport(month)
      .then((x) => { if (alive) setData(x); })
      .catch((e) => { if (alive) { setData(null); setErr(e.message); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [month]);
  return { data, loading, err };
}

/** 탭 화면 */
export default function TabMonthly() {
  const max = thisMonth();
  const [month, setMonth] = useState(max);
  const { data, loading, err } = useMonthlyReport(month);
  const pick = (v) => { if (MONTH_RE.test(v) && v <= max) setMonth(v); };

  return (
    <div className="mr-tab">
      <div className="main-filters mr-filters">
        <button type="button" className="main-btn main-btn--secondary mr-step" onClick={() => pick(shiftMonth(month, -1))} aria-label="이전 달">‹</button>
        <label className="mr-month">
          <span className="mr-visually-hidden">정산 월</span>
          <input type="month" value={month} max={max} onChange={(e) => pick(e.target.value)} />
        </label>
        <button type="button" className="main-btn main-btn--secondary mr-step" onClick={() => pick(shiftMonth(month, 1))} disabled={month >= max} aria-label="다음 달">›</button>
        <span className="mr-filters-gap" />
        <button type="button" className="main-btn main-btn--secondary" onClick={() => window.location.assign(`/monthly-report?month=${month}`)} disabled={!data}>
          인쇄 / PDF 저장
        </button>
        <button type="button" className="main-btn main-btn--secondary" onClick={() => data && downloadMonthlyCsv(data)} disabled={!data}>
          엑셀(CSV) 다운로드
        </button>
      </div>
      {loading && <p className="main-loading" aria-live="polite">불러오는 중…</p>}
      {!loading && err && <p className="main-error" role="alert">{err}</p>}
      {!loading && data && <MonthlyReportSheet data={data} />}
    </div>
  );
}

/** 인쇄 화면 /monthly-report?month=YYYY-MM — 거래명세서(T-105)와 같은 툴바·인쇄 규칙(Statement.css) */
export function MonthlyReportPrint() {
  const [params] = useSearchParams();
  const month = params.get('month') || thisMonth();
  const { data, loading, err } = useMonthlyReport(month);
  useEffect(() => {
    if (data) document.title = `월정산_${data.month}`;
  }, [data]);
  return (
    <div className="stmt-page mr-print-page">
      <div className="stmt-toolbar no-print">
        <Link to="/" className="stmt-btn stmt-btn--ghost">← 돌아가기</Link>
        <div className="stmt-toolbar-actions">
          <button type="button" className="stmt-btn stmt-btn--ghost" onClick={() => data && downloadMonthlyCsv(data)} disabled={!data}>CSV</button>
          <button type="button" className="stmt-btn" onClick={() => window.print()} disabled={!data}>인쇄 / PDF 저장</button>
        </div>
      </div>
      <p className="stmt-hint no-print">휴대폰에서 보내려면: 인쇄 / PDF 저장 → 대상 "PDF로 저장" → 저장된 파일을 카카오톡·문자로 보내기</p>
      {loading && <p className="stmt-state" aria-live="polite">불러오는 중…</p>}
      {!loading && err && <p className="stmt-state stmt-state--error" role="alert">{err}</p>}
      {!loading && data && <MonthlyReportSheet data={data} />}
    </div>
  );
}
