import { fetchVolumes, loadCredentials } from "@/lib/searchad";
import type { KeywordVolume } from "@/lib/searchad";
import { getCachedVolumes, putVolumes } from "@/lib/volume-cache";
import { fetchProductSearchPopular } from "@/lib/search-popular";
import {
  getCached as getCachedPopular,
  putCache as putCachePopular,
} from "@/lib/search-popular-cache";
import type { ProductPopularResult } from "@/types";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[ad-manager] installed");
});

interface VolumeMessage {
  type: "GET_VOLUMES";
  keywords: string[];
}

interface VolumeResponse {
  ok: boolean;
  volumes?: KeywordVolume[];
  error?: string;
  hasCredentials: boolean;
}

interface SearchPopularMessage {
  type: "GET_SEARCH_POPULAR";
  keyword: string;
}

interface SearchPopularResponse {
  ok: boolean;
  data?: ProductPopularResult;
  cached?: boolean;
  cachedAt?: number;
  error?: string;
}

type Msg =
  | VolumeMessage
  | SearchPopularMessage
  | { type: "OPEN_OPTIONS" };

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg?.type === "OPEN_OPTIONS") {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "GET_VOLUMES") {
    void handleVolumes(msg.keywords).then(sendResponse);
    return true;
  }
  if (msg?.type === "GET_SEARCH_POPULAR") {
    void handleSearchPopular(msg.keyword).then(sendResponse);
    return true;
  }
  return false;
});

async function handleSearchPopular(
  keyword: string,
): Promise<SearchPopularResponse> {
  try {
    const cached = await getCachedPopular(keyword);
    if (cached) {
      return {
        ok: true,
        data: cached.result,
        cached: true,
        cachedAt: cached.cachedAt,
      };
    }
    const fresh = await fetchProductSearchPopular(keyword);
    await putCachePopular(keyword, fresh);
    return { ok: true, data: fresh, cached: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleVolumes(keywords: string[]): Promise<VolumeResponse> {
  const cred = await loadCredentials();
  if (!cred) {
    return { ok: false, error: "API 키 미설정", hasCredentials: false };
  }

  try {
    const { hit, miss } = await getCachedVolumes(keywords);
    let fresh: KeywordVolume[] = [];
    if (miss.length > 0) {
      fresh = await fetchVolumes(miss, cred);
      await putVolumes(fresh);
    }
    const all = [...hit.values(), ...fresh];
    return { ok: true, volumes: all, hasCredentials: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      hasCredentials: true,
    };
  }
}

export {};
