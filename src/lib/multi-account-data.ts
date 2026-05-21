/**
 * F-MultiAccount — 광고관리자 internal API 호출 (콘텐츠 스크립트 전용).
 *
 * 모든 호출은 ads.naver.com 콘텐츠 스크립트 컨텍스트에서만 가능 (background는 CORS로 차단).
 * 인증은 광고관리자 로그인 쿠키 + `x-xsrf-token` 헤더 (XSRF-TOKEN 쿠키 더블 서밋).
 *
 * 정찰 결과 정리: 메모리 `project_f_multiaccount_endpoints` 참조.
 */

import type {
  MultiAccountDirectoryEntry,
  MultiAccountSnapshot,
} from "@/types/storage";

interface DirectoryPageResponse {
  content: Array<{
    adAccountNo: number;
    naverId?: string;
    roleName?: string;
    lastAccessTime?: string;
    favorite?: boolean;
    adAccount?: {
      no?: number;
      name?: string;
      adPlatformType?: string;
      disabled?: boolean;
      deleted?: boolean;
      masterCustomerId?: number;
    };
  }>;
  totalPages: number;
  totalElements: number;
  number: number;
}

interface BizMoneyResponse {
  refundableAmt?: number;
  nonRefundableAmt?: number;
}

interface NccCampaignRow {
  nccCampaignId?: string;
  campaignTp?: string;
}

interface NccAdgroupRow {
  nccAdgroupId?: string;
  campaignTp?: string;
  nccCampaignId?: string;
  adgroupType?: string;
}

interface StatsResponse {
  data: Array<{
    id: string;
    impCnt?: number;
    clkCnt?: number;
    cpc?: number;
    salesAmtMicros?: number;
    purchaseConvAmtMicros?: number;
    purchaseCcnt?: number;
  }>;
}

interface ContractsResponse {
  nccAdgroupId: string;
  currentTimeContract?: {
    contractName?: string;
    campaignTp?: string;
    contractStartDt?: string;
    contractEndDt?: string;
    contractStatus?: string;
  };
}

// ─── 공통 인증 fetch ───

/**
 * `x-ad-customer-id` 헤더가 cross-account의 silver bullet — 서버가 이 헤더의 customerId
 * 기준으로 응답해서 SPA 활성 계정 컨텍스트와 무관하게 다른 계정 데이터를 받을 수 있다.
 * 광고관리자 SPA 자신도 모든 internal API 호출에 이 헤더를 함께 보냄(2026-05-21 정찰 확인).
 * 헤더 없으면 서버가 세션 활성 계정 기준으로 응답하므로 활성 계정 컨텍스트가 안 잡힌
 * 상태에서는 404 "광고주가 존재하지 않습니다" 반환.
 */
async function authFetch<T>(
  input: string,
  init?: RequestInit,
  customerId?: number,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("x-xsrf-token")) {
    const xsrf = readCookie("XSRF-TOKEN");
    if (xsrf) headers.set("x-xsrf-token", decodeURIComponent(xsrf));
  }
  if (customerId !== undefined && !headers.has("x-ad-customer-id")) {
    headers.set("x-ad-customer-id", String(customerId));
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json, text/plain, */*");
  }
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const resp = await fetch(input, {
    ...init,
    headers,
    credentials: "include",
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

function readCookie(name: string): string | null {
  for (const raw of document.cookie.split(";")) {
    const t = raw.trim();
    if (t.startsWith(name + "=")) return t.slice(name.length + 1);
  }
  return null;
}

// ─── 광고계정 명단 (페이지네이션 누적) ───

export async function fetchAllDirectory(): Promise<MultiAccountDirectoryEntry[]> {
  const PAGE_SIZE = 50;
  const out: MultiAccountDirectoryEntry[] = [];
  let page = 0;
  let totalPages = 1;
  while (page < totalPages) {
    const url =
      `/apis/ad-account/v1.1/adAccounts/access?size=${PAGE_SIZE}&page=${page}` +
      `&sort=${encodeURIComponent("adAccount.name,asc")}`;
    const json = await authFetch<DirectoryPageResponse>(url);
    totalPages = json.totalPages ?? 1;
    for (const item of json.content ?? []) {
      const ad = item.adAccount;
      if (!ad?.no || !ad.name) continue;
      out.push({
        adAccountNo: ad.no,
        name: ad.name,
        adPlatformType: ad.adPlatformType ?? "",
        roleName: item.roleName ?? "",
        serverFavorite: !!item.favorite,
        lastAccessTime: item.lastAccessTime ?? "",
        masterCustomerId: ad.masterCustomerId,
        disabled: ad.disabled,
        deleted: ad.deleted,
      });
    }
    page++;
    if (page >= 50) break; // 비정상 무한 페이지 방어
  }
  return out;
}

// ─── 비즈머니 잔액 ───

/**
 * bmgate URL은 path에 adAccountNo가 박혀있어 `x-ad-customer-id` 헤더 없이도
 * 그 계정의 비즈머니를 직접 응답. campaigns/stats/contracts는 `/apis/sa/api/*` 경로 +
 * x-ad-customer-id 헤더 조합으로 cross-account 가능.
 */
export async function fetchBizMoney(adAccountNo: number): Promise<number | null> {
  try {
    const json = await authFetch<BizMoneyResponse>(
      `/apis/bmgate/v1.0/adAccounts/${adAccountNo}/bizmoney/account`,
    );
    const refundable = Number(json.refundableAmt ?? 0);
    const nonRefundable = Number(json.nonRefundableAmt ?? 0);
    if (!Number.isFinite(refundable) || !Number.isFinite(nonRefundable)) return null;
    return refundable + nonRefundable;
  } catch (e) {
    console.warn("[dv-ads/multi-account] bizmoney 실패", e);
    return null;
  }
}

// ─── 캠페인 ID 리스트 (campaignType별 호출 필요) ───

// 정찰 결과: `/apis/sa/api/ncc/campaigns`는 `campaignType` 파라미터 필수.
// 광고관리자 페이지가 매체별 따로 호출. 타입 병렬 호출해서 합산.
//
// `BRAND`/`NEW_PROD`만 time-contracts 대상이라 브랜드검색 알림 D-day 계산에 쓰임.
// 응답의 `campaignTp` 필드는 더 구체적인 값(`BRAND_SEARCH`, `NEW_PRODUCT_SEARCH` 등)으로
// 돌아올 수 있어 호출 측 필터(`=== "BRAND"`)와 어긋남 → 출처(URL의 campaignType)로 강제 태깅.
const CAMPAIGN_TYPES = [
  "WEB_SITE",       // 파워링크
  "SHOPPING_NS",    // 쇼핑검색
  "BRAND",          // 브랜드검색
  "NEW_PROD",       // 신제품검색 (브랜드와 별도 campaignType)
  "POWER_CONTENTS", // 파워컨텐츠
  "PLACE",          // 플레이스
] as const;

// 브랜드검색 알림 D-day 대상 — 두 캠페인 타입의 광고그룹에 time-contracts 존재.
const BRAND_LIKE_TYPES: ReadonlyArray<(typeof CAMPAIGN_TYPES)[number]> = ["BRAND", "NEW_PROD"];

export async function fetchCampaignRows(customerId: number): Promise<NccCampaignRow[]> {
  const results = await Promise.allSettled(
    CAMPAIGN_TYPES.map((tp) =>
      authFetch<NccCampaignRow[]>(
        `/apis/sa/api/ncc/campaigns?recordSize=1001&campaignType=${tp}`,
        undefined,
        customerId,
      ),
    ),
  );
  const out: NccCampaignRow[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      const tp = CAMPAIGN_TYPES[i];
      // recordSize=1001로 호출했는데 1000개를 넘으면 page 짤림 가능 — stats 누락 위험 경고.
      // 페이지네이션은 SPA 보강 작업 시까지 보류.
      if (r.value.length >= 1001) {
        console.warn(
          `[dv-ads/multi-account] 캠페인 ${tp}이(가) 1000개를 초과해 일부 통계가 누락될 수 있어요`,
          r.value.length,
        );
      }
      for (const row of r.value) {
        if (row?.nccCampaignId) {
          // 응답 campaignTp는 그대로 안 쓰고 요청 URL의 tp로 태깅 — 호출 측 필터가
          // "BRAND" 같은 카테고리 키로 매칭할 수 있도록 보장 (응답이 BRAND_SEARCH 등
          // 더 구체적인 서브타입이라 직접 비교하면 누락).
          out.push({ nccCampaignId: row.nccCampaignId, campaignTp: tp });
        }
      }
    }
  }
  return out;
}

// ─── 광고그룹 ID 리스트 (특정 캠페인의 그룹 조회) ───

// 정찰 결과: `/apis/sa/api/ncc/adgroups`는 `nccCampaignId` 파라미터 필수.
// 브랜드검색 계약 정보는 BRAND 캠페인의 광고그룹 ID 필요.
export async function fetchAdgroupRowsByCampaign(
  nccCampaignId: string,
  customerId: number,
): Promise<NccAdgroupRow[]> {
  const url = `/apis/sa/api/ncc/adgroups?nccCampaignId=${encodeURIComponent(nccCampaignId)}&recordSize=1001`;
  const raw = await authFetch<NccAdgroupRow[]>(url, undefined, customerId).catch(() => [] as NccAdgroupRow[]);
  return Array.isArray(raw) ? raw : [];
}

// ─── 어제 stats (캠페인 ID 합산) ───

export async function fetchYesterdayStats(
  campaignIds: string[],
  yesterdayISODate: string,
  customerId: number,
): Promise<MultiAccountSnapshot["yesterday"]> {
  if (campaignIds.length === 0) {
    return { impressions: 0, clicks: 0, ctr: 0, cpc: 0, cost: 0, revenue: 0, conversions: 0, roas: 0 };
  }
  const CHUNK = 80;
  let impressions = 0,
    clicks = 0,
    costMicros = 0,
    convValueMicros = 0,
    conversions = 0;
  for (let i = 0; i < campaignIds.length; i += CHUNK) {
    const chunk = campaignIds.slice(i, i + CHUNK);
    const body = JSON.stringify({
      fields: [
        "impCnt",
        "clkCnt",
        "cpc",
        "salesAmtMicros",
        "purchaseConvAmtMicros",
        "purchaseCcnt",
      ],
      timeIncrement: "allDays",
      timeRange: { since: yesterdayISODate, until: yesterdayISODate },
      ids: chunk.join(","),
    });
    const json = await authFetch<StatsResponse>(
      "/apis/sa/api/stats",
      { method: "POST", body },
      customerId,
    );
    for (const row of json.data ?? []) {
      impressions += Number(row.impCnt ?? 0);
      clicks += Number(row.clkCnt ?? 0);
      costMicros += Number(row.salesAmtMicros ?? 0);
      convValueMicros += Number(row.purchaseConvAmtMicros ?? 0);
      conversions += Number(row.purchaseCcnt ?? 0);
    }
  }
  const cost = costMicros / 1_000_000;
  const revenue = convValueMicros / 1_000_000;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpc = clicks > 0 ? Math.round(cost / clicks) : 0;
  const roas = cost > 0 ? (revenue / cost) * 100 : 0;
  return { impressions, clicks, ctr, cpc, cost, revenue, conversions, roas };
}

// ─── 계약 정보 (BRAND_SEARCH 등 time-contracts) ───

export async function fetchContracts(
  adgroupIds: string[],
  customerId: number,
): Promise<MultiAccountSnapshot["contracts"]> {
  if (adgroupIds.length === 0) return [];
  const url =
    "/apis/sa/api/ncc/time-contracts/after-current-summaries?nccAdgroupIds=" +
    encodeURIComponent(adgroupIds.join(","));
  const raw = await authFetch<ContractsResponse[]>(url, undefined, customerId);
  const out: MultiAccountSnapshot["contracts"] = [];
  for (const row of raw ?? []) {
    const c = row.currentTimeContract;
    if (!c?.contractEndDt) continue;
    out.push({
      product: c.contractName ?? "",
      campaignTp: c.campaignTp ?? "",
      endDate: c.contractEndDt,
      status: c.contractStatus ?? "",
    });
  }
  return out;
}

// ─── 통합: 특정 광고계정의 모든 데이터 수집 ───

export interface AccountSnapshotPayload {
  bizMoney: number | null;
  yesterday: MultiAccountSnapshot["yesterday"];
  contracts: MultiAccountSnapshot["contracts"];
}

/**
 * 어떤 광고계정의 데이터든 현재 페이지 컨텍스트에서 직접 수집. hidden tab/approach 불필요.
 *
 * - bizmoney: URL에 adAccountNo가 박힌 bmgate endpoint
 * - campaigns/stats/contracts/adgroups: `x-ad-customer-id` 헤더로 cross-account
 *
 * `customerId`는 광고계정의 `masterCustomerId`(검색광고 customerId와 동일 ID space).
 * directory entry에서 가져온다. 빠진 경우 호출 측에서 skip.
 */
export async function collectAccount(
  adAccountNo: number,
  customerId: number,
  yesterdayISODate: string,
): Promise<AccountSnapshotPayload> {
  // 비즈머니 + 캠페인 동시 fetch
  const [bizMoney, campaignRows] = await Promise.all([
    fetchBizMoney(adAccountNo),
    fetchCampaignRows(customerId).catch((e) => {
      console.warn("[dv-ads/multi-account] campaigns 실패", e);
      return [] as NccCampaignRow[];
    }),
  ]);

  const allCampaignIds = campaignRows
    .map((c) => c.nccCampaignId)
    .filter((id): id is string => !!id);
  const brandCampaignIds = campaignRows
    .filter((c) => BRAND_LIKE_TYPES.includes(c.campaignTp as (typeof CAMPAIGN_TYPES)[number]))
    .map((c) => c.nccCampaignId)
    .filter((id): id is string => !!id);

  // stats (어제) + 브랜드검색 광고그룹 ID 동시
  const [yesterday, brandAdgroupIds] = await Promise.all([
    fetchYesterdayStats(allCampaignIds, yesterdayISODate, customerId).catch((e) => {
      console.warn("[dv-ads/multi-account] stats 실패", e);
      return null;
    }),
    fetchBrandAdgroupIds(brandCampaignIds, customerId).catch((e) => {
      console.warn("[dv-ads/multi-account] brand adgroups 실패", e);
      return [] as string[];
    }),
  ]);

  const contracts = await fetchContracts(brandAdgroupIds, customerId).catch((e) => {
    console.warn("[dv-ads/multi-account] contracts 실패", e);
    return [] as MultiAccountSnapshot["contracts"];
  });

  // [DEBUG] 브랜드검색 알림 진단용 — 단계별 카운트. 원인 좁힌 뒤 제거 예정.
  console.log("[dv-ads/multi-account/debug]", {
    adAccountNo,
    customerId,
    totalCampaigns: campaignRows.length,
    campaignTps: [...new Set(campaignRows.map((c) => c.campaignTp))],
    brandCampaignIds: brandCampaignIds.length,
    brandAdgroupIds: brandAdgroupIds.length,
    contracts: contracts.length,
    contractsSample: contracts[0],
  });

  return { bizMoney, yesterday, contracts };
}

async function fetchBrandAdgroupIds(
  brandCampaignIds: string[],
  customerId: number,
): Promise<string[]> {
  if (brandCampaignIds.length === 0) return [];
  const results = await Promise.allSettled(
    brandCampaignIds.map((cmpId) => fetchAdgroupRowsByCampaign(cmpId, customerId)),
  );
  const out: string[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const row of r.value) {
        if (row?.nccAdgroupId) out.push(row.nccAdgroupId);
      }
    }
  }
  return out;
}

// ─── 날짜 유틸 ───

export function yesterdayKST(): string {
  const now = new Date();
  // ads.naver.com이 KST(+09:00) 기준이라 사용자 로컬 시간을 KST 오프셋으로 환산
  const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS + now.getTimezoneOffset() * 60 * 1000);
  kstNow.setUTCDate(kstNow.getUTCDate() - 1);
  const y = kstNow.getUTCFullYear();
  const m = String(kstNow.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kstNow.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
