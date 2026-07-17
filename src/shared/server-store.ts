// F-Accounts — Supabase 서버 스토어 (account_meta / account_groups CRUD).
// 서버 먼저 반영하고, 성공 시 로컬 캐시(chrome.storage.local) 갱신은 호출부(Task 9) 책임.
import { getSupabase } from "@/shared/supabase";
import type { MultiAccountUserMeta, MultiAccountGroup } from "@/types/storage";

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
  return { ...row.meta, adAccountNo: row.ad_account_no };
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
  return {
    id: row.id,
    name: row.name,
    order: row.ord,
    accountNos: row.account_nos,
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
    metaMap[row.ad_account_no] = rowToMeta(row);
  }

  const groups = groupRows.map(rowToGroup);

  const addedList = metaRows
    .filter((row) => row.added)
    .sort((a, b) => a.added_order - b.added_order)
    .map((row) => row.ad_account_no);

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
