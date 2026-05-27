/**
 * F-Setup — 유형별 소재/타겟팅 schema 정규화.
 *
 * ads.naver.com ncc 응답은 캠페인 유형마다 소재(`ad`) 구조와 타겟(`targets[].target`)이
 * 다르다. 이 모듈이 그 차이를 SetupAd/SetupTargeting 공통 모델로 흡수한다.
 *
 * 지역(REGION_TARGET)/요일시간(TIME_TARGET)은 확인 당시 라이브 샘플이 없어(대행사 데이터가
 * 거의 안 씀) 내부 구조가 미확정 — targetTp 존재 여부 + best-effort 요약으로 처리하고,
 * 실제 그런 타겟을 쓰는 데이터가 오면 흡수되도록 동적으로 읽는다.
 */

import type { CampaignTypeCode, SetupAd, SetupTargeting } from "@/types/setup";

export const CAMPAIGN_TYPE_LABELS: Record<CampaignTypeCode, string> = {
  WEB_SITE: "파워링크",
  SHOPPING: "쇼핑검색",
  BRAND_SEARCH: "브랜드검색",
  POWER_CONTENTS: "파워컨텐츠",
  PLACE: "플레이스",
};

export function campaignTypeLabel(tp: string): string {
  return CAMPAIGN_TYPE_LABELS[tp as CampaignTypeCode] ?? tp;
}

/**
 * 키워드를 갖는 유형만 키워드 시트에 포함. SHOPPING(자동매칭)/PLACE(지역기반)/POWER_CONTENTS는
 * 명시 키워드가 없거나 구조가 달라 소재 시트에만 싣는다.
 */
export function typeHasKeywords(tp: string): boolean {
  return tp === "WEB_SITE" || tp === "BRAND_SEARCH";
}

const AD_TYPE_LABELS: Record<string, string> = {
  TEXT_45: "텍스트",
  SHOPPING_PRODUCT_AD: "쇼핑 상품",
  BRAND_SEARCH_NEW_AD: "브랜드검색",
  LOCAL_AD: "플레이스",
};

/** raw 소재 응답 (유형별로 `ad` 내부가 다름). */
export interface RawAd {
  type?: string;
  name?: string;
  ad?: Record<string, unknown>;
  /** 쇼핑 소재는 상품 정보가 referenceData에 (productTitle/mallProductUrl/imageUrl). */
  referenceData?: Record<string, unknown>;
}

/** raw 타겟 항목. */
export interface RawTarget {
  targetTp?: string;
  target?: Record<string, unknown>;
}

/** raw 광고그룹 (타겟 정규화에 필요한 필드만). */
export interface RawAdgroupForTargeting {
  adRollingType?: string;
  targetSummary?: Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

export function normalizeAd(raw: RawAd): SetupAd {
  const type = raw.type ?? "";
  const ad = obj(raw.ad);
  const ref = obj(raw.referenceData);
  const pc = obj(ad.pc);
  const mobile = obj(ad.mobile);
  const info = obj(ad.info);

  let title = "";
  let body = "";
  let url = "";
  let imageUrl = "";

  switch (type) {
    case "TEXT_45":
      title = str(ad.headline);
      body = str(ad.description);
      url = str(pc.final) || str(mobile.final) || str(pc.display);
      break;
    case "SHOPPING_PRODUCT_AD":
      // 쇼핑 소재 = 상품 자체. 제목/링크/이미지는 referenceData에. 설명은 없음.
      title = str(ref.productTitle) || str(ref.productName) || str(ad.productName) || "(쇼핑 상품)";
      url = str(ref.mallProductUrl) || str(ref.mallProdMblUrl);
      imageUrl = str(ref.imageUrl);
      break;
    case "BRAND_SEARCH_NEW_AD":
      title = str(raw.name) || "(브랜드검색 소재)";
      break;
    case "LOCAL_AD":
      title = str(info.name) || "(플레이스 소재)";
      body = str(ad.description);
      url = str(info.address);
      break;
    default:
      // 미정찰 유형 best-effort — 흔한 필드 순회 시도.
      title = str(ad.headline) || str(ad.productName) || str(raw.name) || (type || "(소재)");
      body = str(ad.description);
      url = str(pc.final) || str(mobile.final);
  }

  return { type, typeLabel: AD_TYPE_LABELS[type] ?? (type || "소재"), title, body, url, imageUrl };
}

function adRollingLabel(t: string | undefined): string {
  switch (t) {
    case "PERFORMANCE":
      return "성과 기반 노출";
    case "EQUAL":
      return "균등 노출";
    case "RANDOM":
      return "랜덤 노출";
    default:
      return t || "-";
  }
}

function summarizeRegion(target: Record<string, unknown> | undefined): string {
  if (!target) return "전체";
  // REGION_TARGET 내부 구조 미확정 — 배열 후보를 찾아 개수로 요약, 못 찾으면 "설정함".
  for (const key of ["regions", "codes", "locations", "areas", "region"]) {
    const v = target[key];
    if (Array.isArray(v) && v.length > 0) return `${v.length}개 지역`;
  }
  return "설정함";
}

export function normalizeTargeting(
  group: RawAdgroupForTargeting,
  targets: RawTarget[],
): SetupTargeting {
  const summary = obj(group.targetSummary);

  // 디바이스 — PC_MOBILE_TARGET 우선, 없으면 summary.pcMobile 폴백.
  let device = "PC, 모바일";
  const pcMobile = targets.find((t) => t.targetTp === "PC_MOBILE_TARGET")?.target;
  if (pcMobile) {
    const pc = !!pcMobile.pc;
    const mo = !!pcMobile.mobile;
    device = pc && mo ? "PC, 모바일" : pc ? "PC만" : mo ? "모바일만" : "노출 안 함";
  } else {
    const sm = str(summary.pcMobile);
    device = sm === "pc" ? "PC만" : sm === "mobile" ? "모바일만" : "PC, 모바일";
  }

  // 매체(소재 노출 위치) 제한 — summary.media 기준.
  const sm = str(summary.media);
  const media = sm === "partially" || sm === "partial" ? "일부 제한" : sm === "none" ? "노출 안 함" : "전체";

  // 지역 / 요일시간 — targetTp 동적 탐지.
  const regionT = targets.find((t) => t.targetTp === "REGION_TARGET")?.target;
  const region = summarizeRegion(regionT);
  const timeT = targets.find(
    (t) => t.targetTp === "TIME_TARGET" || t.targetTp === "SCHEDULE_TARGET",
  )?.target;
  const schedule = timeT ? "설정함" : "전체";

  return {
    device,
    region,
    schedule,
    media,
    adRolling: adRollingLabel(group.adRollingType),
  };
}
