/**
 * 디브이 애드 매니저 — 영속 저장소 데이터 모델.
 *
 * 본 확장은 서버 DB를 보유하지 않는다. 사용자 측 영속 저장소는 `chrome.storage.local`이다.
 *
 * 자격증명 형태(`SearchadCredentials`)는 `src/shared/searchad.ts`에서 단일 객체로 정의·관리한다.
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

/**
 * F-MultiAccount — 광고계정 자동 명단 디렉터리 캐시.
 * chrome.storage.local 단일 키: `multi_account_directory`
 *
 * 데이터 소스: `GET /apis/ad-account/v1.1/adAccounts/access` (광고관리자 internal API).
 * 콘텐츠 스크립트가 ads.naver.com 첫 로드 시 자동 수집 후 캐시. 옵션 페이지는 이 캐시를 읽어서
 * 사용자 편집 메타(MultiAccountUserMeta)와 합쳐서 표시한다.
 */
export interface MultiAccountDirectoryEntry {
  /** 광고계정 번호 */
  adAccountNo: number;
  /** 서버측 광고계정명 */
  name: string;
  /** 계정 플랫폼 태그 SA(검색광고) | GFA(디스플레이). 어제 데이터는 옵션 플랫폼 필터에 따라 SA/GFA 합산 */
  adPlatformType: string;
  /** 사용자 권한 (MASTER / OPERATOR / VIEWER 등) */
  roleName: string;
  /** 서버측 즐겨찾기 (사용자 메타 favorite과 OR 결합) */
  serverFavorite: boolean;
  /** 마지막 접속 시각 (ISO 8601) */
  lastAccessTime: string;
  /** masterCustomerId — 검색광고 API customerId와 동일 */
  masterCustomerId?: number;
  /** 비활성/삭제 계정은 리스트에서 제외 */
  disabled?: boolean;
  deleted?: boolean;
}

export interface MultiAccountDirectoryCache {
  /** 캐시 적재 시각 (ISO date string) */
  fetched_at: string;
  /** 전체 광고계정 명단 (페이지네이션 누적) */
  entries: MultiAccountDirectoryEntry[];
}

/**
 * F-MultiAccount — 광고계정 사용자 편집 메타.
 * chrome.storage.local 단일 키: `multi_account_user_meta` (Record<adAccountNo, MultiAccountUserMeta>)
 *
 * 광고계정 명단 자체는 `/apis/ad-account/v1.1/adAccounts/access`로 자동 수집(디렉터리 캐시).
 * 그 디렉터리에서 사용자가 명시적으로 "추가"한 것만 popover에 표시(별도 키 `multi_account_added_list`).
 * 본 모델은 추가된 계정의 별칭만 관리한다.
 */
export interface MultiAccountUserMeta {
  /** 광고계정 번호 (광고관리자 URL ad-accounts/{adAccountNo}) */
  adAccountNo: number;
  /** 사용자 별칭. 비어있으면 서버의 adAccount.name 사용 */
  displayName?: string;
  /** 즐겨찾기 — true면 1시간마다 자동 갱신 + 리스트 상단 정렬 */
  favorite?: boolean;
  /** 비즈머니 알림 임계값 (원). 비즈머니가 이 값 이하면 알림. undefined = 비활성 */
  bizMoneyThreshold?: number;
  /** 브랜드검색 최소 D-day 알림 임계값 (일). 최소 dday가 이 값 이하면 알림. undefined = 비활성 */
  brandSearchDaysThreshold?: number;
  /**
   * 변경이력 알림 켜기. 켠 계정만 30분마다 변경이력을 훑는다. undefined = 비활성.
   * 광고주가 직접 운영하는 계정은 외부 수정이 정상이라 알림이 소음이 되므로 계정별 선택.
   */
  changeWatch?: boolean;
  /**
   * 목표 광고수익률(%). F-Brief 키워드 구간 분류(초록/노랑/무색) 기준.
   * undefined = 미설정 - 구간 분류 후보를 만들지 않는다(자동 추정 안 함).
   */
  targetRoas?: number;
  /** F-Brief 이 광고주의 보고 유형 기억 (사후보고/사전제안). undefined = 기본(사후보고). */
  briefReportType?: "post_action_report" | "pre_action_proposal";
  /** F-Brief 이 광고주의 보고 톤 기억. undefined = 기본(상세하게). */
  briefTone?: "short" | "detailed" | "numeric" | "soft" | "professional" | "friendly";
  /** F-Brief 이슈 기준 민감도. undefined = 보통(광고비 규모 자동 보정). */
  briefSensitivity?: "sensitive" | "normal" | "loose" | "custom";
  /** F-Brief 이슈 기준 직접 설정값 — briefSensitivity === "custom"일 때만 사용. */
  briefThresholds?: {
    costFloor?: number;
    skewRatio?: number;
    adImpFloor?: number;
    lowCtrPct?: number;
    lowRankFloor?: number;
    revenueDropFloor?: number;
  };
}

/**
 * F-MultiAccount — 팀원별(등) 계정 그룹.
 * chrome.storage.local 단일 키: `multi_account_groups` (MultiAccountGroup[])
 *
 * "내 계정"(`multi_account_added_list`) 위에 얹는 이름 붙은 계정 묶음. 한 계정이 여러 그룹에
 * 동시 소속 가능하므로 그룹이 자기 멤버 목록(accountNos)을 들고 있는 모델. 계정 메타
 * (MultiAccountUserMeta)와는 분리 저장한다.
 */
export interface MultiAccountGroup {
  /** 그룹 식별자 (crypto.randomUUID()) */
  id: string;
  /** 그룹 이름 (팀원명 등, 최대 24자) */
  name: string;
  /** 표시 순서 (오름차순) */
  order: number;
  /** 이 그룹에 속한 광고계정 번호 (한 계정이 여러 그룹에 중복 가능) */
  accountNos: number[];
}

/**
 * F-MultiAccount — 각 광고계정의 어제 데이터/비즈머니/계약 캐시 스냅샷.
 * chrome.storage.local 키: `multi_account_snapshot:<adAccountNo>` — 10분 TTL stale-while-revalidate.
 *
 * 수집 방식: background tab으로 해당 계정 페이지를 active:false로 열어 콘텐츠 스크립트가
 * 비즈머니/계약/stats를 호출한 뒤 응답. 자세한 사유는 메모리
 * `project_f_multiaccount_cross_account_decision` 참조.
 */
export interface MultiAccountSnapshot {
  adAccountNo: number;
  /** 어제 8지표 합산 (광고계정 전체 캠페인). 수집 실패 시 null */
  yesterday: {
    impressions: number;
    clicks: number;
    ctr: number;         // 클릭률 % = clicks/impressions * 100
    cpc: number;         // 평균 CPC (원)
    cost: number;        // 총비용 (원)
    revenue: number;     // 전환매출 (원)
    conversions: number; // 전환수
    roas: number;        // ROAS % = revenue/cost * 100
  } | null;
  /** 비즈머니 잔액 = refundableAmt + nonRefundableAmt (원). 수집 실패 시 null */
  bizMoney: number | null;
  /**
   * 광고주센터 알림 피드 중 프로모션(type=PROMOTION) 제외분 = 계정 이슈.
   * 미수집(구 캐시)이면 undefined, 수집 실패면 빈 배열.
   */
  issues?: { type: string; title: string }[];
  /**
   * BRAND_SEARCH 등 기간 계약. 광고그룹별 currentTimeContract + nextTimeContract 모두 row로
   * 포함 — 캠페인 단위 max(endDate)로 "후속 계약 마련됨" 판정 가능.
   * 계약 없으면 빈 배열.
   */
  contracts: {
    product: string;        // contractName (e.g. "PC.4.10 ~ 7.08")
    campaignTp: string;     // "BRAND_SEARCH" 등
    endDate: string;        // ISO 8601 UTC (contractEndDt)
    status: string;         // contractStatus (e.g. "ON_EXPOSING")
    /** 소속 캠페인 ID — 캠페인 단위 그룹핑용. 매핑 못 잡으면 빈 문자열. */
    nccCampaignId: string;
    /** "current" = 현재 진행 중, "next" = 예약된 다음 계약 */
    phase: "current" | "next";
  }[];
  /** 캐시 적재 시각 (ISO date string) */
  fetched_at: string;
  /** 수집 중 실패 사유 (사용자 친화 한글 메시지) */
  error?: string;
}

/**
 * F-ChangeWatch — 변경이력 알림 1건.
 *
 * 데이터 소스: `POST /apis/sa/api/histories/_search` (정찰 결과는 메모리
 * `project_f_changewatch_endpoints` 참조).
 */
export interface ChangeWatchEvent {
  /** 응답 eventId — 중복 제거 + 읽음 처리 키 */
  id: string;
  /** 발생 시각 (epoch ms) */
  ts: number;
  /** budget = 예산 초과로 중단(ncc.charge.*_LOCK), external = 우리 목록에 없는 사람이 수정 */
  kind: "budget" | "external";
  /** 변경자 표시명(actorDisplayName). budget은 시스템이 올린 거라 빈 문자열 */
  actor: string;
  /** 대상 이름 (캠페인/광고그룹명). 못 잡으면 빈 문자열 */
  target: string;
  /** 사람이 읽는 한 줄 요약 (예: "일예산 10,000원 -> 15,000원") */
  summary: string;
}

/**
 * F-ChangeWatch — 광고계정별 변경이력 알림 상태.
 * chrome.storage.local 키: `change_watch_state:<adAccountNo>`
 *
 * 조회 창(window)은 고정 기간이 아니라 "직전 점검 이후"다. `scanned_until`이 다음 조회의
 * since가 되어 놓치는 이력도, 중복 알림도 없다. 첫 점검만 CHANGE_WATCH_BOOTSTRAP_MS 만큼
 * 거슬러 올라간다.
 */
export interface ChangeWatchState {
  adAccountNo: number;
  /** 아직 확인 안 한 알림만. 확인한 건 다시 안 뜨므로 저장하지 않는다 (CHANGE_WATCH_KEEP_MS 참조) */
  events: ChangeWatchEvent[];
  /** 이 시각(epoch ms)까지 조회 완료 — 다음 조회의 since */
  scanned_until: number;
  /**
   * 읽음 기준 (epoch ms). ts가 이 값 이하인 알림은 확인된 것으로 침묵.
   * 예산/수정을 따로 확인할 수 있어야 해서 종류별로 나눠 기억한다 — 하나로 두면 예산만
   * 확인했는데 그보다 오래된 수정 알림까지 같이 사라진다.
   */
  read_budget_up_to: number;
  read_external_up_to: number;
  /** 마지막 점검 시각 (ISO date string) */
  fetched_at: string;
  /** 점검 실패 사유 (사용자 친화 한글 메시지) */
  error?: string;
}
