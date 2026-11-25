// T-203 매입서 대조 탭 — ③ 매입서(업로드·목록·대조 결과) ④ 검토 대기 ⑤ 대조 설정 (설계 6.4~6.6)
// "매입 등록(매입전환)" = 대조된 매입서 줄로 판매툴 매입 기록을 만드는 것. 기존 "매입→판매 전환"과 다른 기능(U-12)
// 잠금(T-404): 목록 조건·탭 전환은 useLatestRequest, 줄 버튼은 useBusyIds, 창은 guardClose, 요청 중 다른 화면 이동 잠금
import { useCallback, useEffect, useId, useState } from 'react';
import { purchaseDocApi } from '../lib/purchaseDocApi';
import { getUser } from '../api';
import { can } from '../lib/staffAccess';
import { newIdempotencyKey, withIdempotency } from '../lib/idempotency';
import { useBusyIds, useLatestRequest } from '../components/Busy';
import { ErrorLine, SubNav, Tone } from '../components/MatchBits';
import PurchaseDocUpload from '../components/PurchaseDocUpload';
import ReviewQueue from '../components/ReviewQueue';
import { LineEditModal, MatchCandidateModal, ReasonModal, lineTitle } from '../components/MatchCandidateModal';
import MatchSettings from './MatchSettings';
import {
  CONVERT_RESULT, DOC_STATUS, LINE_STATUS, MATCH_RESULT, MODE_LABEL,
  countsText, dec, kstAddDays, kstTime, kstToday, md, normLine, reasonText, won,
} from '../lib/matchLabels';
import './PurchaseMatch.css';

const LIMIT = 50;
const MAX_CONVERT = 200;

export default function TabPurchaseDocs({ navFilter, onNavigate }) {
  const [view, setView] = useState(navFilter?.doc_id ? { name: 'docs', docId: navFilter.doc_id } : { name: 'docs' });
  const [reviewCount, setReviewCount] = useState(null);
  const [navBusy, setNavBusy] = useState(false); // 하위 화면에서 요청 중이면 보기 전환 잠금

  const loadCount = useCallback(() => {
    purchaseDocApi.review({ limit: 1, offset: 0 }).then((r) => setReviewCount(r.total ?? null)).catch(() => {});
  }, []);
  useEffect(() => {
    loadCount();
  }, [loadCount]);

  return (
    <div className="pm" data-testid="pdoc-tab">
      <SubNav
        label="매입서 대조 화면"
        value={view.name}
        busy={navBusy}
        testidPrefix="pdoc-view"
        onChange={(name) => setView({ name })}
        items={[
          { id: 'docs', label: '매입서' },
          { id: 'review', label: '검토 대기', count: reviewCount },
          { id: 'settings', label: '대조 설정' },
        ]}
      />
      {view.name === 'docs' && !view.docId && <DocList onOpen={(docId) => setView({ name: 'docs', docId })} onChanged={loadCount} />}
      {view.name === 'docs' && view.docId && (
        <DocDetail id={view.docId} onBack={() => setView({ name: 'docs' })} onChanged={loadCount} onBusy={setNavBusy} onNavigate={onNavigate} />
      )}
      {view.name === 'review' && <ReviewQueue busyNav={navBusy} onOpenDoc={(docId) => setView({ name: 'docs', docId })} onChanged={loadCount} />}
      {view.name === 'settings' && <MatchSettings />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function DocList({ onOpen, onChanged }) {
  const today = kstToday();
  const ids = { from: useId(), to: useId(), st: useId(), q: useId() };
  const [cond, setCond] = useState({ date_from: kstAddDays(today, -23), date_to: today, status: '', q: '' });
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [saved, setSaved] = useState(null);
  const latest = useLatestRequest();

  const load = useCallback(
    async (c, off) => {
      const t = latest.next();
      setLoading(true);
      setErr(null);
      try {
        const r = await purchaseDocApi.list({ ...c, q: c.q.trim(), limit: LIMIT, offset: off });
        if (!latest.isCurrent(t)) return;
        setRows(r.data || []);
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
    latest.invalidate();
    setLoading(false);
    setCond((c) => ({ ...c, ...patch }));
  };
  const search = (e) => {
    e?.preventDefault();
    setOffset(0);
    load(cond, 0);
  };

  return (
    <section className="pm-section" aria-label="매입서 목록">
      <PurchaseDocUpload
        onSaved={(result) => {
          setSaved(result);
          load(cond, 0);
          onChanged?.();
        }}
      />
      {saved && <SavedSummary result={saved} onOpen={onOpen} onClose={() => setSaved(null)} />}
      <form className="main-filters pm-filters" onSubmit={search} data-testid="pdoc-filters">
        <label htmlFor={ids.from}>
          기간
          <input id={ids.from} type="date" value={cond.date_from} max={today} onChange={(e) => change({ date_from: e.target.value })} />
        </label>
        <span aria-hidden="true">~</span>
        <label htmlFor={ids.to}>
          <span className="pm-sr">끝 날짜</span>
          <input id={ids.to} type="date" value={cond.date_to} max={today} onChange={(e) => change({ date_to: e.target.value })} />
        </label>
        <label htmlFor={ids.st}>
          상태
          <select id={ids.st} value={cond.status} onChange={(e) => change({ status: e.target.value })} data-testid="pdoc-filter-status">
            <option value="">전체</option>
            {Object.entries(DOC_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </label>
        <label htmlFor={ids.q}>
          검색
          <input id={ids.q} type="search" value={cond.q} maxLength={50} placeholder="매입서번호·품목" onChange={(e) => change({ q: e.target.value })} data-testid="pdoc-filter-q" />
        </label>
        <button type="submit" className="main-btn" disabled={loading} aria-busy={loading} data-testid="pdoc-search">{loading ? '조회 중…' : '조회'}</button>
      </form>
      <ErrorLine error={err} />
      <div className="main-table-wrap pm-table-wrap">
        <table className="main-table pm-table" data-testid="pdoc-list">
          <thead>
            <tr>
              <th>매입서번호</th>
              <th>거래일</th>
              <th>제공처</th>
              <th className="pm-num">줄수</th>
              <th className="pm-num">합계</th>
              <th>상태 <span className="pm-muted">(전환/대기/보류/아님/취소)</span></th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!loading && rows.length === 0 && <tr><td colSpan={7} className="main-empty">매입서가 없습니다. [파일 올리기] 또는 [직접 입력]으로 넣어 주세요.</td></tr>}
            {rows.map((d) => (
              <tr key={d.id} data-testid={`pdoc-row-${d.id}`}>
                <td data-label="매입서번호">{d.doc_no || `#${d.id}`}</td>
                <td data-label="거래일">{md(d.doc_date)}</td>
                <td data-label="제공처">{d.supplier_name || '-'}</td>
                <td className="pm-num" data-label="줄수">{won(d.line_count)}</td>
                <td className="pm-num" data-label="합계">{won(d.amount_total)}</td>
                <td data-label="상태">
                  <Tone tone={DOC_STATUS[d.status]?.tone}>{DOC_STATUS[d.status]?.label || d.status}</Tone> <span className="pm-counts">{countsText(d.counts || d)}</span>
                </td>
                <td><button type="button" className="main-btn main-btn--secondary" onClick={() => onOpen(d.id)} data-testid={`pdoc-open-${d.id}`}>열기</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > 0 && (
        <nav className="list-pager pm-pager" aria-label="매입서 목록 페이지">
          <span role="status">총 <strong>{won(total)}</strong>건 ({Math.floor(offset / LIMIT) + 1}/{Math.max(1, Math.ceil(total / LIMIT))}쪽)</span>
          <button type="button" className="main-btn main-btn--secondary" disabled={loading || offset === 0} onClick={() => { const o = Math.max(0, offset - LIMIT); setOffset(o); load(cond, o); }}>‹ 이전</button>
          <button type="button" className="main-btn main-btn--secondary" disabled={loading || offset + LIMIT >= total} onClick={() => { const o = offset + LIMIT; setOffset(o); load(cond, o); }}>다음 ›</button>
        </nav>
      )}
    </section>
  );
}

/** 저장 직후 요약(R-118 응답) */
function SavedSummary({ result, onOpen, onClose }) {
  const s = result.summary || {};
  const docs = result.docs || [];
  return (
    <div className="pm-saved" role="status" data-testid="pdoc-saved-summary">
      <p>
        매입서 {docs.length}건을 저장하고 대조했습니다 — 완전 {won(s.exact)} · 부분 {won(s.partial)} · 미매칭 {won(s.unmatched)} · 바로 매입 등록 {won(s.auto_converted)}
      </p>
      <span className="pm-actions">
        {docs.slice(0, 5).map((d) => (
          <button key={d.id} type="button" className="main-btn main-btn--secondary" onClick={() => onOpen(d.id)}>#{d.id} 열기</button>
        ))}
        <button type="button" className="pm-link" onClick={onClose} aria-label="요약 닫기">닫기</button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
function DocDetail({ id, onBack, onChanged, onBusy, onNavigate }) {
  const user = getUser();
  const isOwner = !user?.staff;
  const canConvert = can('purchase_doc.convert');
  const canMatch = can('purchase_doc.match');
  const canEdit = can('purchase_doc.edit');
  const canCancel = can('purchase_doc.cancel');
  const [doc, setDoc] = useState(null);
  const [lines, setLines] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [results, setResults] = useState({}); // line_id → R-127 결과
  const [bulk, setBulk] = useState(false);
  const [docBusy, setDocBusy] = useState(''); // match
  const [cand, setCand] = useState(null);
  const [edit, setEdit] = useState(null);
  const [reasonBox, setReasonBox] = useState(null); // { kind: 'line'|'doc', line? }
  const [events, setEvents] = useState(null);
  const [showEvents, setShowEvents] = useState(false);
  const rowBusy = useBusyIds();
  const latest = useLatestRequest();
  const anyBusy = bulk || !!docBusy || rowBusy.any;

  useEffect(() => {
    onBusy?.(anyBusy);
    return () => onBusy?.(false);
  }, [anyBusy, onBusy]);

  const load = useCallback(async () => {
    const t = latest.next();
    setLoading(true);
    setErr(null);
    try {
      const r = await purchaseDocApi.get(id);
      if (!latest.isCurrent(t)) return;
      const d = r.data || {};
      setDoc(d);
      setLines((d.lines || []).map(normLine));
      setSel(new Set());
    } catch (e) {
      if (latest.isCurrent(t)) setErr(e);
    } finally {
      if (latest.isCurrent(t)) setLoading(false);
    }
  }, [id, latest]);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const after = () => {
    load();
    onChanged?.();
    if (showEvents) loadEvents();
  };
  const loadEvents = async () => {
    try {
      const r = await purchaseDocApi.events(id, { limit: 100, offset: 0 });
      setEvents(r.data || []);
    } catch (e) {
      setEvents([]);
      setMsg({ tone: 'bad', text: e.message });
    }
  };

  const convertable = lines.filter((l) => l.convertible);
  const toggle = (lid) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(lid)) n.delete(lid);
      else if (n.size < MAX_CONVERT) n.add(lid);
      return n;
    });

  const showResults = (list) => {
    const m = {};
    for (const x of list || []) m[x.line_id] = x;
    setResults((r) => ({ ...r, ...m }));
    const ok = (list || []).filter((x) => x.result === 'CONVERTED').length;
    const already = (list || []).filter((x) => x.result === 'ALREADY_CONVERTED').length;
    const fail = (list || []).length - ok - already;
    setMsg({ tone: fail ? 'warn' : 'ok', text: `매입 등록 ${ok}건${already ? ` · 이미 등록 ${already}건` : ''}${fail ? ` · 안 됨 ${fail}건(줄의 사유 확인)` : ''}` });
  };

  /** [매입 등록] 한 줄 — 클릭 하나에 키 하나, 409 RETRY 는 같은 키로 1회 */
  const convertOne = async (l) => {
    if (bulk || !rowBusy.start(`cv:${l.id}`)) return;
    setMsg(null);
    try {
      const r = await withIdempotency((key) => purchaseDocApi.convert([l.id], key), newIdempotencyKey('cv'));
      showResults(r.data?.results);
      after();
    } catch (e) {
      setMsg({ tone: 'bad', text: e.message });
    } finally {
      rowBusy.end(`cv:${l.id}`);
    }
  };
  const convertSelected = async () => {
    if (bulk || sel.size === 0) return;
    setBulk(true);
    setMsg(null);
    try {
      const r = await withIdempotency((key) => purchaseDocApi.convert([...sel], key), newIdempotencyKey('cvb'));
      showResults(r.data?.results);
      after();
    } catch (e) {
      setMsg({ tone: 'bad', text: e.message });
    } finally {
      setBulk(false);
    }
  };
  const rematchDoc = async () => {
    if (anyBusy) return;
    setDocBusy('match');
    setMsg(null);
    try {
      const r = await purchaseDocApi.match(id, false);
      const s = r.data?.summary || {};
      setMsg({ tone: 'ok', text: `다시 대조했습니다 — 완전 ${won(s.exact)} · 부분 ${won(s.partial)} · 미매칭 ${won(s.unmatched)}${s.skipped ? ` · 건너뜀(이미 등록) ${won(s.skipped)}` : ''}` });
      setResults({});
      after();
    } catch (e) {
      setMsg({ tone: 'bad', text: e.message });
    } finally {
      setDocBusy('');
    }
  };

  if (loading && !doc) return <p className="main-loading">매입서를 불러오는 중…</p>;
  if (err && !doc)
    return (
      <section className="pm-section">
        <button type="button" className="pm-link" onClick={onBack}>‹ 목록</button>
        <ErrorLine error={err} />
      </section>
    );
  const cancelled = doc?.status === 'CANCELLED';
  const hasActive = lines.some((l) => l.status === 'CONVERTED');

  return (
    <section className="pm-section" aria-label="대조 결과" data-testid="pdoc-detail">
      <div className="pm-detail-head">
        <button type="button" className="pm-link" onClick={onBack} disabled={anyBusy} data-testid="pdoc-back">‹ 목록</button>
        <h3 className="pm-h3">
          {doc.doc_no || `#${doc.id}`} · {md(doc.doc_date)} · {doc.supplier_name || '-'} ·{' '}
          <Tone tone={DOC_STATUS[doc.status]?.tone} testid="pdoc-detail-status">{DOC_STATUS[doc.status]?.label || doc.status}</Tone>
        </h3>
        <span className="pm-actions pm-head-right">
          {canMatch && !cancelled && (
            <button type="button" className="main-btn main-btn--secondary" onClick={rematchDoc} disabled={anyBusy} aria-busy={docBusy === 'match'} data-testid="pdoc-rematch">
              {docBusy === 'match' ? '대조 중…' : '다시 대조'}
            </button>
          )}
          {isOwner && canCancel && !cancelled && (
            <button
              type="button"
              className="main-btn main-btn--secondary pm-danger-text"
              onClick={() => setReasonBox({ kind: 'doc' })}
              disabled={anyBusy}
              title={hasActive ? '매입 등록된 줄이 있으면 먼저 줄의 전환을 취소해야 합니다' : ''}
              data-testid="pdoc-cancel-doc"
            >
              매입서 취소
            </button>
          )}
        </span>
      </div>
      {cancelled && <p className="pm-notice">취소한 매입서입니다. 대조·매입 등록을 할 수 없습니다.</p>}
      {msg && <p className={msg.tone === 'bad' ? 'pm-error' : msg.tone === 'warn' ? 'pm-warn' : 'pm-ok'} role={msg.tone === 'bad' ? 'alert' : 'status'} data-testid="pdoc-detail-msg">{msg.text}</p>}

      <div className="main-table-wrap pm-table-wrap">
        <table className="main-table pm-table" data-testid="pdoc-lines">
          <thead>
            <tr>
              <th className="main-col-check"><span className="pm-sr">선택</span></th>
              <th>줄</th>
              <th>품목·등급·규격</th>
              <th className="pm-num">수량</th>
              <th className="pm-num">단가</th>
              <th className="pm-num">금액</th>
              <th>판정</th>
              <th className="pm-num">점수</th>
              <th>상태</th>
              <th>동작</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const res = results[l.id];
              const busyCv = rowBusy.has(`cv:${l.id}`) || (bulk && sel.has(l.id));
              const notes = [...l.reason_codes, ...l.warnings];
              return [
                <tr key={l.id} className={l.status === 'CONVERTED' ? 'pm-row-done' : ''} data-testid={`pdoc-line-${l.id}`}>
                  <td className="main-col-check">
                    {l.convertible && canConvert && !cancelled && (
                      <input type="checkbox" aria-label={`${l.line_no}줄 선택`} checked={sel.has(l.id)} disabled={bulk} onChange={() => toggle(l.id)} data-testid={`pdoc-line-check-${l.id}`} />
                    )}
                  </td>
                  <td data-label="줄">{l.line_no}</td>
                  <td data-label="품목">
                    {l.item_name} {l.grade} {l.spec}
                    {l.item_key == null && <Tone tone="bad" title={reasonText('ITEM_UNMAPPED')}>품목 미확인</Tone>}
                  </td>
                  <td className="pm-num" data-label="수량">{dec(l.qty)}</td>
                  <td className="pm-num" data-label="단가">{won(l.unit_price)}</td>
                  <td className="pm-num" data-label="금액">{won(l.amount)}</td>
                  <td data-label="판정">{l.match_result ? <Tone tone={MATCH_RESULT[l.match_result]?.tone}>{MATCH_RESULT[l.match_result]?.label || l.match_result}</Tone> : '-'}</td>
                  <td className="pm-num" data-label="점수">{l.score ?? '-'}</td>
                  <td data-label="상태">
                    <Tone tone={l.convertible ? 'ok' : LINE_STATUS[l.status]?.tone} testid={`pdoc-line-status-${l.id}`}>
                      {l.convertible ? '전환 가능' : LINE_STATUS[l.status]?.label || l.status}
                    </Tone>
                    {l.status === 'CONVERTED' && l.purchase_id && (
                      <span className="pm-muted"> #{l.purchase_id}{l.conversion_mode ? ` ${MODE_LABEL[l.conversion_mode] || ''}` : ''}</span>
                    )}
                  </td>
                  <td data-label="동작"><div className="pm-actions">
                    {l.convertible && canConvert && !cancelled && (
                      <button type="button" className="main-btn" disabled={busyCv || bulk} aria-busy={busyCv} onClick={() => convertOne(l)} data-testid={`pdoc-line-convert-${l.id}`}>
                        {busyCv ? '등록 중…' : '매입 등록'}
                      </button>
                    )}
                    {!cancelled && l.status !== 'CONVERTED' && !l.convertible && (
                      <button type="button" className="main-btn main-btn--secondary" disabled={anyBusy} onClick={() => setCand({ ...l, supplier_name: doc.supplier_name })} data-testid={`pdoc-line-cand-${l.id}`}>후보 보기</button>
                    )}
                    {canEdit && !cancelled && l.status !== 'CONVERTED' && (
                      <button type="button" className="main-btn main-btn--secondary" disabled={anyBusy} onClick={() => setEdit(l)} data-testid={`pdoc-line-edit-${l.id}`}>수정</button>
                    )}
                    {l.status === 'CONVERTED' && isOwner && canCancel && (
                      <button type="button" className="main-btn main-btn--secondary pm-danger-text" disabled={anyBusy} onClick={() => setReasonBox({ kind: 'line', line: l })} data-testid={`pdoc-line-cancel-${l.id}`}>전환 취소</button>
                    )}
                    {l.status === 'CONVERTED' && onNavigate && (
                      <button type="button" className="pm-link" disabled={anyBusy} onClick={() => onNavigate('purchases', null)} title="매입정보 탭에서 이 매입을 봅니다">매입정보</button>
                    )}
                  </div></td>
                </tr>,
                (notes.length > 0 || res) && (
                  <tr key={`${l.id}-n`} className="pm-subrow">
                    <td />
                    <td colSpan={9}>
                      {notes.length > 0 && <span>└ 사유: {notes.map(reasonText).join(' · ')}{l.candidate_count > 1 ? ` (후보 ${l.candidate_count}건)` : ''}</span>}
                      {res && (
                        <span className={res.result === 'CONVERTED' || res.result === 'ALREADY_CONVERTED' ? 'pm-ok-text' : 'pm-bad-text'} data-testid={`pdoc-line-result-${l.id}`}>
                          {' '}· 결과: {CONVERT_RESULT[res.result] || res.result}
                          {res.purchase_id ? ` #${res.purchase_id}` : ''}
                          {res.message ? ` — ${res.message}` : ''}
                          {res.detail?.message ? ` — ${res.detail.message}` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>

      {canConvert && !cancelled && convertable.length > 0 && (
        <div className="pm-bulk">
          <label className="main-filter-checkbox">
            <input
              type="checkbox"
              checked={sel.size > 0 && sel.size === Math.min(convertable.length, MAX_CONVERT)}
              disabled={bulk}
              onChange={(e) => setSel(e.target.checked ? new Set(convertable.slice(0, MAX_CONVERT).map((l) => l.id)) : new Set())}
              data-testid="pdoc-check-all"
            />
            전환 가능한 줄 모두 선택({convertable.length})
          </label>
          <button type="button" className="main-btn" disabled={bulk || sel.size === 0 || rowBusy.any} aria-busy={bulk} onClick={convertSelected} data-testid="pdoc-convert-selected">
            {bulk ? '매입 등록 중…' : `선택한 줄 매입 등록 (${sel.size})`}
          </button>
          <span className="pm-muted">완전일치(허용오차 안·확정 경락)인 줄만 고를 수 있습니다. 그 밖은 [후보 보기]에서 주인이 확정합니다.</span>
        </div>
      )}

      <details className="pm-events" onToggle={(e) => { setShowEvents(e.currentTarget.open); if (e.currentTarget.open && events == null) loadEvents(); }} data-testid="pdoc-events">
        <summary>이력(누가·언제·어떤 기준으로)</summary>
        {events == null ? (
          <p className="main-loading">불러오는 중…</p>
        ) : events.length === 0 ? (
          <p className="pm-muted">이력 없음</p>
        ) : (
          <ul className="pm-event-list">
            {events.map((ev) => (
              <li key={ev.id}>
                <span className="pm-muted">{kstTime(ev.created_at)}</span> <b>{ev.event_type}</b> {ev.line_no ? `${ev.line_no}줄` : ''} · {ev.actor_name || (ev.actor_type === 'SYSTEM' ? '시스템' : '-')}
                {ev.score != null && ` · 점수 ${ev.score}`}
                {ev.reason && ` · ${ev.reason}`}
              </li>
            ))}
          </ul>
        )}
      </details>

      {cand && (
        <MatchCandidateModal
          line={cand}
          onClose={() => setCand(null)}
          onLine={(nl) => setCand((c) => ({ ...c, ...nl }))}
          onDone={(r) => {
            setCand(null);
            setMsg({ tone: 'ok', text: `매입 등록했습니다(매입 #${r.purchase_id ?? '-'}, ${MODE_LABEL[r.mode] || r.mode || ''}).` });
            after();
          }}
        />
      )}
      {edit && (
        <LineEditModal
          line={edit}
          onClose={() => setEdit(null)}
          onSaved={(r) => {
            setEdit(null);
            const n = normLine(r.line || r);
            setMsg({ tone: 'ok', text: `${edit.line_no}줄을 고치고 다시 대조했습니다: ${LINE_STATUS[n.status]?.label || '완료'}` });
            after();
          }}
        />
      )}
      {reasonBox?.kind === 'line' && (
        <ReasonModal
          title="전환 취소"
          sub={`${reasonBox.line.line_no}줄 · ${lineTitle(reasonBox.line)} → 판매툴 매입 #${reasonBox.line.purchase_id ?? '-'}을 취소합니다(재고·미지급도 되돌림).`}
          confirmLabel="전환 취소"
          placeholder="예: 단가 오기"
          testid="pdoc-cancel-line"
          danger
          onClose={() => setReasonBox(null)}
          onSubmit={async (reason) => {
            await withIdempotency((key) => purchaseDocApi.cancelLine(reasonBox.line.id, reason, key), newIdempotencyKey('cl'));
            setReasonBox(null);
            setMsg({ tone: 'ok', text: `${reasonBox.line.line_no}줄의 매입 등록을 취소했습니다. [다시 대조] 뒤 다시 등록할 수 있습니다.` });
            setResults({});
            after();
          }}
        />
      )}
      {reasonBox?.kind === 'doc' && (
        <ReasonModal
          title="매입서 취소"
          sub={`${doc.doc_no || `#${doc.id}`} 전체를 취소합니다. 취소한 매입서는 다시 대조·등록할 수 없습니다.`}
          confirmLabel="매입서 취소"
          placeholder="예: 중복 업로드"
          testid="pdoc-cancel-doc-modal"
          danger
          onClose={() => setReasonBox(null)}
          onSubmit={async (reason) => {
            await withIdempotency((key) => purchaseDocApi.cancelDoc(id, reason, key), newIdempotencyKey('cd'));
            setReasonBox(null);
            setMsg({ tone: 'ok', text: '매입서를 취소했습니다.' });
            after();
          }}
        />
      )}
    </section>
  );
}
