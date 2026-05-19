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
 * 검색광고 API 응답은 시장 단위 추정치 — 어떤 자격증명으로 호출해도 같은 숫자가 나오므로
 * 광고주 매칭 개념은 적용하지 않는다.
 */
export interface GetBidEstimateRequest {
  type: "GET_BID_ESTIMATE";
  /** 키워드별 요청 — currentBid 있으면 성과 추정도 함께 받음 */
  keywords: Array<{ keyword: string; currentBid: number | null }>;
}

export interface GetBidEstimateResponse {
  ok: boolean;
  data?: KeywordVolumeCache[];
  /** 성과 추정 결과 — currentBid가 있던 키워드만 포함 (없거나 호출 실패 시 omit) */
  performance?: KeywordPerformanceCache[];
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

/** 모든 in-bound 메시지 유니온 */
export type ExtensionMessage =
  | OpenOptionsRequest
  | GetBidEstimateRequest
  | GetProductRankRequest
  | RefreshActiveTabRequest;

/** 모든 out-bound 응답 유니온 */
export type ExtensionResponse =
  | OpenOptionsResponse
  | GetBidEstimateResponse
  | GetProductRankResponse
  | RefreshActiveTabResponse;
