/**
 * 사용자에게 노출되는 에러 메시지 공통 매핑.
 *
 * 원시 에러 메시지(JS 런타임 메시지, JSON 응답, 영문 상세)는 절대 그대로 보여주지 않고
 * 사용자가 다음 행동을 알 수 있는 한글 문장으로 대체한다. 디버그 정보는 호출자가 console로 남긴다.
 */

export type FriendlyErrorKind =
  | "volume"
  | "searchable"
  | "extract"
  | "synonym"
  | "test"
  | "searchPopular";

export function friendlyApiError(
  err: string | undefined,
  kind: FriendlyErrorKind = "test",
): string {
  const s = err ?? "";
  const lower = s.toLowerCase();

  // API 키에 비ASCII(한글 등) 포함 → fetch가 헤더 인코딩 단계에서 실패
  if (
    lower.includes("iso-8859-1") ||
    lower.includes("non iso") ||
    lower.includes("string contains non")
  ) {
    return "API 키에 한글·공백·특수문자가 포함되어 있어요. 영문·숫자만 입력해 주세요";
  }

  // 네트워크
  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("err_network") ||
    lower.includes("err_internet")
  ) {
    return "네트워크 연결을 확인해 주세요";
  }

  // HTTP status
  const status = s.match(/\b(\d{3})\b/)?.[1];
  if (status === "429") {
    return "요청 한도를 잠시 초과했어요. 잠시 후 다시 시도해 주세요";
  }
  if (status === "401" || status === "403") {
    return "API 키 인증 실패 - 옵션에서 키를 확인해 주세요";
  }
  if (status && status.startsWith("5")) {
    return "네이버 서버 일시 장애. 잠시 후 다시 시도해 주세요";
  }

  switch (kind) {
    case "volume":
      return "검색량 조회 실패. 잠시 후 다시 시도해 주세요";
    case "searchable":
      return "태그 사전 확인 실패. 잠시 후 다시 시도해 주세요";
    case "extract":
      // 패널 측에서 "스마트스토어센터" 토큰을 a 태그로 치환해 렌더한다.
      return "태그 추출 실패. 스마트스토어센터에 로그인된 상태에서만 사용 가능합니다.";
    case "synonym":
      return "동의어 분석 실패. 잠시 후 다시 시도해 주세요";
    case "searchPopular":
      // 패널 측에서 "스마트스토어센터" 토큰을 a 태그로 치환해 렌더한다.
      // 다른 호출자에게도 평문으로 의미가 통하도록 키워드는 그대로 둔다.
      return "이 기능은 브랜드 스토어 계정에서만 동작합니다. 스마트스토어센터에 브랜드 계정으로 로그인되어 있는지 확인해 주세요";
    case "test":
    default:
      return "연결 실패. 잠시 후 다시 시도해 주세요";
  }
}
