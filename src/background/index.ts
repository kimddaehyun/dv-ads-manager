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
  RefreshActiveTabResponse,
  FetchProductPageResponse,
  ScrapeProductImagesResponse,
  FetchImageBinaryResponse,
} from "@/types/messages";
import {
  MAX_POSITION_BY_DEVICE,
  type KeywordPerformanceCache,
  type KeywordVolumeCache,
} from "@/types/storage";
import type { AdDevice } from "@/types/device";
import {
  loadCredentials,
  fetchPositionBids,
  fetchPerformance,
} from "@/shared/searchad";
import { getCachedBids, putBids } from "@/features/bid/volume-cache";
import {
  cacheKey as perfCacheKey,
  getCachedPerformance,
  putPerformance,
} from "@/features/bid/performance-cache";
import { friendlyApiError } from "@/shared/friendly-error";
import { maybePrune, pruneExpiredCache } from "@/shared/cache-prune";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[dv-ads] service worker installed");
  // 설치/업데이트 직후 한 번 전체 스캔 — 이전 버전에서 남은 expired 엔트리 일괄 정리
  void pruneExpiredCache().catch((e) =>
    console.warn("[dv-ads] initial prune failed", e),
  );
});

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  if (msg?.type === "OPEN_OPTIONS") {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === "GET_BID_ESTIMATE") {
    // hot path 진입 시 fire-and-forget으로 throttled prune. 1h 안 됐으면 즉시 return.
    void maybePrune();
    const device = msg.device;
    handleGetBidEstimate(msg.keywords, device, msg.skipPerformance === true)
      .then(sendResponse)
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn("[bg] GET_BID_ESTIMATE crashed", e);
        sendResponse({
          ok: false,
          has_credential: true,
          device,
          error: friendlyApiError(raw, "bid"),
        });
      });
    return true; // 비동기 응답
  }
  if (msg?.type === "REFRESH_ACTIVE_TAB") {
    handleRefreshActiveTab()
      .then(sendResponse)
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn("[bg] REFRESH_ACTIVE_TAB crashed", e);
        sendResponse({ ok: false, error: raw });
      });
    return true; // 비동기 응답
  }
  if (msg?.type === "FETCH_PRODUCT_PAGE") {
    handleFetchProductPage(msg.url)
      .then(sendResponse)
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn("[bg] FETCH_PRODUCT_PAGE crashed", e);
        sendResponse({ ok: false, error: raw });
      });
    return true;
  }
  if (msg?.type === "FETCH_IMAGE_BINARY") {
    handleFetchImageBinary(msg.url)
      .then(sendResponse)
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn("[bg] FETCH_IMAGE_BINARY crashed", e);
        sendResponse({ ok: false, error: raw });
      });
    return true;
  }
  return false;
});

// ─── F-AssetBulk V2 — 상품 페이지 이미지 후보 추출 (hidden tab) ───
// 콘텐츠 스크립트 직접 fetch는 CORS 차단 + naver anti-bot에 막힘. 대신 hidden tab으로 페이지를
// 정상 브라우저처럼 열어 SPA hydration 후 실제 DOM에서 추출 — anti-bot 우회 + 정확도↑.

async function handleFetchProductPage(url: string): Promise<FetchProductPageResponse> {
  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    console.warn("[bg/asset-bulk] tabs.create 실패", e);
    return { ok: false, error: "탭을 열지 못했어요. 다시 시도해 주세요" };
  }
  const tabId = tab.id;
  if (!tabId) return { ok: false, error: "탭을 열지 못했어요" };

  try {
    await waitForTabComplete(tabId, 15000);
    // 콘텐츠 스크립트가 document_idle에 mount되지만 SPA hydration은 그 후. 짧은 여유.
    await sleep(800);

    const scrape = (await chrome.tabs.sendMessage(tabId, {
      type: "SCRAPE_PRODUCT_IMAGES",
    })) as ScrapeProductImagesResponse | undefined;
    if (!scrape?.ok || !scrape.urls) {
      return {
        ok: false,
        error: scrape?.error ?? "상품 페이지에서 이미지를 찾지 못했어요",
      };
    }
    if (scrape.urls.length === 0) {
      return {
        ok: false,
        error: "이 페이지에서 이미지를 찾지 못했어요. 다른 상품 페이지를 시도하거나 파일로 직접 첨부해 주세요",
      };
    }
    return { ok: true, candidates: scrape.urls };
  } catch (e) {
    console.warn("[bg/asset-bulk] hidden tab scrape 실패", url, e);
    return { ok: false, error: "상품 페이지를 불러오지 못했어요. 잠시 후 다시 시도해 주세요" };
  } finally {
    await chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ─── F-AssetBulk V2 — 이미지 binary fetch (광고 모달 업로드용) ───
// shop-phinf.pstatic.net이 host_permissions에 있어 background fetch는 CORS 우회. ArrayBuffer로
// 응답해 콘텐츠 스크립트가 File 변환 가능 (Blob은 sendMessage 구조화 클론 안 됨).

async function handleFetchImageBinary(url: string): Promise<FetchImageBinaryResponse> {
  try {
    const resp = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      // 네이버 CDN(`shop-phinf.pstatic.net`)이 referrer 없는 요청에 hotlink 차단 응답(빈/리다이렉트)을
      // 보내는 듯. smartstore 도메인을 referrer로 위장해 정상 트래픽처럼 받음.
      referrer: "https://smartstore.naver.com/",
      referrerPolicy: "strict-origin-when-cross-origin",
      headers: {
        Accept: "image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
    });
    const contentType = resp.headers.get("content-type") ?? "";
    const buffer = await resp.arrayBuffer();
    console.log(
      `[bg/asset-bulk] image fetch status=${resp.status} ct="${contentType}" size=${buffer.byteLength}b url=${url}`,
    );
    if (!resp.ok) {
      return { ok: false, error: `이미지를 받아오지 못했어요 (HTTP ${resp.status})` };
    }
    if (buffer.byteLength < 100) {
      // 정상 jpeg/png는 최소 수백 바이트 — 이보다 작으면 placeholder/에러 응답.
      return {
        ok: false,
        error: "이미지 데이터가 비정상이에요 (응답이 비어있거나 잘못된 형식)",
      };
    }
    return {
      ok: true,
      base64: arrayBufferToBase64(buffer),
      mimeType: contentType.startsWith("image/") ? contentType : "image/jpeg",
    };
  } catch (e) {
    console.warn("[bg/asset-bulk] image binary fetch 실패", url, e);
    return { ok: false, error: "이미지를 받아오지 못했어요. 네트워크 연결을 확인해 주세요" };
  }
}

// ArrayBuffer → base64. chrome.runtime.sendMessage가 ArrayBuffer를 JSON으로 wire-serialize해
// `{}`로 손실시키는 회피책. btoa는 binary string만 받으므로 byte-by-byte fromCharCode.
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunkSize = 0x8000; // 큰 ArrayBuffer를 한 번에 String.fromCharCode.apply하면 stack overflow
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
  }
  return btoa(bin);
}

// ─── F-MultiAccount: 더 이상 hidden tab 안 씀 ───
// 2026-05-21 정찰로 `x-ad-customer-id` 헤더 + bmgate URL 조합으로 cross-account 직접
// fetch 가능 확인. 이제 콘텐츠 스크립트가 사용자 페이지 컨텍스트에서 모든 계정 데이터를
// 직접 받음 (이 background 코드 경로 자체가 폐기됨).
// `MULTI_ACCOUNT_COLLECT_ACCOUNT` Port handler 및 hidden tab spawning 모두 제거.

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── F012 — 팝업 → 활성 탭 캐시 강제 갱신 ───
// 책임 분리: background는 forward만, 실제 캐시 무효화/재조회는 콘텐츠 스크립트가
// 자기 mount 상태를 보고 결정 (어떤 키워드가 화면에 보이는지 모르는 background가
// 추측하면 quota 낭비).
async function handleRefreshActiveTab(): Promise<RefreshActiveTabResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: "활성 탭을 찾지 못했습니다" };
  }
  if (!tab.url || !/^https?:\/\/([^/]+\.)?ads\.naver\.com/.test(tab.url)) {
    return {
      ok: false,
      error: "네이버 광고관리자 탭에서만 갱신할 수 있습니다",
    };
  }
  try {
    const res = (await chrome.tabs.sendMessage(tab.id, {
      type: "REFRESH_ACTIVE_TAB",
    })) as RefreshActiveTabResponse | undefined;
    return res ?? { ok: false, error: "콘텐츠 스크립트 응답 없음" };
  } catch (e) {
    // 콘텐츠 스크립트 미주입(키워드 페이지 외) 또는 통신 실패
    const raw = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: `콘텐츠 스크립트 응답 없음 (페이지 새로고침 후 재시도): ${raw}`,
    };
  }
}

async function handleGetBidEstimate(
  keywords: GetBidEstimateRequest["keywords"],
  device: AdDevice,
  skipPerformance = false,
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
    return { ok: true, has_credential: true, device, data: [] };
  }

  const cred = await loadCredentials();
  if (!cred) {
    return { ok: true, has_credential: false, device };
  }

  const bidKeywords = cleaned.map((c) => c.keyword);

  try {
    // 1단계: bid 추정 (1~10위 시장가)
    const bidResult = await fetchBidsWithCache(bidKeywords, cred, device);

    // 2단계: bid 결과를 펼쳐 perf 쿼리 생성. device별 순위 상한 적용 (PC 10 / MOBILE 5).
    // skipPerformance면 쿼리를 안 만들어 3단계가 통째로 생략된다.
    const maxPos = MAX_POSITION_BY_DEVICE[device];
    const perfQueries: Array<{ keyword: string; bid: number }> = [];
    if (!skipPerformance) for (const b of bidResult) {
      const seenBids = new Set<number>();
      for (let r = 1; r <= maxPos; r++) {
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
        ? await fetchPerformanceWithCache(perfQueries, cred, device).catch((e) => {
            const raw = e instanceof Error ? e.message : String(e);
            console.warn("[bg] fetchPerformance failed (bid 결과만 반환)", raw);
            return [] as KeywordPerformanceCache[];
          })
        : [];

    return {
      ok: true,
      has_credential: true,
      device,
      data: bidResult,
      performance: perfResult,
    };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    console.warn("[bg] GET_BID_ESTIMATE failed", e);
    return {
      ok: false,
      has_credential: true,
      device,
      error: friendlyApiError(raw, "bid"),
    };
  }
}

// 진행 중인 네트워크 요청 공유(in-flight 코얼레싱) — 멀티탭/프레임이 같은 키워드를
// 동시에 요청할 때 캐시 miss로 중복 fetch하는 걸 막는다. 키 = `<device>:<keyword>`.
const bidInflight = new Map<string, Promise<KeywordVolumeCache | undefined>>();

async function fetchBidsWithCache(
  keywords: string[],
  cred: Parameters<typeof fetchPositionBids>[1],
  device: AdDevice,
): Promise<KeywordVolumeCache[]> {
  const { hit, miss } = await getCachedBids(keywords, device);

  let fresh: KeywordVolumeCache[] = [];
  if (miss.length > 0) {
    // 아직 진행 중이지 않은 키워드만 묶어서 1회 fetch, 나머지는 기존 Promise 재사용.
    // miss에 같은 키워드가 중복될 수 있어(currentBid만 다른 dedupe 잔재) Set으로 정리 — 같은 key를
    // 두 번 set해 첫 Promise가 고아(unhandled rejection)가 되는 것 방지.
    const toFetch = [...new Set(miss.filter((k) => !bidInflight.has(`${device}:${k}`)))];
    if (toFetch.length > 0) {
      const batch = (async () => {
        const items = await fetchPositionBids(toFetch, cred, device);
        const now = new Date().toISOString();
        const mapped = items.map((item) => ({
          keyword: item.keyword,
          device,
          rank_to_bid: item.rank_to_bid,
          fetched_at: now,
        }));
        await putBids(mapped);
        return new Map(mapped.map((m) => [m.keyword, m] as const));
      })();
      for (const k of toFetch) {
        const key = `${device}:${k}`;
        bidInflight.set(
          key,
          batch.then((m) => m.get(k)).finally(() => bidInflight.delete(key)),
        );
      }
    }
    const settled = await Promise.all(
      miss.map((k) => bidInflight.get(`${device}:${k}`)),
    );
    fresh = settled.filter((x): x is KeywordVolumeCache => !!x);
  }
  const freshByKeyword = new Map(fresh.map((f) => [f.keyword, f] as const));
  return keywords
    .map((k) => hit.get(k) ?? freshByKeyword.get(k))
    .filter((x): x is KeywordVolumeCache => !!x);
}

// perf in-flight 코얼레싱 — 키에 bid 포함(`<device>:<keyword>:<bid>`, perfCacheKey와 동일).
const perfInflight = new Map<string, Promise<KeywordPerformanceCache | undefined>>();

async function fetchPerformanceWithCache(
  queries: Array<{ keyword: string; bid: number }>,
  cred: Parameters<typeof fetchPerformance>[1],
  device: AdDevice,
): Promise<KeywordPerformanceCache[]> {
  const { hit, miss } = await getCachedPerformance(queries, device);

  let fresh: KeywordPerformanceCache[] = [];
  if (miss.length > 0) {
    // 아직 진행 중이지 않은 (키워드,입찰가)만 묶어서 1회 fetch, 나머지는 기존 Promise 재사용.
    // 같은 (키워드,입찰가) 중복은 같은 key를 두 번 set해 첫 Promise를 고아로 만들므로 key 기준 dedupe.
    const seenPerfKeys = new Set<string>();
    const toFetch = miss.filter((q) => {
      const key = perfCacheKey(q.keyword, q.bid, device);
      if (perfInflight.has(key) || seenPerfKeys.has(key)) return false;
      seenPerfKeys.add(key);
      return true;
    });
    if (toFetch.length > 0) {
      const batch = (async () => {
        const items = await fetchPerformance(toFetch, cred, device);
        if (items.length > 0) await putPerformance(items);
        return new Map(
          items.map((m) => [perfCacheKey(m.keyword, m.bid, device), m] as const),
        );
      })();
      for (const q of toFetch) {
        const key = perfCacheKey(q.keyword, q.bid, device);
        perfInflight.set(
          key,
          batch.then((m) => m.get(key)).finally(() => perfInflight.delete(key)),
        );
      }
    }
    const settled = await Promise.all(
      miss.map((q) => perfInflight.get(perfCacheKey(q.keyword, q.bid, device))),
    );
    fresh = settled.filter((x): x is KeywordPerformanceCache => !!x);
  }
  const freshByKey = new Map(
    fresh.map((f) => [perfCacheKey(f.keyword, f.bid, device), f] as const),
  );
  return queries
    .map((q) => {
      const key = perfCacheKey(q.keyword, q.bid, device);
      return hit.get(key) ?? freshByKey.get(key);
    })
    .filter((x): x is KeywordPerformanceCache => !!x);
}

export {};
