# F-AssetBulk — 파워링크 확장소재 일괄 등록

"+ 새 확장 소재" 드롭다운에 "등록" li 주입 → native DOM 팝업으로 이미지/추가제목/추가설명/홍보문구(최대 2개) 입력 → 페이지 모달 자동화로 순차 등록.

## 파일

- `asset-bulk.ts` — 진입/오케스트레이션. `asset-bulk-popup.ts` — 입력 팝업 UI(자체 pointerdown dismiss 가드 보유). `dom-asset.ts` — 확장소재 페이지 DOM 셀렉터 격리.
- 홍보문구는 `[홍보종류 select][추가설명 14자]` 쌍이고 종류 dropdown은 `selectPromoKind`로 mousedown+click + portal li 매칭.
- `product-page-scrape.ts` — v2: 상품 페이지 URL → background hidden tab에 주입되는 스크레이퍼(콘텐츠 스크립트 진입점, manifest 등록). `product-page-extract.ts` — PRELOADED_STATE `simpleProductForDetailPage.A.{representativeImageUrl, optionalImageUrls}` 화이트리스트 path만 사용해 로고/배너/추천 상품 noise 제외.
- `shopping-image-import.ts` — 쇼핑 소재 이미지 가져오기. `image-file.ts` — background `FETCH_IMAGE_BINARY` 경유 이미지 binary → File 변환.
- React `<input>` 값 주입·`waitFor`는 `@/features/bid/dom-bid`의 헬퍼 재사용.

## Gotchas

- **네이버 SPA의 inline SSR state**(`window.__PRELOADED_STATE__={...}` 등)는 `/` unicode escape + `:undefined`/`:NaN` JS literal이 박혀있어 raw `JSON.parse` 실패. brace depth counter로 assignment 잘라낸 뒤 `:undefined` → `:null` sanitize 후 parse (`product-page-scrape.ts` `sliceBalancedBraces`/`sanitizeJsLiterals`). 갤러리 path는 도메인별 화이트리스트로 박아 noise 제외 — 단순 정규식 추출은 거의 항상 noise 같이 잡힘.
- **`shop-phinf.pstatic.net` raw URL은 응답 사이즈 비일관** (이미지마다 thumbnail 또는 full). 확장소재 모달(단축 640px ~ 장축 2000px 검증)에 그대로 업로드 시 일부 거부. 페이지 carousel이 쓰는 `?type=o1000` query 강제로 1000×1000 정사각 보장 (`applyStandardSize`). `?type=w1500` 등 다른 variant는 일부 이미지에서 invalid response → broken image.
- **`chrome.tabs.create({active:false})` hidden tab의 carousel hydration 한계** — lazy slider의 다른 슬라이드가 lazy-load 안 됨. DOM `<img>` scrape만으론 첫 슬라이드 ~4장만 잡힘. SSR JSON inline state에서 path 화이트리스트 추출이 가장 안정적, DOM scrape는 폴백.
- **주입 DOM("이미 있음" skip 가드가 있는 메뉴 항목·strip)은 세대값을 attribute에 찍는다** (`takeover.currentGen()`). 드롭다운/모달이 열린 채 확장 reload되면 옛 컨텍스트의 자기 정리가 안 돌 수 있어, 새 컨텍스트가 다른 세대 요소를 제거 후 재주입하는 게 방어선 — 안 하면 죽은 핸들러의 버튼만 남는다 (2026-07-22).
- 이미지 CDN(pstatic)은 CORS 차단이라 background fetch 필수 → `host_permissions`에 해당 도메인 필요 (`manifest.config.ts` 주석 참조).
