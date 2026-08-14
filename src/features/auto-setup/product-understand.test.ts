import { describe, expect, it } from "vitest";
import { cleanSeedKeywords } from "./product-understand";

// 시드가 검색광고 API 제약을 어기면 그 배치(5개)가 통째로 400이 나면서 멀쩡한 시드까지 날아간다.
// 보내기 전에 여기서 거르는 게 유일한 방어선이라 경계값을 잠가둔다.
describe("cleanSeedKeywords", () => {
  it("허용 문자만 남기고 특수문자는 공백으로 정리한다", () => {
    expect(cleanSeedKeywords(["임산부 수유브라!!", "노와이어★브라"])).toEqual([
      "임산부 수유브라",
      "노와이어 브라",
    ]);
  });

  it("공백 제거 기준 30자를 넘으면 버린다", () => {
    const ok = "가".repeat(30);
    const tooLong = "가".repeat(31);
    // 공백이 섞여도 판정은 공백을 뺀 길이로 한다 — 전송 형태가 그렇기 때문.
    const spacedButFits = `${"가".repeat(15)} ${"나".repeat(15)}`;
    expect(cleanSeedKeywords([ok, tooLong, spacedButFits])).toEqual([ok, spacedButFits]);
  });

  it("공백·대소문자만 다른 중복을 하나로 합친다", () => {
    expect(cleanSeedKeywords(["수유 브라", "수유브라", "Nursing Bra", "nursingbra"])).toEqual([
      "수유 브라",
      "Nursing Bra",
    ]);
  });

  it("빈 값과 문자열이 아닌 값은 걸러낸다", () => {
    const input = ["", "   ", "!!!", null, 42, "수유브라"] as unknown as string[];
    expect(cleanSeedKeywords(input)).toEqual(["수유브라"]);
  });

  it("최대 개수를 넘지 않는다", () => {
    const many = Array.from({ length: 20 }, (_, i) => `키워드${i}`);
    expect(cleanSeedKeywords(many)).toHaveLength(10);
    expect(cleanSeedKeywords(many, 3)).toHaveLength(3);
  });
});
