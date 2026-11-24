// T-203 매입서 업로드·미리보기·직접 입력 (설계 6.4, R-116~R-118) — T-402 ExcelUpload 와 같은 모양
// 흐름: 파일 선택 → R-117 미리보기(저장 안 함, 줄별 OK/오류/경고) → 오류 0일 때만 [저장하고 대조] → R-118
// 잠금(T-404): 미리보기·저장 중 창 닫기 막음(guardClose), 파일 선택 잠금. 직접 입력 창은 열 때 Idempotency-Key 하나
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { fetchPartners } from '../api';
import { can } from '../lib/staffAccess';
import { purchaseDocApi } from '../lib/purchaseDocApi';
import { newIdempotencyKey, withIdempotency } from '../lib/idempotency';
import { ErrorLine, MatchModal } from './MatchBits';
import { fieldErrors, kstToday, won } from '../lib/matchLabels';
import './ExcelUpload.css';

const PURCHASE_ACCOUNT_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer']);
const PAGE = 200;
const MAX_BYTES = 2 * 1024 * 1024;

export default function PurchaseDocUpload({ onSaved }) {
  const canUpload = can('purchase_doc.upload');
  const [autoConvert, setAutoConvert] = useState(true);
  const [busy, setBusy] = useState(''); // template | preview
  const [err, setErr] = useState('');
  const [preview, setPreview] = useState(null); // { file, data }
  const [manual, setManual] = useState(false);
  const fileRef = useRef(null);

  const onTemplate = async () => {
    if (busy) return;
    setErr('');
    setBusy('template');
    try {
      await purchaseDocApi.template();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };
  const onPick = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f || busy) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) return setErr('엑셀(.xlsx) 또는 CSV 파일만 올릴 수 있습니다.');
    if (f.size > MAX_BYTES) return setErr('파일은 2MB까지 올릴 수 있습니다. 나눠서 올려 주세요.');
    setErr('');
    setBusy('preview');
    try {
      const r = await purchaseDocApi.preview(f);
      setPreview({ file: f, data: r.data || {} });
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="xl-bar pm-upload" role="group" aria-label="매입서 올리기" data-testid="pdoc-upload-bar">
      <button type="button" className="main-btn main-btn--secondary" onClick={onTemplate} disabled={!!busy} data-testid="pdoc-template">
        {busy === 'template' ? '내려받는 중…' : '템플릿 내려받기'}
      </button>
      {canUpload && (
        <>
          <button type="button" className="main-btn main-btn--secondary" onClick={() => !busy && fileRef.current?.click()} disabled={!!busy} aria-busy={busy === 'preview'} data-testid="pdoc-file-pick">
            {busy === 'preview' ? '검사 중…' : '파일 올리기'}
          </button>
          <input ref={fileRef} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onPick} hidden aria-hidden="true" tabIndex={-1} data-testid="pdoc-file-input" />
          <button type="button" className="main-btn main-btn--secondary" onClick={() => setManual(true)} disabled={!!busy} data-testid="pdoc-manual-open">
            직접 입력
          </button>
          <label className="main-filter-checkbox" title="완전일치(허용오차 안·확정 경락)인 줄은 저장과 함께 판매툴 매입으로 등록합니다">
            <input type="checkbox" checked={autoConvert} onChange={(e) => setAutoConvert(e.target.checked)} disabled={!!busy} data-testid="pdoc-auto-convert" />
            완전일치는 바로 매입 등록
          </label>
        </>
      )}
      {err && <p className="xl-err" role="alert" data-testid="pdoc-upload-error">{err}</p>}
      {preview && (
        <PreviewModal
          state={preview}
          autoConvert={autoConvert}
          onClose={() => setPreview(null)}
          onRows={(data) => setPreview((p) => ({ ...p, data: { ...p.data, ...data } }))}
          onSaved={(result) => {
            setPreview(null);
            onSaved?.(result);
          }}
        />
      )}
      {manual && (
        <ManualEntryModal
          autoConvert={autoConvert}
          onClose={() => setManual(false)}
          onSaved={(result) => {
            setManual(false);
            onSaved?.(result);
          }}
        />
      )}
    </div>
  );
}

function PreviewModal({ state, autoConvert, onClose, onRows, onSaved }) {
  const { file, data } = state;
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState(null);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const s = data.summary || {};
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const docs = Array.isArray(data.docs) ? data.docs : [];
  const list = onlyIssues ? rows.filter((r) => !r.ok || (r.warnings && r.warnings.length)) : rows;
  const canSave = !saving && rows.length > 0 && (s.errors || 0) === 0;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveErr(null);
    try {
      const r = await purchaseDocApi.saveFile(file, autoConvert);
      onSaved(r.data || {});
    } catch (e) {
      // 400 HAS_ERRORS: 저장 시점 검사에서 오류가 생김 → 줄별 결과로 다시 그림
      const rowsBack = e.body?.data?.rows || e.body?.rows;
      if (Array.isArray(rowsBack)) onRows({ rows: rowsBack, summary: e.body?.data?.summary || e.body?.summary || s });
      setSaveErr(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <MatchModal
      title="매입서 미리보기"
      sub={file.name}
      busy={saving}
      onClose={onClose}
      testid="pdoc-preview"
      labelId="pdoc-preview-title"
      footer={
        <>
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={saving} data-testid="pdoc-preview-close">닫기</button>
          <button type="button" className="main-modal-btn primary" onClick={save} disabled={!canSave} aria-busy={saving} title={canSave ? '' : '오류가 0줄일 때만 저장할 수 있습니다'} data-testid="pdoc-preview-save">
            {saving ? '저장·대조 중…' : '저장하고 대조'}
          </button>
        </>
      }
    >
      <div className="xl-summary" aria-live="polite" data-testid="pdoc-preview-summary">
        <span className="xl-chip">{won(s.rows)}줄</span>
        <span className="xl-chip xl-chip--ok">정상 <b>{won(s.ok)}</b></span>
        <span className={'xl-chip ' + (s.errors ? 'xl-chip--err' : '')}>오류 <b>{won(s.errors)}</b></span>
        <span className="xl-chip">경고 <b>{won(s.warnings)}</b></span>
        <span className="xl-chip">합계 <b>{won(s.amount_total)}</b>원</span>
      </div>
      {docs.length > 0 && (
        <p className="pm-muted">
          매입서 {docs.length}건: {docs.slice(0, 5).map((d) => `${d.doc_no || d.group_key} (${d.doc_date} · ${d.supplier} · ${d.lines}줄)`).join(' / ')}
          {docs.length > 5 && ` 외 ${docs.length - 5}건`}
        </p>
      )}
      {s.errors > 0 ? (
        <p className="xl-banner xl-banner--err" role="alert">오류가 있는 줄을 고친 뒤 다시 올려 주세요. 오류가 하나라도 있으면 아무것도 저장하지 않습니다.</p>
      ) : (
        rows.length > 0 && (
          <p className="xl-banner" role="status">
            [저장하고 대조]를 누르면 매입서를 저장하고 경락과 대조합니다.{autoConvert ? ' 완전일치 줄은 바로 매입 등록됩니다.' : ' 매입 등록은 대조 결과에서 직접 누릅니다.'}
          </p>
        )
      )}
      <ErrorLine error={saveErr} testid="pdoc-preview-error" />
      {(s.errors > 0 || s.warnings > 0) && (
        <label className="xl-only-err">
          <input type="checkbox" checked={onlyIssues} onChange={(e) => { setOnlyIssues(e.target.checked); setShown(PAGE); }} /> 오류·경고 줄만 보기
        </label>
      )}
      <ul className="xl-rows" aria-label="줄별 결과" data-testid="pdoc-preview-rows">
        {list.slice(0, shown).map((r) => {
          const warn = (r.warnings || []).length > 0;
          return (
            <li key={r.line} className={'xl-row ' + (r.ok ? 'xl-row--ok' : 'xl-row--err')} data-testid={`pdoc-preview-row-${r.line}`}>
              <span className="xl-line">{r.line}줄</span>
              <span className={'xl-badge ' + (r.ok ? (warn ? 'xl-badge--warn' : 'xl-badge--ok') : 'xl-badge--err')}>{r.ok ? (warn ? '경고' : 'OK') : '오류'}</span>
              <span className="xl-text">
                {r.ok && r.normalized && (
                  <span className="xl-sum">
                    {r.normalized.item_key || '품목 미확인'} {r.normalized.grade_norm || ''} {r.normalized.unit_qty_kg ? `${Number(r.normalized.unit_qty_kg)}kg` : ''} · {won(r.normalized.amount)}원
                  </span>
                )}
                {(r.errors || []).map((x, i) => (
                  <span key={`e${i}`} className="xl-msg">✕ {x.field ? `[${x.field}] ` : ''}{x.message}</span>
                ))}
                {(r.warnings || []).map((x, i) => (
                  <span key={`w${i}`} className="xl-msg xl-msg--warn">⚠ {x.message || x.code}</span>
                ))}
              </span>
            </li>
          );
        })}
      </ul>
      {list.length > shown && (
        <button type="button" className="main-btn main-btn--secondary xl-more" onClick={() => setShown((n) => n + PAGE)}>
          {won(list.length - shown)}줄 더 보기
        </button>
      )}
    </MatchModal>
  );
}

const emptyLine = (date) => ({ trade_date: date, item_name: '', grade: '', spec: '', qty: '', unit_price: '', amount: '', origin: '' });

/** 직접 입력 — 헤더 + 줄 표. 창을 열 때 Idempotency-Key 하나를 만들고 저장에 성공할 때까지 같은 키로 보낸다 */
function ManualEntryModal({ autoConvert, onClose, onSaved }) {
  const today = kstToday();
  const idem = useRef(newIdempotencyKey('pdoc'));
  const ids = { no: useId(), date: useId(), sup: useId() };
  const [partners, setPartners] = useState([]);
  const [head, setHead] = useState({ doc_no: '', doc_date: today, supplier_partner_id: '' });
  const [lines, setLines] = useState([emptyLine(today)]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [lineErrs, setLineErrs] = useState({});

  useEffect(() => {
    fetchPartners().then((p) => setPartners((p || []).filter((x) => PURCHASE_ACCOUNT_TYPES.has(x.type)))).catch(() => setPartners([]));
  }, []);

  const fe = useMemo(() => fieldErrors(err), [err]);
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const intOrNull = (v) => (String(v).trim() === '' ? null : Number(String(v).replace(/,/g, '')));

  const validate = () => {
    const out = {};
    lines.forEach((l, i) => {
      const e = [];
      if (!l.trade_date) e.push('거래일');
      if (!l.item_name.trim()) e.push('품목');
      const q = intOrNull(l.qty);
      if (!(q > 0)) e.push('수량(0보다 큼)');
      const p = intOrNull(l.unit_price);
      if (!(Number.isInteger(p) && p > 0)) e.push('단가(원 단위 정수)');
      const a = intOrNull(l.amount);
      if (a !== null && !Number.isInteger(a)) e.push('금액(원 단위 정수)');
      if (e.length) out[i] = `${e.join(' · ')}을(를) 확인하세요.`;
    });
    return out;
  };

  const save = async () => {
    if (saving) return;
    const le = validate();
    setLineErrs(le);
    if (!head.doc_date || !head.supplier_partner_id) {
      setErr({ message: '거래일과 제공처는 꼭 넣어 주세요.' });
      return;
    }
    if (Object.keys(le).length) {
      setErr({ message: '줄 입력을 확인하세요.' });
      return;
    }
    setSaving(true);
    setErr(null);
    const body = {
      doc_no: head.doc_no.trim() || undefined,
      doc_date: head.doc_date,
      supplier_partner_id: Number(head.supplier_partner_id),
      auto_convert: !!autoConvert,
      lines: lines.map((l) => ({
        trade_date: l.trade_date,
        item_name: l.item_name.trim(),
        grade: l.grade.trim() || undefined,
        spec: l.spec.trim() || undefined,
        qty: intOrNull(l.qty),
        unit_price: intOrNull(l.unit_price),
        ...(intOrNull(l.amount) !== null ? { amount: intOrNull(l.amount) } : {}),
        origin: l.origin.trim() || undefined,
      })),
    };
    try {
      const r = await withIdempotency((key) => purchaseDocApi.saveManual(body, key), idem.current);
      onSaved(r.data || {});
    } catch (e) {
      // 같은 키로 다른 내용을 보냈다(422) → 내용을 바꿨으니 새 키로 다시 보낼 수 있게 한다
      if (e.code === 'IDEMPOTENCY_KEY_REUSED') idem.current = newIdempotencyKey('pdoc');
      const byLine = {};
      for (const x of e.errors || []) {
        const m = /^lines\.(\d+)\./.exec(x.field || '');
        if (m) byLine[Number(m[1])] = x.message;
      }
      if (Object.keys(byLine).length) setLineErrs(byLine);
      setErr(e);
    } finally {
      setSaving(false);
    }
  };

  // 입력을 바꾸면 키를 새로: 같은 키 + 다른 본문 = 422. 저장 실패 후 고쳐 보내는 경우를 위해
  const edit = (fn) => (...a) => {
    if (saving) return;
    if (err) idem.current = newIdempotencyKey('pdoc');
    fn(...a);
  };

  return (
    <MatchModal
      title="매입서 직접 입력"
      sub="법인 정산서·거래명세서를 보고 입력합니다. 저장하면 바로 경락과 대조합니다."
      busy={saving}
      onClose={onClose}
      testid="pdoc-manual"
      labelId="pdoc-manual-title"
      footer={
        <>
          <button type="button" className="main-modal-btn secondary" onClick={onClose} disabled={saving} data-testid="pdoc-manual-close">닫기</button>
          <button type="button" className="main-modal-btn primary" onClick={save} disabled={saving} aria-busy={saving} data-testid="pdoc-manual-save">
            {saving ? '저장·대조 중…' : '저장하고 대조'}
          </button>
        </>
      }
    >
      <fieldset className="pm-form-grid" disabled={saving}>
        <label htmlFor={ids.no}>
          매입서 번호(선택)
          <input id={ids.no} value={head.doc_no} maxLength={40} onChange={edit((e) => setHead({ ...head, doc_no: e.target.value }))} data-testid="pdoc-manual-docno" />
          {fe.doc_no && <span className="pm-field-err">{fe.doc_no}</span>}
        </label>
        <label htmlFor={ids.date}>
          거래일(경락일)
          <input id={ids.date} type="date" value={head.doc_date} max={today} onChange={edit((e) => setHead({ ...head, doc_date: e.target.value }))} data-testid="pdoc-manual-date" />
          {fe.doc_date && <span className="pm-field-err">{fe.doc_date}</span>}
        </label>
        <label htmlFor={ids.sup}>
          제공처
          <select id={ids.sup} value={head.supplier_partner_id} onChange={edit((e) => setHead({ ...head, supplier_partner_id: e.target.value }))} data-testid="pdoc-manual-supplier">
            <option value="">선택</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {fe.supplier_partner_id && <span className="pm-field-err">{fe.supplier_partner_id}</span>}
        </label>
      </fieldset>
      <div className="main-table-wrap">
        <table className="main-table pm-table pm-table--input" data-testid="pdoc-manual-lines">
          <thead>
            <tr>
              <th>거래일</th><th>품목</th><th>등급</th><th>규격</th><th className="pm-num">수량</th><th className="pm-num">단가(원)</th><th className="pm-num">금액(선택)</th><th>산지</th><th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i} className={lineErrs[i] ? 'pm-row-err' : ''}>
                <td><input type="date" aria-label={`${i + 1}줄 거래일`} value={l.trade_date} max={today} disabled={saving} onChange={edit((e) => setLine(i, { trade_date: e.target.value }))} /></td>
                <td><input aria-label={`${i + 1}줄 품목`} value={l.item_name} maxLength={100} placeholder="예: 청양고추" disabled={saving} onChange={edit((e) => setLine(i, { item_name: e.target.value }))} data-testid={`pdoc-manual-item-${i}`} /></td>
                <td><input aria-label={`${i + 1}줄 등급`} value={l.grade} maxLength={30} placeholder="특·상" disabled={saving} onChange={edit((e) => setLine(i, { grade: e.target.value }))} className="pm-in-s" /></td>
                <td><input aria-label={`${i + 1}줄 규격`} value={l.spec} maxLength={50} placeholder="10kg 상자" disabled={saving} onChange={edit((e) => setLine(i, { spec: e.target.value }))} /></td>
                <td><input aria-label={`${i + 1}줄 수량`} inputMode="decimal" value={l.qty} disabled={saving} onChange={edit((e) => setLine(i, { qty: e.target.value }))} className="pm-in-n" data-testid={`pdoc-manual-qty-${i}`} /></td>
                <td><input aria-label={`${i + 1}줄 단가`} inputMode="numeric" value={l.unit_price} disabled={saving} onChange={edit((e) => setLine(i, { unit_price: e.target.value }))} className="pm-in-n" data-testid={`pdoc-manual-price-${i}`} /></td>
                <td><input aria-label={`${i + 1}줄 금액`} inputMode="numeric" value={l.amount} disabled={saving} onChange={edit((e) => setLine(i, { amount: e.target.value }))} className="pm-in-n" /></td>
                <td><input aria-label={`${i + 1}줄 산지`} value={l.origin} maxLength={50} disabled={saving} onChange={edit((e) => setLine(i, { origin: e.target.value }))} /></td>
                <td>
                  <button type="button" className="main-modal-row-del" aria-label={`${i + 1}줄 지우기`} disabled={saving || lines.length === 1} onClick={edit(() => setLines((ls) => ls.filter((_, j) => j !== i)))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {Object.entries(lineErrs).map(([i, m]) => (
        <p key={i} className="pm-field-err">{Number(i) + 1}줄: {m}</p>
      ))}
      <button type="button" className="main-modal-toolbar-btn" disabled={saving || lines.length >= 200} onClick={edit(() => setLines((ls) => [...ls, emptyLine(head.doc_date || today)]))} data-testid="pdoc-manual-add-line">
        + 줄 추가
      </button>
      <ErrorLine error={err} testid="pdoc-manual-error" />
    </MatchModal>
  );
}
