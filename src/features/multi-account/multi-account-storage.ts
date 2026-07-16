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
  ChangeWatchState,
  ChangeWatchEvent,
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
  // 끄기 = 키 제거 (false를 남겨두면 저장소에 의미 없는 값만 쌓인다)
  if ("changeWatch" in patch && !patch.changeWatch) delete next.changeWatch;
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
  // 끄기 = 키 제거 (false를 남겨두면 저장소에 의미 없는 값만 쌓인다)
  if ("changeWatch" in patch && !patch.changeWatch) delete next.changeWatch;
    all[adAccountNo] = next;
  }
  await saveAllUserMeta(all);
  return all;
}

export async function clearAllUserMeta(): Promise<void> {
  await chrome.storage.local.remove(USER_META_KEY);
}

// ─── 계정 그룹 (팀원별 등) ───
// "내 계정" 위에 얹는 이름 붙은 계정 묶음. 한 계정은 그룹 하나에만 소속(중복 금지) →
// 그룹이 자기 멤버(accountNos)를 들고 있는 모델. 계정 메타와 분리 저장.

// 한 계정은 그룹 하나에만 소속(중복 금지). order 앞선 그룹이 소유권을 갖고, 이후 그룹의
// 중복 항목(및 한 그룹 내 중복)은 제거한다. 읽기/쓰기 양쪽에 적용해 어떤 경로로도 중복이 안 생기고
// 과거에 여러 그룹에 걸쳐 있던 계정도 자동 정리된다.
function dedupeMembership(list: MultiAccountGroup[]): MultiAccountGroup[] {
  const seen = new Set<number>();
  for (const g of [...list].sort((a, b) => a.order - b.order)) {
    const uniq: number[] = [];
    for (const n of g.accountNos) {
      if (seen.has(n)) continue;
      seen.add(n);
      uniq.push(n);
    }
    g.accountNos = uniq;
  }
  return list;
}

export async function loadGroups(): Promise<MultiAccountGroup[]> {
  const r = await chrome.storage.local.get(GROUPS_KEY);
  const raw = r[GROUPS_KEY];
  if (!Array.isArray(raw)) return [];
  // 형식 방어 + order 오름차순 정렬(저장 시 보장하지만 이관/손상 대비).
  const list = raw.filter(
    (g): g is MultiAccountGroup =>
      !!g && typeof g === "object" && typeof g.id === "string" && Array.isArray(g.accountNos),
  );
  return dedupeMembership(list.sort((a, b) => a.order - b.order));
}

export async function saveGroups(list: MultiAccountGroup[]): Promise<void> {
  await chrome.storage.local.set({ [GROUPS_KEY]: dedupeMembership(list) });
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

// 드래그한 그룹(draggedId)을 targetId 그룹 위치로 옮긴다 — 배열 재배치 후 order를 인덱스로 재부여.
export async function reorderGroups(
  draggedId: string,
  targetId: string,
): Promise<MultiAccountGroup[]> {
  const list = await loadGroups(); // order 오름차순
  const from = list.findIndex((g) => g.id === draggedId);
  const to = list.findIndex((g) => g.id === targetId);
  if (from < 0 || to < 0 || from === to) return list;
  const [moved] = list.splice(from, 1);
  list.splice(to, 0, moved);
  list.forEach((g, i) => (g.order = i));
  await saveGroups(list);
  return list;
}

// 삭제된 그룹을 통째로 복원 — 드래그 삭제의 "되돌리기"용. id 중복이면 무시(이미 존재).
export async function restoreGroup(group: MultiAccountGroup): Promise<MultiAccountGroup[]> {
  const list = await loadGroups();
  if (list.some((g) => g.id === group.id)) return list;
  list.push(group);
  await saveGroups(list);
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

// 여러 계정 스냅샷을 remove 1회로 일괄 삭제 — 계정 삭제 흐름에서 호출.
// 안 지우면 만료된 스냅샷 키가 영구 잔존한다 (재추가·재방문 시 자동 재수집되므로 안전).
export async function clearSnapshots(adAccountNos: number[]): Promise<void> {
  if (adAccountNos.length === 0) return;
  await chrome.storage.local.remove(
    adAccountNos.map((no) => SNAPSHOT_PREFIX + String(no)),
  );
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

// ─── F-ChangeWatch: 변경이력 알림 ───
// 우리 대행사가 수정한 건 알림 대상이 아니다. 변경이력의 `actorDisplayName`이 이 목록에
// 있으면(또는 SYSTEM이면) 조용히 넘어가고, 그 외 사람이 만지면 알린다. 형식이 계정마다
// 제각각이라(`dvcompany:naver` / `김아라` / `GW10500`) 숫자 ID가 아닌 자유 문자열로 받는다.
// 목록이 비어있으면 우리 것도 외부로 보이므로 외부 수정 알림 자체를 끈다(예산 알림은 계속 동작).
const CHANGE_WATCH_IDENTITY_KEY = "change_watch_identity";
const CHANGE_WATCH_PREFIX = "change_watch_state:";

/** 점검 주기. 이보다 최근에 본 계정은 재조회 skip — 페이지 상주 중 반복 호출 방지. */
export const CHANGE_WATCH_TTL_MS = 30 * 60 * 1000; // 30분
/** 최초 점검 시 거슬러 올라갈 기간. 이전 이력이 한꺼번에 쏟아지지 않게 제한. */
export const CHANGE_WATCH_BOOTSTRAP_MS = 3 * 24 * 60 * 60 * 1000; // 3일
/**
 * 확인 안 한 알림 보관 기간. 확인한 알림은 다시 표시되지 않으므로 즉시 버리고(저장소 절약),
 * 확인 안 한 것도 이보다 오래되면 정리한다 — 2주 지난 걸 계속 붙들고 알릴 이유가 없다.
 */
export const CHANGE_WATCH_KEEP_MS = 14 * 24 * 60 * 60 * 1000; // 14일

export async function loadChangeWatchIdentity(): Promise<string[]> {
  const r = await chrome.storage.local.get(CHANGE_WATCH_IDENTITY_KEY);
  const raw = r[CHANGE_WATCH_IDENTITY_KEY] as { actors?: unknown } | undefined;
  const list = raw?.actors;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

export async function saveChangeWatchIdentity(actors: string[]): Promise<void> {
  await chrome.storage.local.set({ [CHANGE_WATCH_IDENTITY_KEY]: { actors } });
}

export async function loadChangeWatchState(adAccountNo: number): Promise<ChangeWatchState | null> {
  const key = CHANGE_WATCH_PREFIX + String(adAccountNo);
  const r = await chrome.storage.local.get(key);
  const raw = r[key];
  if (!raw || typeof raw !== "object") return null;
  return raw as ChangeWatchState;
}

// 스냅샷과 같은 이유로 일괄 로드 — 배지 재계산이 계정마다 storage를 때리지 않게 1회로 묶는다.
export async function loadChangeWatchStateMany(
  adAccountNos: number[],
): Promise<Map<number, ChangeWatchState>> {
  const result = new Map<number, ChangeWatchState>();
  if (adAccountNos.length === 0) return result;
  const keys = adAccountNos.map((no) => CHANGE_WATCH_PREFIX + String(no));
  const r = await chrome.storage.local.get(keys);
  for (const no of adAccountNos) {
    const raw = r[CHANGE_WATCH_PREFIX + String(no)];
    if (raw && typeof raw === "object") result.set(no, raw as ChangeWatchState);
  }
  return result;
}

export async function saveChangeWatchState(state: ChangeWatchState): Promise<void> {
  const key = CHANGE_WATCH_PREFIX + String(state.adAccountNo);
  await chrome.storage.local.set({ [key]: state });
}

export async function clearChangeWatchStates(adAccountNos: number[]): Promise<void> {
  if (adAccountNos.length === 0) return;
  await chrome.storage.local.remove(
    adAccountNos.map((no) => CHANGE_WATCH_PREFIX + String(no)),
  );
}

export function isChangeWatchFresh(state: ChangeWatchState | null): boolean {
  if (!state?.fetched_at) return false;
  const age = Date.now() - new Date(state.fetched_at).getTime();
  return age >= 0 && age < CHANGE_WATCH_TTL_MS;
}

/** 이 종류를 어디까지 확인했는지 (epoch ms). 예전 형식/누락은 0 = 전부 미확인. */
export function readUpToFor(
  state: ChangeWatchState | null,
  kind: ChangeWatchEvent["kind"],
): number {
  if (!state) return 0;
  return (kind === "budget" ? state.read_budget_up_to : state.read_external_up_to) ?? 0;
}

/** 아직 확인하지 않은 알림. kind를 주면 그 종류만. */
export function unreadChangeWatchEvents(
  state: ChangeWatchState | null,
  kind?: ChangeWatchEvent["kind"],
): ChangeWatchState["events"] {
  if (!state) return [];
  return state.events.filter(
    (e) => (!kind || e.kind === kind) && e.ts > readUpToFor(state, e.kind),
  );
}
