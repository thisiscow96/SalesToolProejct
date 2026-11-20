import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import './Statement.css';

// 거래명세서 (T-105) — 매출 탭에서 거래처·기간을 고른 뒤 이 화면으로 온다.
// 인쇄(브라우저 인쇄 → "PDF로 저장")와 휴대폰 공유(navigator.share, 지원 브라우저만)를 제공한다.
// 새 의존성·외부 서비스 없이 브라우저 기능만 쓴다.

// api.js 와 같은 규칙: 로컬은 Vite 프록시 '/api', 배포는 VITE_API_URL
const isLocalhost =
  typeof window !== 'undefined' &&
  (window.location.origin.startsWith('http://localhost:') ||
    window.location.origin.startsWith('http://127.0.0.1:'));
const API_BASE = isLocalhost
  ? '/api'
  : import.meta.env.VITE_API_URL
    ? import.meta.env.VITE_API_URL.replace(/\/$/, '') + '/api'
    : '/api';

function readToken() {
  try {
    const s = window.sessionStorage.getItem('user');
    return s ? JSON.parse(s)?.token || null : null;
  } catch {
    return null;
  }
}

function won(n) {
  if (n == null || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return String(n);
  return num.toLocaleString('ko-KR');
}

function qty(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return num.toLocaleString('ko-KR', { maximumFractionDigits: 3 });
}

/** 수량+단위 — 단위가 '10kg'처럼 숫자로 시작하면 '1 × 10kg' 로 써서 '1 10kg' 처럼 붙어 읽히지 않게 */
function qtyUnit(n, unit) {
  const u = String(unit || '').trim();
  if (!u) return qty(n);
  return /^\d/.test(u) ? `${qty(n)} × ${u}` : `${qty(n)} ${u}`;
}

function ymd(v) {
  if (!v) return '';
  return String(v).slice(0, 10);
}

const PAY_LABEL = { paid: '완료', partial: '일부', unpaid: '미수' };

function periodText(from, to) {
  return from === to ? from : `${from} ~ ${to}`;
}

/** 공유용 글 — 받는 사람은 로그인할 수 없으므로 링크 대신 내용 요약을 보낸다 */
function buildShareText(d) {
  const lines = [
    `[거래명세서] ${d.partner.name} 귀하`,
    `기간: ${periodText(d.from_date, d.to_date)}`,
    `공급자: ${d.supplier?.name || ''}${d.supplier?.agent_no ? ` (중매 ${d.supplier.agent_no})` : ''}`,
    '',
    ...d.items.map(
      (it) => `${ymd(it.sale_date)} ${it.product_name} ${qtyUnit(it.quantity, it.unit)} × ${won(it.unit_price)} = ${won(it.total_amount)}원`,
    ),
    '',
    // 미수 = 합계 − 반품 − 수금 (서버와 같은 식, T-219 R-07)
    `합계 ${won(d.totals.total_amount)}원${Number(d.totals.returned_amount) > 0 ? ` · 반품 ${won(d.totals.returned_amount)}원` : ''} · 수금 ${won(d.totals.paid_amount)}원 · 미수 ${won(d.totals.unpaid_amount)}원`,
  ];
  return lines.join('\n');
}

export default function Statement() {
  const [params] = useSearchParams();
  const partnerId = params.get('partner_id') || '';
  const from = params.get('from_date') || params.get('from') || params.get('date') || '';
  const to = params.get('to_date') || params.get('to') || params.get('date') || '';

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const q = new URLSearchParams();
    if (partnerId) q.set('partner_id', partnerId);
    if (from) q.set('from_date', from);
    if (to) q.set('to_date', to);
    const token = readToken();
    setLoading(true);
    setErr('');
    fetch(`${API_BASE}/sales/statement?${q.toString()}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (res.status === 401) {
          try { window.sessionStorage.removeItem('user'); } catch { /* 무시 */ }
          window.location.href = '/login';
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.message || '거래명세서를 불러오지 못했습니다.');
        setData(body.data);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [partnerId, from, to]);

  useEffect(() => {
    if (data) document.title = `거래명세서_${data.partner.name}_${periodText(data.from_date, data.to_date)}`;
  }, [data]);

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  const share = async () => {
    if (!data) return;
    if (!canShare) {
      setNotice('이 브라우저는 바로 공유를 지원하지 않습니다. "인쇄 / PDF 저장"에서 대상(프린터)을 "PDF로 저장"으로 고른 뒤 저장된 파일을 보내세요.');
      return;
    }
    try {
      await navigator.share({ title: document.title, text: buildShareText(data) });
      setNotice('');
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 사용자가 공유 창을 닫음
      setNotice('공유하지 못했습니다. "인쇄 / PDF 저장"으로 PDF를 만든 뒤 보내세요.');
    }
  };

  const hasRefund = useMemo(() => !!data && data.items.some((it) => Number(it.refunded_qty) > 0), [data]);

  return (
    <div className="stmt-page">
      <div className="stmt-toolbar no-print">
        <Link to="/" className="stmt-btn stmt-btn--ghost">← 매출로 돌아가기</Link>
        <div className="stmt-toolbar-actions">
          <button type="button" className="stmt-btn stmt-btn--ghost" onClick={share} disabled={!data}>
            공유
          </button>
          <button type="button" className="stmt-btn" onClick={() => window.print()} disabled={!data}>
            인쇄 / PDF 저장
          </button>
        </div>
      </div>
      {notice && <p className="stmt-notice no-print" role="status">{notice}</p>}
      {!canShare && data && (
        <p className="stmt-hint no-print">
          휴대폰에서 보내려면: 인쇄 / PDF 저장 → 대상 "PDF로 저장" → 저장된 파일을 카카오톡·문자로 보내기
        </p>
      )}

      {loading && <p className="stmt-state" aria-live="polite">불러오는 중…</p>}
      {!loading && err && <p className="stmt-state stmt-state--error" role="alert">{err}</p>}

      {!loading && data && (
        <article className="stmt-sheet" aria-label="거래명세서">
          <header className="stmt-head">
            <h1 className="stmt-title">거 래 명 세 서</h1>
            <p className="stmt-sub">
              기간 {periodText(data.from_date, data.to_date)} · 발행일 {data.issued_on}
            </p>
          </header>

          <section className="stmt-parties">
            <div className="stmt-party">
              <h2>공급자</h2>
              <dl>
                <dt>상호(성명)</dt><dd>{data.supplier?.name || '—'}</dd>
                <dt>중매인 번호</dt><dd>{data.supplier?.agent_no || '—'}</dd>
                <dt>연락처</dt><dd>{data.supplier?.phone || '—'}</dd>
              </dl>
            </div>
            <div className="stmt-party">
              <h2>받는 자</h2>
              <dl>
                <dt>상호</dt><dd>{data.partner.name} 귀하</dd>
                <dt>담당·연락처</dt>
                <dd>{[data.partner.contact, data.partner.phone].filter(Boolean).join(' · ') || '—'}</dd>
                <dt>납품지·주소</dt>
                <dd>{[data.partner.location, data.partner.address].filter(Boolean).join(' · ') || '—'}</dd>
              </dl>
            </div>
          </section>

          <div className="stmt-total-line">
            합계 금액 <strong>{won(data.totals.total_amount)}원</strong>
          </div>

          {data.items.length === 0 ? (
            <p className="stmt-state">이 기간에 거래 내역이 없습니다.</p>
          ) : (
            <table className="stmt-table">
              <thead>
                <tr>
                  <th scope="col">일자</th>
                  <th scope="col">품목</th>
                  <th scope="col" className="num">수량</th>
                  <th scope="col" className="num">단가</th>
                  <th scope="col" className="num">금액</th>
                  <th scope="col" className="stmt-col-status">수금</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id}>
                    <td data-label="일자">{ymd(it.sale_date)}</td>
                    <td data-label="품목" className="stmt-col-product">
                      {it.product_name}
                      {Number(it.refunded_qty) > 0 && (
                        <span className="stmt-refund"> (환불 {qtyUnit(it.refunded_qty, it.unit)})</span>
                      )}
                    </td>
                    <td data-label="수량" className="num">{qtyUnit(it.quantity, it.unit)}</td>
                    <td data-label="단가" className="num">{won(it.unit_price)}</td>
                    <td data-label="금액" className="num">{won(it.total_amount)}</td>
                    <td data-label="수금" className="stmt-col-status">
                      {it.status === 'refunded' ? '환불' : PAY_LABEL[it.payment_status] || it.payment_status}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={4}>합계 ({data.totals.count}건)</th>
                  <td className="num">{won(data.totals.total_amount)}</td>
                  <td className="stmt-col-status" />
                </tr>
                {Number(data.totals.returned_amount) > 0 && (
                  <tr>
                    <th scope="row" colSpan={4}>반품액</th>
                    <td className="num">−{won(data.totals.returned_amount)}</td>
                    <td className="stmt-col-status" />
                  </tr>
                )}
                <tr>
                  <th scope="row" colSpan={4}>수금액</th>
                  <td className="num">{won(data.totals.paid_amount)}</td>
                  <td className="stmt-col-status" />
                </tr>
                <tr className="stmt-unpaid">
                  <th scope="row" colSpan={4}>미수금</th>
                  <td className="num">{won(data.totals.unpaid_amount)}</td>
                  <td className="stmt-col-status" />
                </tr>
              </tfoot>
            </table>
          )}

          <footer className="stmt-foot">
            {hasRefund && <p>환불 수량은 저장된 환불 기록 그대로 표시했습니다. 금액·수금액은 매출에 저장된 값입니다.</p>}
            <p>위와 같이 거래하였음을 확인합니다.</p>
          </footer>
        </article>
      )}
    </div>
  );
}
