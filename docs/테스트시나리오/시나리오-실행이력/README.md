# 시나리오 실행 이력

`npm run scenario` (`server/scripts/scenario-integration-test.js`) 실행 시 **자동 생성**되는 파일입니다.

| 파일·폴더 | 설명 |
|-----------|------|
| **`최근실행.md`** | 마지막 실행의 요약 마크다운(항상 덮어씀). 빠르게 열어보기용 |
| **`runs/`** | 실행마다: `{실행ID}.md`(단계 로그), `{실행ID}.progress.json`(진행 중 스냅샷), **`{실행ID}-API통합시나리오-실행결과.md`**(§1 표 복제·이번 실행 ○×) |
| **`history.jsonl`** | 실행이 **끝날 때마다** 한 줄(JSON) 추가. 타임라인·통계 집계에 적합 |
| **`통합대장-수동필드.json`** | 실행 ID별 **에러요약·조치·원인** 수동 입력 → 다음 실행 시 [통합 대장](../API-통합-시나리오-실행-통합대장.md) 표에 반영 |

**한눈에 이력:** 상위 폴더의 **[API-통합-시나리오-실행-통합대장.md](../API-통합-시나리오-실행-통합대장.md)** — 모든 실행을 표로 링크(상세 로그 / 시나리오 결과표), 진행·통과 %, 상태.

## 실행 ID 형식

`run-2026-03-13T12-30-45-123Z` — ISO 시각 기반(파일명에 쓰기 위해 `:` 등 치환).

## `history.jsonl` 한 줄 예시

```json
{"runId":"run-2026-03-13T...","endedAt":"2026-03-13T...","exitCode":1,"base":"http://127.0.0.1:3000","agent":"admin001","tag":"1774...","totalSteps":15,"passedSteps":14,"firstFailedScenario":"S-015","fatalError":null,"status":"failed"}
```

- **`totalSteps`**: `record()`가 호출된 시나리오 ID 개수(실행 순서대로 누적)
- **`firstFailedScenario`**: 검증 실패(×)한 **첫** ID. 없으면 `null`
- **`fatalError`**: DB/네트워크 등으로 스크립트가 중단된 경우 메시지. 정상 완료·검증 실패만 있으면 `null`

## 진행 중 저장

각 시나리오 단계 직후 `runs/{실행ID}.progress.json`과 `runs/{실행ID}.md`를 갱신합니다.  
중간에 프로세스가 죄어도 **마지막으로 완료된 단계 ID**는 `progress.json`의 `lastCompletedStep`에서 확인할 수 있습니다.

## 저장 위치 바꾸기

```bash
set SCENARIO_HISTORY_DIR=C:\logs\scenario
npm run scenario
```

(절대 경로 권장. 미설정 시 이 폴더가 기본값입니다.)

## Git에 이력만 올리기

시나리오는 **자동으로 push 하지 않습니다.** 테스트 후 수동으로:

```powershell
cd "...\판매툴\server"
npm run scenario:git
```

- `docs/테스트시나리오/시나리오-실행이력/` 과 `API-통합-시나리오-실행-통합대장.md` 만 stage → commit → `git push`
- **한 번에:** `npm run scenario:push` (= scenario 실행 후 바로 위와 동일)
- push 만 안 하려면: `$env:SCENARIO_GIT_NO_PUSH='1'; npm run scenario:git`
- 프로젝트 루트에 `.git` 이 있어야 하고, `git user.name` / `user.email` · 원격 저장소 설정이 되어 있어야 합니다.
