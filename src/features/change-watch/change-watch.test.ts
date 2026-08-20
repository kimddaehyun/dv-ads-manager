import { describe, it, expect } from "vitest";
import { classifyHistory } from "./change-watch";
import type { RawHistoryRow } from "./change-watch";

/** 예산 도달(잠금) 이벤트 한 줄. `data` 키가 `locker-sa`이고 적용 예산이 들어있다. */
function lockRow(eventType: string, name = "캠페인A", dailyBudget = 50000): RawHistoryRow {
  return {
    eventId: eventType + ":" + name,
    eventType,
    "@timestamp": "2026-08-19T12:07:27.000Z",
    actorDisplayName: "",
    objects: [
      {
        id: "cmp-a001-02-000000008531141",
        displayName: name,
        data: { "locker-sa": { useDailyBudget: 1, dailyBudget } },
      },
    ],
  };
}

/** 사람이 고친 이벤트 한 줄. */
function editRow(actor: string): RawHistoryRow {
  return {
    eventId: "edit:" + actor,
    eventType: "ncc.heroes.CAMPAIGN.MODIFY",
    "@timestamp": "2026-08-19T12:00:00.000Z",
    actorDisplayName: actor,
    objects: [
      {
        id: "cmp-1",
        displayName: "캠페인A",
        data: { heroes: { before: { dailyBudget: "10000" }, after: { dailyBudget: "15000" } } },
      },
    ],
  };
}

describe("classifyHistory - 예산 도달", () => {
  it("캠페인/광고그룹 하루예산 중단을 잡는다", () => {
    const out = classifyHistory(
      [lockRow("ncc.charge.CAMPAIGN_LOCK"), lockRow("ncc.charge.ADGROUP_LOCK", "그룹1", 30000)],
      [],
    );
    expect(out.map((e) => e.summary)).toEqual([
      "캠페인 하루예산 50,000원 도달",
      "광고그룹 하루예산 30,000원 도달",
    ]);
    expect(out.every((e) => e.kind === "budget")).toBe(true);
  });

  it("이름을 모르는 잠금 종류(공유예산 등)도 잡는다", () => {
    const out = classifyHistory([lockRow("ncc.charge.SHARED_BUDGET_LOCK", "공유예산1", 100000)], []);
    expect(out).toHaveLength(1);
    expect(out[0].summary).toBe("예산 100,000원 도달");
  });

  it("재개(UNLOCK)와 계정 잠금은 알림 대상이 아니다", () => {
    const out = classifyHistory(
      [
        lockRow("ncc.charge.CAMPAIGN_UNLOCK"),
        lockRow("ncc.charge.ADGROUP_UNLOCK"),
        lockRow("ncc.charge.EXP_ADGROUP_UNLOCK"),
        lockRow("ncc.charge.ACCOUNT_LOCK", "byungdale"),
      ],
      [],
    );
    expect(out).toEqual([]);
  });

  it("적용 예산을 못 읽으면 금액 없이 알린다", () => {
    const row = lockRow("ncc.charge.CAMPAIGN_LOCK");
    row.objects![0].data = {};
    expect(classifyHistory([row], [])[0].summary).toBe("캠페인 하루예산 도달");
  });

  it("예산 도달을 끈 계정은 만들지 않는다", () => {
    const rows = [lockRow("ncc.charge.CAMPAIGN_LOCK"), editRow("designplay1004:naver")];
    const out = classifyHistory(rows, ["dvcompany:naver"], { budget: false });
    expect(out.map((e) => e.kind)).toEqual(["external"]);
  });
});

describe("classifyHistory - 외부 수정", () => {
  it("제외 목록에 없는 사람의 수정만 알린다", () => {
    const rows = [editRow("dvcompany:naver"), editRow("designplay1004:naver")];
    const out = classifyHistory(rows, ["dvcompany:naver"]);
    expect(out).toHaveLength(1);
    expect(out[0].actor).toBe("designplay1004:naver");
  });

  it("변경 이력을 끈 계정은 예산 도달만 남는다", () => {
    const rows = [lockRow("ncc.charge.CAMPAIGN_LOCK"), editRow("designplay1004:naver")];
    const out = classifyHistory(rows, ["dvcompany:naver"], { external: false });
    expect(out.map((e) => e.kind)).toEqual(["budget"]);
  });

  it("제외 목록이 비어도 예산 도달은 계속 잡힌다", () => {
    const rows = [lockRow("ncc.charge.CAMPAIGN_LOCK"), editRow("designplay1004:naver")];
    expect(classifyHistory(rows, []).map((e) => e.kind)).toEqual(["budget"]);
  });
});
