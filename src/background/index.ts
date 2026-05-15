/**
 * 디브이 애드 매니저 — MV3 서비스 워커.
 *
 * 책임: 콘텐츠 스크립트·팝업·옵션 페이지에서 오는 메시지 라우팅.
 *   - OPEN_OPTIONS: 옵션 페이지 열기
 *   - GET_BID_ESTIMATE: 키워드 → 1~10위 예상 입찰가 (F001)
 *   - (예정) GET_PRODUCT_RANK: 쇼핑검색광고 소재 → 자동매칭 키워드별 순위·입찰가 (F002/F003)
 *   - (예정) REFRESH_ACTIVE_TAB: 팝업 → 활성 탭 캐시 강제 갱신 (F012)
 */

import type {
  ExtensionMessage,
  GetBidEstimateResponse,
} from "@/types/messages";
import type { KeywordVolumeCache } from "@/types/storage";
import { loadCredentials, fetchPositionBids } from "@/lib/searchad";
import { getCachedBids, putBids } from "@/lib/volume-cache";
import { friendlyApiError } from "@/lib/friendly-error";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[dv-ads] service worker installed");
});

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg?.type === "OPEN_OPTIONS") {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "GET_BID_ESTIMATE") {
    handleGetBidEstimate(msg.keywords)
      .then(sendResponse)
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn("[bg] GET_BID_ESTIMATE crashed", e);
        sendResponse({
          ok: false,
          has_credential: true,
          error: friendlyApiError(raw, "bid"),
        });
      });
    return true; // 비동기 응답
  }
  return false;
});

async function handleGetBidEstimate(
  keywords: string[],
): Promise<GetBidEstimateResponse> {
  const cleaned = Array.from(
    new Set(keywords.map((k) => k.trim()).filter(Boolean)),
  );
  if (cleaned.length === 0) {
    return { ok: true, has_credential: true, data: [] };
  }

  const cred = await loadCredentials();
  if (!cred) {
    return { ok: true, has_credential: false };
  }

  try {
    const { hit, miss } = await getCachedBids(cleaned);

    let fresh: KeywordVolumeCache[] = [];
    if (miss.length > 0) {
      const items = await fetchPositionBids(miss, cred);
      const now = new Date().toISOString();
      fresh = items.map((item) => ({
        keyword: item.keyword,
        rank_to_bid: item.rank_to_bid,
        fetched_at: now,
      }));
      await putBids(fresh);
    }

    const data: KeywordVolumeCache[] = cleaned
      .map((k) => hit.get(k) ?? fresh.find((f) => f.keyword === k))
      .filter((x): x is KeywordVolumeCache => !!x);

    return { ok: true, has_credential: true, data };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.warn("[bg] GET_BID_ESTIMATE failed", e);
    return {
      ok: false,
      has_credential: true,
      error: friendlyApiError(raw, "bid"),
    };
  }
}

export {};
