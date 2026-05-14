/**
 * 네이버 스마트스토어 셀러 어드민의 "상품 경쟁지표" API.
 * 키워드로 1~100위 상품의 순위·지수(8개 별점)를 한 번에 반환한다.
 * 브랜드 스토어 계정으로 sell.smartstore.naver.com 에 로그인되어 있어야 동작한다.
 *
 * 엔드포인트:
 *   GET /api/product/shared/product-search-popular
 *       ?_action=productSearchPopularByKeyword&keyword=...
 */

import type {
  ProductPopularProduct,
  ProductPopularResult,
} from "@/types";

const ENDPOINT =
  "https://sell.smartstore.naver.com/api/product/shared/product-search-popular";

export async function fetchProductSearchPopular(
  keyword: string,
): Promise<ProductPopularResult> {
  const trimmed = keyword.trim();
  if (!trimmed) throw new Error("키워드가 비어 있습니다.");

  const url = new URL(ENDPOINT);
  url.searchParams.set("_action", "productSearchPopularByKeyword");
  url.searchParams.set("keyword", trimmed);

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      accept: "*/*",
      referer: "https://sell.smartstore.naver.com/",
      "x-current-state":
        "https://sell.smartstore.naver.com/#/search-popular/product",
      "x-current-statename": "main.search-popular-stats.product",
      "x-to-statename": "main.search-popular-stats.product",
    },
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "브랜드 스토어 계정으로 sell.smartstore.naver.com 에 로그인해주세요.",
    );
  }
  if (!res.ok) throw new Error(`상품 경쟁지표 API ${res.status}`);

  const json = (await res.json()) as {
    result?: {
      searchKeyword?: string;
      searchTime?: string;
      products?: ProductPopularProduct[];
    };
  };
  const r = json.result;
  if (!r || !Array.isArray(r.products)) {
    throw new Error("상품 경쟁지표 응답 형식 오류");
  }
  return {
    searchKeyword: r.searchKeyword ?? trimmed,
    searchTime: r.searchTime ?? new Date().toISOString(),
    products: r.products,
  };
}
