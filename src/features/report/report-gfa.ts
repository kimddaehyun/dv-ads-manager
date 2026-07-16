// F-Report 디스플레이(GFA) 데이터 수집.
//
// 종합용(이 파일): 디스플레이 합계 + 캠페인목적(유형)별 합계.
// 분해용(일자/지면/성별/연령)은 별도 비동기 다운로드 보고서 파이프라인 — report-gfa-detail.ts(2단계).
//
// ★ reportPerformance의 CAMPAIGN_OBJECTIVE 필터는 서버가 무시하고 계정 전체를 돌려줘서 쓸 수 없다
// (2026-06-24 라이브 확인). 대신 F-MultiAccount와 동일하게:
//   1) dashboard campaigns/search(filter DA) → 캠페인별 type + 노출/클릭/비용 + campaignId
//   2) gfa campaignStats → 캠페인별 구매완료수/매출 (purchaseConvCount/purchaseConvSalesKRW)
// 를 campaignId로 합쳐 유형(type)별로 그룹핑한다. 합계는 전 캠페인 합 → 디스플레이행 == 디스플레이소계 보장.
// GFA는 직접/간접 전환 split이 없어 directConv/indirectConv=0.

import { authFetch } from "@/features/multi-account/multi-account-data";
import { addMetrics, ZERO_METRICS, type ReportMetrics } from "./report-data";
import type { DateRange } from "./report-period";

interface DashboardSearchResponse {
  results?: Array<{
    campaign?: { campaignId?: string; type?: string; name?: string };
    metrics?: { impressions?: number; clicks?: number; grossCostMicros?: number };
  }>;
}
type CampaignStatsResponse = Record<
  string,
  { conversion?: { purchaseConvCount?: number; purchaseConvSalesKRW?: number } } | null
>;

// GFA 캠페인 type 코드(dashboard, GFA_ prefix) → 양식 디스플레이 유형 라벨
const GFA_TYPE_LABEL: Record<string, string> = {
  GFA_CONVERSION: "웹사이트전환",
  GFA_INSTALL_APP: "앱전환",
  GFA_WEB_SITE_TRAFFIC: "인지도 및 트래픽",
  GFA_WATCH_VIDEO: "동영상 조회",
  GFA_PMAX: "애드부스트",
  GFA_CATALOG: "카탈로그",
  GFA_SHOPPING: "쇼핑프로모션",
  GFA_LEAD: "참여 유도",
};
// 양식 종합 섹션3 디스플레이 유형 표시 순서
export const DISPLAY_TYPE_ORDER = [
  "웹사이트전환", "앱전환", "인지도 및 트래픽", "동영상 조회",
  "애드부스트", "카탈로그", "쇼핑프로모션", "참여 유도",
];
function typeLabel(code: string): string {
  return GFA_TYPE_LABEL[code] ?? code.replace(/^GFA_/, "");
}

const CONV_CHUNK = 100;

export interface DisplayType {
  label: string;
  metrics: ReportMetrics;
}
// 디스플레이 시트(sheet7) 캠페인별 표 — 유형(label)별 캠페인 행. CampaignTypeGroup과 동형.
export interface DisplayCampaignGroup {
  type: string; // 양식 디스플레이 유형 라벨 (웹사이트전환 등)
  rows: { group: string; metrics: ReportMetrics }[]; // group = 캠페인명
}
export interface GfaData {
  total: ReportMetrics;
  byType: DisplayType[];
  byCampaign: DisplayCampaignGroup[]; // sheet7 캠페인별 표
}

// 디스플레이 합계 + 유형별 (단일 소스 = dashboard + campaignStats).
export async function fetchGfaData(
  adAccountNo: number, customerId: number, range: DateRange,
): Promise<GfaData> {
  // 1) dashboard — DA 캠페인의 노출/클릭/비용 + type + campaignId
  const body = JSON.stringify({
    startDate: range.since, endDate: range.until,
    filter: "campaign.adPlatform:in:DA",
    orderBy: "campaign.status:asc",
    pageNumber: 1, pageSize: 1000,
  });
  const dash = await authFetch<DashboardSearchResponse>(
    `/apis/dashboard/v1/adAccounts/${adAccountNo}/campaigns/search`,
    { method: "POST", body },
    customerId,
  );
  // 캠페인별 imp/clk/cost + type + name 집계
  const perCampaign = new Map<string, { type: string; name: string; m: ReportMetrics }>();
  for (const row of dash.results ?? []) {
    const id = row.campaign?.campaignId;
    if (!id) continue;
    const me = row.metrics ?? {};
    perCampaign.set(id, {
      type: row.campaign?.type ?? "",
      name: row.campaign?.name ?? "",
      m: {
        impressions: Number(me.impressions ?? 0),
        clicks: Number(me.clicks ?? 0),
        cost: Number(me.grossCostMicros ?? 0) / 1_000_000,
        purchaseConv: 0, revenue: 0, directConv: 0, indirectConv: 0,
      },
    });
  }

  // 2) campaignStats — 구매완료수/매출 (campaignId 배치, 병렬). URL-aware라 헤더 불필요.
  const ids = [...perCampaign.keys()];
  const chunks: Promise<CampaignStatsResponse>[] = [];
  for (let i = 0; i < ids.length; i += CONV_CHUNK) {
    const chunk = ids.slice(i, i + CONV_CHUNK);
    const url =
      `/apis/gfa/v1/adAccounts/${adAccountNo}/stats/campaignStats` +
      `?campaignNoList=${encodeURIComponent(chunk.join(","))}` +
      `&startDate=${range.since}&endDate=${range.until}`;
    chunks.push(authFetch<CampaignStatsResponse>(url).catch(() => ({}) as CampaignStatsResponse));
  }
  for (const stats of await Promise.all(chunks)) {
    for (const [id, v] of Object.entries(stats)) {
      const conv = v?.conversion;
      const c = perCampaign.get(id);
      if (conv && c) {
        c.m.purchaseConv += Number(conv.purchaseConvCount ?? 0);
        c.m.revenue += Number(conv.purchaseConvSalesKRW ?? 0);
      }
    }
  }

  // 3) 유형별 그룹핑 + 합계 + 캠페인별 행
  const byLabel = new Map<string, ReportMetrics>();
  const campaignsByLabel = new Map<string, { group: string; metrics: ReportMetrics }[]>();
  let total = ZERO_METRICS;
  for (const { type, name, m } of perCampaign.values()) {
    const label = typeLabel(type);
    byLabel.set(label, addMetrics(byLabel.get(label) ?? ZERO_METRICS, m));
    total = addMetrics(total, m);
    if (m.impressions > 0) {
      const arr = campaignsByLabel.get(label) ?? [];
      arr.push({ group: name, metrics: m });
      campaignsByLabel.set(label, arr);
    }
  }
  const byType = DISPLAY_TYPE_ORDER
    .filter((l) => (byLabel.get(l)?.impressions ?? 0) > 0)
    .map((label) => ({ label, metrics: byLabel.get(label)! }));
  // 캠페인별: 유형 순서(DISPLAY_TYPE_ORDER, 미지정 유형은 뒤로) + 유형 내 총비용순
  const orderedLabels = [
    ...DISPLAY_TYPE_ORDER.filter((l) => campaignsByLabel.has(l)),
    ...[...campaignsByLabel.keys()].filter((l) => !DISPLAY_TYPE_ORDER.includes(l)),
  ];
  const byCampaign: DisplayCampaignGroup[] = orderedLabels.map((label) => ({
    type: label,
    rows: campaignsByLabel.get(label)!.sort((a, b) => b.metrics.cost - a.metrics.cost),
  }));

  return { total, byType, byCampaign };
}

// 합계만 필요할 때(전주 등). byType는 버림.
export async function fetchGfaTotal(
  adAccountNo: number, customerId: number, range: DateRange,
): Promise<ReportMetrics> {
  return (await fetchGfaData(adAccountNo, customerId, range)).total;
}
