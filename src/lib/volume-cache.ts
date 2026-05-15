/**
 * F001 — 키워드별 1~10위 예상 입찰가 캐시.
 *
 * 데이터 소스: 검색광고 API `POST /estimate/average-position-bid/keyword`.
 * 응답은 시장 단위 추정치 — 호출자 customerId와 무관하게 동일하므로 캐시 키는
 * 키워드 단위로만 스코프한다.
 *
 * 키 스킴: `volume_cache:<normalizedKeyword>` (`storage-keys.ts`의 `keyForVolumeCache`).
 * 각 키워드가 별도 storage 키를 점유 — 5MB quota 안에서 LRU prune은 Task 015에서 도입.
 */

import { keyForVolumeCache } from "./storage-keys";
import type { KeywordVolumeCache } from "@/types/storage";

const TTL_MS = 4 * 60 * 60 * 1000; // 4h — 입찰 시장 변동을 고려한 보수적 TTL

export async function getCachedBids(
  keywords: string[],
): Promise<{ hit: Map<string, KeywordVolumeCache>; miss: string[] }> {
  const keys = keywords.map(keyForVolumeCache);
  const stored = await chrome.storage.local.get(keys);
  const hit = new Map<string, KeywordVolumeCache>();
  const miss: string[] = [];
  const now = Date.now();
  for (const keyword of keywords) {
    const k = keyForVolumeCache(keyword);
    const entry = stored[k] as KeywordVolumeCache | undefined;
    if (entry && now - new Date(entry.fetched_at).getTime() < TTL_MS) {
      hit.set(keyword, entry);
    } else {
      miss.push(keyword);
    }
  }
  return { hit, miss };
}

export async function putBids(entries: KeywordVolumeCache[]): Promise<void> {
  const payload: Record<string, KeywordVolumeCache> = {};
  for (const e of entries) {
    payload[keyForVolumeCache(e.keyword)] = e;
  }
  if (Object.keys(payload).length === 0) return;
  await chrome.storage.local.set(payload);
}

export async function invalidateBids(keywords: string[]): Promise<void> {
  if (keywords.length === 0) return;
  await chrome.storage.local.remove(keywords.map(keyForVolumeCache));
}
