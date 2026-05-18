/**
 * F001 — 키워드 × 입찰가 → 예상 성과(노출/클릭/CPC/광고비) 캐시.
 *
 * 데이터 소스: `POST /estimate/performance-bulk` (네이버 검색광고 API).
 * 응답은 키워드와 bid 조합에 대한 성과 추정 — bid가 같으면 결과 동일하므로
 * 캐시 키에 (keyword, bid) 양쪽을 포함한다.
 *
 * 키 스킴: `performance_cache:<normalizedKeyword>:<bid>` (`storage-keys.ts`).
 * TTL 4시간 — `volume-cache`와 동일 (시장 변동성 보수적 가정).
 */

import { keyForPerformanceCache } from "./storage-keys";
import type { KeywordPerformanceCache } from "@/types/storage";

const TTL_MS = 4 * 60 * 60 * 1000;

export interface PerfQuery {
  keyword: string;
  bid: number;
}

export async function getCachedPerformance(
  queries: PerfQuery[],
): Promise<{ hit: Map<string, KeywordPerformanceCache>; miss: PerfQuery[] }> {
  const keys = queries.map((q) => keyForPerformanceCache(q.keyword, q.bid));
  const stored = await chrome.storage.local.get(keys);
  const hit = new Map<string, KeywordPerformanceCache>();
  const miss: PerfQuery[] = [];
  const now = Date.now();
  for (const q of queries) {
    const k = keyForPerformanceCache(q.keyword, q.bid);
    const entry = stored[k] as KeywordPerformanceCache | undefined;
    if (entry && now - new Date(entry.fetched_at).getTime() < TTL_MS) {
      hit.set(cacheKey(q.keyword, q.bid), entry);
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
    payload[keyForPerformanceCache(e.keyword, e.bid)] = e;
  }
  if (Object.keys(payload).length === 0) return;
  await chrome.storage.local.set(payload);
}

/** 키워드 단위 무효화 — 모든 bid 변형을 일괄 제거 */
export async function invalidatePerformance(keywords: string[]): Promise<void> {
  if (keywords.length === 0) return;
  // bid 값을 모르므로 정확히 어느 키를 지워야 하는지 알 수 없음.
  // 보수적으로 storage 전체를 스캔해 prefix + normalizedKeyword + ':' 로 시작하는 키 제거.
  const all = await chrome.storage.local.get(null);
  const normalized = new Set(
    keywords.map((k) => k.normalize("NFC").replace(/\s+/g, "").toLowerCase()),
  );
  const toRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith("performance_cache:")) continue;
    // performance_cache:<normalized>:<bid>
    const rest = key.slice("performance_cache:".length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon < 0) continue;
    const kw = rest.slice(0, lastColon);
    if (normalized.has(kw)) toRemove.push(key);
  }
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
}

/** in-memory 룩업용 — storage 키와 다른 인메모리 식별자 */
export const cacheKey = (keyword: string, bid: number): string =>
  `${keyword}:${bid}`;
