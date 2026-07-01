# dv-ads (디브이 애드 매니저)

네이버 광고 대시보드(`ads.naver.com`)에 주입되는 Chrome MV3 확장. 파워링크 키워드 옆에 **현재 추정 순위 + 1~10위 예상 입찰가 + 성과 추정**을 띄우고 **팝오버 행 클릭으로 입찰가를 자동 변경**한다. (쇼핑검색광고 F002/F003은 2026-05-19 보류 — `docs/ROADMAP.md`·`docs/PRD.md` 참조)

React 19 + TypeScript 5.7 + TailwindCSS v4 + Vite 6 + `@crxjs/vite-plugin`.

## 언어

이 프로젝트의 모든 사용자 응답은 **한글**로 작성한다. gstack, superpowers 등 스킬에서 나오는 안내·질문·옵션 라벨·요약·진행 상황 메시지도 모두 한글로 번역해서 전달한다. 코드, 명령어, 파일 경로, 변수명, 영문 고유명사는 원문 그대로 둔다.

## Commands

```bash
npm run dev         # @crxjs HMR 개발 서버
npm run build       # tsc -b && vite build → dist/
npm run typecheck   # tsc -b --noEmit
npm run package     # build + dist-zip/DV-Ads-Manager vX.Y.Z.zip
```

**소스 코드(`src/`, `manifest.config.ts`, `package.json` 등) 수정 후에는 항상 `npm run build`를 실행해 `dist/`를 갱신한다.** 사용자가 `dist/`를 chrome://extensions 에 로드해서 사용 중이라 빌드를 빼먹으면 변경이 반영되지 않는다. 문서·주석만 고친 경우는 예외.

## Release

`v*` 태그를 push 하면 `.github/workflows/release.yml`이 `npm run package`를 실행해 `dist-zip/DV-Ads-Manager v{version}.zip`을 GitHub Release에 첨부한다. 버전은 `package.json` 기준이므로 `package.json`의 `version`을 먼저 올리고 동일 버전으로 태그: `git tag v0.0.X && git push --tags`. zip 파일명 패턴을 바꾸면 `release.yml`의 `files:` 글롭과 `scripts/zip-dist.mjs`의 outFile 패턴도 동기화 필요.

## Architecture

- `src/content/index.ts` — `ads.naver.com` 페이지 주입 콘텐츠 스크립트. 광고 키워드 옆 입찰가·순위 오버레이 렌더 + 팝오버 행 클릭으로 입찰가 자동 변경. popover에 PC/모바일 디바이스 토글(PC default eager 호출, MOBILE은 토글 시 lazy 호출). in-memory + storage 캐시 키에 device 포함(`<prefix>:<device>:<keyword>[:<bid>]`). 토글 시 popover 높이 morph(FLIP 패턴) + flip 결정 freeze(`openPopoverFlipHeight`)로 위치 jitter 방지.
- `src/content/dom-bid.ts` — ads.naver.com 입찰가 변경 UI 자동화 격리. 페이지 입찰가 셀 클릭 → React 호환 input 값 주입 → 변경 버튼 클릭 → 셀 갱신 대기. `waitFor` / `setReactInputValue` 헬퍼는 다른 자동화 모듈에서도 import해서 사용.
- `src/content/asset-bulk.ts` + `asset-bulk-popup.ts` + `dom-asset.ts` — F-AssetBulk 파워링크 확장소재 일괄 등록. "+ 새 확장 소재" 드롭다운에 "등록" li 주입 → native DOM 팝업으로 이미지/추가제목/추가설명/홍보문구(최대 2개) 입력 → 페이지 모달 자동화로 순차 등록. 홍보문구는 `[홍보종류 select][추가설명 14자]` 쌍이고 종류 dropdown은 `selectPromoKind`로 mousedown+click + portal li 매칭. 확장소재 페이지 DOM 셀렉터는 `dom-asset.ts`에 격리.
- `src/content/product-page-scrape.ts` + `src/lib/product-page-extract.ts` — F-AssetBulk v2 상품 페이지 URL → background hidden tab 갤러리 스크레이퍼. PRELOADED_STATE `simpleProductForDetailPage.A.{representativeImageUrl, optionalImageUrls}` 화이트리스트 path만 사용해 로고/배너/추천 상품 noise 제외.
- `src/content/confirm-dialog.ts` / `toast.ts` — 오버레이 다이얼로그·토스트(+5초 Undo). React 미사용, native DOM.
- `src/background/index.ts` — MV3 Service Worker. 검색광고 API(GET_BID_ESTIMATE) fetch 위임.
- `src/popup/` — React 19 팝업 (옵션 진입점)
- `src/options/` — 검색광고 API 자격증명(`customerId`/`accessLicense`/`secretKey`) 입력
- `src/lib/searchad.ts` — 검색광고 API HMAC 서명 + batch fetch + 429 backoff
- `src/lib/volume-cache.ts` + `performance-cache.ts` — 캐시
- `src/lib/friendly-error.ts` — 사용자 친화적 에러 변환
- `manifest.config.ts` — `@crxjs/vite-plugin`이 빌드 시 manifest.json 생성. content_scripts 2개 (ISOLATED `index.ts` + MAIN-world `fetch-patch-main.ts`, 둘 다 `all_frames:true`).
- `src/content/fetch-patch-main.ts` — MAIN-world에서 페이지 `fetch`/`XHR`을 패치해 stats 요청을 캡처. `CustomEvent`로 ISOLATED 콘텐츠 스크립트에 전달 (`dvads:fetch-capture`).
- `src/content/period-compare.ts` — F-PoP 전후 비교 popover. 6개 매체 페이지 우측 상단 날짜 picker 옆 버튼 + 캡처된 stats를 직전 동일 기간 날짜로 replay.
- `src/lib/period-compare-adapters.ts` — 매체별 응답 schema → 6지표 정규화 + URL/body 날짜 shift.
- `src/content/multi-account.ts` + `src/lib/multi-account-data.ts` + `src/lib/multi-account-storage.ts` + `src/options/multi-account-ui.tsx` — F-MultiAccount 다계정 대시보드. `/manage/ad-accounts/` URL에서 우상단 fixed 버튼(`dvads-multi-btn`) → `dvads-multi-popover`로 광고계정 명단(자동 fetch) + 어제 6지표 + 비즈머니 + 계약 D-day(≤5 빨강). **모든 계정 데이터를 사용자 페이지 컨텍스트에서 직접 fetch** — bizmoney는 bmgate URL(`/apis/bmgate/v1.0/adAccounts/{accountNo}/bizmoney/account`)로 URL-aware, 나머지(campaigns/stats/contracts/adgroups)는 `/apis/sa/api/*` + `x-ad-customer-id: {masterCustomerId}` 헤더로 cross-account. hidden tab/approach 안 씀. "↻ 전체"는 4 worker 병렬. 옵션 페이지에서 별칭/즐겨찾기/숨김 편집. PRD §8 단일 자격증명 모델과 충돌 없음 — 광고관리자 로그인 쿠키 기반.
- `src/content/setup.ts` + `src/lib/setup-data.ts` + `src/lib/setup-adapters.ts` + `src/lib/setup-excel.ts` + `src/types/setup.ts` — F-Setup 세팅안(광고 세팅 제안서) 엑셀 다운로드. F-MultiAccount popover 행 메뉴 "세팅안 생성" → 캠페인 선택 모달(`dvads-setup-modal`, 체크박스 다중선택+유형 필터) → 선택 캠페인의 캠페인-그룹-소재-키워드 계층 수집(`/apis/sa/api/ncc/{campaigns,adgroups,adgroups/{id},ads,keywords}`, `authFetch` cross-account, worker pool 4) → 키워드 예상순위 보강(background `GET_BID_ESTIMATE` 재사용 + `estimateRank`) → `write-excel-file/browser`로 **캠페인마다 시트 1개**(시트명=캠페인명) 생성 → Blob 다운로드. 각 시트 레이아웃(눈금선 off): 상단 캠페인 타이틀+그룹 요약표(그룹/일예산/디바이스/지역/요일시간/소재노출), 중단 소재(제목/설명/URL은 columnSpan 2), 하단 **키워드 가로 블록**(그룹을 옆으로 나란히, 그룹마다 그룹명 헤더(columnSpan 3)+[키워드/입찰가/예상순위]). 한 시트에 폭 다른 표를 columnSpan으로 정렬. **쇼핑검색 소재는 상품 자체** — 소재유형 칸에 상품 이미지(write-excel-file image anchor)+제목(referenceData.productTitle)+상품링크(mallProductUrl), 설명 없음. 이미지는 pstatic CDN CORS 차단으로 background `FETCH_IMAGE_BINARY` 경유(host_permissions에 `shopping-phinf.pstatic.net` 추가). 전부 클라이언트 사이드. 유형별 소재/키워드 구조 차이는 `setup-adapters.ts`가 흡수(WEB_SITE/BRAND_SEARCH만 키워드 보유, SHOPPING/PLACE는 소재만). 키워드 실효 입찰가는 `useGroupBidAmt`면 그룹 `bidAmt` 상속. endpoint schema는 메모리 `project_f_setup_endpoints`.
- ~~F002/F003 쇼핑검색광고~~ — ⏸️ 보류 (2026-05-19). Spike B 정찰 결과(`admng_exp_keyword` + `ad-account v2`)는 메모리 `project_spike_b_shopping_endpoints`에 보존 — 추후 다른 기능에서 재사용 가능. 보류 사유는 `docs/ROADMAP.md` Task 013/014 항목 참조.

## 디자인 시스템

모든 시각 결정(색·간격·타이포·컴포넌트)의 **단일 진실의 원천**은 [`docs/DESIGN.md`](./docs/DESIGN.md). UI를 작성/수정할 때는 반드시 이 문서를 먼저 확인한다. 핵심:

- **카드** — 옵션/팝업은 `rounded-2xl + shadow-card` (보더 없음). 오버레이는 호스트 페이지와 시각 분리를 위해 `1.5px #E6783B` 보더 + 10px radius.
- **버튼** — radius 8px, weight 500, height 32px (오버레이 공통 `.dvads-btn`). **Primary는 항상 DV 주황 `#E6783B`** (검정 default 패턴은 폐기, DESIGN.md Decisions Log 2026-05-18). 화면당 primary 1~2개 제한.
- **DV 주황 사용 면적 ~3% 이내** — primary 버튼 + F001 "현재 N위 ▾" 배지 + focus ring + 다이얼로그 차액(+) 강조. 페이지 배경·본문 텍스트·카드 보더 등에는 X.
- **Pretendard 1순위**, 3-weight(400/500/600) 시스템. 700 bold는 옵션 페이지 h1에만.
- **콘텐츠 오버레이는 `dvads-` prefix로 격리** — `ads.naver.com` 호스트 CSS와 충돌 방지.
- **오버레이 dropdown은 `createDropdown`(`src/content/ui-dropdown.ts`) 의무** — 네이티브 `<select>` 사용 금지. OS·브라우저별 외관 차이로 시각 통일 불가. popup 등 컨테이너 dismiss 시 `closeAllOpenDropdowns()` 호출해 portal 패널 정리.
- **em dash(`—`) / minus sign(`−` U+2212) 금지** — 모든 짝대기는 일반 하이픈 `-` (U+002D)만 사용. 음수 표시(`(-230)`)도 동일.

새 패턴이 필요하면 코드에 즉흥 도입하지 말고 `docs/DESIGN.md`를 먼저 갱신한 뒤 반영.

## Gotchas

- **`host_permissions` 핵심은 광고 2곳 — `ads.naver.com`, `api.searchad.naver.com`.** 모든 광고 데이터는 이 두 곳(검색광고 API + 광고관리자 internal API) 안에서만 — 셀러 센터(`sell.smartstore.naver.com`) 등 비광고 도메인은 부적합. 그 외는 **이미지 binary fetch처럼 불가피한 경우에만** 추가됨: `smartstore`/`brand.naver.com`/`shop-phinf.pstatic.net`(F-AssetBulk 상품 이미지), `shopping-phinf.pstatic.net`(F-Setup 쇼핑 소재 이미지). pstatic CDN은 CORS 차단이라 background fetch 필수→host_permission 필요. **늘릴수록 Chrome 심사 사유 요구이니 최소화** — 새 도메인 추가 전 정말 불가피한지 검토.
- 광고 대시보드 페이지 fetch는 사용자 탭 컨텍스트에서 실행하는 게 안전(쿠키·UA 우회). background에서 직접 부르면 anti-bot에 막힐 가능성.
- `ads.naver.com` 비공식 internal API(`/apis/sa/api/adata/*`, `/apis/ad-account/v2/*`)는 CORS상 **콘텐츠 스크립트에서만 호출 가능** (background는 차단). 인증은 광고관리자 로그인 쿠키 + `x-xsrf-token` 헤더(`XSRF-TOKEN` 쿠키 더블 서밋, `decodeURIComponent` 필요). schema·path 예고 없이 변경 가능 — `friendly-error`로 graceful fallback 필수.
- 광고관리자 URL의 `ad-accounts/{accountId}`는 광고관리자 account ID로 검색광고 API `customerId`와 별개. 매핑은 `GET ads.naver.com/apis/ad-account/v2/adAccounts/{accountId}` 응답의 `adAccount.masterCustomerId`.
- searchad API `hintKeywords` 제약 = 한글·영문·숫자만 + 길이 ≤30 + 공백 X. 위반 시 배치(5개) 400. `fetchVolumes`(`searchad.ts`)는 400만 swallow하고 401/403/5xx/네트워크는 throw — 인증·서버 장애를 부분 결과로 가리지 않게.
- `chrome.storage.local`은 확장별 격리 — 다른 확장에 등록된 검색광고 자격증명을 자동으로 못 읽으므로 사용자가 본 확장 옵션에 별도 입력해야 한다.
- 사용자 데이터(광고 키워드·예산·소재 등) 외부 전송 0건이어야 한다.
- 버전은 `package.json`의 `version` 필드가 단일 소스 — `manifest.config.ts`에서 자동 import.
- **콘텐츠 스크립트에서 페이지의 React `<input>`에 값 자동 주입** 시 `input.value = "X"`는 React state 우회되어 저장 시 원래값으로 복구. `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, v)` + bubbling `input`/`change` 이벤트 dispatch 필수 (`src/content/dom-bid.ts` `setReactInputValue` 참고).
- **ads.naver.com DOM 셀렉터는 `src/content/dom-bid.ts`에 격리.** 클래스명이 갈리면 그 파일만 수정. 다음 페이지 자동화도 같은 파일에 추가.
- **콘텐츠 스크립트의 `document` 외부 클릭 리스너(팝오버 자동 닫기 등)는 우리가 `element.click()`으로 발생시킨 이벤트도 받는다.** 페이지 자동화 동안 `suppressPopoverClose(ms)` 토큰 패턴(`src/content/index.ts`)으로 일시 차단. 토큰 카운터는 연속 작업 시 먼저 발행된 timer가 늦은 작업 중간에 풀어버리는 race 방지.
- **페이지가 띄우는 자체 모달 검출**은 `[role="dialog"]`에 의존하지 말 것 — naver 컴포넌트가 role을 안 쓸 수 있음. `document.body.textContent.includes("...")` + `requestAnimationFrame` throttle이 안정적 (`watchPageConfirmModal` 참고). 페이지 모달이 떠있는 동안 우리 팝오버는 `.dvads-recede`로 hide, 토스트(Undo)는 hide 대상 제외.
- **ads.naver.com SA stats endpoint** — `POST /apis/sa/api/stats`. body `{fields:[], timeIncrement:"allDays", timeRange:{since:"YYYY-MM-DD", until:"YYYY-MM-DD"}, ids:"id1,id2,..."}`. 응답 `{summary, data, compTm, cycleBaseTm}` — `summary`가 총계, `data`가 row별. `*Micros` suffix는 마이크로 단위(÷1,000,000=원). 6지표 키 매핑: `impCnt`(노출)/`clkCnt`(클릭)/`cpc`/`salesAmtMicros`(=광고비, **매출 아님**)/`purchaseConvAmtMicros`(=구매완료 전환매출)/`purchaseCcnt`(=구매완료 전환수). 같은 endpoint를 캠페인/광고그룹/키워드별로 여러 번 호출 — 빈 응답(summary null + data empty) 섞이니 의미있는 것만 사용.
- **MAIN-world fetch/XHR 가로채기 패턴** — `manifest.config.ts`에 `world:"MAIN"` + `run_at:"document_start"` + `all_frames:true`로 별도 content_script 등록 (페이지가 iframe·다른 frame에서 호출하는 경우 cover). MAIN→ISOLATED 통신은 `window.dispatchEvent(new CustomEvent("dvads:fetch-capture", {detail}))`. **detail의 response 객체는 반드시 `JSON.stringify` 후 string으로 전달** — Apollo/React reactive 객체를 그대로 넣으면 구조화 클론에서 throw돼 ISOLATED listener에 못 도착. ISOLATED는 parse + 새 객체로 복사 (CustomEvent.detail은 frozen 가능). `src/content/fetch-patch-main.ts` 참조.
- **XHR `readystatechange` 단독 의존 금지** — `lib-sentry` 등 third-party가 XHR wrap을 덧씌우면 우리 listener가 무력화됨. `load`/`loadend`/`error`/`abort`도 같이 listen + `dispatched` flag로 멱등성 보장.
- **광고관리자 SPA URL 패턴**: `/manage/ad-accounts/{adAccountNo}/sa/campaigns-by/{TYPE}` (매체 리스트, TYPE=`WEB_SITE`(파워링크)/`SHOPPING_NS`(쇼핑)/`BRAND`(브랜드)/`POWER_CONTENTS`/`PLACE`), `/manage/ad-accounts/{adAccountNo}/sa/adgroups/{adgroupId}` (광고그룹 상세). `adAccountNo`는 광고관리자 URL ID — 검색광고 API `customerId`와 별개.
- **`.dvads-bid-table` 재사용 시 CSS specificity 주의** — 베이스 `.dvads-bid-table td { color: #171717 }`(specificity 0,1,1)가 셀 색 클래스(`.dvads-period-delta-up` 0,1,0)를 덮어씀. 행·셀 색 override는 `td.dvads-X` 또는 `.dvads-bid-table td.dvads-X`(0,2,1) 형태로 specificity 맞춤.
- **광고관리자 internal API cross-account의 silver bullet = `x-ad-customer-id` 헤더** (2026-05-21 정찰). `/apis/sa/api/*` 류 endpoint들이 URL에 `adAccountNo`가 없지만 SPA가 매 호출에 `x-ad-customer-id: {masterCustomerId}` 헤더를 함께 보내 서버가 그 customerId 기준으로 응답한다. 헤더 없으면 세션 활성 계정 기준 → 404 "광고주가 존재하지 않습니다". `masterCustomerId`는 광고계정 directory의 `adAccount.masterCustomerId`에서 가져옴. 또한 **bizmoney는 별도 `bmgate` 서비스로 URL-aware**: `/apis/bmgate/v1.0/adAccounts/{adAccountNo}/bizmoney/account` (path에 accountNo, 헤더 불필요). 이 패턴 덕에 F-MultiAccount cross-account 데이터 수집은 hidden tab/approach 안 쓰고 사용자 페이지 컨텍스트에서 직접 fetch + 병렬 가능. 새 internal API 신규 사용 시 SPA가 그 호출에 `x-ad-customer-id` 보내는지 / URL-aware 경로 있는지 정찰 권장.
- **`/apis/sa/api/stats` body `ids` 필드는 캠페인/광고그룹 ID 쉼표 분리 문자열** — 배열 아닌 문자열. 한 번에 많이 넣으면 URL/payload 한계가 있을 수 있어 chunk(80개 등)로 호출 후 응답 합산. `*Micros` suffix는 ÷1,000,000 = 원 단위.
- **`/apis/sa/api/stats`는 x-ad-customer-id 없으면 404가 아니라 200+빈 data(silent-empty).** ncc/campaigns 등은 404를 주지만 stats는 빈 응답이라 더 헷갈린다. dashboard/전체캠페인처럼 계정 스코프로 SA 구매완료를 합산할 땐 캡처 헤더에 기대지 말고 `masterCustomerId`(`/apis/ad-account/v2/adAccounts/{no}` → `adAccount.masterCustomerId`)를 `x-ad-customer-id`로 명시해야 SA만 0으로 누락되지 않는다 (2026-05-27 F-PoP). dashboard `campaign.campaignId`(`cmp-...`)는 SA stats `ids`와 동일 형식이라 변환 불필요 — 헤더만 문제.
- **`/estimate/average-position-bid/keyword` position 상한은 device별로 다름** — PC 1~10, **MOBILE 1~5만 허용** (400 `position(N) must be lower than 5`). batch에 cap 초과 1개라도 섞이면 전체 400 거부 → silent-empty → "응답없음" 배지. `MAX_POSITION_BY_DEVICE` 상수(`src/types/storage.ts`)로 가드. 다른 estimate endpoint도 device-specific 제약 가능성 — 새 device 호출 도입 시 raw 응답 1회 검증 필수.
- **배지 ⚠ "응답없음" 디버깅 1순위 = SW Console raw 로그** (`[searchad] ... raw response` 또는 `API 4xx`). silent-empty = "응답은 받았는데 데이터 0개" 상태. spike 로그는 모듈당 1회만 찍히니 확장 reload 후 재호출하면 다시 찍힘. 400 에러 메시지의 `fields:` 가 결정적 단서.
- **ads.naver.com internal API 응답 검증/디버깅은 Playwright MCP `browser_evaluate` 페이지 컨텍스트 fetch로** — 사용자 로그인 후 페이지에서 직접 fetch 실행해 라이브 응답 확인(확장 미로드여도 internal API 동작 검증 가능). `POST /apis/dashboard/v1/adAccounts/{no}/reports/search` body `{startDate,endDate}`는 계정 전체 ground truth(일별 metrics 합산, `conversions`=전체전환 / `purchasedConversionsValueMicros`=구매완료매출, **구매완료 전환수 count 필드는 없음**).
- **`tsc -b` incremental cache(`.tsbuildinfo`)에 stale 에러가 남을 수 있음** — `rm -f tsconfig.*.tsbuildinfo && npm run typecheck`로 클린 재실행.
- **사용자 노출 한글 메시지에 영문 기술용어 금지** (`reload`/`fetch`/`background`/`백그라운드`/`sendMessage` 등). `friendly-error.ts` 패턴 따라 "페이지를 새로고침해 주세요" 같은 일상 한글로. 배지 툴팁(`lastError`), 토스트, 다이얼로그 모두 동일.
- **네이버 SPA의 inline SSR state**(스마트스토어 `window.__PRELOADED_STATE__={...}` 등)는 `/` unicode escape + `:undefined`/`:NaN` JS literal이 박혀있어 raw `JSON.parse` 실패. brace depth counter로 assignment 잘라낸 뒤 `:undefined` → `:null` sanitize 후 parse (`src/content/product-page-scrape.ts` `sliceBalancedBraces`/`sanitizeJsLiterals`). 갤러리/대표 데이터 path는 도메인별 화이트리스트로 박아 noise(로고·배너·추천상품) 제외 — 단순 정규식 추출은 거의 항상 noise 같이 잡힘.
- **`shop-phinf.pstatic.net` raw URL은 응답 사이즈 비일관** (이미지마다 thumbnail 또는 full). ads.naver.com 확장소재 모달(이미지 검증 단축 640px ~ 장축 2000px)에 그대로 업로드 시 일부 거부됨. 페이지 carousel이 쓰는 `?type=o1000` query 강제로 1000×1000 정사각 보장 (`applyStandardSize`). `?type=w1500` 같은 다른 variant는 일부 이미지에서 invalid response 줘 broken image.
- **`chrome.tabs.create({active:false})` hidden tab의 carousel hydration 한계** — lazy slider 다른 슬라이드가 viewport 밖 transform 또는 lazy-load 안 됨. DOM `<img>` scrape만으론 첫 슬라이드 ~4장만 잡힘. SSR JSON inline state(`__PRELOADED_STATE__` 등)에서 path 화이트리스트로 추출이 가장 안정적, DOM scrape는 폴백.
- **CSS `transform` 키프레임 vs JS inline `transform` 위치 충돌** — popover/dropdown이 `style.transform = translate(x,y)`로 위치를 잡는 경우(`period-compare.ts` 등), 진입 애니메이션 keyframe의 `transform`이 그 inline 위치를 덮어 0,0으로 튀는 사고 발생. 진입 모션은 `opacity` only로 가거나 wrapper 분리. 같은 이유로 `@media (prefers-reduced-motion) { transform: none !important }`도 JS 위치 잡는 element엔 적용 금지 — 그 element는 reset에서 제외하고 animation/opacity만 reset.
- **`clip-path: inset(...)`는 box-shadow를 같이 자름** — popover 진입 sweep에 clip-path 쓰면 shadow도 사라짐. shadow 보존해야 하면 `translateY + scale + opacity` 조합으로 대체 (`overlay.css`의 `.dvads-multi-popover` enter 키프레임 참고).
- **DOM 빌드 → attach → paint 3단계 분리** — `popoverEl.querySelector`로 자식 행 찾아 그리는 helper(`paintRow` 등)는 element가 popover에 attach된 *후* 호출해야 함. detached fragment 안에선 querySelector가 silent no-op. 패턴: 모든 row mount → table을 wrap에 attach → 그 다음 paint loop.
- **async render 함수 깜빡임 방지** — 모든 await 데이터 로드 *먼저* 끝낸 뒤 `DocumentFragment`에 빌드 → `wrap.replaceChildren(fragment)`로 atomic swap. `wrap.innerHTML=""` 후 await하면 그 사이 빈 화면 노출. 정렬·뷰 전환처럼 rapid 재트리거 가능한 곳은 추가로 token guard 필요 — `const token = ++renderToken; await ...; if (token !== renderToken) return;` 패턴으로 늦은 호출이 새 호출을 덮지 않게 (`multi-account.ts:renderListView` 참고).
- **Popover click-outside 닫힘 핸들러는 mousedown 시작 위치 추적 필수** — popover 안에서 텍스트 드래그 → 밖에서 mouseup하면 click이 외부로 발화해서 잘못 닫힘. `mousedown` capture로 시작 위치 기록 → popover 내부였으면 다음 click 1번 면제 (`multi-account.ts`, `period-compare.ts` 동일 패턴). 자주 fire-and-forget으로 트리거되는 background 작업(popover open 시 자동 refresh 등)은 in-flight 플래그로 중복 실행 차단.
- **오버레이 다이얼로그(backdrop dim + 중앙 카드) "배경 클릭으로 닫기"는 반드시 `wireBackdropDismiss`(`src/content/dialog-dismiss.ts`) 사용** — 위와 같은 원인. 카드 입력창에서 텍스트 드래그 → backdrop에서 mouseup하면 `click` target이 backdrop이 돼(공통 조상) 단순 `e.target === backdrop` 판정만으론 다이얼로그가 잘못 닫힘. 헬퍼는 mousedown이 backdrop에서 시작한 경우에만 닫고 stopPropagation까지 처리. `openInputDialog`/`openConfirmDialog`/rename·그룹 다이얼로그 모두 이걸 씀. `setup.ts`(mousedown-dismiss)·`asset-bulk-popup.ts`(pointerdown 가드)·대행권 모달은 자체 가드가 이미 있음. **새 다이얼로그는 backdrop dismiss를 직접 구현하지 말 것.**

## gstack

[gstack](https://github.com/garrytan/gstack) 스킬 사용 가능. 업그레이드: `/gstack-upgrade`.
