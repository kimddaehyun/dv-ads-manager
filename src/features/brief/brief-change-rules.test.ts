import { describe, expect, it } from "vitest";
import {
  CHANGE_CANDIDATE_CAP,
  IMPACT_ROAS_RATIO,
  buildChangeHistoryCandidates,
  evaluateChangeImpacts,
  filterOurChanges,
  type BriefChangeEvent,
} from "./brief-change-rules";
import type { RawHistoryRow } from "@/features/change-watch/change-watch";
import type { BriefTargetSnapshot } from "./brief-rules";

function row(over: Partial<RawHistoryRow> & { name?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }): RawHistoryRow {
  return {
    eventId: over.eventId ?? "e1",
    eventType: over.eventType ?? "ncc.heroes.CRITERION.MODIFY",
    actorDisplayName: over.actorDisplayName ?? "김아라",
    "@timestamp": over["@timestamp"] ?? "2026-07-10T09:00:00.000Z",
    objects: over.objects ?? [
      { displayName: over.name ?? "대나무돗자리", data: { heroes: { before: over.before ?? { bidAmt: "500" }, after: over.after ?? { bidAmt: "700" } } } },
    ],
  };
}

function snap(label: string, cost: number, revenue: number): BriefTargetSnapshot {
  return { label, cost, revenue, purchaseConv: 1, clicks: 10, impressions: 100 };
}

describe("filterOurChanges", () => {
  it("우리 팀 작업자의 heroes 변경만 남긴다", () => {
    const rows = [
      row({ eventId: "a", actorDisplayName: "김아라" }),
      row({ eventId: "b", actorDisplayName: "외부인" }),
      row({ eventId: "c", eventType: "ncc.charge.CAMPAIGN_LOCK" }),
    ];
    const out = filterOurChanges(rows, ["김아라"]);
    expect(out.map((e) => e.id)).toEqual(["a:0"]);
    expect(out[0].actor).toBe("김아라");
    expect(out[0].entityLabel).toBe("대나무돗자리");
    expect(out[0].summary).toContain("입찰가");
    expect(out[0].summary).toContain("500");
  });

  it("작업자 매칭은 trim + 대소문자 무시 완전 일치", () => {
    const rows = [row({ actorDisplayName: " GW10500 " })];
    expect(filterOurChanges(rows, ["gw10500"])).toHaveLength(1);
    expect(filterOurChanges(rows, ["gw105"])).toHaveLength(0);
  });

  it("actors가 비면 빈 배열", () => {
    expect(filterOurChanges([row({})], [])).toEqual([]);
  });

  it("diff가 없는 행(내용 동일)은 요약이 '변경'으로 폴백", () => {
    const rows = [row({ before: { bidAmt: "500" }, after: { bidAmt: "500" } })];
    const out = filterOurChanges(rows, ["김아라"]);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toContain("키워드");
  });
});

describe("evaluateChangeImpacts", () => {
  const periodStartMs = Date.parse("2026-07-12T00:00:00+09:00");
  const ev = (atMs: number, label = "대나무돗자리"): BriefChangeEvent => ({
    id: "a:0", actor: "김아라", atMs, entityLabel: label, what: "키워드", summary: "입찰가 500원 -> 700원",
  });

  it("기간 시작 전 변경 + 전/후 지표가 있으면 ROAS 비교로 평가한다", () => {
    const prev = new Map([["대나무돗자리", snap("대나무돗자리", 10000, 30000)]]); // 300%
    const cur = new Map([["대나무돗자리", snap("대나무돗자리", 10000, 40000)]]); // 400%
    const out = evaluateChangeImpacts([ev(periodStartMs - 1000)], prev, cur, periodStartMs);
    expect(out[0].impact).toBe("positive");
    expect(out[0].before?.revenue).toBe(30000);
    expect(out[0].after?.revenue).toBe(40000);
  });

  it("하락이면 negative, 임계(±10%) 안이면 neutral", () => {
    const prev = new Map([["k", snap("k", 10000, 30000)]]);
    const down = new Map([["k", snap("k", 10000, 20000)]]);
    const flat = new Map([["k", snap("k", 10000, 30000 * (1 + IMPACT_ROAS_RATIO * 0.5))]]);
    expect(evaluateChangeImpacts([ev(periodStartMs - 1, "k")], prev, down, periodStartMs)[0].impact).toBe("negative");
    expect(evaluateChangeImpacts([ev(periodStartMs - 1, "k")], prev, flat, periodStartMs)[0].impact).toBe("neutral");
  });

  it("기간 중간 변경은 unknown (전/후 분할 불가)", () => {
    const prev = new Map([["k", snap("k", 10000, 30000)]]);
    const cur = new Map([["k", snap("k", 10000, 40000)]]);
    const out = evaluateChangeImpacts([ev(periodStartMs + 1000, "k")], prev, cur, periodStartMs);
    expect(out[0].impact).toBe("unknown");
  });

  it("라벨 매칭 실패(이름 변경/삭제)면 unknown", () => {
    const out = evaluateChangeImpacts([ev(periodStartMs - 1, "없는키워드")], new Map(), new Map(), periodStartMs);
    expect(out[0].impact).toBe("unknown");
    expect(out[0].before).toBeNull();
  });
});

describe("buildChangeHistoryCandidates", () => {
  const impact = (label: string, atMs: number, impactVal: "positive" | "unknown" = "positive") => ({
    event: { id: `${label}:${atMs}`, actor: "김아라", atMs, entityLabel: label, what: "키워드", summary: "입찰가 500원 -> 700원" },
    before: impactVal === "positive" ? snap(label, 10000, 30000) : null,
    after: impactVal === "positive" ? snap(label, 10000, 40000) : null,
    impact: impactVal,
  });

  it("같은 대상은 최신 1건만, kind는 changeFollowUp", () => {
    const out = buildChangeHistoryCandidates([impact("k", 100), impact("k", 200)]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("changeFollowUp");
    expect(out[0].facts.변경내용).toContain("입찰가");
    expect(out[0].facts.평가).toBe("개선");
    expect(out[0].targets[0].label).toBe("k");
  });

  it("전체 상한을 넘으면 최신순으로 자른다", () => {
    const many = Array.from({ length: CHANGE_CANDIDATE_CAP + 3 }, (_, i) => impact(`k${i}`, i));
    const out = buildChangeHistoryCandidates(many);
    expect(out).toHaveLength(CHANGE_CANDIDATE_CAP);
    expect(out[0].facts.대상).toBe(`k${CHANGE_CANDIDATE_CAP + 2}`);
  });

  it("unknown이면 성과 숫자 대신 판단 보류 문구", () => {
    const out = buildChangeHistoryCandidates([impact("k", 1, "unknown")]);
    expect(out[0].facts.평가).toBe("판단 보류");
    expect(out[0].facts.이전수익률).toBeUndefined();
  });
});
