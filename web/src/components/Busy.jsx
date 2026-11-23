// T-404 화면 조작 공통 도구 — 요청 중 잠금·늦은 응답 무시
// 원칙: 요청이 진행 중이면 화면을 바꾸는 링크·창 닫기·모드 전환을 잠근다(로그인 전환 잠금 87b333b 와 같은 방식).
import { useCallback, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

/**
 * 요청 중에는 눌리지 않는 링크. busy 이면 이동을 막고 aria-disabled 로 표시한다(키보드 Tab 에서도 빠짐).
 */
export function BusyLink({ busy, to, className, children, ...rest }) {
  if (busy) {
    return (
      <span className={(className || '') + ' is-disabled'} aria-disabled="true" role="link" {...rest}>
        {children}
      </span>
    );
  }
  return (
    <Link to={to} className={className} {...rest}>
      {children}
    </Link>
  );
}

/**
 * 늦게 도착한 응답을 버리기 위한 요청 순번.
 *   const latest = useLatestRequest();
 *   const t = latest.next();  ...await...;  if (!latest.isCurrent(t)) return;
 * 조건이 바뀌거나 창을 닫을 때 latest.invalidate() 를 부르면 그 전 요청 결과는 모두 버린다.
 */
export function useLatestRequest() {
  const seq = useRef(0);
  const next = useCallback(() => {
    seq.current += 1;
    return seq.current;
  }, []);
  const isCurrent = useCallback((t) => t === seq.current, []);
  const invalidate = useCallback(() => {
    seq.current += 1;
  }, []);
  return { next, isCurrent, invalidate };
}

/**
 * 행마다 따로 잠그는 처리 중 표시. 한 줄만 기억하면(busyId) 다른 줄을 누를 때 앞 줄 잠금이 풀려 같은 요청이 두 번 나간다.
 *   const rows = useBusyIds();  if (!rows.start(id)) return;  ...finally rows.end(id);   disabled={rows.has(id)}
 */
export function useBusyIds() {
  const [ids, setIds] = useState(() => new Set());
  const live = useRef(new Set());
  const start = useCallback((id) => {
    if (live.current.has(id)) return false;
    live.current.add(id);
    setIds(new Set(live.current));
    return true;
  }, []);
  const end = useCallback((id) => {
    live.current.delete(id);
    setIds(new Set(live.current));
  }, []);
  return { has: (id) => ids.has(id), start, end, any: ids.size > 0 };
}

/** Esc·바깥 클릭 닫기 핸들러를 요청 중에는 무시하도록 감싼다 */
export function guardClose(busy, onClose) {
  return (...args) => {
    if (busy) return;
    onClose?.(...args);
  };
}
