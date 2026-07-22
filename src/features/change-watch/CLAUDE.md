# F-ChangeWatch — 변경이력 모니터링 알림 + 관리이력 보고

`history-report.ts`(관리이력 보고, 2026-07-21): 기간 내 변경이력에서 **우리(대행사) 변경자의 작업만** 골라 카톡 붙여넣기용 한글 텍스트로 요약(캠페인 유형별 섹션 → 종류별 그룹 → 같은 대상 묶음 + 시각). UI는 multi-account.ts `openHistoryReportDialogFor`(⋮ > "관리이력 보고"), 변경자·종류 필터 선택은 계정별 `MultiAccountUserMeta.historyReportActors/Groups`에 저장(닫을 때도 저장). 정찰 확정 사실(2026-07-21 라이브, 상세는 메모리 `project_f_history_report`):
- 동사 `ADD/REMOVE/COPY`는 diff 무의미(신규는 전 필드가 "없음 -> 값") — 동작으로만 표기. **키워드는 `KEYWORD.*`, `CRITERION.*`은 키워드가 아니라 요일/시간(SD)·지역(RL)·연령(AG) 타겟팅**(criterionJson, codeName 한글). 연령은 켜는 순간 전 구간 11개가 통째로 기록됨(2026-07-22 라이브) — `CRITERION_FULL_SET_KIND`로 "사용/해제" 한 줄로 접고, 기존 구간의 negative/bidWeight 변화는 바뀐 구간만 표기.
- **키워드/소재 수정엔 대상 이름이 없다**(nkw-/nad- id만, displayName이 그룹명 반복인 경우도) — `ncc/keywords?ids=`(keyword)·`ncc/ads?ids=`(referenceData.productTitle)로 조인. 캠페인 유형은 `ncc/campaigns`(campaignTp) 조인.
- **무변경 이벤트가 대량으로 온다**(2026-07-22 라이브: API 입찰 도구가 같은 입찰가를 다시 쓴 `AD.MODIFY`의 adAttr before==after가 주간 126건) — diff가 0개인 이벤트는 관리 내역이 아니므로 보고 건수에서도 제외(`buildHistoryReport`의 `if (!detail) continue`).
- 제외키워드 2경로: `TARGET.MODIFY`+`RESTRICT_KEYWORD_TARGET`(target JSON에 **매번 전체 목록** → 차집합으로 추가/삭제분만), `ADGROUP.{ADD,REMOVE}_KEYWORD_PLUS`(건별). `inspectStatus`는 검수 부수 변화라 무시, `ad` 필드는 "소재 내용 변경"으로 접기.
- `restrictKeywordDiff`/`criterionDetail`의 non-empty 폴백("제외키워드 변경"/"타겟팅 변경")은 무변경 이벤트를 못 거르지만 **라이브 검증 결과 발생 0건**(2026-07-22, 20계정×14일 4,611행 중 해당 후보 74건 전수 재현) — 미지 형식의 진짜 변경을 지키는 안전망이므로 빈 문자열로 바꾸지 말 것. `targetTp: NON_SEARCH_KEYWORD_TARGET`(14일 7건)은 전용 처리 없이 "타겟 설정 변경" 일반 문구로 나감.

`POST /apis/sa/api/histories/_search?serviceId=james-rhodes&since={ms}&until={ms}&maxRowsPerPage=5000` + body `{bool:{must:[]}}`(ES DSL) + **`x-ad-customer-id` 헤더 필수**(없으면 `ownerId format is invalid`). 5,000행은 호출당 한도일 뿐 — 전수가 필요하면 `fetchChangeHistoryAll`(한도에 걸리면 기간 반분 재귀 + eventId 중복 제거, 관리이력 보고가 사용)로 우회. UI(다이얼로그·행 알림)는 `@/features/multi-account/multi-account.ts`에 있고, 이 폴더는 수집·판정 로직(`change-watch.ts`).

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
