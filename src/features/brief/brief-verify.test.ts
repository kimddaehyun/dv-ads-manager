import { describe, it, expect } from "vitest";
import { extractNumbers, verifyBlock } from "./brief-verify";

describe("extractNumbers", () => {
  it("쉼표 있는 숫자를 정규화해서 뽑는다", () => {
    expect(extractNumbers("광고비 267,558원")).toContain("267558");
  });

  it("소수점을 보존한다", () => {
    expect(extractNumbers("수익률 620.58%")).toContain("620.58");
  });

  it("여러 개를 다 뽑는다", () => {
    expect(extractNumbers("862% > 621%")).toEqual(["862", "621"]);
  });

  it("숫자가 없으면 빈 배열", () => {
    expect(extractNumbers("안녕하세요")).toEqual([]);
  });
});

describe("verifyBlock", () => {
  const allowed = new Set(["267558", "620.58", "1"]);

  it("허용 집합의 숫자만 있으면 통과", () => {
    expect(verifyBlock("광고비 267,558원, 수익률 620.58%", allowed)).toBe(true);
  });

  it("허용 집합에 없는 숫자가 있으면 실패", () => {
    // AI가 267,559로 바꿔 쓴 경우
    expect(verifyBlock("광고비 267,559원", allowed)).toBe(false);
  });

  it("숫자가 없으면 통과", () => {
    expect(verifyBlock("추이를 확인하겠습니다", allowed)).toBe(true);
  });
});
