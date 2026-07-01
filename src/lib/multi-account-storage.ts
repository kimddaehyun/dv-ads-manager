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
  MultiAccountGroup,
  MultiAccountSnapshot,
  MultiAccountDirectoryCache,
} from "@/types/storage";

const USER_META_KEY = "multi_account_user_meta";
const ADDED_LIST_KEY = "multi_account_added_list";
const GROUPS_KEY = "multi_account_groups";
const DIRECTORY_KEY = "multi_account_directory";
const SNAPSHOT_PREFIX = "multi_account_snapshot:";
const SNAPSHOT_TTL_MS = 60 * 60 * 1000; // 1시간. popover 열 때 stale 항목 자동 background refresh. 대행사 30~50계정 가정에서 너무 짧으면 매 진입마다 큰 burst — 1시간이 신선도 ↔ API 부담의 sweet spot
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

// 여러 계정을 한 번에 추가 — load 1회 + save 1회. 직렬 루프(계정마다 save) 대비 onChanged 1회만 발화.
export async function addAccountsToList(adAccountNos: number[]): Promise<number[]> {
  const list = await loadAddedList();
  let changed = false;
  for (const no of adAccountNos) {
    if (!list.includes(no)) {
      list.push(no);
      changed = true;
    }
  }
  if (changed) await saveAddedList(list);
  return list;
}

// 여러 계정을 한 번에 제거 — load 1회 + save 1회. 변경 없으면 save 생략.
export async function removeAccountsFromList(adAccountNos: number[]): Promise<number[]> {
  const list = await loadAddedList();
  const toRemove = new Set(adAccountNos);
  const next = list.filter((n) => !toRemove.has(n));
  if (next.length !== list.length) await saveAddedList(next);
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
  // 임계값 해제: undefined/null이 명시적으로 들어오면 키 자체를 제거.
  // patch에 키가 들어왔는지로 판정 — patch에 없으면 prev 값 유지.
  if ("bizMoneyThreshold" in patch && patch.bizMoneyThreshold == null) delete next.bizMoneyThreshold;
  if ("brandSearchDaysThreshold" in patch && patch.brandSearchDaysThreshold == null) delete next.brandSearchDaysThreshold;
  all[adAccountNo] = next;
  await saveAllUserMeta(all);
  return all;
}

// 여러 계정에 동일 patch를 한 번에 적용 — loadAllUserMeta 1회 + save 1회.
// 계정별 병합 규칙은 updateUserMeta와 동일(빈 값/임계값 해제 시 키 제거).
export async function updateUserMetaMany(
  adAccountNos: number[],
  patch: Partial<Omit<MultiAccountUserMeta, "adAccountNo">>,
): Promise<UserMetaMap> {
  const all = await loadAllUserMeta();
  if (adAccountNos.length === 0) return all;
  for (const adAccountNo of adAccountNos) {
    const prev = all[adAccountNo] ?? { adAccountNo };
    const next: MultiAccountUserMeta = { ...prev, ...patch, adAccountNo };
    if (next.displayName === "") delete next.displayName;
    if ("bizMoneyThreshold" in patch && patch.bizMoneyThreshold == null) delete next.bizMoneyThreshold;
    if ("brandSearchDaysThreshold" in patch && patch.brandSearchDaysThreshold == null) delete next.brandSearchDaysThreshold;
    all[adAccountNo] = next;
  }
  await saveAllUserMeta(all);
  return all;
}

export async function clearAllUserMeta(): Promise<void> {
  await chrome.storage.local.remove(USER_META_KEY);
}

// ─── 계정 그룹 (팀원별 등) ───
// "내 계정" 위에 얹는 이름 붙은 계정 묶음. 한 계정이 여러 그룹에 중복 소속 가능 →
// 그룹이 자기 멤버(accountNos)를 들고 있는 모델. 계정 메타와 분리 저장.

export async function loadGroups(): Promise<MultiAccountGroup[]> {
  const r = await chrome.storage.local.get(GROUPS_KEY);
  const raw = r[GROUPS_KEY];
  if (!Array.isArray(raw)) return [];
  // 형식 방어 + order 오름차순 정렬(저장 시 보장하지만 이관/손상 대비).
  const list = raw.filter(
    (g): g is MultiAccountGroup =>
      !!g && typeof g === "object" && typeof g.id === "string" && Array.isArray(g.accountNos),
  );
  return list.sort((a, b) => a.order - b.order);
}

export async function saveGroups(list: MultiAccountGroup[]): Promise<void> {
  await chrome.storage.local.set({ [GROUPS_KEY]: list });
}

export async function createGroup(name: string): Promise<MultiAccountGroup[]> {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) return loadGroups();
  const list = await loadGroups();
  const order = list.length > 0 ? Math.max(...list.map((g) => g.order)) + 1 : 0;
  list.push({ id: crypto.randomUUID(), name: trimmed, order, accountNos: [] });
  await saveGroups(list);
  return list;
}

export async function renameGroup(id: string, name: string): Promise<MultiAccountGroup[]> {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) return loadGroups();
  const list = await loadGroups();
  const g = list.find((x) => x.id === id);
  if (g) {
    g.name = trimmed;
    await saveGroups(list);
  }
  return list;
}

export async function deleteGroup(id: string): Promise<MultiAccountGroup[]> {
  const list = await loadGroups();
  const next = list.filter((g) => g.id !== id);
  if (next.length !== list.length) await saveGroups(next);
  return next;
}

// "내 계정"에서 삭제된 계정을 모든 그룹에서도 제거 — 유령 소속 방지.
export async function removeAccountsFromAllGroups(
  accountNos: number[],
): Promise<MultiAccountGroup[]> {
  const remove = new Set(accountNos);
  const list = await loadGroups();
  let changed = false;
  for (const g of list) {
    const before = g.accountNos.length;
    g.accountNos = g.accountNos.filter((n) => !remove.has(n));
    if (g.accountNos.length !== before) changed = true;
  }
  if (changed) await saveGroups(list);
  return list;
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

// 여러 스냅샷을 storage.get 1회로 일괄 로드 — 계정 N개를 단건 순차 호출하던 것을 1번으로 합침.
// 누락(없거나 형식 불량)은 Map에서 빠진다 (단건 loadSnapshot의 null과 동일 의미).
export async function loadSnapshotMany(
  adAccountNos: number[],
): Promise<Map<number, MultiAccountSnapshot>> {
  const result = new Map<number, MultiAccountSnapshot>();
  if (adAccountNos.length === 0) return result;
  const keys = adAccountNos.map((no) => SNAPSHOT_PREFIX + String(no));
  const r = await chrome.storage.local.get(keys);
  for (const no of adAccountNos) {
    const raw = r[SNAPSHOT_PREFIX + String(no)];
    if (raw && typeof raw === "object") result.set(no, raw as MultiAccountSnapshot);
  }
  return result;
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

// 모든 어제 데이터 스냅샷 일괄 삭제 — 플랫폼 필터 변경 시 새 필터로 재수집하도록 캐시 무효화.
export async function clearAllSnapshots(): Promise<void> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(SNAPSHOT_PREFIX));
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

// ─── 광고 유형(플랫폼) 필터 ───
// 검색광고(SA) / 디스플레이광고(DA=GFA) 표시 토글. 둘 다 켜지면 합산, 하나면 해당 유형만.
// 어제 데이터 수집 시점에 collectAccount가 읽어 SA/GFA 파이프라인을 선택 실행한다.
const PLATFORM_FILTER_KEY = "multi_account_platform_filter";

export interface PlatformFilter {
  sa: boolean;
  da: boolean;
}

export async function loadPlatformFilter(): Promise<PlatformFilter> {
  const r = await chrome.storage.local.get(PLATFORM_FILTER_KEY);
  const raw = r[PLATFORM_FILTER_KEY] as Partial<PlatformFilter> | undefined;
  // 기본값: 둘 다 켜짐(전체). 저장값이 명시적으로 false인 것만 끈다.
  if (!raw || typeof raw !== "object") return { sa: true, da: true };
  return { sa: raw.sa !== false, da: raw.da !== false };
}

export async function savePlatformFilter(filter: PlatformFilter): Promise<void> {
  await chrome.storage.local.set({ [PLATFORM_FILTER_KEY]: filter });
}

// ─── 대행권 점검: 우리 담당 관리 계정 ID ───
// 대행권 이관이 "우리 대행사"에 있는지 판별하는 기준값(담당 관리 계정 번호).
// 영업 담당자가 여러 명일 수 있어 복수 허용. 비어있으면 점검 전 설정 유도.
const AGENCY_IDENTITY_KEY = "multi_account_agency_identity";

export async function loadAgencyIdentity(): Promise<number[]> {
  const r = await chrome.storage.local.get(AGENCY_IDENTITY_KEY);
  const raw = r[AGENCY_IDENTITY_KEY] as { directManagerNos?: unknown } | undefined;
  const ids = raw?.directManagerNos;
  if (!Array.isArray(ids)) return [];
  return ids.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

export async function saveAgencyIdentity(directManagerNos: number[]): Promise<void> {
  await chrome.storage.local.set({ [AGENCY_IDENTITY_KEY]: { directManagerNos } });
}
