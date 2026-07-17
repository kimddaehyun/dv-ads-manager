import { describe, it, expect, vi, beforeEach } from "vitest";
import { chromeStorageAdapter } from "./supabase";

const store: Record<string, string> = {};
beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  vi.stubGlobal("chrome", { storage: { local: {
    get: vi.fn(async (k: string) => ({ [k]: store[k] })),
    set: vi.fn(async (o: Record<string, string>) => { Object.assign(store, o); }),
    remove: vi.fn(async (k: string) => { delete store[k]; }),
  } } });
});

describe("chromeStorageAdapter", () => {
  it("setItem 후 getItem으로 같은 값을 돌려준다", async () => {
    await chromeStorageAdapter.setItem("k", "v");
    expect(await chromeStorageAdapter.getItem("k")).toBe("v");
  });
  it("없는 키는 null", async () => {
    expect(await chromeStorageAdapter.getItem("none")).toBeNull();
  });
  it("removeItem 후 null", async () => {
    await chromeStorageAdapter.setItem("k", "v");
    await chromeStorageAdapter.removeItem("k");
    expect(await chromeStorageAdapter.getItem("k")).toBeNull();
  });
});
