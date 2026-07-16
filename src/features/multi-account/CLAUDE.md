# F-MultiAccount — 다계정 대시보드

`/manage/ad-accounts/` URL에서 우상단 fixed 버튼(`dvads-multi-btn`) → `dvads-multi-popover`로 광고계정 명단(자동 fetch) + 어제 6지표 + 비즈머니 + 계약 D-day(≤5 빨강). 옵션 페이지에서 별칭/즐겨찾기/숨김 편집. 리포트(F-Report)·세팅안(F-Setup)·변경이력 알림(F-ChangeWatch)의 진입 메뉴도 이 popover에 있다.

## 파일

- `multi-account.ts` — popover UI 전체(행 메뉴, 리스트 뷰, 분리형 고정 헤더, 알림선). `report`/`setup`은 dynamic import로 지연 로딩.
- `multi-account-data.ts` — 데이터 수집. **모든 계정 데이터를 사용자 페이지 컨텍스트에서 직접 fetch** — bizmoney는 bmgate URL(`/apis/bmgate/v1.0/adAccounts/{accountNo}/bizmoney/account`)로 URL-aware, 나머지(campaigns/stats/contracts/adgroups)는 `/apis/sa/api/*` + `x-ad-customer-id: {masterCustomerId}` 헤더로 cross-account. hidden tab 안 씀. "↻ 전체"는 4 worker 병렬. `authFetch`는 다른 기능들(report/setup/change-watch)도 import.
- `multi-account-storage.ts` — 별칭/즐겨찾기/숨김/알림 opt-in 등 `MultiAccountUserMeta`.
- `agency-check-excel.ts` — 대행권 확인 엑셀 (dynamic import).

PRD §8 단일 자격증명 모델과 충돌 없음 — 광고관리자 로그인 쿠키 기반.

## Gotchas

- **여러 경로가 같은 행 클래스를 토글하면 나중 것이 앞선 것을 지운다** — 좌측 알림 선(`dvads-multi-tr-threshold-alert`)은 스냅샷 paint(비즈/브랜드)와 변경이력 스캔이 서로 다른 시점에 칠한다. 각 경로는 `row.dataset.alert*`에 자기 판정만 쓰고 `syncAlertBar(row)`가 합쳐서 칠하는 구조.
- 리스트 뷰의 **분리형 고정 헤더**(sticky 금지)는 이 기능이 레퍼런스 구현 — 패턴 상세와 함정 3개는 `src/shared/CLAUDE.md` 참조 (`syncHeadCols`, `scheduleHeadColSync`).
- 정렬·뷰 전환처럼 rapid 재트리거 가능한 async render는 token guard 필수 — `renderListView` 참고 (`src/shared/CLAUDE.md` "async render" 절).
- popover click-outside 닫기는 mousedown 시작 위치 추적 패턴 사용 (`src/shared/CLAUDE.md` 참조). popover open 시 자동 refresh 같은 fire-and-forget background 작업은 in-flight 플래그로 중복 실행 차단.
