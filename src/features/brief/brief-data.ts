/**
 * F-Brief 데이터 — F-Report의 collectReportData를 재사용하고 엑셀만 건너뛴다.
 *
 * 요약 문구(인사/3지표/전기 대비)는 **AI를 거치지 않는다** — 코드가 문자열로 조립한다.
 * 물어본 적이 없으므로 AI가 이 숫자를 틀릴 확률은 0이다(설계 §3 1겹).
 */

import { collectReportData, buildProductAdRows, type ReportData, type ReportTarget } from "@/features/report/report-build";
import { rangeText, previousRange, type DateRange } from "@/features/report/report-period";
import {
  fetchAdvancedReport, colIndex, rowMetrics, CAMPAIGN_TP_CODE, ZERO_METRICS,
  type ReportMetrics, type AdvReportResult,
} from "@/features/report/report-data";
import { type NamedMetrics } from "@/features/report/report-fill";
import { type BriefTableSpec, type BriefProductDelta } from "./brief-rules";
import { roasPct } from "./brief-rules";

export interface BriefData extends ReportData {
  range: DateRange;
  advertiserName: string;
  /** 현재 기간에 존재하는 상품의 현재/전기 지표. 이름은 현재 기준으로만 얻을 수 있다. */
  products: BriefProductDelta[];
  /** 기기(PC/모바일)별 검색광고 성과. 실패 시 빈 배열 — 기기 후보만 생략. */
  byDevice: NamedMetrics[];
}

/**
 * 기기별 성과 — advanced-report의 `pcMblTp` 차원 (2026-07-17 라이브 정찰: 라벨 "PC"/"모바일",
 * `x-ad-customer-id` cross-account 정상). F-Report 엑셀엔 안 쓰여 F-Brief 전용으로 여기서 수집.
 */
async function fetchByDevice(customerId: number, range: DateRange): Promise<NamedMetrics[]> {
  const res = await fetchAdvancedReport({ attributes: ["pcMblTp"], range, customerId });
  const idx = colIndex(res.head);
  return res.rows.map((r) => ({ label: r[idx.pcMblTp] ?? "", metrics: rowMetrics(r, idx) }))
    .filter((n) => n.label !== "");
}

/**
 * 전기 쇼핑검색 상품(소재ID 기준) 성과 — collectReportData의 productReportP와 동일 호출을
 * 전기 range로 1회 더. 필터도 동일해야 한다(없으면 앞쪽 유형이 상한을 채워 실종되는 그 사고).
 */
async function fetchPrevProducts(customerId: number, range: DateRange): Promise<NamedMetrics[]> {
  const res: AdvReportResult = await fetchAdvancedReport({
    attributes: ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "nccAdId"],
    range,
    customerId,
    maxRows: 30000,
    filters: [
      { type: "in", field: "nccCampaignTp", values: [CAMPAIGN_TP_CODE.쇼핑검색] },
      { type: "bound", field: "salesAmt", operator: "gt", value: 0 },
      { type: "bound", field: "impCnt", operator: "gt", value: 0 },
    ],
  });
  return buildProductAdRows(res, "쇼핑검색");
}

export async function collectBriefData(target: ReportTarget, range: DateRange): Promise<BriefData> {
  const cid = target.masterCustomerId;
  if (cid == null) throw new Error("계정 정보를 불러올 수 없어요");
  // 담당자/작성일은 엑셀 표지 전용이라 문구엔 안 쓰인다. 빈 값으로 넘긴다.
  // 전기 상품은 F-Brief만 필요하다 — collectReportData를 건드리지 않고 여기서 1회 더 부른다.
  // 두 수집을 동시에 출발시켜 왕복을 더하지 않는다. 실패해도 상품 후보만 생략.
  const [data, prevAdRows, byDevice] = await Promise.all([
    collectReportData(target, range, { authorName: "", createdDate: "" }),
    fetchPrevProducts(cid, previousRange(range)).catch((e) => {
      console.warn("[dv-ads/brief] 전기 상품 조회 실패 — 상품 후보만 생략", e);
      return [] as NamedMetrics[];
    }),
    fetchByDevice(cid, range).catch((e) => {
      console.warn("[dv-ads/brief] 기기별 조회 실패 — 기기 후보만 생략", e);
      return [] as NamedMetrics[];
    }),
  ]);

  // 소재ID로 매칭. shProducts(ProductRow)는 이름 조인 후라 ID가 없어 못 쓴다.
  const prevById = new Map(prevAdRows.map((r) => [r.label, r.metrics]));
  const products: BriefProductDelta[] = data.shProductAdRows
    .map((cur) => ({
      // 이름을 못 얻은 소재는 ID를 광고주에게 보여줄 수 없어 label을 비워 걸러낸다.
      label: data.shProductInfo.get(cur.label)?.title ?? "",
      cur: cur.metrics,
      prev: prevById.get(cur.label) ?? ZERO_METRICS,
    }))
    .filter((p) => p.label !== "");

  return { ...data, range, advertiserName: target.name, products, byDevice };
}

/** 기간 일수. "지난 30일 동안" 같은 표현에 쓴다. */
function dayCount(range: DateRange): number {
  const a = new Date(range.since).getTime();
  const b = new Date(range.until).getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

function won(n: number): string {
  return `${Math.round(n).toLocaleString()}원`;
}

/** 억/만 단위 반올림 — "약 34만 원 감소" 같은 표현용. 보고 로그의 관행. */
function approxWon(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `약 ${(abs / 100_000_000).toFixed(1)}억 원`;
  if (abs >= 10_000) return `약 ${Math.round(abs / 10_000).toLocaleString()}만 원`;
  return `약 ${Math.round(abs).toLocaleString()}원`;
}

/**
 * 요약 블록 — 인사 + 기간/범위 + 3지표 + 전기 대비.
 * 보고 로그 5건이 전부 이 형태다. AI 미경유(설계 §3 1겹).
 */
export function buildSummaryText(data: BriefData): string {
  const cur = data.model.totalCurrent;
  const prev = data.model.totalPrev;
  const scope = data.model.hasDisplay ? "검색광고, GFA 포함" : "검색광고";
  const curRoas = roasPct(cur);
  const prevRoas = roasPct(prev);

  const lines = [
    "안녕하세요:)",
    "",
    `지난 ${dayCount(data.range)}일 동안 ${scope}`,
    "",
    `▶광고비 : ${won(cur.cost)}`,
    `▶전환매출액 : ${won(cur.revenue)}`,
    `▶광고수익률 : ${curRoas.toFixed(2)}%로 집계되었습니다.`,
  ];

  // 전기 데이터가 전무하면 비교 문장을 만들지 않는다(신규 계정 등).
  if (prev.cost > 0) {
    const diff = cur.revenue - prev.revenue;
    const dir = diff >= 0 ? "증가" : "감소";
    const roasDir = curRoas >= prevRoas ? "상승" : "하락";
    lines.push(
      "",
      `지난 동기간 대비 매출은 ${approxWon(diff)} ${dir}하였으며, 수익률 또한 ` +
        `${prevRoas.toFixed(0)}% > ${curRoas.toFixed(0)}%로 ${roasDir}하는 추세를 보였습니다.`,
    );
  }

  return lines.join("\n");
}

/** 요약 표 — 문구 ①에 딸리는 사진. */
export function buildSummarySpec(data: BriefData): BriefTableSpec {
  const rows = ([
    ["설정 기간", data.model.totalCurrent],
    ["이전 기간", data.model.totalPrev],
  ] as Array<[string, ReportMetrics]>).map(([label, m]) => ({
    cells: [
      label,
      m.impressions.toLocaleString(),
      m.clicks.toLocaleString(),
      won(m.cost),
      String(m.purchaseConv),
      won(m.revenue),
      `${roasPct(m).toFixed(0)}%`,
    ],
  }));
  return {
    title: `${data.advertiserName} · ${rangeText(data.range)}`,
    columns: ["구분", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
    rows,
  };
}

// Task 10의 brief.ts가 totals를 만들 때 같은 형식을 써야 검산이 안 어긋난다(두 곳 포맷 금지).
export { won, approxWon };

// ── 순위 보강용 입찰가 맵 (Task 7) ─────────────────────────────────────
//
// 리포트의 키워드 행은 advanced-report의 **검색어**(expKeyword)라 입찰가가 없다.
// estimateRank(userBid, ...)에 넣을 실효 입찰가는 ncc 등록 키워드에서 가져와
// **정규화된 키워드 텍스트**로 매칭한다. 검색어가 등록 키워드와 다르면(확장 매칭 등)
// 맵에 없어 rank가 비고, 후보에서 자연히 빠진다 — 등록 키워드의 순위만 말할 수 있다.

interface RawCampaign { nccCampaignId?: string }
interface RawAdgroup { nccAdgroupId?: string; bidAmt?: number }
interface RawKeyword { keyword?: string; bidAmt?: number; useGroupBidAmt?: boolean }

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** setup-data.ts의 pool과 동일 발상 — 동시성 4 worker. */
async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

/**
 * 파워링크(WEB_SITE) 등록 키워드의 실효 입찰가 맵. key = normalizeKeyword(키워드).
 * useGroupBidAmt면 그룹 bidAmt 상속(F-Setup과 동일 규칙). 쇼핑검색은 키워드 입찰이 없어 제외.
 * 같은 키워드가 여러 그룹에 있으면 **높은 입찰가**를 쓴다 — 순위는 가장 잘 노출되는 그룹 기준.
 */
export async function fetchPowerlinkBidMap(customerId: number): Promise<Map<string, number>> {
  const { authFetch } = await import("@/features/multi-account/multi-account-data");
  const { normalizeKeyword } = await import("@/shared/storage-keys");

  const campaigns = await authFetch<RawCampaign[]>(
    "/apis/sa/api/ncc/campaigns?recordSize=1001&campaignType=WEB_SITE",
    undefined,
    customerId,
  ).catch(() => [] as RawCampaign[]);
  const campIds = (Array.isArray(campaigns) ? campaigns : [])
    .map((c) => c.nccCampaignId).filter((x): x is string => !!x);

  const groupLists = await pool(campIds, 4, (cid) =>
    authFetch<RawAdgroup[]>(
      `/apis/sa/api/ncc/adgroups?nccCampaignId=${encodeURIComponent(cid)}&recordSize=1001`,
      undefined,
      customerId,
    ).catch(() => [] as RawAdgroup[]),
  );
  const groups = groupLists.flat().filter((g) => g?.nccAdgroupId);

  const bidMap = new Map<string, number>();
  await pool(groups, 4, async (g) => {
    const keywords = await authFetch<RawKeyword[]>(
      `/apis/sa/api/ncc/keywords?nccAdgroupId=${encodeURIComponent(g.nccAdgroupId!)}&recordSize=1001`,
      undefined,
      customerId,
    ).catch(() => [] as RawKeyword[]);
    const groupBid = numOr0(g.bidAmt);
    for (const k of Array.isArray(keywords) ? keywords : []) {
      const kw = k.keyword?.trim();
      if (!kw) continue;
      const bid = k.useGroupBidAmt ? groupBid : numOr0(k.bidAmt);
      if (bid <= 0) continue;
      const key = normalizeKeyword(kw);
      const prev = bidMap.get(key);
      if (prev == null || bid > prev) bidMap.set(key, bid);
    }
  });
  return bidMap;
}
