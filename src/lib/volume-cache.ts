/**
 * F001 — 키워드별 1~10위 예상 입찰가 캐시.
 *
 * 데이터 소스: 검색광고 API `POST /estimate/average-position-bid/keyword`.
 * 응답은 시장 단위 추정치 — 호출자 customerId와 무관하지만 디바이스(`PC`/`MOBILE`)에
 * 따라 시장이 갈리므로 캐시 키는 (keyword, device) 단위로 스코프한다.
 *
 * 키 스킴: `volume_cache:<device>:<normalizedKeyword>` (`storage-keys.ts`).
 * 각 (키워드, 디바이스)가 별도 storage 키를 점유 — 5MB quota 안에서 LRU prune은 Task 015.
 */

import { keyForVolumeCache, VOLUME_CACHE_PREFIX, normalizeKeyword } from "./storage-keys";
import type { KeywordVolumeCache } from "@/types/storage";
import type { AdDevice } from "@/types/device";

const TTL_MS = 4 * 60 * 60 * 1000; // 4h — 입찰 시장 변동을 고려한 보수적 TTL

export async function getCachedBids(
  keywords: string[],
  device: AdDevice,
): Promise<{ hit: Map<string, KeywordVolumeCache>; miss: string[] }> {
  const keys = keywords.map((k) => keyForVolumeCache(k, device));
  const stored = await chrome.storage.local.get(keys);
  const hit = new Map<string, KeywordVolumeCache>();
  const miss: string[] = [];
  const now = Date.now();
  for (const keyword of keywords) {
    const k = keyForVolumeCache(keyword, device);
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
    payload[keyForVolumeCache(e.keyword, e.device)] = e;
  }
  if (Object.keys(payload).length === 0) return;
  await chrome.storage.local.set(payload);
}

/**
 * 키워드 단위 무효화 — 모든 디바이스 변형을 일괄 제거.
 *
 * 키 형식이 `volume_cache:<device>:<normalizedKeyword>` 이므로 storage 전체 스캔으로
 * 키워드 매칭. 호출 빈도가 낮은 경로(F012 새로고침)라 비용 허용.
 */
export async function invalidateBids(keywords: string[]): Promise<void> {
  if (keywords.length === 0) return;
  const all = await chrome.storage.local.get(null);
  const normalized = new Set(keywords.map(normalizeKeyword));
  const toRemove: string[] = [];
  for (const key of Object.keys(all)) {
    if (!key.startsWith(VOLUME_CACHE_PREFIX)) continue;
    // volume_cache:<device>:<normalizedKeyword>
    const rest = key.slice(VOLUME_CACHE_PREFIX.length);
    const firstColon = rest.indexOf(":");
    if (firstColon < 0) continue;
    const kw = rest.slice(firstColon + 1);
    if (normalized.has(kw)) toRemove.push(key);
  }
  if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
}
