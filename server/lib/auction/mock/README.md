# D_mock — 외부 경락 API 목업 응답 (T-203)

- 다시 만들기: 이 폴더에서 `node _generate.js` (값을 바꾸려면 스크립트를 고친다 — 파일 직접 수정 금지)
- 기준 날짜: 거래정산일자 `2026-11-23`, 도매시장 `110001`(서울가락 [가정 — 표준코드 API로 확인])
- **이름 규칙:** 공개 명세에 있는 이름(`trd_clcln_ymd`, `scsbd_dt`, `whsl_mrkt_cd`, `corp_cd`, `gds_lclsf_cd`, `gds_mclsf_cd`, `gds_sclsf_cd`, `grd_cd`, `pkg_cd`, `sz_cd`, `unit_cd`, `plor_cd`)은 그대로 썼다(data.go.kr 15141808·15141809·15141818, 확인 2026-11-24). 나머지 값 필드는 **[가정] 이름**: `auc_seq`(건 번호), `*_nm`(명칭), `scsbd_prc`(낙찰가), `qty`(수량), `unit_qty`(단위중량), `shpr_nm`(출하자), `mdlmrchnt_no`(낙찰 중도매인 번호), 정산정보의 `trd_qty`·`min_prc`·`max_prc`·`avg_prc`·`tot_amt`, 가락 XML 태그 전부.
- **키 발급 후 첫 호출일에 B①가** 실제 응답과 다른 이름을 어댑터 `FIELD_MAP`과 이 스크립트에서 같이 고친다. 내부 정규화 스키마(D_수집아키텍처.md 0.2)는 그대로 둔다.
- 법인명(A청과·B청과·C농협공판장)·출하자(출하자A~N)·중도매인 번호·품목 코드 값은 전부 가명/가정이다. 실제 거래가 아니다.

## 파일 → 시나리오 → 목업 HTTP 응답
| 파일 | 시나리오(`AUCTION_MOCK_SCENARIO`) | HTTP 상태 | 헤더 | 기대 판정(kind) · 테스트 포인트 |
|---|---|---|---|---|
| at_realtime_normal.json | normal | 200 | Content-Type: application/json | OK · 15건: 고추 청양(특 2건 같은 조합·상)·꽈리(특·상)·오이맛(특·중)·풋고추·홍고추(상자·망 5kg) / 파프리카 적(특·상)·황·주황 / 피망 1건(매핑 없음 → UNMAPPED) |
| at_realtime_paged_p1.json + at_realtime_paged_p2.json | paged | 200 | 〃 | OK · numOfRows=10, totalCount=15 → 2쪽 수집, fetched=total 검증 |
| at_realtime_paged_p2_count_changed.json | paged_changed (p1 다음) | 200 | 〃 | 끝난 뒤 fetched(15) ≠ total(16) → 처음부터 1회 재수집 → 다시 다르면 PARTIAL |
| at_realtime_empty.json | empty | 200 | 〃 | EMPTY · 시각·휴장 달력으로 NOT_YET / HOLIDAY / EMPTY 판정 |
| at_realtime_revised.json | revised (normal 다음) | 200 | 〃 | 3번째 건(청양 상, `auc_seq` …-00003) 낙찰가 31500→30500, 수량 20→19 → revision+1, 연결 전환 건 `BASE_REVISED` 재대조 |
| at_realtime_bad_fields.json | bad | 200 | 〃 | BAD_RESPONSE · 낙찰가 소수(38000.5)·수량 누락 → 저장 0건, raw 보존 |
| at_error_auth.xml | auth | 200 (또는 401 — 둘 다 테스트) | Content-Type: text/xml | AUTH_ERROR · `returnReasonCode` 30 → 재시도 안 함, 서킷 disabled |
| at_error_quota.xml | quota | 200 | text/xml | QUOTA · 코드 22 → 다음 날 00:10 KST로 미룸 |
| at_error_429.json | rate429 | 429 | Retry-After: 120 | RATE_LIMIT · run_after ≥ now+120초 |
| at_error_502.html | 5xx | 502 | text/html | SERVER_ERROR · 백오프 재시도, 5회 연속이면 서킷 OPEN |
| at_error_unknown.xml | unknown | 200 | text/xml | SERVER_ERROR · 코드 99 |
| (파일 없음) | timeout | — | — | TIMEOUT · 목업 어댑터가 `AUCTION_HTTP_TIMEOUT_MS`보다 오래 지연 후 Abort |
| at_settle_normal.json | settle | 200 | application/json | 정산정보(집계) — 법인·중/소분류별 거래물량·최저/최고/평균·총액. 실시간 normal과 합이 같게 만듦 → SETTLE_VERIFY 경고 0 |
| at_code_items.json | code | 200 | application/json | 표준코드 품목 대/중/소 9행(고추 5·파프리카 3·피망 1) → code_master·매핑 시드 |
| garak_price_normal.xml | garak | 200 | text/xml | 가락 주요품목 가격(참고 시세, 집계) — 조회 화면 참고 시세 |

## 내부 정규화로 옮길 때 기대값 예 (at_realtime_normal.json 1번째 건)
| 내부 필드 | 값 |
|---|---|
| trade_date | 2026-11-23 |
| auction_at | 2026-11-23T01:12:05+09:00 |
| market_code / corp_code | 110001 / 11000101 |
| item_l/m/s_code | 06 / 11 / 01 → 내부 품목 고추·청양고추 |
| grade_code / grade_norm | 11 / 특 |
| pkg_code / unit_qty | 100(상자) / 10 (kg) |
| qty / unit_price / amount | 12 / 38000 / 456000 |
| weight_kg / price_per_kg | 120.000 / 3800.00 |
| shipper_name_masked | 출*A (기본: 저장 안 함 또는 마스킹 — 사용자 확인) |
| buyer_code | 1001 |
| source_row_key | `auc_seq` 값 `20261123-00001` (건 번호가 없는 실제 응답이면 자연키 해시 + seq) |
