/**
 * F-Accounts — 첫 로그인 시 로컬 캐시(chrome.storage.local) ↔ 서버(Supabase) 1회성 이관.
 *
 * 방향 규칙: 서버 프로필의 `migrated_at`(이관 완료 마커)이 기록돼 있으면 download(서버→로컬),
 * 아니면 upload(로컬→서버). "서버에 데이터가 있는지"로 판단하면 부분 업로드 후 재시도가
 * download로 뒤집혀 로컬을 지워버린다 — 마커 기준이면 부분 업로드 상태에서 재시도해도
 * upload가 재개된다. 마커는 업로드가 전부 성공한 뒤에만 RPC `mark_migrated`로 기록.
 *
 * 로컬 플래그는 사용자별(`migrated_v1:<userId>`)로 idempotent — 실패 시 플래그를 남기지 않아
 * 다음 로그인 때 재시도. 다른 사용자로 전환하면 그 사용자 기준으로 다시 이관한다.
 */
import { getSupabase } from "@/shared/supabase";
import { fetchAuthContext } from "@/shared/auth-state";
import { pullAll, pushMetaMany, pushGroups } from "@/shared/server-store";
import { currentMigratedFlagKey } from "@/shared/migration-flag";
import {
  loadAllUserMeta,
  saveAllUserMeta,
  loadGroups,
  saveGroups,
  loadAddedList,
  saveAddedList,
} from "@/features/multi-account/multi-account-storage";
import { loadCredentials, saveCredentials } from "@/shared/searchad";
import { vaultLoad, vaultSave } from "@/shared/vault";

/** 서버가 이관 완료를 기록했으면 download(서버→로컬), 아니면 upload(로컬→서버). */
export function decideMigration(serverMigrated: boolean): "upload" | "download" {
  return serverMigrated ? "download" : "upload";
}

/** 이관 전 로컬 원본 백업 키. 어떤 경로로든 사고가 나도 복구할 사본을 남긴다 — 지우지 않는다. */
export const PREMIGRATION_BACKUP_KEY = "premigration_backup_v1";

const BACKUP_SOURCE_KEYS = [
  "multi_account_user_meta",
  "multi_account_groups",
  "multi_account_added_list",
  "searchadCredentials",
] as const;

/**
 * 로컬 사용자 데이터(별칭·그룹·추가목록·자격증명)를 통째로 백업 키에 1회 복사.
 * 이미 백업이 있으면 덮지 않는다 — 최초 상태가 가장 가치 있는 원본이다.
 */
async function backupLocalOnce(): Promise<void> {
  const existing = await chrome.storage.local.get(PREMIGRATION_BACKUP_KEY);
  if (existing[PREMIGRATION_BACKUP_KEY]) return;
  const data = await chrome.storage.local.get([...BACKUP_SOURCE_KEYS]);
  if (Object.keys(data).length === 0) return; // 백업할 게 없음(신규 설치)
  await chrome.storage.local.set({
    [PREMIGRATION_BACKUP_KEY]: { savedAt: new Date().toISOString(), data },
  });
}

/** 로그인 직후 1회 호출. 이미 이관됐으면(플래그 있음) 즉시 skip. */
export async function runMigrationOnce(): Promise<void> {
  // 승인 상태를 가장 먼저 확인 — vault 401에 안전성을 기대지 않는다.
  const { state } = await fetchAuthContext();
  if (state !== "approved") return;

  const flagKey = await currentMigratedFlagKey();
  if (!flagKey) return; // 세션 없음
  // 알려진 경쟁: 여러 탭이 동시에 이 함수를 돌 수 있다(탭마다 컨텍스트 분리라 락 없음).
  // pushMetaMany는 upsert, pushGroups는 전체 교체라 중복 실행은 중복 쓰기일 뿐 데이터가 깨지지 않는다.
  const flagRes = await chrome.storage.local.get(flagKey);
  if (flagRes[flagKey]) return;

  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) return;

  // 방향 판단은 본인 프로필의 migrated_at(서버측 이관 완료 마커) 기준.
  const { data: profileRow, error: profileErr } = await supabase
    .from("profiles")
    .select("migrated_at")
    .eq("id", uid)
    .maybeSingle();
  if (profileErr) throw profileErr;

  const direction = decideMigration(Boolean(profileRow?.migrated_at));

  // 어느 방향이든 로컬을 건드리기 전에 원본을 백업 — download는 로컬을 덮고,
  // upload도 이후 로그아웃 정리 등과 얽힐 수 있어 복구 사본을 남긴다.
  await backupLocalOnce();

  if (direction === "upload") {
    const [localMetaMap, localGroups, localAddedList, localCred] = await Promise.all([
      loadAllUserMeta(),
      loadGroups(),
      loadAddedList(),
      loadCredentials(),
    ]);

    // meta 전체를 배열 upsert 1회로 밀어 partial 창을 최소화.
    const addedOrder = new Map(localAddedList.map((no, i) => [no, i]));
    await pushMetaMany(
      Object.values(localMetaMap).map((meta) => ({
        meta,
        added: addedOrder.has(meta.adAccountNo),
        order: addedOrder.get(meta.adAccountNo) ?? 0,
      })),
    );
    await pushGroups(localGroups);
    if (localCred) await vaultSave(localCred);

    // 전부 성공한 뒤에만 서버측 완료 마커 기록 — 이후 다른 기기는 download.
    const { error: rpcErr } = await supabase.rpc("mark_migrated");
    if (rpcErr) throw rpcErr;
  } else {
    // 서버가 이미 이관 완료 — 서버가 이긴다(다른 프로필/PC의 낡은 로컬로 되돌리지 않음).
    const [server, vaultCred] = await Promise.all([pullAll(), vaultLoad()]);
    await saveAllUserMeta(server.metaMap);
    await saveGroups(server.groups);
    await saveAddedList(server.addedList);
    if (vaultCred) await saveCredentials(vaultCred);
  }

  await chrome.storage.local.set({ [flagKey]: true });
  await chrome.storage.local.remove("brief_token");
}
