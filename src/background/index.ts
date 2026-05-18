/**
 * 디브이 애드 매니저 — MV3 서비스 워커.
 *
 * 책임: 콘텐츠 스크립트·팝업·옵션 페이지에서 오는 메시지 라우팅.
 *   - OPEN_OPTIONS: 옵션 페이지 열기
 *   - GET_BID_ESTIMATE: 키워드 → 1~10위 예상 입찰가 + (있으면) 현재 입찰가 기준 성과 추정 (F001)
 *   - (예정) GET_PRODUCT_RANK: 쇼핑검색광고 소재 → 자동매칭 키워드별 순위·입찰가 (F002/F003)
 *   - (예정) REFRESH_ACTIVE_TAB: 팝업 → 활성 탭 캐시 강제 갱신 (F012)
 */

import type {
  ExtensionMessage,
  GetBidEstimateRequest,
  GetBidEstimateResponse,
} from "@/types/messages";
import type {
  KeywordPerformanceCache,
  KeywordVolumeCache,
} from "@/types/storage";
import {
  loadCredentials,
  fetchPositionBids,
  fetchPerformance,
} from "@/lib/searchad";
import { getCachedBids, putBids } from "@/lib/volume-cache";
import {
  cacheKey as perfCacheKey,
  getCachedPerformance,
  putPerformance,
} from "@/lib/performance-cache";
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
  keywords: GetBidEstimateRequest["keywords"],
): Promise<GetBidEstimateResponse> {
  // 키워드 dedupe (currentBid가 다르면 다른 항목으로 취급 — 같은 키워드에 두 bid가 올 일은 거의 없지만)
  const seen = new Set<string>();
  const cleaned = keywords
    .map((k) => ({ keyword: k.keyword.trim(), currentBid: k.currentBid }))
    .filter((k) => {
      if (!k.keyword) return false;
      const id = `${k.keyword}|${k.currentBid ?? "null"}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  if (cleaned.length === 0) {
    return { ok: true, has_credential: true, data: [] };
  }

  const cred = await loadCredentials();
  if (!cred) {
    return { ok: true, has_credential: false };
  }

  const bidKeywords = cleaned.map((c) => c.keyword);

  try {
    // 1단계: bid 추정 (1~10위 시장가)
    const bidResult = await fetchBidsWithCache(bidKeywords, cred);

    // 2단계: bid 결과를 펼쳐 perf 쿼리 생성. 키워드 × 각 순위 bid = 최대 10개/키워드
    const perfQueries: Array<{ keyword: string; bid: number }> = [];
    for (const b of bidResult) {
      const seenBids = new Set<number>();
      for (let r = 1; r <= 10; r++) {
        const bid = b.rank_to_bid[r as 1];
        // 같은 키워드 내 중복 bid는 1회만 (예: 9위·10위가 동일 70원이면 한 번만 조회)
        if (bid != null && !seenBids.has(bid)) {
          seenBids.add(bid);
          perfQueries.push({ keyword: b.keyword, bid });
        }
      }
    }

    // 3단계: perf 일괄 조회. 실패해도 bid 결과는 반환.
    const perfResult =
      perfQueries.length > 0
        ? await fetchPerformanceWithCache(perfQueries, cred).catch((e) => {
            const raw = e instanceof Error ? e.message : String(e);
            console.warn("[bg] fetchPerformance failed (bid 결과만 반환)", raw);
            return [] as KeywordPerformanceCache[];
          })
        : [];

    return {
      ok: true,
      has_credential: true,
      data: bidResult,
      performance: perfResult,
    };
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

async function fetchBidsWithCache(
  keywords: string[],
  cred: Parameters<typeof fetchPositionBids>[1],
): Promise<KeywordVolumeCache[]> {
  const { hit, miss } = await getCachedBids(keywords);

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
  return keywords
    .map((k) => hit.get(k) ?? fresh.find((f) => f.keyword === k))
    .filter((x): x is KeywordVolumeCache => !!x);
}

async function fetchPerformanceWithCache(
  queries: Array<{ keyword: string; bid: number }>,
  cred: Parameters<typeof fetchPerformance>[1],
): Promise<KeywordPerformanceCache[]> {
  const { hit, miss } = await getCachedPerformance(queries);

  let fresh: KeywordPerformanceCache[] = [];
  if (miss.length > 0) {
    fresh = await fetchPerformance(miss, cred);
    if (fresh.length > 0) await putPerformance(fresh);
  }
  return queries
    .map(
      (q) =>
        hit.get(perfCacheKey(q.keyword, q.bid)) ??
        fresh.find((f) => f.keyword === q.keyword && f.bid === q.bid),
    )
    .filter((x): x is KeywordPerformanceCache => !!x);
}

export {};
