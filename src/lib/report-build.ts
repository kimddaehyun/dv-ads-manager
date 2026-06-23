// F-Report orchestration — 실데이터(advanced-report) 수집 → ReportModel 조립 → 양식 주입 → xlsx bytes.
//
// 검색광고(SA)만 완전 연결(advanced-report 동기, 메모리 project_f_report_endpoints). 디스플레이(GFA)는
// 분해 endpoint 미정찰이라 이번 단계 제외 — hasDisplay=false로 디스플레이 시트 2개 제거.
//
// 라벨 매핑(캠페인유형/지면/연령/성별)은 best-effort. 실데이터로 검증·보정 필요(특히 지면 7버킷).

import {
  openXlsx, buildXlsx, forceRecalc, removeSheets, removeSheetDrawing, removeCalcChain,
  replaceChartColor,
  readText, writeText, hideRowRange, type ZipFiles,
} from "./report-excel";
import { fillFixedSheets, type ReportModel, type NamedMetrics } from "./report-fill";
import {
  renderKeywordSheet, renderCampaignSheet, renderSummaryTypes, renderDetailPlacement,
  type KeywordGroup, type CampaignTypeGroup, type SummaryType,
} from "./report-variable";
import {
  fetchAdvancedReport, colIndex, parseEntity, rowMetrics, addMetrics,
  ZERO_METRICS, type ReportMetrics,
} from "./report-data";
import {
  rangeForPreset, previousRange, eachDay, dayLabel, ymdToIso,
  type DateRange, type ReportPreset,
} from "./report-period";

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
// 캠페인유형: nccCampaignTp. 브랜드검색+신제품검색은 양식상 한 줄("브랜드·신제품검색")로 합산.
const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  파워링크: "파워링크",
  쇼핑검색: "쇼핑검색광고",
  플레이스: "플레이스",
  브랜드검색: "브랜드·신제품검색",
  신제품검색: "브랜드·신제품검색",
  파워컨텐츠: "파워컨텐츠",
};
function campaignTypeLabel(apiTp: string): string {
  return CAMPAIGN_TYPE_LABEL[apiTp.trim()] ?? apiTp.trim();
}

function ageLabel(api: string): string | null {
  const n = (api.match(/(\d+)/) ?? [])[1];
  switch (n) {
    case "13": case "14": return "만 13~18세";
    case "19": return "19~24세";
    case "25": return "25~29세";
    case "30": return "30~34세";
    case "35": return "35~39세";
    case "40": return "40~44세";
    case "45": return "45~49세";
    case "50": return "50세 이상";
    default: return null;
  }
}
const AGE_ORDER = ["만 13~18세", "19~24세", "25~29세", "30~34세", "35~39세", "40~44세", "45~49세", "50세 이상"];

function genderLabel(api: string): string {
  const t = (api || "").replace(/\s/g, "");
  if (t.includes("남")) return "남성";
  if (t.includes("여")) return "여성";
  return "알수없음";
}
const GENDER_ORDER = ["남성", "여성", "알수없음"];

const SEARCH_TYPE_ORDER = ["파워링크", "쇼핑검색광고", "플레이스", "브랜드·신제품검색", "파워컨텐츠"];

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
export async function buildReportModel(target: ReportTarget, range: DateRange, meta: ReportMeta): Promise<ReportModel> {
  const cid = target.masterCustomerId;
  if (cid == null) throw new Error("계정 정보를 불러올 수 없어요");
  const prev = previousRange(range);

  const [totalCur, totalPrev, byDayMap, byPlaceRows, byGenderMap, byAgeMap] = await Promise.all([
    fetchTotal(cid, range),
    fetchTotal(cid, prev),
    fetchAggregated(cid, range, "ymd", (v) => ymdToIso(v)),
    fetchPlacement(cid, range),
    fetchAggregated(cid, range, "criterionGenderNm", genderLabel),
    fetchAggregated(cid, range, "criterionAgeTpNm", ageLabel),
  ]);

  // 일자별: 기간 내 모든 날짜를 라벨로, 데이터 매칭(없으면 0)
  const byDay: NamedMetrics[] = eachDay(range).map((d) => {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { label: dayLabel(d), metrics: byDayMap.get(iso) ?? ZERO_METRICS };
  });

  return {
    advertiserName: target.name,
    periodText: `${range.since.replace(/-/g, ".")} ~ ${range.until.replace(/-/g, ".")}`,
    authorName: meta.authorName,
    createdDate: meta.createdDate,
    totalCurrent: totalCur,
    totalPrev: totalPrev,
    searchCurrent: totalCur, // SA 전용(디스플레이 미연동) → 전체=검색광고
    searchPrev: totalPrev,
    displayCurrent: ZERO_METRICS,
    byDay,
    byPlacement: byPlaceRows, // 이미 동적 정렬된 NamedMetrics[]
    byGender: orderedNamed(byGenderMap, GENDER_ORDER),
    byAge: orderedNamed(byAgeMap, AGE_ORDER),
    hasSearch: true,
    hasDisplay: false,
  };
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

// 종합 캠페인 유형별(섹션3) 검색 유형 리스트
async function fetchSummarySearchTypes(customerId: number, range: DateRange): Promise<SummaryType[]> {
  const map = await fetchAggregated(customerId, range, "nccCampaignTp", campaignTypeLabel);
  return SEARCH_TYPE_ORDER.filter((l) => map.has(l)).map((label) => ({ label, metrics: map.get(label)! }));
}

// 검색광고 캠페인별(섹션2): 유형 → 광고그룹 행
async function fetchCampaignGroups(customerId: number, range: DateRange): Promise<CampaignTypeGroup[]> {
  const res = await fetchAdvancedReport({ attributes: ["nccCampaignTp", "nccAdgroupId"], range, customerId });
  const idx = colIndex(res.head);
  const byType = new Map<string, { group: string; metrics: ReportMetrics }[]>();
  for (const r of res.rows) {
    const type = campaignTypeLabel(r[idx["nccCampaignTp"]] ?? "");
    const group = parseEntity(r[idx["nccAdgroupId"]] ?? "").name;
    if (!group) continue;
    const arr = byType.get(type) ?? [];
    arr.push({ group, metrics: rowMetrics(r, idx) });
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

  const [model, searchTypes, campGroups, plKeywords, shKeywords] = await Promise.all([
    buildReportModel(target, range, meta),
    fetchSummarySearchTypes(cid, range),
    fetchCampaignGroups(cid, range),
    // 파워링크·쇼핑검색 둘 다 '검색어(expKeyword)' 기준 (등록 키워드 keyword 아님). 비용 상위 N개.
    fetchKeywordGroups(cid, range, "파워링크", "expKeyword", 50),
    fetchKeywordGroups(cid, range, "쇼핑검색", "expKeyword", 50),
  ]);

  // 고정형
  fillFixedSheets(files, model);
  // 종합 그래프 제거 + 빈 영역(3~16) 숨김
  removeSheetDrawing(files, "xl/worksheets/sheet2.xml");
  writeText(files, "xl/worksheets/sheet2.xml", hideRowRange(readText(files, "xl/worksheets/sheet2.xml"), 3, 16));
  // 동적: 종합 유형별 / 검색광고 캠페인별 / 키워드
  renderSummaryTypes(files, searchTypes, []);
  renderCampaignSheet(files, "xl/worksheets/sheet3.xml", campGroups);
  renderKeywordSheet(files, "xl/worksheets/sheet5.xml", plKeywords);
  renderKeywordSheet(files, "xl/worksheets/sheet6.xml", shKeywords, "쇼핑검색 키워드별 성과");
  // 검색_상세 지면별 → 맨 아래 동적 + 옛 영역 삭제 + 지면 그래프 제거(내부 처리) + 성별 그래프 여성색
  renderDetailPlacement(files, model.byPlacement);
  replaceChartColor(files, "xl/charts/chart5.xml", "92D050", "F67676");

  // 비진행 매체 시트 제거 (디스플레이 미연동 → 항상 제거. 파워링크/쇼핑 키워드 없으면 해당 시트 제거)
  const toRemove = ["디스플레이", "디스플레이_상세"];
  if (plKeywords.length === 0) toRemove.push("파워링크_키워드");
  if (shKeywords.length === 0) toRemove.push("쇼핑검색_키워드");
  removeSheets(files, toRemove);

  removeCalcChain(files); // stale 수식 캐시 제거 → 엑셀 "복구" 대화상자 방지
  forceRecalc(files);
  return buildXlsx(files);
}

// 프리셋 편의
export function buildRangeFromPreset(preset: ReportPreset, today: Date): DateRange {
  return rangeForPreset(preset, today);
}
