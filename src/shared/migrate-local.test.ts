import { describe, it, expect } from "vitest";
import { decideMigration } from "./migrate-local";

describe("decideMigration", () => {
  // 서버측 이관 완료 마커(migrated_at) 기준 — "서버에 데이터가 있는지"가 아니다.
  // 부분 업로드 상태에서 재시도해도 마커가 없으니 upload가 재개돼 로컬이 지워지지 않는다.
  it("서버가 이관 완료를 기록하지 않았으면 로컬을 올린다(재시도 포함)", () =>
    expect(decideMigration(false)).toBe("upload"));
  it("서버가 이관 완료를 기록했으면 서버가 이긴다 - 로컬을 덮는다", () =>
    expect(decideMigration(true)).toBe("download"));
});
