/**
 * F-Accounts — 로컬 이관 완료 플래그 (사용자별).
 *
 * 같은 크롬 프로필에서 다른 계정으로 로그인하면 이전 사용자의 플래그가 남아
 * 새 사용자의 이관을 건너뛰는 오염이 생기므로, 키를 `migrated_v1:<userId>`로 사용자 단위 분리.
 * migrate-local.ts(플래그 기록)와 multi-account-storage.ts(refreshFromServer 가드)가 공유한다.
 */
import { getSupabase } from "@/shared/supabase";

export function migratedFlagKey(userId: string): string {
  return `migrated_v1:${userId}`;
}

/** 현재 세션 사용자의 플래그 키. 세션이 없으면 null. */
export async function currentMigratedFlagKey(): Promise<string | null> {
  const {
    data: { session },
  } = await getSupabase().auth.getSession();
  const uid = session?.user?.id;
  return uid ? migratedFlagKey(uid) : null;
}

/** 현재 사용자의 로컬 이관 완료 여부. 세션 없으면 false. */
export async function isMigratedLocally(): Promise<boolean> {
  const key = await currentMigratedFlagKey();
  if (!key) return false;
  const r = await chrome.storage.local.get(key);
  return Boolean(r[key]);
}
