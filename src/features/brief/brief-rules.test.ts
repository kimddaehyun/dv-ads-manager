import { describe, it, expect } from "vitest";
import { roasBand, roasPct, YELLOW_FLOOR_RATIO } from "./brief-rules";
import { ZERO_METRICS } from "@/features/report/report-data";

describe("roasPct", () => {
  it("매출/비용 x 100", () => {
    expect(roasPct({ ...ZERO_METRICS, cost: 100_000, revenue: 620_000 })).toBeCloseTo(620);
  });

  it("비용 0이면 0 — 0으로 나누기 방지", () => {
    expect(roasPct({ ...ZERO_METRICS, cost: 0, revenue: 50_000 })).toBe(0);
  });
});

describe("roasBand", () => {
  // 목표 800% 기준. 노랑 하한 = 800 x 0.75 = 600.
  // 근거: 임유엽 AE 보고 로그 — 초록 "800% 이상 상향" / 노랑 "600%대 유지" / 무색 "목표 미달 하향".
  it("목표 이상이면 green", () => {
    expect(roasBand(900, 800)).toBe("green");
  });

  it("목표와 정확히 같으면 green — 경계 포함", () => {
    expect(roasBand(800, 800)).toBe("green");
  });

  it("목표 미만 노랑 하한 이상이면 yellow", () => {
    expect(roasBand(700, 800)).toBe("yellow");
  });

  it("노랑 하한과 정확히 같으면 yellow — 경계 포함", () => {
    // 이 경계가 어긋나면 유지해야 할 키워드가 "하향" 후보로 광고주에게 나간다.
    expect(roasBand(600, 800)).toBe("yellow");
  });

  it("노랑 하한 바로 아래면 none", () => {
    expect(roasBand(599, 800)).toBe("none");
  });

  it("0이면 none", () => {
    expect(roasBand(0, 800)).toBe("none");
  });

  it("목표가 0 이하면 판정 불가 — none", () => {
    expect(roasBand(500, 0)).toBe("none");
  });

  it("YELLOW_FLOOR_RATIO는 0.75", () => {
    expect(YELLOW_FLOOR_RATIO).toBe(0.75);
  });
});
