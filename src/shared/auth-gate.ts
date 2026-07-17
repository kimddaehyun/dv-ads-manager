/**
 * F-Accounts 전면 잠금 게이트 — 콘텐츠 스크립트/popup 등에서 "이 화면을 계속 그려도 되는지"
 * 판단하는 단일 진입점.
 *
 * 콘텐츠 스크립트는 페이지당 한 번만 로드되므로, 페이지 수명 동안 `fetchAuthContext()`를
 * 딱 한 번만 호출하고 그 결과를 모듈 스코프 변수에 캐시한다 (같은 페이지에서 여러 기능이
 * init 시점마다 각자 조회하면 중복 네트워크 호출이 생기므로).
 */
import { fetchAuthContext } from "@/shared/auth-state";
import { runMigrationOnce } from "@/shared/migrate-local";

let cached: Promise<boolean> | null = null;

export async function requireApproved(): Promise<boolean> {
  if (!cached) {
    cached = fetchAuthContext()
      .then(({ state }) => {
        const approved = state === "approved";
        // 기존(이미 승인된) 세션도 이관 대상 — migrate-local의 사용자별 migrated_v1:<uid>
        // 플래그로 idempotent, 재실행돼도 즉시 skip된다. runMigrationOnce가 승인 상태를
        // 자체 확인하지만 여기서도 approved일 때만 불러 불필요한 호출을 줄인다.
        if (approved) {
          runMigrationOnce().catch((e) => {
            console.warn("[auth-gate] 이관 실패", e);
          });
        }
        return approved;
      })
      .catch(() => false);
  }
  return cached;
}
