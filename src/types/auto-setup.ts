/**
 * F-AutoSetup — 링크 하나로 광고 세팅 (AX 2호) 공용 타입.
 *
 * ncc 쓰기 API의 본문 형태는 docs/superpowers/specs/2026-08-14-f-autosetup-ncc-write-recon.md
 * (2026-08-14 라이브 정찰) 기준.
 */

/** 세팅 대상 광고 유형. 파워링크 = 키워드 중심, 쇼핑 = 상품 중심으로 흐름이 갈린다. */
export type AutoSetupAdType = "WEB_SITE" | "SHOPPING";

/**
 * 링크에서 읽어낸 페이지 정보 = **사실**. 여기서 AI가 지어낸 것은 하나도 없다.
 * `source`는 어느 경로로 읽었는지 — `text`면 정확도가 낮으니 사용자에게 확인을 더 받는다.
 */
export interface ProductPageInfo {
  url: string;
  source: "preloaded" | "jsonld" | "meta" | "text";
  title: string;
  description: string;
  price?: string;
  category?: string;
  images: string[];
  /** 구조화 정보를 못 찾았을 때만 채운다 — AI에 넘길 본문 발췌. */
  bodyText?: string;
}

/**
 * AI가 페이지를 읽고 정리한 상품 이해. **사용자 확인 게이트를 거친다**(설계 §5.2) —
 * 여기가 틀리면 그 뒤 초안이 통째로 틀리므로, 키워드 200개를 훑기 전에 한 줄로 판별시킨다.
 */
export interface ProductUnderstanding {
  /** 업종 (예: "반려동물 사료 판매") */
  business: string;
  /** 무엇을 파는가 */
  product: string;
  priceRange?: string;
  /** 누구에게 */
  targets: string[];
  /** 강점·셀링포인트 */
  strengths: string[];
  /** 지역 기반 서비스인가 (매장 방문형) */
  isLocal: boolean;
  /**
   * 네이버 키워드 도구에 넣을 씨앗. **최종 등록 키워드가 아니다** —
   * 등록 대상은 100% 네이버가 돌려준 것에서만 고른다(설계 §3 철칙).
   */
  seedKeywords: string[];
}

/** 만든 것을 되돌리기 위한 기록. 캠페인을 지우면 하위가 같이 사라진다(실측). */
export interface AutoSetupLedger {
  customerId: number;
  /** 우리가 만든 캠페인. 되돌리기는 이것만 지우면 하위까지 정리된다. */
  campaignIds: string[];
  /** 우리가 만든 비즈채널. 캠페인과 별개라 따로 지운다. */
  channelIds: string[];
}

export interface CreateCampaignInput {
  name: string;
  adType: AutoSetupAdType;
  /** 원 단위. 50 ~ 1,000,000,000, 10원 단위. */
  dailyBudget: number;
}

export interface CreateSiteChannelInput {
  /** 비즈채널 이름 - 관리용, 노출되지 않음. 30자. */
  name: string;
  /** 사이트 이름 - 검색결과에 노출됨. 10자. */
  siteName: string;
  /** 프로토콜 포함 전체 URL. */
  url: string;
}

export interface CreateAdgroupInput {
  nccCampaignId: string;
  name: string;
  adType: AutoSetupAdType;
  /** 비즈채널 ID. 파워링크는 SITE, 쇼핑은 MALL 채널. */
  channelId: string;
  /** 채널 URL(파워링크) 또는 쇼핑몰 URL. */
  channelKey: string;
  /** 기본 입찰가. 70 ~ 100,000, 10원 단위. */
  bidAmt: number;
  /** 미지정이면 그룹 예산 제한 없음. */
  dailyBudget?: number;
}

/** 파워링크 반응형 소재. 제목은 최소 3개가 필수. */
export interface CreateRsaAdInput {
  nccAdgroupId: string;
  /** 각 15자. 3~7개. */
  headlines: string[];
  /** 각 45자. 1~4개. */
  descriptions: string[];
  pcUrl: string;
  mobileUrl: string;
}

/** 쇼핑몰 상품형 소재 = 상품 그 자체. */
export interface CreateShoppingAdInput {
  nccAdgroupId: string;
  /** 네이버쇼핑 상품 ID (상품 조회 응답의 `id`). 링크 속 번호와 다르다. */
  referenceKeys: string[];
  /**
   * 소재 입찰가. **그룹 입찰가를 그대로 쓸 때도 값을 넣는다** — 화면이 그렇게 보낸다
   * (`{useGroupBidAmt: true, bidAmt: 50}`). 상속이면 그룹 입찰가를 그대로 넘길 것.
   */
  bidAmt: number;
  /** false면 이 소재만 다른 입찰가를 쓴다. 기본은 그룹 입찰가 상속. */
  useGroupBidAmt?: boolean;
}

export interface CreateKeywordInput {
  keyword: string;
  /** 키워드별 입찰가. 미지정이면 그룹 입찰가 사용. */
  bidAmt?: number;
}

/** 비즈채널 (읽기). 쇼핑 세팅 가능 여부 판별에 MALL 채널 유무를 쓴다. */
export interface NccChannel {
  id: string;
  channelTp: string;
  name: string;
  channelKey: string;
}

/** 쇼핑몰 상품 (읽기). 링크 → 소재 연결의 핵심. */
export interface ShoppingProduct {
  /** 네이버쇼핑 상품 ID = 소재의 referenceKey. */
  id: string;
  /** 스마트스토어 링크에 들어 있는 번호. 링크 매칭은 이 값으로 한다. */
  mallProductId: string;
  productTitle: string;
  mallProductUrl: string;
  imageUrl: string;
  lowPrice: string;
  /** 쇼핑몰 > 카테고리 전체 경로. */
  fullMallCatNm: string;
  /** false면 광고 등록 불가 - 초안에서 제외하고 이유를 보여준다. */
  registrable: boolean;
}
