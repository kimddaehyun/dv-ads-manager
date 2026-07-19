import { describe, expect, it } from "vitest";
import { resolveThresholds, SENSITIVITY_LABEL } from "./brief-thresholds";
import { COST_FLOOR, SKEW_RATIO } from "./brief-rules";

describe("resolveThresholds", () => {
  it("보통 + 총광고비 없음 = 기본 상수 그대로", () => {
    const th = resolveThresholds({});
    expect(th.costFloor).toBe(COST_FLOOR);
    expect(th.skewRatio).toBe(SKEW_RATIO);
  });

  it("비용 기준은 총광고비의 1.5%로 자동 보정 (1만원 하한, 20만원 상한, 천원 반올림)", () => {
    expect(resolveThresholds({ totalCost: 100_000 }).costFloor).toBe(10_000);       // 1.5% = 1,500 → 하한
    expect(resolveThresholds({ totalCost: 2_000_000 }).costFloor).toBe(30_000);     // 1.5% = 30,000
    expect(resolveThresholds({ totalCost: 50_000_000 }).costFloor).toBe(200_000);   // 상한
    expect(resolveThresholds({ totalCost: 2_100_000 }).costFloor).toBe(32_000);     // 31,500 → 천원 반올림
  });

  it("매출 낙폭 기준은 비용 기준의 10배로 따라간다", () => {
    const th = resolveThresholds({ totalCost: 2_000_000 });
    expect(th.revenueDropFloor).toBe(300_000);
  });

  it("민감하게 = 문턱 낮춤, 느슨하게 = 문턱 높임", () => {
    const s = resolveThresholds({ sensitivity: "sensitive", totalCost: 2_000_000 });
    const l = resolveThresholds({ sensitivity: "loose", totalCost: 2_000_000 });
    const n = resolveThresholds({ totalCost: 2_000_000 });
    expect(s.costFloor).toBeLessThan(n.costFloor);
    expect(l.costFloor).toBeGreaterThan(n.costFloor);
    expect(s.skewRatio).toBeLessThan(n.skewRatio);
    expect(l.skewRatio).toBeGreaterThan(n.skewRatio);
    expect(s.lowCtrPct).toBeGreaterThan(n.lowCtrPct); // 민감 = 더 높은 CTR까지 문제 삼음
    expect(l.lowCtrPct).toBeLessThan(n.lowCtrPct);
  });

  it("직접 설정은 준 값만 덮고 나머지는 자동값 유지", () => {
    const th = resolveThresholds({
      sensitivity: "custom",
      custom: { costFloor: 55_000, skewRatio: 1.7 },
      totalCost: 2_000_000,
    });
    expect(th.costFloor).toBe(55_000);
    expect(th.skewRatio).toBe(1.7);
    expect(th.adImpFloor).toBe(resolveThresholds({ totalCost: 2_000_000 }).adImpFloor);
  });

  it("직접 설정의 엉뚱한 값(0 이하·NaN)은 무시하고 자동값 사용", () => {
    const th = resolveThresholds({ sensitivity: "custom", custom: { costFloor: 0, skewRatio: Number.NaN } });
    expect(th.costFloor).toBe(COST_FLOOR);
    expect(th.skewRatio).toBe(SKEW_RATIO);
  });

  it("프리셋 라벨이 4종 다 있다", () => {
    expect(Object.keys(SENSITIVITY_LABEL)).toEqual(["sensitive", "normal", "loose", "custom"]);
  });
});
