# 디브이 애드 매니저 개발 로드맵

네이버 광고관리자(`ads.naver.com`)에 주입되어 키워드별 순위·1~15위 예상 입찰가를 실시간 표시하는 Chrome MV3 확장 — 대행사 AE의 multi-account 운영을 1차 타겟으로 한다.

## 개요

**디브이 애드 매니저**는 네이버 광고를 운영하는 **대행사 AE·인하우스 광고 운영자·셀러**를 위한 Chrome 확장으로 다음 기능을 제공합니다:

- **파워링크 순위·입찰가 오버레이 (F001)**: 키워드 행 옆에 현재 추정 순위 + 1~15위 예상 입찰가
- **쇼핑검색광고 그룹·소재 키워드 표시 (F002/F003)**: 소재의 자동매칭 키워드별 현재 순위·예상 입찰가
- **검색광고 API 자격증명 등록 (F011)**: `customerId` + `accessLicense` + `secretKey` 1쌍 등록 (시장 단위 데이터라 광고주 매칭 불필요)
- **라이선스·캐시 관리 (F010/F012)**: Supabase RPC 라이선스 검증, 활성 탭 캐시 강제 갱신

상세 명세는 [`docs/PRD.md`](./PRD.md) 참조.

## 개발 워크플로우

1. **작업 계획**
   - 기존 코드베이스(특히 `src/lib/*.ts` 공유 코어)를 확인하고 현재 상태 파악
   - `naver-tag-picker`와 공유되는 코어 파일은 양쪽 동기화 정책 준수 (CLAUDE.md "코어 코드 변경 정책")
   - 새 작업은 마지막 완료된 Task 다음에 삽입

2. **작업 생성**
   - `/tasks/` 디렉토리에 `XXX-description.md`로 세부 작업 명세 작성 (선택)
   - 고수준 명세, 영향 파일, 수락 기준, 구현 단계 포함
   - API/콘텐츠 스크립트 통합 작업에는 "## 수동 검증 체크리스트" 섹션 필수
     (Chrome 확장은 자동 E2E보다 `chrome://extensions` reload + `ads.naver.com` 실제 페이지 검증이 안정적)

3. **작업 구현**
   - 변경 후 항상 `npm run typecheck` + `npm run build`로 `dist/` 갱신
   - 사용자가 `chrome://extensions` Reload 후 동작 확인
   - 라이선스 활성/비활성, 자격증명 등록/미등록 분기를 수동 검증

4. **로드맵 업데이트**
   - 완료된 Task에 `✅ - 완료` 표기, 하위 체크리스트 ✅ 추가
   - Phase 내 모든 Task 완료 시 Phase 제목에도 ✅
   - 진행 상황·최종 업데이트 날짜 갱신 — `/update-roadmap` 커맨드로 자동화 가능

## 개발 단계

### Phase 1: 애플리케이션 골격 구축 ✅

- **Task 001: 진입점 골격 정리 및 메시지 타입 정의** ✅ - 완료 (starter-cleaner)
  - ✅ content/background/popup/options 4개 진입점 골격 정리
  - ✅ `manifest.config.ts` host_permissions 4개 + content_scripts `ads.naver.com` 매칭 확인
  - ✅ background 메시지 라우터에 `OPEN_OPTIONS` 핸들러 + F001/F002/F003 신규 메시지 자리 주석
  - 신규 메시지 타입(`GET_BID_ESTIMATE`, `GET_PRODUCT_RANK`)의 TypeScript 인터페이스를 `src/types/messages.ts`에 정의 (다음 Task에서)

- **Task 002: 데이터 모델 타입 + storage 헬퍼 골격** ✅ - 완료 (2026-05-14 단일 자격증명 모델로 재정리)
  - ✅ PRD §데이터 모델의 4개 캐시·라이선스 모델(LicenseState, KeywordVolumeCache, ShoppingRankCache, CurrentBidSnapshot) TypeScript 인터페이스 정의 — `src/types/storage.ts`. 자격증명 자체(`SearchadCredentials`)는 코어 라이브러리 `searchad.ts`가 관리하므로 별도 정의 X.
  - ✅ `src/types/messages.ts`에 콘텐츠 ↔ background 메시지 요청/응답 타입 정의 (OPEN_OPTIONS / GET_BID_ESTIMATE / GET_PRODUCT_RANK / REFRESH_ACTIVE_TAB)
  - ✅ `src/lib/storage-keys.ts`에 chrome.storage 키 상수 + 빌더 (`keyForVolumeCache`, `keyForShoppingCache`, `keyForCurrentBid`) + `normalizeKeyword`. 캐시는 키워드 단위 스코프(검색광고 API 응답이 시장 단위 추정치).
  - ✅ `chrome.storage.local` quota 5MB 인지 주석 + 향후 prune 훅 자리 (`PRUNE_HOOK_PLACEHOLDER`)

### Phase 2: UI/UX 완성 (더미 데이터 활용)

- **Task 003: 공통 UI 컴포넌트 + 디자인 토큰 정리**
  - Tailwind v4 `@theme` 블록에 색·간격·둥글기 토큰 정리 (브랜드 오렌지 `#E6783B` 포함)
  - 콘텐츠 오버레이·팝업·옵션 공통으로 쓰일 `Badge`, `Card`, `Field`, `Button` React 컴포넌트
  - 콘텐츠 오버레이 격리 정책: 모든 루트 클래스에 `dvads-` prefix, 충분한 `z-index`
  - Pretendard 적용 + `tabular-nums` 숫자 정렬

- **Task 004: 옵션 페이지 UI 완성 (F011 단일 자격증명 폼)**
  - 기존 `LicenseUi` (F010)·`DataDisclosure` 유지
  - F011 placeholder를 실제 UI로 교체: customerId·accessLicense·secretKey 3개 입력 + 비밀값 마스킹·가시화 토글
  - 등록 상태에서는 마스킹된 요약 + 수정·삭제 버튼 노출 (수정은 폼을 다시 열어 덮어쓰기)
  - 더미 상태로 미등록·등록 두 분기 렌더 (storage 연동은 Task 008)
  - 검증/저장 실패 시 친화적 에러 메시지(`friendly-error.ts`) 적용

- **Task 005: 팝업 페이지 UI 완성 (F012)**
  - 라이선스 상태 카드: tier(베이직)·만료일·검증 시각
  - "지금 다시 조회" 캐시 강제 갱신 버튼
  - 라이선스 미설정·자격증명 미등록 시 "옵션 열기" CTA
  - 더미 상태로 두 분기(활성/비활성) 렌더

- **Task 006: 콘텐츠 오버레이 UI 시안 (더미 데이터)**
  - 파워링크 키워드 옆 배지(현재 순위) + 펼침 표(1~15위 예상 입찰가) (F001 시안)
  - 쇼핑 그룹 뷰 소재 행 inline 펼침 토글 + 키워드 × 1~15위 테이블 (F002 시안)
  - 쇼핑 소재 상세 풀 패널(정렬·검색 가능) (F003 시안)
  - 자격증명 미등록·라이선스 미검증 안내 배지
  - 셀렉터 미정 단계라 별도 `demo-page/index.html`을 만들고 거기에 시안 렌더링 (npm run dev에서 접근)

### Phase 3: 핵심 기능 구현

- **Task 008: F011 단일 자격증명 옵션 폼 구현 (storage 연동)**
  - `src/lib/searchad.ts`의 기존 `loadCredentials`/`saveCredentials`/`clearCredentials` 그대로 사용 — 단일 객체 모델 유지 (코어 동기화)
  - Task 004의 더미 자격증명 상태를 실제 storage 연동으로 교체
  - 입력값 검증: customerId 숫자 문자열, accessLicense·secretKey non-empty
  - 수동 검증: 옵션 페이지에서 자격증명 등록 → 수정 → 삭제 → 빈 상태 안내까지 동작 확인

- **Task 009: F010 라이선스 검증 통합 + 기능 게이트**
  - 기존 `license.ts`·`LicenseUi`는 그대로 사용 (코어 동기화)
  - 라이선스 미검증/만료 시 콘텐츠 오버레이·팝업·옵션 자격증명 폼이 잠금 상태 표시
  - 5분 TTL 캐시 동작 확인 (옵션 페이지 새로고침 시 즉시 RPC 재호출되지 않는지)
  - 베이직 tier 단일 등급 — `LicenseTier = "basic" | "brand"`의 `brand`는 자매 호환 필드로 코드에 두고 UI에서는 basic만 활성 표시

- **Task 010: F001 파워링크 순위·입찰가 오버레이 구현**
  - **Spike C (1일차)**: 한 번의 실호출로 `POST /estimate/average-position-bid/keyword` 응답 schema 확정 → `RawPositionBidItem` 타입 정의
  - `src/lib/searchad.ts`에 `fetchPositionBids(keywords: string[], cred): Promise<{keyword, rank_to_bid}[]>` 신설
    - 요청 body: `{device: "PC", items: [{key, position: 1}, ..., {key, position: 15}]}` (1페이지 커버. Spike C에서 단일 호출 max 확정 후 `MAX_POSITION` 상수 조정)
    - 429 backoff·400 swallow 기존 패턴 재사용
  - `background/index.ts`에 `GET_BID_ESTIMATE` 메시지 핸들러: `loadCredentials()` → 자격증명 존재 시 `fetchPositionBids` 호출 → 캐시 적재. 미등록이면 `has_credential: false` 응답
  - `volume-cache.ts` 키 스킴: `volume_cache:<keyword>` (구 키 일괄 폐기 또는 TTL 만료 대기)
  - 콘텐츠 스크립트: 파워링크 키워드 테이블 셀렉터 + GET_BID_ESTIMATE 호출 + 행 옆 배지·펼침 렌더
  - 자격증명 미등록 시 "검색광고 API 자격증명 미등록" 안내 배지 + 옵션 페이지 바로가기
  - 수동 검증: ads.naver.com 광고주 페이지에서 키워드 추가/수정/삭제 시 오버레이 자동 갱신, 429/401/네트워크 에러 시 친화적 메시지

- **Task 011: F012 팝업 캐시 갱신 통합**
  - `chrome.tabs.query({active:true, currentWindow:true})` → 활성 탭 확인 (host_permissions만으로 충분한지 1일차 확인, 불가 시 `"activeTab"` 추가)
  - "지금 다시 조회": 활성 탭에 해당하는 키워드 캐시 만료 + 콘텐츠 스크립트에 재조회 트리거 메시지 전송 (전체 캐시 클리어 X)
  - 수동 검증: 라이선스 활성 + 자격증명 등록 상태에서 캐시 갱신이 활성 탭에 정상 전달되는지

- **Task 011-1: Phase 3 통합 수동 검증**
  - chrome://extensions reload 후 시나리오 검증
    - 라이선스 미설정 → 옵션 페이지 안내 + 오버레이 잠금
    - 라이선스 활성 + 자격증명 등록 → 파워링크 오버레이 정상
    - 라이선스 활성 + 자격증명 미등록 → 미등록 안내 배지 + 옵션 페이지 링크
    - 광고주 탭 전환 시 오버레이가 정상 재초기화되는지
  - naver-tag-picker 측 호환 확인 (코어 lib `searchad.ts`에 본 repo가 추가한 함수가 그쪽 빌드를 깨지 않는지)

### Phase 4: 고급 기능 및 최적화

- **Task 012: F002/F003 Spike B — 쇼핑검색광고 데이터 소스 확정**
  - 후보 비교:
    - 검색광고 API의 쇼핑 영역 endpoint 존재 여부 (공식 문서 정독)
    - `ads.naver.com` 페이지 DOM에서 자동매칭 키워드 추출 + `search.shopping.naver.com` 재조회
    - 내부 XHR 재호출 (host page 비공식 API 가로채기)
  - 채택 안에 따라 자격증명 필요 여부 정의 (검색광고 API면 F011 자격증명 재사용, DOM/쿠키 기반이면 자격증명 무관)
  - `host_permissions` 5번째 추가 필요 여부 결정
  - 산출물: 채택 endpoint·인증 방식·캐시 키 스킴·에러 분기. Plan A(v0.2 분리) / Plan B(v0.1 일괄) 최종 결정
  - 예상 기간: 3-7d

- **Task 013: F002 쇼핑검색광고 그룹 inline 펼침 구현** *(Plan B 선택 시)*
  - 콘텐츠 스크립트: 쇼핑 그룹 페이지 셀렉터 + 소재 행 옆 토글 버튼 주입 (다중 동시 펼침)
  - 펼침 시 자동매칭 키워드 × 1~15위 예상 입찰가 테이블 렌더
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

**📅 최종 업데이트**: 2026-05-14
**📊 진행 상황**: Phase 1 완료 ✅ (2/13 Tasks 완료, 단일 자격증명 모델 적용으로 Task 007 제거)
