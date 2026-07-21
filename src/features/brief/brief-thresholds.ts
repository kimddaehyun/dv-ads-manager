/**
 * 이슈 기준(임계값) 해석 — 광고주별 커스텀 (순수 함수).
 *
 * 3단계: ① 자동 보정 - 비용 기준은 계정의 기간 총광고비에 비례(소액/대형 계정 모두 맞게).
 *        ② 프리셋 - 민감/기본/핵심이 임계값 세트를 통째로 조정.
 *        ③ 맞춤 - 개별 값 덮어쓰기(잘못된 값은 무시하고 자동값으로).
 * 결과는 extractCandidates에 통째로 전달 — 규칙 엔진은 어디서 온 값인지 모른다.
 */

import {
  AD_IMP_FLOOR, COST_FLOOR, LOW_CTR_PCT, LOW_RANK_FLOOR, REVENUE_DROP_FLOOR, SKEW_RATIO,
  type BriefThresholds,
} from "./brief-rules";

export type BriefSensitivity = "sensitive" | "normal" | "loose" | "custom";

export const SENSITIVITY_LABEL: Record<BriefSensitivity, string> = {
  sensitive: "민감",
  normal: "기본",
  loose: "핵심",
  custom: "맞춤",
};

/** 비용 기준 자동 보정 — 기간 총광고비의 이 비율. */
const AUTO_COST_RATIO = 0.015;
const AUTO_COST_MIN = 10_000;
const AUTO_COST_MAX = 200_000;
/** 매출 낙폭 기준 = 비용 기준의 이 배수. */
const REVENUE_DROP_MULT = 10;

export interface ResolveThresholdsInput {
  sensitivity?: BriefSensitivity;
  /** sensitivity === "custom"일 때 개별 덮어쓰기. */
  custom?: Partial<BriefThresholds>;
  /** 기간 총광고비(원) — 비용 기준 자동 보정 재료. 없으면 기본 상수. */
  totalCost?: number;
}

function roundThousand(n: number): number {
  return Math.round(n / 1_000) * 1_000;
}

export function resolveThresholds(input: ResolveThresholdsInput): BriefThresholds {
  // ① 자동 보정 (보통 기준)
  const autoCost =
    input.totalCost != null && input.totalCost > 0
      ? Math.min(AUTO_COST_MAX, Math.max(AUTO_COST_MIN, roundThousand(input.totalCost * AUTO_COST_RATIO)))
      : COST_FLOOR;
  const base: BriefThresholds = {
    costFloor: autoCost,
    skewRatio: SKEW_RATIO,
    adImpFloor: AD_IMP_FLOOR,
    lowCtrPct: LOW_CTR_PCT,
    lowRankFloor: LOW_RANK_FLOOR,
    revenueDropFloor: input.totalCost != null && input.totalCost > 0 ? autoCost * REVENUE_DROP_MULT : REVENUE_DROP_FLOOR,
  };

  // ② 프리셋
  const s = input.sensitivity ?? "normal";
  const preset: BriefThresholds =
    s === "sensitive"
      ? {
          costFloor: Math.max(1_000, roundThousand(base.costFloor * 0.5)),
          skewRatio: 1.3,
          adImpFloor: 500,
          lowCtrPct: 0.7,
          lowRankFloor: 4,
          revenueDropFloor: Math.max(10_000, roundThousand(base.revenueDropFloor * 0.5)),
        }
      : s === "loose"
        ? {
            costFloor: roundThousand(base.costFloor * 2),
            skewRatio: 2,
            adImpFloor: 2_000,
            lowCtrPct: 0.3,
            lowRankFloor: 8,
            revenueDropFloor: roundThousand(base.revenueDropFloor * 2),
          }
        : base;

  // ③ 직접 설정 — 준 값 중 말이 되는 것만(양수) 덮어쓴다.
  if (s !== "custom") return preset;
  const out = { ...base };
  for (const key of Object.keys(out) as Array<keyof BriefThresholds>) {
    const v = input.custom?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}
