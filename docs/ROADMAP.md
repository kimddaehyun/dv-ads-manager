# 디브이 애드 매니저 개발 로드맵

네이버 광고관리자(`ads.naver.com`)에 주입되어 키워드별 순위·1~10위 예상 입찰가를 실시간 표시하는 Chrome MV3 확장 — 대행사 AE의 multi-account 운영을 1차 타겟으로 한다.

## 개요

**디브이 애드 매니저**는 네이버 광고를 운영하는 **대행사 AE·인하우스 광고 운영자·셀러**를 위한 Chrome 확장으로 다음 기능을 제공합니다:

- **파워링크 순위·입찰가 오버레이 (F001)**: 키워드 행 옆에 현재 추정 순위 + 1~10위 예상 입찰가 + 팝오버 행 클릭으로 입찰가 자동 변경
- **검색광고 API 자격증명 등록 (F011)**: `customerId` + `accessLicense` + `secretKey` 1쌍 등록 (시장 단위 데이터라 광고주 매칭 불필요)
- **팝업 캐시 관리 (F012)**: 활성 탭 캐시 강제 갱신

> **F002/F003 쇼핑검색광고 보류** (2026-05-19): 광고관리자가 이미 키워드별 ROI/소재별 평균순위·평균CPC 데이터를 제공하고, 우리가 inline으로 옮기는 가치가 F001 수준에 못 미친다고 판단. 카톡 보고 워크플로 분석 결과 AE의 진짜 페인은 "키워드별 1~10위 입찰가 표시"가 아닌 "임계값 기반 자동 분류 + 일괄 액션"으로 확인 → 다음 기능 brainstorming에서 재정의 예정. Spike B 결과(`admng_exp_keyword` endpoint)는 추후 재사용 가능하므로 메모리 `project_spike_b_shopping_endpoints` 그대로 보존.

상세 명세는 [`docs/PRD.md`](./PRD.md) 참조.

## 개발 워크플로우

1. **작업 계획**
   - 기존 코드베이스(특히 `src/lib/*.ts`)를 확인하고 현재 상태 파악
   - 새 작업은 마지막 완료된 Task 다음에 삽입

2. **작업 생성**
   - `/tasks/` 디렉토리에 `XXX-description.md`로 세부 작업 명세 작성 (선택)
   - 고수준 명세, 영향 파일, 수락 기준, 구현 단계 포함
   - API/콘텐츠 스크립트 통합 작업에는 "## 수동 검증 체크리스트" 섹션 필수
     (Chrome 확장은 자동 E2E보다 `chrome://extensions` reload + `ads.naver.com` 실제 페이지 검증이 안정적)

3. **작업 구현**
   - 변경 후 항상 `npm run typecheck` + `npm run build`로 `dist/` 갱신
   - 사용자가 `chrome://extensions` Reload 후 동작 확인
   - 자격증명 등록/미등록 분기를 수동 검증

4. **로드맵 업데이트**
   - 완료된 Task에 `✅ - 완료` 표기, 하위 체크리스트 ✅ 추가
   - Phase 내 모든 Task 완료 시 Phase 제목에도 ✅
   - 진행 상황·최종 업데이트 날짜 갱신 — `/update-roadmap` 커맨드로 자동화 가능

## 개발 단계

### Phase 1: 애플리케이션 골격 구축 ✅

- **Task 001: 진입점 골격 정리 및 메시지 타입 정의** ✅ - 완료 (starter-cleaner)
  - ✅ content/background/popup/options 4개 진입점 골격 정리
  - ✅ `manifest.config.ts` host_permissions + content_scripts `ads.naver.com` 매칭 확인 (이후 라이선스 제거로 3개)
  - ✅ background 메시지 라우터에 `OPEN_OPTIONS` 핸들러 + F001/F002/F003 신규 메시지 자리 주석
  - 신규 메시지 타입(`GET_BID_ESTIMATE`, `GET_PRODUCT_RANK`)의 TypeScript 인터페이스를 `src/types/messages.ts`에 정의 (다음 Task에서)

- **Task 002: 데이터 모델 타입 + storage 헬퍼 골격** ✅ - 완료 (2026-05-14 단일 자격증명 모델로 재정리, 2026-05-15 LicenseState 제거)
  - ✅ PRD §데이터 모델의 캐시 모델(KeywordVolumeCache, ShoppingRankCache, CurrentBidSnapshot) TypeScript 인터페이스 정의 — `src/types/storage.ts`. 자격증명 자체(`SearchadCredentials`)는 `searchad.ts`가 관리하므로 별도 정의 X.
  - ✅ `src/types/messages.ts`에 콘텐츠 ↔ background 메시지 요청/응답 타입 정의 (OPEN_OPTIONS / GET_BID_ESTIMATE / GET_PRODUCT_RANK / REFRESH_ACTIVE_TAB)
  - ✅ `src/lib/storage-keys.ts`에 chrome.storage 키 상수 + 빌더 (`keyForVolumeCache`, `keyForShoppingCache`, `keyForCurrentBid`) + `normalizeKeyword`. 캐시는 키워드 단위 스코프(검색광고 API 응답이 시장 단위 추정치).
  - ✅ `chrome.storage.local` quota 5MB 인지 주석 + 향후 prune 훅 자리 (`PRUNE_HOOK_PLACEHOLDER`)

### Phase 2: UI/UX 완성 (더미 데이터 활용) ✅

- **Task 003: 공통 UI 컴포넌트 + 디자인 토큰 정리** ✅ - 완료
  - Tailwind v4 `@theme` 블록에 색·간격·둥글기 토큰 정리 (브랜드 오렌지 `#E6783B` 포함)
  - 콘텐츠 오버레이·팝업·옵션 공통으로 쓰일 `Badge`, `Card`, `Field`, `Button` React 컴포넌트
  - 콘텐츠 오버레이 격리 정책: 모든 루트 클래스에 `dvads-` prefix, 충분한 `z-index`
  - Pretendard 적용 + `tabular-nums` 숫자 정렬

- **Task 004: 옵션 페이지 UI 완성 (F011 단일 자격증명 폼)** ✅ - 완료 (2026-05-15 라이선스 제거 반영)
  - ✅ `DataDisclosure` 유지 (라이선스 관련 항목은 제거)
  - ✅ F011 placeholder를 `src/options/credentials-ui.tsx`로 교체: customerId·accessLicense·secretKey 3개 입력 + 비밀값 마스킹·가시화 토글
  - ✅ 등록 상태에서는 마스킹된 요약 + 수정·삭제 액션 리스트 노출
  - ✅ 더미 상태로 **3 분기** 렌더 (미등록 / 등록됨 / 등록 실패) — storage 연동은 Task 008
  - ✅ 폼 검증: customerId 숫자 정규식, accessLicense/secretKey non-empty. 실패 시 친화적 에러 메시지

- **Task 005: 팝업 페이지 UI 완성 (F012)** ✅ - 완료 (2026-05-15 라이선스 제거 반영)
  - ✅ "지금 다시 조회" 캐시 강제 갱신 버튼 (default) + "옵션 열기" (secondary/brand 분기)
  - ✅ 더미 상태로 **2 분기** 렌더 (ok / API 미등록)
  - ✅ `PopupView` named export로 데모 페이지 재사용

- **Task 006: 콘텐츠 오버레이 UI 시안 (더미 데이터)** ✅ - 완료 (2026-05-15 라이선스 제거 반영)
  - ✅ `src/styles/overlay.css` — hand-rolled `dvads-*` prefix CSS (호스트 격리, Tailwind 미사용)
  - ✅ F001 `PowerlinkOverlay`: 파워링크 키워드 우측 끝 순위 배지 (`N위 ▾` 1~15 / `순위권 밖 ▾` / `분석 중…`) + 클릭 시 1~10위 미니 테이블 펼침. 2 상태 (ok / no-cred)
  - ✅ F002 `ShoppingGroupOverlay`: 소재 행 토글 + 자동매칭 키워드 × 1~10위 테이블 inline 펼침
  - ✅ F003 `ShoppingDetailOverlay`: 소재 상세 풀패널 + 키워드 검색 input
  - ✅ 셀렉터 미정 단계라 별도 Vite 엔트리 `src/demo/index.html` 작성

### Phase 3: 핵심 기능 구현

- **Task 008: F011 단일 자격증명 옵션 폼 구현 (storage 연동)** ✅ - 완료
  - ✅ `src/lib/searchad.ts`의 기존 `loadCredentials`/`saveCredentials`/`clearCredentials` 그대로 사용 — 단일 객체 모델 유지
  - ✅ Task 004의 더미 자격증명 상태를 실제 storage 연동으로 교체 (`src/options/Options.tsx`)
  - ✅ 입력값 검증: customerId 숫자 문자열, accessLicense·secretKey non-empty
  - 수동 검증: 옵션 페이지에서 자격증명 등록 → 수정 → 삭제 → 빈 상태 안내까지 동작 확인

- ~~**Task 009: F010 라이선스 검증 통합 + 기능 게이트**~~ — **취소** (2026-05-15 라이선스 시스템 제거 결정)

- **Task 010: F001 파워링크 순위·입찰가 오버레이 구현** ✅ - 완료 (2026-05-19)
  - ✅ **Spike C 1차 (2026-05-15)**: 실호출로 API 제약 확인 — `POST /estimate/average-position-bid/keyword`의 `position` 필드는 **1~10만 허용** (11 이상 시 400 `position(N) must be lower than 10`). `MAX_POSITION` 15→10, `RankPosition` 1..10으로 축소
  - ✅ **Spike C 2차 (2026-05-18)**: 정상 응답 schema 확정 — `{device: "PC", estimate: [{key, position, bid}, ...]}`. 50 items/batch = 5 keywords × 10 positions. `extractItemsArray`의 `estimate` 키 매칭으로 parser 정상 동작. defensive fallback은 호환성 안전망으로 유지
  - ✅ `src/lib/searchad.ts`에 `fetchPositionBids(keywords, cred): Promise<PositionBidsItem[]>` 추가
    - 요청 body: `{device: "PC", items: [{key, position 1~10}]}` (5 키워드/배치 = 50 items)
    - 429 backoff·400 swallow 패턴 재사용. HMAC POST 서명
  - ✅ `background/index.ts` `GET_BID_ESTIMATE` 핸들러: `loadCredentials()` → 미등록이면 `has_credential: false`. 등록되어 있으면 `getCachedBids` hit/miss → miss만 `fetchPositionBids` → `putBids`로 캐시 적재. promise reject 안전망 + sendResponse 보장
  - ✅ `volume-cache.ts` 재작성: 키 스킴 `volume_cache:<normalizedKeyword>`, `KeywordVolumeCache` 모델(rank_to_bid), TTL 4시간
  - ✅ `src/content/index.ts`: 셀렉터 `td.ad-cms-table-cell-fix-start span.keyword` + 같은 `<tr>` 내 "N원" 패턴 첫 매치로 현재 입찰가 셀 자동 식별(`findBidCellAndValue`) + 배지 mount + MutationObserver(가상화 행 재마운트·입찰가 변경 감지) + 250ms debounced batched GET_BID_ESTIMATE
  - ✅ 에러 상태 배지: `확장 응답 없음`, `백그라운드 응답 없음`, `API 키 인증 실패`, `예상 입찰가 조회 실패` 등 friendly-error 변환 메시지 노출
  - ✅ 자격증명 미등록 시 배지 "API 키 미등록" → 클릭 시 OPEN_OPTIONS
  - ✅ 가상화 테이블 대응: 행 삽입(`<tr>`) 대신 **floating popover** 사용 (`position: fixed`, 배지 아래 anchored, 화면 우측 보정, outside click·Escape로 닫힘). rAF 루프로 매 프레임 anchor 위치 재계산 → 호스트 중첩 스크롤도 자동 추적
  - ✅ **silent-empty 감지** (2026-05-18): 응답 schema mismatch 등으로 N개 요청 → 0개 응답 시 배지가 "분석 중…"에 영원히 멈추던 버그 패치. `lastError = "응답없음"`으로 가시화
  - ✅ **현재 추정 순위 표시 구현** (2026-05-18): `src/lib/rank.ts`의 `estimateRank(userBid, rankToBid)` — max(N) where market[N] ≤ userBid. 콘텐츠 스크립트는 같은 `<tr>` 내 "N원" 패턴 셀에서 현재 입찰가 파싱 후 배지를 "현재 N위 ▾"(brand) / "순위권 밖 ▾"(warn) / "시세"(fallback)로 분기. popover 테이블의 현재 순위 행만 brand subtle 강조
  - ✅ **성과 추정 통합** (2026-05-18): `POST /estimate/performance-bulk` 호출로 노출/클릭/광고비 3지표를 받아 popover 통합 테이블의 각 순위 행에 표시. `fetchPerformance` (`searchad.ts`) + `performance-cache` 신규 + bid 추정과 병렬 호출(`Promise.all`). 캐시 키 `performance_cache:<keyword>:<bid>` (TTL 4h)
  - ✅ **팝오버 행 클릭 → 입찰가 자동 변경 통합** (2026-05-19, c028c41): 1~10위 행 클릭 시 ① `confirm-dialog.ts` 확정 다이얼로그(키워드·현재가·목표가·차액 표시) → ② `dom-bid.ts` `applyBidToRow`로 페이지 입찰가 셀 자동 조작(React-호환 input setter `setReactInputValue` + "변경" 버튼 click + 셀 갱신 polling) → ③ `toast.ts` 성공 토스트 + 5초 Undo. mount 단위 락(`inflightMounts: WeakSet`)으로 중복 클릭/Undo race 차단. 가상화로 셀이 분리되면 `relocateBidCell`로 키워드 텍스트 재탐색. 페이지가 띄우는 자체 모달("입찰가가 변경되었습니다")은 `watchPageConfirmModal` MutationObserver+rAF로 검출해 우리 팝오버 `.dvads-recede` hide, 토스트는 hide 제외(Undo UX 보존). `suppressPopoverClose` 토큰 카운터로 자동화 중 외부 클릭 리스너 race 차단. ads.naver.com DOM 셀렉터는 모두 `dom-bid.ts`에 격리(향후 클래스명 변경 시 단일 파일 수정)
  - ✅ **키워드 헤더 → 네이버 광고 검색결과 새 탭** (popover 헤더 `<a>`로 `ad.search.naver.com/search.naver?where=ad&query=…` 열기)

- **Task 011: F012 팝업 캐시 갱신 통합** ✅ - 완료 (2026-05-19)
  - ✅ `src/types/messages.ts` `RefreshActiveTabResponse`에 `count`/`error` 필드 보강
  - ✅ `src/background/index.ts` `REFRESH_ACTIVE_TAB` 핸들러: `chrome.tabs.query({active:true, currentWindow:true})` → ads.naver.com 호스트 검증 → `chrome.tabs.sendMessage`로 활성 탭 콘텐츠 스크립트에 forward. background는 forward만, 캐시 무효화는 콘텐츠 스크립트가 자기 mount 상태 보고 결정 (책임 분리)
  - ✅ `src/content/index.ts` `chrome.runtime.onMessage` 리스너 추가 + `handleRefreshActiveTab`: mount된 키워드 dedupe → `invalidateBids` + `invalidatePerformance` 호출(storage) → in-memory `dataCache`/`perfCache`에서 해당 키워드 제거 → `lastError = null` → 모든 배지 즉시 loading 재렌더 → pending debounce 취소 후 `poll()` 강제 호출. **전체 캐시 클리어 X** (ROADMAP 명시 원칙 유지)
  - ✅ `src/popup/App.tsx` "새로고침" 버튼이 실제 동작: `RefreshStatus` discriminated union (idle/loading/ok/error)로 4상태 관리, 결과를 버튼 아래 inline 11px 텍스트로 노출 (ok 2.5s, error 4s 자동 사라짐). 자격증명 미등록 시 버튼 자체 숨김
  - ✅ `host_permissions`만으로 충분 — `activeTab` 추가 불필요 확인
  - 수동 검증: 자격증명 등록 상태에서 ads.naver.com 키워드 페이지 열고 팝업 새로고침 시 (1) 배지가 loading으로 돌아갔다 새 데이터로 갱신 (2) 키워드 0개일 때 안내 메시지 (3) ads.naver.com 아닌 탭에서 친화적 에러

- **Task 011-1: Phase 3 통합 수동 검증**
  - chrome://extensions reload 후 시나리오 검증
    - 자격증명 등록 → 파워링크 오버레이 정상
    - 자격증명 미등록 → 미등록 안내 배지 + 옵션 페이지 링크
    - 광고주 탭 전환 시 오버레이가 정상 재초기화되는지

### Phase 4: 고급 기능 및 최적화

- **Task 012: F002/F003 Spike B — 쇼핑검색광고 데이터 소스 확정** ✅ - 완료 (2026-05-18) · ⏸️ **Plan 결정 무효화 (2026-05-19)** — 아래 Task 013/014 보류 사유 참조. 정찰 결과(`admng_exp_keyword` + `ad-account v2`)는 추후 다른 기능에서 재사용 가능하므로 메모리 `project_spike_b_shopping_endpoints` 보존.
  - ✅ **데이터 소스 정책**: `ads.naver.com` + `api.searchad.naver.com` (광고 데이터 도메인 단일 채널). 셀러 백오피스 미사용. `host_permissions` 추가 0 (현재 2개 유지).
  - ✅ **검색광고 API 공식 sample 정찰** (`naver/searchad-apidoc`): SHOPPING 전용 estimate endpoint 없음 — `IDType` enum = `id`/`keyword` 두 가지뿐. `/estimate/average-position-bid/keyword`는 광고 타입 분기 없는 시장가(파워링크 기준).
  - ✅ **광고관리자 네트워크 트레이스로 비공식 endpoint 2개 확정**:
    - **`POST https://ads.naver.com/apis/sa/api/adata/admng_exp_keyword`** — 광고그룹의 자동매칭 키워드(노출 키워드) + 통계(impCnt/clkCnt/salesAmt) 한 번에 반환. 광고관리자 화면이 쓰는 그 호출. Payload `{domain, cols: {keys: [{columns: [{code: customerId|nccAdgroupId|ymd|expKeyword|...}]}]}}`. 응답 `{total, data: [{nccAdId, expKeyword, impCnt, clkCnt, salesAmt, drtCnto, customerId, nccAdgroupId}, ...]}`. CORS는 `https://ads.naver.com` 만 허용 → **콘텐츠 스크립트에서만 호출 가능**.
    - **`GET https://ads.naver.com/apis/ad-account/v2/adAccounts/{accountId}`** — URL의 accountId 로 customerId 매핑. 응답 `adAccount.masterCustomerId` 가 검색광고 API customerId.
  - ✅ **인증**: 둘 다 광고관리자 로그인 쿠키(NID_AUT, JSESSIONID 등) + `x-xsrf-token` 헤더(XSRF-TOKEN 쿠키 더블 서밋). HMAC 없음. F011 자격증명과 완전 분리 — 광고관리자에 로그인되어 있으면 자동 동작.
  - ✅ **콘텐츠 스크립트 통합 흐름** (메모리 `project_spike_b_shopping_endpoints` 참조):
    1. URL parsing → accountId · nccAdgroupId 추출
    2. `GET /apis/ad-account/v2/adAccounts/{accountId}` → `adAccount.masterCustomerId` = customerId
    3. `POST /apis/sa/api/adata/admng_exp_keyword` → 자동매칭 키워드 목록
    4. background `GET_BID_ESTIMATE` (F001 인프라 재사용) → 키워드별 1~10위 시장가
  - ✅ **Plan 결정**: **Plan B (v0.1 F001·F002·F003 일괄)** 가능. 검색광고 API에 쇼핑 전용 endpoint는 없지만 비공식 admng_exp_keyword가 안정적으로 자동매칭 키워드 + 통계 제공.
  - 🟡 **남은 미세 보강**: `admng_exp_keyword` payload의 모든 columns 정확 목록 (impCnt/clkCnt/salesAmt 등 통계 컬럼) — 본 구현 시 첫 호출 디버깅으로 확정. 차단 요소 아님.
  - ⚠️ **비공식 API 안정성 리스크**: schema/path 예고 없이 변경 가능 → friendly-error로 graceful fallback + console 경고 로깅 필수.

- ~~**Task 013: F002 쇼핑검색광고 그룹 inline 펼침 구현**~~ — **보류** (2026-05-19)
  - **사유**: ① 쇼핑검색광고는 검색광고 API에 전용 estimate endpoint가 없어 "키워드별 1~10위 시장가"가 파워링크 시장가로만 가능(의미 약함). ② 키워드 단위 평균순위는 광고관리자 자체도 제공하지 않음(소재 단위만). ③ 광고관리자 "제외키워드 추가" 모달이 이미 키워드별 노출/클릭/비용/전환율을 정렬·1-클릭 추가까지 제공 — F002 inline 펼침의 가치 ≪ F001의 "행동 단축" 모델.
  - **다음 방향**: AE 광고주 보고 카톡 분석(2026-05-19) 결과 진짜 페인은 "ROI 임계값 기반 자동 분류 + 일괄 입찰 변경" + "키워드 패턴 일괄 처리" + "보고서 자동 생성". 다음 brainstorming에서 새 기능 ID로 재정의 예정.

- ~~**Task 014: F003 쇼핑검색광고 소재 상세 풀 패널 구현**~~ — **보류** (2026-05-19, Task 013 사유 동일)

- **Task 015: 캐시 prune + 웹스토어 심사 준비** 🟡 - 진행 중 (캐시 prune 완료)
  - ✅ **캐시 prune** (2026-05-19): `src/lib/cache-prune.ts` 신규 — 4개 prefix(`volume_cache:` / `performance_cache:` / `shopping_cache:` / `current_bid:`) 스캔해 TTL 4h 만료 항목 일괄 삭제. 메타 키 `__last_prune_at`로 마지막 실행 시각 기록 후 1h 간격 throttle. background `onInstalled`에서 1회 + `GET_BID_ESTIMATE` hot path에서 fire-and-forget `maybePrune()` 호출. 형식 모를 엔트리(타임스탬프 없음)는 안전 보존. `chrome.alarms` 권한 추가 없이 service worker 자연 깨어남 사이클로 처리
  - `manifest.config.ts` icons 16/48/128 크기별 분리 (현재는 동일 icon-128.png 사용)
  - 스토어 등록 자료: 스크린샷 5장, 상세 설명, 개인정보처리방침 링크, 권한 사용 사유
  - `release.yml` 워크플로우 동작 확인 (v태그 → zip 자동 생성)
  - 1차 릴리스 — `package.json` version bump + `git tag v0.1.0`

---

**📅 최종 업데이트**: 2026-05-19
**📊 진행 상황**: Phase 1·2 완료 ✅ + Phase 3 Task 008·010·011 완료 ✅ (Task 011-1 통합 검증 대기) + Phase 4 Task 012 Spike B 완료 ✅ + Task 015 캐시 prune 완료 ✅. F001 파워링크 라인 완성 — 1~10위 시장가 + 현재 순위 + 성과 추정 + **팝오버 행 클릭으로 입찰가 자동 변경(다이얼로그 → 페이지 DOM 자동화 → 5초 Undo 토스트)** 까지. F012 팝업 새로고침이 실제 동작. 캐시 prune 자동화로 5MB quota 보호. **Task 013/014 F002·F003 보류** (2026-05-19) — 광고관리자 자체 UI가 이미 충분히 잘 제공하는 영역이고 우리의 차별화가 약함. AE 카톡 보고 워크플로 분석 결과 다음 방향은 "ROI 임계값 자동 분류 + 일괄 액션" 모델로 재정의 필요. v0.1은 **F001 + F011 + F012만으로 ship** (Plan A 회귀), Task 011-1 통합 검증 + Task 015 잔여(아이콘·스토어 자료·릴리스) 마무리 후 출시.
