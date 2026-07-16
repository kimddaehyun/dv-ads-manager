/**
 * F-Brief 검산 — AI가 쓴 문장의 숫자가 우리가 준 값인지 대조 (설계 §3 3겹).
 *
 * **차단하지 않고 표시만 한다.** 오탐이 있다 — "30일", "2페이지" 같은 정상 숫자가
 * 문장에 들어간다. 판단은 AE에게 맡긴다.
 */

/** 문장에서 숫자를 뽑아 정규화(쉼표 제거, 소수점 보존). */
export function extractNumbers(text: string): string[] {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found.map((s) => s.replace(/,/g, ""));
}

/** 문장의 숫자가 전부 허용 집합에 있으면 true. */
export function verifyBlock(text: string, allowed: Set<string>): boolean {
  return extractNumbers(text).every((n) => allowed.has(n));
}
