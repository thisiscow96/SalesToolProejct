// 변경 이력(감사 로그) 화면 — T-212 (기능 제안 P17)
// 누가 언제 무엇을 바꿨는지 한 화면: 매입·매출 수정·취소, 지급 취소, 품목 공용 요청·승인·반려, 거래처 등록·수정, 로그인.
// 서버 GET /api/history 가 기존 기록(정정·지급 취소·품목 요청)과 새 audit_log 를 합쳐 본인 것만 돌려준다.
// 필터: 기간·종류·거래처. 페이지 나누기는 T-211(usePagedList·Pager) 그대로. 768 미만은 카드형(main-table--cards).
import { useEffect, useState } from 'react';
import { fetchPartners } from '../api';
import { kstParts, kstTodayYmd } from '../lib/dates';
import { Pager, usePagedList, PAGE_SIZE } from '../components/ListPaging';
import { partnerTypeLabel } from './TabPartners';
import { won } from './PartnerLedger';
import './AuditHistory.css';

export const HISTORY_KIND_OPTIONS = [
  { value: '', label: '전체' },
  { value: 'correction', label: '매입·매출 수정' },
  { value: 'cancel', label: '매입·매출 취소' },
  { value: 'payment_cancel', label: '지급 취소' },
  { value: 'partner', label: '거래처 등록·수정' },
  { value: 'product_request', label: '품목 공용 요청' },
  { value: 'login', label: '로그인' },
];
const KIND_LABEL = Object.fromEntries(HISTORY_KIND_OPTIONS.filter((o) => o.value).map((o) => [o.value, o.label]));
const KIND_CLASS = {
  correction: 'main-status--pay-partial',
  cancel: 'main-status--pay-unpaid',
  payment_cancel: 'main-status--pay-unpaid',
  partner: 'main-status--entry-receive',
  product_request: 'main-status--entry-receive',
  login: 'ah-badge-muted',
};

const FIELD_LABEL = {
  quantity: '수량',
  unit_price: '단가',
  total_amount: '금액',
  amount: '금액',
  partner_id: '거래처',
  product_id: '품목',
  purchase_date: '매입일',
  sale_date: '판매일',
  paid_at: '지급일시',
  memo: '비고',
  source_name: '출처',
  status: '상태',
  name: '이름',
  type: '유형',
  contact: '담당자',
  phone: '전화',
  location: '위치',
  address: '주소',
  credit_limit: '외상 한도',
};
const MONEY_FIELDS = new Set(['unit_price', 'total_amount', 'amount', 'credit_limit']);
const STATUS_LABEL = {
  active: '정상',
  cancelled: '취소',
  pending: '요청(대기)',
  approved: '승인',
  rejected: '반려',
  unpaid: '미수',
  partial: '일부 수금',
  paid: '수금 완료',
  refunded: '반품',
};
const TARGET_LABEL = { purchase: '매입', sale: '매출', supplier_payment: '지급', product: '품목', account: '거래처', auth: '' };

const firstDayOfMonthKst = () => `${kstTodayYmd().slice(0, 7)}-01`;
const dateTimeText = (ts) => {
  const p = kstParts(ts);
  return p ? `${p.ymd} ${p.hm}` : '-';
};

function valueText(field, v, partnerName) {
  if (v == null || v === '') return '(없음)';
  if (field === 'status') return STATUS_LABEL[v] || String(v);
  if (field === 'type') return partnerTypeLabel(v);
  if (field === 'partner_id') return partnerName(v) || `#${v}`;
  if (field === 'product_id') return `#${v}`;
  if (field === 'paid_at') return dateTimeText(v);
  if (MONEY_FIELDS.has(field)) return `${won(v)}원`;
  if (field === 'quantity') return Number(v).toLocaleString('ko-KR', { maximumFractionDigits: 3 });
  if (/_date$/.test(field)) return String(v).slice(0, 10);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function targetText(row) {
  if (row.kind === 'login') return '로그인';
  const t = TARGET_LABEL[row.target_type] ?? row.target_type;
  const id = row.target_id ? ` #${row.target_id}` : '';
  return `${t}${id}${row.target_label ? ` · ${row.target_label}` : ''}`;
}

function actorText(row) {
  if (row.actor === 'admin') return '관리자';
  return '본인';
}

/** 바뀐 내용: "단가 1,000원 → 1,200원" 줄 목록. 등록이면 값만 */
function ChangeList({ row, partnerName }) {
  if (row.kind === 'login') return <span className="ah-muted">로그인 성공</span>;
  if (!row.changes?.length) return <span className="ah-muted">—</span>;
  // 거래처 '등록'은 전 값이 없으므로 새 값만, 수정은 (없음) → 값
  const isCreate = row.source === 'audit_log' && row.reason === '등록';
  return (
    <ul className="ah-changes">
      {row.changes.map((c) => (
        <li key={c.field}>
          <span className="ah-field">{FIELD_LABEL[c.field] || c.field}</span>{' '}
          {isCreate ? (
            <span className="ah-after">{valueText(c.field, c.after, partnerName)}</span>
          ) : (
            <>
              <span className={c.before == null ? 'ah-muted' : 'ah-before'}>{valueText(c.field, c.before, partnerName)}</span>
              <span className="ah-arrow" aria-label="에서">
                {' '}→{' '}
              </span>
              <span className="ah-after">{valueText(c.field, c.after, partnerName)}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function TabHistory() {
  const [partners, setPartners] = useState([]);
  const [fromDate, setFromDate] = useState(firstDayOfMonthKst());
  const [toDate, setToDate] = useState(kstTodayYmd());
  const [kind, setKind] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const paged = usePagedList('history');

  const params = () => {
    const p = { from_date: fromDate, to_date: toDate };
    if (kind) p.kind = kind;
    if (partnerId) p.partner_id = partnerId;
    return p;
  };
  useEffect(() => {
    fetchPartners().then(setPartners).catch(() => {});
    paged.search(params());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 1회. 이후는 검색 버튼
  }, []);
  const partnerName = (id) => partners.find((p) => String(p.id) === String(id))?.name;
  const { list, total, offset, loading, err } = paged;

  return (
    <>
      <p className="ah-intro">매입·매출 수정·취소, 지급 취소, 거래처 등록·수정, 품목 공용 요청, 로그인 기록을 최근 순으로 보여 줍니다. 내 기록만 보입니다.</p>
      <div className="main-filters">
        <label className="main-date-filter">
          기간 <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="시작일" /> ~{' '}
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="종료일" />
        </label>
        <label>
          종류{' '}
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="변경 종류">
            {HISTORY_KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          거래처{' '}
          <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)} aria-label="거래처">
            <option value="">전체</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="main-btn main-btn--secondary" onClick={() => paged.search(params())} disabled={loading}>
          검색
        </button>
      </div>
      {err ? (
        <p className="main-error" role="alert">
          {err}
        </p>
      ) : loading && list.length === 0 ? (
        <p className="main-loading">불러오는 중…</p>
      ) : list.length === 0 ? (
        <p className="main-empty">이 조건의 변경 이력이 없습니다.</p>
      ) : (
        <>
          <Pager total={total} offset={offset} limit={PAGE_SIZE} count={list.length} loading={loading} onPage={paged.goPage} />
          <div className="main-table-wrap">
            <table className="main-table main-table--cards ah-table">
              <thead>
                <tr>
                  <th className="main-col-datetime">일시</th>
                  <th>종류</th>
                  <th>대상</th>
                  <th className="main-col-partner">거래처</th>
                  <th>바뀐 내용 (전 → 후)</th>
                  <th className="main-col-memo">사유</th>
                  <th className="ah-actor">한 사람</th>
                </tr>
              </thead>
              <tbody>
                {list.map((row) => (
                  <tr key={`${row.source}-${row.source_id}`}>
                    <td data-card="sub" data-label="일시" className="main-col-datetime">
                      {dateTimeText(row.occurred_at)}
                    </td>
                    <td data-card="key" data-label="종류">
                      <span className={`main-status ${KIND_CLASS[row.kind] || ''}`}>{KIND_LABEL[row.kind] || row.kind}</span>
                    </td>
                    <td data-card="title" data-label="대상">
                      {targetText(row)}
                    </td>
                    <td data-card="key" data-label="거래처" className="main-col-partner">
                      {row.partner_name || '—'}
                    </td>
                    <td data-card="wide" data-label="바뀐 내용" className="ah-change-cell">
                      <ChangeList row={row} partnerName={partnerName} />
                    </td>
                    <td data-card="key" data-label="사유" className="main-col-memo">
                      {row.kind === 'login' ? '—' : row.reason || '—'}
                    </td>
                    <td data-card="key" data-label="한 사람" className="ah-actor">
                      {actorText(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager total={total} offset={offset} limit={PAGE_SIZE} count={list.length} loading={loading} onPage={paged.goPage} />
        </>
      )}
    </>
  );
}
