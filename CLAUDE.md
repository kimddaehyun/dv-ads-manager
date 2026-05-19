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
- `src/content/asset-bulk.ts` + `asset-bulk-popup.ts` + `dom-asset.ts` — F-AssetBulk 파워링크 확장소재 일괄 등록. "+ 새 확장 소재" 드롭다운에 "일괄 등록" li 주입 → native DOM 팝업으로 이미지/추가제목/추가설명 입력 → 페이지 모달 자동화로 순차 등록. 확장소재 페이지 DOM 셀렉터는 `dom-asset.ts`에 격리.
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
- ~~F002/F003 쇼핑검색광고~~ — ⏸️ 보류 (2026-05-19). Spike B 정찰 결과(`admng_exp_keyword` + `ad-account v2`)는 메모리 `project_spike_b_shopping_endpoints`에 보존 — 추후 다른 기능에서 재사용 가능. 보류 사유는 `docs/ROADMAP.md` Task 013/014 항목 참조.

## 디자인 시스템

모든 시각 결정(색·간격·타이포·컴포넌트)의 **단일 진실의 원천**은 [`docs/DESIGN.md`](./docs/DESIGN.md). UI를 작성/수정할 때는 반드시 이 문서를 먼저 확인한다. 핵심:

- **카드** — 옵션/팝업은 `rounded-2xl + shadow-card` (보더 없음). 오버레이는 호스트 페이지와 시각 분리를 위해 `1.5px #E6783B` 보더 + 10px radius.
- **버튼** — radius 8px, weight 500, height 32px (오버레이 공통 `.dvads-btn`). **Primary는 항상 DV 주황 `#E6783B`** (검정 default 패턴은 폐기, DESIGN.md Decisions Log 2026-05-18). 화면당 primary 1~2개 제한.
- **DV 주황 사용 면적 ~3% 이내** — primary 버튼 + F001 "현재 N위 ▾" 배지 + focus ring + 다이얼로그 차액(+) 강조. 페이지 배경·본문 텍스트·카드 보더 등에는 X.
- **Pretendard 1순위**, 3-weight(400/500/600) 시스템. 700 bold는 옵션 페이지 h1에만.
- **콘텐츠 오버레이는 `dvads-` prefix로 격리** — `ads.naver.com` 호스트 CSS와 충돌 방지.
- **em dash(`—`) / minus sign(`−` U+2212) 금지** — 모든 짝대기는 일반 하이픈 `-` (U+002D)만 사용. 음수 표시(`(-230)`)도 동일.

새 패턴이 필요하면 코드에 즉흥 도입하지 말고 `docs/DESIGN.md`를 먼저 갱신한 뒤 반영.

## Gotchas

- **`host_permissions`는 정확히 2개만 — `ads.naver.com`, `api.searchad.naver.com`.** 늘리면 Chrome 심사에서 사유 요구. 모든 데이터는 **광고 도메인 두 곳** 안에서만 — 검색광고 API + 광고관리자 internal API. 셀러 센터(`sell.smartstore.naver.com`) 등 비광고 도메인은 부적합.
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
- **`/estimate/average-position-bid/keyword` position 상한은 device별로 다름** — PC 1~10, **MOBILE 1~5만 허용** (400 `position(N) must be lower than 5`). batch에 cap 초과 1개라도 섞이면 전체 400 거부 → silent-empty → "응답없음" 배지. `MAX_POSITION_BY_DEVICE` 상수(`src/types/storage.ts`)로 가드. 다른 estimate endpoint도 device-specific 제약 가능성 — 새 device 호출 도입 시 raw 응답 1회 검증 필수.
- **배지 ⚠ "응답없음" 디버깅 1순위 = SW Console raw 로그** (`[searchad] ... raw response` 또는 `API 4xx`). silent-empty = "응답은 받았는데 데이터 0개" 상태. spike 로그는 모듈당 1회만 찍히니 확장 reload 후 재호출하면 다시 찍힘. 400 에러 메시지의 `fields:` 가 결정적 단서.
- **`tsc -b` incremental cache(`.tsbuildinfo`)에 stale 에러가 남을 수 있음** — `rm -f tsconfig.*.tsbuildinfo && npm run typecheck`로 클린 재실행.
- **사용자 노출 한글 메시지에 영문 기술용어 금지** (`reload`/`fetch`/`background`/`백그라운드`/`sendMessage` 등). `friendly-error.ts` 패턴 따라 "페이지를 새로고침해 주세요" 같은 일상 한글로. 배지 툴팁(`lastError`), 토스트, 다이얼로그 모두 동일.

## gstack

[gstack](https://github.com/garrytan/gstack) 스킬 사용 가능. 업그레이드: `/gstack-upgrade`.
