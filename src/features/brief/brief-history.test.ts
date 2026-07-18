import { describe, it, expect } from "vitest";
import { candidatesToActions } from "./brief-history";

describe("candidatesToActions", () => {
  it("후보의 kind/facts/action/targets만 추려 담는다 (표 spec은 제외)", () => {
    const out = candidatesToActions([
      {
        kind: "zeroConvKeyword",
        facts: { 기준: "전환 0", keywords: "가방", count: 1, 비용합계: 20000 },
        table: { title: "t", columns: [], rows: [] },
        selected: true,
        action: "lower",
        targets: [{ label: "가방", cost: 20000, revenue: 0, purchaseConv: 0, clicks: 10, impressions: 100 }],
      },
    ]);
    expect(out).toEqual([
      {
        kind: "zeroConvKeyword",
        facts: { 기준: "전환 0", keywords: "가방", count: 1, 비용합계: 20000 },
        action: "lower",
        actionText: undefined,
        targets: [{ label: "가방", cost: 20000, revenue: 0, purchaseConv: 0, clicks: 10, impressions: 100 }],
      },
    ]);
  });
});
