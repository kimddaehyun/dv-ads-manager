/**
 * F001 — 키워드 × 입찰가 × 디바이스 → 예상 성과(노출/클릭/CPC/광고비) 캐시.
 *
 * 데이터 소스: `POST /estimate/performance-bulk` (네이버 검색광고 API).
 * 응답은 (keyword, bid, device) 조합에 대한 성과 추정 — 셋이 같으면 결과 동일하므로
 * 캐시 키에 셋 모두 포함한다.
 *
 * 키 스킴: `performance_cache:<device>:<normalizedKeyword>:<bid>` (`storage-keys.ts`).
 * TTL 4시간 — `volume-cache`와 동일 (시장 변동성 보수적 가정).
 */

import { keyForPerformanceCache, PERFORMANCE_CACHE_PREFIX, normalizeKeyword } from "@/shared/storage-keys";
import type { KeywordPerformanceCache } from "@/types/storage";
import type { AdDevice } from "@/types/device";

const TTL_MS = 4 * 60 * 60 * 1000;

export interface PerfQuery {
  keyword: string;
  bid: number;
}

export async function getCachedPerformance(
  queries: PerfQuery[],
  device: AdDevice,
): Promise<{ hit: Map<string, KeywordPerformanceCache>; miss: PerfQuery[] }> {
  // 쿼리별 정규화 storage 키를 1회만 계산해 조회 루프에서 재사용 (keyFor* 내부 NFC 정규화 중복 제거).
  const pairs = queries.map((q) => [q, keyForPerformanceCache(q.keyword, q.bid, device)] as const);
  const stored = await chrome.storage.local.get(pairs.map(([, k]) => k));
  const hit = new Map<string, KeywordPerformanceCache>();
  const miss: PerfQuery[] = [];
  const now = Date.now();
  for (const [q, k] of pairs) {
    const entry = stored[k] as KeywordPerformanceCache | undefined;
    if (entry && now - new Date(entry.fetched_at).getTime() < TTL_MS) {
      hit.set(cacheKey(q.keyword, q.bid, device), entry);
    } else {
      miss.push(q);
    }
  }
  return { hit, miss };
}

export async function putPerformance(
  entries: KeywordPerformanceCache[],
): Promise<void> {
  const payload: Record<string, KeywordPerformanceCache> = {};
  for (const e of entries) {
    payload[keyForPerformanceCache(e.keyword, e.bid, e.device)] = e;
  }
  if (Object.keys(payload).length === 0) return;
  await chrome.storage.local.set(payload);
}

/**
 * 키워드 단위 무효화 — 모든 (디바이스, bid) 변형을 일괄 제거.
 *
 * 키 형식이 `performance_cache:<device>:<normalizedKeyword>:<bid>` 이므로 storage 전체
 * 스캔으로 키워드 매칭. 호출 빈도가 낮은 경로(F012 새로고침)라 비용 허용.
 */
export async function invalidatePerformance(keywords: string[]): Promise<void> {
  if (keywords.length === 0) return;
  const all = await chrome.storage.local.get(null);
  const normalized = new Set(keywords.map(normalizeKeyword));
  const toRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(PERFORMANCE_CACHE_PREFIX)) continue;
    // performance_cache:<device>:<normalizedKeyword>:<bid>
    const rest = key.slice(PERFORMANCE_CACHE_PREFIX.length);
    const firstColon = rest.indexOf(":");
    const lastColon = rest.lastIndexOf(":");
    if (firstColon < 0 || lastColon <= firstColon) continue;
    const kw = rest.slice(firstColon + 1, lastColon);
    if (normalized.has(kw)) toRemove.push(key);
  }
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
}

/** in-memory 룩업용 — storage 키와 다른 인메모리 식별자. device 포함. */
export const cacheKey = (keyword: string, bid: number, device: AdDevice): string =>
  `${device}:${keyword}:${bid}`;
