/**
 * 디브이 애드 매니저 — 광고 대시보드 콘텐츠 스크립트.
 * ads.naver.com 진입 시 로드되어 키워드 옆 입찰가·쇼핑 순위 오버레이를 렌더한다.
 *
 * 다음 단계 (docs/PRD.md 부록 "Spike & 출시 계획" 참조):
 *   Spike A: 활성 광고주 customerId 자동 감지 전략 확정 (URL 패턴 → DOM 헤더 → 폴백 드롭다운)
 *   F001:    파워링크 키워드 테이블 옆 1~15위 예상 입찰가 오버레이
 *            (background → POST /estimate/average-position-bid/keyword)
 *   F002/3:  쇼핑검색광고 그룹 inline 펼침 + 소재 상세 풀 패널 (데이터 소스 TBD)
 *   F013:    활성 광고주 매칭 상태 배지
 */

declare const __APP_VERSION__: string;

console.log(
  `[dv-ads] content script loaded · v${__APP_VERSION__} · ${location.href}`,
);

export {};
