import { useEffect, useRef, useState } from 'react';
import { downloadExcelTemplate, uploadExcel } from '../api';
import { can } from '../lib/staffAccess';
import './ExcelUpload.css';

/**
 * T-402 엑셀 업로드 — 화면마다 [템플릿 내려받기] [엑셀 올리기]
 * 흐름: 파일 선택 → 서버 검증(미리보기: 줄별 OK/오류·이유·합계) → 오류 0일 때만 [저장] → 전부 아니면 전무
 * 권한: 서버 권한 표(lib/access.js)의 ui 이름 excel.<종류> 로 버튼을 숨긴다(막는 것은 서버).
 */
export const EXCEL_KIND_LABEL = {
  partner: '거래처',
  product: '품목(개인 품목)',
  purchase: '매입',
  sale: '판매(재고 기준)',
  convert: '매입→판매 전환',
  payment: '수금',
  supplier_payment: '매입처 지급',
  offset: '상계',
};
const PAGE = 200;
const won = (n) => Number(n || 0).toLocaleString('ko-KR');

export default function ExcelUploadBar({ kinds, onDone }) {
  const allowed = kinds.filter((k) => can(`excel.${k}`));
  const [kind, setKind] = useState(allowed[0] || '');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null); // { file, result, saved }
  const fileRef = useRef(null);
  if (!allowed.length) return null;
  const label = EXCEL_KIND_LABEL[kind] || kind;

  const onTemplate = async () => {
    setErr('');
    setBusy('template');
    try {
      await downloadExcelTemplate(kind);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const preview = async (file) => {
    setErr('');
    setBusy('preview');
    try {
      const result = await uploadExcel(kind, 'preview', file);
      setOpen({ file, result, saved: false, kind });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const onPick = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!/\.xlsx$/i.test(f.name)) {
      setErr('엑셀(.xlsx) 파일을 골라 주세요. CSV·.xls 는 엑셀에서 .xlsx 로 다시 저장해 올려 주세요.');
      return;
    }
    if (f.size > 2 * 1024 * 1024) {
      setErr('파일은 2MB까지 올릴 수 있습니다. 나눠서 올려 주세요.');
      return;
    }
    preview(f);
  };

  return (
    <div className="xl-bar" role="group" aria-label="엑셀 업로드">
      {allowed.length > 1 && (
        <label className="xl-kind">
          <span className="xl-kind-label">엑셀</span>
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="엑셀 업로드 대상">
            {allowed.map((k) => (
              <option key={k} value={k}>{EXCEL_KIND_LABEL[k] || k}</option>
            ))}
          </select>
        </label>
      )}
      <button type="button" className="main-btn main-btn--secondary" onClick={onTemplate} disabled={!!busy} title={`${label} 템플릿(.xlsx) — 시트1 입력 · 시트2 작성 안내`}>
        {busy === 'template' ? '내려받는 중…' : allowed.length > 1 ? '템플릿 내려받기' : `${label} 템플릿`}
      </button>
      <button type="button" className="main-btn main-btn--secondary" onClick={() => fileRef.current && fileRef.current.click()} disabled={!!busy} title="올리면 먼저 미리보기로 줄별 결과를 보여 줍니다">
        {busy === 'preview' ? '검사 중…' : '엑셀 올리기'}
      </button>
      <input ref={fileRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onPick} hidden aria-hidden="true" tabIndex={-1} />
      {err && <p className="xl-err" role="alert">{err}</p>}
      {open && (
        <ExcelPreviewModal
          state={open}
          onClose={() => setOpen(null)}
          onRepick={() => {
            setOpen(null);
            setTimeout(() => fileRef.current && fileRef.current.click(), 0);
          }}
          onSaved={(result) => {
            setOpen((s) => ({ ...s, result, saved: true }));
            if (onDone) onDone();
          }}
          onResult={(result) => setOpen((s) => ({ ...s, result }))}
        />
      )}
    </div>
  );
}

function ExcelPreviewModal({ state, onClose, onRepick, onSaved, onResult }) {
  const { file, result, saved, kind } = state;
  const [onlyErr, setOnlyErr] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => e.key === 'Escape' && !saving && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, saving]);

  const s = result.summary || {};
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const list = onlyErr ? rows.filter((r) => !r.ok) : rows;
  const canSave = !saved && s.errors === 0 && !s.duplicate && rows.length > 0;
  const label = EXCEL_KIND_LABEL[kind] || kind;

  const save = async () => {
    setSaving(true);
    setSaveErr('');
    try {
      const r = await uploadExcel(kind, 'commit', file);
      if (r.saved) onSaved(r);
      else {
        setSaveErr(r.message || '저장하지 못했습니다.');
        if (Array.isArray(r.rows)) onResult(r);
      }
    } catch (e) {
      setSaveErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="main-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div className="main-modal main-modal--wide xl-modal" role="dialog" aria-modal="true" aria-labelledby="xl-title">
        <div className="main-modal-header">
          <h2 id="xl-title">{label} 엑셀 {saved ? '저장 완료' : '미리보기'}</h2>
          <p className="xl-file" title={file.name}>{file.name}</p>
        </div>
        <div className="main-modal-body">
          <div className="xl-summary" aria-live="polite">
            <span className="xl-chip">전체 <b>{won(s.total)}</b>줄</span>
            <span className="xl-chip xl-chip--ok">정상 <b>{won(s.ok)}</b></span>
            <span className={'xl-chip ' + (s.errors ? 'xl-chip--err' : '')}>오류 <b>{won(s.errors)}</b></span>
            {s.amount_total > 0 && <span className="xl-chip">정상 줄 합계 <b>{won(s.amount_total)}</b>원</span>}
          </div>
          {saved && <p className="xl-banner xl-banner--ok" role="status">{won(s.ok)}건을 저장했습니다. 변경 이력에 “엑셀 업로드 {label} {won(s.ok)}건”으로 남았습니다.</p>}
          {!saved && s.duplicate && (
            <p className="xl-banner xl-banner--warn" role="alert">
              이미 저장한 파일입니다({String(s.duplicate.created_at || '').slice(0, 10)}, {won(s.duplicate.row_count)}건). 같은 내용을 다시 넣으려면 파일을 고쳐서 올리세요.
            </p>
          )}
          {!saved && !s.duplicate && s.errors > 0 && (
            <p className="xl-banner xl-banner--err" role="alert">오류가 있는 줄을 엑셀에서 고친 뒤 다시 올려 주세요. 오류가 하나라도 있으면 아무것도 저장하지 않습니다.</p>
          )}
          {!saved && canSave && <p className="xl-banner" role="status">모든 줄이 정상입니다. [저장]을 누르면 {won(s.ok)}건을 한 번에 저장합니다.</p>}
          {saveErr && <p className="xl-banner xl-banner--err" role="alert">{saveErr}</p>}
          {s.errors > 0 && (
            <label className="xl-only-err">
              <input type="checkbox" checked={onlyErr} onChange={(e) => { setOnlyErr(e.target.checked); setShown(PAGE); }} /> 오류 줄만 보기
            </label>
          )}
          <ul className="xl-rows" aria-label="줄별 결과">
            {list.slice(0, shown).map((r) => (
              <li key={r.line} className={'xl-row ' + (r.ok ? 'xl-row--ok' : 'xl-row--err')}>
                <span className="xl-line">{r.line}행</span>
                <span className={'xl-badge ' + (r.ok ? 'xl-badge--ok' : 'xl-badge--err')}>{r.ok ? (saved ? '저장' : 'OK') : '오류'}</span>
                <span className="xl-text">
                  {r.summary && <span className="xl-sum">{r.summary}</span>}
                  {!r.ok && <span className="xl-msg">{r.message}</span>}
                  {r.ok && r.warning && <span className="xl-msg xl-msg--warn">{r.warning}</span>}
                </span>
              </li>
            ))}
          </ul>
          {list.length > shown && (
            <button type="button" className="main-btn main-btn--secondary xl-more" onClick={() => setShown((n) => n + PAGE)}>
              {won(list.length - shown)}줄 더 보기
            </button>
          )}
        </div>
        <div className="main-modal-footer">
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={saving}>{saved ? '닫기' : '취소'}</button>
          {!saved && (
            <button type="button" className="main-modal-btn secondary" onClick={onRepick} disabled={saving}>다른 파일</button>
          )}
          {!saved && (
            <button type="button" className="main-modal-btn primary" onClick={save} disabled={!canSave || saving} title={canSave ? '' : '오류가 0줄일 때만 저장할 수 있습니다'}>
              {saving ? '저장 중…' : `저장 (${won(s.ok)}건)`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
