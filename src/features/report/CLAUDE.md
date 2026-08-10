# F-Report — 광고주 보고용 리포트 엑셀

F-MultiAccount popover에서 진입. 기간을 고르면 계정의 매체별 성과를 수집해 엑셀 양식(`src/assets/report-template.xlsx`)에 채워 다운로드한다.

## 파일·흐름

- `report.ts` — 진입 오케스트레이션 + 진행 UI (multi-account에서 dynamic import, `openReportFlowBatch`).
- `report-datepicker.ts` — 기간 선택 UI (`rangeForPreset`, 프리셋 라벨).
- `report-build.ts` — 수집→모델→엑셀 빌드 총괄. 템플릿은 `chrome.runtime.getURL("src/assets/report-template.xlsx")`로 로드.
- `report-data.ts` — SA stats 수집·지표 합산(`ReportMetrics`). `report-gfa.ts`/`report-gfa-detail.ts` — GFA(성과형 디스플레이) 수집.
- `report-message.ts` — "문구 포함 생성" 카톡 안내 문구. brief-compose Edge Function `mode:"reportSummary"` 호출 — 캠페인별(검색광고)·디스플레이(`displayLines`, GFA byCampaign)·상위/저효율 키워드 요약만 보낸다. 프롬프트(예시·금지어·temperature)는 서버에 있어 수정 시 함수 재배포 필요. **`plKeywords`/`shKeywords`에는 접힌 "기타 키워드" 묶음 행이 섞여 있다** — 문구 재료로 쓸 땐 걸러야 실존하지 않는 키워드가 보고에 안 나간다. 기간 간 키워드 **비교**(지난 조치 효과)는 접힌 목록이 아니라 advanced-report **원본 행**으로 — 접기에 뭉개진 소액 키워드가 "이전 기간에 없던 키워드"로 오분류된다(`collectPrevKeywordMetrics`).
- `report-period.ts` — 기간 계산(`DateRange`). `report-variable.ts` — 가변 영역(상품별 등) 채우기. `report-fill.ts` — 고정 시트 채우기. `report-excel.ts` — xlsx zip 열기/쓰기 저수준.

- 진행 오버레이(`showProgress`)는 `dvads-progress-backdrop` 마커 클래스로 scroll-lock에 걸린다(스타일 없음) — 클래스명 바꾸면 배경 스크롤 잠금이 풀린다.

## 테스트·양식

- **node 단독 테스트**: `node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-report-*.ts` — chrome 없이 fill/변수/표시 로직 검증. `ts-resolve.mjs`가 확장자 없는 상대 import와 `@/` 별칭을 해석해 준다.
- 엑셀 양식(차트·표지)은 `scripts/build-report-template-*.{ts,mjs}`로 생성/병합. **양식을 다시 손대면 `report-fill.ts`·`report-variable.ts`의 행 오프셋 상수도 같이 맞춰야 한다** (해당 파일 주석 참조).

## Gotchas

- **계정별 리포트 설정**(2026-08-07): 접기 임계(`minorRatio`)·캠페인 선택(`saCampaignIds`/`gfaCampaignIds`)·직간접 표기(`showConvSplit`)는 `MultiAccountUserMeta`에 계정별 저장, 기본값은 키 제거. UI는 행 메뉴 "리포트 설정" → 독립 flyout(`report-settings.ts`, 2026-08-10 생성 flow에서 분리 — datepicker 톱니 폐기). 훅 주입은 report.ts(`settingsHooksFor`) — report-settings가 report-build를 import하지 않게. 일괄 생성은 각 계정의 저장값을 자동 적용(일괄 메뉴엔 설정 진입 없음). 생성(runSingle/runBatch)은 설정을 저장소에서 읽으므로 **읽기 전 `settingsSaveChain`을 await** — 설정 변경 직후 생성하면 서버 저장 완료 전에 읽어 직전 변경이 빠진다(codex P2, 2026-08-10). **수집 옵션은 캐시 키 지문에 반드시 포함**하고 `null`(전체)과 `[]`(디스플레이 제외)를 구분(`*` vs 빈 문자열). `showConvSplit`은 렌더 전용이라 키에 넣지 않는다(F-Brief 캐시 공유 유지).
- **캠페인 선택 필터는 SA advanced-report 전 호출 + `collectPrevKeywordMetrics`(문구 이전 기간)까지 전부** 같은 `nccCampaignId in` 필터를 걸어야 시트 간·문구 비교 정합이 맞는다. 브랜드검색 계약은 campIds 교집합(클라이언트). GFA 상세 4차원은 캠페인 차원이 없어 부분 선택 시 수집 자체를 생략(상세 시트 제외).
- **직/간접 열 숨김은 시트별 열 오프셋이 다르다** — sheet3/7은 한 시트에 섹션1(C~N)과 동적 표(E~P·D~O)가 공존해 단순 열 숨김이 다른 지표를 가린다 → 섹션1(14~18행)은 `dropRowCellsAfter`로 M/N 셀 제거 + 동적 표 열만 `hideColumns`. `hideColumns`는 기존 `hidden` 속성을 제거 후 추가(중복 속성 = XML 위반, 엑셀 복구 대화상자).
- **`collectReportData`는 5분 TTL 1건 캐시**(2026-07-22) — 캐시 키는 계정+기간, meta(담당자/작성일)는 키에서 빼고 반환 시 model만 갈아끼운다. 반환은 최상위 배열·Map을 얕은 복사한 사본 — 소비자가 정렬/추가해도 캐시본 오염 없음(행 객체는 공유라 **행 내용 제자리 수정 금지**). 실제 수집은 `collectReportDataFresh`(병렬 구조 동결 대상은 이쪽).
- **GFA 상세 4개 차원은 병렬화 금지**(2026-07-22 라이브 실사고, 계정 499563) — 4건을 동시에 걸면 서버가 어느 것도 COMPLETED로 만들지 않아 전 차원 폴링 시간 초과 → 상세 시트 통째 실종 + 계정당 22초 낭비. GFA 서버는 계정당 보고서 생성 1건씩만 처리하는 듯. 차원 루프는 반드시 직렬. 폴링은 "먼저 확인 후 대기", 상한은 기간 일수 비례(`pollMaxFor`) — 고정 15회로 되돌리면 월간에서 시트 누락 재발.
- SA stats는 `x-ad-customer-id` 없으면 200+빈 data(silent-empty) — 루트 CLAUDE.md "stats" 절 참조. `ids`는 쉼표 분리 문자열이라 chunk(80개 등)로 나눠 호출 후 합산.
- `POST /apis/dashboard/v1/adAccounts/{no}/reports/search` body `{startDate,endDate}`는 계정 전체 ground truth(일별 metrics 합산, `conversions`=전체전환 / `purchasedConversionsValueMicros`=구매완료매출, **구매완료 전환수 count 필드는 없음**).
