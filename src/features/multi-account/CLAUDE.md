# F-MultiAccount — 다계정 대시보드

`/manage/ad-accounts/` URL에서 우상단 fixed 버튼(`dvads-multi-btn`) → `dvads-multi-popover`로 광고계정 명단(자동 fetch) + 어제 6지표 + 비즈머니 + 계약 D-day(≤5 빨강). 옵션 페이지에서 별칭/즐겨찾기/숨김 편집. 리포트(F-Report)·세팅안(F-Setup)·변경이력 알림(F-ChangeWatch)의 진입 메뉴도 이 popover에 있다.

## 파일

- `multi-account.ts` — popover UI 전체(행 메뉴, 리스트 뷰, 분리형 고정 헤더, 알림선). `report`/`setup`은 dynamic import로 지연 로딩.
- `multi-account-data.ts` — 데이터 수집. **모든 계정 데이터를 사용자 페이지 컨텍스트에서 직접 fetch** — bizmoney는 bmgate URL(`/apis/bmgate/v1.0/adAccounts/{accountNo}/bizmoney/account`)로 URL-aware, 나머지(campaigns/stats/contracts/adgroups)는 `/apis/sa/api/*` + `x-ad-customer-id: {masterCustomerId}` 헤더로 cross-account. hidden tab 안 씀. "↻ 전체"는 4 worker 병렬. `authFetch`는 다른 기능들(report/setup/change-watch)도 import.
- `multi-account-storage.ts` — 별칭/즐겨찾기/숨김/알림 opt-in 등 `MultiAccountUserMeta` + 사용자 설정 4종(제외 변경자·대행권 기준 번호·광고 유형 필터·리포트 담당자명, 서버 `user_settings`가 원본) + 계정 이슈 이력 캐시. **설정 save는 서버 성공 후 로컬 갱신이라 throw 가능** — 호출부는 `withServerSave`로 감쌀 것. 단 `Promise<void>` 함수는 성공해도 `undefined`라 실패 판정(`=== undefined`)과 구분 불가 — `.then(() => true)`로 성공값을 만들어 넘긴다(타입 제약이 컴파일로 강제, 2026-07-22 대행권 점검 먹통 실사고).
- `agency-check-excel.ts` — 대행권 확인 엑셀 (dynamic import).

PRD §8 단일 자격증명 모델과 충돌 없음 — 광고관리자 로그인 쿠키 기반.

## Gotchas

- **캠페인 상세 SPA URL은 `/sa/campaigns/{nccCampaignId}`** — 2026-07-21 실사용 URL로 검증(예: `/manage/ad-accounts/454196/sa/campaigns/cmp-a001-01-...`). 2026-07-20의 404는 다른 형식이었던 것. 유형별 목록은 `campaigns-by/{TYPE}` — API campaignType ↔ SPA TYPE이 다름: `SHOPPING`↔`SHOPPING_NS`, `BRAND_SEARCH`↔`BRAND` (`ISSUE_DEST_CAMPAIGN_TYPES` 매핑 참조). 광고그룹 상세 `/sa/adgroups/{id}`도 검증됨.
- **텍스트 휴리스틱 앵커 탐색(`findOperationChip`)의 fallback에도 위치 검증 필수** — "운영 관리" 텍스트는 계정 목록 드롭다운 안에도 나타나서, 위치 확인 없는 `el.parentElement` fallback이 열린 드롭다운 안에 버튼을 꽂는 사고(2026-07-20). 후보 span 자체가 헤더 영역(top<120, 크기>0)에 보여야 앵커 인정.

- **여러 경로가 같은 행 요소를 칠하면 나중 것이 앞선 것을 지운다** — 스냅샷 paint와 변경이력 스캔이 서로 다른 시점에 같은 행을 칠한다. 공유 표시는 각 경로가 `row.dataset.*`에 자기 판정만 쓰고 `syncIssueChip(row)`이 합쳐 그린다. 현재 이 구조를 쓰는 곳: '상태' 컬럼 배지(`syncIssueChip`, 이상 없음/확인 필요/예산 도달/광고 중단 4단계 — 겹치면 확인 필요 빨강, 계정 중단 판정은 비즈머니 잔액 ≤ 0). '상태' 헤더 클릭 = 상태 필터 드롭다운(`statusFilter` + `row.dataset.statusKind`, 필터 로직은 `applyListSearchFilter`에 통합). 계정명 셀 개수 배지·좌측 알림 선은 폐기(2026-07-21/20).
- **리스트 view와 검색 view가 `dvads-multi-td-status` 클래스를 공유한다** — 셀 스타일은 반드시 테이블 클래스(`.dvads-multi-search-table` 등)로 스코프. 안 하면 파일 뒤쪽 규칙이 다른 view의 정렬을 조용히 덮는다(2026-07-21 실사고).
- popover 폭은 `applyPopoverWidth`의 고정값(940px) — 리스트 컬럼을 추가/제거하면 이 값도 함께 조정해야 잘림/여백이 안 생긴다.
- **광고주센터 알림 피드** — `GET /apis/insight/v1/adAccounts/{no}/messages`. bmgate처럼 URL-aware cross-account(헤더 불필요). `type: "PROMOTION"` 제외분이 계정 이슈. 단, 상단 빨간 배너(비즈머니 부족 일시중지)는 이 피드에 **안 온다** — 잔액은 bizmoney로 별도 판단 (2026-07-20 정찰).
- 리스트 뷰의 **분리형 고정 헤더**(sticky 금지)는 이 기능이 레퍼런스 구현 — 패턴 상세와 함정 3개는 `src/shared/CLAUDE.md` 참조 (`syncHeadCols`, `scheduleHeadColSync`).
- 정렬·뷰 전환처럼 rapid 재트리거 가능한 async render는 token guard 필수 — `renderListView` 참고 (`src/shared/CLAUDE.md` "async render" 절).
- popover click-outside 닫기는 mousedown 시작 위치 추적 패턴 사용 (`src/shared/CLAUDE.md` 참조). popover open 시 자동 refresh 같은 fire-and-forget background 작업은 in-flight 플래그로 중복 실행 차단.
