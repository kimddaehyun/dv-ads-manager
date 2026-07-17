/**
 * F-Accounts — 검색광고 API 자격증명을 서버(Supabase Edge Function `credentials-vault`)에
 * 저장/조회하는 얇은 클라이언트. `migrate-local.ts`(첫 로그인 1회성 이관)와
 * `searchad.ts`(loadCredentials/saveCredentials 평상시 read/write)가 공유한다 — 구현은 여기 하나만.
 *
 * 반드시 로그인 세션이 있는 컨텍스트(확장 페이지·콘텐츠 스크립트)에서만 호출한다. 서비스 워커에는
 * `window`가 없어 호출부(searchad.ts)가 그 컨텍스트에서는 이 모듈을 아예 동적 import하지 않는다.
 */
import { getSupabase } from "@/shared/supabase";
import type { SearchadCredentials } from "@/shared/searchad";

const VAULT_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co/functions/v1/credentials-vault";

async function vaultCall(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error("로그인 세션이 없습니다");

  const res = await fetch(VAULT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  // 401 = 세션 만료(또는 미승인) — 사용자에게 보이는 메시지는 일상 한글로.
  if (res.status === 401) throw new Error("로그인이 만료됐어요. 다시 로그인해 주세요");
  if (!res.ok) throw new Error(`vault 호출 실패 (${res.status})`);
  return res.json();
}

export async function vaultLoad(): Promise<SearchadCredentials | null> {
  const result = await vaultCall({ action: "load" });
  const credentials = result.credentials as SearchadCredentials | null | undefined;
  return credentials ?? null;
}

export async function vaultSave(cred: SearchadCredentials): Promise<void> {
  await vaultCall({
    action: "save",
    customerId: cred.customerId,
    accessLicense: cred.accessLicense,
    secretKey: cred.secretKey,
  });
}

/** 서버에 저장된 자격증명 행 삭제. 실패 시 throw — 호출부(UI)가 실패를 사용자에게 알린다. */
export async function vaultDelete(): Promise<void> {
  await vaultCall({ action: "delete" });
}
