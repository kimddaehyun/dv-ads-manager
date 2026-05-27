/**
 * 네이버 스마트스토어·브랜드스토어 상품 페이지에서 이미지 후보를 추출.
 *
 * 사용자가 일괄 등록 팝업의 링크 입력란에 상품 페이지 URL을 붙여넣으면 호출된다.
 * background가 hidden tab으로 페이지를 열고 그 안의 콘텐츠 스크립트(product-page-scrape.ts)가
 * DOM에서 갤러리 이미지를 수집한다. SPA hydration 후 실제 DOM을 보므로 SSR fetch보다 정확.
 *
 * 본 모듈 책임:
 *   - 입력 URL parsing + 검증
 *   - background에 FETCH_PRODUCT_PAGE 메시지 전달 + 응답 받기
 *   - popup 사이클 단위 메모리 캐시
 */

import type { FetchProductPageResponse } from "@/types/messages";

export type ProductPageHost = "smartstore" | "brand";

export interface ExtractResult {
  candidates: string[];
  resolvedUrl: string;
  host: ProductPageHost;
}

const HOST_FOR: Record<ProductPageHost, string> = {
  smartstore: "smartstore.naver.com",
  brand: "brand.naver.com",
};

const URL_PATTERN =
  /^https?:\/\/(?:m\.)?(smartstore|brand)\.naver\.com\/([^/?#]+)\/products\/(\d+)/i;

interface ParsedUrl {
  host: ProductPageHost;
  storeSlug: string;
  productId: string;
  canonicalUrl: string;
}

// popup 사이클 동안 같은 URL 재펼침은 즉시 — promise 캐시(in-flight 중복 호출도 safe).
const cache = new Map<string, Promise<ExtractResult>>();

export function clearProductPageCache(): void {
  cache.clear();
}

export async function resolveAndExtract(rawInput: string): Promise<ExtractResult> {
  const input = (rawInput ?? "").trim();
  if (!input) throw new Error("상품 링크를 입력해 주세요");

  const parsed = parseUrl(input);
  if (!parsed) {
    throw new Error(
      "스마트스토어 또는 브랜드스토어 상품 페이지 주소만 가능해요",
    );
  }

  const key = parsed.canonicalUrl;
  let promise = cache.get(key);
  if (!promise) {
    promise = requestFromBackground(parsed);
    cache.set(key, promise);
    promise.catch(() => cache.delete(key));
  }
  return promise;
}

function parseUrl(input: string): ParsedUrl | null {
  const m = URL_PATTERN.exec(input);
  if (!m) return null;
  const host = m[1].toLowerCase() as ProductPageHost;
  const storeSlug = m[2];
  const productId = m[3];
  const canonicalUrl = `https://${HOST_FOR[host]}/${storeSlug}/products/${productId}`;
  return { host, storeSlug, productId, canonicalUrl };
}

async function requestFromBackground(parsed: ParsedUrl): Promise<ExtractResult> {
  let response: FetchProductPageResponse;
  try {
    response = (await chrome.runtime.sendMessage({
      type: "FETCH_PRODUCT_PAGE",
      url: parsed.canonicalUrl,
    })) as FetchProductPageResponse;
  } catch (e) {
    console.warn("[dv-ads/product-page-extract] sendMessage failed", e);
    throw new Error("페이지를 새로고침한 뒤 다시 시도해 주세요");
  }
  if (!response?.ok || !response.candidates) {
    throw new Error(response?.error ?? "상품 페이지를 불러오지 못했어요");
  }
  return {
    candidates: response.candidates,
    resolvedUrl: parsed.canonicalUrl,
    host: parsed.host,
  };
}
