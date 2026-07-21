/**
 * F-ChangeWatch — 변경이력 조회 + 알림 판별 (콘텐츠 스크립트 전용).
 *
 * 두 가지를 잡는다:
 *   1. 예산 초과 중단 — `ncc.charge.*_LOCK` (시스템이 올리는 이벤트)
 *   2. 외부 수정      — `ncc.heroes.*`인데 변경자가 제외 목록(`change_watch_identity`)에 없는 경우.
 *                       SYSTEM과 GW+숫자(네이버 내부 사번형)는 시스템 변경이라 무조건 제외(2026-07-21).
 *
 * endpoint/schema 정찰 결과는 메모리 `project_f_changewatch_endpoints` 참조.
 */

import type { ChangeWatchEvent } from "@/types/storage";
import { authFetch } from "@/features/multi-account/multi-account-data";

// 앱이 박아 쓰는 고정 상수 — 계정과 무관 (정찰에서 3개 계정 동일 확인).
const SERVICE_ID = "james-rhodes";
// 앱이 쓰는 값과 동일. 한 번에 이만큼 넘으면 잘리므로 초과 시 경고만 남긴다.
const MAX_ROWS = 5000;

export interface RawHistoryObject {
  id?: string;
  displayName?: string;
  data?: {
    heroes?: {
      nccCampaignId?: string;
      nccAdgroupId?: string;
      nccCampaignName?: string;
      nccAdgroupName?: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      detailEventType?: string;
    };
    // 예산 잠금 이벤트는 data 키가 `locker-sa` — 잠글 때 적용된 예산값이 들어있다.
    [k: string]: unknown;
  };
}

export interface RawHistoryRow {
  eventId?: string;
  eventType?: string;
  eventTime?: string;
  actorDisplayName?: string;
  objects?: RawHistoryObject[];
  "@timestamp"?: string;
}

interface HistorySearchResponse {
  success?: boolean;
  errorMessage?: string | null;
  totalHits?: { value?: number };
  data?: RawHistoryRow[];
}

// 예산 소진으로 노출이 멈춘 이벤트. UNLOCK(재개)은 알림 대상이 아니라 제외.
// `ncc.charge.ACCOUNT_LOCK`은 계정 비즈머니 소진이라 여기서 뺐다 — 대상이 캠페인/그룹이
// 아니라 계정 자체(data 없이 계정명만)이고, 그 알림은 이미 비즈머니 임계값이 담당한다.
const LOCK_LABEL: Record<string, string> = {
  "ncc.charge.CAMPAIGN_LOCK": "캠페인",
  "ncc.charge.ADGROUP_LOCK": "광고그룹",
};

// 변경자를 특정할 수 없는 행(빈 문자열)과 네이버 쪽 시스템 변경자는 뺀다.
// 빈 문자열은 예산 잠금 계열이라 위에서 budget으로 따로 처리되고,
// SYSTEM·GW+숫자(네이버 내부 사번형, 전 계정에 공통 등장)는 사람이 아니라
// 네이버 내부 처리라 알림 대상도 칩 후보도 아니다.
function isAttributed(actor: string): boolean {
  return actor !== "" && actor.toUpperCase() !== "SYSTEM" && !/^GW\d+$/i.test(actor);
}

// eventType → 사람이 읽는 동작 이름. 없는 건 "설정"으로 폴백 (영문 코드 노출 금지).
export const EVENT_LABEL: Record<string, string> = {
  "ncc.heroes.CAMPAIGN.MODIFY": "캠페인",
  "ncc.heroes.ADGROUP.MODIFY": "광고그룹",
  "ncc.heroes.ADGROUP.MODIFY_USER_LOCK": "광고그룹",
  "ncc.heroes.AD.MODIFY": "소재",
  "ncc.heroes.AD.MODIFY_ENABLE": "소재",
  "ncc.heroes.CRITERION.MODIFY": "키워드",
  "ncc.heroes.CRITERION.MODIFY_BID_WEIGHT": "입찰 가중치",
  "ncc.heroes.TARGET.MODIFY": "타겟",
};

/**
 * before/after 필드 → 한글 라벨. **값까지 그대로 보여줘도 되는 필드만** 넣는다.
 * 모르는 필드는 개수만 세므로(diffSummary) 영문 키도, JSON 덩어리 값도 새지 않는다.
 * 그래서 `budgetType`(값이 DAILY_BUDGET 같은 영문)이나 `adAttr`/`criterionJson`/`target`
 * (값이 JSON 문자열)은 일부러 제외했다.
 */
const FIELD_LABEL: Record<string, string> = {
  dailyBudget: "일예산",
  bidAmt: "입찰가",
  useDailyBudget: "일예산 사용",
  userLock: "상태",
  enable: "상태",
  name: "이름",
  mobileBidWeight: "모바일 입찰 가중치",
  pcBidWeight: "PC 입찰 가중치",
};

// 응답 값은 전부 문자열로 온다 ("true"/"false", "300"). 숫자/불리언 타입으로 올 가능성도
// 열어두고 둘 다 받는다.
function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

function formatValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "없음";
  // userLock은 "잠금"이라 true가 꺼짐 — enable과 의미가 반대다.
  if (field === "userLock") return toBool(v) ? "꺼짐" : "켜짐";
  if (field === "enable") return toBool(v) ? "켜짐" : "꺼짐";
  if (field === "useDailyBudget") return toBool(v) ? "사용" : "미사용";
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n) && /budget|bid|amt|weight/i.test(field)) {
    return n.toLocaleString("ko-KR") + (/weight/i.test(field) ? "%" : "원");
  }
  return String(v);
}

/**
 * before/after를 "일예산 10,000원 -> 15,000원" 같은 한 줄로. 아는 필드가 하나도 없으면
 * 개수만 알린다 — 영문 필드명을 그대로 보여주느니 "설정 2개 변경"이 낫다.
 */
export function diffSummary(before?: Record<string, unknown>, after?: Record<string, unknown>): string {
  const b = before ?? {};
  const a = after ?? {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const changed = keys.filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));
  if (changed.length === 0) return "";
  const known = changed.filter((k) => FIELD_LABEL[k]);
  if (known.length === 0) return `설정 ${changed.length}개 변경`;
  const parts = known
    .slice(0, 2)
    .map((k) => `${FIELD_LABEL[k]} ${formatValue(k, b[k])} -> ${formatValue(k, a[k])}`);
  const rest = changed.length - known.slice(0, 2).length;
  return parts.join(", ") + (rest > 0 ? ` 외 ${rest}건` : "");
}

/** 잠금 이벤트의 data 키(`locker-sa`)에서 적용 예산을 꺼낸다. 키 이름이 바뀔 수 있어 폴백 포함. */
function lockedBudget(obj: RawHistoryObject): number | null {
  const data = obj.data;
  if (!data) return null;
  const block =
    (data["locker-sa"] as { dailyBudget?: unknown } | undefined) ??
    (Object.values(data).find(
      (v) => v && typeof v === "object" && "dailyBudget" in (v as object),
    ) as { dailyBudget?: unknown } | undefined);
  const n = Number(block?.dailyBudget);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 대상의 캠페인/광고그룹 id 추출 — 알림 클릭 시 해당 페이지 이동용.
 * obj.id 자체가 대상 id(`cmp-`/`grp-` prefix)이고, 소재/키워드 수정은 heroes에 실린
 * 상위 id로 폴백한다. 못 얻으면 undefined — 이동 없이 표시만.
 */
function entityIds(obj: RawHistoryObject): { campaignId?: string; adgroupId?: string } {
  const heroes = obj.data?.heroes;
  const id = obj.id ?? "";
  return {
    campaignId: id.startsWith("cmp-") ? id : heroes?.nccCampaignId,
    adgroupId: id.startsWith("grp-") ? id : heroes?.nccAdgroupId,
  };
}

export function rowTime(row: RawHistoryRow): number {
  const iso = row["@timestamp"];
  if (iso) {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }
  // 폴백: eventTime "20260713002247646" (KST 기준 yyyyMMddHHmmssSSS)
  const s = row.eventTime;
  if (s && s.length >= 14) {
    const t = Date.parse(
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+09:00`,
    );
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * 변경이력 원본 조회. `x-ad-customer-id` 헤더가 필수 — 없으면 서버가
 * "ownerId format is invalid" 로 거부한다. 이 헤더 덕에 활성 계정과 무관하게 cross-account.
 * body는 Elasticsearch DSL이고 빈 must 배열 = 필터 없음(전체).
 */
export async function fetchChangeHistory(
  customerId: number,
  sinceMs: number,
  untilMs: number,
): Promise<RawHistoryRow[]> {
  const url =
    `/apis/sa/api/histories/_search?serviceId=${SERVICE_ID}` +
    `&since=${sinceMs}&until=${untilMs}&maxRowsPerPage=${MAX_ROWS}`;
  const json = await authFetch<HistorySearchResponse>(
    url,
    { method: "POST", body: JSON.stringify({ bool: { must: [] } }) },
    customerId,
  );
  if (json.success === false) {
    throw new Error(json.errorMessage || "변경이력을 불러오지 못했어요");
  }
  const rows = json.data ?? [];
  if (rows.length >= MAX_ROWS) {
    console.warn(
      `[dv-ads/change-watch] 변경이력이 ${MAX_ROWS}건을 넘어 일부가 빠졌을 수 있어요`,
      customerId,
    );
  }
  return rows;
}

/**
 * 원본 행 → 알림 목록. `ourActors`가 비어있으면 외부 수정은 판별이 불가능하므로
 * (우리 것도 남의 것으로 보임) 예산 알림만 만든다.
 */
export function classifyHistory(rows: RawHistoryRow[], ourActors: string[]): ChangeWatchEvent[] {
  const ours = new Set(ourActors.map((a) => a.trim().toLowerCase()));
  const canDetectExternal = ours.size > 0;
  const out: ChangeWatchEvent[] = [];

  for (const row of rows) {
    const eventType = row.eventType ?? "";
    const ts = rowTime(row);
    if (!ts) continue;
    const objects = row.objects ?? [];

    const lockScope = LOCK_LABEL[eventType];
    if (lockScope) {
      objects.forEach((obj, i) => {
        const budget = lockedBudget(obj);
        out.push({
          id: `${row.eventId ?? ts}:${i}`,
          ts,
          kind: "budget",
          actor: "",
          target: obj.displayName ?? "",
          summary: budget
            ? `${lockScope} 일 예산 ${budget.toLocaleString("ko-KR")}원 도달`
            : `${lockScope} 일 예산 도달`,
          ...entityIds(obj),
        });
      });
      continue;
    }

    if (!canDetectExternal || !eventType.startsWith("ncc.heroes.")) continue;
    const actor = (row.actorDisplayName ?? "").trim();
    if (!isAttributed(actor)) continue;
    if (ours.has(actor.toLowerCase())) continue;

    const what = EVENT_LABEL[eventType] ?? "설정";
    objects.forEach((obj, i) => {
      const heroes = obj.data?.heroes;
      const target = obj.displayName || heroes?.nccAdgroupName || heroes?.nccCampaignName || "";
      const diff = diffSummary(heroes?.before, heroes?.after);
      out.push({
        id: `${row.eventId ?? ts}:${i}`,
        ts,
        kind: "external",
        actor,
        target,
        summary: diff ? `${what} - ${diff}` : `${what} 변경`,
        ...entityIds(obj),
      });
    });
  }

  // 최신순. 같은 시각이면 안정적 순서 유지를 위해 id로 tie-break.
  out.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1));
  return out;
}

/** 이 계정에서 관측된 변경자 목록 — 설정 화면이 "제외할 변경자" 고르기 칩으로 쓴다. 시스템 변경자(SYSTEM·GW+숫자) 제외. */
export function observedActors(rows: RawHistoryRow[]): string[] {
  const set = new Set<string>();
  for (const row of rows) {
    const a = (row.actorDisplayName ?? "").trim();
    if (isAttributed(a)) set.add(a);
  }
  return [...set].sort();
}
