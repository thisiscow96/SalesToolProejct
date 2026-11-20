/**
 * T-204 목록 CSV(엑셀) 다운로드 — 공용 함수 (서버 변경 없음, 화면에 불러온 목록 그대로 저장)
 *
 * - UTF-8 BOM(﻿)을 앞에 붙여 엑셀에서 한글이 깨지지 않게 한다.
 * - 숫자는 콤마 없이 그대로(엑셀이 숫자로 인식). 날짜는 YYYY-MM-DD.
 * - 줄바꿈은 CRLF(엑셀 기본), 값에 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싼다.
 * - 문자열이 = + - @ 탭 CR 로 시작하면 앞에 ' 를 붙여 수식으로 실행되지 않게 한다(CSV 수식 주입 방지).
 *   숫자 열(type: 'number')은 음수(-)를 그대로 둬야 하므로 이 처리를 하지 않는다.
 */

const BOM = '﻿';
const FORMULA_START = /^[=+\-@\t\r]/;

const pad2 = (n) => String(n).padStart(2, '0');

/** 로컬 기준 오늘 YYYY-MM-DD */
export function todayYmd(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 숫자 셀: 콤마 없는 숫자 문자열. 빈 값·숫자 아님은 빈칸. "12000.00" → "12000" */
export function csvNumber(v) {
  if (v == null || v === '') return '';
  const n = Number(String(v).replace(/,/g, ''));
  if (!Number.isFinite(n)) return '';
  return String(n);
}

/** 문자열 셀: 수식 주입 방지 + 따옴표 처리 */
function escapeText(v) {
  let s = v == null ? '' : String(v);
  if (FORMULA_START.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * columns: [{ header: '상품', value: (row) => any, type?: 'number' | 'text' }]
 * rows: 화면 목록 배열
 * 반환: BOM 포함 CSV 문자열
 */
export function toCsv(columns, rows) {
  const lines = [columns.map((c) => escapeText(c.header)).join(',')];
  for (const row of rows || []) {
    lines.push(
      columns
        .map((c) => {
          const raw = c.value(row);
          return c.type === 'number' ? csvNumber(raw) : escapeText(raw);
        })
        .join(','),
    );
  }
  return BOM + lines.join('\r\n') + '\r\n';
}

/** 파일명: 판매툴_<목록>_<날짜>.csv (파일명에 못 쓰는 문자는 _ 로) */
export function csvFileName(listName, ymd = todayYmd()) {
  const safe = String(listName).replace(/[\\/:*?"<>|\s]+/g, '_');
  return `판매툴_${safe}_${ymd}.csv`;
}

/** 브라우저에서 CSV 파일 저장 */
export function downloadCsv(fileName, columns, rows) {
  const blob = new Blob([toCsv(columns, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 일부 브라우저는 click 직후 해제하면 저장이 취소되므로 조금 뒤에 해제
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
