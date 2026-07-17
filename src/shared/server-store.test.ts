import { describe, it, expect, vi } from "vitest";
import { rowToMeta, metaToRow, rowToGroup, groupToRow, pushMetaMany } from "./server-store";

const mocks = vi.hoisted(() => ({
  upsert: vi.fn(async () => ({ error: null })),
}));
vi.mock("@/shared/supabase", () => ({
  getSupabase: () => ({
    from: () => ({ upsert: mocks.upsert }),
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "uid" } } } }),
    },
  }),
}));

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

describe("pushMetaMany", () => {
  it("여러 meta를 배열 upsert 1회로 보낸다 (metaToRow 변환 재사용)", async () => {
    mocks.upsert.mockClear();
    await pushMetaMany([
      { meta: { adAccountNo: 1, displayName: "A" }, added: true, order: 0 },
      { meta: { adAccountNo: 2 }, added: false, order: 0 },
    ]);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const [rows, opts] = mocks.upsert.mock.calls[0] as unknown as [unknown[], { onConflict: string }];
    expect(rows).toEqual([
      metaToRow("uid", { adAccountNo: 1, displayName: "A" }, true, 0),
      metaToRow("uid", { adAccountNo: 2 }, false, 0),
    ]);
    expect(opts.onConflict).toBe("user_id,ad_account_no");
  });
  it("빈 목록이면 요청을 보내지 않는다", async () => {
    mocks.upsert.mockClear();
    await pushMetaMany([]);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
