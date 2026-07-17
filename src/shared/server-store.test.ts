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
  it("meta 왕복 - undefined 필드만", () => {
    const m = { adAccountNo: 5 };
    const row = metaToRow("uid", m, false, 0);
    const restored = rowToMeta(row);
    expect(restored).toEqual({ adAccountNo: 5 });
    expect(Object.keys(restored)).toEqual(["adAccountNo"]);
  });
  it("rowToMeta - string 컬럼을 숫자로 강제 변환", () => {
    const row = { user_id: "uid", ad_account_no: "77" as unknown as number, meta: {}, added: false, added_order: 0 };
    const result = rowToMeta(row);
    expect(result.adAccountNo).toBe(77);
    expect(typeof result.adAccountNo).toBe("number");
  });
  it("rowToGroup - account_nos string 배열을 숫자로 강제 변환", () => {
    const row = { id: "g1", user_id: "uid", name: "팀A", ord: 1, account_nos: ["1", "2"] as unknown as number[] };
    const result = rowToGroup(row);
    expect(result.accountNos).toEqual([1, 2]);
    expect(result.accountNos.every((n) => typeof n === "number")).toBe(true);
  });
});
