# F001 — 파워링크 입찰 오버레이

콘텐츠 스크립트 진입점(`index.ts`). 파워링크 키워드 옆에 현재 추정 순위 + 1~10위 예상 입찰가 + 성과 추정 배지를 렌더하고, 팝오버 행 클릭으로 입찰가를 자동 변경한다. 다른 기능(asset-bulk, period-compare, multi-account 등)의 init도 여기서 호출한다.

## 파일

- `index.ts` — 배지·팝오버 렌더 + 입찰가 변경 오케스트레이션 + 각 기능 init. popover에 PC/모바일 디바이스 토글(PC default eager, MOBILE은 토글 시 lazy). 토글 시 popover 높이 morph(FLIP 패턴) + flip 결정 freeze(`openPopoverFlipHeight`)로 위치 jitter 방지.
- `dom-bid.ts` — ads.naver.com 입찰가 변경 UI 자동화 격리. 페이지 입찰가 셀 클릭 → React 호환 input 값 주입 → 변경 버튼 클릭 → 셀 갱신 대기. **ads.naver.com DOM 셀렉터는 이 파일에 격리** — 클래스명이 갈리면 이 파일만 수정. `waitFor`/`setReactInputValue` 헬퍼는 다른 자동화 모듈(asset-bulk 등)도 import해서 사용.
- `volume-cache.ts` / `performance-cache.ts` — 입찰가·성과 캐시. TTL 4시간. 키 스킴은 `@/shared/storage-keys` (`<prefix>:<device>:<keyword>[:<bid>]` — device 포함). background(`src/background`)도 import.

## Gotchas

- **`/estimate/average-position-bid/keyword` position 상한은 device별로 다름** — PC 1~10, **MOBILE 1~5만 허용** (400 `position(N) must be lower than 5`). batch에 cap 초과 1개라도 섞이면 전체 400 → silent-empty → "응답없음" 배지. `MAX_POSITION_BY_DEVICE` 상수(`src/types/storage.ts`)로 가드. 다른 estimate endpoint도 device-specific 제약 가능성 — 새 device 호출 도입 시 raw 응답 1회 검증 필수.
- **배지 ⚠ "응답없음" 디버깅 1순위 = SW Console raw 로그** (`[searchad] ... raw response` 또는 `API 4xx`). silent-empty = "응답은 받았는데 데이터 0개". spike 로그는 모듈당 1회만 찍히니 확장 reload 후 재호출하면 다시 찍힘. 400 에러 메시지의 `fields:`가 결정적 단서.
- **페이지의 React `<input>`에 값 자동 주입** 시 `input.value = "X"`는 React state 우회되어 저장 시 원래값으로 복구. `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v)` + bubbling `input`/`change` 이벤트 dispatch 필수 (`dom-bid.ts` `setReactInputValue`).
- **`document` 외부 클릭 리스너(팝오버 자동 닫기)는 우리가 `element.click()`으로 발생시킨 이벤트도 받는다.** 페이지 자동화 동안 `suppressPopoverClose(ms)` 토큰 패턴(`index.ts`)으로 일시 차단. 토큰 카운터는 연속 작업 시 먼저 발행된 timer가 늦은 작업 중간에 풀어버리는 race 방지.
- **페이지 자체 모달 검출**은 `[role="dialog"]` 의존 금지 — naver 컴포넌트가 role을 안 쓸 수 있음. `document.body.textContent.includes("...")` + `requestAnimationFrame` throttle이 안정적 (`watchPageConfirmModal`). 페이지 모달이 떠있는 동안 우리 팝오버는 `.dvads-recede`로 hide, 토스트(Undo)는 hide 대상 제외.
