# shared — 공용 모듈 + 오버레이 UI 패턴

여러 기능이 함께 쓰는 모듈. **오버레이 UI(팝오버·다이얼로그·표·드롭다운)를 새로 만들거나 고칠 때는 기능 폴더 작업이어도 이 문서를 먼저 읽는다.** 시각 결정은 `docs/DESIGN.md`가 단일 진실의 원천.

## 파일

- `ui-dropdown.ts` — **오버레이 dropdown은 `createDropdown` 의무** (네이티브 `<select>` 금지 — OS별 외관 차이). popup 등 컨테이너 dismiss 시 `closeAllOpenDropdowns()` 호출해 portal 패널 정리.
- `dialog-dismiss.ts` — **backdrop dim + 중앙 카드 다이얼로그의 "배경 클릭으로 닫기"는 반드시 `wireBackdropDismiss` 사용.** 카드 입력창에서 텍스트 드래그 → backdrop에서 mouseup하면 `click` target이 backdrop이 돼 단순 `e.target === backdrop` 판정으론 잘못 닫힘. 헬퍼는 mousedown이 backdrop에서 시작한 경우에만 닫고 stopPropagation까지 처리. 새 다이얼로그는 직접 구현 금지.
- `confirm-dialog.ts` / `input-dialog.ts` / `toast.ts`(+5초 Undo) / `tooltip.ts` — React 미사용, native DOM.
- `searchad.ts` — 검색광고 API HMAC 서명 + batch fetch + 429 backoff. `friendly-error.ts` — 사용자 친화적 에러 변환. `rank.ts` — 예상순위 계산. `storage-keys.ts` — 캐시 키 스킴. `cache-prune.ts` — TTL prune.

## searchad API

- `hintKeywords` 제약 = 한글·영문·숫자만 + 길이 ≤30 + 공백 X. 위반 시 배치(5개) 400. `fetchVolumes`는 400만 swallow하고 401/403/5xx/네트워크는 throw — 인증·서버 장애를 부분 결과로 가리지 않게.

## 오버레이 UI 패턴 (전 기능 공통)

- **Popover click-outside 닫힘은 mousedown 시작 위치 추적 필수** — 안에서 텍스트 드래그 → 밖에서 mouseup하면 click이 외부로 발화해 잘못 닫힘. `mousedown` capture로 시작 위치 기록 → 내부였으면 다음 click 1번 면제 (`multi-account.ts`·`period-compare.ts` 동일 패턴).
- **DOM 빌드 → attach → paint 3단계 분리** — `popoverEl.querySelector`로 자식 행을 찾아 그리는 helper는 element가 attach된 *후* 호출. detached fragment 안에선 querySelector가 silent no-op. 패턴: 모든 row mount → table attach → paint loop.
- **async render 깜빡임 방지** — await 데이터 로드를 *먼저* 끝낸 뒤 `DocumentFragment`에 빌드 → `wrap.replaceChildren(fragment)` atomic swap. rapid 재트리거 가능한 곳은 token guard 추가 — `const token = ++renderToken; await ...; if (token !== renderToken) return;` (`multi-account.ts:renderListView`).
- **CSS `transform` 키프레임 vs JS inline `transform` 위치 충돌** — JS로 `style.transform = translate(x,y)` 위치를 잡는 popover에 진입 애니메이션 keyframe의 `transform`이 겹치면 0,0으로 튐. 진입 모션은 `opacity` only 또는 wrapper 분리. `@media (prefers-reduced-motion) { transform: none !important }`도 그 element엔 적용 금지.
- **`clip-path: inset(...)`는 box-shadow를 같이 자름** — shadow 보존하려면 `translateY + scale + opacity` 조합으로 대체 (`overlay.css` `.dvads-multi-popover` enter 키프레임).
- **`.dvads-bid-table` 재사용 시 CSS specificity** — 베이스 `.dvads-bid-table td { color }`(0,1,1)가 셀 색 클래스(0,1,0)를 덮음. 색 override는 `td.dvads-X` 또는 `.dvads-bid-table td.dvads-X`(0,2,1) 형태로.
- **스크롤 표의 고정 헤더는 sticky 대신 "분리형 헤더" 패턴** (F-MultiAccount list view가 레퍼런스). sticky는 ① 조상 transform 잔류(진입 애니메이션 `fill:both/forwards`) 아래에서 1프레임 지연 — sticky 자손 품는 컨테이너의 transform 애니메이션은 `fill: backwards` 필수, ② 소수점 스크롤 오프셋에서 1px 떨림. 해법 = 헤더를 스크롤 컨테이너 밖 별도 테이블로 분리: headwrap(thead, `table-layout:fixed`, `scrollbar-gutter:stable`) + bodywrap(tbody) + `syncHeadCols`(JS)가 body 첫 가시 행 셀 폭을 th에 강제. 함정 3개: (a) 폭 측정은 `getBoundingClientRect` 금지(진입 scale 도중 축소값) — `getComputedStyle().width` 사용, (b) RO(table)는 내부 컬럼 재분배를 못 잡음 — paintRow·필터·접기·fullscreen에 `scheduleHeadColSync` 훅 + `document.fonts.ready`, (c) 표 외곽 보더 겹선 — 헤더 하단/본문 상단 각각 `border-bottom:0`/`border-top:0`.
- **콘텐츠 오버레이는 `dvads-` prefix로 격리** — 호스트 CSS 충돌 방지. em dash(`—`)/minus sign(`−`) 금지, 하이픈 `-`만.
