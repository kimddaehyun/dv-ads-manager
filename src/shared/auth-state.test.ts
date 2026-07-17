import { describe, it, expect } from "vitest";
import { deriveAuthState } from "./auth-state";

describe("deriveAuthState", () => {
  it("세션 없으면 signedOut", () => expect(deriveAuthState(false, undefined)).toBe("signedOut"));
  it("세션 + approved → approved", () => expect(deriveAuthState(true, "approved")).toBe("approved"));
  it("세션 + pending → pending", () => expect(deriveAuthState(true, "pending")).toBe("pending"));
  it("세션 + blocked → blocked", () => expect(deriveAuthState(true, "blocked")).toBe("blocked"));
  it("세션은 있는데 프로필을 못 읽었으면 pending 취급 - 잠금이 안전 기본값", () =>
    expect(deriveAuthState(true, undefined)).toBe("pending"));
});
