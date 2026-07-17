import { describe, it, expect } from "vitest";
import { decideMigration } from "./migrate-local";

describe("decideMigration", () => {
  it("서버가 비어 있으면 로컬을 올린다", () => expect(decideMigration(false)).toBe("upload"));
  it("서버에 데이터가 있으면 서버가 이긴다 - 로컬을 덮는다", () => expect(decideMigration(true)).toBe("download"));
});
