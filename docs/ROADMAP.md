# 디브이 애드 매니저 개발 로드맵

네이버 광고관리자(`ads.naver.com`)에 주입되어 키워드별 순위·1~10위 예상 입찰가를 실시간 표시하는 Chrome MV3 확장 — 대행사 AE의 multi-account 운영을 1차 타겟으로 한다.

## 개요

**디브이 애드 매니저**는 네이버 광고를 운영하는 **대행사 AE·인하우스 광고 운영자·셀러**를 위한 Chrome 확장으로 다음 기능을 제공합니다:

- **파워링크 순위·입찰가 오버레이 (F001)**: 키워드 행 옆에 현재 추정 순위 + 1~10위 예상 입찰가
- **쇼핑검색광고 그룹·소재 키워드 표시 (F002/F003)**: 소재의 자동매칭 키워드별 현재 순위·예상 입찰가
- **검색광고 API 자격증명 등록 (F011)**: `customerId` + `accessLicense` + `secretKey` 1쌍 등록 (시장 단위 데이터라 광고주 매칭 불필요)
- **팝업 캐시 관리 (F012)**: 활성 탭 캐시 강제 갱신

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

- **Task 010: F001 파워링크 순위·입찰가 오버레이 구현** 🟡 - 1차 구현 완료 (schema 확정 ✅ + 현재가 셀렉터 보강 대기)
  - ✅ **Spike C 1차 (2026-05-15)**: 실호출로 API 제약 확인 — `POST /estimate/average-position-bid/keyword`의 `position` 필드는 **1~10만 허용** (11 이상 시 400 `position(N) must be lower than 10`). `MAX_POSITION` 15→10, `RankPosition` 1..10으로 축소
  - ✅ **Spike C 2차 (2026-05-18)**: 정상 응답 schema 확정 — `{device: "PC", estimate: [{key, position, bid}, ...]}`. 50 items/batch = 5 keywords × 10 positions. `extractItemsArray`의 `estimate` 키 매칭으로 parser 정상 동작. defensive fallback은 호환성 안전망으로 유지
  - ✅ `src/lib/searchad.ts`에 `fetchPositionBids(keywords, cred): Promise<PositionBidsItem[]>` 추가
    - 요청 body: `{device: "PC", items: [{key, position 1~10}]}` (5 키워드/배치 = 50 items)
    - 429 backoff·400 swallow 패턴 재사용. HMAC POST 서명
  - ✅ `background/index.ts` `GET_BID_ESTIMATE` 핸들러: `loadCredentials()` → 미등록이면 `has_credential: false`. 등록되어 있으면 `getCachedBids` hit/miss → miss만 `fetchPositionBids` → `putBids`로 캐시 적재. promise reject 안전망 + sendResponse 보장
  - ✅ `volume-cache.ts` 재작성: 키 스킴 `volume_cache:<normalizedKeyword>`, `KeywordVolumeCache` 모델(rank_to_bid), TTL 4시간
  - ✅ `src/content/index.ts`: 셀렉터 `td.ad-cms-table-cell-fix-start span.keyword` + `span.label-wrap`에 배지 mount + MutationObserver(가상화 행 재마운트) + 250ms debounced batched GET_BID_ESTIMATE
  - ✅ 에러 상태 배지: `확장 응답 없음`, `백그라운드 응답 없음`, `API 키 인증 실패`, `예상 입찰가 조회 실패` 등 friendly-error 변환 메시지 노출
  - ✅ 자격증명 미등록 시 배지 "API 키 미등록" → 클릭 시 OPEN_OPTIONS
  - ✅ 가상화 테이블 대응: 행 삽입(`<tr>`) 대신 **floating popover** 사용 (`position: fixed`, 배지 아래 anchored, 화면 우측 보정, outside click·Escape로 닫힘)
  - ✅ **silent-empty 감지** (2026-05-18): 응답 schema mismatch 등으로 N개 요청 → 0개 응답 시 배지가 "분석 중…"에 영원히 멈추던 버그 패치. `lastError = "응답 비어있음 (서비스 워커 콘솔 확인)"`로 가시화
  - ✅ **현재 추정 순위 표시 구현** (2026-05-18): `src/lib/rank.ts`의 `estimateRank(userBid, rankToBid)` — max(N) where market[N] ≤ userBid. 콘텐츠 스크립트는 같은 `<tr>` 내 "N원" 패턴 셀에서 현재 입찰가 파싱 후 배지를 "N위"(brand) / "순위권 밖"(warn) / "시세"(fallback)로 분기. popover 헤더에 "내 입찰가 N원 → 추정 R위" + 해당 행만 brand subtle 강조
  - ✅ **성과 추정 통합** (2026-05-18): `POST /estimate/performance-bulk` 호출로 현재 입찰가 기준 노출수/클릭수/평균CPC/광고비 4지표 받아 popover 하단 카드에 표시. `fetchPerformance` (`searchad.ts`) + `performance-cache` 신규 + bid 추정과 병렬 호출(`Promise.all`). 캐시 키 `performance_cache:<keyword>:<bid>` (TTL 4h). 80 키워드 = 1 배치 (배치 한도 200 items)

- **Task 011: F012 팝업 캐시 갱신 통합**
  - `chrome.tabs.query({active:true, currentWindow:true})` → 활성 탭 확인 (host_permissions만으로 충분한지 1일차 확인, 불가 시 `"activeTab"` 추가)
  - "지금 다시 조회": 활성 탭에 해당하는 키워드 캐시 만료 + 콘텐츠 스크립트에 재조회 트리거 메시지 전송 (전체 캐시 클리어 X)
  - 수동 검증: 자격증명 등록 상태에서 캐시 갱신이 활성 탭에 정상 전달되는지

- **Task 011-1: Phase 3 통합 수동 검증**
  - chrome://extensions reload 후 시나리오 검증
    - 자격증명 등록 → 파워링크 오버레이 정상
    - 자격증명 미등록 → 미등록 안내 배지 + 옵션 페이지 링크
    - 광고주 탭 전환 시 오버레이가 정상 재초기화되는지

### Phase 4: 고급 기능 및 최적화

- **Task 012: F002/F003 Spike B — 쇼핑검색광고 데이터 소스 확정** ✅ - 완료 (2026-05-18)
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

- **Task 013: F002 쇼핑검색광고 그룹 inline 펼침 구현** *(Plan B 선택 시)*
  - 콘텐츠 스크립트: 쇼핑 그룹 페이지 셀렉터 + 소재 행 옆 토글 버튼 주입 (다중 동시 펼침)
  - 펼침 시 자동매칭 키워드 × 1~10위 예상 입찰가 테이블 렌더
  - `shopping_cache:<product_id>:<keyword>` 캐시
  - 미노출 키워드는 "미노출" 명시
  - 수동 검증: 그룹 안 소재 3~5개 동시 펼침 + 토글 동작

- **Task 014: F003 쇼핑검색광고 소재 상세 풀 패널 구현** *(Plan B 선택 시)*
  - 소재 단독 상세 페이지에 풀 패널 주입
  - 컬럼 정렬, 빠른 키워드 검색 박스
  - 캐시 시각 표기 + 수동 새로고침 버튼
  - 그룹 뷰 ↔ 소재 상세 전환 시 캐시 재사용

- **Task 015: 캐시 prune + 웹스토어 심사 준비**
  - `volume-cache.ts`·`shopping-cache.ts`에 LRU 또는 TTL prune 추가 (5MB quota 보호)
  - `manifest.config.ts` icons 16/48/128 크기별 분리 (현재는 동일 icon-128.png 사용)
  - 스토어 등록 자료: 스크린샷 5장, 상세 설명, 개인정보처리방침 링크, 권한 사용 사유
  - `release.yml` 워크플로우 동작 확인 (v태그 → zip 자동 생성)
  - 1차 릴리스 — `package.json` version bump + `git tag v0.1.0`

---

**📅 최종 업데이트**: 2026-05-18
**📊 진행 상황**: Phase 1·2 완료 ✅ + Phase 3 Task 008·010 완료 ✅ (Task 011·011-1 대기) + Phase 4 Task 012 Spike B 완료 ✅. F002/F003 데이터 소스 확정 — `ads.naver.com` 비공식 internal endpoint `admng_exp_keyword`(자동매칭 키워드+통계) + `ad-account v2`(accountId→customerId 매핑) 채택. 광고관리자 쿠키 인증, host_permissions 추가 0. 본 구현(Task 013/014) 진입 가능.
