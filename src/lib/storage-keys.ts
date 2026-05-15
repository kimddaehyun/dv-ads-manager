/**
 * 디브이 애드 매니저 — chrome.storage.local 키 상수와 빌더.
 *
 * 본 확장은 서버 DB 없이 chrome.storage.local에 라이선스·자격증명·캐시를 보관한다.
 * quota는 약 5MB — 키워드 누적 시 prune 필요 (MVP 이후 백로그).
 *
 * 자격증명 자체의 키(`searchadCredentials`)는 `src/lib/searchad.ts`가 직접 관리하므로
 * 여기에 정의하지 않는다.
 *
 * 본 확장은 단일 자격증명 모델을 사용한다. 검색광고 API의 입찰가/볼륨 응답은 시장 단위
 * 추정치 — 호출자 customerId와 무관하게 동일하므로 캐시 키를 광고주별로 스코프할 필요가 없다.
 */

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

/** F001 캐시 키 빌더 — `volume_cache:<keyword>` */
export const keyForVolumeCache = (keyword: string): string =>
  `${VOLUME_CACHE_PREFIX}${normalizeKeyword(keyword)}`;

/** F002/F003 캐시 키 빌더 — `shopping_cache:<product_id>:<keyword>` */
export const keyForShoppingCache = (
  productId: string,
  keyword: string,
): string => `${SHOPPING_CACHE_PREFIX}${productId}:${normalizeKeyword(keyword)}`;

/** F001 현재 입찰가 스냅샷 키 빌더 — `current_bid:<keyword>` */
export const keyForCurrentBid = (keyword: string): string =>
  `${CURRENT_BID_PREFIX}${normalizeKeyword(keyword)}`;

/**
 * TODO (MVP 이후 백로그): chrome.storage.local quota prune 정책.
 *
 * 5MB 한계 근접 시 VOLUME_CACHE_PREFIX·SHOPPING_CACHE_PREFIX·CURRENT_BID_PREFIX의
 * 키를 fetched_at/read_at 기준 LRU 또는 TTL prune. background.alarms로 주기 실행.
 *
 * 본 함수는 자리만 표시 — 실제 구현은 ROADMAP Task 015.
 */
export const PRUNE_HOOK_PLACEHOLDER = true;
