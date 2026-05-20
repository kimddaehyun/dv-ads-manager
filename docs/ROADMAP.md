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

### Phase 3: 핵심 기능 구현 ✅

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

- **Task 011-1: Phase 3 통합 수동 검증** ✅ - 완료 (2026-05-20)
  - ✅ 자격증명 등록 → 파워링크 오버레이 정상 (배지 분석 중 → 현재 순위 → popover 1~10위 + 성과 추정 + 행 클릭 입찰가 자동 변경 + 5초 Undo)
  - ✅ 자격증명 미등록 → "API 키 미등록" 배지 + 클릭 시 옵션 페이지 열림
  - ✅ 광고주 탭 전환 시 SPA 라우팅 후 오버레이 새 키워드 행에 재마운트, 이전 광고주 잔존 없음

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

- **Task 016: F001 PC/모바일 디바이스 분리 (PC default + 모바일 lazy 토글)** ✅ - 완료 (2026-05-19)
  - ✅ `src/types/device.ts` 신규: `AdDevice = "PC" | "MOBILE"`, **`DEFAULT_DEVICE = "PC"`** (초안은 MOBILE이었으나 사용자 피드백으로 PC로 전환 — 배지 "10위+" 라벨이 MOBILE 5위 상한과 안 맞고, PC가 캐시 hit이라 popover 첫 표시가 즉시)
  - ✅ 캐시 키 스킴 갱신: `volume_cache:<device>:<keyword>`, `performance_cache:<device>:<keyword>:<bid>` — `storage-keys.ts`의 `keyForVolumeCache(keyword, device)`/`keyForPerformanceCache(keyword, bid, device)` 시그니처에 device 추가. `KeywordVolumeCache`/`KeywordPerformanceCache` 타입에 `device` 필드 필수화
  - ✅ `searchad.ts` `fetchPositionBids`/`fetchPerformance`의 `device: "PC"` 하드코딩 제거 → `device: AdDevice` 파라미터로 외부에서 주입. POST body에 그대로 전달
  - ✅ `volume-cache.ts`/`performance-cache.ts` get/put에 device 인자 추가. `invalidate*`는 새 키 형식(`<prefix>:<device>:<keyword>[:<bid>]`)에서 device를 건너뛰고 키워드 매칭으로 storage 전체 스캔
  - ✅ `messages.ts` `GetBidEstimateRequest.device: AdDevice` 필수 필드 추가, `GetBidEstimateResponse.device` echo. background `handleGetBidEstimate`가 device 전파
  - ✅ `content/index.ts`: in-memory `dataCache`/`perfCache` 키에 device 포함, `poll()`은 항상 `DEFAULT_DEVICE`(PC) 기준 호출. popover 헤더에 `[PC | 모바일]` segmented control(`buildPopoverBody`)을 X 닫기 버튼 자리에 마운트(X 버튼 제거, 닫기는 외부 클릭/ESC/배지 재클릭으로). 면책 푸터는 기존 "모든 예상 실적은 과거 데이터를 기반으로 예측한 값입니다. (30일 기준 데이터)" 유지
  - ✅ **모바일 lazy fetch + race guard**: `selectDevice(target)` — cache hit 즉시 re-render, miss면 `.dvads-popover-loading` skeleton + 1회 `GET_BID_ESTIMATE { device: "MOBILE" }` 호출. 응답 도착 시 popover가 같은 mount + 같은 device 상태일 때만 re-render(빠른 토글 연타 race 방지). `inflightDevice` 토큰. **inflightDevice null 처리는 re-render 전에** 해야 새 토글에 `.is-loading` 클래스 잔존 X
  - ✅ `overlay.css` `.dvads-device-toggle`/`.dvads-device-seg`/`.dvads-popover-loading` 추가. **DV 주황 안 씀** — 보조 UI는 중성 회색(`#F3F4F6` 트랙 + 흰 카드 선택), 주황 면적 ~3% 규칙 보존
  - ✅ **MOBILE position 1~5 cap fix**: `MAX_POSITION_BY_DEVICE = { PC: 10, MOBILE: 5 }` (`types/storage.ts`) — Naver `/estimate/position-bid` API가 device별로 상한 다름(PC 10 / MOBILE 5). batch에 cap 초과 position 1개라도 섞이면 400 거부 → silent-empty → "응답없음" 배지. `callPositionBid` + `handleGetBidEstimate` perf query + `buildPopoverBody` 행 수에 모두 적용. **MOBILE은 1~5위만 렌더**
  - ✅ **popover 위치 jitter freeze**: device 토글로 표 크기 바뀔 때 popover 위치가 흔들리는 jitter 차단 — togglePopover에서 popover 열릴 때 첫 PC 높이를 `openPopoverFlipHeight`로 측정·고정. reposition rAF의 flip(아래→위) 결정은 freeze된 값으로, 실제 위치는 pr.height로 (위로 flip 시 bottom 엣지 안정성)
  - ✅ **사용자 노출 에러 메시지 한글화**: 배지 ⚠ 툴팁 3개를 영문 기술용어 없이 다듬음. "확장 응답 없음 (reload 후 페이지 새로고침 필요)" → "확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요". "백그라운드 응답 없음" / "응답없음"도 동일 톤
  - ✅ **popover UX 애니메이션 3종**: ① 첫 열기 entrance(`.dvads-popover-content-enter` — opacity + translateY(-4px) 220ms `cubic-bezier(0.16,1,0.3,1)`) ② 닫기 fade-out 120ms ③ device 토글 시 crossfade + height morph(`animatePopoverBody`) — 옛 wrap을 `position:absolute`로 띄워 새 wrap이 같은 자리에 normal flow로 들어가게 + opacity 1→0 / 0→1, popover container는 height 200ms morph. **race guard**: `bodyAnimToken` — 토글 + lazy fetch 응답이 ~200ms 간격으로 연달아 와도 옛 cleanup이 새 transition을 끊지 않고, 매 호출이 popover의 *모든* 기존 children을 swap-out 처리해 누적 wrap 방지
  - ✅ **다른 키워드 배지 1클릭 전환**: togglePopover가 다른 mount 클릭 시 `closePopoverImmediate()`(fade-out 생략)로 옛 popover 즉시 제거 후 새 popover 마운트. fade-out 140ms 동안 두 popover 겹침 race 차단. 추가 안전망 2겹: (1) 새 popover 만들기 직전 `document.querySelectorAll(".dvads-popover").remove()` (2) reposition rAF에서 매 프레임 잔존 popover 강제 정리
  - ✅ **CSS `overflow:hidden` + `position:relative` 보존 필수**: crossfade의 swap-out absolute wrap이 popover 박스 밖으로 튀어나가 "두 popover처럼" 보이는 시각 버그 방지. 린터가 되돌릴 수 있어 코멘트로 의도 명시
  - ✅ **캐시 마이그레이션**: 기존 device 없는 키는 새 빌드에서 자동 cache miss → 다음 fetch 때 새 키로 자연 재구축. 별도 마이그레이션 코드 불필요(TTL 4h 만료 후 prune이 청소)
  - ✅ **수동 검증 완료** (2026-05-20): chrome reload + ads.naver.com hard refresh 후 (1) PC↔모바일 토글 시 popover 위치·크기 jitter 없음 (2) 모바일 토글 시 로딩 스피너가 응답 후 정상 종료 (3) 다른 키워드 배지 1클릭 전환 시 옛 popover 즉시 사라짐

- **Task 018: F-PoP — 데이터 비교 popover (Period-over-Period)** ✅ - 완료 (2026-05-20, SA·전체 캠페인·대시보드·GFA에서 정상 동작 확인)
  - ✅ **6개 매체 페이지 우측 상단 날짜 picker 옆 아이콘 버튼 주입** (`period-compare.ts`): bar chart 비교 아이콘(32×32 정사각, hover 시 DV 주황). 클릭 시 popover. 매체 사전 식별 없이 날짜 picker가 발견되는 광고관리자 페이지면 어디든 mount. SPA 라우팅 대응 MutationObserver
  - ✅ **MAIN-world fetch/XHR 가로채기 패턴** (`fetch-patch-main.ts` 기존): 페이지가 호출하는 stats fetch를 우리가 직접 정찰 없이 가로채 학습 → 같은 endpoint를 직전 동일 기간 날짜로 1회 replay. `CustomEvent("dvads:fetch-capture")` 채널, response는 `JSON.stringify` 후 string으로 전달(구조화 클론 안전)
  - ✅ **stats 응답 인식: URL 패턴 → shape 기반** (`isStatsLikeCapture`): 매체별 endpoint path 추정 대신 응답 안 `impCnt`·`clkCnt`·`cost`·`cpc`·`ctr` 같은 stats hint key 2개 이상이면 stats로 판정. 매체 사전 정찰 불필요, 캠페인 리스트처럼 row별 stats도 자동 cover
  - ✅ **다중 capture 보관 + 사용자 선택 날짜 매칭 필터** (`recentCaptures` array + `pickBestCapture`): 같은 페이지에서 lifetime range fetch(2024-05-19 등)·paginated `/campaigns/search`·account-level `/reports/overview` 동시 호출되는 케이스 cover. URL/body에 사용자 picker 시작·종료 날짜가 모두 포함된 capture 중 impressions 최대치 선택 → lifetime/sub-period fetch 자동 배제
  - ✅ **6지표 정규화 어댑터** (`period-compare-adapters.ts`): impressions·clicks·CTR·CPC·cost·revenue·conversions·ROAS. 응답 키 별칭 (`impCnt`/`impCount`/`impressionCount`, `salesAmtMicros`/`grossCostMicros`/`sales`(GFA), `averageCpcMicros`, `purchasedConversionsValueMicros`/`convSalesKRW`(GFA), `convCount` 등) + `*Micros` 접미사 자동 /1,000,000원 정규화
  - ✅ **깊이 walk 집계** (`deepFindStatsNode` + `shallowMergedStats`): 임의 nested 구조에서도 stats 노드 발견. 두 패턴 cover — ① 객체 자체가 stats 노드(직접 + 1단계 nested 머지로 `row.metrics.{...}` 같은 구조 포함) ② `{id: statsRow|null}` 객체 맵(GFA `campaignStats` 패턴 — campaign value들을 합산, `conversion` 안쪽 데이터까지 1단계 머지로 포함). 두 패턴 중 stats hint key가 더 많은 쪽 채택
  - ✅ **비율 지표 base totals 재계산**: CTR·CPC·ROAS는 응답 직접 값을 신뢰하지 않고 항상 `clicks/impressions`·`cost/clicks`·`revenue/cost`에서 재계산. day별 row 합산 시 비율도 합산되어 잘못 표시되던 버그 cover (예: 7일치 CTR row 합 = 8.27% → 실제 1.18%로 정정)
  - ✅ **날짜 picker DOM 감지** (`findDateRangeContainer`): 텍스트 walker로 헤더 내 `YYYY.MM.DD.` 패턴 2개 인접 노드의 LCA가 picker container. 매체별 셀렉터 사전 정찰 불필요
  - ✅ **직전 기간 날짜 shift** (`shiftDateParams`): 현재 기간 길이만큼 backward 이동. URL 쿼리·body JSON 안의 모든 string에서 4가지 포맷(`YYYY-MM-DD`/`.`/`/`/없음) 매칭 + 치환. 어떤 키 이름(`startDate`/`from`/`period.start` 등)을 쓰든 무관 동작
  - ✅ **UI/UX 완성**: ① popover 헤더 `데이터 비교` + 우측 X ② 기간 줄 "이전 기간 ~ 종료 → 선택 기간 ~ 종료 (N일)" 즉시 렌더(fetch 무관) ③ 8지표 통합 테이블 4컬럼(지표 / 이전 기간 / 선택 기간 / 증감) ④ 로딩 중 shimmer 스켈레톤 셀(레이아웃 점프 없음) ⑤ 빈값 통일 0/0원/0.0% ⑥ 한국 주식 컨벤션 증감 색(상승=빨강 / 하강=파랑) + 1자리 소수 ⑦ 이전 기간 0 → 선택 N(>0)은 분수 ∞라 "-" 표기 통일. popover 너비 520px로 수억 원대 숫자 cover
  - ✅ **DEBUG_CAPTURE 로그**: `STATS KEEP/skip-empty` + 추출된 metrics + 응답 sample 1500자 출력(콘솔). 매체별 응답 schema 분석/별칭 추가 시 사용
  - ✅ **`DEBUG_CAPTURE` flag false 전환** (2026-05-20): `src/content/period-compare.ts:37` — 매체별 응답 schema 분석/별칭 추가 시 일시 true 전환 가능하도록 flag 자체는 보존 (`if (DEBUG_CAPTURE)` 가드로 console 출력 차단)
  - 🔵 **출시 후 보강 후보 (corner case)**: ① GFA 페이지가 사용자 picker 8일 대신 weekly bucket 7일로 stats를 fetch하면 부분 매치만 되어 replay 범위 어긋남 (capture URL의 실제 날짜를 "current"로 정정하는 로직 필요) ② GFA 일부 페이지는 paginated 10개 campaign stats만 부르고 account-level 집계는 없음 → 표가 top 10 합계만 표시. 일반 사용 케이스 정상 동작 확인되어 v0.1 ship 차단 요소 아님

- **Task 017: F-AssetBulk v1 — 파워링크 확장소재 일괄 등록** ✅ - 완료 (2026-05-20)
  - ✅ **드롭다운 li 주입**: ads.naver.com 광고그룹의 확장소재 탭에서 "+ 새 확장 소재 ▾" 드롭다운 끝에 "일괄 등록" 항목을 portal MutationObserver로 주입. URL 분기 없이 메뉴 mount 시점에 자연 격리(다른 탭에서는 메뉴 자체가 안 뜸)
  - ✅ **native DOM popup** (`asset-bulk-popup.ts`): 파워링크 이미지(파일/URL 모드 토글, 슬롯 ≤8) + 추가제목(슬롯 ≤8, 슬롯별 노출 위치 dropdown `[모든 위치 / 위치 1만 / 위치 2만]`) + 추가설명(슬롯 ≤1). dvads-confirm-card 베이스 + 자동화 중 visibility hidden으로 페이지 모달 가운데 표시 양보
  - ✅ **DOM 자동화** (`dom-asset.ts`): "+ 새 확장 소재" 트리거 + 종류별 li click → 페이지 모달 mount 대기(`waitFor`) → input 채움(`setReactInputValue` 재사용) → 추가제목은 노출 위치 dropdown 선택(default "all"이면 no-op, "p1"/"p2"이면 트리거 click + 라벨 매칭 li click) → 저장 enabled 대기 → click → 모달 unmount 대기. 이미지는 한 모달에서 multiple files `DataTransfer`로 한 번에 업로드, 추가제목/추가설명은 각 모달 N회 사이클
  - ✅ **이미지 URL → File**: content script 컨텍스트에서 `fetch(url, {mode:"cors"})` → blob → File. CORS 차단 호스트는 결과 토스트에 실패로 노출(V2 background fetch fallback 예정)
  - ✅ **중복 사전 안내** (`scanExistingAssets`): popup 열 때 페이지 확장소재 테이블(`tr.ad-cms-table-row[data-row-key]`)에서 유형 셀("추가제목"/"추가설명") + 첫 `.extension-dot` 텍스트 추출. 사용자 입력값이 일치하면 슬롯에 빨간 보더 + "이미 등록됨 - 자동 skip" 메시지. 일괄 등록 시 중복 항목은 큐에 안 넣고 시작 토스트에 "중복 N건 skip" 표시
  - ✅ **submit click race fix** (`waitForModalClosedRetry`): 첫·마지막 모달에서 페이지가 우리 click을 무시하는 race 보고됨. 모달 mount 후 80ms 양보 + 1차 800ms 대기 → 안 닫히면 input 재commit + click 1회 재시도 → 2차 대기
  - ✅ **드롭다운 깜빡임 fix**: 사이클 사이 finally의 `closeOpenMenu` trigger click이 메뉴를 토글로 다시 여는 부작용. li click이 메뉴를 자연 close하므로 finally cleanup 제거 + `closeOpenMenu`는 ESC dispatch만 사용. orchestrator 끝에서 한 번만 명시적 호출
  - ✅ **재검증 완료** (2026-05-20): 중복 슬롯 실시간 경고 + 자동 skip + 드롭다운 깜빡임 종료 확인
  - 🟡 **V2 후보** (메모리 `project_f_assetbulk_v1` 참조): 상세페이지 URL 입력 → og:image / 상품 갤러리 자동 파싱 → 이미지 슬롯 N개 자동 채우기. background fetch fallback으로 CORS 차단 URL 지원

- **Task 019: F-MultiAccount — 다계정 대시보드** 🟢 - v1 구현 완료 (2026-05-20, Phase 0~2 + 1차 빌드)
  - ✅ **Phase 0 Spike** (2026-05-20): ads.naver.com 광고관리자 페이지에서 fetch/XHR 캡처 스크립트로 정찰. 4종 endpoint·응답 schema 확정 → 메모리 `project_f_multiaccount_endpoints` 보존
    - 광고계정 명단: `GET /apis/ad-account/v1.1/adAccounts/access?size&page&sort` (페이지네이션, content[].adAccount.{no,name,adPlatformType,masterCustomerId})
    - 비즈머니 잔액: `GET /apis/sa/api/bizmoney/account` → `refundableAmt + nonRefundableAmt` (URL에 ID 없음 = SPA 활성 계정 컨텍스트)
    - 계약 정보: `GET /apis/sa/api/ncc/time-contracts/after-current-summaries?nccAdgroupIds=쉼표분리` → currentTimeContract.{contractName, contractEndDt, campaignTp:"BRAND_SEARCH", contractStatus}
    - Stats: `POST /apis/sa/api/stats` body `{fields, timeIncrement:"allDays", timeRange, ids:"cmp-...,..."}` → data[].{impCnt,clkCnt,cpc,salesAmtMicros,purchaseConvAmtMicros,purchaseCcnt} (Micros÷1M)
  - ✅ **결정**: 비즈머니/계약이 SPA 활성 계정 의존 → 다른 계정 데이터는 **background tab 위임** (`chrome.tabs.create({active:false})` → tabs.sendMessage → tabs.remove, 동시 2개 cap). `manifest.config.ts`에 `"tabs"` permission 추가. 메모리 `project_f_multiaccount_cross_account_decision` 참조
  - ✅ **PRD §8 단일 자격증명 모델과 충돌 없음**: 본 기능은 광고관리자 로그인 쿠키 기반, SearchadCredentials와 별개 인증 채널. 계정 명단은 자동 fetch (수동 등록 불필요), 사용자는 옵션 페이지에서 별칭/즐겨찾기/숨김만 편집
  - ✅ **Phase 1 — Storage 모델 + 옵션 UI**: `src/types/storage.ts`에 MultiAccountDirectoryEntry/MultiAccountDirectoryCache/MultiAccountUserMeta/MultiAccountSnapshot 추가. `src/lib/multi-account-storage.ts` 신설(디렉터리·사용자 메타·스냅샷 CRUD + 10분 TTL stale check). `src/options/multi-account-ui.tsx` 신설 — 행마다 ☆즐겨찾기 토글·별칭 인라인 편집·숨김 토글·마지막 접속 시각. "명단 다시 받기" 버튼이 광고관리자 탭에 sendMessage로 갱신 위임
  - ✅ **Phase 2 — 콘텐츠 스크립트 + 데이터 수집**: `src/lib/multi-account-data.ts` 신설(`fetchAllDirectory`·`fetchBizMoney`·`fetchCampaignIds`·`fetchAdgroupIdsByCampaignTp`·`fetchYesterdayStats`·`fetchContracts`·`collectActiveAccount`·`yesterdayKST`). `src/content/multi-account.ts` 신설 — `/manage/ad-accounts/` URL에서 우상단 fixed 버튼(`dvads-multi-btn`) 주입, 클릭 시 `dvads-multi-popover` 표시. 활성 계정은 직접 fetch(background tab 우회), 다른 계정은 `MULTI_ACCOUNT_COLLECT_ACCOUNT` 메시지 → background hidden tab. `src/background/index.ts`에 핸들러 추가(`collectViaHiddenTab` + onUpdated complete 대기 + 15초 timeout + 동시 2개 cap). `src/styles/overlay.css`에 dvads-multi-* 클래스 + D-5 빨강(`text:#DC2626`) 추가
  - ✅ **D-5 빨강 + 만료 회색**: `computeMinDday(contracts)` 최소 D-day 계산. ≤ 0 "계약 만료" 회색, ≤ 5 "⚠ D-N 계약 종료 임박" 빨강, > 5 "D-N" 보통 색. 계약 없으면 미렌더(공간 미점유). 추가 계약 등록은 캐시 무효화(10분 후 자연 갱신 또는 옵션 페이지 "명단 다시 받기")로 빨강 해제
  - ✅ **빌드 통과** (2026-05-20): `npm run typecheck` + `npm run build` 통과. `dist/` 갱신 완료
  - 🟡 **다음 단계 (사용자 수동 QA)**: ① dist 로드 후 광고관리자 진입 시 우상단 "계정" 버튼 노출 확인 ② 버튼 클릭 시 popover에 명단·어제 데이터·비즈머니·계약 표시 확인 ③ 행 클릭으로 다른 계정 페이지 전환 확인 ④ 옵션 페이지 "광고계정 명단" 섹션에서 별칭 편집/즐겨찾기/숨김 동작 확인 ⑤ D-5 빨강 표시 확인 (브랜드검색 계약 종료 임박 계정이 있을 때)
  - 🔵 **V2 후보**: ① 행 드래그로 순서 변경 ② 검색/필터 입력 ③ 광고비 일간/주간 토글 ④ 비즈머니 잔액 임계값 알림 ⑤ 다른 광고그룹 타입(POWER_CONTENTS_BRANDING 등) 계약도 표시

- **Task 015: 캐시 prune + 웹스토어 심사 준비** 🟡 - 진행 중 (캐시 prune 완료)
  - ✅ **캐시 prune** (2026-05-19): `src/lib/cache-prune.ts` 신규 — 4개 prefix(`volume_cache:` / `performance_cache:` / `shopping_cache:` / `current_bid:`) 스캔해 TTL 4h 만료 항목 일괄 삭제. 메타 키 `__last_prune_at`로 마지막 실행 시각 기록 후 1h 간격 throttle. background `onInstalled`에서 1회 + `GET_BID_ESTIMATE` hot path에서 fire-and-forget `maybePrune()` 호출. 형식 모를 엔트리(타임스탬프 없음)는 안전 보존. `chrome.alarms` 권한 추가 없이 service worker 자연 깨어남 사이클로 처리
  - `manifest.config.ts` icons 16/48/128 크기별 분리 (현재는 동일 icon-128.png 사용)
  - 스토어 등록 자료: 스크린샷 5장, 상세 설명, 개인정보처리방침 링크, 권한 사용 사유
  - `release.yml` 워크플로우 동작 확인 (v태그 → zip 자동 생성)
  - 1차 릴리스 — `package.json` version bump + `git tag v0.1.0`

---

**📅 최종 업데이트**: 2026-05-20
**📊 진행 상황**: Phase 1·2·3 완료 ✅ + Phase 4 Task 012 Spike B 완료 ✅ + Task 015 캐시 prune 완료 ✅ + Task 016 device 토글 완료 ✅ + Task 017 F-AssetBulk v1 완료 ✅ + Task 018 F-PoP 데이터 비교 popover 완료 ✅ (DEBUG_CAPTURE flag off). 남은 작업은 Task 015 잔여(아이콘 분리·스토어 자료·v0.1.0 릴리스)만. F001 파워링크 라인 완성 — 1~10위 시장가 + 현재 순위 + 성과 추정 + **팝오버 행 클릭으로 입찰가 자동 변경(다이얼로그 → 페이지 DOM 자동화 → 5초 Undo 토스트)** + **PC/모바일 디바이스 토글(PC default + 모바일 lazy, MOBILE 1~5위 cap 보강, crossfade·height morph 애니메이션, 1-click 키워드 전환, 한글 친화 에러 메시지)** 까지. F012 팝업 새로고침이 실제 동작. 캐시 prune 자동화로 5MB quota 보호. F-AssetBulk로 확장소재 일괄 등록(이미지·추가제목·추가설명 + 노출 위치 슬롯별 지정 + 중복 사전 안내) 추가. F-PoP로 6개 매체 페이지 데이터 비교 popover(8지표·shape 기반 자동 캡처·날짜 매칭 필터·깊이 walk 집계) 추가. **Task 013/014 F002·F003 보류** (2026-05-19). v0.1은 **F001 + F011 + F012 + F-AssetBulk + F-PoP**로 ship, Task 011-1 통합 검증 + Task 015 잔여(아이콘·스토어 자료·릴리스) 마무리 후 출시.

**다음 세션 작업:**
- Task 019 F-MultiAccount — 수동 QA 완료 후 corner case 보강 (실제 사용 시 발견되는 endpoint schema 차이·시간 측정·UI 조정)
- Task 015 잔여 — 아이콘 분리 (16/48/128), 스토어 자료(스크린샷 5장·상세 설명·개인정보처리방침·권한 사유), v0.1.0 릴리스
- (출시 후 후보) Task 018 GFA weekly bucket 매치 / paginated stats 보강
