/**
 * 디브이 애드 매니저 — chrome.storage.local 키 상수와 빌더.
 *
 * 본 확장은 서버 DB 없이 chrome.storage.local에 라이선스·자격증명·캐시를 보관한다.
 * quota는 약 5MB — 광고주 N × 키워드 M × rank_to_bid 누적 시 prune 필요 (MVP 이후 백로그).
 *
 * naver-tag-picker와 공유되지 않는 본 repo 전용 키만 정의. 코어 라이브러리가 직접
 * 관리하는 키(예: `searchad.ts`의 `searchadCredentials` 구 단일 키, `license.ts`의
 * license 관련 키, `volume-cache.ts`의 평면 `volumeCache`)는 각 모듈에 그대로 둔다 —
 * 코어 동기화 정책(CLAUDE.md "코어 코드 변경 정책").
 *
 * F011 마이그레이션: 본 repo는 신규 키 `searchad_credentials`(배열)를 사용하되,
 * `searchad.ts`의 어댑터 함수가 구 키 `searchadCredentials`를 1회 변환 후 삭제.
 */

/** F011 — 자격증명 다중 관리(배열). 본 repo 전용 */
export const SEARCHAD_CREDENTIALS_KEY = "searchad_credentials";

/** F001 — 키워드별 1~10위 예상 입찰가 캐시 키 prefix */
export const VOLUME_CACHE_PREFIX = "volume_cache:";

/** F002/F003 — 쇼핑 키워드별 순위 캐시 키 prefix */
export const SHOPPING_CACHE_PREFIX = "shopping_cache:";

/** F001 — 현재 입찰가 스냅샷 키 prefix */
export const CURRENT_BID_PREFIX = "current_bid:";

/**
 * 키워드 정규화 — chrome.storage 키와 캐시 룩업의 일관성을 위해 호출자가 사용.
 *
 * - 공백 제거: 검색광고 API의 hintKeywords 제약(공백 X)과 일치
 * - NFC: 한글 자모 분해/조합형 차이 흡수
 * - lowercase: 영문 케이스 차이 흡수
 */
export const normalizeKeyword = (raw: string): string =>
  raw.normalize("NFC").replace(/\s+/g, "").toLowerCase();

/** F001 캐시 키 빌더 — `volume_cache:<customer_id>:<keyword>` */
export const keyForVolumeCache = (
  customerId: string,
  keyword: string,
): string => `${VOLUME_CACHE_PREFIX}${customerId}:${normalizeKeyword(keyword)}`;

/** F002/F003 캐시 키 빌더 — `shopping_cache:<product_id>:<keyword>` */
export const keyForShoppingCache = (
  productId: string,
  keyword: string,
): string => `${SHOPPING_CACHE_PREFIX}${productId}:${normalizeKeyword(keyword)}`;

/** F001 현재 입찰가 스냅샷 키 빌더 — `current_bid:<customer_id>:<keyword>` */
export const keyForCurrentBid = (
  customerId: string,
  keyword: string,
): string => `${CURRENT_BID_PREFIX}${customerId}:${normalizeKeyword(keyword)}`;

/**
 * TODO (MVP 이후 백로그): chrome.storage.local quota prune 정책.
 *
 * 5MB 한계 근접 시 VOLUME_CACHE_PREFIX·SHOPPING_CACHE_PREFIX·CURRENT_BID_PREFIX의
 * 키를 fetched_at/read_at 기준 LRU 또는 TTL prune. background.alarms로 주기 실행.
 *
 * 본 함수는 자리만 표시 — 실제 구현은 ROADMAP Task 015.
 */
export const PRUNE_HOOK_PLACEHOLDER = true;
