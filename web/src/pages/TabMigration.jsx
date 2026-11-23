// T-403 데이터 이관 탭 (주인만) — 설계 5.8
// 1) 묶음 목록·만들기  2) 묶음 화면(draft): 대상 7칸 카드 [템플릿][올리기/바꾸기][빼기] → [전체 검증] → 경고 확인 → [저장]
// 3) 묶음 화면(saved): 대조 리포트 + [엑셀 받기] · [되돌리기 가능 확인] → 막는 목록 또는 [되돌리기]  4) 이관 기록 조회
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { migrationApi } from '../lib/migrationApi';
import '../components/ExcelUpload.css';
import './TabMigration.css';

const KINDS = [
  { kind: 'partner', label: '① 거래처', help: '판매처·매입처·같은 시장·생산자. 이름이 같은 거래처는 새로 만들지 않고 그대로 씁니다.' },
  { kind: 'product', label: '② 품목', help: '내 품목(공용=Y는 관리자만). 이름이 같은 품목은 그대로 씁니다.' },
  { kind: 'opening_ar', label: '③ 기초 미수', help: '기준일에 받을 돈. 원래 매출일로 미수 연령을 셉니다.' },
  { kind: 'opening_ap', label: '④ 기초 미지급', help: '기준일에 줄 돈(매입처·생산자).' },
  { kind: 'opening_stock', label: '⑤ 기초 재고', help: '남은 수량·원가·입고일 → 오래된 것부터 팝니다.' },
  { kind: 'history', label: '⑥ 과거 거래(기록)', help: '참고 기록. 잔액·재고를 바꾸지 않습니다(선택).' },
  { kind: 'disposal', label: '⑦ 폐기', help: '기준일 전 = 기록만, 기준일~오늘 = 이관 재고에서 차감.' },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label]));
const STATUS = { draft: '검증 중', saved: '저장됨', rolled_back: '되돌림' };
const HISTORY_KIND = { purchase: '매입', sale: '매출', receipt: '수금', supplier_payment: '지급', disposal: '폐기' };
const won = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR'));
const qty = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 3 }));
const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const PAGE = 200;

function countText(c) {
  if (!c || !Object.keys(c).length) return '-';
  const g = (k, f) => (c[k] ? c[k][f] || 0 : 0);
  const parts = [];
  if (g('partner', 'created')) parts.push(`거래처 ${g('partner', 'created')}`);
  if (g('product', 'created')) parts.push(`품목 ${g('product', 'created')}`);
  if (g('opening_ar', 'saved')) parts.push(`기초 미수 ${g('opening_ar', 'saved')}건`);
  if (g('opening_ap', 'saved')) parts.push(`기초 미지급 ${g('opening_ap', 'saved')}건`);
  if (g('opening_stock', 'saved')) parts.push(`재고 ${g('opening_stock', 'saved')}로트`);
  const h = g('history', 'history') + g('disposal', 'history');
  if (h) parts.push(`기록 ${h}건`);
  if (g('disposal', 'disposed')) parts.push(`폐기 ${g('disposal', 'disposed')}건`);
  return parts.join(' · ') || '-';
}

export default function TabMigration() {
  const [view, setView] = useState({ name: 'list' }); // list | batch(id) | history
  return (
    <div className="mg">
      <div className="mg-nav" role="tablist" aria-label="데이터 이관 화면">
        <button type="button" role="tab" aria-selected={view.name !== 'history'} className={'mg-nav-btn' + (view.name !== 'history' ? ' on' : '')} onClick={() => setView({ name: 'list' })}>
          이관 묶음
        </button>
        <button type="button" role="tab" aria-selected={view.name === 'history'} className={'mg-nav-btn' + (view.name === 'history' ? ' on' : '')} onClick={() => setView({ name: 'history' })}>
          이관 기록 조회
        </button>
      </div>
      {view.name === 'list' && <BatchList onOpen={(id) => setView({ name: 'batch', id })} />}
      {view.name === 'batch' && <BatchView id={view.id} onBack={() => setView({ name: 'list' })} />}
      {view.name === 'history' && <HistoryView />}
    </div>
  );
}

// ---------------------------------------------------------------------------
function BatchList({ onOpen }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [date, setDate] = useState(kstToday());
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const dateId = useId();
  const memoId = useId();
  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const r = await migrationApi.list();
      setRows(r.data || []);
      const saved = (r.data || []).find((b) => b.status === 'saved');
      if (saved) setDate(saved.cutover_date);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const create = async (e) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await migrationApi.create(date, memo.trim() || undefined);
      onOpen(r.data.id);
    } catch (ex) {
      setErr(ex.message);
      setBusy(false);
    }
  };
  const hasSaved = rows.some((b) => b.status === 'saved');
  return (
    <section aria-label="이관 묶음 목록">
      <div className="mg-intro">
        <p><b>쓰던 장부를 이 프로그램으로 옮깁니다.</b> 기준일(이 프로그램으로 장부를 시작하는 날)을 정하고, 거래처·품목·기초 미수·기초 미지급·기초 재고·과거 거래·폐기 파일을 올려 한 번에 검증·저장합니다.</p>
        <p className="mg-muted">받을 돈·줄 돈은 ③④ 파일로만, 재고는 ⑤ 파일로만 정해집니다. 저장 뒤 틀린 것은 묶음 전체를 되돌리고 다시 올립니다.</p>
      </div>
      <form className="mg-create" onSubmit={create}>
        <label htmlFor={dateId}>기준일</label>
        <input id={dateId} type="date" value={date} max={kstToday()} onChange={(e) => setDate(e.target.value)} disabled={hasSaved} required />
        <label htmlFor={memoId}>메모</label>
        <input id={memoId} type="text" maxLength={200} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 2026년 11월 장부 이관" />
        <button type="submit" className="main-btn" disabled={busy || !date}>{busy ? '만드는 중…' : '새 이관 묶음'}</button>
        {hasSaved && <span className="mg-muted mg-create-note">저장한 묶음이 있어 기준일은 {date}로 고정됩니다.</span>}
      </form>
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      {loading ? (
        <p className="mg-muted" aria-busy="true">불러오는 중…</p>
      ) : rows.length === 0 ? (
        <p className="mg-empty">아직 이관 묶음이 없습니다. 기준일을 정하고 [새 이관 묶음]을 누르세요.</p>
      ) : (
        <div className="main-table-wrap">
          <table className="main-table mg-table">
            <thead>
              <tr><th>묶음</th><th>기준일</th><th>상태</th><th>만든 것</th><th>메모</th><th aria-label="열기" /></tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td data-label="묶음">#{b.id}</td>
                  <td data-label="기준일">{b.cutover_date}</td>
                  <td data-label="상태"><span className={`mg-status mg-status--${b.status}`}>{STATUS[b.status]}</span></td>
                  <td data-label="만든 것">{b.status === 'draft' ? `파일 ${b.file_count}개` : countText(b.counts)}</td>
                  <td data-label="메모">{b.memo || ''}</td>
                  <td><button type="button" className="main-btn main-btn--secondary" onClick={() => onOpen(b.id)}>열기</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
function BatchView({ id, onBack }) {
  const [batch, setBatch] = useState(null);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null); // 검증·저장 응답
  const [confirmed, setConfirmed] = useState(false);
  // T-404: 파일 올리기·빼기 중인 카드 — 진행 중에는 검증·저장·삭제·목록 이동을 잠근다(바꾸기 전 파일로 저장되는 것 방지)
  const [cardBusy, setCardBusy] = useState({});
  const onCardBusy = useCallback((kind, on) => {
    setCardBusy((m) => ({ ...m, [kind]: on }));
    if (on) {
      setResult(null); // 파일이 바뀌면 이전 검증 결과로는 저장하지 않는다 — 다시 검증해야 저장 버튼이 나온다
      setConfirmed(false);
    }
  }, []);
  const load = useCallback(async () => {
    try {
      const r = await migrationApi.get(id);
      setBatch(r.data);
      return r.data;
    } catch (e) {
      setErr(e.message);
      return null;
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (!batch) return <p className="mg-muted">{err || '불러오는 중…'}</p>;

  const files = Object.fromEntries((batch.files || []).map((f) => [f.kind, f]));
  const run = async (what, fn) => {
    setErr('');
    setNotice('');
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const onValidate = () => run('validate', async () => {
    const r = await migrationApi.validate(id);
    setResult(r);
    setConfirmed(false);
    await load();
  });
  const onCommit = () => run('commit', async () => {
    const r = await migrationApi.commit(id, confirmed);
    if (r.saved) {
      setResult(null);
      setNotice(`저장했습니다 — ${countText(r.summary.counts)}. 아래 대조 리포트에서 파일 합과 저장 합이 같은지 확인하세요.`);
      await load();
    } else {
      if (r.files) setResult(r);
      setErr(r.message || '저장하지 못했습니다.');
    }
  });
  const onDelete = () => run('delete', async () => {
    if (!window.confirm(`묶음 #${id}을(를) 삭제할까요? 올린 파일도 함께 지워집니다.`)) return;
    await migrationApi.remove(id);
    onBack();
  });

  const summary = result && result.summary;
  const warnCount = summary ? summary.warnings : 0;
  const locked = !!busy || Object.values(cardBusy).some(Boolean);
  const canSave = batch.status === 'draft' && summary && summary.errors === 0 && (warnCount === 0 || confirmed) && !locked;

  return (
    <section aria-label={`이관 묶음 #${id}`}>
      <div className="mg-head">
        <button type="button" className="main-btn main-btn--secondary" onClick={onBack} disabled={locked}>← 목록</button>
        <h3 className="mg-title">묶음 #{batch.id} <span className={`mg-status mg-status--${batch.status}`}>{STATUS[batch.status]}</span></h3>
        <span className="mg-cut">기준일 <b>{batch.cutover_date}</b></span>
        {batch.memo && <span className="mg-muted">{batch.memo}</span>}
        {batch.status === 'draft' && (
          <button type="button" className="main-btn main-btn--secondary mg-danger-text mg-head-right" onClick={onDelete} disabled={locked}>묶음 삭제</button>
        )}
      </div>
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      {notice && <p className="xl-banner xl-banner--ok" role="status">{notice}</p>}

      {batch.status === 'draft' && (
        <>
          <div className="mg-cards">
            {KINDS.map((k) => (
              <KindCard key={k.kind} def={k} file={files[k.kind]} batchId={id} disabled={locked} onBusy={onCardBusy}
                onChanged={async (msg) => { setResult(null); setNotice(msg || ''); await load(); }}
                onError={setErr} />
            ))}
          </div>
          <div className="mg-actions">
            <button type="button" className="main-btn" onClick={onValidate} disabled={locked || !(batch.files || []).length}>
              {busy === 'validate' ? '검증 중…' : '전체 검증'}
            </button>
            <span className="mg-muted">저장 순서대로 실제로 넣어 본 뒤 되돌립니다. 결과가 그대로 저장 결과입니다.</span>
          </div>
          {result && (
            <ValidateResult result={result} confirmed={confirmed} setConfirmed={setConfirmed} />
          )}
          {result && (
            <div className="mg-actions mg-actions--save">
              <button type="button" className="main-btn" onClick={onCommit} disabled={!canSave}
                title={canSave ? '' : summary.errors ? '오류가 0줄일 때만 저장할 수 있습니다' : '경고를 확인해야 저장할 수 있습니다'}>
                {busy === 'commit' ? '저장 중…' : '저장(전부 아니면 전무)'}
              </button>
              {summary.errors > 0 && <span className="mg-err-note">오류 {won(summary.errors)}줄 — 엑셀에서 고쳐 다시 올린 뒤 검증하세요.</span>}
            </div>
          )}
        </>
      )}

      {batch.status === 'saved' && <SavedView batch={batch} onRolledBack={async (msg) => { setNotice(msg); await load(); }} />}
      {batch.status === 'rolled_back' && (
        <p className="xl-banner xl-banner--warn" role="status">
          {String(batch.rolled_back_at || '').slice(0, 10)}에 되돌렸습니다 — 사유: {batch.rollback_reason}. 이 묶음이 만든 거래처·품목·잔액·재고는 지워졌습니다. 같은 파일을 새 묶음에 다시 올릴 수 있습니다.
        </p>
      )}
    </section>
  );
}

function KindCard({ def, file, batchId, disabled, onChanged, onError, onBusy }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState('');
  const pick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) return onError('엑셀(.xlsx) 파일을 골라 주세요.');
    if (f.size > 5 * 1024 * 1024) return onError('파일은 5MB까지 올릴 수 있습니다. 나눠서 여러 묶음으로 올려 주세요.');
    setBusy('up');
    onBusy?.(def.kind, true);
    onError('');
    try {
      const r = await migrationApi.upload(batchId, def.kind, f);
      await onChanged(`${def.label} 파일을 올렸습니다(${won(r.data.row_count)}줄). [전체 검증]을 다시 누르세요.`);
    } catch (ex) {
      onError(ex.message);
    } finally {
      setBusy('');
      onBusy?.(def.kind, false);
    }
  };
  const remove = async () => {
    setBusy('rm');
    onBusy?.(def.kind, true);
    try {
      await migrationApi.removeFile(batchId, def.kind);
      await onChanged(`${def.label} 파일을 뺐습니다.`);
    } catch (ex) {
      onError(ex.message);
    } finally {
      setBusy('');
      onBusy?.(def.kind, false);
    }
  };
  const tpl = async () => {
    setBusy('tpl');
    try {
      await migrationApi.template(def.kind);
    } catch (ex) {
      onError(ex.message);
    } finally {
      setBusy('');
    }
  };
  const res = file && Array.isArray(file.result) ? file.result : null;
  const errN = res ? res.filter((r) => !r.ok).length : 0;
  return (
    <div className={'mg-card' + (file ? ' has' : '')}>
      <div className="mg-card-head">
        <span className="mg-card-title">{def.label}</span>
        {file && res && <span className={'xl-badge ' + (errN ? 'xl-badge--err' : 'xl-badge--ok')}>{errN ? `오류 ${errN}` : '검증 OK'}</span>}
      </div>
      <p className="mg-card-help">{def.help}</p>
      {file ? (
        <p className="mg-card-file" title={file.file_name || ''}>
          {file.file_name} · {won(file.row_count)}줄
          {file.amount_total > 0 && <> · {won(file.amount_total)}원</>}
          {file.qty_total > 0 && <> · 수량 {qty(file.qty_total)}</>}
        </p>
      ) : (
        <p className="mg-card-file mg-muted">파일 없음</p>
      )}
      <div className="mg-card-btns">
        <button type="button" className="main-btn main-btn--secondary" onClick={tpl} disabled={disabled || !!busy}>{busy === 'tpl' ? '…' : '템플릿'}</button>
        <button type="button" className="main-btn main-btn--secondary" onClick={() => ref.current && ref.current.click()} disabled={disabled || !!busy}>
          {busy === 'up' ? '올리는 중…' : file ? '바꾸기' : '올리기'}
        </button>
        {file && <button type="button" className="main-btn main-btn--secondary" onClick={remove} disabled={disabled || !!busy}>빼기</button>}
      </div>
      <input ref={ref} type="file" accept=".xlsx" hidden onChange={pick} aria-label={`${def.label} 파일`} />
    </div>
  );
}

function ValidateResult({ result, confirmed, setConfirmed }) {
  const [onlyIssue, setOnlyIssue] = useState(result.summary.errors > 0);
  const [shown, setShown] = useState(PAGE);
  const s = result.summary;
  const kinds = KINDS.filter((k) => result.files && result.files[k.kind]);
  return (
    <div className="mg-result" aria-live="polite">
      <div className="xl-summary">
        {kinds.map((k) => {
          const c = s.counts[k.kind] || {};
          return (
            <span key={k.kind} className={'xl-chip ' + (c.errors ? 'xl-chip--err' : 'xl-chip--ok')}>
              {k.label} <b>{won(c.rows)}</b>줄{c.errors ? <> · 오류 <b>{c.errors}</b></> : null}
              {c.amount ? <> · {won(c.amount)}원</> : null}{c.qty ? <> · 수량 {qty(c.qty)}</> : null}
            </span>
          );
        })}
      </div>
      {s.errors > 0 ? (
        <p className="xl-banner xl-banner--err" role="alert">오류 {won(s.errors)}줄. 하나라도 있으면 아무것도 저장하지 않습니다.</p>
      ) : (
        <p className="xl-banner" role="status">오류가 없습니다{s.warnings ? ` — 경고 ${won(s.warnings)}건을 확인하면 저장할 수 있습니다` : ' — 저장할 수 있습니다'}.</p>
      )}
      {(result.warnings || []).length > 0 && (
        <ul className="mg-warns">
          {result.warnings.map((w) => <li key={w.code + w.message} className="xl-banner xl-banner--warn">{w.message}</li>)}
        </ul>
      )}
      {s.errors === 0 && s.warnings > 0 && (
        <label className="mg-confirm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> 경고 {won(s.warnings)}건을 확인했습니다(줄 경고 포함)
        </label>
      )}
      <label className="xl-only-err">
        <input type="checkbox" checked={onlyIssue} onChange={(e) => { setOnlyIssue(e.target.checked); setShown(PAGE); }} /> 오류·경고 줄만 보기
      </label>
      {kinds.map((k) => {
        const rows = result.files[k.kind].rows.filter((r) => !onlyIssue || !r.ok || r.warning);
        if (!rows.length) return null;
        return (
          <div key={k.kind} className="mg-kind-rows">
            <h4>{k.label}</h4>
            <ul className="xl-rows" aria-label={`${k.label} 줄별 결과`}>
              {rows.slice(0, shown).map((r) => (
                <li key={r.line} className={'xl-row ' + (r.ok ? 'xl-row--ok' : 'xl-row--err')}>
                  <span className="xl-line">{r.line}행</span>
                  <span className={'xl-badge ' + (r.ok ? 'xl-badge--ok' : 'xl-badge--err')}>{r.ok ? ({ created: '새로', existing: '기존 사용', saved: 'OK', history: '기록', disposed: '재고 차감' }[r.status] || 'OK') : '오류'}</span>
                  <span className="xl-text">
                    {r.summary && <span className="xl-sum">{r.summary}</span>}
                    {!r.ok && <span className="xl-msg">{r.message}</span>}
                    {r.ok && r.warning && <span className="xl-msg xl-msg--warn">{r.warning}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {rows.length > shown && <button type="button" className="main-btn main-btn--secondary xl-more" onClick={() => setShown((n) => n + PAGE)}>{won(rows.length - shown)}줄 더 보기</button>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
function SavedView({ batch, onRolledBack }) {
  const [rep, setRep] = useState(null);
  const [err, setErr] = useState('');
  const [check, setCheck] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const reasonId = useId();
  useEffect(() => {
    migrationApi.reconcile(batch.id).then((r) => setRep(r.data)).catch((e) => setErr(e.message));
  }, [batch.id]);
  const doCheck = async () => {
    setBusy('check');
    setErr('');
    try {
      const r = await migrationApi.rollbackCheck(batch.id);
      setCheck(r.data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const doRollback = async () => {
    if (!reason.trim()) return setErr('되돌리는 사유를 입력하세요.');
    setBusy('rb');
    setErr('');
    try {
      const r = await migrationApi.rollback(batch.id, reason.trim());
      if (r.status === 200 && r.ok) await onRolledBack(`묶음 #${batch.id}을(를) 되돌렸습니다.`);
      else {
        setErr(r.message || '되돌리지 못했습니다.');
        if (r.blockers) setCheck({ can_rollback: false, blockers: r.blockers });
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="mg-saved">
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      <div className="mg-rep-head">
        <h4>대조 리포트</h4>
        {rep && (
          <span className={'mg-status ' + (rep.all_zero ? 'mg-status--saved' : 'mg-status--bad')}>{rep.all_zero ? '파일 합 = 저장 합 (차이 0)' : '차이 있음'}</span>
        )}
        <button type="button" className="main-btn main-btn--secondary" onClick={() => migrationApi.reconcileXlsx(batch.id).catch((e) => setErr(e.message))}>엑셀 받기</button>
      </div>
      {!rep ? <p className="mg-muted">불러오는 중…</p> : <Reconcile rep={rep} />}

      <div className="mg-rollback">
        <h4>되돌리기</h4>
        <p className="mg-muted">묶음이 만든 거래처·품목·기초 잔액·이관 재고·이관 기록·폐기를 모두 지웁니다. 이후 거래(수금·판매·지급 등)가 이 데이터를 쓰고 있으면 되돌릴 수 없습니다 — 그때는 매출 할인 등으로 바로잡으세요.</p>
        <button type="button" className="main-btn main-btn--secondary" onClick={doCheck} disabled={!!busy}>{busy === 'check' ? '확인 중…' : '되돌리기 가능 확인'}</button>
        {check && !check.can_rollback && (
          <div className="mg-blockers" role="alert">
            <p className="xl-banner xl-banner--err">되돌릴 수 없습니다 — 아래 거래가 이 묶음의 데이터를 쓰고 있습니다.</p>
            <ul>
              {(check.blockers || []).map((b) => (
                <li key={b.type}><b>{b.label}</b> {won(b.count)}건{b.samples && b.samples.length ? ` — ${b.samples.map((x) => `${x.summary}${x.date ? ` (${x.date})` : ''}`).join(', ')}` : ''}</li>
              ))}
            </ul>
          </div>
        )}
        {check && check.can_rollback && (
          <div className="mg-rb-form">
            <label htmlFor={reasonId}>사유</label>
            <input id={reasonId} type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 기초 미수 금액 오타" />
            <button type="button" className="main-btn mg-danger" onClick={doRollback} disabled={!!busy || !reason.trim()}>{busy === 'rb' ? '되돌리는 중…' : '되돌리기'}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Reconcile({ rep }) {
  const diffCls = (v) => (Number(v) !== 0 ? 'mg-diff-bad' : '');
  return (
    <>
      <div className="main-table-wrap">
        <table className="main-table mg-rep">
          <caption>요약 — 파일 줄 = 새로 만듦 + 기존 사용 + 저장 + 기록 + 재고 차감</caption>
          <thead><tr><th>대상</th><th>파일</th><th className="num">파일 줄</th><th className="num">새로</th><th className="num">기존 사용</th><th className="num">기초·재고</th><th className="num">기록</th><th className="num">폐기 차감</th><th>일치</th></tr></thead>
          <tbody>
            {rep.summary.filter((s) => s.file_rows > 0).map((s) => (
              <tr key={s.kind} className={s.matched ? '' : 'mg-diff-bad'}>
                <td>{LABEL[s.kind]}</td><td className="mg-ellipsis">{s.file_name}</td><td className="num">{won(s.file_rows)}</td><td className="num">{won(s.created)}</td>
                <td className="num">{won(s.existing)}</td><td className="num">{won(s.saved)}</td><td className="num">{won(s.history)}</td><td className="num">{won(s.disposed)}</td><td>{s.matched ? '일치' : '불일치'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {[['기초 미수 — 거래처별', rep.receivable, '현재 미수'], ['기초 미지급 — 거래처별', rep.payable, '현재 미지급']].map(([title, sec, cur]) => (sec.rows.length > 0 && (
        <div key={title} className="main-table-wrap">
          <table className="main-table mg-rep">
            <caption>{title}</caption>
            <thead><tr><th>거래처</th><th className="num">파일 합</th><th className="num">저장 합</th><th className="num">차이</th><th className="num">{cur}</th></tr></thead>
            <tbody>
              {sec.rows.map((r) => (
                <tr key={`${r.partner_id}-${r.partner_name}`} className={diffCls(r.diff)}>
                  <td>{r.partner_name}</td><td className="num">{won(r.file_amount)}</td><td className="num">{won(r.saved_amount)}</td><td className="num">{won(r.diff)}</td><td className="num">{won(r.current)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th>합계</th><td className="num">{won(sec.total.file_amount)}</td><td className="num">{won(sec.total.saved_amount)}</td><td className="num">{won(sec.total.diff)}</td><td className="num">{won(sec.total.current)}</td></tr></tfoot>
          </table>
        </div>
      )))}
      {rep.stock.rows.length > 0 && (
        <div className="main-table-wrap">
          <table className="main-table mg-rep">
            <caption>기초 재고 — 품목별</caption>
            <thead><tr><th>품목</th><th className="num">파일 수량</th><th className="num">저장 수량</th><th className="num">파일 금액</th><th className="num">저장 금액</th><th className="num">차이</th><th className="num">기준일 이후 폐기</th><th className="num">현재 재고</th></tr></thead>
            <tbody>
              {rep.stock.rows.map((r) => (
                <tr key={`${r.product_id}-${r.product_name}`} className={diffCls(r.diff_qty) || diffCls(r.diff_amount)}>
                  <td>{r.product_name}</td><td className="num">{qty(r.file_qty)}</td><td className="num">{qty(r.saved_qty)}</td><td className="num">{won(r.file_amount)}</td>
                  <td className="num">{won(r.saved_amount)}</td><td className="num">{qty(r.diff_qty)} / {won(r.diff_amount)}</td><td className="num">{qty(r.disposed_after)}</td><td className="num">{qty(r.current_qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
function HistoryView() {
  const [f, setF] = useState({ from_date: '', to_date: '', kind: '', q: '' });
  const [data, setData] = useState({ data: [], total: 0 });
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async (off) => {
    setLoading(true);
    setErr('');
    try {
      const params = { limit: 50, offset: off };
      for (const [k, v] of Object.entries(f)) if (v) params[k] = v;
      const r = await migrationApi.history(params);
      setData(r);
      setOffset(off);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [f]);
  useEffect(() => { load(0); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <section aria-label="이관 기록 조회">
      <p className="mg-muted">과거 거래·기준일 전 폐기의 참고 기록입니다. 미수·미지급·재고·원장에는 들어가지 않습니다.</p>
      <form className="mg-filter" onSubmit={(e) => { e.preventDefault(); load(0); }}>
        <label>시작일 <input type="date" value={f.from_date} onChange={set('from_date')} /></label>
        <label>종료일 <input type="date" value={f.to_date} onChange={set('to_date')} /></label>
        <label>구분
          <select value={f.kind} onChange={set('kind')}>
            <option value="">전체</option>
            {Object.entries(HISTORY_KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>검색 <input type="search" value={f.q} onChange={set('q')} placeholder="거래처·품목·메모" /></label>
        <button type="submit" className="main-btn" disabled={loading}>조회</button>
      </form>
      {err && <div className="main-alert-banner" role="alert">{err}</div>}
      {!loading && data.data.length === 0 ? (
        <p className="mg-empty">이관 기록이 없습니다.</p>
      ) : (
        <div className="main-table-wrap">
          <table className="main-table mg-table">
            <thead><tr><th>날짜</th><th>구분</th><th>거래처</th><th>품목</th><th className="num">수량</th><th className="num">금액</th><th>원 전표</th><th>메모</th><th>묶음</th></tr></thead>
            <tbody>
              {data.data.map((r) => (
                <tr key={r.id}>
                  <td data-label="날짜">{r.txn_date}</td>
                  <td data-label="구분"><span className="mg-hist-kind">{r.kind_label}</span></td>
                  <td data-label="거래처">{r.partner_name}{r.partner_id == null && r.partner_name ? <span className="mg-muted"> (미등록)</span> : null}</td>
                  <td data-label="품목">{r.product_name || ''}</td>
                  <td data-label="수량" className="num">{r.quantity == null ? '' : qty(r.quantity)}</td>
                  <td data-label="금액" className="num">{won(r.amount)}</td>
                  <td data-label="원 전표">{r.external_ref || ''}</td>
                  <td data-label="메모">{r.memo || ''}</td>
                  <td data-label="묶음">#{r.batch_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.total > 50 && (
        <div className="mg-pager">
          <button type="button" className="main-btn main-btn--secondary" disabled={offset === 0 || loading} onClick={() => load(Math.max(0, offset - 50))}>이전</button>
          <span>{won(offset + 1)}–{won(Math.min(offset + 50, data.total))} / {won(data.total)}</span>
          <button type="button" className="main-btn main-btn--secondary" disabled={offset + 50 >= data.total || loading} onClick={() => load(offset + 50)}>다음</button>
        </div>
      )}
    </section>
  );
}
