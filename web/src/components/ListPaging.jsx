// T-211 목록 검색·페이지 나누기 — 검색창, 페이지 이동 막대, 페이지 상태 훅
// 서버 목록 API(limit·offset·q·partner_id)를 쓴다. CSV는 같은 조건으로 limit 없이 다시 불러 전체를 저장한다.
import { useRef, useState } from 'react';
import { fetchListPage } from '../api';
import { downloadListCsv } from '../lib/csvLists';
import './ListPaging.css';

export const PAGE_SIZE = 50;

/** 품목·메모 텍스트 검색칸 — Enter 로 바로 검색 */
export function SearchTextField({ id, value, onChange, onSubmit, placeholder = '품목·메모' }) {
  return (
    <label className="list-search-filter" htmlFor={id}>
      검색
      <input
        id={id}
        type="search"
        value={value}
        maxLength={100}
        placeholder={placeholder}
        aria-label={`텍스트 검색 (${placeholder})`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit?.();
          }
        }}
      />
    </label>
  );
}

/** 쪽 번호 목록 — 처음·끝·현재 앞뒤 1쪽, 사이는 … (최대 7칸) */
export function pageWindow(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const set = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => set.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => set.add(n));
  const nums = [...set].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out = [];
  nums.forEach((n, i) => {
    if (i > 0 && n - nums[i - 1] > 1) out.push('gap-' + n);
    out.push(n);
  });
  return out;
}

const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');

/**
 * 페이지 이동 막대(앱 공통) — total 이 0 이면 그리지 않는다.
 *  full(기본, 표 아래): 왼쪽 "총 N건 · a–b" · 가운데 "‹ 이전 1 2 … N 다음 ›" · 오른쪽 쪽당 건수(onLimit 있을 때)
 *  compact(표 위 오른쪽): "a–b / N건  ‹ ›" — 아래까지 내리지 않고 넘길 수 있게
 *  휴대폰(<768): 쪽 번호 대신 "3 / 23쪽", 이전·다음은 반반 44px
 */
export function Pager({ total, offset, limit = PAGE_SIZE, count, loading, onPage, onLimit, pageSizes = [50, 100, 200], variant = 'full', label = '목록 페이지', testid }) {
  if (!total) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = offset + 1;
  const to = offset + (count ?? 0);
  const go = (p) => onPage(Math.min(Math.max(0, (p - 1) * limit), (pages - 1) * limit));
  const prevDisabled = loading || page <= 1;
  const nextDisabled = loading || page >= pages;

  if (variant === 'compact') {
    return (
      <nav className="list-pager list-pager--compact" aria-label={label + '(표 위)'} data-testid={testid}>
        <span className="list-pager-info" role="status">
          <span className="list-pager-range">{fmt(from)}–{fmt(to)}</span> / <strong>{fmt(total)}</strong>건
        </span>
        {pages > 1 && (
          <span className="list-pager-btns">
            <button type="button" className="list-pager-icon" disabled={prevDisabled} onClick={() => go(page - 1)} aria-label="이전 페이지(표 위)" title="이전 페이지">‹</button>
            <span className="list-pager-of" aria-hidden="true">{page}/{pages}</span>
            <button type="button" className="list-pager-icon" disabled={nextDisabled} onClick={() => go(page + 1)} aria-label="다음 페이지(표 위)" title="다음 페이지">›</button>
          </span>
        )}
      </nav>
    );
  }

  return (
    <nav className="list-pager" aria-label={label} data-testid={testid}>
      <span className="list-pager-info" role="status">
        총 <strong>{fmt(total)}</strong>건 · {fmt(from)}–{fmt(to)}
        <span className="list-pager-page"> ({page}/{pages}쪽)</span>
      </span>
      {pages > 1 ? (
        <span className="list-pager-btns">
          <button type="button" className="list-pager-step" disabled={prevDisabled} onClick={() => go(page - 1)} aria-label="이전 페이지">
            ‹ 이전
          </button>
          <span className="list-pager-nums">
            {pageWindow(page, pages).map((n) =>
              typeof n === 'string' ? (
                <span key={n} className="list-pager-gap" aria-hidden="true">…</span>
              ) : (
                <button
                  key={n}
                  type="button"
                  className={'list-pager-num' + (n === page ? ' on' : '')}
                  aria-current={n === page ? 'page' : undefined}
                  aria-label={`${n}쪽`}
                  disabled={loading && n !== page}
                  onClick={() => n !== page && go(n)}
                >
                  {n}
                </button>
              ),
            )}
          </span>
          <span className="list-pager-mobile-of" aria-hidden="true">{page} / {pages}쪽</span>
          <button type="button" className="list-pager-step" disabled={nextDisabled} onClick={() => go(page + 1)} aria-label="다음 페이지">
            다음 ›
          </button>
        </span>
      ) : (
        <span />
      )}
      <span className="list-pager-size">
        {onLimit && (
          <label>
            <span>쪽당</span>
            <select value={limit} disabled={loading} onChange={(e) => onLimit(Number(e.target.value))} aria-label="한 쪽에 보일 건수">
              {pageSizes.map((n) => <option key={n} value={n}>{n}건</option>)}
            </select>
          </label>
        )}
      </span>
    </nav>
  );
}


/**
 * 서버 페이지 목록 상태. search(params) 로 첫 페이지, goPage(offset) 로 같은 조건의 다른 페이지.
 * 마지막 검색 조건(lastParams)은 CSV 전체 다운로드에 쓴다.
 */
export function usePagedList(resource) {
  const [list, setList] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const lastParams = useRef({});
  const seq = useRef(0);
  // T-404: CSV 전체 받기 진행 중 — 버튼 잠금·"받는 중…" 표시, 연타로 두 번 받지 않게
  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);

  const fetchAt = (params, off) => {
    const my = ++seq.current;
    setLoading(true);
    setErr('');
    return fetchListPage(resource, { ...params, limit: PAGE_SIZE, offset: off })
      .then((r) => {
        if (my !== seq.current) return;
        // 지운 뒤 마지막 페이지가 비면 한 쪽 앞으로
        if (r.data.length === 0 && off > 0 && r.total > 0) {
          const back = Math.max(0, Math.floor((r.total - 1) / PAGE_SIZE) * PAGE_SIZE);
          return fetchAt(params, back);
        }
        setList(r.data);
        setTotal(r.total);
        setOffset(off);
      })
      .catch((e) => {
        if (my === seq.current) setErr(e.message);
      })
      .finally(() => {
        if (my === seq.current) setLoading(false);
      });
  };

  return {
    list,
    total,
    offset,
    loading,
    err,
    /** 새 조건으로 첫 페이지 */
    search: (params) => {
      lastParams.current = params;
      return fetchAt(params, 0);
    },
    /** 같은 조건으로 지금 페이지 다시(등록·정정 뒤) */
    reload: () => fetchAt(lastParams.current, offset),
    goPage: (off) => fetchAt(lastParams.current, off),
    lastParams,
    /** CSV — 마지막 검색 조건 그대로, 페이지와 상관없이 전체(limit 없이 서버 조회) */
    downloading,
    downloadAll: (csvName, fetchAll) => {
      if (downloadingRef.current) return Promise.resolve();
      downloadingRef.current = true;
      setDownloading(true);
      return fetchAll(lastParams.current)
        .then((rows) => downloadListCsv(csvName, rows))
        .catch((e) => setErr(`CSV 저장 실패: ${e.message}`))
        .finally(() => {
          downloadingRef.current = false;
          setDownloading(false);
        });
    },
  };
}
