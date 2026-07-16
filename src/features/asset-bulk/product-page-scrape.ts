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
 * 갤러리 이미지 수집 — 2단 fallback 구조.
 *
 *   1순위: PRELOADED_STATE 화이트리스트 path (스마트스토어/브랜드스토어 표준).
 *   2순위: DOM scrape + og:image (PRELOADED_STATE 못 잡는 host용 폴백).
 *
 * PRELOADED_STATE는 SSR 정적이라 재시도해도 안 바뀜 — 거대 JSON 파싱은 루프 밖에서
 * 페이지당 1회만. 메인 갤러리 path를 잡으면 즉시 반환. 못 잡는 host는 DOM hydration이
 * 끝날 때까지 DOM scrape만 짧은 retry. SCRAPE 요청 시점이 document_idle이라 보통 첫 호출에서
 * 잡히지만 안전망.
 */
async function scrapeWithRetry(): Promise<string[]> {
  // 1순위: PRELOADED_STATE 화이트리스트 — 스마트스토어/브랜드스토어 표준 SSR state에서
  // 메인 갤러리 path만 정확히 추출. 로고·프로모션 배너·추천 상품 같은 noise를 휴리스틱 없이
  // 깔끔하게 제외 (2026-05-21 정찰로 3개 페이지에서 동일 path 확인). SSR 정적이라 1회만.
  const inlineState = extractInlineState();
  if (inlineState) {
    const gallery = extractGalleryFromState(inlineState);
    if (gallery.length > 0) return gallery;
  }
  // 2순위: PRELOADED_STATE 못 잡거나 갤러리 path가 비어 있는 host용 폴백. DOM scrape 휴리스틱.
  // DOM hydration 대기는 이 폴백에만 필요하므로 collectFallback만 재시도.
  const MAX_RETRIES = 8;
  const RETRY_DELAY_MS = 300;
  for (let i = 0; i < MAX_RETRIES; i++) {
    const urls = collectFallback();
    if (urls.length > 0) return urls;
    await sleep(RETRY_DELAY_MS);
  }
  return collectFallback();
}

/**
 * 스마트스토어/브랜드스토어 SSR state에서 메인 갤러리 path만 추출.
 *
 * 2026-05-21 정찰로 확정 — 메인 갤러리는 정확히 두 path에 들어있음:
 *   - simpleProductForDetailPage.A.representativeImageUrl  (대표 1장)
 *   - simpleProductForDetailPage.A.optionalImageUrls[N]    (추가 N장)
 *
 * 다른 path는 모두 noise: 스토어 로고(gnbWidget.logo), 프로모션 배너(promotionBannerWidget),
 * 채널 대표(channel.representativeImageUrl 등). representativeImageUrl이 optionalImageUrls
 * 첫 번째와 같은 케이스도 있어서 URL 중복 dedup만.
 */
interface ProductDetailState {
  representativeImageUrl?: unknown;
  optionalImageUrls?: unknown[];
}

function extractGalleryFromState(state: unknown): string[] {
  const root = (state as { simpleProductForDetailPage?: { A?: ProductDetailState } })
    ?.simpleProductForDetailPage?.A;
  if (!root) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (u: unknown): void => {
    if (typeof u !== "string") return;
    if (!IMAGE_URL_PATTERN.test(u)) return;
    if (seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  push(root.representativeImageUrl);
  const optional = root.optionalImageUrls;
  if (Array.isArray(optional)) {
    for (const u of optional) push(u);
  }
  return out.map(applyStandardSize);
}

/**
 * 스마트스토어 CDN raw URL(query 없음)은 이미지마다 default 응답 사이즈가 일관되지 않아
 * (어떤 건 thumbnail, 어떤 건 full) ads.naver.com 모달의 640~2000 검증에서 일부 떨어짐.
 *
 * 페이지가 carousel에서 실제 사용하는 `?type=o1000` query를 강제 — 1000×1000 정사각 보장.
 * (스크린샷 1 정찰 결과 carousel `<img src="...jpg?type=o1000">` 확인. 광고 모달 검증 범위 안.)
 *
 * URL에 이미 query가 있으면 보존 — 의도된 variant일 수 있음.
 *
 * 한계: 원본이 1000px 미만인 갤러리 이미지는 CDN이 upscale 없이 원본 크기를 응답하므로
 * 광고 모달의 640~2000 검증에서 거부될 수 있음. 갤러리 이미지가 모두 1000+인 일반 케이스는
 * 안전. 거부 발생 시 사용자가 popup 결과에서 손으로 빼면 됨.
 */
function applyStandardSize(url: string): string {
  try {
    const u = new URL(url);
    if (!u.search) u.search = "?type=o1000";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * PRELOADED_STATE를 못 잡은 경우 폴백 — DOM scrape + og:image 휴리스틱.
 * 표준 host(스마트스토어·브랜드스토어)에선 1순위에서 끝나므로 도달 안 함.
 */
function collectFallback(): string[] {
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

  document
    .querySelectorAll<HTMLMetaElement>(
      'meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"], meta[name="twitter:image:src"]',
    )
    .forEach((m) => consider(m.getAttribute("content")));

  const viewportH = window.innerHeight || 800;
  const MIN_RENDERED_WIDTH = 40;
  const FOLD_ABOVE_MULTIPLIER = 1.5;
  const MIN_INTRINSIC_SIDE = 400;
  const MAX_ASPECT_RATIO = 2.5;
  document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const rect = img.getBoundingClientRect();
    if (rect.width < MIN_RENDERED_WIDTH) return;
    if (rect.top > viewportH * FOLD_ABOVE_MULTIPLIER) return;
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
    .map((e) => e.url);
}

/**
 * inline script에서 SSR state JSON 추출.
 *
 * 우선순위:
 *   1. Next.js `<script id="__NEXT_DATA__">` — 표준 SSR. JSON 그대로 들어있음.
 *   2. `window.__PRELOADED_STATE__={...}` / `__APOLLO_STATE__={...}` / `__INITIAL_STATE__={...}`
 *      — 스마트스토어/브랜드스토어 패턴. assignment의 첫 `{`부터 매칭되는 `}` 까지를
 *      depth count로 잘라서 JSON.parse.
 */
function extractInlineState(): unknown | null {
  const nextScript = document.getElementById("__NEXT_DATA__");
  if (nextScript?.textContent) {
    try {
      return JSON.parse(nextScript.textContent);
    } catch {
      // 다음 후보로
    }
  }
  const ASSIGN_KEYS = ["__PRELOADED_STATE__", "__APOLLO_STATE__", "__INITIAL_STATE__"];
  const scripts = document.querySelectorAll<HTMLScriptElement>("script:not([src])");
  for (const s of scripts) {
    const text = s.textContent || "";
    if (!text) continue;
    for (const name of ASSIGN_KEYS) {
      const idx = text.indexOf(name + "=");
      if (idx < 0) continue;
      const start = text.indexOf("{", idx);
      if (start < 0) continue;
      const json = sliceBalancedBraces(text, start);
      if (!json) continue;
      try {
        return JSON.parse(sanitizeJsLiterals(json));
      } catch {
        // 다음 후보로
      }
    }
  }
  return null;
}

/**
 * JSON.parse 가 거부하는 JS literal을 null로 치환.
 * 스마트스토어 PRELOADED_STATE는 빈 필드에 `undefined`를 그대로 박는 케이스가 있어
 * (2026-05-21 사용자 정찰 `recInfo:undefined`) 표준 JSON.parse가 실패.
 *
 * `:undefined` 패턴만 매치 — string 안의 `:undefined`는 quote 안이라 거의 없고,
 * 실데이터로 사용자 정찰 시 안전 확인됨.
 */
function sanitizeJsLiterals(s: string): string {
  return s
    .replace(/:\s*undefined\b/g, ":null")
    .replace(/:\s*NaN\b/g, ":null")
    .replace(/:\s*Infinity\b/g, ":null")
    .replace(/:\s*-Infinity\b/g, ":null");
}

// `{`부터 매칭되는 `}` 까지를 잘라낸다. 문자열 안의 brace는 무시 (`"`/`'`/`` ` `` 모두 처리, escape `\` 처리).
// 한계: template literal 안의 `${...}` expression brace는 처리 안 함 — state 값에 template
// literal이 박히는 케이스 자체가 드물어 실용상 충분.
function sliceBalancedBraces(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let strCh = "";
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inStr = true;
      strCh = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
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
