// T-203 ⑤ 대조 설정 (설계 6.6) — 허용오차(R-113~R-115) · 품목 연결(R-108~R-110) · 법인 연결(R-111·R-112)
// 관리자 영역: 품목 매핑(R-103~R-106) · 매핑 안 된 이름(R-107) · 시장 달력(R-101·R-102) · 수집 일정(R-134·R-135)
// 저장 중 입력 잠금, 400 VALIDATION 의 field 로 칸 옆 문구. 수정 권한: 주인(match.settings), 관리자 영역은 주인 중 관리자
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { fetchPartners, fetchProducts, getUser } from '../api';
import { can } from '../lib/staffAccess';
import { auctionApi } from '../lib/auctionApi';
import { purchaseDocApi } from '../lib/purchaseDocApi';
import { useBusyIds } from '../components/Busy';
import { ErrorLine, Tone } from '../components/MatchBits';
import { productOptionLabel } from './ProductRequest';
import { GRADE_LABEL, fieldErrors, kstAddDays, kstTime, kstToday, md, won } from '../lib/matchLabels';

const PURCHASE_ACCOUNT_TYPES = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer']);
const TOL_FIELDS = [
  'price_pct_auto', 'price_pct_review', 'qty_pct_auto', 'qty_pct_review', 'amount_abs_auto',
  'date_before_auto', 'date_after_auto', 'date_before_review', 'date_after_review', 'auto_min_score', 'ambiguity_margin',
];

export default function MatchSettings() {
  const user = getUser();
  const isOwner = !user?.staff;
  const isAdmin = isOwner && !!user?.is_admin;
  const canEdit = isOwner && can('match.settings');
  const [items, setItems] = useState([]);
  useEffect(() => {
    auctionApi.items().then((r) => setItems(r.data || [])).catch(() => setItems([]));
  }, []);
  return (
    <div className="pm-settings" data-testid="pdoc-settings">
      {!canEdit && <p className="pm-notice">설정 보기만 할 수 있습니다. 바꾸려면 중매인(주인) 계정으로 로그인하세요.</p>}
      <ToleranceCard items={items} canEdit={canEdit} />
      <ProductLinkCard items={items} canEdit={canEdit} />
      <CorpLinkCard canEdit={canEdit} />
      {isAdmin && (
        <div className="pm-admin" data-testid="pdoc-settings-admin">
          <h3 className="pm-h3">관리자 — 전 회원 공용</h3>
          <MappingCard items={items} />
          <CalendarCard />
          <ScheduleCard />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ToleranceCard({ items, canEdit }) {
  const [data, setData] = useState(null);
  const [scope, setScope] = useState(''); // '' | 'F:PEPPER' | 'K:PEPPER.CHEONGYANG'
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState('');
  const sid = useId();

  const load = useCallback(async () => {
    try {
      const r = await purchaseDocApi.tolerances();
      setData(r.data || r);
    } catch (e) {
      setErr(e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const scopeOf = (s) => (s.startsWith('F:') ? { item_family: s.slice(2), item_key: null } : s.startsWith('K:') ? { item_family: null, item_key: s.slice(2) } : { item_family: null, item_key: null });
  const myRow = useMemo(() => {
    if (!data) return null;
    const sc = scopeOf(scope);
    return (data.rows || []).find((r) => (r.item_family || null) === sc.item_family && (r.item_key || null) === sc.item_key && r.user_id != null) || null;
  }, [data, scope]);
  useEffect(() => {
    if (!data) return;
    const base = myRow || data.effective || data.default_row || {};
    const f = {};
    for (const k of TOL_FIELDS) f[k] = base[k] != null ? String(Number(base[k])) : '';
    f.auto_convert = base.auto_convert !== false;
    setForm(f);
    setErr(null);
  }, [data, myRow]);

  const fe = fieldErrors(err);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const check = () => {
    const n = Object.fromEntries(TOL_FIELDS.map((k) => [k, Number(form[k])]));
    const bad = TOL_FIELDS.find((k) => form[k] === '' || !Number.isFinite(n[k]));
    if (bad) return { field: bad, message: '숫자를 넣어 주세요.' };
    if (!(n.price_pct_auto >= 0 && n.price_pct_auto <= n.price_pct_review && n.price_pct_review <= 50)) return { field: 'price_pct_review', message: '단가: 0 ≤ 자동 ≤ 후보 ≤ 50%' };
    if (!(n.qty_pct_auto >= 0 && n.qty_pct_auto <= n.qty_pct_review && n.qty_pct_review <= 100)) return { field: 'qty_pct_review', message: '수량: 0 ≤ 자동 ≤ 후보 ≤ 100%' };
    if (!(Number.isInteger(n.amount_abs_auto) && n.amount_abs_auto >= 0 && n.amount_abs_auto <= 10000)) return { field: 'amount_abs_auto', message: '금액 차: 0~10,000원(정수)' };
    for (const k of ['date_before_auto', 'date_after_auto']) if (!(Number.isInteger(n[k]) && n[k] >= 0 && n[k] <= 7)) return { field: k, message: '자동 날짜 범위: 0~7일' };
    if (!(n.date_before_review >= n.date_before_auto && n.date_before_review <= 14)) return { field: 'date_before_review', message: '후보 날짜(앞): 자동 이상 ~14일' };
    if (!(n.date_after_review >= n.date_after_auto && n.date_after_review <= 14)) return { field: 'date_after_review', message: '후보 날짜(뒤): 자동 이상 ~14일' };
    if (!(n.auto_min_score >= 50 && n.auto_min_score <= 100)) return { field: 'auto_min_score', message: '최소 점수: 50~100' };
    if (!(n.ambiguity_margin >= 0 && n.ambiguity_margin <= 50)) return { field: 'ambiguity_margin', message: '1·2위 간격: 0~50' };
    return null;
  };
  const save = async () => {
    if (busy) return;
    const bad = check();
    if (bad) return setErr(bad);
    setBusy(true);
    setErr(null);
    setMsg('');
    try {
      const body = { ...scopeOf(scope), auto_convert: !!form.auto_convert };
      for (const k of TOL_FIELDS) body[k] = Number(form[k]);
      await purchaseDocApi.saveTolerance(body);
      setMsg('저장했습니다. 다음 대조부터 이 값을 씁니다(이미 등록된 매입은 바뀌지 않음).');
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (busy || !myRow) return;
    setBusy(true);
    setErr(null);
    setMsg('');
    try {
      await purchaseDocApi.removeTolerance(myRow.id);
      setMsg('내 값을 지우고 기본값으로 돌렸습니다.');
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const num = (k, unit, w = 'pm-in-n') => (
    <span className="pm-tol-cell">
      <input aria-label={k} className={w} inputMode="decimal" value={form?.[k] ?? ''} onChange={set(k)} aria-invalid={!!fe[k]} data-testid={`pdoc-tol-${k}`} />
      {unit}
    </span>
  );

  return (
    <div className="pm-card" data-testid="pdoc-tol-card">
      <div className="pm-card-head">
        <h3 className="pm-h3">허용오차</h3>
        <label htmlFor={sid}>
          적용 범위
          <select id={sid} value={scope} disabled={busy} onChange={(e) => setScope(e.target.value)} data-testid="pdoc-tol-scope">
            <option value="">전체</option>
            <option value="F:PEPPER">고추</option>
            <option value="F:PAPRIKA">파프리카</option>
            {items.filter((i) => !String(i.item_key).endsWith('._')).map((i) => <option key={i.item_key} value={`K:${i.item_key}`}>{i.family_name} · {i.variety_name}</option>)}
          </select>
        </label>
        {myRow ? <Tone tone="info">내 값</Tone> : <Tone tone="neutral">기본값 적용 중</Tone>}
      </div>
      {!form ? (
        <p className="main-loading">불러오는 중…</p>
      ) : (
        <fieldset className="pm-tol" disabled={busy || !canEdit}>
          <div>단가 자동 {num('price_pct_auto', '%')} 후보 {num('price_pct_review', '%')}</div>
          <div>수량 자동 {num('qty_pct_auto', '%')} 후보 {num('qty_pct_review', '%')}</div>
          <div>금액 차 자동 {num('amount_abs_auto', '원')}</div>
          <div>날짜 자동: 경락일 = 거래일 −{num('date_before_auto', '')}~+{num('date_after_auto', '')}일 · 후보 −{num('date_before_review', '')}~+{num('date_after_review', '')}일</div>
          <div>
            <label className="main-filter-checkbox">
              <input type="checkbox" checked={!!form.auto_convert} onChange={set('auto_convert')} data-testid="pdoc-tol-auto_convert" /> 완전일치는 자동 매입 등록
            </label>
            {' '}최소 점수 {num('auto_min_score', '')} 1·2위 간격 {num('ambiguity_margin', '')}
          </div>
        </fieldset>
      )}
      {Object.entries(fe).map(([k, m]) => <p key={k} className="pm-field-err" data-testid={`pdoc-tol-err-${k}`}>{m}</p>)}
      {err && !Object.keys(fe).length && <ErrorLine error={err} />}
      {msg && <p className="pm-ok" role="status">{msg}</p>}
      {canEdit && (
        <div className="pm-actions">
          <button type="button" className="main-btn main-btn--secondary" onClick={reset} disabled={busy || !myRow} data-testid="pdoc-tol-reset">기본값으로</button>
          <button type="button" className="main-btn" onClick={save} disabled={busy || !form} aria-busy={busy} data-testid="pdoc-tol-save">{busy ? '저장 중…' : '저장'}</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function ProductLinkCard({ items, canEdit }) {
  const [links, setLinks] = useState([]);
  const [sugg, setSugg] = useState([]);
  const [products, setProducts] = useState([]);
  const [draft, setDraft] = useState({}); // `${item_key}|${grade}` → product_id
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState('');
  const rowBusy = useBusyIds();

  const load = useCallback(async () => {
    try {
      const r = await auctionApi.productLinks();
      setLinks(r.data || []);
      setSugg(r.suggestions || r.data?.suggestions || []);
      setDraft({});
    } catch (e) {
      setErr(e);
    }
  }, []);
  useEffect(() => {
    load();
    fetchProducts().then((p) => setProducts(p || [])).catch(() => setProducts([]));
  }, [load]);

  const varieties = items.filter((i) => !String(i.item_key).endsWith('._'));
  const rows = useMemo(() => {
    const out = varieties.map((v) => ({ item_key: v.item_key, grade_norm: null, label: `${v.family_name} · ${v.variety_name}` }));
    for (const l of links) if (l.grade_norm) out.push({ item_key: l.item_key, grade_norm: l.grade_norm, label: `${l.item_key} · ${GRADE_LABEL[l.grade_norm] || l.grade_norm}` });
    return out;
  }, [varieties, links]);
  const linkOf = (k, g) => links.find((l) => l.item_key === k && (l.grade_norm || null) === (g || null));
  const keyOf = (k, g) => `${k}|${g || ''}`;
  const changed = Object.keys(draft).length;

  const save = async () => {
    if (busy || !changed) return;
    setBusy(true);
    setErr(null);
    setMsg('');
    try {
      const out = Object.entries(draft)
        .filter(([, pid]) => pid)
        .map(([k, pid]) => {
          const [item_key, g] = k.split('|');
          return { item_key, grade_norm: g || null, product_id: Number(pid) };
        });
      const r = await auctionApi.saveProductLinks(out);
      setMsg(`${r.data?.saved ?? out.length}건 저장했습니다.`);
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (l) => {
    if (!rowBusy.start(l.id)) return;
    try {
      await auctionApi.removeProductLink(l.id);
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      rowBusy.end(l.id);
    }
  };

  return (
    <div className="pm-card" data-testid="pdoc-plink-card">
      <h3 className="pm-h3">품목 연결 <span className="pm-muted">(내부 품종 → 내 품목 · 매입 등록에 쓰임)</span></h3>
      <table className="main-table pm-table pm-table--compact">
        <thead><tr><th>내부 품종</th><th>등급</th><th>내 품목</th><th>추천</th><th /></tr></thead>
        <tbody>
          {rows.map((r) => {
            const l = linkOf(r.item_key, r.grade_norm);
            const k = keyOf(r.item_key, r.grade_norm);
            const s = sugg.find((x) => x.item_key === r.item_key);
            const val = draft[k] ?? (l ? String(l.product_id) : '');
            return (
              <tr key={k} data-testid={`pdoc-plink-${r.item_key}`}>
                <td>{r.label}</td>
                <td>{r.grade_norm ? GRADE_LABEL[r.grade_norm] : '전 등급'}</td>
                <td>
                  <select aria-label={`${r.label} 내 품목`} value={val} disabled={busy || !canEdit} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}>
                    <option value="">연결 안 함</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{productOptionLabel(p)}{p.unit ? ` (${p.unit})` : ''}</option>)}
                  </select>
                </td>
                <td>
                  {!l && s && canEdit && (
                    <button type="button" className="pm-link" disabled={busy} onClick={() => setDraft({ ...draft, [k]: String(s.product_id) })}>
                      공용 ‘{s.product_name}’
                    </button>
                  )}
                </td>
                <td>
                  {l && canEdit && (
                    <button type="button" className="pm-link pm-danger-text" disabled={busy || rowBusy.has(l.id)} onClick={() => remove(l)}>지우기</button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <ErrorLine error={err} />
      {msg && <p className="pm-ok" role="status">{msg}</p>}
      {canEdit && (
        <div className="pm-actions">
          <button type="button" className="main-btn" onClick={save} disabled={busy || !changed} aria-busy={busy} data-testid="pdoc-plink-save">{busy ? '저장 중…' : `저장${changed ? ` (${changed})` : ''}`}</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function CorpLinkCard({ canEdit }) {
  const [links, setLinks] = useState([]);
  const [partners, setPartners] = useState([]);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await auctionApi.corpLinks();
      setLinks(r.data || []);
      setDraft({});
    } catch (e) {
      setErr(e);
    }
  }, []);
  useEffect(() => {
    load();
    fetchPartners().then((p) => setPartners((p || []).filter((x) => PURCHASE_ACCOUNT_TYPES.has(x.type)))).catch(() => setPartners([]));
  }, [load]);
  const changed = Object.keys(draft).length;
  const save = async () => {
    if (busy || !changed) return;
    setBusy(true);
    setErr(null);
    setMsg('');
    try {
      await auctionApi.saveCorpLinks(Object.entries(draft).map(([corp_code, pid]) => ({ corp_code, partner_id: pid ? Number(pid) : null })));
      setMsg('저장했습니다.');
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pm-card" data-testid="pdoc-clink-card">
      <h3 className="pm-h3">법인 연결 <span className="pm-muted">(경락 법인 코드 → 내 거래처 · 매입 거래처·지급 대상)</span></h3>
      {links.length === 0 ? (
        <p className="pm-muted">경락에 나온 법인이 아직 없습니다.</p>
      ) : (
        <table className="main-table pm-table pm-table--compact">
          <thead><tr><th>법인 코드</th><th>법인 이름</th><th>내 거래처</th></tr></thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.corp_code} data-testid={`pdoc-clink-${l.corp_code}`}>
                <td>{l.corp_code}</td>
                <td>{l.corp_name || '-'}</td>
                <td>
                  <select aria-label={`${l.corp_name || l.corp_code} 내 거래처`} value={draft[l.corp_code] ?? (l.partner_id ? String(l.partner_id) : '')} disabled={busy || !canEdit} onChange={(e) => setDraft({ ...draft, [l.corp_code]: e.target.value })}>
                    <option value="">연결 안 함</option>
                    {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorLine error={err} />
      {msg && <p className="pm-ok" role="status">{msg}</p>}
      {canEdit && links.length > 0 && (
        <div className="pm-actions">
          <button type="button" className="main-btn" onClick={save} disabled={busy || !changed} aria-busy={busy} data-testid="pdoc-clink-save">{busy ? '저장 중…' : '저장'}</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
function MappingCard({ items }) {
  const [rows, setRows] = useState([]);
  const [unmapped, setUnmapped] = useState([]);
  const [form, setForm] = useState({ target: 'BOTH', keyword: '', code_m: '', code_s: '', item_key: '', priority: '100' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState('');
  const rowBusy = useBusyIds();
  const today = kstToday();
  const load = useCallback(async () => {
    try {
      const [m, u] = await Promise.all([auctionApi.mappings({}), auctionApi.unmapped({ date_from: kstAddDays(today, -30), date_to: today })]);
      setRows(m.data || []);
      setUnmapped(u.data || []);
    } catch (e) {
      setErr(e);
    }
  }, [today]);
  useEffect(() => {
    load();
  }, [load]);
  const fe = fieldErrors(err);
  const add = async () => {
    if (busy) return;
    const hasKw = form.keyword.trim() !== '';
    const hasCode = form.code_m.trim() !== '' || form.code_s.trim() !== '';
    if (hasKw === hasCode) return setErr({ field: 'keyword', message: '키워드 또는 코드 중 하나만 넣어 주세요.' });
    if (!form.item_key) return setErr({ field: 'item_key', message: '내부 품종을 고르세요.' });
    setBusy(true);
    setErr(null);
    setMsg('');
    try {
      const body = { target: form.target, item_key: form.item_key, priority: Number(form.priority) || 100 };
      if (hasKw) body.keyword = form.keyword.trim();
      else Object.assign(body, { code_m: form.code_m.trim() || undefined, code_s: form.code_s.trim() || undefined });
      const r = await auctionApi.createMapping(body);
      setMsg(`추가했습니다. 기존 경락 재계산 작업 #${r.data?.remap_job_id ?? r.remap_job_id ?? '-'}을 넣었습니다.`);
      setForm({ ...form, keyword: '', code_m: '', code_s: '' });
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (m) => {
    if (!rowBusy.start(m.id)) return;
    try {
      if (m.active) await auctionApi.removeMapping(m.id);
      else await auctionApi.updateMapping(m.id, { ...m, active: true });
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      rowBusy.end(m.id);
    }
  };
  return (
    <div className="pm-card" data-testid="pdoc-map-card">
      <h3 className="pm-h3">품목 매핑 <span className="pm-muted">(원천 코드·이름 → 내부 품종)</span></h3>
      {unmapped.length > 0 && (
        <p className="pm-unmapped" data-testid="pdoc-unmapped">
          매핑 안 된 이름:{' '}
          {unmapped.slice(0, 12).map((u, i) => (
            <button key={i} type="button" className="pm-link" disabled={busy} onClick={() => setForm({ ...form, keyword: u.item_name_raw || '', code_m: '', code_s: '', target: u.origin === 'DOC' ? 'DOC' : 'BOTH' })} title={`${u.origin === 'DOC' ? '매입서' : '경락'} · 마지막 ${md(u.last_seen)}`}>
              {u.item_name_raw || `${u.code_m}/${u.code_s}`}({won(u.count)})
            </button>
          ))}
        </p>
      )}
      <fieldset className="pm-inline-form" disabled={busy}>
        <select aria-label="적용 대상" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
          <option value="BOTH">경락·매입서</option>
          <option value="MARKET">경락만</option>
          <option value="DOC">매입서만</option>
        </select>
        <input aria-label="키워드" placeholder="키워드(예: 청량초)" value={form.keyword} maxLength={50} onChange={(e) => setForm({ ...form, keyword: e.target.value })} data-testid="pdoc-map-keyword" />
        <span className="pm-muted">또는</span>
        <input aria-label="중분류 코드" className="pm-in-s" placeholder="중분류" value={form.code_m} maxLength={10} onChange={(e) => setForm({ ...form, code_m: e.target.value })} />
        <input aria-label="소분류 코드" className="pm-in-s" placeholder="소분류" value={form.code_s} maxLength={10} onChange={(e) => setForm({ ...form, code_s: e.target.value })} />
        <span aria-hidden="true">→</span>
        <select aria-label="내부 품종" value={form.item_key} onChange={(e) => setForm({ ...form, item_key: e.target.value })} data-testid="pdoc-map-item">
          <option value="">내부 품종 선택</option>
          {items.map((i) => <option key={i.item_key} value={i.item_key}>{i.family_name} · {i.variety_name}</option>)}
        </select>
        <input aria-label="우선순위" className="pm-in-s" inputMode="numeric" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} title="작을수록 먼저" />
        <button type="button" className="main-btn" onClick={add} aria-busy={busy} data-testid="pdoc-map-add">{busy ? '추가 중…' : '추가'}</button>
      </fieldset>
      {Object.values(fe).map((m, i) => <p key={i} className="pm-field-err">{m}</p>)}
      {err && !Object.keys(fe).length && <ErrorLine error={err} />}
      {msg && <p className="pm-ok" role="status">{msg}</p>}
      <div className="main-table-wrap pm-table-wrap pm-table-wrap--short">
        <table className="main-table pm-table pm-table--compact">
          <thead><tr><th>대상</th><th>원천</th><th>코드·키워드</th><th>내부 품종</th><th className="pm-num">우선</th><th>상태</th><th /></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'pm-row-off'}>
                <td>{m.target}</td>
                <td>{m.source || '전체'}</td>
                <td>{m.keyword_norm || [m.code_l, m.code_m, m.code_s].filter(Boolean).join('/')}</td>
                <td>{m.item_key}</td>
                <td className="pm-num">{m.priority}</td>
                <td>{m.active ? <Tone tone="ok">사용</Tone> : <Tone tone="neutral">끔</Tone>}</td>
                <td><button type="button" className="pm-link" disabled={rowBusy.has(m.id)} onClick={() => toggle(m)}>{m.active ? '끄기' : '켜기'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CalendarCard() {
  const today = kstToday();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [rows, setRows] = useState([]);
  const [add, setAdd] = useState({ cal_date: '', note: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    try {
      const from = `${month}-01`;
      const r = await auctionApi.calendar({ date_from: from, date_to: kstAddDays(kstAddDays(from, 32).slice(0, 7) + '-01', -1) });
      setRows(r.data || []);
    } catch (e) {
      setErr(e);
    }
  }, [month]);
  useEffect(() => {
    load();
  }, [load]);
  const save = async (body) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await auctionApi.saveCalendar({ market_code: rows[0]?.market_code || '110001', add: [], remove: [], ...body });
      setAdd({ cal_date: '', note: '' });
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pm-card" data-testid="pdoc-cal-card">
      <h3 className="pm-h3">시장 달력(휴장일)</h3>
      <fieldset className="pm-inline-form" disabled={busy}>
        <input type="month" aria-label="달" value={month} onChange={(e) => setMonth(e.target.value)} />
        <input type="date" aria-label="휴장일" value={add.cal_date} onChange={(e) => setAdd({ ...add, cal_date: e.target.value })} />
        <input aria-label="메모" placeholder="메모(예: 휴장 공지)" value={add.note} maxLength={100} onChange={(e) => setAdd({ ...add, note: e.target.value })} />
        <button type="button" className="main-btn" disabled={!add.cal_date} onClick={() => save({ add: [{ cal_date: add.cal_date, kind: 'HOLIDAY', note: add.note.trim() || undefined }] })} data-testid="pdoc-cal-add">휴장일 추가</button>
      </fieldset>
      <ErrorLine error={err} />
      <ul className="pm-daychips">
        {rows.length === 0 && <li className="pm-muted">이 달에 등록된 휴장일이 없습니다.</li>}
        {rows.map((r) => (
          <li key={r.cal_date}>
            <Tone tone="neutral" title={r.note || ''}>{md(r.cal_date)} {r.kind === 'HOLIDAY' ? '휴장' : r.kind}</Tone>
            <button type="button" className="pm-link pm-danger-text" disabled={busy} onClick={() => save({ remove: [r.cal_date] })} aria-label={`${r.cal_date} 휴장 지우기`}>×</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScheduleCard() {
  const [rows, setRows] = useState([]);
  const [draft, setDraft] = useState({});
  const [err, setErr] = useState(null);
  const rowBusy = useBusyIds();
  const load = useCallback(async () => {
    try {
      const r = await auctionApi.schedules();
      setRows(r.data || []);
      setDraft({});
    } catch (e) {
      setErr(e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const keyOf = (s) => `${s.job_type}|${s.source}`;
  const save = async (s) => {
    const k = keyOf(s);
    if (!rowBusy.start(k)) return;
    setErr(null);
    try {
      const d = { ...s, ...(draft[k] || {}) };
      if (String(d.cron_text).trim().split(/\s+/).length !== 5) throw Object.assign(new Error('cron 은 5칸(분 시 일 월 요일)으로 적어 주세요.'), { code: 'BAD_CRON' });
      await auctionApi.saveSchedule({ job_type: d.job_type, source: d.source, cron_text: String(d.cron_text).trim(), active: !!d.active });
      await load();
    } catch (e) {
      setErr(e);
    } finally {
      rowBusy.end(k);
    }
  };
  return (
    <div className="pm-card" data-testid="pdoc-sched-card">
      <h3 className="pm-h3">수집 일정 <span className="pm-muted">(KST cron)</span></h3>
      <ErrorLine error={err} />
      <table className="main-table pm-table pm-table--compact">
        <thead><tr><th>작업</th><th>소스</th><th>cron</th><th>사용</th><th>다음 실행</th><th /></tr></thead>
        <tbody>
          {rows.map((s) => {
            const k = keyOf(s);
            const d = { ...s, ...(draft[k] || {}) };
            return (
              <tr key={k}>
                <td>{s.job_type}</td>
                <td>{s.source}</td>
                <td><input aria-label={`${s.job_type} cron`} value={d.cron_text} disabled={rowBusy.has(k)} onChange={(e) => setDraft({ ...draft, [k]: { ...(draft[k] || {}), cron_text: e.target.value } })} /></td>
                <td><input type="checkbox" aria-label={`${s.job_type} 사용`} checked={!!d.active} disabled={rowBusy.has(k)} onChange={(e) => setDraft({ ...draft, [k]: { ...(draft[k] || {}), active: e.target.checked } })} /></td>
                <td>{kstTime(s.next_run_at)}</td>
                <td><button type="button" className="main-btn main-btn--secondary" disabled={!draft[k] || rowBusy.has(k)} onClick={() => save(s)}>{rowBusy.has(k) ? '저장 중…' : '저장'}</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

