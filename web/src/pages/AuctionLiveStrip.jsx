// T-203 경락 조회 "수집 상태 줄" + [지금 받기] (A 설계 5.1~5.3, R-96 live[]·settle_today / R-98)
// 왼쪽: 정산분(오늘/어제) 선택 · 상태 칩 · 마지막·다음 수집 시각 / 오른쪽: [지금 받기](주인만, 다른 사람은 상태만)
// 누른 뒤: 요청 중 잠금 → 202면 5초마다 상태 확인(최대 2분) → 끝나면 부모가 현재 조건으로 [조회] 1회 → "N건 새로 받음"
// 429 → 남은 시간 카운트다운(수집 현황과 같은 5분 제한 값 공유), ALREADY_RUNNING → 그 작업이 끝날 때까지 같은 방식으로 기다림
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { auctionApi } from '../lib/auctionApi';
import { getUser } from '../api';
import { can } from '../lib/staffAccess';
import { Tone } from '../components/MatchBits';
import { LIVE_STATE, SETTLE_LABEL, SYNC_SKIP, kstAddDays, kstToday, leftText, liveTimes, won } from '../lib/matchLabels';

export const SYNC_GAP_MS = 5 * 60 * 1000;
/** 회원별 5분 제한(서버 R-98) — 경락 조회·수집 현황 두 화면이 같은 값을 본다. 새로고침하면 비고, 그때는 서버 429로 다시 안다 */
export const syncGate = { until: 0 };

const POLL_MS = 3000; // B 권고 2~5초(즉시 실행 run_now)
const POLL_MAX_MS = 120000;
const REFRESH_MS = 60000;
const RUNNING = new Set(['QUEUED', 'RUNNING']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function AuctionLiveStrip({ onSettleToday, onCollected }) {
  const user = getUser();
  const canSync = !user?.staff && can('auction.sync'); // R-98 OWNER — 조회 직원·직원에게는 버튼 없음(AC-L-22)
  const selId = useId();
  const [st, setSt] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [pick, setPick] = useState('today');
  const [step, setStep] = useState('idle'); // idle | sending | waiting
  const [msg, setMsg] = useState(null); // { tone, text }
  const [now, setNow] = useState(Date.now());
  const alive = useRef(true);
  const sendingRef = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await auctionApi.syncStatus();
      if (!alive.current) return null;
      setSt(s);
      setLoadErr(null);
      return s;
    } catch (e) {
      if (alive.current) setLoadErr(e);
      return null;
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 경매가 도는 동안(경매 전·진행 중)에는 1분마다 상태만 다시 본다(화면이 보일 때만)
  const settleToday = st?.settle_today || kstToday();
  const live = Array.isArray(st?.live) ? st.live : null;
  const dateOf = (p) => (p === 'today' ? settleToday : kstAddDays(settleToday, -1));
  const cur = live ? live.find((x) => x.label === pick) || live.find((x) => x.settle_date === dateOf(pick)) : null;
  const moving = !live || live.some((x) => x.state === 'WAITING' || x.state === 'LIVE');
  useEffect(() => {
    if (step !== 'idle' || !moving) return undefined;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => clearInterval(t);
  }, [step, moving, load]);

  useEffect(() => {
    if (st?.settle_today) onSettleToday?.(st.settle_today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st?.settle_today]);

  // 5분 제한 남은 시간 카운트다운
  const waitLeft = Math.max(0, syncGate.until - now);
  useEffect(() => {
    if (syncGate.until <= now) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [now]);

  /**
   * 그 날짜 작업이 끝날 때까지 3초마다 R-96 확인(최대 2분) → 끝난 시점의 응답
   * 끝 = live[그 날짜].running 이 null(B 계약). running 칸이 없는 옛 서버면 queue 에서 그 작업 id가 빠질 때
   */
  const waitJobs = async (jobIds, date) => {
    const t0 = Date.now();
    while (alive.current && Date.now() - t0 < POLL_MAX_MS) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(POLL_MS);
      // eslint-disable-next-line no-await-in-loop
      const s = await load();
      if (!s) continue;
      const d = (Array.isArray(s.live) ? s.live : []).find((x) => x.settle_date === date);
      if (d && 'running' in d) {
        if (!d.running) return s;
        continue;
      }
      const q = Array.isArray(s.queue) ? s.queue : [];
      if (!jobIds.some((id) => q.some((j) => j.id === id && RUNNING.has(j.status)))) return s;
    }
    return null;
  };

  const syncNow = async () => {
    if (sendingRef.current || step !== 'idle' || waitLeft > 0) return; // 연타 잠금
    sendingRef.current = true;
    const date = dateOf(pick);
    const before = cur?.rows;
    setStep('sending');
    setMsg(null);
    try {
      // 경락 조회 화면은 force를 보내지 않는다(다시 받기는 수집 현황에만, A 5.1). phase는 서버가 그날 상태로 정한다
      const r = await auctionApi.sync({ source: 'AT_REALTIME', date_from: date, date_to: date });
      const q = r.data?.queued || [];
      const sk = r.data?.skipped || [];
      // 이미 받는 중·이미 대기 중(작업 번호가 있으면) → 새 작업 없이 그 작업을 기다린다
      const runningIds = sk.filter((x) => (x.reason === 'ALREADY_RUNNING' || x.reason === 'ALREADY_QUEUED') && x.job_id).map((x) => x.job_id);
      if (q.length) {
        syncGate.until = Date.now() + SYNC_GAP_MS;
        setNow(Date.now());
      }
      const jobIds = [...q.map((x) => x.id), ...runningIds];
      if (!jobIds.length) {
        const why = sk.map((x) => SYNC_SKIP[x.reason] || x.reason).join(', ');
        setMsg({ tone: 'info', text: why ? `${md2(date)} ${why} — 새로 받을 것이 없습니다.${sk.some((x) => x.reason === 'ALREADY_COMPLETE') ? ' 다시 받기는 수집 현황에서 합니다.' : ''}` : '받을 작업이 없습니다.' });
        return;
      }
      setStep('waiting');
      setMsg({ tone: 'info', text: runningIds.length && !q.length ? '이미 받는 중입니다 — 끝나면 표를 새로 고칩니다.' : '받는 중… 끝나면 표를 새로 고칩니다.' });
      const s = await waitJobs(jobIds, date);
      if (!alive.current) return;
      if (!s) {
        setMsg({ tone: 'warn', text: '2분 안에 끝나지 않았습니다. 수집 현황에서 진행 상태를 확인하세요.' });
        return;
      }
      const d = (Array.isArray(s.live) ? s.live : []).find((x) => x.settle_date === date);
      const lj = d?.last_job && jobIds.includes(d.last_job.job_id) ? d.last_job : null;
      await onCollected?.(date); // 결과와 관계없이 지금 조회 조건으로 1회 다시 조회
      if (!alive.current) return;
      if (lj && (lj.status === 'FAILED' || lj.status === 'DEAD')) {
        setMsg({ tone: 'bad', text: '받기에 실패했습니다. 수집 현황에서 오류를 확인하세요.' });
        return;
      }
      // N건 = 그 작업의 inserted(B 계약). 없으면 행 수 차이
      const gained = lj?.inserted != null ? Number(lj.inserted) : before != null && d?.rows != null ? Math.max(0, Number(d.rows) - Number(before)) : null;
      const upd = Number(lj?.updated || 0);
      setMsg({ tone: 'ok', text: gained == null ? '받기를 마치고 표를 새로 고쳤습니다.' : gained > 0 ? `${won(gained)}건 새로 받음${upd ? ` · ${won(upd)}건 값 바뀜` : ''}` : upd ? `${won(upd)}건 값 바뀜` : '새로 받은 건 없음(원천과 같음)' });
    } catch (e) {
      if (e.code === 'SYNC_RATE_LIMIT') {
        const sec = Number(e.detail?.retry_after_sec) || 300;
        syncGate.until = Date.now() + sec * 1000;
        setNow(Date.now());
        setMsg({ tone: 'warn', text: `수동 받기는 5분에 한 번입니다. ${leftText(sec * 1000)} 뒤 다시 누르세요.` });
      } else {
        setMsg({ tone: 'bad', text: e.message || '수집을 요청하지 못했습니다.' });
      }
    } finally {
      sendingRef.current = false;
      if (alive.current) setStep('idle');
    }
  };

  const info = cur ? LIVE_STATE[cur.state] || { label: cur.state, tone: 'neutral' } : null;
  const times = cur ? liveTimes(cur) : '';
  const busy = step !== 'idle';
  const btnText = step === 'sending' ? '요청 중…' : step === 'waiting' ? '받는 중…' : waitLeft > 0 ? `${leftText(waitLeft)} 뒤 다시 가능` : '지금 받기';

  return (
    <div className={'pm-live' + (canSync ? '' : ' pm-live--view')} data-testid="auction-live-strip" aria-label="경락 수집 상태">
      <div className="pm-live-date">
        <label htmlFor={selId} className="pm-sr">정산분</label>
        <select id={selId} value={pick} disabled={busy} onChange={(e) => { setPick(e.target.value); setMsg(null); }} data-testid="auction-live-date">
          <option value="today">{SETTLE_LABEL.today} {dateOf('today')}</option>
          <option value="yesterday">{SETTLE_LABEL.yesterday} {dateOf('yesterday')}</option>
        </select>
      </div>
      <div className="pm-live-state" role="status" aria-live="polite">
        {info ? (
          <span className={`pm-live-chip pm-live-chip--${info.tone}` + (cur.state === 'LIVE' ? ' is-live' : '')} data-state={cur.state} data-testid="auction-live-state">
            <span className="pm-live-dot" aria-hidden="true" />
            {info.label}
          </span>
        ) : (
          <span className="pm-muted" data-testid="auction-live-state">{loadErr ? '수집 상태를 불러오지 못했습니다' : st ? '수집 상태 정보 없음' : '수집 상태 확인 중…'}</span>
        )}
        {times && <span className="pm-live-times" data-testid="auction-live-times">{times}</span>}
        {cur?.rows != null && cur.state !== 'WAITING' && <span className="pm-live-rows">{won(cur.rows)}건</span>}
        {cur?.running && step === 'idle' && <span className="pm-live-rows" data-testid="auction-live-running"><span className="pm-spin pm-spin--sm" aria-hidden="true" /> 자동 수집 중</span>}
      </div>
      {msg && (
        <p className={`pm-live-msg pm-live-msg--${msg.tone}`} role={msg.tone === 'bad' ? 'alert' : 'status'} data-testid="auction-live-msg">
          {msg.text}
        </p>
      )}
      {canSync && (
        <div className="pm-live-act">
          <button
            type="button"
            className={'main-btn main-btn--secondary pm-live-btn' + (busy ? ' is-busy' : '')}
            onClick={syncNow}
            disabled={busy || waitLeft > 0}
            aria-busy={busy}
            aria-label={btnText}
            title={waitLeft > 0 ? '수동 받기는 회원별 5분에 한 번입니다' : `${SETTLE_LABEL[pick]}(${dateOf(pick)})을 지금 원천에서 받습니다`}
            data-testid="auction-live-sync"
          >
            {busy && <span className="pm-spin" aria-hidden="true" />}
            {waitLeft > 0 && !busy ? <>{leftText(waitLeft)} 뒤<span className="pm-live-btn-tail"> 다시 가능</span></> : btnText}
          </button>
        </div>
      )}
    </div>
  );
}

const md2 = (ymd) => String(ymd || '').slice(0, 10);
