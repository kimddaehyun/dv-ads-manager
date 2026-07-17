/**
 * F-Accounts — 첫 로그인 시 로컬 캐시(chrome.storage.local) ↔ 서버(Supabase) 1회성 이관.
 *
 * 규칙: 서버에 데이터가 하나라도 있으면 "서버가 이긴다" (로컬을 덮어씀 — 다른 프로필/PC에서
 * 이미 이관된 사용자가 재로그인할 때 로컬의 낡은 캐시로 서버를 되돌리지 않기 위함).
 * 서버가 비어 있으면 이번이 첫 이관이므로 로컬 것을 올린다.
 *
 * `migrated_v1` 플래그로 idempotent — 실패 시 플래그를 남기지 않아 다음 로그인 때 재시도.
 * vault(Edge Function `credentials-vault`)는 별도 클라이언트 모듈이 아직 없어 여기서 직접 fetch.
 */
import { getSupabase } from "@/shared/supabase";
import { pullAll, pushMeta, pushGroups } from "@/shared/server-store";
import {
  loadAllUserMeta,
  saveAllUserMeta,
  loadGroups,
  saveGroups,
  loadAddedList,
  saveAddedList,
} from "@/features/multi-account/multi-account-storage";
import { loadCredentials, saveCredentials, type SearchadCredentials } from "@/shared/searchad";

const VAULT_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co/functions/v1/credentials-vault";
const MIGRATED_FLAG_KEY = "migrated_v1";

/** 서버 우선 규칙: 서버에 데이터가 있으면 download(서버→로컬), 없으면 upload(로컬→서버). */
export function decideMigration(serverHasData: boolean): "upload" | "download" {
  return serverHasData ? "download" : "upload";
}

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
  if (!res.ok) throw new Error(`vault 호출 실패 (${res.status})`);
  return res.json();
}

async function vaultLoad(): Promise<SearchadCredentials | null> {
  const result = await vaultCall({ action: "load" });
  const credentials = result.credentials as SearchadCredentials | null | undefined;
  return credentials ?? null;
}

async function vaultSave(cred: SearchadCredentials): Promise<void> {
  await vaultCall({
    action: "save",
    customerId: cred.customerId,
    accessLicense: cred.accessLicense,
    secretKey: cred.secretKey,
  });
}

/** 로그인 직후 1회 호출. 이미 이관됐으면(플래그 있음) 즉시 skip. */
export async function runMigrationOnce(): Promise<void> {
  const flagRes = await chrome.storage.local.get(MIGRATED_FLAG_KEY);
  // 알려진 경쟁: 여러 탭이 동시에 이 함수를 돌 수 있다(탭마다 컨텍스트 분리라 락 없음).
  // pushMeta는 upsert, pushGroups는 전체 교체라 중복 실행은 중복 쓰기일 뿐 데이터가 깨지지 않는다.
  if (flagRes[MIGRATED_FLAG_KEY]) return;

  const [server, vaultCred] = await Promise.all([pullAll(), vaultLoad()]);
  const serverHasData =
    Object.keys(server.metaMap).length > 0 || server.groups.length > 0 || vaultCred !== null;

  const direction = decideMigration(serverHasData);

  if (direction === "upload") {
    const [localMetaMap, localGroups, localAddedList, localCred] = await Promise.all([
      loadAllUserMeta(),
      loadGroups(),
      loadAddedList(),
      loadCredentials(),
    ]);

    const addedOrder = new Map(localAddedList.map((no, i) => [no, i]));
    for (const meta of Object.values(localMetaMap)) {
      const added = addedOrder.has(meta.adAccountNo);
      await pushMeta(meta, added, addedOrder.get(meta.adAccountNo) ?? 0);
    }
    await pushGroups(localGroups);
    if (localCred) await vaultSave(localCred);
  } else {
    await saveAllUserMeta(server.metaMap);
    await saveGroups(server.groups);
    await saveAddedList(server.addedList);
    if (vaultCred) await saveCredentials(vaultCred);
  }

  await chrome.storage.local.set({ [MIGRATED_FLAG_KEY]: true });
  await chrome.storage.local.remove("brief_token");
}
