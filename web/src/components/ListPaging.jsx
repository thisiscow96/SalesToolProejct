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

/** 총 건수와 이전·다음 — total 이 0 이면 그리지 않고, 1쪽뿐이면 건수만 보인다 */
export function Pager({ total, offset, limit = PAGE_SIZE, count, loading, onPage }) {
  if (!total) return null;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + (count ?? 0);
  return (
    <nav className="list-pager" aria-label="목록 페이지">
      <span className="list-pager-info" role="status">
        총 <strong>{total.toLocaleString('ko-KR')}</strong>건 · {from.toLocaleString('ko-KR')}–{to.toLocaleString('ko-KR')}
        <span className="list-pager-page"> ({page}/{pages}쪽)</span>
      </span>
      {pages > 1 && (
      <span className="list-pager-btns">
        <button type="button" className="main-btn main-btn--secondary" disabled={loading || page <= 1} onClick={() => onPage(Math.max(0, offset - limit))} aria-label="이전 페이지">
          ‹ 이전
        </button>
        <button type="button" className="main-btn main-btn--secondary" disabled={loading || page >= pages} onClick={() => onPage(offset + limit)} aria-label="다음 페이지">
          다음 ›
        </button>
      </span>
      )}
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
    downloadAll: (csvName, fetchAll) =>
      fetchAll(lastParams.current)
        .then((rows) => downloadListCsv(csvName, rows))
        .catch((e) => setErr(`CSV 저장 실패: ${e.message}`)),
  };
}
