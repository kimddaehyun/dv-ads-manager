# dv-ads (디브이 애드 매니저)

네이버 광고 대시보드(`ads.naver.com`)에 주입되는 Chrome MV3 확장. 키워드별 **파워링크 예상 입찰가**, **쇼핑검색 순위**, **다른 순위의 예상 입찰가**를 광고 화면 옆에 실시간 표시.

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

- `src/content/index.ts` — `ads.naver.com` 페이지 주입 콘텐츠 스크립트. 광고 키워드 옆 입찰가·순위 오버레이 렌더.
- `src/background/index.ts` — MV3 Service Worker. 검색광고 API(GET_BID_ESTIMATE) fetch 위임.
- `src/popup/` — React 19 팝업 (옵션 진입점)
- `src/options/` — 검색광고 API 자격증명(`customerId`/`accessLicense`/`secretKey`) 입력
- `src/lib/searchad.ts` — 검색광고 API HMAC 서명 + batch fetch + 429 backoff
- `src/lib/volume-cache.ts` + `performance-cache.ts` — 캐시
- `src/lib/friendly-error.ts` — 사용자 친화적 에러 변환
- `manifest.config.ts` — `@crxjs/vite-plugin`이 빌드 시 manifest.json 생성
- F002/F003 쇼핑검색광고는 콘텐츠 스크립트에서 `ads.naver.com` 비공식 internal API 직접 호출 — `/apis/sa/api/adata/admng_exp_keyword` (자동매칭 키워드+통계), `/apis/ad-account/v2/adAccounts/{accountId}` (accountId→customerId 매핑). 상세 schema·인증·payload는 [`docs/PRD.md`](./docs/PRD.md) 와 메모리 `project_spike_b_shopping_endpoints`.

## 디자인 시스템

모든 시각 결정(색·간격·타이포·컴포넌트)의 **단일 진실의 원천**은 [`docs/DESIGN.md`](./docs/DESIGN.md). UI를 작성/수정할 때는 반드시 이 문서를 먼저 확인한다. 핵심:

- **카드 v5 flat** — 보더·그림자 없이 페이지 배경(#fafafa)과 흰 카드(#fff)의 1% 명도차로만 구분.
- **버튼 Vercel strict** — sm 28 / md 32 / lg 40, radius 6px, weight 500, `box-shadow` 절대 금지.
- **버튼 역할** — default(검정 워밍 잉크 #1F1714) 95% 케이스 / **brand(DV 주황 #E6783B) 화면당 단 1개** / secondary(연회색).
- **DV 주황 사용 면적 ~3% 이내** — 로고 + 1차 CTA + F001 "현재 N위 ▾" 배지 + focus ring. 페이지 배경·본문 텍스트·카드 보더·default 버튼 등에는 절대 X.
- **Pretendard 1순위**, 3-weight(400/500/600) 시스템. 700 bold 금지.
- **콘텐츠 오버레이는 `dvads-` prefix로 격리** — `ads.naver.com` 호스트 CSS와 충돌 방지.

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

## gstack

[gstack](https://github.com/garrytan/gstack) 스킬 사용 가능. 업그레이드: `/gstack-upgrade`.
