/**
 * 디브이 애드 매니저 — 영속 저장소 데이터 모델.
 *
 * 본 확장은 서버 DB를 보유하지 않는다. 사용자 측 영속 저장소는 `chrome.storage.local`이며,
 * 라이선스 검증만 Supabase의 기존 RPC를 호출한다.
 *
 * 본 파일은 본 repo 전용 타입만 정의 — naver-tag-picker와 공유되는 타입은
 * `src/types/index.ts`에 그대로 둔다 (코어 동기화 정책).
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

/**
 * F011 — 광고주별 검색광고 API 자격증명. 광고주(customer_id)별로 N개 등록되는 리스트.
 * chrome.storage.local 키: `searchad_credentials` (배열)
 *
 * 대행사 AE가 운영하는 여러 광고주를 한 확장에서 다룰 수 있게 함.
 * 비밀값은 `chrome.storage.local`에만 저장되며 외부로 전송되지 않는다.
 */
export interface SearchadCredential {
  /** 네이버 검색광고 광고주 ID. 매칭 키이자 unique constraint */
  customer_id: string;
  /** 사용자가 붙인 별칭 (예: "A고객사"). 식별성 강화용 */
  label: string;
  /** 검색광고 API 액세스 라이선스 */
  access_license: string;
  /** 검색광고 API 시크릿 키 (HMAC 서명용) */
  secret_key: string;
  /** 등록 시각 (ISO date string) */
  created_at: string;
}

/**
 * F013 — 활성 광고주 정보 (휘발성).
 * `chrome.storage.session` 또는 콘텐츠 스크립트 메모리에 보관.
 *
 * 콘텐츠 스크립트가 ads.naver.com DOM/URL에서 customerId를 추출 → 등록된 자격증명과 매칭.
 * 콘텐츠 오버레이·팝업이 이 정보를 공통 소비.
 */
export interface ActiveAdvertiser {
  /** 호스트 페이지 DOM/URL에서 추출한 현재 광고주 ID */
  customer_id: string;
  /** 매칭된 SearchadCredential 참조 (없으면 null) */
  matched_credential: SearchadCredential | null;
  /** 감지 시각 (ISO date string) */
  detected_at: string;
}

/** 노출 순위 1~10위. F001/F002/F003 모두 동일 범위 사용 */
export type RankPosition = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * F001 — 키워드별 1~10위 예상 입찰가 캐시.
 * chrome.storage.local 키: `volume_cache:<customer_id>:<keyword>`
 *
 * 데이터 소스: `POST /estimate/average-position-bid/keyword` (네이버 검색광고 API).
 * 광고주별로 캐시 분리 — 같은 키워드라도 광고주마다 추정치가 다를 수 있음.
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
 * chrome.storage.local 키: `current_bid:<customer_id>:<keyword>`
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
