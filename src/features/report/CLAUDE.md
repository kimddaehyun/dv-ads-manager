# F-Report — 광고주 보고용 리포트 엑셀

F-MultiAccount popover에서 진입. 기간을 고르면 계정의 매체별 성과를 수집해 엑셀 양식(`src/assets/report-template.xlsx`)에 채워 다운로드한다.

## 파일·흐름

- `report.ts` — 진입 오케스트레이션 + 진행 UI (multi-account에서 dynamic import, `openReportFlowBatch`).
- `report-datepicker.ts` — 기간 선택 UI (`rangeForPreset`, 프리셋 라벨).
- `report-build.ts` — 수집→모델→엑셀 빌드 총괄. 템플릿은 `chrome.runtime.getURL("src/assets/report-template.xlsx")`로 로드.
- `report-data.ts` — SA stats 수집·지표 합산(`ReportMetrics`). `report-gfa.ts`/`report-gfa-detail.ts` — GFA(성과형 디스플레이) 수집.
- `report-period.ts` — 기간 계산(`DateRange`). `report-variable.ts` — 가변 영역(상품별 등) 채우기. `report-fill.ts` — 고정 시트 채우기. `report-excel.ts` — xlsx zip 열기/쓰기 저수준.

- 진행 오버레이(`showProgress`)는 `dvads-progress-backdrop` 마커 클래스로 scroll-lock에 걸린다(스타일 없음) — 클래스명 바꾸면 배경 스크롤 잠금이 풀린다.

## 테스트·양식

- **node 단독 테스트**: `node --experimental-strip-types --import ./scripts/ts-resolve.mjs scripts/test-report-*.ts` — chrome 없이 fill/변수/표시 로직 검증. `ts-resolve.mjs`가 확장자 없는 상대 import와 `@/` 별칭을 해석해 준다.
- 엑셀 양식(차트·표지)은 `scripts/build-report-template-*.{ts,mjs}`로 생성/병합. **양식을 다시 손대면 `report-fill.ts`·`report-variable.ts`의 행 오프셋 상수도 같이 맞춰야 한다** (해당 파일 주석 참조).

## Gotchas

- SA stats는 `x-ad-customer-id` 없으면 200+빈 data(silent-empty) — 루트 CLAUDE.md "stats" 절 참조. `ids`는 쉼표 분리 문자열이라 chunk(80개 등)로 나눠 호출 후 합산.
- `POST /apis/dashboard/v1/adAccounts/{no}/reports/search` body `{startDate,endDate}`는 계정 전체 ground truth(일별 metrics 합산, `conversions`=전체전환 / `purchasedConversionsValueMicros`=구매완료매출, **구매완료 전환수 count 필드는 없음**).
