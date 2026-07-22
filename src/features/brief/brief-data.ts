/**
 * F-Brief 데이터 — F-Report의 collectReportData를 재사용하고 엑셀만 건너뛴다.
 *
 * 요약 문구(인사/3지표/전기 대비)는 **AI를 거치지 않는다** — 코드가 문자열로 조립한다.
 * 물어본 적이 없으므로 AI가 이 숫자를 틀릴 확률은 0이다(설계 §3 1겹).
 */

import { collectReportData, buildProductAdRows, type ReportData, type ReportTarget } from "@/features/report/report-build";
import { rangeText, previousRange, ymdToIso, type DateRange } from "@/features/report/report-period";
import {
  fetchAdvancedReport, colIndex, rowMetrics, parseEntity, CAMPAIGN_TP_CODE, ZERO_METRICS,
  type ReportMetrics, type AdvReportResult,
} from "@/features/report/report-data";
import { type NamedMetrics } from "@/features/report/report-fill";
import { type BriefTableSpec, type BriefProductDelta, type BriefGroupData, type BriefAdRow } from "./brief-rules";
import { roasPct } from "./brief-rules";

export interface BriefData extends ReportData {
  range: DateRange;
  advertiserName: string;
  /** 현재 기간에 존재하는 상품의 현재/전기 지표. 이름은 현재 기준으로만 얻을 수 있다. */
  products: BriefProductDelta[];
  /** 파워링크 소재별 성과(그룹 정보 포함, label=제목). 실패 시 빈 배열 — 소재 후보만 생략. */
  plAds: BriefAdRow[];
  /** 광고그룹별 차원 성과(지면/성별/연령/기기/시간대/지역/일자). 실패한 차원만 비어 있다. */
  groups: BriefGroupData[];
  /** "캠페인 > 그룹" 라벨 → id. 키워드 계열 후보의 scope id 보강 + 바로가기 재료. */
  groupIds: Map<string, { campaignId: string; adgroupId: string }>;
}

// 세그먼트 attribute 정찰 메모(2026-07-17): `pcMblTp`(라벨 "PC"/"모바일"), `hh24`("00시~01시"
// 24구간), `regnNo`(시도명), `x-ad-customer-id` cross-account 정상.
/** BriefGroupData의 차원 배열 필드 이름 ↔ advanced-report attribute 매핑. */
const GROUP_DIMS = [
  ["byPlacement", "mediaNm"],
  ["byGender", "criterionGenderNm"],
  ["byAge", "criterionAgeTpNm"],
  ["byDevice", "pcMblTp"],
  ["byHour", "hh24"],
  ["byRegion", "regnNo"],
  ["byDay", "ymd"],
] as const;
type GroupDimField = (typeof GROUP_DIMS)[number][0];

/**
 * 광고그룹별 차원 성과 수집 — 캠페인/그룹 차원을 함께 분해해 그룹별 지면/성별/연령/기기/
 * 시간대/지역/일자를 얻는다. 계정 합산은 그룹 특성이 섞여 부정확해 전 차원을 이 단위로만
 * 판정한다(2026-07-20 캠페인>그룹 개편). entity 셀은 "[이름](id)" — 이름을 못 얻은 그룹은
 * 광고주에게 id를 보여줄 수 없어 제외(상품 후보와 동일 규칙).
 * 차원 하나가 실패하면 그 차원 후보만 생략하고 나머지는 계속.
 */
async function fetchGroupDims(customerId: number, range: DateRange): Promise<BriefGroupData[]> {
  const byGroup = new Map<string, BriefGroupData>();
  await Promise.all(GROUP_DIMS.map(async ([field, attr]) => {
    let res;
    try {
      res = await fetchAdvancedReport({
        attributes: ["nccCampaignId", "nccAdgroupId", attr],
        range,
        customerId,
        maxRows: 30000,
        filters: [{ type: "bound", field: "impCnt", operator: "gt", value: 0 }],
      });
    } catch (e) {
      console.warn(`[dv-ads/brief] 그룹별 ${attr} 조회 실패 — 해당 차원 후보만 생략`, e);
      return;
    }
    // maxRows에 걸려 잘린 차원은 통째로 버린다 — 부분 데이터로 skew를 계산하면
    // 뒤쪽 그룹 이슈가 조용히 사라지거나 반쪽 세그먼트로 오판한다(코덱스 리뷰 P1).
    if (res.rows.length < res.totalResults) {
      console.warn(`[dv-ads/brief] 그룹별 ${attr} 잘림(${res.rows.length}/${res.totalResults}행) — 해당 차원 후보 생략`);
      return;
    }
    const idx = colIndex(res.head);
    for (const r of res.rows) {
      const camp = parseEntity(r[idx["nccCampaignId"]] ?? "");
      const grp = parseEntity(r[idx["nccAdgroupId"]] ?? "");
      const rawLabel = r[idx[attr]] ?? "";
      const label = field === "byDay" ? ymdToIso(rawLabel) : rawLabel;
      if (!label || !camp.id || !grp.id || !camp.name || !grp.name) continue;
      let g = byGroup.get(grp.id);
      if (!g) {
        g = { campaign: camp.name, group: grp.name, nccCampaignId: camp.id, nccAdgroupId: grp.id };
        byGroup.set(grp.id, g);
      }
      const arr = (g[field as GroupDimField] ??= []);
      arr.push({ label, metrics: rowMetrics(r, idx) });
    }
  }));
  return [...byGroup.values()];
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

interface RawTextAd { nccAdId?: string; ad?: { headline?: string } }

/**
 * 파워링크 소재별 성과 + 제목(headline) 조인 (2026-07-17 라이브 정찰: TEXT_45의 `ad.headline`,
 * `ncc/ads?ids=` 벌크 조회 동작 확인). label은 headline — 제목 못 얻은 소재는 광고주에게
 * `nad-...`를 보여줄 수 없어 제외한다(상품 후보와 동일 규칙).
 */
async function fetchPlAds(customerId: number, range: DateRange): Promise<BriefAdRow[]> {
  const res = await fetchAdvancedReport({
    attributes: ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "nccAdId"],
    range,
    customerId,
    maxRows: 30000,
    filters: [
      { type: "in", field: "nccCampaignTp", values: [CAMPAIGN_TP_CODE.파워링크] },
      { type: "bound", field: "impCnt", operator: "gt", value: 0 },
    ],
  });
  // 그룹 정보를 유지해야 해서(캠페인>그룹 개편) buildProductAdRows(소재ID로 접음)를 안 쓰고
  // 직접 파싱한다. 이름 못 얻은 캠페인/그룹/소재는 제외(광고주에게 id 노출 불가).
  const idx = colIndex(res.head);
  interface RawAdRow { campaign: string; group: string; campaignId: string; adgroupId: string; adId: string; metrics: ReportMetrics }
  const adRows: RawAdRow[] = [];
  for (const r of res.rows) {
    // 서버 필터가 조용히 실패할 수 있어 로컬 캠페인 타입 가드 유지(buildProductAdRows와 동일 규칙).
    if ((r[idx["nccCampaignTp"]] ?? "").trim() !== "파워링크") continue;
    const camp = parseEntity(r[idx["nccCampaignId"]] ?? "");
    const grp = parseEntity(r[idx["nccAdgroupId"]] ?? "");
    const ad = parseEntity(r[idx["nccAdId"]] ?? "");
    const adId = ad.id || ad.name; // 소재 셀은 이름 없이 id만 올 수 있다
    if (!camp.id || !grp.id || !camp.name || !grp.name || !adId) continue;
    adRows.push({ campaign: camp.name, group: grp.name, campaignId: camp.id, adgroupId: grp.id, adId, metrics: rowMetrics(r, idx) });
  }
  if (adRows.length === 0) return [];

  const { authFetch } = await import("@/features/multi-account/multi-account-data");
  const ids = [...new Set(adRows.map((r) => r.adId))];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 80) chunks.push(ids.slice(i, i + 80));
  const titleById = new Map<string, string>();
  await pool(chunks, 4, async (chunk) => {
    const ads = await authFetch<RawTextAd[]>(
      `/apis/sa/api/ncc/ads?ids=${chunk.map(encodeURIComponent).join(",")}`,
      undefined,
      customerId,
    ).catch(() => [] as RawTextAd[]);
    for (const a of Array.isArray(ads) ? ads : []) {
      const title = a.ad?.headline?.trim();
      if (a.nccAdId && title) titleById.set(a.nccAdId, title);
    }
  });
  return adRows
    .map((r) => ({
      campaign: r.campaign, group: r.group,
      nccCampaignId: r.campaignId, nccAdgroupId: r.adgroupId,
      label: titleById.get(r.adId) ?? "",
      metrics: r.metrics,
    }))
    .filter((r) => r.label !== "");
}

export async function collectBriefData(target: ReportTarget, range: DateRange): Promise<BriefData> {
  const cid = target.masterCustomerId;
  if (cid == null) throw new Error("계정 정보를 불러올 수 없어요");
  // 담당자/작성일은 엑셀 표지 전용이라 문구엔 안 쓰인다. 빈 값으로 넘긴다.
  // 전기 상품은 F-Brief만 필요하다 — collectReportData를 건드리지 않고 여기서 1회 더 부른다.
  // 두 수집을 동시에 출발시켜 왕복을 더하지 않는다. 실패해도 상품 후보만 생략.
  const [data, prevAdRows, groups, plAds] = await Promise.all([
    collectReportData(target, range, { authorName: "", createdDate: "" }),
    fetchPrevProducts(cid, previousRange(range)).catch((e) => {
      console.warn("[dv-ads/brief] 전기 상품 조회 실패 — 상품 후보만 생략", e);
      return [] as NamedMetrics[];
    }),
    // 차원별 실패는 fetchGroupDims 내부에서 개별 처리 — 전체 실패만 여기서 잡는다.
    fetchGroupDims(cid, range).catch((e) => {
      console.warn("[dv-ads/brief] 그룹별 차원 조회 실패 — 세그먼트 후보 생략", e);
      return [] as BriefGroupData[];
    }),
    fetchPlAds(cid, range).catch((e) => {
      console.warn("[dv-ads/brief] 파워링크 소재 조회 실패 — 소재 후보만 생략", e);
      return [] as BriefAdRow[];
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

  // "캠페인 > 그룹" 라벨 → id 맵 — 키워드 계열 후보의 scope id 보강(추가 호출 없음).
  const groupIds = new Map<string, { campaignId: string; adgroupId: string }>();
  for (const g of groups) {
    groupIds.set(`${g.campaign} > ${g.group}`, { campaignId: g.nccCampaignId, adgroupId: g.nccAdgroupId });
  }

  return { ...data, range, advertiserName: target.name, products, groups, groupIds, plAds };
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
 * 요약 블록 — 기간/범위 + 3지표 + 전기 대비. 인사는 AI(greeting)가 붙인다.
 * 보고 로그 5건이 전부 이 형태다. AI 미경유(설계 §3 1겹).
 */
export function buildSummaryText(data: BriefData): string {
  const cur = data.model.totalCurrent;
  const prev = data.model.totalPrev;
  const scope = data.model.hasDisplay ? "검색광고와 GFA" : "검색광고";
  const curRoas = roasPct(cur);
  const prevRoas = roasPct(prev);

  const lines = [
    `지난 ${dayCount(data.range)}일 동안 진행된 ${scope} 성과 전달드립니다.`,
    "",
    `▶광고비 : ${won(cur.cost)}`,
    `▶전환매출액 : ${won(cur.revenue)}`,
    `▶광고수익률 : ${curRoas.toFixed(2)}%`,
  ];

  // 전기 데이터가 전무하면 비교 문장을 만들지 않는다(신규 계정 등).
  if (prev.cost > 0) {
    const diff = cur.revenue - prev.revenue;
    const dir = diff >= 0 ? "증가" : "감소";
    const roasDir = curRoas >= prevRoas ? "상승" : "하락";
    // 매출과 수익률이 같은 방향이면 "~하였으며, 또한", 엇갈리면 "~하였으나"로 잇는다.
    const sameDir = (diff >= 0) === (curRoas >= prevRoas);
    const joiner = sameDir ? "하였으며, 수익률 또한" : "하였으나, 수익률은";
    lines.push(
      "",
      `지난 동기간 대비 매출은 ${approxWon(diff)} ${dir}${joiner} ` +
        `${prevRoas.toFixed(0)}% > ${curRoas.toFixed(0)}%로 ${roasDir}하는 추세를 보였습니다.`,
    );
  }

  return lines.join("\n");
}

/** 요약 표 — 문구 ①에 딸리는 사진. */
export function buildSummarySpec(data: BriefData): BriefTableSpec {
  // "설정 기간/이전 기간"은 리포트 용어 — 광고주 표에는 날짜로(예: "07.13~07.19(7일)").
  const rangeLabel = (r: DateRange): string => `${rangeText(r)}(${dayCount(r)}일)`;
  const rows = ([
    [rangeLabel(data.range), data.model.totalCurrent],
    [rangeLabel(previousRange(data.range)), data.model.totalPrev],
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
    // 계정명은 빼고 날짜만(2026-07-22 사용자 요구) — 광고주에게 보내는 표라 계정명이 군더더기다.
    title: rangeText(data.range),
    columns: ["구분", "노출", "클릭", "총비용", "구매완료", "매출액", "ROAS"],
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
