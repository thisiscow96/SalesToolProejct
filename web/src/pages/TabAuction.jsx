// T-203 경락 시세 탭 — ① 경락 조회 ② 수집 현황 (설계 6.2·6.3)
// 데이터: R-92(목록·meta·days) · R-93(상세) · R-94(참고 시세) · R-95(품종 선택지) · R-138/R-139(경락 → 매입 전환)
// 잠금(T-404): 조건을 바꾸면 useLatestRequest().invalidate() — 늦은 응답 버림, [조회] 요청 중 비활성
// 2026-11-25 원표번호 검색·열 정렬(서버)·체크 → 매입 전환 → 매입정보 이동 (A 설계서 1·2·4절)
// 2026-11-25 수집 상태 줄·[지금 받기](AuctionLiveStrip) · 첫 진입 날짜 = 서버 settle_today(경매 직후 수집 설계 5.3·L-D5)
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { auctionApi } from '../lib/auctionApi';
import { tradeConvertApi } from '../lib/purchaseDocApi';
import { newIdempotencyKey, withIdempotency } from '../lib/idempotency';
import { can } from '../lib/staffAccess';
import { useLatestRequest } from '../components/Busy';
import { Pager } from '../components/ListPaging';
import { ErrorLine, MatchModal, MockBadge, SubNav, Tone } from '../components/MatchBits';
import AuctionSyncStatus from './AuctionSyncStatus';
import AuctionLiveStrip from './AuctionLiveStrip';
import {
  EMPTY_REASON, FAMILY, GRADE, GRADE_LABEL, NOT_CONVERTIBLE, PHASE_LABEL, SNAPSHOT_STATUS, SOURCE_LABEL,
  TRADE_CONVERT_RESULT, TRADE_CONVERT_WARN, reasonText,
  daysBetween, dec, kstAddDays, kstTime, kstToday, md, won,
} from '../lib/matchLabels';
import './PurchaseMatch.css';

const PAGE_SIZES = [50, 100, 200];
const PKG = [
  { value: '', label: '전체' },
  { value: '상자', label: '상자' },
  { value: '망', label: '망' },
  { value: '봉', label: '봉' },
  { value: 'kg', label: 'kg(벌크)' },
];

/** 표 열 — sort 키·기본 방향은 A 설계서 2절 표(서버 화이트리스트와 같음) */
const COLUMNS = [
  { key: 'trade_date', label: '경락일', dir: 'desc' },
  { key: 'auction_at', label: '낙찰시각', dir: 'desc' },
  { key: 'corp', label: '법인', dir: 'asc' },
  { key: 'shipment_no', label: '원표번호', dir: 'asc', cls: 'pm-col-ref' },
  { key: 'auction_seq', label: '경매번호', dir: 'asc', cls: 'pm-col-ref' },
  { key: 'item', label: '품종', dir: 'asc' },
  { key: 'grade', label: '등급', dir: 'asc' },
  { key: 'unit_kg', label: '규격', dir: 'asc' },
  { key: 'qty', label: '수량', dir: 'desc', cls: 'pm-num' },
  { key: 'unit_price', label: '단가', dir: 'desc', cls: 'pm-num' },
  { key: 'price_per_kg', label: 'kg단가', dir: 'desc', cls: 'pm-num' },
  { key: 'origin', label: '산지', dir: 'asc' },
];
const DEFAULT_SORT = { key: 'trade_date', dir: 'desc' };
const DIR_LABEL = { asc: '오름차순', desc: '내림차순' };

/** 원표번호 입력 정리 — 서버 규칙과 같게(공백·하이픈·점 제거, 숫자 1~20자리). 보낼 때는 입력 문자열 그대로(앞자리 0 보존) */
const cleanShipment = (v) => String(v || '').replace(/[\s.-]/g, '');
const shipmentError = (v) => {
  const c = cleanShipment(v);
  if (!c) return '';
  return /^\d{1,20}$/.test(c) ? '' : '원표번호는 숫자 20자리 이내로 입력하세요.';
};

/** 이 행을 매입 전환에 고를 수 없는 이유(없으면 null). 서버 칸(convertible·not_convertible_reason·converted_purchase_id) 우선 */
function blockReason(r) {
  if (r.converted_purchase_id || r.not_convertible_reason === 'ALREADY_CONVERTED') return 'CONVERTED';
  if (r.not_convertible_reason) return r.not_convertible_reason;
  if (r.withdrawn_at) return 'WITHDRAWN';
  if (r.convertible === false) return 'UNMAPPED_ITEM';
  if ((r.map_status && r.map_status !== 'MAPPED') || !r.item_key) return 'UNMAPPED_ITEM';
  return null;
}

export default function TabAuction({ onNavigate, onTabBusy } = {}) {
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
      {view === 'trades' ? <AuctionTrades onNavigate={onNavigate} onTabBusy={onTabBusy} /> : <AuctionSyncStatus />}
    </div>
  );
}

function AuctionTrades({ onNavigate, onTabBusy }) {
  const today = kstToday();
  const ids = { from: useId(), to: useId(), fam: useId(), grade: useId(), pkg: useId(), corp: useId(), origin: useId(), ship: useId(), sort: useId() };
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({ date_from: today, date_to: today, shipment_no: '', family: 'PEPPER', item_key: [], grade: '', pkg: '', corp_code: '', origin: '', include_withdrawn: false });
  const [applied, setApplied] = useState(null); // 마지막으로 [조회]한 조건
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(PAGE_SIZES[0]);
  const [sort, setSort] = useState(DEFAULT_SORT); // 서버 정렬(탭 안 상태 — 새로고침하면 기본)
  const [corps, setCorps] = useState([]);
  const [advOpen, setAdvOpen] = useState(false);
  const topRef = useRef(null);
  const [res, setRes] = useState(null);
  const [prices, setPrices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [formErr, setFormErr] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [picked, setPicked] = useState(() => new Set()); // 매입 전환할 경락 id(지금 쪽만)
  const [convertIds, setConvertIds] = useState(null); // 미리보기 모달을 연 대상
  const latest = useLatestRequest();
  const [settleToday, setSettleToday] = useState(today); // 서버 정산일(21시 경계) — 받기 전에는 달력 날짜
  const touched = useRef(false); // 사용자가 조건을 바꿨으면 정산일이 와도 날짜를 덮지 않는다
  const canConvert = can('purchase.convert_from_trade');
  const shipMode = cleanShipment(form.shipment_no) !== '';

  useEffect(() => {
    auctionApi.items().then((r) => setItems(r.data || [])).catch(() => setItems([]));
    // 법인 선택지는 조회 결과(현재 쪽)가 아니라 이 시장의 전체 법인(R-137)
    auctionApi.corps().then((r) => setCorps(r.data || [])).catch(() => setCorps([]));
  }, []);

  const varieties = useMemo(
    () => items.filter((i) => i.active !== false && (!form.family || String(i.item_key).startsWith(form.family + '.'))),
    [items, form.family],
  );

  const run = useCallback(
    async (cond, off, lim = PAGE_SIZES[0], srt = DEFAULT_SORT) => {
      const t = latest.next();
      setLoading(true);
      setErr(null);
      setPicked(new Set()); // 쪽·정렬·조건이 바뀌면 선택 해제(다른 쪽 선택을 보이지 않게 들고 가지 않는다)
      try {
        const ship = String(cond.shipment_no || '').trim();
        // 원표번호가 있으면 품목·품종·등급·규격·산지 조건은 보내지 않는다(서버도 무시 — 설계 1절)
        const params = {
          date_from: cond.date_from,
          date_to: cond.date_to,
          ...(ship
            ? { shipment_no: ship }
            : { family: cond.family, item_key: cond.item_key, grade: cond.grade, pkg: cond.pkg, origin: cond.origin.trim() }),
          corp_code: cond.corp_code,
          include_withdrawn: cond.include_withdrawn ? 'true' : '',
          sort: srt.key,
          dir: srt.dir,
          limit: lim,
          offset: off,
        };
        const [r, p] = await Promise.all([
          auctionApi.trades(params),
          ship ? Promise.resolve({ data: [] }) : auctionApi.dailyPrices({ date: cond.date_to, family: cond.family, item_key: cond.item_key }).catch(() => ({ data: [] })),
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
    touched.current = true;
    latest.invalidate(); // 조건을 바꾸면 진행 중 응답은 버린다
    setLoading(false);
    setForm((f) => ({ ...f, ...patch }));
  };
  const submit = (e) => {
    e?.preventDefault();
    if (!form.date_from || !form.date_to || form.date_from > form.date_to) return setFormErr('기간을 바르게 지정하세요(시작 ≤ 끝).');
    if (daysBetween(form.date_from, form.date_to) > 30) return setFormErr('조회 기간은 31일 이내로 지정하세요.');
    const se = shipmentError(form.shipment_no);
    if (se) return setFormErr(se);
    setFormErr('');
    const c = { ...form };
    setApplied(c);
    setOffset(0);
    run(c, 0, limit, sort);
  };
  // 쪽을 바꾸면 표 맨 위(결과 요약 줄)로 올린다
  const scrollTop = () => topRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  const page = (off) => {
    if (!applied || loading) return;
    setOffset(off);
    run(applied, off, limit, sort);
    scrollTop();
  };
  const changeLimit = (n) => {
    if (!applied || loading) return;
    setLimit(n);
    setOffset(0);
    run(applied, 0, n, sort);
  };
  /** 열 머리 클릭 — 처음엔 그 열 기본 방향, 같은 열을 다시 누르면 반대. 정렬이 바뀌면 1쪽 */
  const applySort = (next) => {
    if (!applied) return;
    setSort(next);
    setOffset(0);
    run(applied, 0, limit, next);
  };
  const clickSort = (col) => applySort(sort.key === col.key ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: col.dir });
  /** R-96 settle_today 도착 — 첫 진입 그대로면(오늘 하루 조회) 그 날짜로 다시 조회(밤 21시 뒤 = 다음 정산일) */
  const adoptSettleToday = (d) => {
    setSettleToday(d);
    if (touched.current || d === today || form.date_from !== today || form.date_to !== today) return;
    const c = { ...form, date_from: d, date_to: d };
    setForm(c);
    setApplied(c);
    setOffset(0);
    run(c, 0, limit, sort);
  };
  /** [지금 받기]가 끝나면 지금 조회 조건 그대로 1회 다시 조회 */
  const refreshAfterCollect = () => (applied ? run(applied, offset, limit, sort) : undefined);
  const toggleVariety = (key) =>
    change({ item_key: form.item_key.includes(key) ? form.item_key.filter((k) => k !== key) : [...form.item_key, key] });

  const rows = res?.data || [];
  const meta = res?.meta || {};
  const days = res?.days || [];
  const total = res?.total || 0;
  // 전체 법인(R-137). 목록을 못 받았으면 지금 쪽에 보인 법인으로 채운다
  const corpOptions = useMemo(() => {
    const mm = new Map(corps.map((c) => [c.corp_code, c.corp_name || c.corp_code]));
    for (const r of rows) if (r.corp_code && !mm.has(r.corp_code)) mm.set(r.corp_code, r.corp_name || r.corp_code);
    return [...mm.entries()].sort((x, y) => x[0].localeCompare(y[0]));
  }, [corps, rows]);
  const advCount = [form.grade, form.pkg, form.origin.trim(), form.include_withdrawn].filter(Boolean).length;
  const emptyDay = days.find((d) => EMPTY_REASON[d.status]);
  const appliedShip = String(applied?.shipment_no || '').trim();

  // 선택(지금 쪽에서 고를 수 있는 행만)
  const selectable = rows.filter((r) => !blockReason(r));
  const pickedRows = rows.filter((r) => picked.has(r.id));
  const allOn = selectable.length > 0 && selectable.every((r) => picked.has(r.id));
  const someOn = pickedRows.length > 0 && !allOn;
  const headCheck = useRef(null);
  useEffect(() => {
    if (headCheck.current) headCheck.current.indeterminate = someOn;
  }, [someOn]);
  const togglePick = (id) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const toggleAll = () => setPicked(allOn ? new Set() : new Set(selectable.map((r) => r.id)));
  const colCount = COLUMNS.length + (canConvert ? 1 : 0);

  /** 전환 결과로 매입정보 탭 이동 — 서버 navigate 값 우선 */
  const goPurchases = (data) => {
    const nav = data?.navigate || {};
    const results = data?.results || [];
    const pids = nav.purchase_ids || results.filter((x) => x.purchase_id).map((x) => x.purchase_id);
    if (!pids.length || !onNavigate) return;
    const tradeDates = results
      .filter((x) => x.purchase_id)
      .map((x) => rows.find((r) => r.id === x.trade_id)?.trade_date)
      .filter(Boolean)
      .sort();
    const n = (data?.summary?.converted || 0);
    onNavigate('purchases', {
      from_date: nav.from_date || tradeDates[0] || today,
      to_date: nav.to_date || tradeDates[tradeDates.length - 1] || today,
      highlight_ids: pids,
      notice: n > 0 ? `경락 시세에서 ${n}건을 매입 등록했습니다.` : '선택한 경락 건은 이미 매입 등록되어 있습니다.',
    });
  };

  return (
    <section className="pm-section" aria-label="경락 조회">
      <form className="pm-search" onSubmit={submit} data-testid="auction-filters" aria-label="경락 조회 조건">
        {/* 1줄: 기간 · 원표번호 · 품목 · 법인 · [상세 조건] [조회] */}
        <div className="pm-search-row">
          <div className="pm-field pm-field--range">
            <label className="pm-field-label" htmlFor={ids.from}>기간</label>
            <div className="pm-range">
              <input id={ids.from} type="date" value={form.date_from} max={settleToday > today ? settleToday : today} onChange={(e) => change({ date_from: e.target.value })} data-testid="auction-date-from" />
              <span aria-hidden="true">~</span>
              <label htmlFor={ids.to} className="pm-sr">끝 날짜</label>
              <input id={ids.to} type="date" value={form.date_to} max={kstAddDays(settleToday > today ? settleToday : today, 1)} onChange={(e) => change({ date_to: e.target.value })} data-testid="auction-date-to" />
            </div>
          </div>
          <div className="pm-field pm-field--ship">
            <label className="pm-field-label" htmlFor={ids.ship}>원표번호</label>
            <input
              id={ids.ship}
              type="search"
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="search"
              maxLength={30}
              placeholder="번호 그대로 입력"
              value={form.shipment_no}
              aria-describedby={ids.ship + '-hint'}
              aria-invalid={shipmentError(form.shipment_no) ? 'true' : undefined}
              onChange={(e) => change({ shipment_no: e.target.value })}
              data-testid="auction-shipment"
            />
          </div>
          <div className="pm-field">
            <label className="pm-field-label" htmlFor={ids.fam}>품목</label>
            <select id={ids.fam} value={form.family} disabled={shipMode} onChange={(e) => change({ family: e.target.value, item_key: [] })} data-testid="auction-family">
              {FAMILY.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </div>
          <div className="pm-field pm-field--wide">
            <label className="pm-field-label" htmlFor={ids.corp}>법인</label>
            <select id={ids.corp} value={form.corp_code} onChange={(e) => change({ corp_code: e.target.value })} data-testid="auction-corp">
              <option value="">전체 법인</option>
              {corpOptions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </div>
          <div className="pm-search-actions">
            <button
              type="button"
              className="pm-adv-toggle"
              aria-expanded={advOpen}
              aria-controls={ids.grade + '-adv'}
              onClick={() => setAdvOpen((v) => !v)}
              data-testid="auction-adv-toggle"
            >
              상세 조건{advCount > 0 && <span className="pm-adv-count" aria-label={`${advCount}개 적용`}>{advCount}</span>}
              <span className="pm-adv-caret" aria-hidden="true">{advOpen ? '▴' : '▾'}</span>
            </button>
            <button type="submit" className="main-btn" disabled={loading} aria-busy={loading} data-testid="auction-search">
              {loading ? '조회 중…' : '조회'}
            </button>
          </div>
        </div>
        <p id={ids.ship + '-hint'} className={'pm-search-hint' + (shipMode ? ' on' : '')} data-testid="auction-shipment-hint" aria-live="polite">
          {shipMode
            ? <><strong>원표번호 검색</strong> — 기간·법인 안에서 이 번호와 정확히 같은 원표만 찾습니다. 품목·품종·등급·규격·산지 조건은 적용하지 않습니다.</>
            : '원표번호: 전표에 적힌 번호를 그대로 입력하고 Enter. 앞자리 0·공백·하이픈은 빼고 비교합니다.'}
        </p>

        {/* 2줄: 품종 칩(품목에 따라 바뀜, 줄바꿈 허용) — 원표번호 검색 중에는 값은 두고 잠금 */}
        <fieldset className="pm-search-row pm-chips" data-testid="auction-varieties" disabled={shipMode}>
          <legend className="pm-field-label">
            품종{form.item_key.length > 0 && <span className="pm-chip-sel"> · {form.item_key.length}개 선택</span>}
          </legend>
          <div className="pm-chip-list">
            {varieties.length === 0 && <span className="pm-muted">품종 목록 없음</span>}
            {varieties.length > 0 && (
              <button type="button" className={'pm-chip' + (form.item_key.length === 0 ? ' on' : '')} aria-pressed={form.item_key.length === 0} onClick={() => change({ item_key: [] })}>
                전체
              </button>
            )}
            {varieties.map((v) => (
              <label key={v.item_key} className={'pm-chip' + (form.item_key.includes(v.item_key) ? ' on' : '')}>
                <input type="checkbox" checked={form.item_key.includes(v.item_key)} onChange={() => toggleVariety(v.item_key)} />
                {v.variety_name}
              </label>
            ))}
          </div>
        </fieldset>

        {/* 3줄(접힘): 등급 · 규격 · 산지 · 철회된 건 포함 */}
        <div className="pm-search-row pm-adv" id={ids.grade + '-adv'} hidden={!advOpen} data-testid="auction-adv">
          <div className="pm-field">
            <label className="pm-field-label" htmlFor={ids.grade}>등급</label>
            <select id={ids.grade} value={form.grade} disabled={shipMode} onChange={(e) => change({ grade: e.target.value })} data-testid="auction-grade">
              {GRADE.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
            </select>
          </div>
          <div className="pm-field">
            <label className="pm-field-label" htmlFor={ids.pkg}>규격</label>
            <select id={ids.pkg} value={form.pkg} disabled={shipMode} onChange={(e) => change({ pkg: e.target.value })} data-testid="auction-pkg">
              {PKG.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
          <div className="pm-field">
            <label className="pm-field-label" htmlFor={ids.origin}>산지</label>
            <input id={ids.origin} type="search" value={form.origin} maxLength={30} placeholder="예: 청양" disabled={shipMode} onChange={(e) => change({ origin: e.target.value })} data-testid="auction-origin" />
          </div>
          <label className="pm-check">
            <input type="checkbox" checked={form.include_withdrawn} onChange={(e) => change({ include_withdrawn: e.target.checked })} />
            철회된 건 포함
          </label>
        </div>
        {formErr && <p className="pm-error pm-error--inline" role="alert">{formErr}</p>}
      </form>

      <AuctionLiveStrip onSettleToday={adoptSettleToday} onCollected={refreshAfterCollect} />

      <div className="pm-result-bar" ref={topRef}>
      {res ? (
        <div className="pm-meta" role="status" data-testid="auction-meta">
          {appliedShip && <Tone tone="info" testid="auction-shipment-badge">원표 {appliedShip}</Tone>}
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
                  {d.trade_date} {SNAPSHOT_STATUS[d.status]?.label || d.status}
                </Tone>
              ))}
            </span>
          )}
        </div>
      ) : <span />}
        <Pager variant="compact" total={total} offset={offset} limit={limit} count={rows.length} loading={loading} onPage={page} label="경락 목록 페이지" testid="auction-pager-top" />
      </div>

      {/* 표 도구줄: (휴대폰) 정렬 선택 · 선택 건수 · [매입 전환] */}
      <div className="pm-table-tools" data-testid="auction-tools">
        <div className="pm-sort-mobile">
          <label htmlFor={ids.sort} className="pm-field-label">정렬</label>
          <select id={ids.sort} value={sort.key} disabled={!applied} onChange={(e) => applySort({ key: e.target.value, dir: COLUMNS.find((c) => c.key === e.target.value)?.dir || 'asc' })} data-testid="auction-sort-select">
            {COLUMNS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <button
            type="button"
            className="pm-sort-dir"
            disabled={!applied}
            onClick={() => applySort({ key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
            aria-label={`정렬 방향: ${DIR_LABEL[sort.dir]} (누르면 반대로)`}
            data-testid="auction-sort-dir"
          >
            <span aria-hidden="true">{sort.dir === 'asc' ? '▲' : '▼'}</span> {sort.dir === 'asc' ? '오름' : '내림'}
          </button>
        </div>
        {canConvert && (
          <div className="pm-convert-bar" data-testid="auction-convert-bar">
            <span className={'pm-pick-count' + (picked.size ? ' on' : '')} aria-live="polite" data-testid="auction-pick-count">
              {picked.size ? <><strong>{picked.size}건</strong> 선택</> : '매입으로 옮길 경락 건을 체크하세요'}
            </span>
            {picked.size > 0 && (
              <button type="button" className="pm-text-btn" onClick={() => setPicked(new Set())} data-testid="auction-pick-clear">선택 해제</button>
            )}
            <button
              type="button"
              className="main-btn"
              disabled={picked.size === 0 || loading}
              onClick={() => setConvertIds([...picked])}
              data-testid="auction-convert"
            >
              매입 전환{picked.size > 0 ? ` (${picked.size}건)` : ''}
            </button>
          </div>
        )}
      </div>

      <ErrorLine error={err} testid="auction-error" />

      <div className="main-table-wrap pm-table-wrap">
        <table className={'main-table pm-table pm-table--scroll' + (canConvert ? ' pm-table--pick' : '')} data-testid="auction-table">
          <thead>
            <tr>
              {canConvert && (
                <th className="pm-col-pick" scope="col">
                  <label className="pm-pick" title="이 쪽에서 고를 수 있는 건 전체 선택">
                    <input
                      ref={headCheck}
                      type="checkbox"
                      checked={allOn}
                      disabled={selectable.length === 0}
                      onChange={toggleAll}
                      aria-label="이 쪽 전체 선택"
                      data-testid="auction-pick-all"
                    />
                  </label>
                </th>
              )}
              {COLUMNS.map((c) => {
                const on = sort.key === c.key;
                return (
                  <th key={c.key} scope="col" className={c.cls} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    <button
                      type="button"
                      className={'pm-sort' + (on ? ' on' : '')}
                      onClick={() => clickSort(c)}
                      disabled={!applied}
                      title={on ? `${c.label} ${DIR_LABEL[sort.dir]} — 누르면 ${DIR_LABEL[sort.dir === 'asc' ? 'desc' : 'asc']}` : `${c.label} 기준 정렬`}
                      data-testid={`auction-sort-${c.key}`}
                    >
                      {c.label}
                      <span className="pm-sort-ico" aria-hidden="true">{on ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr><td colSpan={colCount} className="main-loading">불러오는 중…</td></tr>
            )}
            {!loading && res && rows.length === 0 && (
              <tr>
                <td colSpan={colCount} className="main-empty-cell" data-testid="auction-empty">
                  {appliedShip
                    ? `그 기간에 원표번호 ${appliedShip} 경락 건이 없습니다. 기간·법인을 확인하세요.`
                    : emptyDay ? EMPTY_REASON[emptyDay.status] : '조건에 맞는 경락이 없습니다.'}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const why = blockReason(r);
              const on = picked.has(r.id);
              return (
              <tr
                key={r.id}
                className={'pm-row-click' + (r.withdrawn_at ? ' pm-withdrawn' : '') + (on ? ' pm-row-picked' : '') + (r.converted_purchase_id ? ' pm-row-converted' : '')}
                tabIndex={0}
                onClick={() => setDetailId(r.id)}
                onKeyDown={(e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setDetailId(r.id))}
                aria-label={`경락 ${r.id} 상세 보기`}
                aria-selected={canConvert ? on : undefined}
                data-testid={`auction-row-${r.id}`}
              >
                {canConvert && (
                  <td className="pm-col-pick" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <label className="pm-pick" title={why ? NOT_CONVERTIBLE[why] || why : '매입 전환할 건으로 선택'}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!!why}
                        onChange={() => togglePick(r.id)}
                        aria-label={why ? `경락 ${r.id} 선택 불가: ${NOT_CONVERTIBLE[why] || why}` : `경락 ${r.id} 선택`}
                        data-testid={`auction-pick-${r.id}`}
                      />
                    </label>
                  </td>
                )}
                <td data-label="경락일">{md(r.trade_date)}</td>
                <td data-label="낙찰시각">{kstTime(r.auction_at, false)}</td>
                <td data-label="법인">
                  {r.corp_name || r.corp_code || '-'}
                  {r.corp_variety_name && <div className="pm-muted" title="법인이 쓴 품목명(매입서와 대조할 때 참고)">{r.corp_item_name ? `${r.corp_item_name}/` : ''}{r.corp_variety_name}</div>}
                </td>
                <td className="pm-mono pm-col-ref" data-label="원표번호">{r.shipment_no || <span className="pm-muted">-</span>}</td>
                <td className="pm-mono pm-col-ref" data-label="경매번호">{r.auction_seq || <span className="pm-muted">-</span>}</td>
                <td className="pm-col-item" data-label="품종">
                  {r.item_label ? r.item_label.split('·').pop().trim() : <span className="pm-muted" title="품목 매핑 없음">{r.item_name_raw}</span>}
                  {r.converted_purchase_id && (
                    <span className="pm-tone pm-tone--ok" title={`매입 #${r.converted_purchase_id}로 등록됨`} data-testid={`auction-converted-${r.id}`}>매입됨</span>
                  )}
                  {r.revision > 1 && <Tone tone="info" title="원천에서 값이 바뀌었습니다(행을 눌러 이전 값 보기)">값 바뀜</Tone>}
                  {r.trade_type && r.trade_type !== '경매' && <Tone tone="info" title="매매방법">{r.trade_type}</Tone>}
                </td>
                <td data-label="등급">{r.grade_name || GRADE_LABEL[r.grade_norm] || '-'}</td>
                <td data-label="규격">{r.unit_qty_kg ? `${dec(r.unit_qty_kg)}kg` : ''} {r.pkg_name || ''}{r.weight_source === 'RULE' ? '(추정)' : ''}</td>
                <td className="pm-num" data-label="수량">{dec(r.qty)}</td>
                <td className="pm-num" data-label="단가">{won(r.unit_price)}</td>
                <td className="pm-num" data-label="kg단가">{dec(r.price_per_kg, 0)}</td>
                <td className="pm-col-origin" data-label="산지">
                  {r.origin_name ? <span className="pm-ellip" title={r.origin_name}>{r.origin_name}</span> : '-'}
                </td>
              </tr>
              );
            })}
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

      <Pager total={total} offset={offset} limit={limit} count={rows.length} loading={loading} onPage={page} onLimit={changeLimit} pageSizes={PAGE_SIZES} label="경락 목록 페이지" testid="auction-pager" />

      {detailId && <TradeDetail id={detailId} onClose={() => setDetailId(null)} />}
      {convertIds && (
        <ConvertModal
          tradeIds={convertIds}
          tradeRows={rows}
          onTabBusy={onTabBusy}
          onClose={(changed) => {
            setConvertIds(null);
            if (changed && applied) run(applied, offset, limit, sort); // 성공 건 "매입됨" 표시·선택 해제
          }}
          onGo={goPurchases}
        />
      )}
    </section>
  );
}

/**
 * 경락 → 매입 전환 모달 (설계 A 4절): 미리보기(R-138) → [N건 매입 등록](R-139) → 결과
 * 키: 모달을 열 때 1번 만들고 같은 모달의 재시도에 그대로 쓴다. 요청 중에는 버튼·닫기·최상위 탭 이동 잠금.
 */
function ConvertModal({ tradeIds, tradeRows, onTabBusy, onClose, onGo }) {
  const keyRef = useRef(newIdempotencyKey('tc'));
  const sendingRef = useRef(false);
  const [prev, setPrev] = useState(null);
  const [prevErr, setPrevErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(null); // R-139 응답 data
  const [pendingGo, setPendingGo] = useState(null);

  useEffect(() => {
    let live = true;
    tradeConvertApi
      .preview(tradeIds)
      .then((r) => live && setPrev(r.data || r))
      .catch((e) => live && setPrevErr(e));
    return () => {
      live = false;
    };
  }, [tradeIds]);

  // 탭 잠금을 푼 뒤(다음 렌더의 onNavigate가 잠금 해제 상태를 볼 때) 이동한다
  useEffect(() => {
    if (pendingGo && !busy) {
      const d = pendingGo;
      setPendingGo(null);
      onGo(d);
    }
  }, [pendingGo, busy, onGo]);

  const byId = useMemo(() => new Map(tradeRows.map((r) => [r.id, r])), [tradeRows]);
  const prow = prev?.rows || [];
  const sum = prev?.summary || {};
  const willIds = prow.filter((x) => x.result === 'WILL_CONVERT').map((x) => x.trade_id);
  const willCount = sum.will_convert ?? willIds.length;

  const submit = async () => {
    if (sendingRef.current || willIds.length === 0) return; // 빠르게 두 번 눌러도 요청 1번
    // 고른 건 전부를 보낸다 — 서버가 등록 직전에 다시 점검해 건별 결과를 준다(미리보기 뒤 철회 등, 설계 A 4절 5·AC-V-14)
    sendingRef.current = true;
    setBusy(true);
    setErr(null);
    onTabBusy?.(true);
    try {
      const r = await withIdempotency((k) => tradeConvertApi.convert(tradeIds, k), keyRef.current);
      const data = r.data || r;
      const s = data.summary || {};
      const okCount = (s.converted || 0) + (s.already || 0);
      if (okCount > 0 && !(s.failed > 0)) setPendingGo(data); // 전부 성공 → 바로 매입정보로
      else setDone(data); // 일부·전부 실패 → 모달에 결과
    } catch (e) {
      setErr(e.status === 409 ? Object.assign(new Error('다른 작업과 겹쳤습니다. 잠시 뒤 다시 누르세요(같은 요청으로 다시 보냅니다).'), { code: e.code }) : e);
    } finally {
      sendingRef.current = false;
      setBusy(false);
      onTabBusy?.(false);
    }
  };

  const results = done?.results || [];
  const okResults = results.filter((x) => x.result === 'CONVERTED' || x.result === 'ALREADY_CONVERTED');
  const badResults = results.filter((x) => !(x.result === 'CONVERTED' || x.result === 'ALREADY_CONVERTED'));
  const close = () => !busy && onClose(!!done);
  const label = (id, x = {}) => {
    const t = { ...(byId.get(id) || {}), ...Object.fromEntries(Object.entries(x).filter(([, v]) => v != null && v !== '')) };
    if (!t.trade_date && !t.corp_name) return `경락 #${id}`;
    return `${md(t.trade_date)} · ${t.corp_name || t.corp_code || ''} · 원표 ${t.shipment_no || '-'} · ${t.item_label ? String(t.item_label).split('·').pop().trim() : t.item_name_raw || ''}`;
  };
  /** 제외 이유 문장 — 코드로 화면 문구를 만든다(서버 문구의 조사 고정 "○○과과" 회피), 없으면 서버 문구 */
  const reasonLine = (x) => {
    const corp = x.corp_name || byId.get(x.trade_id)?.corp_name;
    if (x.result === 'NO_CORP_LINK') return `${corp ? `법인 "${corp}"` : '이 법인'}에 연결된 거래처가 없습니다. 매입서 대조 → 대조 설정 → 법인 연결에서 연결하세요.`;
    if (x.result === 'NO_PRODUCT_LINK') return '내 품목과 연결되지 않은 품종입니다. 매입서 대조 → 대조 설정 → 품목 연결에서 연결하세요.';
    if (x.result === 'UNIT_CHECK_NEEDED') return `${x.detail?.reason ? reasonText(x.detail.reason) + ' — ' : ''}단위 환산이 맞지 않아 자동 등록하지 않습니다. 매입서 대조에서 수동 확정(주인)하세요.`;
    if (x.result === 'PURCHASE_FAILED') return x.detail?.message || x.message || '매입 등록이 거절되었습니다.';
    return x.message || '';
  };
  const warnLine = (w, x) => (w === 'DOC_LINE_PENDING' && x.pending_doc_line
    ? `매입서 #${x.pending_doc_line.doc_id} ${x.pending_doc_line.line_no}줄이 이 경락 건을 후보로 기다리는 중 — 여기서 등록하면 그 줄은 "이미 씀"이 됩니다`
    : TRADE_CONVERT_WARN[w] || w);

  const footer = done ? (
    <>
      <button type="button" className="main-modal-btn secondary" onClick={close} data-testid="tc-close">닫기</button>
      {okResults.length > 0 && (
        <button type="button" className="main-modal-btn primary" onClick={() => { onClose(true); onGo(done); }} data-testid="tc-go">
          매입정보에서 보기 ({okResults.length}건)
        </button>
      )}
    </>
  ) : (
    <>
      <button type="button" className="main-modal-btn secondary" onClick={close} disabled={busy}>취소</button>
      <button
        type="button"
        className="main-modal-btn primary"
        onClick={submit}
        disabled={busy || !prev || willCount === 0}
        aria-busy={busy}
        data-testid="tc-submit"
      >
        {busy ? '등록하는 중…' : `${willCount}건 매입 등록`}
      </button>
    </>
  );

  return (
    <MatchModal
      title={done ? '매입 전환 결과' : '경락 → 매입 전환'}
      sub={done
        ? `${done.summary?.converted || 0}건 등록 · ${done.summary?.already || 0}건 이미 등록 · ${badResults.length}건 제외`
        : `선택 ${tradeIds.length}건 — 등록 전에 거래처·품목·금액을 확인하세요`}
      busy={busy}
      onClose={close}
      testid="tc-modal"
      labelId="tc-modal-title"
      footer={footer}
    >
      {!done && (
        <>
          <p className="pm-warn" data-testid="tc-notice">
            본인이 낙찰·매입한 경락 건만 전환하세요. 등록하면 매입정보에 바로 들어가고, 취소는 주인이 매입정보에서 합니다.
          </p>
          <ErrorLine error={prevErr} testid="tc-preview-error" />
          {!prev && !prevErr && <p className="main-loading">미리보기를 불러오는 중…</p>}
          {prev && (
            <>
              <div className="pm-tc-summary" data-testid="tc-summary">
                <span><span className="pm-tc-k">등록 예정</span> <strong>{won(willCount)}건</strong></span>
                <span><span className="pm-tc-k">합계</span> <strong className="pm-num">{won(sum.total_amount)}원</strong></span>
                {sum.already > 0 && <span><span className="pm-tc-k">이미 등록</span> <strong>{won(sum.already)}건</strong></span>}
                <span className={sum.excluded ? 'pm-bad-text' : ''}><span className="pm-tc-k">제외</span> <strong>{won(sum.excluded || 0)}건</strong></span>
              </div>
              <div className="main-table-wrap pm-table-wrap pm-table-wrap--short">
                <table className="main-table pm-table pm-table--compact pm-tc-table" data-testid="tc-preview-table">
                  <thead>
                    <tr>
                      <th scope="col">경락</th>
                      <th scope="col">거래처 · 품목</th>
                      <th scope="col" className="pm-num">수량</th>
                      <th scope="col" className="pm-num">단가</th>
                      <th scope="col" className="pm-num">금액</th>
                      <th scope="col">결과</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prow.map((x) => {
                      const st = TRADE_CONVERT_RESULT[x.result] || { label: x.result, tone: 'neutral' };
                      const will = x.result === 'WILL_CONVERT';
                      return (
                        <tr key={x.trade_id} className={will ? undefined : 'pm-row-off'} data-testid={`tc-row-${x.trade_id}`}>
                          <td data-label="경락">
                            <div>{x.purchase_date ? md(x.purchase_date) : md(byId.get(x.trade_id)?.trade_date)}</div>
                            <div className="pm-muted pm-mono">원표 {x.shipment_no || byId.get(x.trade_id)?.shipment_no || '-'} · 경매 {x.auction_seq || byId.get(x.trade_id)?.auction_seq || '-'}</div>
                          </td>
                          <td data-label="거래처 · 품목">
                            {will ? <><div>{x.partner?.name || '-'}</div><div className="pm-muted">{x.product?.name || '-'}</div></> : <span className="pm-muted">{label(x.trade_id, x)}</span>}
                            {(will || x.result === 'UNIT_CHECK_NEEDED') && <BasisLine b={convBasis(x, byId.get(x.trade_id))} testid={`tc-basis-${x.trade_id}`} />}
                          </td>
                          <td className="pm-num" data-label="수량">{will ? dec(x.quantity) : ''}</td>
                          <td className="pm-num" data-label="단가">{will ? won(x.unit_price) : ''}</td>
                          <td className="pm-num" data-label="금액">{will ? won(x.total) : ''}</td>
                          <td data-label="결과">
                            <Tone tone={st.tone}>{will || x.result === 'ALREADY_CONVERTED' ? st.label : `제외: ${st.label}`}</Tone>
                            {!will && reasonLine(x) && <div className="pm-tc-msg">{reasonLine(x)}</div>}
                            {(x.warnings || []).map((w) => <div key={w} className="pm-tc-msg pm-tc-msg--warn">⚠ {warnLine(w, x)}</div>)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {willCount === 0 && <p className="pm-error" role="alert">등록할 수 있는 건이 없습니다. 제외 이유를 확인하세요.</p>}
            </>
          )}
          <ErrorLine error={err} testid="tc-error" />
        </>
      )}
      {done && (
        <>
          {okResults.length > 0 ? (
            <p className="pm-ok" role="status" data-testid="tc-done-ok">{okResults.length}건은 매입정보에 들어갔습니다. 아래 {badResults.length}건은 등록하지 않았습니다.</p>
          ) : (
            <p className="pm-error" role="alert" data-testid="tc-done-fail">한 건도 등록하지 못했습니다. 아래 이유를 확인하세요.</p>
          )}
          {okResults.length > 0 && (
            <ul className="pm-tc-fails pm-tc-oks" data-testid="tc-ok-list">
              {okResults.map((x) => {
                const st = TRADE_CONVERT_RESULT[x.result] || { label: x.result, tone: 'ok' };
                return (
                  <li key={x.trade_id}>
                    <Tone tone={st.tone}>{st.label}</Tone> <span>{label(x.trade_id, x)}</span>
                    {x.purchase_id && <span className="pm-muted"> · 매입 #{x.purchase_id}</span>}
                    <BasisLine b={convBasis(x, byId.get(x.trade_id))} testid={`tc-done-basis-${x.trade_id}`} />
                  </li>
                );
              })}
            </ul>
          )}
          <ul className="pm-tc-fails" data-testid="tc-fail-list">
            {badResults.map((x) => {
              const st = TRADE_CONVERT_RESULT[x.result] || { label: x.result, tone: 'bad' };
              return (
                <li key={x.trade_id}>
                  <Tone tone={st.tone}>{st.label}</Tone> <span>{label(x.trade_id, x)}</span>
                  {reasonLine(x) && <div className="pm-tc-msg">{reasonLine(x)}</div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </MatchModal>
  );
}

/**
 * 환산 근거 한 줄 — "경락 1상자(6kg) × 33,600원 → 매입 0.6(10kg 단위) × 56,000원"
 * B 계약(f4492ab): 줄의 trade_original{qty,pkg_name,unit_qty_kg,unit_price}·unit_basis{product_unit,product_unit_kg,factor,same_unit}.
 * 없으면(옛 서버) 표의 경락 행 값으로 채운다. 화면은 표시만 하고 계산하지 않는다(서버 값 그대로).
 */
function convBasis(x, t = {}) {
  const src = x.trade_original || x.source || {};
  const cv = x.unit_basis || x.conversion || {};
  const qty = src.qty ?? t.qty;
  const price = src.unit_price ?? t.unit_price;
  const kg = src.unit_qty_kg ?? t.unit_qty_kg;
  const pkg = src.pkg_name ?? t.pkg_name ?? '';
  const q2 = x.quantity ?? x.detail?.quantity;
  const p2 = x.unit_price ?? x.detail?.unit_price;
  if (qty == null || q2 == null || p2 == null) return null;
  const unitKg = cv.product_unit_kg ?? cv.unit_kg;
  const unit = cv.product_unit ?? x.product?.unit ?? (unitKg != null ? `${dec(unitKg)}kg` : null);
  const same = cv.same_unit === true || (Number(qty) === Number(q2) && Number(price) === Number(p2));
  return {
    from: `${dec(qty)}${pkg}${kg != null && kg !== '' ? `(${dec(kg)}kg)` : ''} × ${won(price)}원`,
    to: `${dec(q2)}${unit ? `(${unit} 단위)` : ''} × ${won(p2)}원`,
    same,
  };
}
function BasisLine({ b, testid }) {
  if (!b) return null;
  return (
    <div className="pm-tc-basis" data-testid={testid}>
      <span className="pm-tc-basis-k">경락</span> <span className="pm-num">{b.from}</span>
      <span className="pm-tc-basis-arrow" aria-label="환산하면">→</span>
      <span className="pm-tc-basis-k">매입</span> <span className="pm-num">{b.to}</span>
      {b.same && <span className="pm-muted"> (환산 없음)</span>}
    </div>
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
            {(d.shipment_no || d.auction_seq) && (<><dt>원표번호·경매번호</dt><dd>{d.shipment_no || '-'} · {d.auction_seq || '-'}{d.trade_type ? ` (${d.trade_type})` : ''}</dd></>)}
            {d.corp_variety_name && (<><dt>법인 품목명</dt><dd>{d.corp_item_name ? `${d.corp_item_name}/` : ''}{d.corp_variety_name}</dd></>)}
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
