/**
 * 디브이 애드 매니저 — 광고 디바이스 타입.
 *
 * 네이버 검색광고 API의 `device` 필드와 1:1 매핑 (`POST /estimate/position-bid`,
 * `POST /estimate/performance-bulk` 둘 다 동일 값 받음).
 *
 * F001 popover의 토글로 사용자가 디바이스를 전환하면 캐시 키·요청 페이로드에 모두
 * 이 값이 전파된다. 모바일 광고 비중이 큰 광고주 위해 default는 "MOBILE".
 */
export type AdDevice = "PC" | "MOBILE";

/** F001 popover가 열릴 때 초기 선택 디바이스. 키워드 옆 배지도 이 기준으로 추정 순위 계산. */
export const DEFAULT_DEVICE: AdDevice = "PC";
