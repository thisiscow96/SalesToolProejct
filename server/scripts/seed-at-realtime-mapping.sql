-- T-203 실 API(katRealTime2) 분류 코드 매핑 시드 — 마이그레이션 아님. 030 적용 뒤에만 실행 가능(item_mapping.action 필요)
-- 근거: A_실API보정.md 2.1 "A 권고"(실데이터 가락 2026-11-24 2,009행) · I_030_seed_draft.sql. A 와 I 가 다르면 A 안(PM 지시)
-- [결정 필요] 표시 줄은 사용자 결정 전 A 권고 기본값 — 바뀌면 관리자 화면(매핑 관리) 또는 이 파일 수정 후 REMAP
--   U-07  12-08-02 홍청양 → PEPPER.RED
--   U-07b 12-05-02 청홍(법인 표기 "홍청양") → PEPPER.GENERAL
--   U-19  12-05-M8 신미락 → PEPPER.CHEONGYANG
--   U-20  12-07 건고추 · 10-25 고추잎 → IGNORE (호출 조합에서도 뺌 — AUCTION_ITEM_COMBOS 기본값)
--   U-21  13-26-05 녹색 파프리카 → 새 품목 PAPRIKA.GREEN
--   U-22a 13-02 피망(단고추) → IGNORE (호출은 함)
-- 재실행 안전: market_item ON CONFLICT DO NOTHING, item_mapping 은 같은 (source, 코드) 행이 있으면 넣지 않음
-- 되돌리기: DELETE FROM item_mapping WHERE memo LIKE 'AT 시드:%'; DELETE FROM market_item WHERE item_key = 'PAPRIKA.GREEN' AND NOT EXISTS (참조);

INSERT INTO market_item (item_key, family, family_name, variety_name, default_product_name, sort_order) VALUES
  ('PAPRIKA.GREEN', 'PAPRIKA', '파프리카', '녹색 파프리카', '녹색 파프리카', 240)   -- [결정 필요 U-21]
ON CONFLICT (item_key) DO NOTHING;

INSERT INTO item_mapping (target, source, code_l, code_m, code_s, item_key, action, priority, memo)
SELECT v.target, v.source, v.code_l, v.code_m, v.code_s, v.item_key, v.action, v.priority, v.memo
  FROM (VALUES
  ('MARKET', 'AT_REALTIME', '12', '05', '01', 'PEPPER.CHEONGYANG', 'MAP',    50, 'AT 시드: 풋고추-청양'),
  ('MARKET', 'AT_REALTIME', '12', '05', '02', 'PEPPER.GENERAL',    'MAP',    50, 'AT 시드: 풋고추-청홍(법인 표기 홍청양) [결정 필요 U-07b]'),
  ('MARKET', 'AT_REALTIME', '12', '05', '03', 'PEPPER.GENERAL',    'MAP',    50, 'AT 시드: 풋고추-녹광'),
  ('MARKET', 'AT_REALTIME', '12', '05', '05', 'PEPPER.GENERAL',    'MAP',    50, 'AT 시드: 풋고추-청초'),
  ('MARKET', 'AT_REALTIME', '12', '05', '10', 'PEPPER.OI',         'MAP',    50, 'AT 시드: 풋고추-오이고추'),
  ('MARKET', 'AT_REALTIME', '12', '05', '12', 'PEPPER.GENERAL',    'MAP',    50, 'AT 시드: 풋고추-롱그린'),
  ('MARKET', 'AT_REALTIME', '12', '05', 'M8', 'PEPPER.CHEONGYANG', 'MAP',    50, 'AT 시드: 풋고추-신미락(법인 표기 청양(신미락)) [결정 필요 U-19]'),
  ('MARKET', 'AT_REALTIME', '12', '05', NULL, 'PEPPER._',          'MAP',   100, 'AT 시드: 풋고추 새 소분류 → 품종 모름(사람 확인)'),
  ('MARKET', 'AT_REALTIME', '12', '06', NULL, 'PEPPER.KKWARI',     'MAP',   100, 'AT 시드: 꽈리고추'),
  ('MARKET', 'AT_REALTIME', '12', '08', '01', 'PEPPER.RED',        'MAP',    50, 'AT 시드: 홍고추(일반)'),
  ('MARKET', 'AT_REALTIME', '12', '08', '02', 'PEPPER.RED',        'MAP',    50, 'AT 시드: 홍청양 [결정 필요 U-07]'),
  ('MARKET', 'AT_REALTIME', '12', '08', NULL, 'PEPPER._',          'MAP',   100, 'AT 시드: 홍고추 새 소분류 → 품종 모름'),
  ('MARKET', 'AT_REALTIME', '12', '07', NULL, NULL,                'IGNORE', 100, 'AT 시드: 건고추 — 생고추 대조 대상 아님 [결정 필요 U-20]'),
  ('MARKET', 'AT_REALTIME', '10', '25', NULL, NULL,                'IGNORE', 100, 'AT 시드: 고추잎 — 고추 아님 [결정 필요 U-20]'),
  ('MARKET', 'AT_REALTIME', '13', '02', NULL, NULL,                'IGNORE', 100, 'AT 시드: 피망(단고추) — 판매툴 품목 없음 [결정 필요 U-22a]'),
  ('MARKET', 'AT_REALTIME', '13', '26', '01', 'PAPRIKA._',         'MAP',    50, 'AT 시드: 파프리카(일반) — 색 모름'),
  ('MARKET', 'AT_REALTIME', '13', '26', '02', 'PAPRIKA.YELLOW',    'MAP',    50, 'AT 시드: 노랑파프리카'),
  ('MARKET', 'AT_REALTIME', '13', '26', '03', 'PAPRIKA.RED',       'MAP',    50, 'AT 시드: 빨강파프리카'),
  ('MARKET', 'AT_REALTIME', '13', '26', '04', 'PAPRIKA.ORANGE',    'MAP',    50, 'AT 시드: 오렌지파프리카'),
  ('MARKET', 'AT_REALTIME', '13', '26', '05', 'PAPRIKA.GREEN',     'MAP',    50, 'AT 시드: 녹색파프리카 [결정 필요 U-21]'),
  ('MARKET', 'AT_REALTIME', '13', '26', NULL, 'PAPRIKA._',         'MAP',   100, 'AT 시드: 파프리카 새 소분류 → 색 모름')
  ) AS v(target, source, code_l, code_m, code_s, item_key, action, priority, memo)
 WHERE NOT EXISTS (
   SELECT 1 FROM item_mapping m
    WHERE m.source = v.source AND m.code_l IS NOT DISTINCT FROM v.code_l AND m.code_m = v.code_m AND m.code_s IS NOT DISTINCT FROM v.code_s);

-- 매입서(DOC) 쪽 키워드 보강(A 2.3-4). 기존 26행 시드는 고치지 않음
INSERT INTO item_mapping (target, keyword_norm, item_key, priority, memo)
SELECT v.target, v.kw, v.item_key, v.priority, v.memo
  FROM (VALUES
  ('DOC', '신미락',         'PEPPER.CHEONGYANG', 50, 'AT 시드: 매입서 키워드 [결정 필요 U-19]'),
  ('DOC', '녹색파프리카',   'PAPRIKA.GREEN',     50, 'AT 시드: 매입서 키워드 [결정 필요 U-21]'),
  ('DOC', '초록파프리카',   'PAPRIKA.GREEN',     50, 'AT 시드: 매입서 키워드 [결정 필요 U-21]'),
  ('DOC', '그린파프리카',   'PAPRIKA.GREEN',     50, 'AT 시드: 매입서 키워드 [결정 필요 U-21]')
  ) AS v(target, kw, item_key, priority, memo)
 WHERE NOT EXISTS (SELECT 1 FROM item_mapping m WHERE m.keyword_norm = v.kw AND m.target = v.target);
