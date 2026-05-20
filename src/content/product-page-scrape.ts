/**
 * F-AssetBulk V2 — 스마트스토어/브랜드스토어 상품 페이지에 inject되는 가벼운 스크레이퍼.
 *
 * background가 hidden tab으로 상품 페이지를 열면 이 스크립트가 DOM에서 갤러리 이미지를
 * 수집해 SCRAPE_PRODUCT_IMAGES 응답으로 돌려준다. SPA hydration이 끝난 후 실제 렌더된
 * <img>를 보므로 SSR HTML 직접 fetch보다 정확.
 *
 * 페이지 자체 동작에는 손대지 않음 — listener만 등록. 사용자가 해당 페이지를 실제 브라우징
 * 중에 우연히 이 스크립트가 inject되어도 noop(어떤 메시지도 안 옴).
 */

import type { ScrapeProductImagesResponse } from "@/types/messages";

const IMAGE_URL_PATTERN =
  /^https?:\/\/[^\s"']+\.(?:jpe?g|png|webp|gif)(?:\?[^\s"']*)?$/i;
// 갤러리 carousel 이미지는 모두 shop-phinf 또는 shopping-phinf CDN. 본문 상세 페이지의
// 이미지나 페이지 chrome(로고/배너)는 다른 호스트라 자동 제외.
const CDN_HOST_PATTERN = /^(shop-phinf|shopping-phinf)\.pstatic\.net$/i;
const MAX_CANDIDATES = 8;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "SCRAPE_PRODUCT_IMAGES") return false;
  scrapeWithRetry()
    .then((urls) => {
      const resp: ScrapeProductImagesResponse = { ok: true, urls };
      sendResponse(resp);
    })
    .catch((e) => {
      const resp: ScrapeProductImagesResponse = {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
      sendResponse(resp);
    });
  return true; // async
});

/**
 * 갤러리/대표 이미지 DOM 셀렉터 우선순위 — 정찰 결과 SPA hydration 시점에 image들이
 * shop-phinf CDN URL로 채워진다. 셀렉터를 협소하게 잡지 않고 페이지 전체에서 CDN host
 * 매칭되는 img 모두 수집 → 큰 사이즈 우선 dedupe.
 *
 * hydration 완료 대기: 첫 시점에 이미지가 0개일 수 있어 짧은 retry. SCRAPE 요청 시점이
 * document_idle이라 보통 첫 호출에서 잡히지만 안전망.
 */
async function scrapeWithRetry(): Promise<string[]> {
  const MAX_RETRIES = 8;
  const RETRY_DELAY_MS = 300;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const urls = collect();
    if (urls.length > 0) return urls;
    await sleep(RETRY_DELAY_MS);
  }
  return collect();
}

/**
 * 갤러리 carousel 메인 이미지만 수집.
 *
 * 휴리스틱:
 *   - eager-load된 `src`만 본다 (`data-src`/srcset 무시). 본문 상세 이미지는 보통 lazy-load라
 *     자동 제외.
 *   - 호스트는 `shop-phinf.pstatic.net` 같은 상품 갤러리 CDN만.
 *   - 같은 path(query 제거)의 사이즈 변형은 "가장 큰" 1개만 유지.
 *
 * 갤러리는 카루셀 메인 + 하단 thumbnail strip이 같은 base path에 사이즈만 다른 변형으로
 * 노출돼서 dedup하면 자연스럽게 1상품 = 1후보로 줄어든다.
 */
function collect(): string[] {
  // base path → 후보 정보. 같은 base의 다른 사이즈가 들어오면 더 큰 쪽으로 교체.
  const bestByBase = new Map<string, { url: string; rank: number; idx: number }>();
  let scanIdx = 0;

  const consider = (raw: string | null | undefined): void => {
    if (!raw) return;
    let url = raw.trim();
    if (!url) return;
    if (url.startsWith("//")) url = "https:" + url;
    if (!/^https?:\/\//i.test(url)) return;
    if (!IMAGE_URL_PATTERN.test(url)) return;

    let host = "";
    let pathBase = url;
    try {
      const u = new URL(url);
      host = u.host;
      pathBase = `${u.host}${u.pathname}`;
    } catch {
      return;
    }
    if (!CDN_HOST_PATTERN.test(host)) return;

    const rank = sizeRank(url);
    const existing = bestByBase.get(pathBase);
    if (!existing || rank > existing.rank) {
      bestByBase.set(pathBase, { url, rank, idx: existing?.idx ?? scanIdx++ });
    }
  };

  // og:image — 대표 이미지로 갤러리 0번과 같은 base일 가능성 큼. meta 태그는 사이즈
  // 정보가 없어서 무조건 통과.
  document
    .querySelectorAll<HTMLMetaElement>(
      'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"], meta[name="twitter:image:src"]',
    )
    .forEach((m) => consider(m.getAttribute("content")));

  // __NEXT_DATA__ SSR JSON — 갤러리 전체 image URL 배열이 박혀있음. lazy load 여부와
  // 무관하게 갤러리 N장 다 추출 가능. JSON BFS로 CDN host 매칭되는 문자열 수집.
  const nextScript = document.getElementById("__NEXT_DATA__");
  if (nextScript?.textContent) {
    try {
      walkJson(JSON.parse(nextScript.textContent), consider);
    } catch {
      // JSON 깨졌으면 skip — DOM scrape로 대체.
    }
  }

  // <img> 중 갤러리 carousel 메인만 — 다중 휴리스틱으로 로고/배너/광고 제외.
  //
  //   사이즈: rect.width >= 200 (썸네일 strip 제외) + intrinsic min >= 400 (썸네일/로고 제외)
  //   비율: intrinsic aspect ratio <= 2.0 (가로 긴 배너·로고 제외; 상품 갤러리는 1:1~3:4)
  //   위치: fold-above 2.5배 안 (페이지 한참 아래 본문 이미지 제외)
  const viewportH = window.innerHeight || 800;
  // 미니썸네일(carousel 하단 strip)도 통과 — 같은 base path라 dedup으로 큰 사이즈로 변환되어
  // 갤러리 N장 base 전부 잡힘. favicon 같은 매우 작은 건 CDN host whitelist로 컷.
  const MIN_RENDERED_WIDTH = 40;
  // 본문 상세 페이지 안의 carousel 또는 큰 이미지 noise 차단. carousel 메인 carousel은
  // 보통 fold-above 1배 안. 1.5배로 본문은 컷, 메인은 보존.
  const FOLD_ABOVE_MULTIPLIER = 1.5;
  const MIN_INTRINSIC_SIDE = 400;
  // 풀샷 모델 사진(800×2000 등)·세로 긴 룩북 포함하려면 2.5 정도. 8:1 배너·3:1 로고는 컷.
  const MAX_ASPECT_RATIO = 2.5;
  document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const rect = img.getBoundingClientRect();
    if (rect.width < MIN_RENDERED_WIDTH) return;
    if (rect.top > viewportH * FOLD_ABOVE_MULTIPLIER) return;
    // intrinsic 사이즈는 lazy load라 0×0일 수 있음. 측정 가능할 때만 검증 — 측정 안 되면
    // 통과시켜 carousel 다른 슬라이드(아직 load 안 됨)까지 포함.
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw && nh) {
      if (Math.min(nw, nh) < MIN_INTRINSIC_SIDE) return;
      if (Math.max(nw, nh) / Math.min(nw, nh) > MAX_ASPECT_RATIO) return;
    }
    consider(img.getAttribute("src"));
    consider(img.getAttribute("data-src"));
    if (img.currentSrc) consider(img.currentSrc);
  });

  return Array.from(bestByBase.values())
    .sort((a, b) => a.idx - b.idx)
    .slice(0, MAX_CANDIDATES)
    .map((e) => e.url);
}

// JSON 트리 BFS — image URL처럼 보이는 string 발견 시 consider 호출.
function walkJson(node: unknown, consider: (url: string) => void): void {
  if (node == null) return;
  if (typeof node === "string") {
    if (IMAGE_URL_PATTERN.test(node)) consider(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) walkJson(n, consider);
    return;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) walkJson(v, consider);
  }
}

// query string으로 사이즈를 추정. `?type=o*` (original) 가장 큼, `?type=f*` 중간, `?type=w*` 작음.
// 숫자 동반 시 그 값까지 반영 — `o1000`이 `o500`보다 크게 평가.
function sizeRank(url: string): number {
  const m = url.match(/[?&]type=([a-z])(\d+)/i);
  if (!m) return 0;
  const letter = m[1].toLowerCase();
  const num = parseInt(m[2], 10) || 0;
  const base = letter === "o" ? 3000 : letter === "f" ? 2000 : letter === "w" ? 1000 : 0;
  return base + num;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
