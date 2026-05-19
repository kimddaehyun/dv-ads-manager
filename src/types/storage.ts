/**
 * 디브이 애드 매니저 — 영속 저장소 데이터 모델.
 *
 * 본 확장은 서버 DB를 보유하지 않는다. 사용자 측 영속 저장소는 `chrome.storage.local`이다.
 *
 * 자격증명 형태(`SearchadCredentials`)는 `src/lib/searchad.ts`에서 단일 객체로 정의·관리한다.
 * 본 파일에서는 캐시 모델만 정의한다.
 */

import type { AdDevice } from "./device";

/**
 * 노출 순위 1~10위. F001/F002/F003 모두 동일 범위 사용 (네이버 검색결과 1페이지 커버).
 *
 * Spike C 결과 (2026-05-15): 네이버 검색광고 API `/estimate/average-position-bid/keyword`는
 * `position` 필드를 1~10만 허용. 11 이상은 400 "position(N) must be lower than 10" 반환.
 */
export type RankPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** 한 번에 조회할 최대 순위. F001 콘텐츠 오버레이 미니 테이블 컬럼 수 (PC 기준). */
export const MAX_POSITION = 10;

/**
 * 디바이스별 허용 최대 순위. 검색광고 API `/estimate/average-position-bid/keyword`가
 * `position` 필드 상한을 디바이스별로 다르게 적용:
 *   - PC: 1~10 (400 `position(N) must be lower than 10`)
 *   - MOBILE: 1~5 (400 `position(N) must be lower than 5`)
 *
 * 모바일 검색결과 페이지가 노출하는 광고 슬롯 수 차이를 반영한 것으로 추정.
 * 호출자는 device를 알고 있을 때 이 맵을 보고 items 범위를 결정해야 400 회피.
 */
export const MAX_POSITION_BY_DEVICE: Record<"PC" | "MOBILE", number> = {
  PC: 10,
  MOBILE: 5,
};

/**
 * F001 — 키워드별 1~10위 예상 입찰가 캐시.
 * chrome.storage.local 키: `volume_cache:<device>:<keyword>`
 *
 * 데이터 소스: `POST /estimate/average-position-bid/keyword` (네이버 검색광고 API).
 * 응답은 시장 단위 추정치 — 호출자 customerId와 무관하지만 device 파라미터(`PC`/`MOBILE`)에
 * 따라 결과가 갈리므로 캐시는 (keyword, device) 단위로 스코프한다.
 */
export interface KeywordVolumeCache {
  /** 정규화된 키워드 (공백 제거, NFC 정규화) */
  keyword: string;
  /** 호출 시의 광고 디바이스 (PC | MOBILE) */
  device: AdDevice;
  /** 노출 순위 → 예상 입찰가 매핑. 응답에서 빠진 순위는 누락 가능 */
  rank_to_bid: Partial<Record<RankPosition, number>>;
  /** 캐시 적재 시각 (ISO date string) */
  fetched_at: string;
}

/**
 * F002/F003 — 쇼핑검색광고 자동매칭 키워드별 현재 순위 캐시.
 * chrome.storage.local 키: `shopping_cache:<product_id>:<keyword>`
 *
 * TODO: 데이터 소스는 TBD (PRD §F002/F003). Spike B 완료 후 인증·필드 확정.
 */
export interface ShoppingRankCache {
  /** 쇼핑 소재 식별자 */
  product_id: string;
  /** 자동매칭 키워드 */
  keyword: string;
  /** 현재 노출 순위. 미노출이면 null */
  rank: number | null;
  /** 캐시 적재 시각 (ISO date string) */
  fetched_at: string;
}

/**
 * F001 — 광고관리자에서 읽어낸 현재 입찰가 스냅샷.
 * chrome.storage.local 키: `current_bid:<keyword>`
 *
 * 콘텐츠 스크립트가 DOM에서 입찰가를 읽고, 그 값과 rank_to_bid를 비교해
 * 현재 추정 순위를 계산한다.
 */
export interface CurrentBidSnapshot {
  /** 정규화된 키워드 */
  keyword: string;
  /** 광고 대시보드에서 읽어낸 현재 입찰가 (원화 단위 정수) */
  current_bid: number;
  /** rank_to_bid 맵을 기준으로 추정한 현재 순위 */
  estimated_rank: number;
  /** DOM에서 읽어낸 시각 (ISO date string) */
  read_at: string;
}

/**
 * F001 — 키워드별 특정 입찰가에서의 예상 성과 지표.
 * chrome.storage.local 키: `performance_cache:<device>:<keyword>:<bid>`
 *
 * 데이터 소스: `POST /estimate/performance-bulk` (네이버 검색광고 API).
 * 키워드 도구 "선택한 키워드" 표의 4지표 — 노출/클릭/CPC/광고비.
 *
 * 캐시 키에 device·bid가 포함되므로 사용자가 광고관리자에서 입찰가를 변경하거나
 * popover에서 디바이스를 토글하면 자동 cache miss.
 */
export interface KeywordPerformanceCache {
  /** 정규화된 키워드 */
  keyword: string;
  /** 호출 시의 광고 디바이스 (PC | MOBILE) */
  device: AdDevice;
  /** 호출 시 보낸 입찰가 (원화 정수) — 같은 키워드라도 bid가 다르면 결과가 다름 */
  bid: number;
  /** 예상 노출수 */
  impressions: number;
  /** 예상 클릭수 */
  clicks: number;
  /** 예상 평균 CPC (원, VAT 제외) */
  cpc: number;
  /** 예상 광고비 (원) */
  salesAmt: number;
  /** 캐시 적재 시각 (ISO date string) */
  fetched_at: string;
}
