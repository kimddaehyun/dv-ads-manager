/**
 * F-Accounts 전면 잠금 게이트 — 콘텐츠 스크립트/popup 등에서 "이 화면을 계속 그려도 되는지"
 * 판단하는 단일 진입점.
 *
 * 콘텐츠 스크립트는 페이지당 한 번만 로드되므로, 페이지 수명 동안 `fetchAuthContext()`를
 * 딱 한 번만 호출하고 그 결과를 모듈 스코프 변수에 캐시한다 (같은 페이지에서 여러 기능이
 * init 시점마다 각자 조회하면 중복 네트워크 호출이 생기므로).
 */
import { fetchAuthContext } from "@/shared/auth-state";

let cached: Promise<boolean> | null = null;

export async function requireApproved(): Promise<boolean> {
  if (!cached) {
    cached = fetchAuthContext()
      .then(({ state }) => state === "approved")
      .catch(() => false);
  }
  return cached;
}
