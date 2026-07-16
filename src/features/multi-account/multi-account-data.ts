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
import { loadPlatformFilter, type PlatformFilter } from "./multi-account-storage";

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

// 대시보드 통합 endpoint — SA+DA 캠페인 + 지표. GFA(DA)의 노출/클릭/비용 + 캠페인 ID 수집용.
// (구매완료 전환수 필드는 없어 conversion 수치는 campaignStats에서 별도로 가져온다.)
interface DashboardSearchResponse {
  results?: Array<{
    campaign?: { campaignId?: string; adPlatform?: string; type?: string };
    metrics?: {
      impressions?: number;
      clicks?: number;
      grossCostMicros?: number;
    };
  }>;
}

// GFA campaignStats — 구매완료 전환수/매출만 사용 (전체전환 convCount/convSalesKRW는 안 씀).
// key = DA 캠페인 ID(campaignId). 데이터 없는 캠페인은 값이 null로 섞여 올 수 있음.
type GfaCampaignStatsResponse = Record<
  string,
  { conversion?: { purchaseConvCount?: number; purchaseConvSalesKRW?: number } } | null
>;

interface ContractsResponse {
  nccAdgroupId: string;
  /** 진행 중 계약 (만료 전). 만료 후엔 null. */
  currentTimeContract?: TimeContractBlock;
  /** 예약된 다음 계약 (현재 계약 종료 후 시작). 없으면 null. */
  nextTimeContract?: TimeContractBlock;
}

interface TimeContractBlock {
  contractName?: string;
  campaignTp?: string;
  contractStartDt?: string;
  contractEndDt?: string;
  contractStatus?: string;
}

// ─── 공통 인증 fetch ───

/**
 * `x-ad-customer-id` 헤더가 cross-account의 silver bullet — 서버가 이 헤더의 customerId
 * 기준으로 응답해서 SPA 활성 계정 컨텍스트와 무관하게 다른 계정 데이터를 받을 수 있다.
 * 광고관리자 SPA 자신도 모든 internal API 호출에 이 헤더를 함께 보냄(2026-05-21 정찰 확인).
 * 헤더 없으면 서버가 세션 활성 계정 기준으로 응답하므로 활성 계정 컨텍스트가 안 잡힌
 * 상태에서는 404 "광고주가 존재하지 않습니다" 반환.
 */
export async function authFetch<T>(
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

/**
 * authFetch가 던진 403(권한 없음) 에러인지. 대행권이 타사/없는 계정은 광고비·비즈머니
 * 조회 권한이 없어 403이 흔하다 — 정상 상황이라 로그로 시끄럽게 남기지 않는다.
 */
function isForbiddenError(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith("HTTP 403");
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
    if (!isForbiddenError(e)) console.warn("[dv-ads/multi-account] bizmoney 실패", e);
    return null;
  }
}

// ─── 어제 광고비 (SA+DA 합산) ───

/**
 * 어제 하루 총 광고비(검색광고 + 디스플레이). dashboard `campaigns/search`의
 * `grossCostMicros`를 전 캠페인 합산 ÷ 1,000,000(원). `x-ad-customer-id`(=customerId)
 * 헤더로 cross-account. 대행권 점검에서 계정당 1회 호출(비즈머니와 병렬).
 */
export async function fetchYesterdayCost(
  adAccountNo: number,
  customerId: number,
  yesterdayISODate: string,
): Promise<number | null> {
  try {
    const body = JSON.stringify({
      startDate: yesterdayISODate,
      endDate: yesterdayISODate,
      filter: "campaign.adPlatform:in:SA,DA",
      orderBy: "campaign.status:asc",
      pageNumber: 1,
      pageSize: 1000,
    });
    const dash = await authFetch<DashboardSearchResponse>(
      `/apis/dashboard/v1/adAccounts/${adAccountNo}/campaigns/search`,
      { method: "POST", body },
      customerId,
    );
    let costMicros = 0;
    for (const row of dash.results ?? []) {
      costMicros += Number(row.metrics?.grossCostMicros ?? 0);
    }
    return costMicros / 1_000_000;
  } catch (e) {
    if (!isForbiddenError(e)) console.warn("[dv-ads/multi-account] 어제 광고비 실패", e);
    return null;
  }
}

// ─── 대행권 이관 (agencyOperations) ───

/** `/apis/mgr-account/v1/adAccounts/{no}/agencyOperations` 응답 원소 (2026-06-26 정찰). */
export interface AgencyOperationRow {
  agencyManagerAccountNo?: number;   // 대표 관리 계정 ID
  agencyManagerAccountName?: string;
  agencyCompanyName?: string;        // 에이전시명(표시용)
  directManagerAccountNo?: number;   // 담당 관리 계정 ID (정상 판별 키)
  directManagerAccountName?: string;
  acceptedAt?: string;               // 승인 일자
  taxInvoiceIncluded?: boolean;
}

export type AgencyOperationOutcome =
  | { kind: "ok"; row: AgencyOperationRow | null } // row null = 빈 배열(대행권 없음)
  | { kind: "forbidden" }                          // 403 — 권한 밖(확인 필요)
  | { kind: "error"; status: number; message: string };

/**
 * 대행권 이관 정보. bizmoney처럼 URL에 adAccountNo가 박힌 URL-aware endpoint라
 * x-ad-customer-id 헤더 없이 cross-account 가능 (2026-06-26 정찰, mgr-account 서비스).
 * 응답은 배열: 대행권 있으면 1개 원소, 없으면 빈 배열. authFetch는 non-ok에서 throw라
 * 403(권한 밖)과 그 외 에러를 구분하려고 여기선 raw fetch로 status를 직접 본다.
 */
export async function fetchAgencyOperation(adAccountNo: number): Promise<AgencyOperationOutcome> {
  const headers = new Headers({ accept: "application/json, text/plain, */*" });
  const xsrf = readCookie("XSRF-TOKEN");
  if (xsrf) headers.set("x-xsrf-token", decodeURIComponent(xsrf));
  try {
    const resp = await fetch(
      `/apis/mgr-account/v1/adAccounts/${adAccountNo}/agencyOperations`,
      { headers, credentials: "include" },
    );
    if (resp.status === 403) return { kind: "forbidden" };
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { kind: "error", status: resp.status, message: text.slice(0, 200) };
    }
    const arr = (await resp.json()) as AgencyOperationRow[];
    const row = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
    return { kind: "ok", row };
  } catch (e) {
    return { kind: "error", status: 0, message: String(e) };
  }
}

// ─── 캠페인 ID 리스트 (campaignType별 호출 필요) ───

// 정찰 결과: `/apis/sa/api/ncc/campaigns`는 `campaignType` 파라미터 필수.
// 광고관리자 페이지가 매체별 따로 호출. 타입 병렬 호출해서 합산.
//
// **주의**: SPA URL path에서 쓰는 string(`BRAND`/`NEW_PROD`/`SHOPPING_NS`)이 본 API에서는
// "this campaign Type don't exist" 400으로 거부됨. API가 받는 정답 풀네임이 따로 있음
// (2026-05-22 정찰):
//   - 브랜드검색 → `BRAND_SEARCH`
//   - 쇼핑검색  → `SHOPPING`
//   - 신제품검색 → 미확인 (정찰에서 매칭 안 됨, 추후 별도 정찰 필요)
const CAMPAIGN_TYPES = [
  "WEB_SITE",       // 파워링크
  "SHOPPING",       // 쇼핑검색 (← SHOPPING_NS 거부)
  "BRAND_SEARCH",   // 브랜드검색 (← BRAND 거부)
  "POWER_CONTENTS", // 파워컨텐츠
  "PLACE",          // 플레이스
] as const;

// 브랜드검색 알림 D-day 대상 — time-contracts 가진 캠페인 타입.
const BRAND_LIKE_TYPES: ReadonlyArray<(typeof CAMPAIGN_TYPES)[number]> = ["BRAND_SEARCH"];

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
      if (r.value.length >= 1001) {
        console.warn(
          `[dv-ads/multi-account] 캠페인 ${tp}이(가) 1000개를 초과해 일부 통계가 누락될 수 있어요`,
          r.value.length,
        );
      }
      for (const row of r.value) {
        if (row?.nccCampaignId) {
          // 응답 campaignTp는 그대로 안 쓰고 요청 URL의 tp로 태깅 — 호출 측 필터가
          // CAMPAIGN_TYPES 키로 정확히 매칭할 수 있도록 보장.
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
  // 청크는 병렬 호출 후 합산 — 동일 계정 내 청크라 호출 수는 그대로, 순차 대기만 제거.
  const chunkPromises: Promise<StatsResponse>[] = [];
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
    chunkPromises.push(
      authFetch<StatsResponse>(
        "/apis/sa/api/stats",
        { method: "POST", body },
        customerId,
      ),
    );
  }
  for (const json of await Promise.all(chunkPromises)) {
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

// ─── GFA(디스플레이) 어제 stats — 구매완료만 ───
//
// 데이터 소스 2개 조합 (메모리 project_gfa_multiaccount_endpoints):
//   1) 대시보드 campaigns/search filter:DA → 노출/클릭/비용 + DA campaignId (URL-aware, cross-account)
//   2) GFA campaignStats → 구매완료 전환수/매출 (purchaseConvCount/purchaseConvSalesKRW)
// 전체전환(convCount/conversions)은 사용하지 않는다 — 구매완료만.
const GFA_CONV_CHUNK = 100;

type YesterdayMetrics = NonNullable<MultiAccountSnapshot["yesterday"]>;

export async function fetchGfaYesterdayStats(
  adAccountNo: number,
  customerId: number,
  yesterdayISODate: string,
): Promise<YesterdayMetrics> {
  // 1) 대시보드 — DA 캠페인의 노출/클릭/비용 + ID. pageSize 크게 잡아 전체 합산.
  const body = JSON.stringify({
    startDate: yesterdayISODate,
    endDate: yesterdayISODate,
    filter: "campaign.adPlatform:in:DA",
    orderBy: "campaign.status:asc",
    pageNumber: 1,
    pageSize: 1000,
  });
  const dash = await authFetch<DashboardSearchResponse>(
    `/apis/dashboard/v1/adAccounts/${adAccountNo}/campaigns/search`,
    { method: "POST", body },
    customerId,
  );
  let impressions = 0;
  let clicks = 0;
  let costMicros = 0;
  const daIds: string[] = [];
  for (const row of dash.results ?? []) {
    const m = row.metrics ?? {};
    impressions += Number(m.impressions ?? 0);
    clicks += Number(m.clicks ?? 0);
    costMicros += Number(m.grossCostMicros ?? 0);
    const id = row.campaign?.campaignId;
    if (id) daIds.push(id);
  }

  // 2) campaignStats — 구매완료 전환수/매출 (DA campaignNoList 배치). URL-aware라 헤더 불필요(bmgate 패턴).
  // 청크는 병렬 호출 후 합산 (캠페인 많을 때 순차 대기 방지).
  let conversions = 0;
  let revenue = 0; // purchaseConvSalesKRW는 이미 원 단위
  const chunkPromises: Promise<GfaCampaignStatsResponse>[] = [];
  for (let i = 0; i < daIds.length; i += GFA_CONV_CHUNK) {
    const chunk = daIds.slice(i, i + GFA_CONV_CHUNK);
    const url =
      `/apis/gfa/v1/adAccounts/${adAccountNo}/stats/campaignStats` +
      `?campaignNoList=${encodeURIComponent(chunk.join(","))}` +
      `&startDate=${yesterdayISODate}&endDate=${yesterdayISODate}`;
    chunkPromises.push(
      authFetch<GfaCampaignStatsResponse>(url).catch((e) => {
        console.warn("[dv-ads/multi-account] GFA campaignStats 실패", e);
        return {} as GfaCampaignStatsResponse;
      }),
    );
  }
  for (const stats of await Promise.all(chunkPromises)) {
    for (const key of Object.keys(stats)) {
      const conv = stats[key]?.conversion;
      if (conv) {
        conversions += Number(conv.purchaseConvCount ?? 0);
        revenue += Number(conv.purchaseConvSalesKRW ?? 0);
      }
    }
  }

  const cost = costMicros / 1_000_000;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpc = clicks > 0 ? Math.round(cost / clicks) : 0;
  const roas = cost > 0 ? (revenue / cost) * 100 : 0;
  return { impressions, clicks, ctr, cpc, cost, revenue, conversions, roas };
}

function zeroYesterday(): YesterdayMetrics {
  return { impressions: 0, clicks: 0, ctr: 0, cpc: 0, cost: 0, revenue: 0, conversions: 0, roas: 0 };
}

// 두 플랫폼 snapshot 합산 — base(노출/클릭/비용/매출/전환)만 더하고 비율(CTR/CPC/ROAS)은 재계산.
function combineYesterday(
  a: YesterdayMetrics | null,
  b: YesterdayMetrics | null,
): YesterdayMetrics {
  const x = a ?? zeroYesterday();
  const y = b ?? zeroYesterday();
  const impressions = x.impressions + y.impressions;
  const clicks = x.clicks + y.clicks;
  const cost = x.cost + y.cost;
  const revenue = x.revenue + y.revenue;
  const conversions = x.conversions + y.conversions;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const cpc = clicks > 0 ? Math.round(cost / clicks) : 0;
  const roas = cost > 0 ? (revenue / cost) * 100 : 0;
  return { impressions, clicks, ctr, cpc, cost, revenue, conversions, roas };
}

// ─── 계약 정보 (BRAND_SEARCH 등 time-contracts) ───

/**
 * 광고그룹별 계약 정보 가져옴. **current + next 둘 다 추출** — "현재 계약 + 후속 예약"이
 * 모두 같은 광고그룹에 묶여있는 경우를 잡기 위함.
 *
 * 추가로 `adgroupToCampaign`을 받아 각 contract에 nccCampaignId를 태깅한다. 호출 측이
 * **캠페인 단위로 max(종료일)을 보고 캠페인별 D-day를 계산** 가능하게 함.
 *
 * 시나리오 예: 광고그룹 A=5/30 종료(current) + 광고그룹 B=5/31~8/30 예약(next on B 또는 next on A).
 * 광고그룹별 max를 캠페인에서 더 max로 묶으면 "후속 마련됨" 판정이 자연 성립.
 */
export async function fetchContracts(
  adgroupIds: string[],
  customerId: number,
  adgroupToCampaign?: Map<string, string>,
): Promise<MultiAccountSnapshot["contracts"]> {
  if (adgroupIds.length === 0) return [];
  const url =
    "/apis/sa/api/ncc/time-contracts/after-current-summaries?nccAdgroupIds=" +
    encodeURIComponent(adgroupIds.join(","));
  const raw = await authFetch<ContractsResponse[]>(url, undefined, customerId);
  const out: MultiAccountSnapshot["contracts"] = [];
  for (const row of raw ?? []) {
    const adgroupId = row.nccAdgroupId;
    const campaignId = adgroupToCampaign?.get(adgroupId) ?? "";
    // current + next 모두 후보 — 둘 다 있으면 두 row로 push (캠페인 단위 max 계산에 모두 반영).
    // 빈 endDate는 skip — 계약 없음/만료/예약 안 됨.
    const candidates: Array<{ block: TimeContractBlock; phase: "current" | "next" }> = [];
    if (row.currentTimeContract?.contractEndDt) {
      candidates.push({ block: row.currentTimeContract, phase: "current" });
    }
    if (row.nextTimeContract?.contractEndDt) {
      candidates.push({ block: row.nextTimeContract, phase: "next" });
    }
    for (const { block: c, phase } of candidates) {
      out.push({
        product: c.contractName ?? "",
        campaignTp: c.campaignTp ?? "",
        endDate: c.contractEndDt!,
        status: c.contractStatus ?? "",
        nccCampaignId: campaignId,
        phase,
      });
    }
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
  platformsArg?: PlatformFilter,
): Promise<AccountSnapshotPayload> {
  // 옵션의 광고 유형 필터 — 검색광고(SA)/디스플레이(GFA) 선택 수집. 둘 다 켜지면 합산.
  // 배치 호출(refreshAll 등)에서 인자로 주입하면 계정마다 storage 중복 조회를 skip.
  const platforms = platformsArg ?? (await loadPlatformFilter());

  // 비즈머니는 플랫폼 무관 — 항상 수집.
  const bizMoneyP = fetchBizMoney(adAccountNo);

  // 디스플레이(GFA) — 켜져 있을 때만. SA와 독립이라 병렬 시작.
  const gfaP: Promise<YesterdayMetrics | null> = platforms.da
    ? fetchGfaYesterdayStats(adAccountNo, customerId, yesterdayISODate).catch((e) => {
        console.warn("[dv-ads/multi-account] GFA stats 실패", e);
        return null;
      })
    : Promise.resolve(null);

  // 검색광고(SA) — 켜져 있을 때만. 캠페인 리스트 → 어제 stats + 브랜드검색 계약.
  let saYesterday: YesterdayMetrics | null = null;
  let contracts: MultiAccountSnapshot["contracts"] = [];
  if (platforms.sa) {
    const campaignRows = await fetchCampaignRows(customerId).catch((e) => {
      console.warn("[dv-ads/multi-account] campaigns 실패", e);
      return [] as NccCampaignRow[];
    });
    const allCampaignIds = campaignRows
      .map((c) => c.nccCampaignId)
      .filter((id): id is string => !!id);
    const brandCampaignIds = campaignRows
      .filter((c) => BRAND_LIKE_TYPES.includes(c.campaignTp as (typeof CAMPAIGN_TYPES)[number]))
      .map((c) => c.nccCampaignId)
      .filter((id): id is string => !!id);

    const [sa, brandAdgroups] = await Promise.all([
      fetchYesterdayStats(allCampaignIds, yesterdayISODate, customerId).catch((e) => {
        console.warn("[dv-ads/multi-account] SA stats 실패", e);
        return null;
      }),
      fetchBrandAdgroupIds(brandCampaignIds, customerId).catch((e) => {
        console.warn("[dv-ads/multi-account] brand adgroups 실패", e);
        return { adgroupIds: [] as string[], adgroupToCampaign: new Map<string, string>() };
      }),
    ]);
    saYesterday = sa;
    contracts = await fetchContracts(
      brandAdgroups.adgroupIds,
      customerId,
      brandAdgroups.adgroupToCampaign,
    ).catch((e) => {
      console.warn("[dv-ads/multi-account] contracts 실패", e);
      return [] as MultiAccountSnapshot["contracts"];
    });
  }

  const [bizMoney, gfaYesterday] = await Promise.all([bizMoneyP, gfaP]);
  const yesterday = combineYesterday(saYesterday, gfaYesterday);

  return { bizMoney, yesterday, contracts };
}

/**
 * 브랜드검색 캠페인들의 광고그룹 ID + 광고그룹→캠페인 매핑 동시 반환.
 * 매핑은 contracts 응답을 캠페인 단위로 그룹핑하기 위함.
 */
async function fetchBrandAdgroupIds(
  brandCampaignIds: string[],
  customerId: number,
): Promise<{ adgroupIds: string[]; adgroupToCampaign: Map<string, string> }> {
  if (brandCampaignIds.length === 0) return { adgroupIds: [], adgroupToCampaign: new Map() };
  const results = await Promise.allSettled(
    brandCampaignIds.map(async (cmpId) => ({
      cmpId,
      rows: await fetchAdgroupRowsByCampaign(cmpId, customerId),
    })),
  );
  const adgroupIds: string[] = [];
  const adgroupToCampaign = new Map<string, string>();
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const row of r.value.rows) {
        if (row?.nccAdgroupId) {
          adgroupIds.push(row.nccAdgroupId);
          adgroupToCampaign.set(row.nccAdgroupId, r.value.cmpId);
        }
      }
    }
  }
  return { adgroupIds, adgroupToCampaign };
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
