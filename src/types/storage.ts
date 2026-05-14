/**
 * 디브이 애드 매니저 — 영속 저장소 데이터 모델.
 *
 * 본 확장은 서버 DB를 보유하지 않는다. 사용자 측 영속 저장소는 `chrome.storage.local`이며,
 * 라이선스 검증만 Supabase의 기존 RPC를 호출한다.
 *
 * 본 파일은 본 repo 전용 타입만 정의 — naver-tag-picker와 공유되는 타입은
 * `src/types/index.ts`에 그대로 둔다 (코어 동기화 정책).
 *
 * 자격증명 자체의 형태(`SearchadCredentials`)는 코어 라이브러리 `src/lib/searchad.ts`에
 * 정의돼 있고 본 확장도 그대로 단일 객체로 사용한다. 본 파일에서는 캐시 모델만 정의한다.
 */

import type { LicenseTier } from "./index";

/**
 * F010 — 라이선스 검증 결과 영속 저장.
 * chrome.storage.local 키: `license`
 *
 * 디바이스 ID와 키만 외부(Supabase RPC `verify_access`)로 전송된다.
 */
export interface LicenseState {
  /** 사용자가 입력한 라이선스 키 원문 */
  key: string;
  /** 본 확장이 디바이스를 식별하기 위해 생성한 UUID */
  device_id: string;
  /** Supabase RPC가 반환한 등급. MVP는 `basic` 단일이며 `brand`는 자매 호환 필드 */
  tier: LicenseTier;
  /** 라이선스 만료 일시 (ISO date string). null이면 무제한 */
  expires_at: string | null;
  /** 마지막 검증 성공 시각 (ISO date string) */
  verified_at: string;
}

/** 노출 순위 1~10위. F001/F002/F003 모두 동일 범위 사용 */
export type RankPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * F001 — 키워드별 1~10위 예상 입찰가 캐시.
 * chrome.storage.local 키: `volume_cache:<keyword>`
 *
 * 데이터 소스: `POST /estimate/average-position-bid/keyword` (네이버 검색광고 API).
 * 응답은 시장 단위 추정치 — 호출자 customerId와 무관하게 동일하므로 캐시는 키워드 단위로만 스코프.
 */
export interface KeywordVolumeCache {
  /** 정규화된 키워드 (공백 제거, NFC 정규화) */
  keyword: string;
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
