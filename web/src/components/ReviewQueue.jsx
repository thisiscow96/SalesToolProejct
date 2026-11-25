// T-203 ④ 검토 대기 (설계 6.5) — R-121 목록 · R-122 후보 · R-128 수동 확정 · R-129 매입 아님 · R-125 다시 대조
// 잠금(T-404): 조건을 바꾸면 늦은 응답 버림(useLatestRequest), 행 버튼은 useBusyIds
import { useCallback, useEffect, useId, useState } from 'react';
import { purchaseDocApi } from '../lib/purchaseDocApi';
import { can } from '../lib/staffAccess';
import { useBusyIds, useLatestRequest } from './Busy';
import { ErrorLine, Tone } from './MatchBits';
import { MatchCandidateModal, ReasonModal, lineTitle } from './MatchCandidateModal';
import { LINE_STATUS, REVIEW_FILTER, dec, kstAddDays, kstToday, md, normLine, reasonText, won } from '../lib/matchLabels';

const LIMIT = 50;
const WAIT_ONLY = new Set(['BASE_NOT_READY', 'BASE_NOT_FINAL']);

export default function ReviewQueue({ onOpenDoc, onChanged, busyNav }) {
  const today = kstToday();
  const ids = { reason: useId(), from: useId(), to: useId() };
  const [cond, setCond] = useState({ reason: '', date_from: kstAddDays(today, -30), date_to: today });
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [cand, setCand] = useState(null);
  const [reject, setReject] = useState(null);
  const rowBusy = useBusyIds();
  const latest = useLatestRequest();
  const canReject = can('purchase_doc.reject');
  const canMatch = can('purchase_doc.match');

  const load = useCallback(
    async (c, off) => {
      const t = latest.next();
      setLoading(true);
      setErr(null);
      try {
        const r = await purchaseDocApi.review({ ...c, limit: LIMIT, offset: off });
        if (!latest.isCurrent(t)) return;
        setRows((r.data || []).map(normLine));
        setTotal(r.total || 0);
      } catch (e) {
        if (latest.isCurrent(t)) setErr(e);
      } finally {
        if (latest.isCurrent(t)) setLoading(false);
      }
    },
    [latest],
  );
  useEffect(() => {
    load(cond, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (patch) => {
    const c = { ...cond, ...patch };
    setCond(c);
    setOffset(0);
    load(c, 0); // 이전 조건 응답은 latest 순번으로 버려진다
  };
  const refresh = () => {
    load(cond, offset);
    onChanged?.();
  };

  const rematch = async (l) => {
    if (!rowBusy.start(l.id)) return;
    setMsg(null);
    try {
      const r = await purchaseDocApi.rematchLine(l.id);
      const n = normLine(r.data?.line || r.data || {});
      setMsg({ tone: 'ok', text: `${l.doc_no || ''}-${l.line_no}줄을 다시 대조했습니다: ${LINE_STATUS[n.status]?.label || n.status || '완료'}` });
      refresh();
    } catch (e) {
      setMsg({ tone: 'bad', text: e.message });
    } finally {
      rowBusy.end(l.id);
    }
  };

  return (
    <section className="pm-section" aria-label="검토 대기" data-testid="pdoc-review">
      <div className="main-filters pm-filters">
        <label htmlFor={ids.reason}>
          사유
          <select id={ids.reason} value={cond.reason} onChange={(e) => change({ reason: e.target.value })} data-testid="pdoc-review-reason">
            {REVIEW_FILTER.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
        <label htmlFor={ids.from}>
          거래일
          <input id={ids.from} type="date" value={cond.date_from} max={today} onChange={(e) => change({ date_from: e.target.value })} />
        </label>
        <span aria-hidden="true">~</span>
        <label htmlFor={ids.to}>
          <span className="pm-sr">끝 날짜</span>
          <input id={ids.to} type="date" value={cond.date_to} max={today} onChange={(e) => change({ date_to: e.target.value })} />
        </label>
        <button type="button" className="main-btn main-btn--secondary" onClick={refresh} disabled={loading}>{loading ? '불러오는 중…' : '새로고침'}</button>
      </div>
      <ErrorLine error={err} />
      {msg && <p className={msg.tone === 'bad' ? 'pm-error' : 'pm-ok'} role={msg.tone === 'bad' ? 'alert' : 'status'} data-testid="pdoc-review-msg">{msg.text}</p>}

      <div className="main-table-wrap pm-table-wrap">
        <table className="main-table pm-table" data-testid="pdoc-review-table">
          <thead>
            <tr>
              <th>거래일</th>
              <th>매입서-줄</th>
              <th>품목</th>
              <th>사유</th>
              <th>차이</th>
              <th>동작</th>
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && <tr><td colSpan={6} className="main-empty">검토 대기 줄이 없습니다.</td></tr>}
            {rows.map((l) => {
              const waitOnly = l.reason_codes.length > 0 && l.reason_codes.every((c) => WAIT_ONLY.has(c));
              const d = l.top_diff || l.diff || {};
              return (
                <tr key={l.id} data-testid={`pdoc-review-row-${l.id}`}>
                  <td data-label="거래일">{md(l.trade_date)}</td>
                  <td data-label="매입서-줄">
                    <button type="button" className="pm-link" disabled={busyNav || rowBusy.any} onClick={() => onOpenDoc(l.doc_id)} data-testid={`pdoc-review-open-${l.id}`}>
                      {l.doc_no || `#${l.doc_id}`}-{l.line_no}
                    </button>
                  </td>
                  <td data-label="품목">{lineTitle(l)}</td>
                  <td data-label="사유">
                    <Tone tone={LINE_STATUS[l.status]?.tone || 'neutral'}>{LINE_STATUS[l.status]?.label || l.status}</Tone>{' '}
                    {[...l.reason_codes, ...l.warnings].map(reasonText).join(' · ') || '-'}
                    {l.candidate_count > 1 && ` (후보 ${l.candidate_count}건)`}
                  </td>
                  <td data-label="차이">
                    {d.price != null && Number(d.price) !== 0
                      ? `단가 ${Number(d.price) > 0 ? '+' : ''}${won(d.price)}원${d.price_pct != null ? ` (${Number(d.price_pct) > 0 ? '+' : ''}${dec(d.price_pct, 1)}%)` : ''}`
                      : '-'}
                  </td>
                  <td data-label="동작"><div className="pm-actions">
                    {waitOnly ? (
                      <span className="pm-muted">확정 수집 뒤 자동 재대조</span>
                    ) : (
                      <button type="button" className="main-btn main-btn--secondary" disabled={rowBusy.has(l.id)} onClick={() => setCand(l)} data-testid={`pdoc-review-cand-${l.id}`}>후보 보기</button>
                    )}
                    {canMatch && (
                      <button type="button" className="main-btn main-btn--secondary" disabled={rowBusy.has(l.id)} onClick={() => rematch(l)} data-testid={`pdoc-review-rematch-${l.id}`}>
                        {rowBusy.has(l.id) ? '대조 중…' : '다시 대조'}
                      </button>
                    )}
                    {canReject && l.status !== 'CONVERTED' && (
                      <button type="button" className="main-btn main-btn--secondary" disabled={rowBusy.has(l.id)} onClick={() => setReject(l)} data-testid={`pdoc-review-reject-${l.id}`}>매입 아님</button>
                    )}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {total > LIMIT && (
        <nav className="list-pager pm-pager" aria-label="검토 대기 페이지">
          <span role="status">총 <strong>{won(total)}</strong>건</span>
          <button type="button" className="main-btn main-btn--secondary" disabled={loading || offset === 0} onClick={() => { const o = Math.max(0, offset - LIMIT); setOffset(o); load(cond, o); }}>‹ 이전</button>
          <button type="button" className="main-btn main-btn--secondary" disabled={loading || offset + LIMIT >= total} onClick={() => { const o = offset + LIMIT; setOffset(o); load(cond, o); }}>다음 ›</button>
        </nav>
      )}

      {cand && (
        <MatchCandidateModal
          line={cand}
          onClose={() => setCand(null)}
          onLine={(nl) => setCand((c) => ({ ...c, ...nl }))}
          onDone={(r) => {
            setCand(null);
            setMsg({ tone: 'ok', text: `매입 등록했습니다(매입 #${r.purchase_id ?? '-'}, ${r.mode === 'FORCED' ? '강제 확정' : '수동 확정'}).` });
            refresh();
          }}
        />
      )}
      {reject && (
        <ReasonModal
          title="매입 아님"
          sub={`${reject.doc_no || ''}-${reject.line_no}줄 · ${lineTitle(reject)}`}
          confirmLabel="매입 아님으로 표시"
          placeholder="예: 다른 중매인 낙찰분"
          testid="pdoc-reject"
          onClose={() => setReject(null)}
          onSubmit={async (reason) => {
            await purchaseDocApi.reject(reject.id, reason);
            setReject(null);
            setMsg({ tone: 'ok', text: '매입 아님으로 표시했습니다.' });
            refresh();
          }}
        />
      )}
    </section>
  );
}
