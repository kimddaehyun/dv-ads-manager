# F-ChangeWatch — 변경이력 모니터링 알림

`POST /apis/sa/api/histories/_search?serviceId=james-rhodes&since={ms}&until={ms}&maxRowsPerPage=5000` + body `{bool:{must:[]}}`(ES DSL) + **`x-ad-customer-id` 헤더 필수**(없으면 `ownerId format is invalid`). UI(다이얼로그·행 알림)는 `@/features/multi-account/multi-account.ts`에 있고, 이 폴더는 수집·판정 로직(`change-watch.ts`).

## 동작 규칙

- 두 가지를 잡는다: ① 예산 초과 중단 = `ncc.charge.{CAMPAIGN,ADGROUP}_LOCK` ② 외부 수정 = `ncc.heroes.*`인데 `actorDisplayName`이 제외 목록(`change_watch_identity`)에 없는 경우.
- **판별은 `actorId`(항상 `0`/`locker-sa`)가 아니라 `actorDisplayName`으로.** 표기가 제각각(`dvcompany:naver`/`김아라`/`GW10500`/`SYSTEM`)이라 설정 UI가 **선택한 계정의** 최근 이력에서 실제 변경자를 긁어 칩으로 고르게 한다(켜기 전에도 후보가 보여야 하므로 스캔 대상은 "켠 계정"이 아니라 "선택한 계정").
- **시스템 변경자는 하드코딩 제외**(2026-07-21, 이전엔 SYSTEM도 칩 후보였음) — `SYSTEM`과 `GW+숫자`(네이버 내부 사번형, 전 계정 공통 등장)는 사람이 아니라 네이버 내부 처리라 알림·칩 후보 모두에서 뺀다(`isAttributed`). 빈 `actorDisplayName`도 무조건 제외(예산 잠금 계열이라 ①에서 처리).
- 켜기/끄기와 제외 변경자 선택은 **한 다이얼로그**(`openChangeWatchDialogFor`, ⋮ > "변경이력 알림"). **계정별 opt-in**(`MultiAccountUserMeta.changeWatch`) — 계정 선택 후 켜야 동작(광고주 직접 운영 계정은 외부 수정이 정상이라 소음).
- **상태는 Supabase `change_watch_state` 테이블이 원본, 로컬 `change_watch_state:<no>`는 캐시**(2026-07-20 이전). 단 수집 결과라 서버 쓰기 실패는 warn 후 로컬만 반영 — 점검이 끊기면 알림 자체가 죽는다. 내려받기(`refreshFromServer` → `mergeChangeWatchFromServer`)는 **덮어쓰기 금지, id 합집합 + 확인/점검 시각 max 병합** (아직 못 올린 로컬 알림 보호). 조회 창은 고정 기간이 아니라 `scanned_until`(직전 점검 시각) 이후 증분 — 누락도 중복도 없음.
- **확인 시각은 예산/수정 종류별로 분리**(`read_budget_up_to`/`read_external_up_to`) — 하나로 두면 예산만 확인했는데 더 오래된 수정 알림까지 같이 사라진다. **[모두 읽음]은 읽음 기준만 올리고 events는 지우지 않는다** — 계정별 이력으로 `CHANGE_WATCH_KEEP_MS`(60일)까지 보관하고 그 뒤 자동 정리(2026-07-20 개편, 그 전엔 확인 즉시 삭제). 배지 개수만 읽음 기준으로 줄고 패널 목록은 그대로 남는다.
- 알람/알림 권한 없이 콘텐츠 스크립트가 30분 주기 + popover 진입 시 점검 — 탭 닫으면 멈추지만 `scanned_until` 덕에 다시 열 때 이어받음. 정찰 결과는 메모리 `project_f_changewatch_endpoints`.

## Gotchas

- **`histories/_search` 응답의 `before`/`after` 값은 전부 문자열이고 필드마다 의미가 제각각** — `userLock:"true"`는 **꺼짐**(잠금), `enable:"true"`는 **켜짐**으로 뜻이 반대. `"1"/1/true`만 보고 판정하면 `"true"`가 false로 떨어져 "꺼짐 -> 꺼짐" 같은 무의미한 요약이 나온다. 또 `adAttr`/`criterionJson`/`target`/`referenceData`는 값이 JSON 문자열, `budgetType`은 `DAILY_BUDGET` 같은 영문 enum이라 **화이트리스트(`FIELD_LABEL`)에 있는 필드만 값까지 노출**하고 나머지는 "설정 N개 변경"으로 접는다(영문·JSON 누출 방지).
