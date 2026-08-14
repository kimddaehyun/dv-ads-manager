/**
 * F-AutoSetup — 링크로 연 페이지에서 상품 정보를 뽑는다.
 *
 * **이 함수는 `chrome.scripting.executeScript`로 페이지(MAIN world)에 통째로 주입된다.**
 * 그래서 규칙이 하나 있다 — **바깥 것을 아무것도 참조하지 않는다.** import한 값, 모듈 상수,
 * 다른 함수 전부 금지. 헬퍼가 필요하면 함수 안에 선언한다. (타입 전용 import는 빌드 때
 * 사라지므로 괜찮다.) 이걸 어기면 주입된 곳에서 "정의되지 않음"으로 조용히 실패한다.
 *
 * 읽는 순서는 정확한 것부터다.
 *   1. `__PRELOADED_STATE__` — 네이버 스토어에서 가장 풍부
 *   2. JSON-LD — 표준이라 일반 쇼핑몰에도 상당수 통한다
 *   3. og: 메타 태그
 *   4. 본문 텍스트 — 정확도는 떨어지지만 없는 것보단 낫다
 *
 * 아무것도 못 건지면 `null`을 반환한다. 호출부는 **원인을 따지지 않고** 탭을 사용자에게 보여준다.
 */

import type { ProductPageInfo } from "@/types/auto-setup";

export function extractPageInfo(): ProductPageInfo | null {
  const MAX_BODY_TEXT = 4000;
  /**
   * 본문이 이보다 짧으면 상품 페이지로 보지 않는다. 캡챠·로그인·오류 페이지는 제목만 있고
   * 본문이 거의 비어 있어서, 이 문턱이 "차단당한 걸 상품으로 착각하는" 사고를 막는 방어선이다.
   * 구조화 데이터(스토어 내부 데이터·JSON-LD)가 잡히면 증거가 확실하니 이 검사를 건너뛴다.
   */
  const MIN_BODY_TEXT = 200;

  const text = (v: unknown): string =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";

  const firstString = (v: unknown): string => {
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      for (const item of v) {
        const s = firstString(item);
        if (s) return s;
      }
      return "";
    }
    if (v && typeof v === "object") {
      const url = (v as { url?: unknown }).url;
      if (typeof url === "string") return url;
    }
    return "";
  };

  const meta = (selector: string): string => {
    const el = document.querySelector(selector);
    return text(el?.getAttribute("content"));
  };

  /**
   * 본문 텍스트. 상단 메뉴·푸터·추천상품 같은 잡음을 조금이라도 덜기 위해 본문 영역을 먼저 찾고,
   * 마땅한 게 없으면 페이지 전체를 쓴다. 완벽히 걸러낼 방법은 없어서 AI 쪽에도 "관련 없는 글이
   * 섞여 있을 수 있다"고 일러둔다.
   */
  const mainText = (): string => {
    for (const sel of ["main", "[role=main]", "article", "#content", "#container"]) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = text((el as HTMLElement).innerText);
      if (t.length >= MIN_BODY_TEXT) return t;
    }
    return text(document.body?.innerText);
  };

  // ── 1. __PRELOADED_STATE__ (네이버 스토어) ──
  const fromPreloaded = (): ProductPageInfo | null => {
    const state = (window as unknown as { __PRELOADED_STATE__?: unknown }).__PRELOADED_STATE__;
    if (!state || typeof state !== "object") return null;

    // 스토어마다 껍데기가 달라 `product.A`를 먼저 보고, 없으면 이름+가격을 가진 객체를 찾는다.
    const direct = (state as { product?: { A?: unknown } }).product?.A;
    let node: Record<string, unknown> | null =
      direct && typeof direct === "object" ? (direct as Record<string, unknown>) : null;

    if (!node) {
      const queue: unknown[] = [state];
      let steps = 0;
      while (queue.length > 0 && steps < 2000) {
        steps += 1;
        const cur = queue.shift();
        if (!cur || typeof cur !== "object") continue;
        const obj = cur as Record<string, unknown>;
        const hasName = typeof obj.name === "string" && obj.name.length > 0;
        const hasPrice =
          typeof obj.salePrice === "number" || typeof obj.discountedSalePrice === "number";
        if (hasName && hasPrice) {
          node = obj;
          break;
        }
        for (const value of Object.values(obj)) {
          if (value && typeof value === "object") queue.push(value);
        }
      }
    }
    if (!node) return null;

    const name = text(node.name);
    if (!name) return null;

    const price = node.discountedSalePrice ?? node.salePrice;
    const category = node.category as { wholeCategoryName?: unknown } | undefined;
    const images: string[] = [];
    const rep = node.representativeImage as { url?: unknown } | undefined;
    const repUrl = firstString(rep);
    if (repUrl) images.push(repUrl);
    if (Array.isArray(node.images)) {
      for (const img of node.images) {
        const u = firstString(img);
        if (u && !images.includes(u)) images.push(u);
      }
    }

    return {
      url: location.href,
      source: "preloaded",
      title: name,
      description: text(node.detailContentText ?? node.sellerCommentContent) || meta('meta[property="og:description"]'),
      price: typeof price === "number" ? String(price) : undefined,
      category: text(category?.wholeCategoryName) || undefined,
      images,
    };
  };

  // ── 2. JSON-LD ──
  const fromJsonLd = (): ProductPageInfo | null => {
    const blocks = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const block of blocks) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.textContent ?? "");
      } catch {
        continue;
      }
      // @graph로 감싸거나 배열로 오는 경우가 흔하다.
      const candidates: unknown[] = [];
      const push = (v: unknown) => {
        if (Array.isArray(v)) candidates.push(...v);
        else if (v) candidates.push(v);
      };
      push(parsed);
      if (parsed && typeof parsed === "object") push((parsed as { "@graph"?: unknown })["@graph"]);

      for (const c of candidates) {
        if (!c || typeof c !== "object") continue;
        const obj = c as Record<string, unknown>;
        const type = firstString(obj["@type"]);
        if (type !== "Product") continue;
        const name = text(obj.name);
        if (!name) continue;
        const offers = obj.offers as Record<string, unknown> | Record<string, unknown>[] | undefined;
        const offer = Array.isArray(offers) ? offers[0] : offers;
        const image = firstString(obj.image);
        return {
          url: location.href,
          source: "jsonld",
          title: name,
          description: text(obj.description) || meta('meta[property="og:description"]'),
          price: text(offer?.price) || undefined,
          category: text(obj.category) || undefined,
          images: image ? [image] : [],
        };
      }
    }
    return null;
  };

  // ── 3. og: 메타 태그 ──
  // `document.title` 폴백을 쓰지 않는다 — 캡챠·오류 페이지도 제목은 있어서, 그걸 받아주면
  // 차단당한 페이지가 "상품"으로 통과해 뒤 단계가 통째로 엉뚱해진다.
  const fromMeta = (body: string): ProductPageInfo | null => {
    const title = meta('meta[property="og:title"]');
    if (!title || body.length < MIN_BODY_TEXT) return null;
    const image = meta('meta[property="og:image"]');
    return {
      url: location.href,
      source: "meta",
      title,
      description: meta('meta[property="og:description"]') || meta('meta[name="description"]'),
      price: meta('meta[property="product:price:amount"]') || undefined,
      images: image ? [image] : [],
    };
  };

  // ── 4. 본문 텍스트 ──
  const fromText = (body: string): ProductPageInfo | null => {
    const title = text(document.title);
    if (!title || body.length < MIN_BODY_TEXT) return null;
    return {
      url: location.href,
      source: "text",
      title,
      description: "",
      images: [],
      bodyText: body.slice(0, MAX_BODY_TEXT),
    };
  };

  try {
    const body = mainText();
    const info = fromPreloaded() ?? fromJsonLd() ?? fromMeta(body) ?? fromText(body);
    // 구조화 정보를 찾았어도 본문을 같이 넘긴다 — 상품명·카테고리만으로는 강점·셀링포인트가
    // 안 나온다. 그건 상세 설명에 적혀 있다. (상세가 이미지로만 된 페이지는 여기 안 잡힌다.)
    if (info && !info.bodyText && body) info.bodyText = body.slice(0, MAX_BODY_TEXT);
    return info;
  } catch {
    return null;
  }
}
