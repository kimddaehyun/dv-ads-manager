/**
 * 콘텐츠 스크립트 세대 교체 표식 — 확장 reload 후 background가 열린 탭에 스크립트를
 * 재주입하면(onInstalled), 이전 고아 컨텍스트의 감시 루프(MutationObserver·setInterval)는
 * 페이지가 살아있는 한 계속 돈다. 둘이 같은 DOM(배지·버튼)을 지웠다 붙였다 싸우지 않도록,
 * 새 컨텍스트가 <html>에 자기 세대값을 찍고 이전 컨텍스트는 주기 루프에서 isStale()로
 * 감지해 스스로 정리한다. DOM attribute는 isolated world 간에 공유되므로 통신 채널로 안전.
 */
const ATTR = "data-dvads-gen";
const GEN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 이 컨텍스트를 현역 세대로 선언. 콘텐츠 스크립트 진입 시 1회 호출. */
export function claimTakeover(): void {
  document.documentElement.setAttribute(ATTR, GEN);
}

/** 더 새로운 컨텍스트가 주입되어 이 컨텍스트가 물러나야 하면 true. */
export function isStale(): boolean {
  return document.documentElement.getAttribute(ATTR) !== GEN;
}
