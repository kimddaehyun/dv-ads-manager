/**
 * 관리이력 보고 — 지정 기간의 변경이력을 "우리(대행사) 작업"만 골라
 * 카톡으로 보낼 수 있는 한글 텍스트로 요약한다 (콘텐츠 스크립트 전용).
 *
 * 수집·파싱은 change-watch.ts의 fetchChangeHistory/diffSummary를 재사용하고,
 * 여기는 종류별 분류와 텍스트 조립만 담당한다. 모르는 eventType은 "기타 설정"으로
 * 접어서 영문 코드가 새지 않게 한다.
 */

import {
  fetchChangeHistoryAll,
  diffSummary,
  rowTime,
  type RawHistoryRow,
  type RawHistoryObject,
} from "./change-watch";
import { authFetch } from "@/features/multi-account/multi-account-data";

export interface HistoryReportItem {
  ts: number;
  /** "캠페인A > 그룹1: 대상명" 형태의 위치 표시 (없는 조각은 생략) */
  where: string;
  /** diffSummary 결과 또는 동작 설명. 빈 문자열 가능. */
  detail: string;
  /**
   * 이벤트에 대상 이름이 안 실려서(키워드/소재 수정은 nkw-/nad- id만 옴) 별도 조회로
   * 이름을 채워야 하는 경우의 대상 id. collectHistoryReport의 enrich 단계에서 소비.
   */
  refId?: string;
  /** 대상 캠페인 id — 캠페인 유형(파워링크/쇼핑검색 등) 구분용. */
  campaignId?: string;
  /** 캠페인 유형 한글 라벨. collectHistoryReport가 ncc/campaigns 조회로 채운다. */
  campaignType?: string;
}

export interface HistoryReportGroup {
  key: GroupKey;
  label: string;
  items: HistoryReportItem[];
}

export interface HistoryReport {
  groups: HistoryReportGroup[];
  /** 전체 건수 (그룹 합계) */
  total: number;
  /** 기간을 최소 폭까지 쪼개도 5,000행 한도에 걸려 일부가 잘린 극단적 경우 */
  truncated: boolean;
}

export type GroupKey =
  | "bid"
  | "budget"
  | "status"
  | "keyword"
  | "ad"
  | "targeting"
  | "structure"
  | "etc";

export const GROUP_LABEL: Record<GroupKey, string> = {
  bid: "입찰가 조정",
  budget: "예산 조정",
  status: "켜기/끄기",
  keyword: "키워드 관리",
  ad: "소재 관리",
  targeting: "타겟팅 관리",
  structure: "캠페인/그룹 관리",
  etc: "기타 설정",
};

// 그룹 정렬 순서 — 보고에서 중요한(자주 하는) 관리부터.
export const GROUP_ORDER: GroupKey[] = [
  "bid",
  "budget",
  "status",
  "keyword",
  "ad",
  "targeting",
  "structure",
  "etc",
];

// eventType의 대상(엔티티) 조각 → 그룹/한글 이름. CRITERION은 키워드가 아니라
// 요일·시간/지역 타겟팅이다(2026-07-21 정찰) — 키워드는 KEYWORD.*로 따로 온다.
const ENTITY_INFO: Record<string, { group: GroupKey; label: string }> = {
  CAMPAIGN: { group: "structure", label: "캠페인" },
  ADGROUP: { group: "structure", label: "광고그룹" },
  KEYWORD: { group: "keyword", label: "키워드" },
  AD: { group: "ad", label: "소재" },
  AD_EXTENSION: { group: "ad", label: "확장소재" },
  CRITERION: { group: "targeting", label: "타겟팅" },
  TARGET: { group: "targeting", label: "타겟팅" },
};

// 등록/삭제/복사 동사 — 이런 이벤트는 before/after 필드 diff가 무의미하다
// (신규 등록이면 모든 필드가 "없음 -> 값"으로 잡혀 입찰가 변경처럼 보인다).
const VERB_LABEL: Record<string, string> = {
  ADD: "등록",
  REMOVE: "삭제",
  COPY: "복사",
};

/** before/after에서 실제로 값이 달라진 키 목록. */
function changedKeys(before?: Record<string, unknown>, after?: Record<string, unknown>): string[] {
  const b = before ?? {};
  const a = after ?? {};
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(
    (k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]),
  );
}

/** JSON 문자열 필드(adAttr 등)를 객체로. 아니면 null. */
function parseJsonField(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string" || !v.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// criterionJson의 타겟팅 종류 코드 → 한글 (2026-07-21 정찰: SD=요일/시간, RL=지역, 2026-07-22: AG=연령).
const CRITERION_KIND: Record<string, string> = {
  SD: "요일/시간",
  RL: "지역",
  AG: "연령",
};

// 켜는 순간 전 구간이 통째로 기록되는 종류(연령) — 나열 대신 "사용/해제"로 접는다.
// (2026-07-22 라이브: 연령 타겟팅 켜기 = 연령 11구간 일괄 추가 + "14세 미만"만 제외)
const CRITERION_FULL_SET_KIND = new Set(["AG"]);

/**
 * 제외키워드 목록(target JSON, `[{keyword,type,date},...]`)의 전후 차이.
 * 이력에는 매번 전체 목록이 실리므로(2026-07-21 정찰) 차집합으로 이번에
 * 추가/삭제된 키워드만 골라낸다.
 */
function restrictKeywordDiff(before: unknown, after: unknown): string {
  const words = (v: unknown): Set<string> => {
    if (typeof v !== "string") return new Set();
    try {
      const arr = JSON.parse(v);
      if (!Array.isArray(arr)) return new Set();
      return new Set(arr.map((x) => String((x as { keyword?: unknown })?.keyword ?? "")).filter(Boolean));
    } catch {
      return new Set();
    }
  };
  const b = words(before);
  const a = words(after);
  const added = [...a].filter((k) => !b.has(k));
  const removed = [...b].filter((k) => !a.has(k));
  const parts: string[] = [];
  if (added.length > 0) parts.push(`제외키워드 추가: ${added.join(", ")}`);
  if (removed.length > 0) parts.push(`제외키워드 삭제: ${removed.join(", ")}`);
  return parts.join(" / ") || "제외키워드 변경";
}

interface CriterionEntry {
  dictionaryCode?: string;
  codeName?: string;
  negative?: boolean;
  bidWeight?: number;
}

/**
 * "월요일 07시부터 23시까지" 7개처럼 요일만 다른 항목은 "매일 07시부터 23시까지"로,
 * 일부 요일이면 "월·화·수요일 07시부터 23시까지"로 줄인다. 그 외는 이름 나열(5개 초과는 외 N).
 */
function describeEntries(entries: CriterionEntry[]): string {
  const names = entries.map((e) => (e.codeName ?? "").trim()).filter(Boolean);
  if (names.length === 0) return "";
  const day = names.map((n) => n.match(/^([월화수목금토일])요일 (.+)$/));
  if (day.every(Boolean) && new Set(day.map((m) => m![2])).size === 1) {
    const rest = day[0]![2];
    if (names.length === 7) return `매일 ${rest}`;
    return `${day.map((m) => m![1]).join("·")}요일 ${rest}`;
  }
  const head = names.slice(0, 5).join(", ");
  return names.length > 5 ? `${head} 외 ${names.length - 5}` : head;
}

/** criterionJson 변경 → "요일/시간 설정: 매일 07시부터 23시까지" 같은 한 줄. */
function criterionDetail(before: unknown, after: unknown): string {
  const parse = (v: unknown): Record<string, CriterionEntry[]> => {
    const obj = parseJsonField(v) ?? {};
    const out: Record<string, CriterionEntry[]> = {};
    for (const [k, list] of Object.entries(obj)) {
      if (Array.isArray(list)) out[k] = list as CriterionEntry[];
    }
    return out;
  };
  const b = parse(before);
  const a = parse(after);
  const parts: string[] = [];
  for (const kind of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const kindLabel = CRITERION_KIND[kind] ?? "타겟팅";
    const bMap = new Map((b[kind] ?? []).map((e) => [e.dictionaryCode ?? e.codeName ?? "", e]));
    const aMap = new Map((a[kind] ?? []).map((e) => [e.dictionaryCode ?? e.codeName ?? "", e]));
    const added = [...aMap].filter(([k]) => !bMap.has(k)).map(([, e]) => e);
    const removed = [...bMap].filter(([k]) => !aMap.has(k)).map(([, e]) => e);

    // 연령처럼 켜는 순간 전 구간이 통째로 기록되는 종류는 나열이 소음이다 —
    // 없던 상태에서 일괄 등장 = "사용"(제외 구간만 덧붙임), 통째로 사라짐 = "해제".
    if (CRITERION_FULL_SET_KIND.has(kind)) {
      if (bMap.size === 0 && aMap.size > 0) {
        const neg = describeEntries(added.filter((e) => e.negative));
        parts.push(`${kindLabel} 타겟팅 사용${neg ? ` (${neg} 제외)` : ""}`);
        continue;
      }
      if (aMap.size === 0 && bMap.size > 0) {
        parts.push(`${kindLabel} 타겟팅 해제`);
        continue;
      }
    }

    // 양쪽에 다 있는데 내용이 바뀐 항목 — 제외 전환과 가중치 조정만 의미가 있다.
    for (const [key, aEntry] of aMap) {
      const bEntry = bMap.get(key);
      if (!bEntry) continue;
      const name = (aEntry.codeName ?? "").trim();
      if (!name) continue;
      if (!bEntry.negative !== !aEntry.negative) {
        parts.push(aEntry.negative ? `${kindLabel} 제외: ${name}` : `${kindLabel} 제외 해제: ${name}`);
      } else if (
        bEntry.bidWeight !== undefined &&
        aEntry.bidWeight !== undefined &&
        bEntry.bidWeight !== aEntry.bidWeight
      ) {
        parts.push(`${kindLabel} 가중치 조정: ${name} ${bEntry.bidWeight}% -> ${aEntry.bidWeight}%`);
      }
    }

    // negative=true는 "그 대상을 제외"하는 설정이라 문구를 구분한다.
    for (const [list, word] of [
      [added.filter((e) => !e.negative), "설정"],
      [added.filter((e) => e.negative), "제외 설정"],
      [removed.filter((e) => !e.negative), "해제"],
      [removed.filter((e) => e.negative), "제외 해제"],
    ] as Array<[CriterionEntry[], string]>) {
      const desc = describeEntries(list);
      if (desc) parts.push(`${kindLabel} ${word}: ${desc}`);
    }
  }
  return parts.join(" / ") || "타겟팅 변경";
}

/** MEDIA_TARGET(노출 매체) — 매체가 숫자 id뿐이라 제외 매체 개수 변화로만 요약. */
function mediaTargetDetail(before: unknown, after: unknown): string {
  const count = (v: unknown): number => {
    const obj = parseJsonField(v);
    const black = (obj?.black as { media?: unknown[] } | undefined)?.media;
    return Array.isArray(black) ? black.length : 0;
  };
  const b = count(before);
  const a = count(after);
  if (b !== a) return `노출 매체 변경 (제외 매체 ${b}곳 -> ${a}곳)`;
  return "노출 매체 변경";
}

/**
 * 이벤트 하나 → 그룹 + 상세 문구.
 *
 * 순서가 중요하다:
 * 1) 등록/삭제/복사 동사는 diff 없이 동작만 말한다.
 * 2) adAttr(JSON 문자열, 쇼핑검색 소재 속성)이 바뀌면 열어서 안쪽 값으로 다시 판단 —
 *    "설정 1개 변경"이 아니라 "입찰가 2,360원 -> 2,510원"이 나온다.
 * 3) criterionJson이 바뀌면 타겟팅 변경.
 * 4) 나머지 MODIFY는 바뀐 필드 우선(입찰가 > 예산 > 켜기/끄기), 없으면 엔티티 기준.
 */
function classifyEvent(
  eventType: string,
  before?: Record<string, unknown>,
  after?: Record<string, unknown>,
): { group: GroupKey; detail: string } {
  const m = eventType.match(/^ncc\.heroes\.(\w+)\.(\w+)$/);
  const entity = ENTITY_INFO[m?.[1] ?? ""];
  const verb = VERB_LABEL[m?.[2] ?? ""];

  // 키워드확장 제외키워드는 ADGROUP 이벤트로 오지만(2026-07-21 정찰) 내용은 키워드 관리다.
  // 제외키워드 텍스트는 displayName에 실려 where에 이미 나온다.
  if (m?.[2] === "ADD_KEYWORD_PLUS") return { group: "keyword", detail: "제외키워드 추가" };
  if (m?.[2] === "REMOVE_KEYWORD_PLUS") return { group: "keyword", detail: "제외키워드 삭제" };

  if (verb) {
    return {
      group: entity?.group ?? "etc",
      detail: entity ? `${entity.label} ${verb}` : verb,
    };
  }

  let b = before ?? {};
  let a = after ?? {};
  // 검수 상태는 네이버가 붙여오는 부수 변화라 관리 내역으로 안 센다 (diff 건수에서도 제외).
  if ("inspectStatus" in b || "inspectStatus" in a) {
    b = { ...b };
    a = { ...a };
    delete b.inspectStatus;
    delete a.inspectStatus;
  }
  let changed = changedKeys(b, a);

  // 제외키워드(노출 제외 검색어) — target JSON에 전체 목록이 실리므로 차집합으로 요약.
  if (changed.includes("target")) {
    const tp = String(a.targetTp ?? b.targetTp);
    if (tp === "RESTRICT_KEYWORD_TARGET") {
      return { group: "keyword", detail: restrictKeywordDiff(b.target, a.target) };
    }
    if (tp === "MEDIA_TARGET") {
      return { group: "targeting", detail: mediaTargetDetail(b.target, a.target) };
    }
    return { group: "targeting", detail: "타겟 설정 변경" };
  }
  if (changed.includes("adAttr")) {
    const bInner = parseJsonField(b.adAttr);
    const aInner = parseJsonField(a.adAttr);
    if (bInner || aInner) {
      b = bInner ?? {};
      a = aInner ?? {};
      changed = changedKeys(b, a);
    }
  }
  if (changed.includes("criterionJson")) {
    return { group: "targeting", detail: criterionDetail(b.criterionJson, a.criterionJson) };
  }

  const has = (k: string) => changed.includes(k);
  const detail = diffSummary(b, a);
  if (has("bidAmt") || has("mobileBidWeight") || has("pcBidWeight")) {
    return { group: "bid", detail };
  }
  if (has("dailyBudget") || has("useDailyBudget")) return { group: "budget", detail };
  if (has("userLock") || has("enable")) return { group: "status", detail };
  // 그룹 입찰가 사용 여부 전환 (키워드 개별 입찰 <-> 그룹 입찰) — 입찰 관련 관리다.
  if (has("useGroupBidAmt")) {
    const on = String(a.useGroupBidAmt) === "true";
    return { group: "bid", detail: on ? "그룹 입찰가 사용으로 전환" : "개별 입찰가로 전환" };
  }
  // AI 광고 최적화(네이버 자동 최적화) 켜기/끄기.
  if (has("aiAdsOptIn")) {
    const on = String(a.aiAdsOptIn) === "true";
    return { group: "etc", detail: on ? "AI 광고 최적화 켬" : "AI 광고 최적화 끔" };
  }
  // ad 필드(JSON, 소재 문안·상품 정보)는 값이 커서 diff 대신 한마디로.
  if (has("ad")) return { group: "ad", detail: "소재 내용 변경" };
  if (changed.length === 0) return { group: entity?.group ?? "etc", detail: "" };
  return { group: entity?.group ?? "etc", detail };
}

/**
 * displayName이 이름이 아니라 내부 id로 오는 행이 있다(예: 키워드 수정인데 `grp-a001-...`).
 * 그대로 보여주면 보고서에 코드가 새므로 이름 취급하지 않는다.
 */
function isIdLike(name: string): boolean {
  return /^(cmp|grp|kwd|nkw|nad|ext|mas|bsn|tgt|tct)-[a-z0-9-]+$/i.test(name);
}

/** 대상 위치 문자열 — "캠페인 > 그룹: 대상명". 자기 자신이 캠페인/그룹이면 이름만. */
function whereOf(obj: RawHistoryObject): { text: string; named: boolean } {
  const heroes = obj.data?.heroes;
  const raw = (obj.displayName ?? "").trim();
  const name = isIdLike(raw) ? "" : raw;
  const path = [heroes?.nccCampaignName, heroes?.nccAdgroupName]
    .map((s) => (s ?? "").trim())
    .filter((s) => s && s !== name);
  const text = path.length === 0 ? name : name ? `${path.join(" > ")} > ${name}` : path.join(" > ");
  return { text, named: name !== "" };
}

/**
 * 기간 내 변경이력을 조회해 우리 변경자(`actors`)의 작업만 종류별로 묶는다.
 * actors 비교는 classifyHistory와 동일하게 소문자 trim 기준.
 */
export async function collectHistoryReport(
  customerId: number,
  sinceMs: number,
  untilMs: number,
  actors: string[],
): Promise<HistoryReport> {
  const { rows, truncated } = await fetchChangeHistoryAll(customerId, sinceMs, untilMs);
  const report = buildHistoryReport(rows, actors, truncated);
  // 서로 다른 API로 다른 필드(where/campaignType)만 채운다 — 의존성 없어 병렬.
  await Promise.all([
    enrichTargetNames(customerId, report),
    applyCampaignTypes(customerId, report),
  ]);
  return report;
}

// 캠페인 유형 코드 → 한글 (2026-07-21 ncc/campaigns 정찰: campaignTp).
const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  WEB_SITE: "파워링크",
  SHOPPING: "쇼핑검색",
  BRAND_SEARCH: "브랜드검색",
  POWER_CONTENTS: "파워콘텐츠",
  PLACE: "플레이스",
};

/** 계정의 캠페인 목록을 받아 각 항목에 캠페인 유형 라벨을 채운다. 실패 시 유형 구분 없이 진행. */
async function applyCampaignTypes(customerId: number, report: HistoryReport): Promise<void> {
  const items = report.groups.flatMap((g) => g.items).filter((i) => i.campaignId);
  if (items.length === 0) return;
  try {
    const campaigns = await authFetch<Array<{ nccCampaignId?: string; campaignTp?: string }>>(
      "/apis/sa/api/ncc/campaigns",
      undefined,
      customerId,
    );
    const typeById = new Map(
      (campaigns ?? []).map((c) => [c.nccCampaignId ?? "", CAMPAIGN_TYPE_LABEL[c.campaignTp ?? ""] ?? ""]),
    );
    for (const item of items) {
      const label = typeById.get(item.campaignId!);
      if (label) item.campaignType = label;
    }
  } catch (err) {
    console.warn("[dv-ads/history-report] 캠페인 유형 조회 실패", err);
  }
}

/** ids 배치 조회 chunk 크기 — stats와 동일하게 80개씩. */
const NAME_LOOKUP_CHUNK = 80;

/**
 * 키워드/소재 수정 이벤트에는 대상 이름이 없고 nkw-/nad- id만 온다(2026-07-21 정찰).
 * 이름을 배치 조회해 채운다 — 키워드는 `ncc/keywords?ids=`의 `keyword`,
 * 쇼핑 소재는 `ncc/ads?ids=`의 `referenceData.productTitle`(F-Report와 동일 조인).
 * 조회 실패는 이름 없이 두면 그만이라 warn 후 계속.
 */
async function enrichTargetNames(customerId: number, report: HistoryReport): Promise<void> {
  const pending = new Map<string, HistoryReportItem[]>();
  for (const g of report.groups) {
    for (const item of g.items) {
      if (!item.refId) continue;
      const list = pending.get(item.refId);
      if (list) list.push(item);
      else pending.set(item.refId, [item]);
    }
  }
  if (pending.size === 0) return;

  const ids = [...pending.keys()];
  const names = new Map<string, string>();
  const lookups: Array<{ prefix: string; url: (chunk: string[]) => string; pick: (row: Record<string, unknown>) => [string, string] }> = [
    {
      prefix: "nkw-",
      url: (chunk) => `/apis/sa/api/ncc/keywords?ids=${chunk.join(",")}`,
      pick: (row) => [String(row.nccKeywordId ?? ""), String(row.keyword ?? "")],
    },
    {
      prefix: "nad-",
      url: (chunk) => `/apis/sa/api/ncc/ads?ids=${chunk.join(",")}`,
      pick: (row) => [
        String(row.nccAdId ?? row.id ?? ""),
        String((row.referenceData as Record<string, unknown> | undefined)?.productTitle ?? ""),
      ],
    },
  ];
  for (const { prefix, url, pick } of lookups) {
    const targets = ids.filter((id) => id.startsWith(prefix));
    for (let i = 0; i < targets.length; i += NAME_LOOKUP_CHUNK) {
      const chunk = targets.slice(i, i + NAME_LOOKUP_CHUNK);
      try {
        const rows = await authFetch<Array<Record<string, unknown>>>(url(chunk), undefined, customerId);
        for (const row of rows ?? []) {
          const [id, name] = pick(row);
          if (id && name) names.set(id, name);
        }
      } catch (err) {
        console.warn("[dv-ads/history-report] 대상 이름 조회 실패", err);
      }
    }
  }

  for (const [id, items] of pending) {
    const name = names.get(id);
    if (!name) continue;
    for (const item of items) {
      item.where = item.where ? `${item.where} > ${name}` : name;
    }
  }
}

/** 조회 결과 → 보고 구조. 테스트를 위해 fetch와 분리. */
export function buildHistoryReport(
  rows: RawHistoryRow[],
  actors: string[],
  truncated = false,
): HistoryReport {
  const ours = new Set(actors.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const byGroup = new Map<GroupKey, HistoryReportItem[]>();

  for (const row of rows) {
    const eventType = row.eventType ?? "";
    // 예산 잠금 등 시스템 이벤트(ncc.charge.*)는 관리 내역이 아니다.
    if (!eventType.startsWith("ncc.heroes.")) continue;
    const actor = (row.actorDisplayName ?? "").trim().toLowerCase();
    if (!ours.has(actor)) continue;
    const ts = rowTime(row);

    for (const obj of row.objects ?? []) {
      const heroes = obj.data?.heroes;
      const { group, detail } = classifyEvent(eventType, heroes?.before, heroes?.after);
      // 바뀐 내용이 하나도 없는 이벤트(API가 같은 값을 다시 쓴 무변경, 검수 상태만 바뀐
      // 부수 변화 등)는 관리 내역이 아니다 — 건수에서도 뺀다 (2026-07-22 라이브 확인:
      // AD.MODIFY인데 adAttr before==after인 행이 주간 126건, "소재 관리"로 새던 문제).
      if (!detail) continue;
      const { text, named } = whereOf(obj);
      const id = obj.id ?? "";
      // displayName이 캠페인/그룹 이름을 그대로 되풀이하는 행이 있다 — 그건 대상(키워드/소재)
      // 이름이 아니므로 믿지 않고 조회한다.
      const raw = (obj.displayName ?? "").trim();
      const echoesParent =
        raw !== "" &&
        (raw === (heroes?.nccAdgroupName ?? "").trim() ||
          raw === (heroes?.nccCampaignName ?? "").trim());
      const item: HistoryReportItem = {
        ts,
        where: text,
        detail,
        // 이름이 안 실렸거나 상위 이름의 반복이면 키워드/소재 이름을 별도 조회로 채운다.
        refId: (!named || echoesParent) && /^(nkw|nad)-/.test(id) ? id : undefined,
        campaignId: heroes?.nccCampaignId ?? (id.startsWith("cmp-") ? id : undefined),
      };
      const list = byGroup.get(group);
      if (list) list.push(item);
      else byGroup.set(group, [item]);
    }
  }

  const groups: HistoryReportGroup[] = GROUP_ORDER.filter((k) => byGroup.has(k)).map((k) => ({
    key: k,
    label: GROUP_LABEL[k],
    items: byGroup.get(k)!.sort((a, b) => b.ts - a.ts),
  }));
  return {
    groups,
    total: groups.reduce((n, g) => n + g.items.length, 0),
    truncated,
  };
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 보고 구조 → 카톡 붙여넣기용 텍스트. 내역은 접지 않고 전부 나열한다. */
export function formatHistoryReportText(
  sinceMs: number,
  untilMs: number,
  report: HistoryReport,
): string {
  const lines: string[] = [];
  lines.push(`[광고 관리 내역] ${fmtDate(sinceMs)} ~ ${fmtDate(untilMs)}`);
  lines.push("");

  if (report.total === 0) {
    lines.push("해당 기간에 정리할 관리 내역이 없습니다.");
    return lines.join("\n");
  }

  const renderGroups = (groups: HistoryReportGroup[]) => {
    for (const g of groups) {
      lines.push(`■ ${g.label} ${g.items.length}건`);
      // 같은 대상(캠페인 > 그룹 > 키워드)의 변경은 한 덩어리로 묶는다 — 대상 줄 아래에
      // 변경 내용 + 시각을 시간순으로 나열. 순서는 최근에 만진 대상부터.
      const byTarget = new Map<string, HistoryReportItem[]>();
      for (const item of g.items) {
        const list = byTarget.get(item.where);
        if (list) list.push(item);
        else byTarget.set(item.where, [item]);
      }
      for (const [target, items] of byTarget) {
        const changes = items
          .filter((i) => i.detail)
          .sort((a, b) => a.ts - b.ts)
          .map((i) => {
            // 그룹명이 이미 "입찰가 조정"이라 각 줄의 "입찰가 " 접두는 소음 — 떼고 값만.
            const detail = g.key === "bid" ? i.detail.replace(/^입찰가 /, "") : i.detail;
            return `    ${detail} (${fmtDateTime(i.ts)})`;
          });
        if (target) {
          lines.push(`  - ${target}`);
          lines.push(...changes);
        } else {
          // 대상 위치를 못 얻은 항목은 변경 내용만 한 줄씩.
          for (const c of changes) lines.push(`  - ${c.trim()}`);
        }
      }
    }
  };

  // 캠페인 유형을 아는 항목이 있으면 유형별 섹션으로 나눈다 (조회 실패 시엔 통짜).
  const typeOrder = [...Object.values(CAMPAIGN_TYPE_LABEL), "기타"];
  const typesPresent = typeOrder.filter((t) =>
    report.groups.some((g) => g.items.some((i) => (i.campaignType ?? "기타") === t)),
  );
  const hasTypeInfo = report.groups.some((g) => g.items.some((i) => i.campaignType));
  if (!hasTypeInfo) {
    renderGroups(report.groups);
  } else {
    typesPresent.forEach((type, idx) => {
      if (idx > 0) lines.push("");
      lines.push(`◆ ${type}`);
      renderGroups(
        report.groups
          .map((g) => ({ ...g, items: g.items.filter((i) => (i.campaignType ?? "기타") === type) }))
          .filter((g) => g.items.length > 0),
      );
    });
  }

  if (report.truncated) {
    lines.push("");
    lines.push("※ 변경 내역이 너무 많아 일부가 제외되었습니다.");
  }
  return lines.join("\n");
}
