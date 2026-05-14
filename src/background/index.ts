/**
 * 디브이 애드 매니저 — MV3 서비스 워커.
 *
 * 책임: 콘텐츠 스크립트·팝업·옵션 페이지에서 오는 메시지 라우팅.
 *   - OPEN_OPTIONS: 옵션 페이지 열기
 *   - (예정) GET_BID_ESTIMATE: 키워드 → 1~15위 예상 입찰가 (F001)
 *   - (예정) GET_PRODUCT_RANK: 쇼핑검색광고 소재 → 자동매칭 키워드별 순위·입찰가 (F002/F003, 데이터 소스 TBD)
 *
 * 메시지 계약과 핸들러 본문은 docs/PRD.md의 기능 명세를 따른다. 현재는 골격만.
 */

chrome.runtime.onInstalled.addListener(() => {
  console.log("[dv-ads] service worker installed");
});

type Msg = { type: "OPEN_OPTIONS" };

chrome.runtime.onMessage.addListener((msg: Msg, _sender, sendResponse) => {
  if (msg?.type === "OPEN_OPTIONS") {
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

export {};
