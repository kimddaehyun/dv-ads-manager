import { describe, it, expect } from "vitest";
import {
  roasBand, roasPct, YELLOW_FLOOR_RATIO,
  flattenKeywords, extractCandidates, COST_FLOOR,
} from "./brief-rules";
import { ZERO_METRICS, type ReportMetrics } from "@/features/report/report-data";
import { type KeywordGroup } from "@/features/report/report-variable";
import { type NamedMetrics } from "@/features/report/report-fill";

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

// 테스트 픽스처 헬퍼 — cost/conv/revenue만 지정하면 나머지는 0.
function m(cost: number, purchaseConv: number, revenue: number): ReportMetrics {
  return { ...ZERO_METRICS, cost, purchaseConv, revenue };
}

const GROUPS: KeywordGroup[] = [
  {
    campaign: "[DV] 대나무",
    group: "1. 기본 상품명",
    keywords: [
      // 비용 1.2만, 전환 0 → zeroConvKeyword
      { keyword: "대나무돗자리", metrics: m(12_000, 0, 0) },
      // 비용 5만, ROAS 900% (목표 800 초과) → green, 후보 아님(순위는 Task 7)
      { keyword: "대나무자리", metrics: m(50_000, 5, 450_000) },
      // 비용 5만, ROAS 700% → yellow → belowTarget 후보 아님 (유지 대상)
      { keyword: "여름돗자리", metrics: m(50_000, 4, 350_000) },
      // 비용 5만, ROAS 400% → none → belowTargetKeyword
      { keyword: "돗자리추천", metrics: m(50_000, 2, 200_000) },
      // 비용 5천(임계 미만), 전환 0 → 후보 아님
      { keyword: "소액키워드", metrics: m(5_000, 0, 0) },
    ],
  },
];

describe("flattenKeywords", () => {
  it("그룹 계층을 평탄화하고 캠페인/그룹을 각 행에 붙인다", () => {
    const rows = flattenKeywords(GROUPS);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      keyword: "대나무돗자리",
      campaign: "[DV] 대나무",
      group: "1. 기본 상품명",
    });
  });
});

describe("extractCandidates", () => {
  const base = { keywords: GROUPS, placements: [] as NamedMetrics[], targetRoas: 800 };

  it("COST_FLOOR는 1만원", () => {
    expect(COST_FLOOR).toBe(10_000);
  });

  it("비용 임계 이상 + 전환 0 → zeroConvKeyword", () => {
    const c = extractCandidates(base).find((x) => x.kind === "zeroConvKeyword");
    expect(c).toBeDefined();
    expect(c!.facts.keywords).toBe("대나무돗자리");
    expect(c!.facts.count).toBe(1);
  });

  it("비용 임계 미만은 전환 0이어도 후보에서 제외", () => {
    const c = extractCandidates(base).find((x) => x.kind === "zeroConvKeyword");
    expect(String(c!.facts.keywords)).not.toContain("소액키워드");
  });

  it("노랑 구간 키워드는 belowTargetKeyword에 안 들어간다", () => {
    // 이게 깨지면 유지해야 할 키워드에 "하향하겠습니다"가 광고주에게 나간다.
    const c = extractCandidates(base).find((x) => x.kind === "belowTargetKeyword");
    expect(c).toBeDefined();
    expect(String(c!.facts.keywords)).not.toContain("여름돗자리");
    expect(String(c!.facts.keywords)).toContain("돗자리추천");
  });

  it("전환 0 키워드는 belowTargetKeyword와 중복되지 않는다", () => {
    // 전환 0이면 ROAS도 0이라 none 구간에 자동으로 떨어진다. 그건 이미 별도 후보다.
    const c = extractCandidates(base).find((x) => x.kind === "belowTargetKeyword");
    expect(String(c!.facts.keywords)).not.toContain("대나무돗자리");
  });

  it("목표 ROAS 미설정이면 분류 후보를 만들지 않는다", () => {
    const cands = extractCandidates({ ...base, targetRoas: undefined });
    expect(cands.find((x) => x.kind === "belowTargetKeyword")).toBeUndefined();
    // 목표와 무관한 후보는 그대로 나온다.
    expect(cands.find((x) => x.kind === "zeroConvKeyword")).toBeDefined();
  });

  it("지면 비용 임계 이상 + 전환 0 → zeroConvPlacement", () => {
    const placements: NamedMetrics[] = [
      { label: "네이버 메인", metrics: m(31_000, 0, 0) },
      { label: "네이버 검색", metrics: m(80_000, 10, 800_000) },
      { label: "기타", metrics: m(500, 0, 0) },
    ];
    const c = extractCandidates({ ...base, placements }).find((x) => x.kind === "zeroConvPlacement");
    expect(c!.facts.placements).toBe("네이버 메인");
  });

  it("후보의 표는 kind가 결정한다 — 행에 band가 칠해진다", () => {
    const c = extractCandidates(base).find((x) => x.kind === "belowTargetKeyword");
    expect(c!.table.rows.some((r) => r.band === "none")).toBe(true);
  });

  it("기본 선택은 전부 해제 — AE선택 모드의 시작 상태", () => {
    expect(extractCandidates(base).every((c) => c.selected === false)).toBe(true);
  });

  it("후보가 없으면 빈 배열", () => {
    expect(extractCandidates({ keywords: [], placements: [], targetRoas: 800 })).toEqual([]);
  });
});
