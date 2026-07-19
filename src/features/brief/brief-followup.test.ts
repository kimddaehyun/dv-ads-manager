import { describe, it, expect } from "vitest";
import { buildFollowUpCandidate, currentTargetMap } from "./brief-followup";
import { type BriefHistoryRecord } from "./brief-history";
import { type BriefTargetSnapshot } from "./brief-rules";

const t = (label: string, cost: number, revenue: number): BriefTargetSnapshot =>
  ({ label, cost, revenue, purchaseConv: revenue > 0 ? 1 : 0, clicks: 10, impressions: 100 });

const history: BriefHistoryRecord = {
  id: "h1", adAccountNo: 1, advertiserName: "테스트", periodSince: "2026-07-01", periodUntil: "2026-07-10",
  message: "...",
  actions: [{ kind: "zeroConvKeyword", facts: {}, action: "lower", targets: [t("가방", 50_000, 0), t("지갑", 30_000, 0)] }],
  snapshot: { totals: { cost: 100_000, revenue: 400_000, roas: 400 }, prevTotals: { cost: 0, revenue: 0, roas: 0 } },
  reportType: "post_action_report", tone: "detailed", aiDraft: "",
  includedPreviousHistory: false, includedChangeHistory: false, relatedChangeIds: [], sentStatus: "copied",
  createdAt: "2026-07-10T09:00:00Z",
};

describe("buildFollowUpCandidate", () => {
  it("지난 조치 대상이 현재도 있으면 그때-지금 비교 후보를 만든다", () => {
    const cur = new Map([["가방", t("가방", 20_000, 150_000)]]);
    const c = buildFollowUpCandidate(history, cur)!;
    expect(c.kind).toBe("pastActionFollowUp");
    expect(c.facts["지난보고일"]).toBe("2026-07-10");
    expect(String(c.facts["대상"])).toContain("가방");
    expect(c.table.rows).toHaveLength(1);
    expect(c.targets).toHaveLength(1); // 이번에도 저장돼 연쇄 추적 가능
  });

  it("현재 데이터에 하나도 매칭되지 않으면 null", () => {
    expect(buildFollowUpCandidate(history, new Map())).toBeNull();
  });

  it("조치가 붙은 액션이 없으면 언급된 전 대상을 점검으로 추적한다", () => {
    const noAction: BriefHistoryRecord = {
      ...history,
      actions: [{ kind: "belowTargetKeyword", facts: {}, targets: [t("가방", 50_000, 100_000)] }],
    };
    const c = buildFollowUpCandidate(noAction, new Map([["가방", t("가방", 40_000, 200_000)]]))!;
    expect(String(c.facts["대상"])).toBe("가방(점검)");
  });
});

describe("currentTargetMap", () => {
  it("키워드 행과 후보 targets를 합쳐 라벨 맵을 만든다", () => {
    const map = currentTargetMap(
      [{ kind: "zeroConvPlacement", facts: {}, table: { title: "", columns: [], rows: [] },
        targets: [t("네이버쇼핑", 10_000, 0)], selected: false }],
      [{ keyword: "가방", campaign: "C", group: "G",
        metrics: { impressions: 1, clicks: 2, cost: 3, purchaseConv: 4, revenue: 5 } as never }],
    );
    expect(map.get("가방")?.cost).toBe(3);
    expect(map.get("네이버쇼핑")?.cost).toBe(10_000);
  });
});
