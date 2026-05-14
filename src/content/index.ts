/**
 * 디브이 애드 매니저 — 광고 대시보드 콘텐츠 스크립트.
 * ads.naver.com 진입 시 로드되어 키워드 옆 입찰가·쇼핑 순위 오버레이를 렌더한다.
 *
 * 현재 상태: 부트스트랩 골격만. 다음 단계:
 *   1. 광고 키워드 셀렉터 탐색 (페이지 구조 분석 후 결정)
 *   2. 키워드별 GET_VOLUMES / GET_SEARCH_POPULAR / GET_BID_ESTIMATE 메시지 호출
 *   3. Shadow DOM 오버레이 또는 인라인 패널 렌더링
 */

declare const __APP_VERSION__: string;

console.log(
  `[dv-ads] content script loaded · v${__APP_VERSION__} · ${location.href}`,
);

export {};
