/**
 * 디브이 애드 매니저 — chrome.runtime 메시지 계약.
 *
 * background는 얇은 라우터 — 메시지 타입별로 분기해 lib/ 호출만 한다.
 * 콘텐츠 스크립트·팝업·옵션 페이지는 이 타입에 맞춰 sendMessage 호출.
 *
 * 신규 메시지 추가 시:
 *   1. 본 파일에 Request·Response 인터페이스 추가
 *   2. ExtensionMessage / ExtensionResponse 유니온에 등록
 *   3. background/index.ts 라우터에 핸들러 분기 추가
 */

import type {
  KeywordVolumeCache,
  KeywordPerformanceCache,
  ShoppingRankCache,
} from "./storage";
import type { AdDevice } from "./device";

/** 옵션 페이지 열기 */
export interface OpenOptionsRequest {
  type: "OPEN_OPTIONS";
}

export interface OpenOptionsResponse {
  ok: true;
}

/**
 * F001 — 키워드별 1~10위 예상 입찰가 + (선택) 성과 추정 일괄 조회.
 *
 * background:
 *   - `POST /estimate/average-position-bid/keyword` → 1~10위 시장 입찰가
 *   - currentBid가 있는 키워드에 대해 `POST /estimate/performance-bulk` → 4지표
 *   - 두 API 병렬 호출 + 각각 별도 캐시
 *
 * 자격증명이 없으면 `has_credential: false`로 응답 (콘텐츠 스크립트는 안내 배지로 폴백).
 * 검색광고 API 응답은 시장 단위 추정치 — 어떤 자격증명으로 호출해도 같은 숫자가 나오지만
 * `device` 파라미터에 따라 (PC | MOBILE) 시장이 달라진다. 모바일이 default 호출이고
 * popover에서 사용자가 PC 토글 시 추가 호출.
 */
export interface GetBidEstimateRequest {
  type: "GET_BID_ESTIMATE";
  /** 키워드별 요청 — currentBid 있으면 성과 추정도 함께 받음 */
  keywords: Array<{ keyword: string; currentBid: number | null }>;
  /** 광고 디바이스 (PC | MOBILE). 한 요청은 단일 device. */
  device: AdDevice;
}

export interface GetBidEstimateResponse {
  ok: boolean;
  data?: KeywordVolumeCache[];
  /** 성과 추정 결과 — currentBid가 있던 키워드만 포함 (없거나 호출 실패 시 omit) */
  performance?: KeywordPerformanceCache[];
  /** 요청 시 보낸 device를 echo — 콘텐츠 스크립트가 race 시 응답 식별용 */
  device?: AdDevice;
  error?: string;
  /** 자격증명이 등록돼 있지 않으면 false */
  has_credential?: boolean;
}

/**
 * F002/F003 — 쇼핑검색광고 소재의 자동매칭 키워드별 순위·예상 입찰가.
 *
 * TODO: Spike B 완료 후 페이로드 확정. 현재는 placeholder 시그니처.
 */
export interface GetProductRankRequest {
  type: "GET_PRODUCT_RANK";
  product_id: string;
}

export interface GetProductRankResponse {
  ok: boolean;
  data?: ShoppingRankCache[];
  error?: string;
}

/**
 * F012 — 팝업이 활성 탭의 캐시 강제 갱신 트리거.
 *
 * background: 활성 탭의 콘텐츠 스크립트에 재조회 트리거 메시지를 보내
 * 키워드 캐시를 만료 후 재조회하게 한다. (전체 캐시 클리어 X)
 */
export interface RefreshActiveTabRequest {
  type: "REFRESH_ACTIVE_TAB";
}

export interface RefreshActiveTabResponse {
  ok: boolean;
  /** 재조회 트리거된 키워드 수 (성공 시) */
  count?: number;
  error?: string;
}

/**
 * F-MultiAccount — content → background. 다른 광고계정의 어제/비즈머니/계약 데이터 수집 위임.
 * background는 hidden tab으로 해당 계정 페이지 열고 그 콘텐츠 스크립트에
 * MULTI_ACCOUNT_COLLECT_ACTIVE 보낸 뒤 응답을 전달 + tab 정리.
 */
export interface MultiAccountCollectAccountRequest {
  type: "MULTI_ACCOUNT_COLLECT_ACCOUNT";
  adAccountNo: number;
}

export interface MultiAccountCollectResponse {
  ok: boolean;
  bizMoney?: number | null;
  yesterday?: {
    impressions: number;
    clicks: number;
    cpc: number;
    cost: number;
    conversionValue: number;
    conversions: number;
  } | null;
  contracts?: Array<{
    product: string;
    campaignTp: string;
    endDate: string;
    status: string;
  }>;
  error?: string;
}

/**
 * F-AssetBulk V2 — content(ads.naver.com) → background. 상품 페이지에서 이미지 후보 수집.
 * background는 hidden tab으로 상품 페이지를 열고 그 안의 콘텐츠 스크립트(product-page-scrape.ts)에
 * SCRAPE_PRODUCT_IMAGES 메시지를 보내 응답을 받음. SPA hydration 후 실제 DOM에서 추출하므로
 * SSR HTML 직접 fetch보다 정확.
 */
export interface FetchProductPageRequest {
  type: "FETCH_PRODUCT_PAGE";
  url: string;
}

export interface FetchProductPageResponse {
  ok: boolean;
  /** ok=true면 후보 이미지 URL 배열 */
  candidates?: string[];
  /** ok=false면 사용자 친화 한글 메시지 */
  error?: string;
}

/**
 * F-AssetBulk V2 — background → 상품 페이지 콘텐츠 스크립트. DOM 갤러리에서 이미지 URL 추출.
 */
export interface ScrapeProductImagesRequest {
  type: "SCRAPE_PRODUCT_IMAGES";
}

export interface ScrapeProductImagesResponse {
  ok: boolean;
  urls?: string[];
  error?: string;
}

/**
 * F-AssetBulk V2 — content → background. 사용자가 후보 중 선택한 이미지의 binary fetch.
 * 콘텐츠 스크립트의 origin(ads.naver.com)에서 shop-phinf.pstatic.net에 직접 fetch하면 CORS에 막힘.
 * background는 host_permissions 기반으로 fetch 후 ArrayBuffer + MIME으로 응답.
 */
export interface FetchImageBinaryRequest {
  type: "FETCH_IMAGE_BINARY";
  url: string;
}

export interface FetchImageBinaryResponse {
  ok: boolean;
  /**
   * ok=true면 base64 encoded binary. Chrome MV3의 chrome.runtime.sendMessage가 ArrayBuffer를
   * JSON serialize해서 `{}`로 손실시키는 동작 회피. content가 atob + Uint8Array로 복원.
   */
  base64?: string;
  mimeType?: string;
  error?: string;
}

/** 모든 in-bound 메시지 유니온 */
export type ExtensionMessage =
  | OpenOptionsRequest
  | GetBidEstimateRequest
  | GetProductRankRequest
  | RefreshActiveTabRequest
  | MultiAccountCollectAccountRequest
  | FetchProductPageRequest
  | ScrapeProductImagesRequest
  | FetchImageBinaryRequest;

/** 모든 out-bound 응답 유니온 */
export type ExtensionResponse =
  | OpenOptionsResponse
  | GetBidEstimateResponse
  | GetProductRankResponse
  | RefreshActiveTabResponse
  | MultiAccountCollectResponse
  | FetchProductPageResponse
  | ScrapeProductImagesResponse
  | FetchImageBinaryResponse;
