# F-PoP — 전후 비교 popover

6개 매체 페이지 우측 상단 날짜 picker 옆 버튼 + 캡처된 stats 요청을 직전 동일 기간 날짜로 replay해 전후 비교표를 띄운다.

## 파일

- `fetch-patch-main.ts` — MAIN-world 콘텐츠 스크립트 진입점(manifest 등록, `document_start`, `all_frames`). 페이지 `fetch`/`XHR`을 패치해 stats 요청 캡처 → `CustomEvent("dvads:fetch-capture")`로 ISOLATED 쪽에 전달.
- `period-compare.ts` — popover UI + replay 오케스트레이션.
- `period-compare-adapters.ts` — 매체별 응답 schema → 6지표 정규화 + URL/body 날짜 shift.

## Gotchas

- **MAIN-world fetch/XHR 가로채기 패턴** — `manifest.config.ts`에 `world:"MAIN"` + `run_at:"document_start"` + `all_frames:true`로 별도 content_script 등록 (iframe에서의 호출 cover). MAIN→ISOLATED 통신은 `window.dispatchEvent(new CustomEvent(...))`. **detail의 response 객체는 반드시 `JSON.stringify` 후 string으로 전달** — Apollo/React reactive 객체를 그대로 넣으면 구조화 클론에서 throw돼 ISOLATED listener에 못 도착. ISOLATED는 parse + 새 객체로 복사 (CustomEvent.detail은 frozen 가능).
- **XHR `readystatechange` 단독 의존 금지** — `lib-sentry` 등 third-party가 XHR wrap을 덧씌우면 listener 무력화. `load`/`loadend`/`error`/`abort`도 같이 listen + `dispatched` flag로 멱등성 보장.
- **SA stats는 x-ad-customer-id 없으면 200+빈 data(silent-empty)** — 계정 스코프로 SA 구매완료를 합산할 땐 캡처 헤더에 기대지 말고 `masterCustomerId`를 명시 (루트 CLAUDE.md "stats" 절 참조). dashboard `campaign.campaignId`(`cmp-...`)는 SA stats `ids`와 동일 형식이라 변환 불필요 — 헤더만 문제.
- popover는 JS inline `transform`으로 위치를 잡음 — 진입 애니메이션에 `transform` 키프레임 금지(`@/shared/CLAUDE.md` UI 패턴 참조).
