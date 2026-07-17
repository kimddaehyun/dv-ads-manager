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

`v*` 태그를 push 하면 `.github/workflows/release.yml`이 `npm run package`를 실행해 zip을 GitHub Release에 첨부한다. `package.json`의 `version`을 먼저 올리고 동일 버전으로 태그: `git tag v0.0.X && git push --tags`. zip 파일명 패턴을 바꾸면 `release.yml`의 `files:` 글롭과 `scripts/zip-dist.mjs`의 outFile 패턴도 동기화.

## 코드 지도 — 기능별 CLAUDE.md

**기능 폴더마다 CLAUDE.md가 있다. 그 폴더의 파일을 만지면 반드시 그 폴더의 CLAUDE.md를 따른다.** 이 루트 문서에는 전 기능 공통 사항만 남긴다.

- `src/features/bid/` — F001 파워링크 입찰 오버레이. **콘텐츠 스크립트 진입점**(`index.ts`, 다른 기능 init도 여기서 호출) + `dom-bid.ts`(페이지 DOM 셀렉터 격리) + 캐시.
- `src/features/asset-bulk/` — F-AssetBulk 확장소재 일괄 등록 + 상품 페이지 이미지 스크레이퍼.
- `src/features/period-compare/` — F-PoP 전후 비교. MAIN-world fetch 캡처(`fetch-patch-main.ts`, 진입점).
- `src/features/multi-account/` — F-MultiAccount 다계정 대시보드. `authFetch`(cross-account)가 여기 있고 report/setup/change-watch가 가져다 쓴다.
- `src/features/change-watch/` — F-ChangeWatch 변경이력 모니터링 알림.
- `src/features/setup/` — F-Setup 세팅안 엑셀.
- `src/features/report/` — F-Report 리포트 엑셀 (+ `scripts/test-report-*.ts` node 테스트). `collectReportData()`(수집만, 엑셀 제외)는 F-Brief와 공유 — 병렬 구조 변경 금지(성능 감사 2026-07-02).
- `src/features/brief/` — F-Brief 광고주 보고 문구(AX 1호). `collectReportData` 재사용 → 규칙 엔진(`brief-rules.ts`, vitest) 후보 추출 → AI(Supabase Edge Function `brief-compose` + Gemini)가 문장만 조립. **AI는 분석가가 아니라 번역기** — 3겹: ①요약은 AI 미경유 ②체크된 facts만 전송 ③숫자 검산(`brief-verify.ts`). AI 판단 문단은 좌측 3px 주황 선. 표는 캡처가 아니라 canvas 생성(`brief-table.ts`). 목표 ROAS는 `MultiAccountUserMeta.targetRoas`(미설정 시 분류 비활성, 자동 추정 안 함). 서버 인증은 로그인 세션(JWT) + `approved` 확인(F-Accounts, 이용 코드 방식 폐기), `@supabase/supabase-js` 미사용.
- `src/shared/` — 공용 UI(toast·다이얼로그·dropdown)와 searchad API 클라이언트. **오버레이 UI(팝오버·다이얼로그·표)를 만들거나 고칠 땐 `src/shared/CLAUDE.md`의 UI 패턴 절 필독.**
- `src/background/` — MV3 Service Worker (API fetch 위임, 이미지 binary fetch). `src/popup/`·`src/options/` — React 진입점. `src/types/` — 공용 타입. `manifest.config.ts` — 빌드 시 manifest 생성 (콘텐츠 스크립트 3개 등록).

## 디자인 시스템

모든 시각 결정(색·간격·타이포·컴포넌트)의 단일 진실의 원천은 [`docs/DESIGN.md`](./docs/DESIGN.md) — UI 작성/수정 전 필수 확인. 핵심: Primary는 항상 DV 주황 `#E6783B`(화면당 1~2개, 사용 면적 ~3% 이내), 버튼 radius 8px/height 32px, Pretendard 3-weight, 오버레이는 `dvads-` prefix 격리, em dash(`—`)/minus(`−`) 금지 — 하이픈 `-`만. 새 패턴은 코드에 즉흥 도입하지 말고 DESIGN.md 먼저 갱신.

## 공통 Gotchas

- **`host_permissions` 핵심은 광고 2곳 — `ads.naver.com`, `api.searchad.naver.com`.** 그 외는 이미지 binary fetch처럼 불가피한 경우에만 (pstatic CDN은 CORS 차단이라 background fetch 필수). **늘릴수록 Chrome 심사 사유 요구이니 최소화** — 새 도메인 추가 전 정말 불가피한지 검토.
- `ads.naver.com` 비공식 internal API(`/apis/sa/api/*`, `/apis/ad-account/v2/*` 등)는 CORS상 **콘텐츠 스크립트에서만 호출 가능** (background는 차단). 인증은 로그인 쿠키 + `x-xsrf-token` 헤더(`XSRF-TOKEN` 쿠키 더블 서밋, `decodeURIComponent` 필요). schema·path 예고 없이 변경 가능 — `friendly-error`로 graceful fallback 필수. 페이지 fetch는 사용자 탭 컨텍스트에서 실행이 안전(anti-bot 회피).
- **cross-account의 silver bullet = `x-ad-customer-id: {masterCustomerId}` 헤더.** `/apis/sa/api/*`는 URL에 계정이 없어도 이 헤더 기준으로 응답. 헤더 없으면 세션 활성 계정 기준 → 404 또는 (stats는) **200+빈 data(silent-empty)**. `masterCustomerId`는 `GET /apis/ad-account/v2/adAccounts/{adAccountNo}` 응답의 `adAccount.masterCustomerId` — 광고관리자 URL의 `adAccountNo`는 검색광고 API `customerId`와 별개다. bizmoney만 예외로 URL-aware(`/apis/bmgate/...`). 새 internal API 도입 시 SPA가 이 헤더를 보내는지 정찰 권장.
- **SA stats endpoint** — `POST /apis/sa/api/stats`, body `{fields, timeIncrement:"allDays", timeRange:{since,until}, ids:"id1,id2,..."}` (`ids`는 쉼표 문자열 — chunk 80개 등으로 나눠 합산). `*Micros`는 ÷1,000,000=원. 6지표: `impCnt`/`clkCnt`/`cpc`/`salesAmtMicros`(=광고비, **매출 아님**)/`purchaseConvAmtMicros`(구매완료 전환매출)/`purchaseCcnt`(구매완료 전환수).
- **광고관리자 SPA URL 패턴**: `/manage/ad-accounts/{adAccountNo}/sa/campaigns-by/{TYPE}` (TYPE=`WEB_SITE`/`SHOPPING_NS`/`BRAND`/`POWER_CONTENTS`/`PLACE`), `/manage/ad-accounts/{adAccountNo}/sa/adgroups/{adgroupId}`.
- internal API 응답 검증/디버깅은 Playwright MCP `browser_evaluate` 페이지 컨텍스트 fetch로 — 확장 미로드여도 라이브 응답 확인 가능.
- `chrome.storage.local`은 확장별 격리 — 다른 확장의 자격증명을 못 읽으므로 사용자가 본 확장 옵션에 별도 입력. **광고 데이터는 네이버와 사내 서버(Supabase Edge Function) 외로 나가지 않는다** — F-Brief AI 조립 시 AE가 체크한 facts만 전송, 서버 저장·로깅 없음(2026-07-16 개정, PRD 데이터 모델 참조).
- 버전은 `package.json`의 `version`이 단일 소스 — `manifest.config.ts`에서 자동 import.
- **`tsc -b` incremental cache에 stale 에러가 남을 수 있음** — `rm -f tsconfig.*.tsbuildinfo && npm run typecheck`로 클린 재실행.
- **사용자 노출 한글 메시지에 영문 기술용어 금지** (`reload`/`fetch`/`background` 등). `friendly-error.ts` 패턴 따라 일상 한글로. 배지 툴팁·토스트·다이얼로그 모두 동일.
- **F-Accounts 전면 잠금**: 로그인(`approved`) 없으면 전 기능 잠금. 가입 즉시 사용 가능(기본 approved, 2026-07-17 개정) — 관리자는 사후 차단만. 게이트는 `src/shared/auth-gate.ts`의 `requireApproved()`가 콘텐츠 스크립트 진입점에서 단일 관문(미승인이면 콘텐츠 스크립트 자체를 미주입, 팝업/옵션은 안내만). 상세는 `src/shared/CLAUDE.md`.
- **Supabase 프로젝트 사용 시작** (`gvyvrjncpwmcwycebrhf`, dvcompany): 4개 테이블(profiles/credentials/account_meta/account_groups) 전부 **서버가 원본, 로컬(`chrome.storage.local`)은 캐시** — 쓰기는 서버 먼저, 성공 시에만 로컬 갱신. RLS는 본인 행 + `approved` 상태 필수.
- **Secret Key(검색광고 API)는 평문 DB 저장 금지** — 반드시 Edge Function `credentials-vault` 경유로 AES-GCM 암호화 후 저장(`src/shared/vault.ts`). 서비스 워커에는 `window`가 없어 vault 관련 모듈은 그 컨텍스트에서 동적 import조차 하지 않는다.
- **anon 키는 공개해도 안전** — RLS가 실제 방어선이라 확장 코드(`src/shared/supabase.ts`)에 하드코딩해도 문제 없다.
- **`@supabase/supabase-js`를 background(service worker) 번들에 정적 import 금지** — 번들 크기 오염 + 서비스 워커에 `window` 없어 일부 API 동작 안 함. 필요하면 동적 import로.

## CLAUDE.md 관리

- **CLAUDE.md 배치 규칙**: 특정 기능에만 해당하는 내용은 그 기능 폴더의 CLAUDE.md에, 2개 이상 기능에 걸치는 UI/API 패턴은 `src/shared/CLAUDE.md`에, 전 기능 공통(권한·인증·릴리스)만 이 루트에 쓴다. 새 기능은 `src/features/<이름>/` 폴더 + CLAUDE.md로 시작한다.
- **세션 시작 알림**: `.claude/scripts/md-health-check.sh`(SessionStart hook)가 비대해진 CLAUDE.md(80줄 초과)나 7일 경과를 감지해 알림을 준다. 알림을 받으면 **본작업을 먼저 끝낸 뒤** 지목된 파일만 `/claude-md-improver`로 정리하고 `date +%s > .claude/.md-cleanup-stamp`로 타임스탬프를 갱신한다.
- 굵직한 작업(기능 추가·구조 변경·gotcha 발견)을 마친 세션 끝에는 사용자에게 `/revise-claude-md` 실행을 제안해 그날 배운 것을 해당 폴더 CLAUDE.md에 반영한다.

## gstack

[gstack](https://github.com/garrytan/gstack) 스킬 사용 가능. 업그레이드: `/gstack-upgrade`.
