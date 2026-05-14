import type { KeywordVolume } from "./searchad";

const CACHE_KEY = "volumeCache";
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheEntry {
  volume: KeywordVolume;
  cachedAt: number;
}

type CacheMap = Record<string, CacheEntry>;

export async function getCachedVolumes(
  keywords: string[],
): Promise<{ hit: Map<string, KeywordVolume>; miss: string[] }> {
  const cache = await readCache();
  const hit = new Map<string, KeywordVolume>();
  const miss: string[] = [];
  const now = Date.now();
  for (const k of keywords) {
    const e = cache[k];
    if (e && now - e.cachedAt < TTL_MS) hit.set(k, e.volume);
    else miss.push(k);
  }
  return { hit, miss };
}

export async function putVolumes(volumes: KeywordVolume[]): Promise<void> {
  const cache = await readCache();
  const now = Date.now();
  for (const v of volumes) cache[v.keyword] = { volume: v, cachedAt: now };
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

async function readCache(): Promise<CacheMap> {
  const r = await chrome.storage.local.get(CACHE_KEY);
  return (r[CACHE_KEY] as CacheMap) ?? {};
}

export async function clearCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}
