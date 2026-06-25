// F-Report orchestration — 실데이터(advanced-report) 수집 → ReportModel 조립 → 양식 주입 → xlsx bytes.
//
// 검색광고(SA)는 advanced-report 동기 수집으로 완전 연결(메모리 project_f_report_endpoints).
// 디스플레이(GFA)는 종합(합계+유형별)까지 연결(report-gfa.ts) - 분해(일자/지면/성별/연령)
// 디스플레이_상세 시트는 비동기 다운로드 보고서 파이프라인 작업 후 연결 예정, 현재는 시트 제거.
//
// 라벨 매핑(캠페인유형/지면/연령/성별)은 best-effort. 실데이터로 검증·보정 필요(특히 지면 7버킷).

import {
  openXlsx, buildXlsx, forceRecalc, removeSheets, removeSheetDrawing, removeCalcChain,
  replaceChartColor,
  readText, writeText, hideRowRange, type ZipFiles,
} from "./report-excel";
import {
  fillFixedSheets, expandDailyRows, SEARCH_DAILY_EXPAND, DISPLAY_DAILY_EXPAND,
  type ReportModel, type NamedMetrics,
} from "./report-fill";
import {
  renderKeywordSheet, renderCampaignSheet, renderSummaryTypes, renderDetailPlacement,
  DISPLAY_PLACEMENT, DISPLAY_CAMPAIGN_LAYOUT,
  type KeywordGroup, type CampaignTypeGroup, type SummaryType,
} from "./report-variable";
import { authFetch, fetchAdgroupRowsByCampaign } from "./multi-account-data";
import {
  fetchAdvancedReport, colIndex, parseEntity, rowMetrics, addMetrics,
  ZERO_METRICS, type ReportMetrics,
} from "./report-data";
import {
  rangeForPreset, previousRange, eachDay, dayLabel, ymdToIso, proratedBrand,
  type DateRange, type ReportPreset, type ProrationContract,
} from "./report-period";
import { fetchGfaTotal, fetchGfaData, type GfaData } from "./report-gfa";
import { fetchGfaDetail } from "./report-gfa-detail";

export interface ReportTarget {
  adAccountNo: number;
  masterCustomerId?: number;
  name: string;
}

export interface ReportMeta {
  authorName: string;
  createdDate: string; // "YYYY.MM.DD"
}

// ── 라벨 매핑 (advanced-report 값 → 양식 라벨) ──
// 캠페인유형: nccCampaignTp. 실데이터 raw 값(2026-06-24 라이브 확인):
// "파워링크" / "쇼핑검색" / "브랜드검색/신제품검색" / "플레이스" / "파워컨텐츠".
// 브랜드+신제품은 API가 이미 한 문자열로 합쳐 주므로 그 키로 양식 라벨에 매핑.
const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  파워링크: "파워링크",
  쇼핑검색: "쇼핑검색광고",
  플레이스: "플레이스",
  "브랜드검색/신제품검색": "브랜드검색/신제품검색",
  파워컨텐츠: "파워컨텐츠",
  // 방어: 혹시 분리되어 오는 계정 대비
  브랜드검색: "브랜드검색/신제품검색",
  신제품검색: "브랜드검색/신제품검색",
};
function campaignTypeLabel(apiTp: string): string {
  return CAMPAIGN_TYPE_LABEL[apiTp.trim()] ?? apiTp.trim();
}

// 연령 raw("14세 ~ 18세","50세 ~ 54세","60세 이상"...)의 시작 나이로 양식 8버킷에 매핑.
// 50세 이상은 잘게 쪼개진 버킷(50~54/55~59/60+)이 와도 모두 "50세 이상"으로 합산.
function ageLabel(api: string): string | null {
  const n = Number((api.match(/(\d+)/) ?? [])[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 19) return "만 13~18세";
  if (n < 25) return "19~24세";
  if (n < 30) return "25~29세";
  if (n < 35) return "30~34세";
  if (n < 40) return "35~39세";
  if (n < 45) return "40~44세";
  if (n < 50) return "45~49세";
  return "50세 이상";
}
const AGE_ORDER = ["만 13~18세", "19~24세", "25~29세", "30~34세", "35~39세", "40~44세", "45~49세", "50세 이상"];

// 디스플레이(GFA)는 연령표에 '알 수 없음' 칸이 있어(양식 sheet8 9행) 살린다. 검색광고는 양식에
// 칸이 없어 ageLabel이 null로 제외한다.
function displayAgeLabel(api: string): string | null {
  if (api.replace(/\s/g, "").includes("알수없")) return "알 수 없음";
  return ageLabel(api);
}
const DISPLAY_AGE_ORDER = [...AGE_ORDER, "알 수 없음"];

function genderLabel(api: string): string {
  const t = (api || "").replace(/\s/g, "");
  if (t.includes("남")) return "남성";
  if (t.includes("여")) return "여성";
  return "알수없음";
}
const GENDER_ORDER = ["남성", "여성", "알수없음"];

const SEARCH_TYPE_ORDER = ["파워링크", "쇼핑검색광고", "플레이스", "브랜드검색/신제품검색", "파워컨텐츠"];

// ── advanced-report 헬퍼 ──
async function fetchTotal(customerId: number, range: DateRange): Promise<ReportMetrics> {
  const res = await fetchAdvancedReport({ attributes: [], range, customerId });
  const idx = colIndex(res.head);
  return res.rows[0] ? rowMetrics(res.rows[0], idx) : ZERO_METRICS;
}

// 한 차원으로 집계 → Map<라벨, 지표>. labelFn으로 양식 라벨 변환(null이면 제외).
async function fetchAggregated(
  customerId: number, range: DateRange, attr: string,
  labelFn: (raw: string) => string | null,
): Promise<Map<string, ReportMetrics>> {
  const res = await fetchAdvancedReport({ attributes: [attr], range, customerId });
  const idx = colIndex(res.head);
  const out = new Map<string, ReportMetrics>();
  for (const r of res.rows) {
    const label = labelFn(r[idx[attr]] ?? "");
    if (!label) continue;
    out.set(label, addMetrics(out.get(label) ?? ZERO_METRICS, rowMetrics(r, idx)));
  }
  return out;
}

function orderedNamed(map: Map<string, ReportMetrics>, order: string[]): NamedMetrics[] {
  return order
    .filter((label) => map.has(label))
    .map((label) => ({ label, metrics: map.get(label)! }));
}

// ── ReportModel 조립 (검색광고) ──
// brandCur/brandPrev = 브랜드검색 계약금액의 금주/전주 일할(proration) 비용 합계. 검색광고
// 비용(salesAmt)은 브랜드가 0으로 잡히므로, 각 기간에 실제 집행된 일할 금액을 검색 총비용에
// 가산해 종합·검색광고 시트의 비용·합계가 섹션3 브랜드 행과 정합되게 한다.
// 전주도 동일 계약을 전주 기간으로 일할 계산하므로, 계약이 기간을 걸쳐 시작/종료되면 증감이
// 실제 집행 변화를 반영한다(미변동 구간이면 증감 0).
export async function buildReportModel(
  target: ReportTarget, range: DateRange, meta: ReportMeta, brandCur = 0, brandPrev = 0,
): Promise<ReportModel> {
  const cid = target.masterCustomerId;
  if (cid == null) throw new Error("계정 정보를 불러올 수 없어요");
  const prev = previousRange(range);

  // GFA(디스플레이)는 계정에 없거나 권한 문제면 0으로 graceful — hasDisplay로 시트/행 표시 결정.
  // ⚠️ 일시적 네트워크/인증 실패도 여기서 0이 되면 디스플레이가 통째로 빠진 리포트가 조용히 나온다.
  // 동시 요청 폭주 중 한 번의 일시 오류로 디스플레이가 통째로 사라지지 않게 1회 재시도 + 에러 로그.
  const gfaSafe = async (r: DateRange) => {
    try {
      return await fetchGfaTotal(target.adAccountNo, cid, r);
    } catch (e1) {
      console.warn("[dv-ads/report] 디스플레이 합계 1차 조회 실패 → 재시도", e1);
      try {
        return await fetchGfaTotal(target.adAccountNo, cid, r);
      } catch (e2) {
        console.warn("[dv-ads/report] 디스플레이 합계 조회 최종 실패 → 0으로 처리(디스플레이 누락 가능)", e2);
        return ZERO_METRICS;
      }
    }
  };
  const [saCurRaw, saPrevRaw, byDayMap, byPlaceRows, byGenderMap, byAgeMap, gfaCur, gfaPrev] = await Promise.all([
    fetchTotal(cid, range),
    fetchTotal(cid, prev),
    fetchAggregated(cid, range, "ymd", (v) => ymdToIso(v)),
    fetchPlacement(cid, range),
    fetchAggregated(cid, range, "criterionGenderNm", genderLabel),
    fetchAggregated(cid, range, "criterionAgeTpNm", ageLabel),
    gfaSafe(range),
    gfaSafe(prev),
  ]);
  // 브랜드 일할 계약금액 가산 (금주/전주 검색 총비용에 각각 반영)
  const saCur = brandCur > 0 ? { ...saCurRaw, cost: saCurRaw.cost + brandCur } : saCurRaw;
  const saPrev = brandPrev > 0 ? { ...saPrevRaw, cost: saPrevRaw.cost + brandPrev } : saPrevRaw;

  // 일자별: 기간 내 모든 날짜를 라벨로, 데이터 매칭(없으면 0)
  const byDay: NamedMetrics[] = eachDay(range).map((d) => {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { label: dayLabel(d), metrics: byDayMap.get(iso) ?? ZERO_METRICS };
  });

  const hasDisplay = gfaCur.impressions > 0 || gfaCur.cost > 0;

  // 디스플레이_상세(일자/지면/성별/연령) — 비동기 다운로드 보고서(느림, 순차). 디스플레이 있을 때만.
  // 실패하면(rate-limit/권한) graceful: hasDisplayDetail=false로 시트 제거.
  let displayByDay: NamedMetrics[] = [];
  let displayByPlacement: NamedMetrics[] = [];
  let displayByGender: NamedMetrics[] = [];
  let displayByAge: NamedMetrics[] = [];
  let hasDisplayDetail = false;
  if (hasDisplay) {
    try {
      const detail = await fetchGfaDetail(target.adAccountNo, cid, range);
      const dayMap = new Map(detail.byDay.map((r) => [ymdToIso(r.label), r.metrics]));
      displayByDay = eachDay(range).map((d) => {
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return { label: dayLabel(d), metrics: dayMap.get(k) ?? ZERO_METRICS };
      });
      displayByPlacement = detail.byPlacement
        .filter((p) => p.metrics.impressions > 0)
        .sort((a, b) => b.metrics.cost - a.metrics.cost);
      displayByGender = orderedNamed(normalizeNamed(detail.byGender, genderLabel), GENDER_ORDER);
      displayByAge = orderedNamed(normalizeNamed(detail.byAge, displayAgeLabel), DISPLAY_AGE_ORDER);
      hasDisplayDetail = true;
    } catch (e) {
      console.warn("[dv-ads/report] 디스플레이 상세 수집 실패", e);
    }
  }

  return {
    advertiserName: target.name,
    periodText: `${range.since.replace(/-/g, ".")} ~ ${range.until.replace(/-/g, ".")}`,
    authorName: meta.authorName,
    createdDate: meta.createdDate,
    totalCurrent: addMetrics(saCur, gfaCur), // 종합 = 검색광고 + 디스플레이
    totalPrev: addMetrics(saPrev, gfaPrev),
    searchCurrent: saCur,
    searchPrev: saPrev,
    displayCurrent: gfaCur,
    displayPrev: gfaPrev,
    byDay,
    byPlacement: byPlaceRows, // 이미 동적 정렬된 NamedMetrics[]
    byGender: orderedNamed(byGenderMap, GENDER_ORDER),
    byAge: orderedNamed(byAgeMap, AGE_ORDER),
    displayByDay,
    displayByPlacement,
    displayByGender,
    displayByAge,
    hasSearch: true,
    hasDisplay,
    hasDisplayDetail,
  };
}

// CSV raw 라벨 NamedMetrics[] → 양식 라벨로 정규화·합산 (성별/연령). labelFn null이면 제외.
function normalizeNamed(
  rows: NamedMetrics[],
  labelFn: (raw: string) => string | null,
): Map<string, ReportMetrics> {
  const out = new Map<string, ReportMetrics>();
  for (const r of rows) {
    const label = labelFn(r.label);
    if (!label) continue;
    out.set(label, addMetrics(out.get(label) ?? ZERO_METRICS, r.metrics));
  }
  return out;
}

// 지면별: mediaNm별 동적. 노출(impressions)>0인 지면만, 총비용 내림차순. (고정 7버킷 폐기)
async function fetchPlacement(customerId: number, range: DateRange): Promise<NamedMetrics[]> {
  const res = await fetchAdvancedReport({ attributes: ["mediaNm"], range, customerId });
  const idx = colIndex(res.head);
  const map = new Map<string, ReportMetrics>();
  for (const r of res.rows) {
    const name = (r[idx["mediaNm"]] ?? "").trim();
    if (!name) continue;
    map.set(name, addMetrics(map.get(name) ?? ZERO_METRICS, rowMetrics(r, idx)));
  }
  return [...map.entries()]
    .map(([label, metrics]) => ({ label, metrics }))
    .filter((p) => p.metrics.impressions > 0)
    .sort((a, b) => b.metrics.cost - a.metrics.cost);
}

// ── 브랜드검색 계약금액 (일할 계산) ──
// 브랜드검색/신제품검색은 소진비용(salesAmt)이 0이라 advanced-report로 비용이 안 잡힌다.
// 대신 계약금액(contractAmt)을 리포트 기간에 실제 집행된 일수만큼 안분(proration)해 비용으로
// 쓴다. 계약은 광고그룹(PC/모바일 별도) 단위라 그룹별로 보관 — 검색광고 시트 섹션2 캠페인별
// 표가 그룹 행이라 그룹 일할 비용으로 주입한다. 일할 공식·날짜 규칙은 report-period.ts 참조.
// raw 계약을 한 번 받아 금주/전주 두 기간으로 각각 proratedBrand()를 돌린다(전주는 다른 기간).
interface BrandCampaignRow { nccCampaignId?: string }
// time-contracts 평면 배열 1건 = 계약 1건 (현재·예약·종료·취소 전부 포함).
interface BrandTimeContract {
  nccTimeContractId?: string;
  nccAdgroupId?: string;
  campaignTp?: string;
  contractAmt?: number;
  contractStatus?: string;
  contractStartDt?: string;
  contractEndDt?: string;
  exposureStartDt?: string;
  exposureEndDt?: string;
  cancelStatus?: string;
  cancelTm?: string;
}
// 일할 입력으로 쓸 raw 계약 1건 (광고그룹ID + 계약 기간/금액/노출·취소 필드).
export type BrandRawContract = ProrationContract & { adgroupId: string; contractStatus?: string };

async function fetchBrandContracts(customerId: number): Promise<BrandRawContract[]> {
  const camps = await authFetch<BrandCampaignRow[]>(
    "/apis/sa/api/ncc/campaigns?recordSize=1001&campaignType=BRAND_SEARCH",
    undefined, customerId,
  ).catch(() => [] as BrandCampaignRow[]);
  const campIds = (camps ?? []).map((c) => c.nccCampaignId).filter((x): x is string => !!x);
  if (campIds.length === 0) return [];

  const agLists = await Promise.all(campIds.map((id) => fetchAdgroupRowsByCampaign(id, customerId)));
  const adgroupIds = agLists.flat().map((a) => a.nccAdgroupId).filter((x): x is string => !!x);
  if (adgroupIds.length === 0) return [];

  // /time-contracts 는 x-ad-customer-id 계정 범위로 브랜드검색 계약 전체(현재·예약·종료·취소)를
  // 평면 배열로 준다 — after-current-summaries(현재+다음만)와 달리 과거 종료 계약까지 포함하므로
  // 지난달 등 과거 기간 리포트의 일할 비용이 정확히 잡힌다(겹침 없는 계약은 proration이 0으로 제외).
  // nccAdgroupIds 파라미터는 실제 필터링하지 않고(계정 전체 반환) 라우트 충족용이라, chunk마다 같은
  // 집합이 와도 nccTimeContractId로 dedup. 삭제된 옛 광고그룹 소속 계약도 함께 와 과거 집행분을 보존.
  const out: BrandRawContract[] = [];
  const seen = new Set<string>();
  const CHUNK = 100;
  for (let i = 0; i < adgroupIds.length; i += CHUNK) {
    const chunk = adgroupIds.slice(i, i + CHUNK);
    const rows = await authFetch<BrandTimeContract[]>(
      "/apis/sa/api/ncc/time-contracts?nccAdgroupIds=" + encodeURIComponent(chunk.join(",")),
      undefined, customerId,
    ).catch(() => [] as BrandTimeContract[]);
    for (const c of rows ?? []) {
      if (!c?.contractAmt || !c.nccAdgroupId) continue;
      const key = c.nccTimeContractId ?? `${c.nccAdgroupId}:${c.contractStartDt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        adgroupId: c.nccAdgroupId,
        contractAmt: c.contractAmt,
        contractStartDt: c.contractStartDt,
        contractEndDt: c.contractEndDt,
        exposureStartDt: c.exposureStartDt,
        exposureEndDt: c.exposureEndDt,
        // 정상 계약은 cancelStatus="NOT_CANCELED" + cancelTm=null. 실제 취소된 계약만 cancelTm을
        // 일할 끝으로 반영(노출전 취소는 cancelTm이 시작보다 앞이라 overlap 0으로 자연 제외).
        cancelTm:
          c.cancelStatus && c.cancelStatus !== "NOT_CANCELED" && c.cancelTm
            ? c.cancelTm
            : undefined,
        contractStatus: c.contractStatus,
      });
    }
  }
  return out;
}

// 종합 캠페인 유형별(섹션3) 검색 유형 리스트. 브랜드검색 행은 비용(cost)을 계약금액으로 대체.
async function fetchSummarySearchTypes(
  customerId: number, range: DateRange, brandTotal: number,
): Promise<SummaryType[]> {
  const map = await fetchAggregated(customerId, range, "nccCampaignTp", campaignTypeLabel);
  return SEARCH_TYPE_ORDER.filter((l) => map.has(l)).map((label) => {
    const metrics = map.get(label)!;
    if (label === "브랜드검색/신제품검색" && brandTotal > 0) {
      return { label, metrics: { ...metrics, cost: metrics.cost + brandTotal } };
    }
    return { label, metrics };
  });
}

// 검색광고 캠페인별(섹션2): 유형 → 광고그룹 행. 브랜드 그룹은 비용을 노출중 계약금액으로 대체.
async function fetchCampaignGroups(
  customerId: number, range: DateRange, brandByAdgroup: Map<string, number>,
): Promise<CampaignTypeGroup[]> {
  const res = await fetchAdvancedReport({ attributes: ["nccCampaignTp", "nccAdgroupId"], range, customerId });
  const idx = colIndex(res.head);
  const byType = new Map<string, { group: string; metrics: ReportMetrics }[]>();
  for (const r of res.rows) {
    const type = campaignTypeLabel(r[idx["nccCampaignTp"]] ?? "");
    const ent = parseEntity(r[idx["nccAdgroupId"]] ?? "");
    if (!ent.name) continue;
    let metrics = rowMetrics(r, idx);
    const contract = brandByAdgroup.get(ent.id);
    if (contract) metrics = { ...metrics, cost: metrics.cost + contract };
    const arr = byType.get(type) ?? [];
    arr.push({ group: ent.name, metrics });
    byType.set(type, arr);
  }
  return SEARCH_TYPE_ORDER.filter((t) => byType.has(t)).map((type) => ({ type, rows: byType.get(type)! }));
}

// 키워드 시트: 파워링크(등록 키워드) / 쇼핑검색(실제 검색어 비용 TOP)
async function fetchKeywordGroups(
  customerId: number, range: DateRange, apiType: string, keyAttr: "keyword" | "expKeyword", topN?: number,
): Promise<KeywordGroup[]> {
  const res = await fetchAdvancedReport({
    attributes: ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", keyAttr], range, customerId,
  });
  const idx = colIndex(res.head);
  const items: { campaign: string; group: string; kw: string; metrics: ReportMetrics }[] = [];
  for (const r of res.rows) {
    if ((r[idx["nccCampaignTp"]] ?? "").trim() !== apiType) continue;
    const kw = (r[idx[keyAttr]] ?? "").trim();
    if (!kw || kw === "-") continue;
    items.push({
      campaign: parseEntity(r[idx["nccCampaignId"]] ?? "").name,
      group: parseEntity(r[idx["nccAdgroupId"]] ?? "").name,
      kw,
      metrics: rowMetrics(r, idx),
    });
  }
  // 총비용(cost) 상위 N개만 (쇼핑 검색어 등 폭주 방지)
  const picked = topN ? [...items].sort((a, b) => b.metrics.cost - a.metrics.cost).slice(0, topN) : items;
  // (campaign, group)별 묶기 — 이름에 공백이 있을 수 있어 JSON 배열을 키로 사용(split 버그 회피)
  const map = new Map<string, KeywordGroup>();
  for (const it of picked) {
    const key = JSON.stringify([it.campaign, it.group]);
    let g = map.get(key);
    if (!g) { g = { campaign: it.campaign, group: it.group, keywords: [] }; map.set(key, g); }
    g.keywords.push({ keyword: it.kw, metrics: it.metrics });
  }
  // 정렬: 그룹 내 키워드 총비용 내림차순, 그룹은 그룹 총비용 내림차순
  const result = [...map.values()];
  const groupCost = (g: KeywordGroup) => g.keywords.reduce((s, k) => s + k.metrics.cost, 0);
  for (const g of result) g.keywords.sort((a, b) => b.metrics.cost - a.metrics.cost);
  result.sort((a, b) => groupCost(b) - groupCost(a));
  return result;
}

// ── 전체 조립 → xlsx bytes ──
export async function buildReportBytes(target: ReportTarget, range: DateRange, meta: ReportMeta): Promise<Uint8Array> {
  const cid = target.masterCustomerId;
  if (cid == null) throw new Error("계정 정보를 불러올 수 없어요");
  const url = chrome.runtime.getURL("src/assets/report-template.xlsx");
  const files: ZipFiles = openXlsx(new Uint8Array(await (await fetch(url)).arrayBuffer()));

  // 브랜드검색 계약 raw 수집(없거나 실패 시 빈 목록) → 금주/전주 기간으로 각각 일할 계산.
  // 검색 비용 가산(금주/전주)·종합 섹션3·검색 섹션2 그룹 비용에 공통 사용.
  const brandRaw = await fetchBrandContracts(cid).catch((e) => {
    console.warn("[dv-ads/report] 브랜드 계약 조회 실패 → 빈 값", e);
    return [] as BrandRawContract[];
  });
  const brandCur = proratedBrand(brandRaw, range);
  const brandPrev = proratedBrand(brandRaw, previousRange(range));

  const emptyGfa: GfaData = { total: ZERO_METRICS, byType: [], byCampaign: [] };
  const [model, searchTypes, displayData, campGroups, plKeywords, shKeywords] = await Promise.all([
    buildReportModel(target, range, meta, brandCur.total, brandPrev.total),
    fetchSummarySearchTypes(cid, range, brandCur.total),
    fetchGfaData(target.adAccountNo, cid, range).catch((e) => {
      console.warn("[dv-ads/report] 디스플레이 유형별/캠페인별 조회 실패 → 빈 값", e);
      return emptyGfa;
    }),
    fetchCampaignGroups(cid, range, brandCur.byAdgroup),
    // 파워링크·쇼핑검색 둘 다 '검색어(expKeyword)' 기준 (등록 키워드 keyword 아님). 비용 상위 N개.
    fetchKeywordGroups(cid, range, "파워링크", "expKeyword", 50),
    fetchKeywordGroups(cid, range, "쇼핑검색", "expKeyword", 50),
  ]);
  const displayTypes = displayData.byType;

  // 고정형
  fillFixedSheets(files, model);
  // 종합 그래프 제거 + 빈 영역(3~16) 숨김
  removeSheetDrawing(files, "xl/worksheets/sheet2.xml");
  writeText(files, "xl/worksheets/sheet2.xml", hideRowRange(readText(files, "xl/worksheets/sheet2.xml"), 3, 16));
  // 동적: 종합 유형별 / 검색광고 캠페인별 / 키워드
  renderSummaryTypes(files, searchTypes, displayTypes);
  renderCampaignSheet(files, "xl/worksheets/sheet3.xml", campGroups);
  renderKeywordSheet(files, "xl/worksheets/sheet5.xml", plKeywords);
  renderKeywordSheet(files, "xl/worksheets/sheet6.xml", shKeywords, "쇼핑검색 키워드별 성과");
  // 검색_상세 지면별 → 맨 아래 동적 + 옛 영역 삭제 + 지면 그래프 제거(내부 처리) + 성별 그래프 여성색
  renderDetailPlacement(files, model.byPlacement);
  replaceChartColor(files, "xl/charts/chart5.xml", "92D050", "F67676");
  // 월간(일수>7) 일자별 확장 — 지면 동적 이동 후 마지막에. 주간이면 no-op.
  expandDailyRows(files, SEARCH_DAILY_EXPAND, model.byDay);
  // 디스플레이_상세도 동일 처리 (수집 성공 시). fillFixedSheets가 일자/성별/연령은 이미 채움.
  if (model.hasDisplayDetail) {
    renderDetailPlacement(files, model.displayByPlacement, DISPLAY_PLACEMENT, true);
    replaceChartColor(files, "xl/charts/chart9.xml", "92D050", "F67676");
    expandDailyRows(files, DISPLAY_DAILY_EXPAND, model.displayByDay, true);
  }
  // 디스플레이 시트(sheet7) 캠페인별 표 — 디스플레이 운영 계정일 때만(섹션1은 fillFixedSheets에서).
  if (model.hasDisplay) {
    renderCampaignSheet(files, "xl/worksheets/sheet7.xml", displayData.byCampaign, DISPLAY_CAMPAIGN_LAYOUT);
  }

  // 비진행 매체 시트 제거. 디스플레이 시트는 디스플레이 미진행 시 제거.
  // 디스플레이_상세는 분해 수집 성공 시 유지. 키워드 시트는 데이터 없으면 제거.
  const toRemove: string[] = [];
  if (!model.hasDisplay) toRemove.push("디스플레이");
  if (!model.hasDisplayDetail) toRemove.push("디스플레이_상세");
  if (plKeywords.length === 0) toRemove.push("파워링크_키워드");
  if (shKeywords.length === 0) toRemove.push("쇼핑검색_키워드");
  if (toRemove.length > 0) removeSheets(files, toRemove);

  removeCalcChain(files); // stale 수식 캐시 제거 → 엑셀 "복구" 대화상자 방지
  forceRecalc(files);
  return buildXlsx(files);
}

// 프리셋 편의
export function buildRangeFromPreset(preset: ReportPreset, today: Date): DateRange {
  return rangeForPreset(preset, today);
}
