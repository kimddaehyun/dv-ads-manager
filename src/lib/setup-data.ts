/**
 * F-Setup — 세팅안 데이터 수집 (콘텐츠 스크립트 전용).
 *
 * ads.naver.com ncc internal API로 캠페인→광고그룹→소재→키워드 계층을 순회 수집한다.
 * 인증/cross-account 헤더는 `authFetch`(multi-account-data.ts)에 위임 — `x-ad-customer-id`에
 * masterCustomerId를 넣어 활성 계정과 무관하게 조회. background에선 CORS로 막히므로 콘텐츠
 * 스크립트에서만 호출 가능.
 *
 * 예상 순위(searchad API)는 여기서 다루지 않는다 — keyword.rank=null로 채워두고 호출 측
 * (setup.ts)이 background GET_BID_ESTIMATE로 보강. internal API와 searchad의 책임 분리.
 *
 * endpoint schema: 메모리 `project_f_setup_endpoints`.
 */

import { authFetch } from "./multi-account-data";
import {
  campaignTypeLabel,
  normalizeAd,
  normalizeTargeting,
  typeHasKeywords,
  type RawAd,
  type RawTarget,
} from "./setup-adapters";
import type {
  CampaignTypeCode,
  SetupAdgroup,
  SetupCampaign,
  SetupCampaignChoice,
  SetupKeyword,
  SetupProgress,
} from "@/types/setup";

const CAMPAIGN_TYPES: CampaignTypeCode[] = [
  "WEB_SITE",
  "SHOPPING",
  "BRAND_SEARCH",
  "POWER_CONTENTS",
  "PLACE",
];

const CONCURRENCY = 4;

interface RawCampaign {
  nccCampaignId?: string;
  name?: string;
  campaignTp?: string;
  dailyBudget?: number;
  useDailyBudget?: boolean;
  status?: string;
}

interface RawAdgroup {
  nccAdgroupId?: string;
  name?: string;
  bidAmt?: number;
  dailyBudget?: number;
  useDailyBudget?: boolean;
  adRollingType?: string;
  adgroupType?: string;
  targetSummary?: Record<string, unknown>;
}

interface RawAdgroupDetail extends RawAdgroup {
  targets?: RawTarget[];
}

interface RawKeyword {
  nccKeywordId?: string;
  keyword?: string;
  bidAmt?: number;
  useGroupBidAmt?: boolean;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** useDailyBudget=false면 일예산 제한 없음(null). */
function budgetOf(useDaily: boolean | undefined, daily: number | undefined): number | null {
  return useDaily ? num(daily) : null;
}

/** 간단한 worker pool — 동시 실행 수 제한. 결과는 입력 순서 유지. */
async function pool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * 캠페인 선택 popover용 경량 목록. 유형별 병렬 호출 후 합산. 예산은 캠페인 목록 응답에
 * 이미 포함돼 단건 호출 불필요.
 */
export async function fetchSetupCampaignChoices(
  customerId: number,
): Promise<SetupCampaignChoice[]> {
  const results = await Promise.allSettled(
    CAMPAIGN_TYPES.map((tp) =>
      authFetch<RawCampaign[]>(
        `/apis/sa/api/ncc/campaigns?recordSize=1001&campaignType=${tp}`,
        undefined,
        customerId,
      ),
    ),
  );
  const out: SetupCampaignChoice[] = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) return;
    const tp = CAMPAIGN_TYPES[i];
    for (const c of r.value) {
      if (!c?.nccCampaignId) continue;
      out.push({
        id: c.nccCampaignId,
        name: c.name?.trim() || "(이름 없음)",
        typeCode: tp,
        typeLabel: campaignTypeLabel(tp),
        dailyBudget: budgetOf(c.useDailyBudget, c.dailyBudget),
        status: c.status ?? "",
      });
    }
  });
  return out;
}

/**
 * 선택된 캠페인들의 전체 계층(그룹/소재/키워드/타겟팅/예산)을 수집.
 * 1) 캠페인별 그룹 목록 (pool) → 2) 평탄화한 그룹별 상세+소재+키워드 (pool) → 3) 트리 재구성.
 * 키워드 rank는 null — 호출 측에서 예상순위 보강.
 */
export async function collectSetupData(
  customerId: number,
  campaigns: SetupCampaignChoice[],
  onProgress?: SetupProgress,
): Promise<SetupCampaign[]> {
  // 1) 캠페인별 그룹 목록.
  let groupDone = 0;
  onProgress?.(0, campaigns.length, "광고그룹을 불러오는 중");
  const perCampaign = await pool(campaigns, CONCURRENCY, async (c) => {
    const raw = await authFetch<RawAdgroup[]>(
      `/apis/sa/api/ncc/adgroups?nccCampaignId=${encodeURIComponent(c.id)}&recordSize=1001`,
      undefined,
      customerId,
    ).catch(() => [] as RawAdgroup[]);
    groupDone++;
    onProgress?.(groupDone, campaigns.length, "광고그룹을 불러오는 중");
    return { campaign: c, groups: Array.isArray(raw) ? raw : [] };
  });

  // 2) (캠페인, 그룹) 평탄화.
  const flat: Array<{ campaign: SetupCampaignChoice; group: RawAdgroup }> = [];
  for (const pc of perCampaign) {
    for (const g of pc.groups) {
      if (g?.nccAdgroupId) flat.push({ campaign: pc.campaign, group: g });
    }
  }

  // 3) 그룹별 상세(타겟)+소재+키워드 병렬 수집.
  let detailDone = 0;
  const total = flat.length;
  const built = await pool(flat, CONCURRENCY, async ({ campaign, group }) => {
    const gid = group.nccAdgroupId as string;
    const [detail, ads, keywords] = await Promise.all([
      authFetch<RawAdgroupDetail>(
        `/apis/sa/api/ncc/adgroups/${encodeURIComponent(gid)}`,
        undefined,
        customerId,
      ).catch(() => ({}) as RawAdgroupDetail),
      authFetch<RawAd[]>(
        `/apis/sa/api/ncc/ads?nccAdgroupId=${encodeURIComponent(gid)}&recordSize=1001`,
        undefined,
        customerId,
      ).catch(() => [] as RawAd[]),
      typeHasKeywords(campaign.typeCode)
        ? authFetch<RawKeyword[]>(
            `/apis/sa/api/ncc/keywords?nccAdgroupId=${encodeURIComponent(gid)}&recordSize=1001`,
            undefined,
            customerId,
          ).catch(() => [] as RawKeyword[])
        : Promise.resolve([] as RawKeyword[]),
    ]);
    detailDone++;
    onProgress?.(detailDone, total, "소재·키워드를 불러오는 중");

    const groupBid = num(group.bidAmt);
    const setupKeywords: SetupKeyword[] = (Array.isArray(keywords) ? keywords : [])
      .map((k): SetupKeyword => {
        const inherited = !!k.useGroupBidAmt;
        return {
          keyword: k.keyword?.trim() ?? "",
          bidAmt: inherited ? groupBid : num(k.bidAmt),
          inheritedFromGroup: inherited,
          rank: null,
        };
      })
      .filter((k) => k.keyword);

    const targets = Array.isArray(detail.targets) ? detail.targets : [];
    const setupGroup: SetupAdgroup = {
      id: gid,
      name: group.name?.trim() || "(이름 없음)",
      groupBid,
      dailyBudget: budgetOf(group.useDailyBudget, group.dailyBudget),
      targeting: normalizeTargeting(group, targets),
      ads: (Array.isArray(ads) ? ads : []).map(normalizeAd),
      keywords: setupKeywords,
    };
    return { campaignId: campaign.id, group: setupGroup };
  });

  // 4) 트리 재구성 (선택 순서 유지).
  const byCampaign = new Map<string, SetupAdgroup[]>();
  for (const b of built) {
    const list = byCampaign.get(b.campaignId);
    if (list) list.push(b.group);
    else byCampaign.set(b.campaignId, [b.group]);
  }
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    typeCode: c.typeCode,
    typeLabel: c.typeLabel,
    dailyBudget: c.dailyBudget,
    adgroups: byCampaign.get(c.id) ?? [],
  }));
}

/**
 * 수집된 캠페인들에서 (키워드, 실효입찰가) 중복 제거 목록 추출 — GET_BID_ESTIMATE 입력용.
 * SHOPPING/PLACE 등 키워드 없는 유형은 자연히 빈 결과.
 */
export function collectKeywordBidPairs(
  campaigns: SetupCampaign[],
): Array<{ keyword: string; currentBid: number }> {
  const seen = new Map<string, { keyword: string; currentBid: number }>();
  for (const c of campaigns) {
    for (const g of c.adgroups) {
      for (const k of g.keywords) {
        if (!k.keyword || k.bidAmt <= 0) continue;
        const id = `${k.keyword}|${k.bidAmt}`;
        if (!seen.has(id)) seen.set(id, { keyword: k.keyword, currentBid: k.bidAmt });
      }
    }
  }
  return Array.from(seen.values());
}
