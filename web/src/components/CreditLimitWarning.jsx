// 외상 한도 경고 (T-207) — 판매(매출 전환·재고 판매)·매출 수정 저장 때 서버가 409 CREDIT_LIMIT 를 주면 모달 안에 띄운다.
// 막지 않는다: 「한도 넘어도 저장」을 누르면 같은 내용을 credit_confirmed=true 로 다시 보낸다.
import './CreditLimitWarning.css';

const won = (n) => `${Number(n || 0).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`;

/** 서버 오류(code·detail)에서 경고 목록을 꺼낸다. 외상 한도 경고가 아니면 null */
export function creditWarningsOf(err) {
  if (!err || err.code !== 'CREDIT_LIMIT') return null;
  const list = err.detail?.credit_warnings;
  return Array.isArray(list) && list.length ? list : null;
}

/** 저장 뒤 안내 한 줄 — "C상회: 미수 10,500원 / 한도 10,000원 (500원 초과)" */
export function creditLine(w) {
  return `${w.partner_name}: 미수 ${won(w.receivable_after)} / 한도 ${won(w.credit_limit)} (${won(w.over_amount)} 초과)`;
}

export default function CreditLimitWarning({ warnings, busy, onConfirm, onCancel }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <div className="credit-warn" role="alert" aria-live="assertive">
      <p className="credit-warn-title">외상 한도를 넘습니다</p>
      <ul className="credit-warn-list">
        {warnings.map((w) => (
          <li key={w.partner_id}>
            <strong>{w.partner_name}</strong>
            <span className="credit-warn-nums">
              저장하면 미수 <b>{won(w.receivable_after)}</b> / 한도 {won(w.credit_limit)}
              <span className="credit-warn-over">{won(w.over_amount)} 초과</span>
            </span>
            <span className="credit-warn-sub">지금 미수 {won(w.receivable_before)} · 이번에 더해지는 금액 {won(w.added_amount)}</span>
          </li>
        ))}
      </ul>
      <p className="credit-warn-hint">아직 저장하지 않았습니다. 거래처와 확인했으면 그대로 저장할 수 있습니다.</p>
      <div className="credit-warn-actions">
        <button type="button" className="main-modal-btn secondary" onClick={onCancel} disabled={busy}>
          다시 고치기
        </button>
        <button type="button" className="main-modal-btn primary credit-warn-confirm" onClick={onConfirm} disabled={busy}>
          {busy ? '저장 중…' : '한도 넘어도 저장'}
        </button>
      </div>
    </div>
  );
}
