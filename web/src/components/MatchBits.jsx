// T-203 경락·매입서 대조 화면 공용 조각 — 배지·하위 메뉴·창(요청 중 닫기 잠금)
import { useEffect } from 'react';
import { guardClose } from './Busy';

/** 상태 배지 — tone: ok | warn | bad | info | neutral */
export function Tone({ tone = 'neutral', children, title, testid }) {
  return (
    <span className={`pm-tone pm-tone--${tone}`} title={title} data-testid={testid}>
      {children}
    </span>
  );
}

/** 탭 안 하위 보기 전환(경락 조회/수집 현황, 매입서/검토 대기/대조 설정). busy 면 전환 잠금 */
export function SubNav({ items, value, onChange, busy, label, testidPrefix }) {
  return (
    <div className="pm-subnav" role="tablist" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="tab"
          aria-selected={value === it.id}
          className={'pm-subnav-btn' + (value === it.id ? ' on' : '')}
          onClick={() => !busy && onChange(it.id)}
          disabled={busy && value !== it.id}
          data-testid={testidPrefix ? `${testidPrefix}-${it.id}` : undefined}
        >
          {it.label}
          {it.count != null && <span className="pm-subnav-count">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * 창 — 요청 중(busy)에는 Esc·바깥 클릭·닫기 버튼이 듣지 않는다(T-404 guardClose).
 * footer 는 버튼들(닫기 버튼도 부르는 쪽이 busy 로 잠근다).
 */
export function MatchModal({ title, sub, busy, onClose, children, footer, wide = true, testid, labelId }) {
  const close = guardClose(busy, onClose);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [close]);
  const id = labelId || 'pm-modal-title';
  return (
    <div className="main-modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={'main-modal pm-modal' + (wide ? ' main-modal--wide' : '')} role="dialog" aria-modal="true" aria-labelledby={id} aria-busy={busy || undefined} data-testid={testid}>
        <div className="main-modal-header pm-modal-header">
          <h2 id={id}>{title}</h2>
          {sub && <p className="pm-modal-sub">{sub}</p>}
        </div>
        <div className="main-modal-body">{children}</div>
        {footer && <div className="main-modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function ErrorLine({ error, testid }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message;
  return (
    <p className="pm-error" role="alert" data-testid={testid}>
      {msg}
    </p>
  );
}

/** 목업 데이터 배지(source_mode MOCK) */
export function MockBadge({ mode }) {
  if (mode !== 'MOCK') return null;
  return (
    <Tone tone="warn" title="외부 API 키가 없어 공개 명세 기반 목업 데이터를 보여 줍니다(가명). 목업 경락으로는 자동 매입 등록을 하지 않습니다." testid="auction-mock-badge">
      목업 데이터
    </Tone>
  );
}
