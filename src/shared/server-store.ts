// F-Accounts — Supabase 서버 스토어 (account_meta / account_groups / change_watch_state CRUD).
// 서버 먼저 반영하고, 성공 시 로컬 캐시(chrome.storage.local) 갱신은 호출부(Task 9) 책임.
import { getSupabase } from "@/shared/supabase";
import type {
  MultiAccountUserMeta,
  MultiAccountGroup,
  ChangeWatchState,
} from "@/types/storage";

export type UserMetaMap = Record<number, MultiAccountUserMeta>;

/** account_meta 테이블 행 형태 */
interface AccountMetaRow {
  user_id: string;
  ad_account_no: number;
  meta: Omit<MultiAccountUserMeta, "adAccountNo">;
  added: boolean;
  added_order: number;
}

/** account_groups 테이블 행 형태 */
interface AccountGroupRow {
  id: string;
  user_id: string;
  name: string;
  ord: number;
  account_nos: number[];
}

/** MultiAccountUserMeta → account_meta 행 (meta jsonb는 adAccountNo 제외 필드만) */
export function metaToRow(
  userId: string,
  m: MultiAccountUserMeta,
  added: boolean,
  addedOrder: number,
): AccountMetaRow {
  const { adAccountNo, ...rest } = m;
  return {
    user_id: userId,
    ad_account_no: adAccountNo,
    meta: rest,
    added,
    added_order: addedOrder,
  };
}

/** account_meta 행 → MultiAccountUserMeta (ad_account_no를 adAccountNo로 되붙임) */
export function rowToMeta(row: AccountMetaRow): MultiAccountUserMeta {
  // bigint 컬럼은 문자열로 올 수 있어 숫자로 강제
  return { ...row.meta, adAccountNo: Number(row.ad_account_no) };
}

/** MultiAccountGroup → account_groups 행 */
export function groupToRow(userId: string, g: MultiAccountGroup): AccountGroupRow {
  return {
    id: g.id,
    user_id: userId,
    name: g.name,
    ord: g.order,
    account_nos: g.accountNos,
  };
}

/** account_groups 행 → MultiAccountGroup */
export function rowToGroup(row: AccountGroupRow): MultiAccountGroup {
  // bigint 컬럼은 문자열로 올 수 있어 숫자로 강제
  return {
    id: row.id,
    name: row.name,
    order: row.ord,
    accountNos: row.account_nos.map(Number),
  };
}

async function currentUserId(): Promise<string> {
  const supabase = getSupabase();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const userId = session?.user?.id;
  if (!userId) throw new Error("로그인 세션이 없습니다");
  return userId;
}

/** account_meta + account_groups 전체 조회 (RLS가 본인 행만 반환) */
export async function pullAll(): Promise<{
  metaMap: UserMetaMap;
  groups: MultiAccountGroup[];
  addedList: number[];
}> {
  const supabase = getSupabase();

  const [metaRes, groupRes] = await Promise.all([
    supabase.from("account_meta").select("*"),
    supabase.from("account_groups").select("*").order("ord", { ascending: true }),
  ]);
  if (metaRes.error) throw metaRes.error;
  if (groupRes.error) throw groupRes.error;

  const metaRows = (metaRes.data ?? []) as AccountMetaRow[];
  const groupRows = (groupRes.data ?? []) as AccountGroupRow[];

  const metaMap: UserMetaMap = {};
  for (const row of metaRows) {
    // bigint 컬럼은 문자열로 올 수 있어 숫자로 강제
    metaMap[Number(row.ad_account_no)] = rowToMeta(row);
  }

  const groups = groupRows.map(rowToGroup);

  const addedList = metaRows
    .filter((row) => row.added)
    .sort((a, b) => a.added_order - b.added_order)
    .map((row) => Number(row.ad_account_no));

  return { metaMap, groups, addedList };
}

/** account_meta 한 행 upsert */
export async function pushMeta(
  m: MultiAccountUserMeta,
  added: boolean,
  order: number,
): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  const row = metaToRow(userId, m, added, order);
  const { error } = await supabase
    .from("account_meta")
    .upsert(row, { onConflict: "user_id,ad_account_no" });
  if (error) throw error;
}

/**
 * account_meta 여러 행을 배열 upsert 1회로 반영 — 이관(migrate-local) 등 대량 쓰기에서
 * 행별 왕복 대신 단일 요청으로 partial 실패 창을 줄인다.
 */
export async function pushMetaMany(
  entries: { meta: MultiAccountUserMeta; added: boolean; order: number }[],
): Promise<void> {
  if (entries.length === 0) return;
  const supabase = getSupabase();
  const userId = await currentUserId();
  const rows = entries.map((e) => metaToRow(userId, e.meta, e.added, e.order));
  const { error } = await supabase
    .from("account_meta")
    .upsert(rows, { onConflict: "user_id,ad_account_no" });
  if (error) throw error;
}

/** account_meta 한 행 삭제 */
export async function deleteMeta(adAccountNo: number): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from("account_meta")
    .delete()
    .eq("ad_account_no", adAccountNo);
  if (error) throw error;
}

/**
 * account_groups 전체 교체(replace-all) 전략 — 로컬 saveGroups(list 전체 저장)와 동일 시맨틱.
 * 넘겨받은 목록에 없는 본인 행은 삭제하고, 목록에 있는 행은 upsert한다.
 */
export async function pushGroups(groups: MultiAccountGroup[]): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  const ids = groups.map((g) => g.id);

  const deleteQuery = supabase.from("account_groups").delete();
  const { error: deleteError } =
    ids.length > 0 ? await deleteQuery.not("id", "in", `(${ids.join(",")})`) : await deleteQuery;
  if (deleteError) throw deleteError;

  if (groups.length === 0) return;

  const rows = groups.map((g) => groupToRow(userId, g));
  const { error: upsertError } = await supabase.from("account_groups").upsert(rows, { onConflict: "id" });
  if (upsertError) throw upsertError;
}

// ─── 계정 이슈 이력 (change_watch_state) ───
// 수집 결과라 설정값(account_meta)과 달리 사용자가 직접 입력하지 않는다. 서버가 원본이되
// 쓰기 실패가 점검 자체를 막지 않도록 호출부는 best-effort로 밀어넣는다.

/** change_watch_state 테이블 행 형태 (숫자 시각은 bigint → 문자열로 올 수 있음) */
interface ChangeWatchRow {
  user_id: string;
  ad_account_no: number | string;
  events: ChangeWatchState["events"];
  scanned_until: number | string;
  read_budget_up_to: number | string;
  read_external_up_to: number | string;
  read_ids?: string[] | null;
  fetched_at: string;
}

function rowToChangeWatch(row: ChangeWatchRow): ChangeWatchState {
  return {
    adAccountNo: Number(row.ad_account_no),
    events: Array.isArray(row.events) ? row.events : [],
    scanned_until: Number(row.scanned_until),
    read_budget_up_to: Number(row.read_budget_up_to),
    read_external_up_to: Number(row.read_external_up_to),
    read_ids: Array.isArray(row.read_ids) ? row.read_ids : [],
    fetched_at: row.fetched_at,
  };
}

/** 본인의 전 계정 이슈 이력 조회 (RLS가 본인 행만 반환) */
export async function pullChangeWatchStates(): Promise<ChangeWatchState[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("change_watch_state").select("*");
  if (error) throw error;
  return ((data ?? []) as ChangeWatchRow[]).map(rowToChangeWatch);
}

/** 한 계정의 이슈 이력 upsert */
export async function pushChangeWatchState(state: ChangeWatchState): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  const { error } = await supabase.from("change_watch_state").upsert(
    {
      user_id: userId,
      ad_account_no: state.adAccountNo,
      events: state.events,
      scanned_until: state.scanned_until,
      read_budget_up_to: state.read_budget_up_to,
      read_external_up_to: state.read_external_up_to,
      read_ids: state.read_ids ?? [],
      fetched_at: state.fetched_at,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,ad_account_no" },
  );
  if (error) throw error;
}

// ─── 사용자 설정 (user_settings) ───
// 계정 단위가 아닌 사용자 단위 설정 묶음. 행은 사용자당 하나.

export interface UserSettings {
  /** 변경이력 알림에서 제외할 변경자 표시명 */
  changeWatchActors: string[];
  /** 대행권 점검 기준이 되는 관리 계정 번호 */
  agencyManagerNos: number[];
  /** 검색광고 / 디스플레이광고 표시 토글 */
  platformSa: boolean;
  platformDa: boolean;
  /** 리포트 담당자명 (마지막 입력값) */
  reportAuthor: string;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  changeWatchActors: [],
  agencyManagerNos: [],
  platformSa: true,
  platformDa: true,
  reportAuthor: "",
};

/** 사용자 설정 조회. 행이 없으면(첫 사용) null — 호출부가 기본값/로컬값을 유지한다. */
export async function pullUserSettings(): Promise<UserSettings | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from("user_settings").select("*").maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as {
    change_watch_actors?: string[];
    agency_manager_nos?: (number | string)[];
    platform_sa?: boolean;
    platform_da?: boolean;
    report_author?: string;
  };
  return {
    changeWatchActors: row.change_watch_actors ?? [],
    agencyManagerNos: (row.agency_manager_nos ?? []).map(Number),
    platformSa: row.platform_sa !== false,
    platformDa: row.platform_da !== false,
    reportAuthor: row.report_author ?? "",
  };
}

/** 사용자 설정 부분 갱신 — 넘긴 항목만 덮어쓴다(다른 설정을 기본값으로 밀지 않게). */
export async function pushUserSettings(patch: Partial<UserSettings>): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  const row: Record<string, unknown> = { user_id: userId, updated_at: new Date().toISOString() };
  if (patch.changeWatchActors !== undefined) row.change_watch_actors = patch.changeWatchActors;
  if (patch.agencyManagerNos !== undefined) row.agency_manager_nos = patch.agencyManagerNos;
  if (patch.platformSa !== undefined) row.platform_sa = patch.platformSa;
  if (patch.platformDa !== undefined) row.platform_da = patch.platformDa;
  if (patch.reportAuthor !== undefined) row.report_author = patch.reportAuthor;
  const { error } = await supabase.from("user_settings").upsert(row, { onConflict: "user_id" });
  if (error) throw error;
}

/** 계정 삭제 시 그 계정의 이슈 이력도 함께 정리 */
export async function deleteChangeWatchStates(adAccountNos: number[]): Promise<void> {
  if (adAccountNos.length === 0) return;
  const supabase = getSupabase();
  const { error } = await supabase
    .from("change_watch_state")
    .delete()
    .in("ad_account_no", adAccountNos);
  if (error) throw error;
}
