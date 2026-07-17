import { describe, it, expect } from "vitest";
import { rowToMeta, metaToRow, rowToGroup, groupToRow } from "./server-store";

describe("row 변환", () => {
  it("meta 왕복 - 모든 필드 보존", () => {
    const m = {
      adAccountNo: 123,
      displayName: "별칭",
      favorite: true,
      bizMoneyThreshold: 10000,
      brandSearchDaysThreshold: 7,
      changeWatch: true,
      targetRoas: 800,
    };
    const row = metaToRow("uid", m, true, 2);
    expect(row).toMatchObject({ user_id: "uid", ad_account_no: 123, added: true, added_order: 2 });
    expect(rowToMeta(row)).toEqual(m);
  });
  it("group 왕복", () => {
    const g = { id: "g1", name: "팀A", order: 1, accountNos: [1, 2] };
    expect(rowToGroup(groupToRow("uid", g))).toEqual(g);
  });
});
