import type { ProductPopularResult } from "@/types";

const CACHE_KEY = "searchPopularCache";
const TTL_MS = 6 * 60 * 60 * 1000; // 6h — 순위는 태그 사전(24h)보다 변동이 잦음

interface CacheEntry {
  result: ProductPopularResult;
  cachedAt: number;
}

type CacheMap = Record<string, CacheEntry>;

function norm(keyword: string): string {
  return keyword.trim().toLowerCase();
}

export interface CachedResult {
  result: ProductPopularResult;
  cachedAt: number;
}

export async function getCached(keyword: string): Promise<CachedResult | null> {
  const cache = await read();
  const e = cache[norm(keyword)];
  if (!e) return null;
  if (Date.now() - e.cachedAt >= TTL_MS) return null;
  return { result: e.result, cachedAt: e.cachedAt };
}

export async function putCache(
  keyword: string,
  result: ProductPopularResult,
): Promise<void> {
  const cache = await read();
  cache[norm(keyword)] = { result, cachedAt: Date.now() };
  await chrome.storage.local.set({ [CACHE_KEY]: cache });
}

async function read(): Promise<CacheMap> {
  const r = await chrome.storage.local.get(CACHE_KEY);
  return (r[CACHE_KEY] as CacheMap) ?? {};
}

export async function clearSearchPopularCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}
