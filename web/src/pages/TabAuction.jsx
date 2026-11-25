// T-203 경락 시세 탭 — ① 경락 조회 ② 수집 현황 (설계 6.2·6.3)
// 데이터: R-92(목록·meta·days) · R-93(상세) · R-94(참고 시세) · R-95(품종 선택지)
// 잠금(T-404): 조건을 바꾸면 useLatestRequest().invalidate() — 늦은 응답 버림, [조회] 요청 중 비활성
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { auctionApi } from '../lib/auctionApi';
import { useLatestRequest } from '../components/Busy';
import { ErrorLine, MatchModal, MockBadge, SubNav, Tone } from '../components/MatchBits';
import AuctionSyncStatus from './AuctionSyncStatus';
import {
  EMPTY_REASON, FAMILY, GRADE, GRADE_LABEL, PHASE_LABEL, SNAPSHOT_STATUS, SOURCE_LABEL,
  daysBetween, dec, kstAddDays, kstTime, kstToday, md, won,
} from '../lib/matchLabels';
import './PurchaseMatch.css';

const LIMIT = 50;

export default function TabAuction() {
  const [view, setView] = useState('trades');
  return (
    <div className="pm" data-testid="auction-tab">
      <SubNav
        label="경락 시세 화면"
        value={view}
        onChange={setView}
        testidPrefix="auction-view"
        items={[
          { id: 'trades', label: '경락 조회' },
          { id: 'sync', label: '수집 현황' },
        ]}
      />
      {view === 'trades' ? <AuctionTrades /> : <AuctionSyncStatus />}
    </div>
  );
}

function AuctionTrades() {
  const today = kstToday();
  const ids = { from: useId(), to: useId(), fam: useId(), grade: useId(), pkg: useId(), corp: useId(), origin: useId() };
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ date_from: today, date_to: today, family: 'PEPPER', item_key: [], grade: '', pkg: '', corp_code: '', origin: '', include_withdrawn: false });
  const [applied, setApplied] = useState(null); // 마지막으로 [조회]한 조건
  const [offset, setOffset] = useState(0);
  const [res, setRes] = useState(null);
  const [prices, setPrices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [formErr, setFormErr] = useState('');
  const [detailId, setDetailId] = useState(null);
  const latest = useLatestRequest();

  useEffect(() => {
    auctionApi.items().then((r) => setItems(r.data || [])).catch(() => setItems([]));
  }, []);

  const varieties = useMemo(
    () => items.filter((i) => i.active !== false && (!form.family || String(i.item_key).startsWith(form.family + '.'))),
    [items, form.family],
  );

  const run = useCallback(
    async (cond, off) => {
      const t = latest.next();
      setLoading(true);
      setErr(null);
      try {
        const params = {
          date_from: cond.date_from,
          date_to: cond.date_to,
          family: cond.family,
          item_key: cond.item_key,
          grade: cond.grade,
          pkg: cond.pkg,
          corp_code: cond.corp_code,
          origin: cond.origin.trim(),
          include_withdrawn: cond.include_withdrawn ? 'true' : '',
          limit: LIMIT,
          offset: off,
        };
        const [r, p] = await Promise.all([
          auctionApi.trades(params),
          auctionApi.dailyPrices({ date: cond.date_to, family: cond.family, item_key: cond.item_key }).catch(() => ({ data: [] })),
        ]);
        if (!latest.isCurrent(t)) return; // 조건이 바뀐 뒤 늦게 온 응답
        setRes(r);
        setPrices(p.data || []);
      } catch (e) {
        if (!latest.isCurrent(t)) return;
        setErr(e);
        setRes(null);
      } finally {
        if (latest.isCurrent(t)) setLoading(false);
      }
    },
    [latest],
  );

  // 처음 들어오면 오늘 고추로 한 번 조회
  useEffect(() => {
    const c = { ...form };
    setApplied(c);
    run(c, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (patch) => {
    latest.invalidate(); // 조건을 바꾸면 진행 중 응답은 버린다
    setLoading(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const submit = (e) => {
    e?.preventDefault();
    if (!form.date_from || !form.date_to || form.date_from > form.date_to) return setFormErr('기간을 바르게 지정하세요(시작 ≤ 끝).');
    if (daysBetween(form.date_from, form.date_to) > 30) return setFormErr('조회 기간은 31일 이내로 지정하세요.');
    setFormErr('');
    const c = { ...form };
    setApplied(c);
    setOffset(0);
    run(c, 0);
  };
  const page = (off) => {
    if (!applied || loading) return;
    setOffset(off);
    run(applied, off);
  };
  const toggleVariety = (key) =>
    change({ item_key: form.item_key.includes(key) ? form.item_key.filter((k) => k !== key) : [...form.item_key, key] });

  const rows = res?.data || [];
  const meta = res?.meta || {};
  const days = res?.days || [];
  const total = res?.total || 0;
  const corpOptions = useMemo(() => {
    const m = new Map();
    for (const r of rows) if (r.corp_code) m.set(r.corp_code, r.corp_name || r.corp_code);
    return [...m.entries()];
  }, [rows]);
  const emptyDay = days.find((d) => EMPTY_REASON[d.status]);

  return (
    <section className="pm-section" aria-label="경락 조회">
      <form className="main-filters pm-filters" onSubmit={submit} data-testid="auction-filters">
        <label htmlFor={ids.from}>
          기간
          <input id={ids.from} type="date" value={form.date_from} max={today} onChange={(e) => change({ date_from: e.target.value })} data-testid="auction-date-from" />
        </label>
        <span aria-hidden="true">~</span>
        <label htmlFor={ids.to} className="pm-sr-label">
          <span className="pm-sr">끝 날짜</span>
          <input id={ids.to} type="date" value={form.date_to} max={kstAddDays(today, 1)} onChange={(e) => change({ date_to: e.target.value })} data-testid="auction-date-to" />
        </label>
        <label htmlFor={ids.fam}>
          품목
          <select id={ids.fam} value={form.family} onChange={(e) => change({ family: e.target.value, item_key: [] })} data-testid="auction-family">
            {FAMILY.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <fieldset className="pm-varieties" data-testid="auction-varieties">
          <legend>품종</legend>
          {varieties.length === 0 && <span className="pm-muted">품종 목록 없음</span>}
          {varieties.map((v) => (
            <label key={v.item_key} className="main-filter-checkbox">
              <input type="checkbox" checked={form.item_key.includes(v.item_key)} onChange={() => toggleVariety(v.item_key)} />
              {v.variety_name}
            </label>
          ))}
        </fieldset>
        <label htmlFor={ids.grade}>
          등급
          <select id={ids.grade} value={form.grade} onChange={(e) => change({ grade: e.target.value })} data-testid="auction-grade">
            {GRADE.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
          </select>
        </label>
        <label htmlFor={ids.pkg}>
          규격
          <select id={ids.pkg} value={form.pkg} onChange={(e) => change({ pkg: e.target.value })} data-testid="auction-pkg">
            <option value="">전체</option>
            <option value="상자">상자</option>
            <option value="망">망</option>
            <option value="봉">봉</option>
            <option value="kg">kg(벌크)</option>
          </select>
        </label>
        <label htmlFor={ids.corp}>
          법인
          <select id={ids.corp} value={form.corp_code} onChange={(e) => change({ corp_code: e.target.value })} data-testid="auction-corp">
            <option value="">전체</option>
            {corpOptions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <label htmlFor={ids.origin}>
          산지
          <input id={ids.origin} type="search" value={form.origin} maxLength={30} placeholder="예: 청양" onChange={(e) => change({ origin: e.target.value })} data-testid="auction-origin" />
        </label>
        <label className="main-filter-checkbox">
          <input type="checkbox" checked={form.include_withdrawn} onChange={(e) => change({ include_withdrawn: e.target.checked })} />
          철회된 건 포함
        </label>
        <button type="submit" className="main-btn" disabled={loading} aria-busy={loading} data-testid="auction-search">
          {loading ? '조회 중…' : '조회'}
        </button>
        {formErr && <p className="pm-error pm-error--inline" role="alert">{formErr}</p>}
      </form>

      {res && (
        <div className="pm-meta" role="status" data-testid="auction-meta">
          {meta.as_of && <span>ⓘ {kstTime(meta.as_of)} 기준</span>}{/* C O-4: 경매 전(as_of 없음)에 "- 기준"을 안 보임 */}
          {meta.phase && <Tone tone={meta.phase === 'FINAL' ? 'ok' : 'info'} testid="auction-phase">{PHASE_LABEL[meta.phase] || meta.phase}</Tone>}
          {meta.stale && (
            <Tone tone="warn" title="지금 수집이 실패했거나 진행 중이라 마지막 정상 수집 결과를 보여 줍니다" testid="auction-stale">
              이전 수집 결과(수집 지연)
            </Tone>
          )}
          <MockBadge mode={meta.source_mode} />
          {days.length > 1 && (
            <span className="pm-days">
              {days.map((d) => (
                <Tone key={`${d.trade_date}-${d.source}`} tone={SNAPSHOT_STATUS[d.status]?.tone || 'neutral'} title={`${SOURCE_LABEL[d.source] || d.source} · ${d.fetched_count ?? 0}건`}>
                  {md(d.trade_date)} {SNAPSHOT_STATUS[d.status]?.label || d.status}
                </Tone>
              ))}
            </span>
          )}
        </div>
      )}

      <ErrorLine error={err} testid="auction-error" />

      <div className="main-table-wrap pm-table-wrap">
        <table className="main-table pm-table" data-testid="auction-table">
          <thead>
            <tr>
              <th>경락일</th>
              <th>낙찰시각</th>
              <th>법인</th>
              <th>품종</th>
              <th>등급</th>
              <th>규격</th>
              <th className="pm-num">수량</th>
              <th className="pm-num">단가</th>
              <th className="pm-num">kg단가</th>
              <th>산지</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={10} className="main-loading">불러오는 중…</td></tr>
            )}
            {!loading && res && rows.length === 0 && (
              <tr>
                <td colSpan={10} className="main-empty-cell" data-testid="auction-empty">
                  {emptyDay ? EMPTY_REASON[emptyDay.status] : '조건에 맞는 경락이 없습니다.'}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                className={'pm-row-click' + (r.withdrawn_at ? ' pm-withdrawn' : '')}
                tabIndex={0}
                onClick={() => setDetailId(r.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setDetailId(r.id))}
                aria-label={`경락 ${r.id} 상세 보기`}
                data-testid={`auction-row-${r.id}`}
              >
                <td data-label="경락일">{md(r.trade_date)}</td>
                <td data-label="낙찰시각">{kstTime(r.auction_at, false)}</td>
                <td data-label="법인">{r.corp_name || r.corp_code || '-'}</td>
                <td data-label="품종">
                  {r.item_label ? r.item_label.split('·').pop().trim() : <span className="pm-muted" title="품목 매핑 없음">{r.item_name_raw}</span>}
                  {r.revision > 1 && <Tone tone="info" title="원천에서 값이 바뀌었습니다(행을 눌러 이전 값 보기)">값 바뀜</Tone>}
                </td>
                <td data-label="등급">{r.grade_name || GRADE_LABEL[r.grade_norm] || '-'}</td>
                <td data-label="규격">{r.unit_qty_kg ? `${dec(r.unit_qty_kg)}kg` : ''} {r.pkg_name || ''}{r.weight_source === 'RULE' ? '(추정)' : ''}</td>
                <td className="pm-num" data-label="수량">{dec(r.qty)}</td>
                <td className="pm-num" data-label="단가">{won(r.unit_price)}</td>
                <td className="pm-num" data-label="kg단가">{dec(r.price_per_kg, 0)}</td>
                <td data-label="산지">{r.origin_name || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {prices.length > 0 && (
        <div className="pm-ref-price" data-testid="auction-ref-price">
          <strong>참고 시세(가락 주요품목)</strong>
          {prices.slice(0, 6).map((p, i) => (
            <span key={i}>
              {p.item_name_raw} {p.grade_name} {p.unit_name}: 평균 {won(p.avg_price)}
              {p.diff_pct != null && ` (전일 ${Number(p.diff_pct) > 0 ? '+' : ''}${dec(p.diff_pct, 1)}%)`}
            </span>
          ))}
        </div>
      )}

      {total > 0 && (
        <nav className="list-pager pm-pager" aria-label="경락 목록 페이지" data-testid="auction-pager">
          <span role="status">
            총 <strong>{won(total)}</strong>건 · {won(offset + 1)}–{won(offset + rows.length)} ({Math.floor(offset / LIMIT) + 1}/{Math.max(1, Math.ceil(total / LIMIT))}쪽)
          </span>
          <button type="button" className="main-btn main-btn--secondary" disabled={loading || offset === 0} onClick={() => page(Math.max(0, offset - LIMIT))} aria-label="이전 페이지">‹ 이전</button>
          <button type="button" className="main-btn main-btn--secondary" disabled={loading || offset + LIMIT >= total} onClick={() => page(offset + LIMIT)} aria-label="다음 페이지">다음 ›</button>
        </nav>
      )}

      {detailId && <TradeDetail id={detailId} onClose={() => setDetailId(null)} />}
    </section>
  );
}

function TradeDetail({ id, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    auctionApi.trade(id).then((r) => live && setD(r.data || r)).catch((e) => live && setErr(e));
    return () => {
      live = false;
    };
  }, [id]);
  const hist = Array.isArray(d?.history) ? d.history : [];
  return (
    <MatchModal
      title={`경락 #${id}`}
      sub={d ? `${d.trade_date} · ${d.corp_name || ''} · ${d.item_label || d.item_name_raw}` : '불러오는 중…'}
      onClose={onClose}
      testid="auction-detail"
      labelId="auction-detail-title"
      footer={<button type="button" className="main-modal-btn secondary" onClick={onClose}>닫기</button>}
    >
      <ErrorLine error={err} />
      {d && (
        <>
          <dl className="pm-dl">
            <dt>출처</dt><dd>{SOURCE_LABEL[d.source] || d.source}</dd>
            <dt>낙찰 시각</dt><dd>{kstTime(d.auction_at)}</dd>
            <dt>등급·규격</dt><dd>{d.grade_name || GRADE_LABEL[d.grade_norm] || '-'} · {d.unit_qty_kg ? `${dec(d.unit_qty_kg)}kg` : '중량 모름'} {d.pkg_name || ''}</dd>
            <dt>수량·단가</dt><dd>{dec(d.qty)} × {won(d.unit_price)}원 = {won(d.amount)}원 (kg당 {dec(d.price_per_kg, 2)})</dd>
            <dt>산지·출하자</dt><dd>{d.origin_name || '-'} · {d.shipper_name_masked || '-'}</dd>
            <dt>개정</dt><dd>{d.revision ?? 1}차 · 처음 {kstTime(d.first_seen_at)} · 마지막 {kstTime(d.last_seen_at)}</dd>
            {d.withdrawn_at && (<><dt>철회</dt><dd className="pm-bad-text">{kstTime(d.withdrawn_at)} 원천에서 사라짐</dd></>)}
          </dl>
          {hist.length > 0 && (
            <>
              <h3 className="pm-h3">이전 값</h3>
              <table className="main-table pm-table pm-table--compact">
                <thead><tr><th>개정</th><th className="pm-num">수량</th><th className="pm-num">단가</th><th>바뀐 시각</th></tr></thead>
                <tbody>
                  {hist.map((h) => (
                    <tr key={h.revision}><td>{h.revision}차</td><td className="pm-num">{dec(h.qty)}</td><td className="pm-num">{won(h.unit_price)}</td><td>{kstTime(h.changed_at || h.created_at)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </MatchModal>
  );
}
