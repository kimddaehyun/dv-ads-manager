/**
 * F-MultiAccount — 광고계정 사용자 편집 메타 영속 저장소.
 *
 * 광고계정 명단 자체는 `/apis/ad-account/v1.1/adAccounts/access`로 자동 수집한다.
 * 본 모듈은 자동 명단 위에 덧씌우는 사용자 커스터마이징(별칭/즐겨찾기/숨김/순서)만 관리한다.
 *
 * 캐시 스냅샷(어제 데이터/비즈머니/계약)은 별도 모듈에서 관리 (`multi-account-data.ts`).
 */

import type {
  MultiAccountUserMeta,
  MultiAccountSnapshot,
  MultiAccountDirectoryCache,
} from "@/types/storage";

const USER_META_KEY = "multi_account_user_meta";
const ADDED_LIST_KEY = "multi_account_added_list";
const DIRECTORY_KEY = "multi_account_directory";
const SNAPSHOT_PREFIX = "multi_account_snapshot:";
const SNAPSHOT_TTL_MS = 30 * 60 * 1000; // 30분. 비즈머니는 가장 자주 변하지만 30분 TTL + 사용자가 그 계정 페이지 진입 시 자연 캐싱으로 충분. 더 짧게 두면 사용자가 popover 열 때마다 N개 iframe 띄워야 해서 부담
const DIRECTORY_STALE_MS = 24 * 60 * 60 * 1000; // 1일

type UserMetaMap = Record<number, MultiAccountUserMeta>;

// ─── 추가된 광고계정 리스트 (사용자가 명시적으로 추가한 것만) ───

export async function loadAddedList(): Promise<number[]> {
  const r = await chrome.storage.local.get(ADDED_LIST_KEY);
  const raw = r[ADDED_LIST_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is number => typeof x === "number");
}

export async function saveAddedList(list: number[]): Promise<void> {
  await chrome.storage.local.set({ [ADDED_LIST_KEY]: list });
}

export async function addAccountToList(adAccountNo: number): Promise<number[]> {
  const list = await loadAddedList();
  if (list.includes(adAccountNo)) return list;
  list.push(adAccountNo);
  await saveAddedList(list);
  return list;
}

export async function removeAccountFromList(adAccountNo: number): Promise<number[]> {
  const list = await loadAddedList();
  const next = list.filter((n) => n !== adAccountNo);
  await saveAddedList(next);
  return next;
}

export async function moveAccountInList(adAccountNo: number, direction: -1 | 1): Promise<number[]> {
  const list = await loadAddedList();
  const idx = list.indexOf(adAccountNo);
  if (idx < 0) return list;
  const next = idx + direction;
  if (next < 0 || next >= list.length) return list;
  [list[idx], list[next]] = [list[next], list[idx]];
  await saveAddedList(list);
  return list;
}

export async function loadAllUserMeta(): Promise<UserMetaMap> {
  const r = await chrome.storage.local.get(USER_META_KEY);
  const raw = r[USER_META_KEY];
  if (!raw || typeof raw !== "object") return {};
  return raw as UserMetaMap;
}

export async function saveAllUserMeta(map: UserMetaMap): Promise<void> {
  await chrome.storage.local.set({ [USER_META_KEY]: map });
}

export async function updateUserMeta(
  adAccountNo: number,
  patch: Partial<Omit<MultiAccountUserMeta, "adAccountNo">>,
): Promise<UserMetaMap> {
  const all = await loadAllUserMeta();
  const prev = all[adAccountNo] ?? { adAccountNo };
  const next: MultiAccountUserMeta = { ...prev, ...patch, adAccountNo };
  // 빈 값은 키 제거 (저장소 깔끔하게)
  if (next.displayName === "") delete next.displayName;
  all[adAccountNo] = next;
  await saveAllUserMeta(all);
  return all;
}

export async function clearAllUserMeta(): Promise<void> {
  await chrome.storage.local.remove(USER_META_KEY);
}

export async function loadDirectory(): Promise<MultiAccountDirectoryCache | null> {
  const r = await chrome.storage.local.get(DIRECTORY_KEY);
  const raw = r[DIRECTORY_KEY];
  if (!raw || typeof raw !== "object") return null;
  return raw as MultiAccountDirectoryCache;
}

export async function saveDirectory(d: MultiAccountDirectoryCache): Promise<void> {
  await chrome.storage.local.set({ [DIRECTORY_KEY]: d });
}

export async function clearDirectory(): Promise<void> {
  await chrome.storage.local.remove(DIRECTORY_KEY);
}

export function isDirectoryStale(cache: MultiAccountDirectoryCache | null): boolean {
  if (!cache?.fetched_at) return true;
  const age = Date.now() - new Date(cache.fetched_at).getTime();
  return age < 0 || age > DIRECTORY_STALE_MS;
}

export async function loadSnapshot(adAccountNo: number): Promise<MultiAccountSnapshot | null> {
  const key = SNAPSHOT_PREFIX + String(adAccountNo);
  const r = await chrome.storage.local.get(key);
  const raw = r[key];
  if (!raw || typeof raw !== "object") return null;
  return raw as MultiAccountSnapshot;
}

export async function saveSnapshot(snapshot: MultiAccountSnapshot): Promise<void> {
  const key = SNAPSHOT_PREFIX + String(snapshot.adAccountNo);
  await chrome.storage.local.set({ [key]: snapshot });
}

export async function clearSnapshot(adAccountNo: number): Promise<void> {
  const key = SNAPSHOT_PREFIX + String(adAccountNo);
  await chrome.storage.local.remove(key);
}

export function isSnapshotFresh(snapshot: MultiAccountSnapshot | null): boolean {
  if (!snapshot?.fetched_at) return false;
  const age = Date.now() - new Date(snapshot.fetched_at).getTime();
  return age >= 0 && age < SNAPSHOT_TTL_MS;
}
