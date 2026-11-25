// T-203 ② 수집 현황 (설계 6.3) — R-96 현황 · R-97 작업 / 쓰기 R-98 지금 받기(주인) · R-132 다시 실행(주인) · R-99 대기 취소(관리자)
// 잠금(T-404): [지금 받기] 응답까지 버튼·기간 잠금, 429 SYNC_RATE_LIMIT 은 남은 시간 표시, 행별 버튼은 useBusyIds
import { useCallback, useEffect, useId, useState } from 'react';
import { auctionApi } from '../lib/auctionApi';
import { getUser } from '../api';
import { can } from '../lib/staffAccess';
import { useBusyIds, useLatestRequest } from '../components/Busy';
import { ErrorLine, MockBadge, Tone } from '../components/MatchBits';
import {
  CIRCUIT, DISABLED_REASON, ERROR_KIND, JOB_STATUS, PHASE_SHORT, SNAPSHOT_STATUS, SOURCE_LABEL,
  kstAddDays, kstTime, kstToday, md, won,
} from '../lib/matchLabels';

const SYNC_GAP_MS = 5 * 60 * 1000;

export default function AuctionSyncStatus() {
  const today = kstToday();
  const user = getUser();
  const isOwner = !user?.staff;
  const isAdmin = isOwner && !!user?.is_admin;
  const canSync = isOwner && can('auction.sync');
  const ids = { from: useId(), to: useId(), phase: useId(), src: useId() };
  const [st, setSt] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState({ source: 'AT_REALTIME', date_from: kstAddDays(today, -4), date_to: today, phase: 'FINAL', force: false });
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null); // { tone, text }
  const [rateUntil, setRateUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const rowBusy = useBusyIds();
  const latest = useLatestRequest();

  const load = useCallback(async () => {
    const t = latest.next();
    setLoading(true);
    setErr(null);
    try {
      const [s, j] = await Promise.all([
        auctionApi.syncStatus({ date_from: kstAddDays(today, -6), date_to: today }),
        auctionApi.jobs({ limit: 30, offset: 0 }),
      ]);
      if (!latest.isCurrent(t)) return;
      setSt(s);
      setJobs(j.data || []);
    } catch (e) {
      if (latest.isCurrent(t)) setErr(e);
    } finally {
      if (latest.isCurrent(t)) setLoading(false);
    }
  }, [latest, today]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (rateUntil <= now) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rateUntil, now]);

  const waitLeft = Math.max(0, rateUntil - now);
  const syncNow = async () => {
    if (syncing || waitLeft > 0) return;
    if (form.date_from > form.date_to || form.date_to > today) {
      setSyncMsg({ tone: 'bad', text: '기간을 바르게 지정하세요(미래 날짜 안 됨).' });
      return;
    }
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await auctionApi.sync(form);
      const q = r.data?.queued || [];
      const sk = r.data?.skipped || [];
      const skipText = sk.map((s) => `${md(s.target_date)} ${s.reason === 'ALREADY_COMPLETE' ? '이미 받음' : s.reason === 'HOLIDAY' ? '휴장' : s.reason === 'ALREADY_QUEUED' ? '이미 대기 중' : s.reason}`).join(', ');
      setSyncMsg({ tone: 'ok', text: `${q.length}건을 수집 대기열에 넣었습니다.${skipText ? ` 건너뜀: ${skipText}` : ''}` });
      setRateUntil(Date.now() + SYNC_GAP_MS);
      setNow(Date.now());
      load();
    } catch (e) {
      if (e.code === 'SYNC_RATE_LIMIT') {
        const sec = Number(e.detail?.retry_after_sec) || 300;
        setRateUntil(Date.now() + sec * 1000);
        setNow(Date.now());
      }
      setSyncMsg({ tone: 'bad', text: e.message });
    } finally {
      setSyncing(false);
    }
  };

  const rowAction = async (job, kind) => {
    const key = `${kind}:${job.id}`;
    if (!rowBusy.start(key)) return;
    try {
      if (kind === 'retry') await auctionApi.retryJob(job.id);
      else await auctionApi.cancelJob(job.id);
      setSyncMsg({ tone: 'ok', text: kind === 'retry' ? `작업 #${job.id}를 다시 넣었습니다.` : `작업 #${job.id}를 취소했습니다.` });
      load();
    } catch (e) {
      setSyncMsg({ tone: 'bad', text: e.message });
    } finally {
      rowBusy.end(key);
    }
  };

  const circuits = st?.circuits || [];
  const days = st?.days || [];

  return (
    <section className="pm-section" aria-label="수집 현황" data-testid="auction-sync">
      <div className="pm-toolbar">
        <MockBadge mode={st?.source_mode} />
        <button type="button" className="main-btn main-btn--secondary" onClick={load} disabled={loading} data-testid="auction-sync-reload">
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>
      <ErrorLine error={err} />

      <div className="pm-card">
        <h3 className="pm-h3">소스 상태</h3>
        <ul className="pm-circuits" data-testid="auction-circuits">
          {circuits.length === 0 && !loading && <li className="pm-muted">상태 정보 없음</li>}
          {circuits.map((c) => {
            const dis = c.disabled_reason;
            const info = dis ? { label: DISABLED_REASON[dis] || dis, tone: dis === 'AUTH_ERROR' ? 'bad' : 'warn' } : CIRCUIT[c.state] || { label: c.state, tone: 'neutral' };
            return (
              <li key={c.source} data-testid={`auction-circuit-${c.source}`}>
                <strong>{SOURCE_LABEL[c.source] || c.source}</strong>
                <Tone tone={info.tone}>● {info.label}</Tone>
                {c.state === 'OPEN' && c.next_probe_at && <span className="pm-muted">{kstTime(c.next_probe_at, false)}에 다시 시도</span>}
                {c.last_error_kind && c.state !== 'CLOSED' && <span className="pm-muted">· {ERROR_KIND[c.last_error_kind] || c.last_error_kind}</span>}
                {c.last_success_at && <span className="pm-muted">· 마지막 성공 {kstTime(c.last_success_at)}</span>}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="pm-card">
        <h3 className="pm-h3">날짜별</h3>
        <ul className="pm-daychips" data-testid="auction-days">
          {days.length === 0 && !loading && <li className="pm-muted">최근 7일 수집 기록 없음</li>}
          {days.map((d) => {
            const s = SNAPSHOT_STATUS[d.status] || { label: d.status, tone: 'neutral' };
            return (
              <li key={`${d.trade_date}-${d.source}-${d.phase}`}>
                <Tone tone={s.tone} title={`${SOURCE_LABEL[d.source] || d.source}${d.finished_at ? ` · ${kstTime(d.finished_at)} 끝남` : ''}${d.verify_warning ? ` · ${d.verify_warning}` : ''}`}>
                  {md(d.trade_date)} {PHASE_SHORT[d.phase] || d.phase} {s.label}
                  {d.status === 'COMPLETE' && ` ${won(d.fetched_count)}건`}
                  {d.unmapped > 0 && ` (미매핑 ${d.unmapped})`}
                </Tone>
              </li>
            );
          })}
        </ul>
      </div>

      {canSync ? (
        <div className="main-filters pm-filters" data-testid="auction-sync-form">
          <label htmlFor={ids.src}>
            소스
            <select id={ids.src} value={form.source} disabled={syncing} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="AT_REALTIME">{SOURCE_LABEL.AT_REALTIME}</option>
              <option value="AT_SETTLE">{SOURCE_LABEL.AT_SETTLE}</option>
              <option value="GARAK_PRICE">{SOURCE_LABEL.GARAK_PRICE}</option>
            </select>
          </label>
          <label htmlFor={ids.from}>
            기간
            <input id={ids.from} type="date" value={form.date_from} max={today} disabled={syncing} onChange={(e) => setForm({ ...form, date_from: e.target.value })} data-testid="auction-sync-from" />
          </label>
          <span aria-hidden="true">~</span>
          <label htmlFor={ids.to}>
            <span className="pm-sr">끝 날짜</span>
            <input id={ids.to} type="date" value={form.date_to} max={today} disabled={syncing} onChange={(e) => setForm({ ...form, date_to: e.target.value })} data-testid="auction-sync-to" />
          </label>
          <label htmlFor={ids.phase}>
            단계
            <select id={ids.phase} value={form.phase} disabled={syncing} onChange={(e) => setForm({ ...form, phase: e.target.value })}>
              <option value="FINAL">확정</option>
              <option value="INTRADAY">당일</option>
            </select>
          </label>
          <label className="main-filter-checkbox">
            <input type="checkbox" checked={form.force} disabled={syncing} onChange={(e) => setForm({ ...form, force: e.target.checked })} />
            이미 받은 날도 다시
          </label>
          <button type="button" className="main-btn" onClick={syncNow} disabled={syncing || waitLeft > 0} aria-busy={syncing} data-testid="auction-sync-now">
            {syncing ? '요청 중…' : waitLeft > 0 ? `${Math.ceil(waitLeft / 60000)}분 뒤 다시 가능` : '지금 받기'}
          </button>
        </div>
      ) : (
        <p className="pm-muted">수동 수집(지금 받기)·다시 실행은 중매인(주인) 계정만 할 수 있습니다.</p>
      )}
      {syncMsg && <p className={syncMsg.tone === 'bad' ? 'pm-error' : 'pm-ok'} role={syncMsg.tone === 'bad' ? 'alert' : 'status'} data-testid="auction-sync-msg">{syncMsg.text}</p>}

      <div className="main-table-wrap pm-table-wrap">
        <table className="main-table pm-table" data-testid="auction-jobs">
          <thead>
            <tr>
              <th>작업</th>
              <th>종류</th>
              <th>대상일</th>
              <th>상태</th>
              <th className="pm-num">시도</th>
              <th>다음 실행·오류</th>
              <th>요청</th>
              <th>동작</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && !loading && <tr><td colSpan={8} className="main-empty-cell">작업 기록 없음</td></tr>}
            {jobs.map((j) => {
              const s = JOB_STATUS[j.status] || { label: j.status, tone: 'neutral' };
              const failed = j.status === 'FAILED' || j.status === 'DEAD';
              return (
                <tr key={j.id} data-testid={`auction-job-${j.id}`}>
                  <td data-label="작업">#{j.id}</td>
                  <td data-label="종류">{j.job_type} {SOURCE_LABEL[j.source] ? `· ${SOURCE_LABEL[j.source]}` : ''}</td>
                  <td data-label="대상일">{md(j.trade_date || j.target_date)} {PHASE_SHORT[j.phase] || ''}</td>
                  <td data-label="상태"><Tone tone={s.tone}>{s.label}</Tone></td>
                  <td className="pm-num" data-label="시도">{j.attempts ?? 0}/{j.max_attempts ?? 5}</td>
                  <td data-label="다음 실행·오류">
                    {j.status === 'QUEUED' && j.run_after && `${kstTime(j.run_after, false)} 실행`}
                    {j.last_error_kind && <span className="pm-muted"> · {ERROR_KIND[j.last_error_kind] || j.last_error_kind}</span>}
                    {j.error_message && <span className="pm-muted pm-clip" title={j.error_message}> · {j.error_message}</span>}
                  </td>
                  <td data-label="요청">{j.requested_by_name || (j.requested_by_user_id ? '사용자' : '자동')}</td>
                  <td data-label="동작"><div className="pm-actions">
                    {failed && canSync && (
                      <button type="button" className="main-btn main-btn--secondary" disabled={rowBusy.has(`retry:${j.id}`)} onClick={() => rowAction(j, 'retry')} data-testid={`auction-job-retry-${j.id}`}>
                        {rowBusy.has(`retry:${j.id}`) ? '요청 중…' : '다시 실행'}
                      </button>
                    )}
                    {j.status === 'QUEUED' && isAdmin && (
                      <button type="button" className="main-btn main-btn--secondary" disabled={rowBusy.has(`cancel:${j.id}`)} onClick={() => rowAction(j, 'cancel')} data-testid={`auction-job-cancel-${j.id}`}>
                        {rowBusy.has(`cancel:${j.id}`) ? '취소 중…' : '대기 취소'}
                      </button>
                    )}
                  </div></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
