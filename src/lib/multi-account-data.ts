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

async function authFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("x-xsrf-token")) {
    const xsrf = readCookie("XSRF-TOKEN");
    if (xsrf) headers.set("x-xsrf-token", decodeURIComponent(xsrf));
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

export async function fetchBizMoney(): Promise<number | null> {
  try {
    const json = await authFetch<BizMoneyResponse>("/apis/sa/api/bizmoney/account");
    const refundable = Number(json.refundableAmt ?? 0);
    const nonRefundable = Number(json.nonRefundableAmt ?? 0);
    if (!Number.isFinite(refundable) || !Number.isFinite(nonRefundable)) return null;
    return refundable + nonRefundable;
  } catch (e) {
    console.warn("[dv-ads/multi-account] bizmoney 실패", e);
    return null;
  }
}

// ─── 활성 광고계정 컨텍스트 ready check ───

/**
 * iframe 안에서 SPA가 활성 광고계정 컨텍스트를 잡기 전에 fetch하면 404
 * "요청하신 광고주가 존재하지 않습니다" 반환. `/apis/sa/api/bizmoney/account`가
 * 200을 응답하는 시점 = SPA가 활성 계정 init 완료. 그 시점까지 backoff polling.
 */
export async function waitForAccountContext(maxMs = 8000): Promise<boolean> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxMs) {
    try {
      const resp = await fetch("/apis/sa/api/bizmoney/account", {
        credentials: "include",
        headers: buildAuthHeaders(),
      });
      if (resp.ok) return true;
      if (resp.status === 404) {
        attempt++;
        await sleep(Math.min(300 + attempt * 200, 1200));
        continue;
      }
      // 401/403/5xx — retry 무의미
      return false;
    } catch {
      attempt++;
      await sleep(400);
    }
  }
  return false;
}

function buildAuthHeaders(): Record<string, string> {
  const xsrf = readCookie("XSRF-TOKEN");
  const h: Record<string, string> = {};
  if (xsrf) h["x-xsrf-token"] = decodeURIComponent(xsrf);
  return h;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 캠페인 ID 리스트 (campaignType별 호출 필요) ───

// 정찰 결과: `/apis/sa/api/ncc/campaigns`는 `campaignType` 파라미터 필수.
// 광고관리자 페이지가 매체별 따로 호출. 5개 타입 병렬 호출해서 합산.
const CAMPAIGN_TYPES = [
  "WEB_SITE",       // 파워링크
  "SHOPPING_NS",    // 쇼핑검색
  "BRAND",          // 브랜드검색/신제품검색 (time-contracts 대상)
  "POWER_CONTENTS", // 파워컨텐츠
  "PLACE",          // 플레이스
] as const;

export async function fetchCampaignRows(): Promise<NccCampaignRow[]> {
  const results = await Promise.allSettled(
    CAMPAIGN_TYPES.map((tp) =>
      authFetch<NccCampaignRow[]>(
        `/apis/sa/api/ncc/campaigns?recordSize=1001&campaignType=${tp}`,
      ),
    ),
  );
  const out: NccCampaignRow[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && Array.isArray(r.value)) {
      const tp = CAMPAIGN_TYPES[i];
      for (const row of r.value) {
        if (row?.nccCampaignId) {
          out.push({ nccCampaignId: row.nccCampaignId, campaignTp: row.campaignTp ?? tp });
        }
      }
    }
  }
  return out;
}

// ─── 광고그룹 ID 리스트 (특정 캠페인의 그룹 조회) ───

// 정찰 결과: `/apis/sa/api/ncc/adgroups`는 `nccCampaignId` 파라미터 필수.
// 브랜드검색 계약 정보는 BRAND 캠페인의 광고그룹 ID 필요.
export async function fetchAdgroupRowsByCampaign(nccCampaignId: string): Promise<NccAdgroupRow[]> {
  const url = `/apis/sa/api/ncc/adgroups?nccCampaignId=${encodeURIComponent(nccCampaignId)}&recordSize=1001`;
  const raw = await authFetch<NccAdgroupRow[]>(url).catch(() => [] as NccAdgroupRow[]);
  return Array.isArray(raw) ? raw : [];
}

// ─── 어제 stats (캠페인 ID 합산) ───

export async function fetchYesterdayStats(
  campaignIds: string[],
  yesterdayISODate: string,
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
    const json = await authFetch<StatsResponse>("/apis/sa/api/stats", {
      method: "POST",
      body,
    });
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

export async function fetchContracts(adgroupIds: string[]): Promise<MultiAccountSnapshot["contracts"]> {
  if (adgroupIds.length === 0) return [];
  const url =
    "/apis/sa/api/ncc/time-contracts/after-current-summaries?nccAdgroupIds=" +
    encodeURIComponent(adgroupIds.join(","));
  const raw = await authFetch<ContractsResponse[]>(url);
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

// ─── 통합: 현재 활성 계정의 모든 데이터 수집 ───

export interface AccountSnapshotPayload {
  bizMoney: number | null;
  yesterday: MultiAccountSnapshot["yesterday"];
  contracts: MultiAccountSnapshot["contracts"];
}

export async function collectActiveAccount(yesterdayISODate: string): Promise<AccountSnapshotPayload> {
  // SPA가 활성 광고계정 컨텍스트 잡을 때까지 대기 (iframe 환경 대응)
  const ready = await waitForAccountContext();
  if (!ready) {
    console.warn("[dv-ads/multi-account] SPA 활성 계정 컨텍스트 초기화 시간 초과");
    return { bizMoney: null, yesterday: null, contracts: [] };
  }
  // 비즈머니 + 캠페인 동시 fetch
  const [bizMoney, campaignRows] = await Promise.all([
    fetchBizMoney(),
    fetchCampaignRows().catch((e) => {
      console.warn("[dv-ads/multi-account] campaigns 실패", e);
      return [] as NccCampaignRow[];
    }),
  ]);

  const allCampaignIds = campaignRows
    .map((c) => c.nccCampaignId)
    .filter((id): id is string => !!id);
  const brandCampaignIds = campaignRows
    .filter((c) => c.campaignTp === "BRAND")
    .map((c) => c.nccCampaignId)
    .filter((id): id is string => !!id);

  // stats (어제) + 브랜드검색 광고그룹 ID 동시
  const [yesterday, brandAdgroupIds] = await Promise.all([
    fetchYesterdayStats(allCampaignIds, yesterdayISODate).catch((e) => {
      console.warn("[dv-ads/multi-account] stats 실패", e);
      return null;
    }),
    fetchBrandAdgroupIds(brandCampaignIds).catch((e) => {
      console.warn("[dv-ads/multi-account] brand adgroups 실패", e);
      return [] as string[];
    }),
  ]);

  const contracts = await fetchContracts(brandAdgroupIds).catch((e) => {
    console.warn("[dv-ads/multi-account] contracts 실패", e);
    return [] as MultiAccountSnapshot["contracts"];
  });

  return { bizMoney, yesterday, contracts };
}

async function fetchBrandAdgroupIds(brandCampaignIds: string[]): Promise<string[]> {
  if (brandCampaignIds.length === 0) return [];
  const results = await Promise.allSettled(
    brandCampaignIds.map((cmpId) => fetchAdgroupRowsByCampaign(cmpId)),
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
