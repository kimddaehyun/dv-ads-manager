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
import {
  pullAll,
  pushMeta,
  pushGroups,
  deleteMeta,
  pullChangeWatchStates,
  pushChangeWatchState,
  deleteChangeWatchStates,
  pullUserSettings,
  pushUserSettings,
} from "@/shared/server-store";

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

// 순수 로컬 캐시 쓰기 — migrate-local.ts의 download(서버→로컬) 경로가 그대로 재사용하므로
// 여기서 서버 push를 하면 그 경로가 서버 데이터를 서버로 되쏘는 낭비/경합이 생긴다.
// 서버 반영은 아래 add/remove/move 계열(호출부)이 각자 담당한다.
export async function saveAddedList(list: number[]): Promise<void> {
  await chrome.storage.local.set({ [ADDED_LIST_KEY]: list });
}

// 추가 목록이 바뀔 때마다 "이전 목록 ∪ 새 목록"에 속한 모든 계정의 meta 행을 서버에 전체 재동기화.
// 부분(touched 계정만) push로는 로컬 index로 계산한 added_order가 건드리지 않은 계정에서는
// 서버에 stale 값으로 남아, remove→add 반복 시 서버 순서가 로컬과 어긋난다(리뷰 지적) —
// pullAll()이 added_order로 정렬해 다른 기기에서 순서가 조용히 뒤바뀌는 원인이었다.
// 그룹(pushAndSaveGroups)처럼 전체 교체 방식으로 통일한다. 실패 시 throw(호출부가 토스트로 안내),
// 로컬 저장은 전체 push 성공 후에만 실행(서버 우선 원칙).
async function pushAddedState(prevList: number[], nextList: number[]): Promise<void> {
  const allMeta = await loadAllUserMeta();
  const order = new Map(nextList.map((no, i) => [no, i]));
  const added = new Set(nextList);
  const affected = new Set([...prevList, ...nextList]);
  for (const no of affected) {
    const meta = allMeta[no] ?? { adAccountNo: no };
    await pushMeta(meta, added.has(no), order.get(no) ?? 0);
  }
}

export async function addAccountToList(adAccountNo: number): Promise<number[]> {
  const list = await loadAddedList();
  if (list.includes(adAccountNo)) return list;
  const next = [...list, adAccountNo];
  await pushAddedState(list, next);
  await saveAddedList(next);
  return next;
}

export async function removeAccountFromList(adAccountNo: number): Promise<number[]> {
  const list = await loadAddedList();
  const next = list.filter((n) => n !== adAccountNo);
  await pushAddedState(list, next);
  await saveAddedList(next);
  return next;
}

// 여러 계정을 한 번에 추가 — load 1회 + save 1회. 직렬 루프(계정마다 save) 대비 onChanged 1회만 발화.
export async function addAccountsToList(adAccountNos: number[]): Promise<number[]> {
  const list = await loadAddedList();
  const next = [...list];
  let changed = false;
  for (const no of adAccountNos) {
    if (!next.includes(no)) {
      next.push(no);
      changed = true;
    }
  }
  if (changed) {
    await pushAddedState(list, next);
    await saveAddedList(next);
  }
  return next;
}

// 여러 계정을 한 번에 제거 — load 1회 + save 1회. 변경 없으면 save 생략.
export async function removeAccountsFromList(adAccountNos: number[]): Promise<number[]> {
  const list = await loadAddedList();
  const toRemove = new Set(adAccountNos);
  const next = list.filter((n) => !toRemove.has(n));
  if (next.length !== list.length) {
    await pushAddedState(list, next);
    await saveAddedList(next);
  }
  return next;
}

export async function moveAccountInList(adAccountNo: number, direction: -1 | 1): Promise<number[]> {
  const list = await loadAddedList();
  const idx = list.indexOf(adAccountNo);
  if (idx < 0) return list;
  const next = idx + direction;
  if (next < 0 || next >= list.length) return list;
  const nextList = [...list];
  [nextList[idx], nextList[next]] = [nextList[next], nextList[idx]];
  await pushAddedState(list, nextList);
  await saveAddedList(nextList);
  return nextList;
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
  // 이 계정 한 행만 push — 전체 맵을 매번 올리는 건 낭비.
  const addedList = await loadAddedList();
  const added = addedList.includes(adAccountNo);
  await pushMeta(next, added, added ? addedList.indexOf(adAccountNo) : 0);
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
  const addedList = await loadAddedList();
  for (const adAccountNo of adAccountNos) {
    const added = addedList.includes(adAccountNo);
    await pushMeta(all[adAccountNo], added, added ? addedList.indexOf(adAccountNo) : 0);
  }
  await saveAllUserMeta(all);
  return all;
}

export async function clearAllUserMeta(): Promise<void> {
  const all = await loadAllUserMeta();
  const nos = Object.keys(all).map(Number);
  for (const no of nos) {
    await deleteMeta(no);
  }
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

// 순수 로컬 캐시 쓰기 — migrate-local.ts의 download(서버→로컬) 경로가 그대로 재사용하므로
// 여기서 서버 push를 하면 그 경로가 서버 데이터를 서버로 되쏘는 낭비/경합이 생긴다.
// 서버 반영은 아래 그룹 뮤테이터들이 pushGroups로 각자 담당한다.
export async function saveGroups(list: MultiAccountGroup[]): Promise<void> {
  await chrome.storage.local.set({ [GROUPS_KEY]: dedupeMembership(list) });
}

// 서버 push(전체 교체) 후 로컬 캐시 갱신 — 그룹을 실제로 바꾸는 호출부 전용.
// (migrate-local.ts의 download 경로는 saveGroups를 직접 써서 이 함수를 거치지 않는다.)
export async function pushAndSaveGroups(list: MultiAccountGroup[]): Promise<void> {
  await pushGroups(list);
  await saveGroups(list);
}

export async function createGroup(name: string): Promise<MultiAccountGroup[]> {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) return loadGroups();
  const list = await loadGroups();
  const order = list.length > 0 ? Math.max(...list.map((g) => g.order)) + 1 : 0;
  list.push({ id: crypto.randomUUID(), name: trimmed, order, accountNos: [] });
  await pushAndSaveGroups(list);
  return list;
}

export async function renameGroup(id: string, name: string): Promise<MultiAccountGroup[]> {
  const trimmed = name.trim().slice(0, 24);
  if (!trimmed) return loadGroups();
  const list = await loadGroups();
  const g = list.find((x) => x.id === id);
  if (g) {
    g.name = trimmed;
    await pushAndSaveGroups(list);
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
  await pushAndSaveGroups(list);
  return list;
}

// 삭제된 그룹을 통째로 복원 — 드래그 삭제의 "되돌리기"용. id 중복이면 무시(이미 존재).
export async function restoreGroup(group: MultiAccountGroup): Promise<MultiAccountGroup[]> {
  const list = await loadGroups();
  if (list.some((g) => g.id === group.id)) return list;
  list.push(group);
  await pushAndSaveGroups(list);
  return list;
}

export async function deleteGroup(id: string): Promise<MultiAccountGroup[]> {
  const list = await loadGroups();
  const next = list.filter((g) => g.id !== id);
  if (next.length !== list.length) await pushAndSaveGroups(next);
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
  if (changed) await pushAndSaveGroups(list);
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

// 로그아웃 시 사용자 종속 로컬 상태 일괄 제거 — 같은 크롬 프로필에서 계정을 전환하면
// 이전 사용자의 별칭/그룹/추가목록/계정 스냅샷이 남아 새 사용자 화면을 오염시킨다.
export async function clearLocalAccountState(): Promise<void> {
  await chrome.storage.local.remove([USER_META_KEY, GROUPS_KEY, ADDED_LIST_KEY]);
  await clearAllSnapshots();
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

// 사용자 설정 3종(광고 유형 필터·대행권 기준 번호·알림 제외 변경자)은 서버가 원본 —
// 서버 저장이 성공해야 로컬 캐시를 갱신한다(실패 시 throw, 호출부가 withServerSave로 처리).
export async function savePlatformFilter(filter: PlatformFilter): Promise<void> {
  await pushUserSettings({ platformSa: filter.sa, platformDa: filter.da });
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
  await pushUserSettings({ agencyManagerNos: directManagerNos });
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
export const CHANGE_WATCH_TTL_MS = 10 * 60 * 1000; // 10분
/**
 * 알림 보관 기간. 확인(모두 읽음) 여부와 무관하게 계정별로 이 기간만큼 이력을 남긴다 —
 * 확인했다고 지워버리면 "그때 무슨 일이 있었는지" 되짚을 수 없다. 지나면 자동 정리.
 */
export const CHANGE_WATCH_KEEP_MS = 60 * 24 * 60 * 60 * 1000; // 60일
/**
 * 서버 체크포인트 최대 지연. 새 알림 없는 점검은 서버 쓰기를 생략하지만, 마지막 동기화가
 * 이보다 뒤처지면 체크포인트만이라도 올린다 — 로컬 유실(확장 재설치) 시 서버에서 이어받을 때
 * 놓치는 구간을 이 시간 이내로 묶는다. 쓰기량은 계정당 시간당 최대 1회.
 */
export const CHANGE_WATCH_SERVER_SYNC_MAX_LAG_MS = 60 * 60 * 1000; // 1시간

export async function loadChangeWatchIdentity(): Promise<string[]> {
  const r = await chrome.storage.local.get(CHANGE_WATCH_IDENTITY_KEY);
  const raw = r[CHANGE_WATCH_IDENTITY_KEY] as { actors?: unknown } | undefined;
  const list = raw?.actors;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

export async function saveChangeWatchIdentity(actors: string[]): Promise<void> {
  await pushUserSettings({ changeWatchActors: actors });
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

/**
 * 서버(change_watch_state)가 원본, 로컬은 캐시. 다만 이건 사용자 입력이 아니라 수집 결과라
 * 서버 쓰기가 실패해도 로컬 저장까지 막지는 않는다 — 점검이 통째로 헛돌면 알림 자체가 끊긴다.
 * 서버에 못 올린 분은 다음 점검이나 [모두 읽음] 때 같은 행을 다시 upsert하며 따라잡는다.
 *
 * localOnly: 새 알림 없이 scanned_until만 전진한 점검은 서버에 쓸 게 없다 — 주기(10분)마다
 * 계정 수만큼 upsert가 나가는 걸 막기 위해 로컬 캐시만 갱신한다. 서버 푸시가 성공한
 * 경우에만 server_synced_until을 전진시켜, 실패를 동기화 완료로 착각하지 않는다.
 */
export async function saveChangeWatchState(
  state: ChangeWatchState,
  opts?: { localOnly?: boolean },
): Promise<void> {
  const key = CHANGE_WATCH_PREFIX + String(state.adAccountNo);
  if (!opts?.localOnly) {
    try {
      await pushChangeWatchState(state);
      state = { ...state, server_synced_until: state.scanned_until };
    } catch (e) {
      console.warn("[dv-ads/change-watch] 서버 저장 실패 - 로컬에만 반영", state.adAccountNo, e);
    }
  }
  await chrome.storage.local.set({ [key]: state });
}

export async function clearChangeWatchStates(adAccountNos: number[]): Promise<void> {
  if (adAccountNos.length === 0) return;
  try {
    await deleteChangeWatchStates(adAccountNos);
  } catch (e) {
    console.warn("[dv-ads/change-watch] 서버 삭제 실패", adAccountNos, e);
  }
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

/** 광고주센터 알림(피드에 id가 없어 제목이 키)의 읽음 키 */
export function naverIssueReadKey(title: string): string {
  return `naver:${title}`;
}

/** 항목 단위로 읽음 처리했는지 — 변경이력은 이벤트 id, 알림은 naverIssueReadKey. */
export function isReadById(state: ChangeWatchState | null, key: string): boolean {
  return !!state?.read_ids?.includes(key);
}

/** 아직 확인하지 않은 알림. kind를 주면 그 종류만. */
export function unreadChangeWatchEvents(
  state: ChangeWatchState | null,
  kind?: ChangeWatchEvent["kind"],
): ChangeWatchState["events"] {
  if (!state) return [];
  return state.events.filter(
    (e) =>
      (!kind || e.kind === kind) &&
      e.ts > readUpToFor(state, e.kind) &&
      !isReadById(state, e.id),
  );
}

/** 읽음 키를 추가한 새 상태 (저장은 호출부). 중복은 합집합으로 흡수. */
export function withReadIds(state: ChangeWatchState, keys: string[]): ChangeWatchState {
  return { ...state, read_ids: [...new Set([...(state.read_ids ?? []), ...keys])] };
}

// ─── F-Accounts: 서버 → 로컬 캐시 새로고침 ───
// 대시보드(popover)를 열 때 1회 fire-and-forget으로 호출 — 다른 기기/프로필에서 바뀐
// 별칭·그룹·추가목록을 반영한다. 실패해도 로컬 캐시로 그대로 렌더되므로 호출부는 catch만 하면 된다.
export async function refreshFromServer(): Promise<void> {
  // 이관(migrate-local)이 끝나기 전에는 실행 금지 — 미이관 상태에서 서버의 빈 상태를
  // 로컬에 쓰면 아직 올리지 못한 로컬 데이터가 지워진다. 로컬 이관 완료 플래그를 먼저 확인.
  const { isMigratedLocally } = await import("@/shared/migration-flag");
  if (!(await isMigratedLocally())) return;

  const server = await pullAll();
  await saveAllUserMeta(server.metaMap);
  await saveGroups(server.groups);
  await saveAddedList(server.addedList);
  await mergeChangeWatchFromServer();
  await pullUserSettingsToLocal();
}

/**
 * 사용자 설정(알림 제외 변경자·대행권 기준 번호·광고 유형 필터·리포트 담당자)을 서버에서
 * 로컬 캐시로 내려받는다. 서버에 행이 없으면(이 기능 도입 전 사용자) **로컬을 그대로 두고
 * 한 번 올려준다** — 안 그러면 이미 설정해 둔 값이 기본값으로 리셋된 것처럼 보인다.
 */
async function pullUserSettingsToLocal(): Promise<void> {
  const server = await pullUserSettings();
  if (!server) {
    const [actors, managerNos, filter] = await Promise.all([
      loadChangeWatchIdentity(),
      loadAgencyIdentity(),
      loadPlatformFilter(),
    ]);
    const author = await loadReportAuthor();
    const withMessage = await loadReportWithMessage();
    await pushUserSettings({
      changeWatchActors: actors,
      agencyManagerNos: managerNos,
      platformSa: filter.sa,
      platformDa: filter.da,
      reportAuthor: author,
      reportWithMessage: withMessage,
    });
    return;
  }
  await chrome.storage.local.set({
    [CHANGE_WATCH_IDENTITY_KEY]: { actors: server.changeWatchActors },
    [AGENCY_IDENTITY_KEY]: { directManagerNos: server.agencyManagerNos },
    [PLATFORM_FILTER_KEY]: { sa: server.platformSa, da: server.platformDa },
    [REPORT_AUTHOR_KEY]: server.reportAuthor,
    [REPORT_WITH_MESSAGE_KEY]: server.reportWithMessage,
  });
}

// 리포트 담당자명 — 입력 위치는 F-Report 날짜 선택기지만, 사용자 설정 묶음이라 여기서 관리.
export const REPORT_AUTHOR_KEY = "report_last_author";

export async function loadReportAuthor(): Promise<string> {
  const r = await chrome.storage.local.get(REPORT_AUTHOR_KEY);
  const v = r[REPORT_AUTHOR_KEY];
  return typeof v === "string" ? v : "";
}

export async function saveReportAuthor(author: string): Promise<void> {
  await pushUserSettings({ reportAuthor: author });
  await chrome.storage.local.set({ [REPORT_AUTHOR_KEY]: author });
}

// 리포트 "문구 생성" 토글 마지막 상태 — 담당자명과 동일 패턴(서버 원본 + 로컬 캐시).
export const REPORT_WITH_MESSAGE_KEY = "report_with_message";

export async function loadReportWithMessage(): Promise<boolean> {
  const r = await chrome.storage.local.get(REPORT_WITH_MESSAGE_KEY);
  return r[REPORT_WITH_MESSAGE_KEY] === true;
}

export async function saveReportWithMessage(on: boolean): Promise<void> {
  await pushUserSettings({ reportWithMessage: on });
  await chrome.storage.local.set({ [REPORT_WITH_MESSAGE_KEY]: on });
}

/**
 * 서버의 계정 이슈 이력을 로컬과 합친다. 다른 PC에서 점검한 결과를 이어받되, 이쪽에서
 * 방금 잡아 아직 못 올린 알림도 지우지 않도록 **덮어쓰기가 아니라 병합**한다 —
 * 알림은 id로 합집합, 확인 시각/점검 시각은 더 나중 것을 채택한다.
 */
async function mergeChangeWatchFromServer(): Promise<void> {
  const states = await pullChangeWatchStates();
  if (states.length === 0) return;
  const local = await loadChangeWatchStateMany(states.map((s) => s.adAccountNo));
  const patch: Record<string, ChangeWatchState> = {};
  for (const remote of states) {
    const mine = local.get(remote.adAccountNo);
    const byId = new Map<string, ChangeWatchEvent>();
    for (const e of mine?.events ?? []) byId.set(e.id, e);
    for (const e of remote.events) byId.set(e.id, e);
    patch[CHANGE_WATCH_PREFIX + String(remote.adAccountNo)] = {
      adAccountNo: remote.adAccountNo,
      events: [...byId.values()].sort((a, b) => b.ts - a.ts),
      scanned_until: Math.max(remote.scanned_until, mine?.scanned_until ?? 0),
      read_budget_up_to: Math.max(remote.read_budget_up_to, mine?.read_budget_up_to ?? 0),
      read_external_up_to: Math.max(remote.read_external_up_to, mine?.read_external_up_to ?? 0),
      // 읽음은 합집합 — 어느 기기에서 읽었든 읽은 것으로 본다.
      read_ids: [...new Set([...(remote.read_ids ?? []), ...(mine?.read_ids ?? [])])],
      // fetched_at은 더 나중 것 — 서버의 옛 값이 이기면 방금 점검한 계정이 stale 판정되어
      // 다음 주기에 즉시 재조회된다.
      fetched_at:
        mine && mine.fetched_at > remote.fetched_at ? mine.fetched_at : remote.fetched_at,
      // 서버 행이 존재한다 = 그 시점까지는 동기화돼 있었다. 로컬 기록이 더 최신이면 그쪽 우선.
      // 없이 두면 0으로 떨어져 조용한 점검마다 서버 쓰기가 재개된다(스로틀 무력화).
      server_synced_until: Math.max(remote.scanned_until, mine?.server_synced_until ?? 0),
    };
  }
  await chrome.storage.local.set(patch);
}
