/**
 * F-Setup — 세팅안(광고 세팅 제안서) 엑셀 데이터 모델.
 *
 * 광고대행사가 선택한 캠페인의 캠페인-광고그룹-소재-키워드 계층 + 예산/타겟팅/입찰가/예상순위를
 * 단일 엑셀로 내려받기 위한 정규화 모델. 수집은 콘텐츠 스크립트에서 ads.naver.com internal API
 * 호출(`src/features/setup/setup-data.ts`), 유형별 schema 차이는 `src/features/setup/setup-adapters.ts`가 흡수.
 *
 * endpoint schema 정찰 결과는 메모리 `project_f_setup_endpoints` 참조.
 */

/** ncc 캠페인 타입 풀네임 (campaignType 파라미터 값). */
export type CampaignTypeCode =
  | "WEB_SITE"
  | "SHOPPING"
  | "BRAND_SEARCH"
  | "POWER_CONTENTS"
  | "PLACE";

/** 광고그룹 단위 타겟팅 설정 — 사람이 읽을 수 있는 한글 문자열로 정규화. */
export interface SetupTargeting {
  /** PC/모바일 노출. 예: "PC, 모바일" / "PC만" / "모바일만" */
  device: string;
  /** 지역 타겟. 미설정이면 "전체" */
  region: string;
  /** 요일/시간 타겟. 미설정이면 "전체" */
  schedule: string;
  /** 매체(소재 노출 위치) 제한. 예: "전체" / "일부 제한" */
  media: string;
  /** 소재 노출 방식 (adRollingType). 예: "성과 기반 노출" / "균등 노출" */
  adRolling: string;
}

/** 광고 소재 — 유형별 ad 객체를 공통 4필드로 정규화. */
export interface SetupAd {
  /** 원본 type code (예: TEXT_45, SHOPPING_PRODUCT_AD) */
  type: string;
  /** 한글 소재 유형 라벨 */
  typeLabel: string;
  /** 소재 제목/대표명 */
  title: string;
  /** 소재 설명/본문 */
  body: string;
  /** 연결 URL (있는 경우) */
  url: string;
  /** 이미지 URL (쇼핑 소재 등). 엑셀에 이미지로 삽입. 없으면 "" */
  imageUrl: string;
}

/** 키워드 + 입찰가 + 예상 순위. */
export interface SetupKeyword {
  keyword: string;
  /** 실효 입찰가 (그룹 기본입찰가 상속 시 그룹값) */
  bidAmt: number;
  /** 그룹 기본입찰가 상속 여부 (useGroupBidAmt) */
  inheritedFromGroup: boolean;
  /** 예상 순위. number=1~10위, "out"=10위 밖, null=미조회/조회실패 */
  rank: number | "out" | null;
}

export interface SetupAdgroup {
  id: string;
  name: string;
  /** 그룹 기본 입찰가 (bidAmt) */
  groupBid: number;
  /** 일예산 (원). null = 제한없음(useDailyBudget false) */
  dailyBudget: number | null;
  targeting: SetupTargeting;
  ads: SetupAd[];
  keywords: SetupKeyword[];
}

export interface SetupCampaign {
  id: string;
  name: string;
  typeCode: CampaignTypeCode;
  /** 한글 캠페인 유형 라벨 (예: "파워링크") */
  typeLabel: string;
  /** 일예산 (원). null = 제한없음 */
  dailyBudget: number | null;
  adgroups: SetupAdgroup[];
}

/** 캠페인 선택 popover에 표시할 경량 항목 (계층 수집 전). */
export interface SetupCampaignChoice {
  id: string;
  name: string;
  typeCode: CampaignTypeCode;
  typeLabel: string;
  dailyBudget: number | null;
  /** ELIGIBLE / PAUSED 등 */
  status: string;
}

/** 수집 진행 콜백 — UI 진행률 표시용. */
export type SetupProgress = (done: number, total: number, label: string) => void;
