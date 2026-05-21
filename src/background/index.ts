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
  MultiAccountCollectResponse,
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
} from "@/lib/searchad";
import { getCachedBids, putBids } from "@/lib/volume-cache";
import {
  cacheKey as perfCacheKey,
  getCachedPerformance,
  putPerformance,
} from "@/lib/performance-cache";
import { friendlyApiError } from "@/lib/friendly-error";
import { maybePrune, pruneExpiredCache } from "@/lib/cache-prune";

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
    handleGetBidEstimate(msg.keywords, device)
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

// ─── F-MultiAccount — Port API (chrome.runtime.connect) ───
// `chrome.runtime.sendMessage` + return true 패턴은 MV3 service worker가 idle/restart 시
// "message channel closed before a response was received" 에러 발생. Port 사용 시
// long-lived connection이라 worker keep-alive + 안정적 응답.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "dvads-multi-account-collect") return;
  port.onMessage.addListener((msg: { type?: string; adAccountNo?: number }) => {
    if (msg?.type !== "MULTI_ACCOUNT_COLLECT_ACCOUNT" || typeof msg.adAccountNo !== "number") {
      port.postMessage({ ok: false, error: "잘못된 메시지" });
      return;
    }
    void (async () => {
      try {
        const result = await handleMultiAccountCollect(msg.adAccountNo!);
        console.log(`[bg/multi-account] port response ad=${msg.adAccountNo}`, result);
        port.postMessage(result);
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn(`[bg/multi-account] port handler crashed ad=${msg.adAccountNo}`, e);
        port.postMessage({ ok: false, error: raw });
      }
    })();
  });
  port.onDisconnect.addListener(() => {
    console.log("[bg/multi-account] port disconnected");
  });
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
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }
  return btoa(bin);
}

// ─── F-MultiAccount — 다른 광고계정 데이터 수집 (hidden tab 위임) ───
// 사유: 비즈머니/계약 같은 endpoint가 SPA 활성 계정 컨텍스트 기준이라 콘텐츠 스크립트
// 직접 cross-account fetch가 안 됨. 메모리 `project_f_multiaccount_cross_account_decision` 참조.

// 동시 1개로 처리 — 여러 hidden tab이 같은 도메인 쿠키(활성 계정)를 동시에 덮어쓰면
// 서로의 수집 결과가 섞일 수 있어 직렬화. "↻ 전체"도 어차피 sequential이라 병목 없음.
const MULTI_ACCOUNT_MAX_CONCURRENT = 1;
let multiAccountInFlight = 0;
const multiAccountWaiters: Array<() => void> = [];

async function handleMultiAccountCollect(
  adAccountNo: number,
): Promise<MultiAccountCollectResponse> {
  while (multiAccountInFlight >= MULTI_ACCOUNT_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => multiAccountWaiters.push(resolve));
  }
  multiAccountInFlight++;
  try {
    return await collectViaHiddenTab(adAccountNo);
  } finally {
    multiAccountInFlight--;
    const next = multiAccountWaiters.shift();
    next?.();
  }
}

async function collectViaHiddenTab(
  adAccountNo: number,
): Promise<MultiAccountCollectResponse> {
  // `active: false` 숨김 탭으로 띄움 — 사용자 화면은 광고 페이지 그대로 유지.
  // 백그라운드 탭은 timer가 1Hz로 throttle되어 SPA 활성 계정 컨텍스트 init이
  // foreground 대비 3~5배 느려진다. 그래서 content script의 `waitForAccountContext`
  // 타임아웃을 30초로 늘려둠 (`multi-account-data.ts`).
  // 데이터 받으면 탭 닫음. active 복귀가 필요 없어 race도 사라짐.
  const url = `https://ads.naver.com/manage/ad-accounts/${adAccountNo}/sa/campaigns-by/WEB_SITE`;
  console.log(`[bg/multi-account] collect start ad=${adAccountNo}`);

  let newTab: chrome.tabs.Tab | null = null;
  try {
    newTab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    console.warn(`[bg/multi-account] tabs.create 실패`, e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const tabId = newTab.id;
  if (!tabId) return { ok: false, error: "탭 생성 실패" };
  console.log(`[bg/multi-account] tab created id=${tabId}, waiting complete...`);

  try {
    // 백그라운드 탭은 페이지 로드도 약간 느려질 수 있어 20초로 여유.
    await waitForTabComplete(tabId, 20000);
    console.log(`[bg/multi-account] tab=${tabId} complete, PING polling 시작`);

    // PING polling — content script listener 등록 완료될 때까지 대기.
    // sendMessage 호출 전 listener 활성 확인하면 "channel closed before response" 회피.
    // 백그라운드 탭이라 content script 등록도 약간 느려질 수 있어 20초.
    const pingOk = await pingUntilReady(tabId, 20000);
    if (!pingOk) {
      console.warn(`[bg/multi-account] tab=${tabId} PING 응답 없음`);
      return { ok: false, error: "콘텐츠 스크립트 응답 없음" };
    }
    console.log(`[bg/multi-account] tab=${tabId} PING OK, sending COLLECT_ACTIVE`);

    // `frameId: 0` (top frame only) — 콘텐츠 스크립트가 `all_frames: true`라
    // iframe들에서도 listener가 등록되고 모두 `return true`(async)로 응답 약속.
    // ads.naver.com SPA가 hydration 중 iframe을 swap하면 그 frame이 sendResponse 전
    // destroy되어 Chrome이 채널을 close → "channel closed before response" 에러.
    // top frame만 타겟해 race 제거.
    // 응답 timeout은 content script의 waitForAccountContext(30s) + 실제 fetch들의
    // 합보다 넉넉히 — 45초.
    const sendPromise = chrome.tabs.sendMessage(
      tabId,
      { type: "MULTI_ACCOUNT_COLLECT_ACTIVE" },
      { frameId: 0 },
    ) as Promise<MultiAccountCollectResponse | undefined>;
    const res = await Promise.race([
      sendPromise,
      sleep(45000).then(() => "__TIMEOUT__" as const),
    ]);

    if (res === "__TIMEOUT__") {
      console.warn(`[bg/multi-account] tab=${tabId} sendMessage 응답 시간 초과 (45초)`);
      return { ok: false, error: "응답 시간 초과" };
    }
    console.log(`[bg/multi-account] tab=${tabId} response`, res);
    return res ?? { ok: false, error: "응답 없음" };
  } catch (e) {
    console.warn(`[bg/multi-account] tab=${tabId} 오류`, e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    console.log(`[bg/multi-account] removing tab ${tabId}`);
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      console.warn(`[bg/multi-account] tabs.remove 실패`, e);
    }
  }
}

async function pingUntilReady(tabId: number, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      // `frameId: 0` — COLLECT_ACTIVE와 동일 frame을 ready check.
      // multi-frame broadcast 시 어느 frame의 listener가 응답했는지 불확실 → top frame 고정.
      const res = (await chrome.tabs.sendMessage(
        tabId,
        { type: "PING" },
        { frameId: 0 },
      )) as { ok?: boolean } | undefined;
      if (res?.ok) return true;
    } catch {
      // listener 미등록 또는 channel close — retry
    }
    await sleep(300);
  }
  return false;
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
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
    const maxPos = MAX_POSITION_BY_DEVICE[device];
    const perfQueries: Array<{ keyword: string; bid: number }> = [];
    for (const b of bidResult) {
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

async function fetchBidsWithCache(
  keywords: string[],
  cred: Parameters<typeof fetchPositionBids>[1],
  device: AdDevice,
): Promise<KeywordVolumeCache[]> {
  const { hit, miss } = await getCachedBids(keywords, device);

  let fresh: KeywordVolumeCache[] = [];
  if (miss.length > 0) {
    const items = await fetchPositionBids(miss, cred, device);
    const now = new Date().toISOString();
    fresh = items.map((item) => ({
      keyword: item.keyword,
      device,
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
  device: AdDevice,
): Promise<KeywordPerformanceCache[]> {
  const { hit, miss } = await getCachedPerformance(queries, device);

  let fresh: KeywordPerformanceCache[] = [];
  if (miss.length > 0) {
    fresh = await fetchPerformance(miss, cred, device);
    if (fresh.length > 0) await putPerformance(fresh);
  }
  return queries
    .map(
      (q) =>
        hit.get(perfCacheKey(q.keyword, q.bid, device)) ??
        fresh.find((f) => f.keyword === q.keyword && f.bid === q.bid),
    )
    .filter((x): x is KeywordPerformanceCache => !!x);
}

export {};
