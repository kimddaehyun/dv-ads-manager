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
  fillFixedSheets, expandDailyRows, insertSummaryDaily, SEARCH_DAILY_EXPAND, DISPLAY_DAILY_EXPAND,
  type ReportModel, type NamedMetrics,
} from "./report-fill";
import {
  renderKeywordSheet, renderProductSheet, renderCampaignSheet, renderSummaryTypes, renderDetailPlacement,
  DISPLAY_PLACEMENT, DISPLAY_CAMPAIGN_LAYOUT,
  type KeywordGroup, type CampaignTypeGroup, type SummaryType,
} from "./report-variable";
import { authFetch, fetchAdgroupRowsByCampaign } from "./multi-account-data";
import {
  fetchAdvancedReport, colIndex, parseEntity, rowMetrics, addMetrics,
  ZERO_METRICS, type ReportMetrics, type AdvReportResult,
} from "./report-data";
import {
  rangeForPreset, previousRange, rangeText, eachDay, dayLabel, ymdToIso, proratedBrand,
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
  displayCurrent?: GfaData | Promise<GfaData>,
  brandRaw: BrandRawContract[] = [], // 일자별에 브랜드 계약금액을 하루 단위로 나눠 넣기 위한 원본
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
  // 현재기간 디스플레이 합계: 상위(buildReportBytes)에서 이미 받은 GFA 결과의 .total을 재사용해
  // fetchGfaData 중복 호출을 없앤다. 단독 호출 등 미제공 시에는 gfaSafe로 폴백(재시도 포함).
  const gfaCurP =
    displayCurrent != null
      ? Promise.resolve(displayCurrent).then((d) => d.total)
      : gfaSafe(range);

  // 디스플레이_상세(비동기 다운로드 파이프라인, 가장 느린 구간)는 합계만 확인되면(1~2초) 바로
  // 출발시켜 아래 SA 수집(키워드 보고서 페이지네이션 포함)과 겹쳐 돌린다 — 직렬로 두면 계정당
  // 그만큼 늦어진다. 결과 소비·실패 graceful 처리는 아래 hasDisplay 블록에서.
  const detailP = gfaCurP.then((g) =>
    g.impressions > 0 || g.cost > 0 ? fetchGfaDetail(target.adAccountNo, cid, range) : null,
  );
  // Promise.all이 먼저 reject되면 아래 await detailP에 도달하지 못한다 — unhandled rejection 방지용
  // no-op catch (await 측 에러 전파에는 영향 없음).
  detailP.catch(() => {});

  const [saCurRaw, saPrevRaw, byDayMap, byPlaceRows, byGenderMap, byAgeMap, gfaCur, gfaPrev] = await Promise.all([
    fetchTotal(cid, range),
    fetchTotal(cid, prev),
    fetchAggregated(cid, range, "ymd", (v) => ymdToIso(v)),
    fetchPlacement(cid, range),
    fetchAggregated(cid, range, "criterionGenderNm", genderLabel),
    fetchAggregated(cid, range, "criterionAgeTpNm", ageLabel),
    gfaCurP,
    gfaSafe(prev),
  ]);
  // 브랜드 일할 계약금액 가산 (금주/전주 검색 총비용에 각각 반영)
  const saCur = brandCur > 0 ? { ...saCurRaw, cost: saCurRaw.cost + brandCur } : saCurRaw;
  const saPrev = brandPrev > 0 ? { ...saPrevRaw, cost: saPrevRaw.cost + brandPrev } : saPrevRaw;

  // 일자별: 기간 내 모든 날짜를 라벨로, 데이터 매칭(없으면 0)
  //
  // 브랜드검색은 계약 기반이라 소진비용(salesAmt)이 0 → 다차원보고서 일자별에 비용이 안 잡힌다.
  // 반면 총계(saCur)에는 계약금액 일할분(brandCur)이 더해져 있어, 그대로 두면 일자별 합계가
  // 총계보다 브랜드 금액만큼 작다. 종합 시트에선 이 둘이 바로 위아래에 붙으므로 티가 난다.
  // → 같은 일할 계산(proratedBrand)을 **하루 단위 기간**으로 돌려 날짜마다 나눠 넣는다.
  //   (캠페인별 표가 이미 brandCur.byAdgroup으로 그룹 단위 배분을 하는 것과 같은 방식)
  // 하루씩 Math.round 하므로 합계가 brandCur와 몇 원(30일 기준 최대 15원) 어긋날 수 있다.
  const byDay: NamedMetrics[] = eachDay(range).map((d) => {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const m = byDayMap.get(iso) ?? ZERO_METRICS;
    const brand = brandRaw.length > 0 ? proratedBrand(brandRaw, { since: iso, until: iso }).total : 0;
    return { label: dayLabel(d), metrics: brand > 0 ? { ...m, cost: m.cost + brand } : m };
  });

  const hasDisplay = gfaCur.impressions > 0 || gfaCur.cost > 0;

  // 디스플레이_상세(일자/지면/성별/연령) — 위에서 SA 수집과 겹쳐 출발시킨 detailP 소비.
  // 실패하면(rate-limit/권한) graceful: hasDisplayDetail=false로 시트 제거.
  let displayByDay: NamedMetrics[] = [];
  let displayByPlacement: NamedMetrics[] = [];
  let displayByGender: NamedMetrics[] = [];
  let displayByAge: NamedMetrics[] = [];
  let hasDisplayDetail = false;
  if (hasDisplay) {
    try {
      const detail = await detailP;
      if (detail) {
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
      }
    } catch (e) {
      console.warn("[dv-ads/report] 디스플레이 상세 수집 실패", e);
    }
  }

  // 종합 일자별 = 검색 + 디스플레이. 둘 다 eachDay(range)로 만들어 인덱스가 맞는다.
  // 디스플레이를 운영하는데 분해 수집이 실패하면(hasDisplayDetail=false) 검색분만 남아 섹션1
  // 총계와 안 맞으므로, 그 사실을 제목에 표기하도록 플래그를 넘긴다.
  const summaryByDay = displayByDay.length > 0
    ? byDay.map((d, i) => ({
      label: d.label,
      metrics: addMetrics(d.metrics, displayByDay[i]?.metrics ?? ZERO_METRICS),
    }))
    : byDay;

  return {
    advertiserName: target.name,
    periodText: `${range.since.replace(/-/g, ".")} ~ ${range.until.replace(/-/g, ".")}`,
    authorName: meta.authorName,
    createdDate: meta.createdDate,
    curPeriodLabel: `설정 기간(${rangeText(range)})`,
    prevPeriodLabel: `이전 기간(${rangeText(prev)})`,
    totalCurrent: addMetrics(saCur, gfaCur), // 종합 = 검색광고 + 디스플레이
    totalPrev: addMetrics(saPrev, gfaPrev),
    searchCurrent: saCur,
    searchPrev: saPrev,
    displayCurrent: gfaCur,
    displayPrev: gfaPrev,
    summaryByDay,
    summaryByDayIsSearchOnly: hasDisplay && !hasDisplayDetail,
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

// ── 자잘한 행 접기 ──
// 총비용이 표 전체 총비용의 0.5% 미만인 행(100만원 집행이면 5천원 미만)은 표를 덮기만 하므로
// "기타 ..." 한 행으로 합친다. 합친 값도 그대로 더해지므로 소계/합계는 계속 정확하다.
const MINOR_ROW_RATIO = 0.005;

// 표 전체 총비용의 0.5%. 합계가 0이면 임계도 0이라 아무것도 안 접힌다(전부 0원인 기간).
function minorThreshold(rows: { metrics: ReportMetrics }[]): number {
  return rows.reduce((s, r) => s + r.metrics.cost, 0) * MINOR_ROW_RATIO;
}

// 전환이 하나라도 붙은 행. 비용이 작아도 성과가 난 것이라 접어서 묻으면 안 된다.
// 이 리포트의 파생지표(전환율/ROAS)는 구매완료 기준이지만, 직접·간접 전환도 별도 칸으로 보여주므로
// 셋 중 하나라도 있으면 전환으로 본다.
function hasConversion(m: ReportMetrics): boolean {
  return m.purchaseConv > 0 || m.directConv > 0 || m.indirectConv > 0;
}

// 총비용 내림차순으로 이미 정렬된 목록을 [주요 행..., 기타 1행]으로 접는다.
// 접을 게 없으면 원본 그대로. 임계는 호출 측이 정한다(키워드는 캠페인별, 지면·상품은 표 전체).
// keep(예: 전환 발생)에 걸리는 행은 임계 미만이어도 남긴다.
function foldMinorRows(
  rows: NamedMetrics[], threshold: number, otherLabel: string,
  keep?: (m: ReportMetrics) => boolean,
): NamedMetrics[] {
  const isMinor = (r: NamedMetrics) => r.metrics.cost < threshold && !keep?.(r.metrics);
  const minor = rows.filter(isMinor);
  if (minor.length === 0) return rows;
  let sum = ZERO_METRICS;
  for (const m of minor) sum = addMetrics(sum, m.metrics);
  return [...rows.filter((r) => !isMinor(r)), { label: otherLabel, metrics: sum }];
}

// 지면별: mediaNm별 동적. 노출(impressions)>0인 지면만, 총비용 내림차순. (고정 7버킷 폐기)
// 총비용 0.5% 미만 지면은 "기타 매체" 한 행으로 접는다.
async function fetchPlacement(customerId: number, range: DateRange): Promise<NamedMetrics[]> {
  const res = await fetchAdvancedReport({ attributes: ["mediaNm"], range, customerId });
  const idx = colIndex(res.head);
  const map = new Map<string, ReportMetrics>();
  for (const r of res.rows) {
    const name = (r[idx["mediaNm"]] ?? "").trim();
    if (!name) continue;
    map.set(name, addMetrics(map.get(name) ?? ZERO_METRICS, rowMetrics(r, idx)));
  }
  const rows = [...map.entries()]
    .map(([label, metrics]) => ({ label, metrics }))
    .filter((p) => p.metrics.impressions > 0)
    .sort((a, b) => b.metrics.cost - a.metrics.cost);
  return foldMinorRows(rows, minorThreshold(rows), "기타 매체");
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
  // nccAdgroupIds 파라미터는 실제 필터링하지 않고(계정 전체 반환) 라우트 충족용이라, chunk를 직렬로
  // 돌리면 같은 전체 응답을 매번 받아 2번째부터 전부 dedup으로 버려진다 → 첫 chunk(최대 100개)만 보내
  // 1회만 호출한다. 삭제된 옛 광고그룹 소속 계약도 함께 와 과거 집행분을 보존. dedup은 안전상 유지.
  const out: BrandRawContract[] = [];
  const seen = new Set<string>();
  const chunk = adgroupIds.slice(0, 100);
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

// 검색광고 캠페인별(섹션2): 유형 → 캠페인 → 광고그룹 행. 브랜드 그룹은 비용을 계약 일할금액으로 대체.
type CampGroupRow = { campaign: string; group: string; metrics: ReportMetrics };
async function fetchCampaignGroups(
  customerId: number, range: DateRange, brandByAdgroup: Map<string, number>,
): Promise<CampaignTypeGroup[]> {
  const res = await fetchAdvancedReport({
    attributes: ["nccCampaignTp", "nccCampaignId", "nccAdgroupId"], range, customerId,
  });
  const idx = colIndex(res.head);
  const byType = new Map<string, CampGroupRow[]>();
  for (const r of res.rows) {
    const type = campaignTypeLabel(r[idx["nccCampaignTp"]] ?? "");
    const campEnt = parseEntity(r[idx["nccCampaignId"]] ?? "");
    const groupEnt = parseEntity(r[idx["nccAdgroupId"]] ?? "");
    if (!groupEnt.name) continue;
    let metrics = rowMetrics(r, idx);
    const contract = brandByAdgroup.get(groupEnt.id);
    if (contract) metrics = { ...metrics, cost: metrics.cost + contract };
    const arr = byType.get(type) ?? [];
    arr.push({ campaign: campEnt.name, group: groupEnt.name, metrics });
    byType.set(type, arr);
  }
  return SEARCH_TYPE_ORDER.filter((t) => byType.has(t))
    .map((type) => ({ type, rows: sortByCampaign(byType.get(type)!) }));
}

// 같은 캠페인 행을 인접하게 정렬(세로 병합 전제). 캠페인은 총비용 desc, 캠페인 내 그룹도 총비용 desc.
function sortByCampaign(rows: CampGroupRow[]): CampGroupRow[] {
  const byCamp = new Map<string, CampGroupRow[]>();
  for (const row of rows) {
    const arr = byCamp.get(row.campaign) ?? [];
    arr.push(row);
    byCamp.set(row.campaign, arr);
  }
  const ordered = [...byCamp.values()]
    .map((list) => ({ list, cost: list.reduce((s, x) => s + x.metrics.cost, 0) }))
    .sort((a, b) => b.cost - a.cost);
  const out: CampGroupRow[] = [];
  for (const { list } of ordered) {
    list.sort((a, b) => b.metrics.cost - a.metrics.cost);
    out.push(...list);
  }
  return out;
}

// 키워드 시트: 파워링크(등록 키워드) / 쇼핑검색(실제 검색어)
// 이미 받아둔 advanced-report 응답(유형x캠페인x그룹x검색어)을 유형(apiType)으로 필터해 그룹핑한다.
// 파워링크·쇼핑검색은 attributes가 동일하므로 호출부에서 보고서를 1회만 받아 두 유형에 각각 적용.
//
// 총비용이 **시트 전체 총비용**의 0.5% 미만인 키워드는 그룹마다 "기타 키워드" 한 행으로 접는다
// (그룹 소계 기준이 아님 — 작은 그룹의 키워드가 살아남는 걸 막는다). 예전엔 상위 N개로 잘랐는데,
// 잘린 만큼 소계가 실제 그룹 총액과 어긋났다. 접기는 값을 버리지 않아 소계·합계가 항상 정확하다.
export function buildKeywordGroups(
  res: AdvReportResult, apiType: string, keyAttr: "keyword" | "expKeyword",
): KeywordGroup[] {
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
  // 접기 임계는 **캠페인마다 따로** — 그 캠페인 총비용의 0.5%. 시트 전체 기준으로 하면 비용이 큰
  // 캠페인이 임계를 끌어올려, 작은 캠페인은 키워드가 통째로 "기타"로 접혀 볼 게 없어진다.
  const campaignCost = new Map<string, number>();
  for (const it of items) campaignCost.set(it.campaign, (campaignCost.get(it.campaign) ?? 0) + it.metrics.cost);

  // (campaign, group)별 묶기 — 이름에 공백이 있을 수 있어 JSON 배열을 키로 사용(split 버그 회피)
  const map = new Map<string, KeywordGroup>();
  for (const it of items) {
    const key = JSON.stringify([it.campaign, it.group]);
    let g = map.get(key);
    if (!g) { g = { campaign: it.campaign, group: it.group, keywords: [] }; map.set(key, g); }
    g.keywords.push({ keyword: it.kw, metrics: it.metrics });
  }
  // 정렬: 그룹 내 총비용 내림차순 → 자잘한 것 접기(기타는 항상 그룹 끝), 그룹은 그룹 총비용 내림차순
  const result = [...map.values()];
  for (const g of result) {
    g.keywords.sort((a, b) => b.metrics.cost - a.metrics.cost);
    const threshold = (campaignCost.get(g.campaign) ?? 0) * MINOR_ROW_RATIO;
    g.keywords = foldMinorRows(
      g.keywords.map((k) => ({ label: k.keyword, metrics: k.metrics })), threshold, "기타 키워드",
      hasConversion, // 전환 난 키워드는 비용이 적어도 남긴다
    ).map((n) => ({ keyword: n.label, metrics: n.metrics }));
  }
  const groupCost = (g: KeywordGroup) => g.keywords.reduce((s, k) => s + k.metrics.cost, 0);
  result.sort((a, b) => groupCost(b) - groupCost(a));
  return result;
}

// ── 쇼핑검색 상품별 (sheet9) ──
//
// advanced-report에는 상품명 차원이 아예 없다(차원 26개 전수 확인, 2026-07-15 라이브). 게다가
// `nccAdId`는 캠페인/그룹과 달리 이름 자리에도 ID가 온다 — `[nad-...](nad-...)`. 그래서 성과는
// 다차원 보고서로 받고 **상품명만 소재 목록에서 조인**한다(네이버 자체 상품별 리포트도 같은 구조).
//
// 이 시트는 캠페인/그룹을 나누지 않고 **같은 상품끼리 합친다** — 같은 상품이 여러 그룹에 등록돼
// 있으면 한 줄로 모인다(라이브에서 실제로 중복 확인). 그래서 소재ID 단위 성과를 상품명 기준으로
// 다시 합산하는 2단계 집계가 된다.
//
// ⚠️ 순서: **상품명 합산이 먼저, 0.5% 접기가 나중.** 소재 단위로 먼저 접으면, 여러 그룹에 흩어져
// 각각은 임계 미만이지만 합치면 임계를 넘는 상품이 통째로 "기타"로 사라진다. 그래서 접기 전에
// 모든 소재의 이름이 필요하다(소재가 많으면 조회도 그만큼 — worker pool로 병렬).
// 정찰 기록: 메모리 project_f_report_product_dimension.

// 소재ID 단위 행 (상품명 조인 전). label = nccAdId.
export function buildProductAdRows(res: AdvReportResult, apiType: string): NamedMetrics[] {
  const idx = colIndex(res.head);
  const map = new Map<string, ReportMetrics>();
  for (const r of res.rows) {
    if ((r[idx["nccCampaignTp"]] ?? "").trim() !== apiType) continue;
    const adId = parseEntity(r[idx["nccAdId"]] ?? "").id.trim();
    if (!adId || adId === "-") continue;
    // 같은 소재가 여러 행으로 쪼개져 올 수 있어 합산부터
    map.set(adId, addMetrics(map.get(adId) ?? ZERO_METRICS, rowMetrics(r, idx)));
  }
  return [...map.entries()].map(([label, metrics]) => ({ label, metrics }));
}

// 소재ID → 상품명 치환 후 **상품명 기준 재합산** + 0.5% 접기. 표 전체 총비용 기준(캠페인 구분 없음).
export function buildProductRows(adRows: NamedMetrics[], titles: Map<string, string>): NamedMetrics[] {
  const byTitle = new Map<string, ReportMetrics>();
  for (const a of adRows) {
    // 이름을 못 얻은 소재는 ID를 그대로 라벨로 (빈칸보다 낫고, 다른 상품과 섞이지도 않는다)
    const title = titles.get(a.label) ?? a.label;
    byTitle.set(title, addMetrics(byTitle.get(title) ?? ZERO_METRICS, a.metrics));
  }
  const rows = [...byTitle.entries()]
    .map(([label, metrics]) => ({ label, metrics }))
    .sort((a, b) => b.metrics.cost - a.metrics.cost);
  return foldMinorRows(rows, minorThreshold(rows), "기타 상품");
}

// URL 길이 여유(소재ID ~30자 x 50 = 1,500자). 계정당 소재가 1,000개대라 병렬로 훑는다.
const AD_ID_CHUNK = 50;
const AD_TITLE_WORKERS = 4;

interface RawAdRef {
  nccAdId?: string;
  referenceData?: Record<string, unknown>;
}

// 소재ID → 상품명. 소재 type은 계정마다 다르므로(SHOPPING_PRODUCT_AD / CATALOG_AD ...)
// **종류로 거르지 않고** referenceData.productTitle만 꺼낸다 — 거르면 카탈로그형 계정이 통째로 빈다.
// productName(브랜드 없음) 말고 productTitle(브랜드 포함)이 네이버 리포트 '상품명' 칸과 같다.
async function fetchProductTitles(customerId: number, ids: string[]): Promise<Map<string, string>> {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += AD_ID_CHUNK) chunks.push(ids.slice(i, i + AD_ID_CHUNK));
  const out = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const ads = await authFetch<RawAdRef[]>(
        `/apis/sa/api/ncc/ads?ids=${chunk.map(encodeURIComponent).join(",")}`, undefined, customerId,
      );
      for (const a of ads ?? []) {
        const t = a.referenceData?.["productTitle"];
        if (a.nccAdId && typeof t === "string" && t.trim()) out.set(a.nccAdId, t.trim());
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(AD_TITLE_WORKERS, chunks.length) }, worker));
  return out;
}

// 소재ID 목록 → 상품명 맵. 조회가 통째로 실패해도 빈 맵을 줘 시트가 성과 숫자를 살린 채 나가게 한다
// (이름 자리에 소재ID가 찍히지만 표 자체는 유효).
async function resolveProductTitles(customerId: number, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  try {
    return await fetchProductTitles(customerId, ids);
  } catch (e) {
    console.warn("[dv-ads/report] 상품명 조회 실패 → 소재ID로 표기", e);
    return new Map();
  }
}

const DISPLAY_SHEET = "xl/worksheets/sheet7.xml";

// ── 전체 조립 → xlsx bytes ──
export async function buildReportBytes(target: ReportTarget, range: DateRange, meta: ReportMeta): Promise<Uint8Array> {
  const cid = target.masterCustomerId;
  if (cid == null) throw new Error("계정 정보를 불러올 수 없어요");
  const url = chrome.runtime.getURL("src/assets/report-template.xlsx");
  const files: ZipFiles = openXlsx(new Uint8Array(await (await fetch(url)).arrayBuffer()));

  // 브랜드검색 계약 raw 수집(없거나 실패 시 빈 목록) → 금주/전주 기간으로 각각 일할 계산.
  // 검색 비용 가산(금주/전주)·종합 섹션3·검색 섹션2 그룹 비용에 공통 사용.
  // 3-hop(캠페인→그룹→계약) 체인이라 앞에서 await로 막지 않고 promise로 시작해 비-brand 수집(디스플레이·
  // 키워드)과 동시 진행 — brand 값이 필요한 소비자에서만 각자 await(데이터 흐름은 동일, 시작만 앞당김).
  const brandP = fetchBrandContracts(cid)
    .catch((e) => {
      console.warn("[dv-ads/report] 브랜드 계약 조회 실패 → 빈 값", e);
      return [] as BrandRawContract[];
    })
    .then((brandRaw) => ({
      brandRaw, // 일자별 하루 단위 일할에 필요 (buildReportModel)
      brandCur: proratedBrand(brandRaw, range),
      brandPrev: proratedBrand(brandRaw, previousRange(range)),
    }));

  // 현재기간 디스플레이(GFA)는 1회만 호출해 종합 .total(buildReportModel)·유형별·캠페인별에 공유.
  // 공유 결과라 일시 오류로 디스플레이가 통째로 빠지지 않게 1회 재시도(전주 gfaSafe와 동일 정책) 후 빈 값.
  const emptyGfa: GfaData = { total: ZERO_METRICS, byType: [], byCampaign: [] };
  const displayDataP = (async (): Promise<GfaData> => {
    try {
      return await fetchGfaData(target.adAccountNo, cid, range);
    } catch (e1) {
      console.warn("[dv-ads/report] 디스플레이 유형별/캠페인별 1차 조회 실패 → 재시도", e1);
      try {
        return await fetchGfaData(target.adAccountNo, cid, range);
      } catch (e2) {
        console.warn("[dv-ads/report] 디스플레이 유형별/캠페인별 최종 실패 → 빈 값", e2);
        return emptyGfa;
      }
    }
  })();

  // 키워드 다차원 보고서는 파워링크·쇼핑검색이 attributes 동일 → 1회만 받아 유형별로 클라이언트 분배.
  const keywordReportP = fetchAdvancedReport({
    attributes: ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "expKeyword"], range, customerId: cid,
  });
  // 상품별은 별도 호출 — nccAdId는 expKeyword와 조합 불가(API exclusive 제약)라 위 보고서에 못 얹는다.
  // 소재 단위라 행이 많아(실측 1,478행) maxRows를 넉넉히. 접기는 buildProductGroups가 한다.
  const productReportP = fetchAdvancedReport({
    attributes: ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "nccAdId"], range, customerId: cid,
    maxRows: 20000,
  }).catch((e) => {
    console.warn("[dv-ads/report] 쇼핑검색 상품별 조회 실패 → 시트 제거", e);
    return { head: [], rows: [], totalResults: 0 } as AdvReportResult;
  });

  const [model, searchTypes, displayData, campGroups, keywordRes, productRes] = await Promise.all([
    (async () => {
      const { brandRaw, brandCur, brandPrev } = await brandP;
      return buildReportModel(target, range, meta, brandCur.total, brandPrev.total, displayDataP, brandRaw);
    })(),
    (async () => {
      const { brandCur } = await brandP;
      return fetchSummarySearchTypes(cid, range, brandCur.total);
    })(),
    displayDataP,
    (async () => {
      const { brandCur } = await brandP;
      return fetchCampaignGroups(cid, range, brandCur.byAdgroup);
    })(),
    keywordReportP,
    productReportP,
  ]);
  // 파워링크·쇼핑검색 둘 다 '검색어(expKeyword)' 기준 (등록 키워드 keyword 아님).
  const plKeywords = buildKeywordGroups(keywordRes, "파워링크", "expKeyword");
  const shKeywords = buildKeywordGroups(keywordRes, "쇼핑검색", "expKeyword");
  // 상품별 — 소재 성과 → 상품명 조인 → 상품명 기준 재합산 → 0.5% 접기 (순서 주의: 위 주석 참고)
  const productAdRows = buildProductAdRows(productRes, "쇼핑검색");
  const shProducts = buildProductRows(
    productAdRows,
    await resolveProductTitles(cid, productAdRows.map((a) => a.label)),
  );
  const displayTypes = displayData.byType;

  // 고정형
  fillFixedSheets(files, model);
  // 종합 그래프 제거 + 빈 영역(3~16) 숨김
  removeSheetDrawing(files, "xl/worksheets/sheet2.xml");
  writeText(files, "xl/worksheets/sheet2.xml", hideRowRange(readText(files, "xl/worksheets/sheet2.xml"), 3, 16));
  // 동적: 종합 유형별 / 검색광고 캠페인별 / 키워드
  renderSummaryTypes(files, searchTypes, displayTypes);
  // 종합 섹션2 일자별 삽입 — renderSummaryTypes 뒤에. 아래 섹션이 최종 위치에 있어야 한 번에 밀린다.
  insertSummaryDaily(files, model);
  renderCampaignSheet(files, "xl/worksheets/sheet3.xml", campGroups);
  renderKeywordSheet(files, "xl/worksheets/sheet5.xml", plKeywords);
  renderKeywordSheet(files, "xl/worksheets/sheet6.xml", shKeywords, "쇼핑검색 키워드별 성과");
  renderProductSheet(files, "xl/worksheets/sheet9.xml", shProducts, "쇼핑검색 상품별 성과");
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
    // 일자별 콤보 그래프(chart12)는 디스플레이_상세 시트를 참조한다. 그 시트가 제거되면 #REF!가
    // 되므로 그래프를 통째로 빼고 빈 자리는 숨긴다(종합 시트의 차트 자리 처리와 동일 패턴).
    if (!model.hasDisplayDetail) {
      removeSheetDrawing(files, DISPLAY_SHEET);
      writeText(files, DISPLAY_SHEET, hideRowRange(readText(files, DISPLAY_SHEET), 3, 13));
    }
  }

  // 비진행 매체 시트 제거. 디스플레이 시트는 디스플레이 미진행 시 제거.
  // 디스플레이_상세는 분해 수집 성공 시 유지. 키워드 시트는 데이터 없으면 제거.
  const toRemove: string[] = [];
  if (!model.hasDisplay) toRemove.push("디스플레이");
  if (!model.hasDisplayDetail) toRemove.push("디스플레이_상세");
  if (plKeywords.length === 0) toRemove.push("파워링크_키워드");
  if (shKeywords.length === 0) toRemove.push("쇼핑검색_키워드");
  if (shProducts.length === 0) toRemove.push("쇼핑검색_상품");
  if (toRemove.length > 0) removeSheets(files, toRemove);

  removeCalcChain(files); // stale 수식 캐시 제거 → 엑셀 "복구" 대화상자 방지
  forceRecalc(files);
  return buildXlsx(files);
}

// 프리셋 편의
export function buildRangeFromPreset(preset: ReportPreset, today: Date): DateRange {
  return rangeForPreset(preset, today);
}
