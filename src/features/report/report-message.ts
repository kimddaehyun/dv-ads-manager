/**
 * F-Report 문구 포함 생성 — 리포트 수집 결과를 요약해 광고주 안내 문구(카톡용)를 AI로 조립.
 *
 * brief-compose Edge Function의 `mode:"reportSummary"`를 호출한다. F-Brief와 달리
 * 규칙 엔진 없이 리포트 총계·캠페인별·상위 키워드만 보낸다 — 개별 행 데이터는 안 보낸다.
 */

import { getSupabase } from "@/shared/supabase";
import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { attachActionMenu, closeAllOpenDropdowns } from "@/shared/ui-dropdown";
import { showToast } from "@/shared/toast";
import { type ReportData } from "./report-build";
import { type NamedMetrics } from "./report-fill";
import {
  CAMPAIGN_TP_CODE, colIndex, fetchAdvancedReport, rowMetrics,
  type AdvReportFilter, type ReportMetrics,
} from "./report-data";
import { previousRange, type DateRange } from "./report-period";

// manifest.config.ts의 host_permissions와 동일 도메인이어야 한다 — 다르면 요청이 차단된다.
const FN_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co/functions/v1/brief-compose";

const won = (n: number) => `${Math.round(n).toLocaleString()}원`;
const roasOf = (m: ReportMetrics) => (m.cost > 0 ? `${((m.revenue / m.cost) * 100).toFixed(2)}%` : "-");
const ctrOf = (m: ReportMetrics) => (m.impressions > 0 ? `${((m.clicks / m.impressions) * 100).toFixed(2)}%` : "-");
const cpcOf = (m: ReportMetrics) => (m.clicks > 0 ? won(m.cost / m.clicks) : "-");
const convRateOf = (m: ReportMetrics) => (m.clicks > 0 ? `${((m.purchaseConv / m.clicks) * 100).toFixed(2)}%` : "-");
const orderValueOf = (m: ReportMetrics) => (m.purchaseConv > 0 ? won(m.revenue / m.purchaseConv) : "-");

// 문구 코멘트 재료는 파워링크·쇼핑검색만 — 브랜드검색/신제품검색·플레이스·파워컨텐츠는 제외
// (2026-07-22 사용자 결정: 계약·노출 기반이라 입찰 운영 코멘트 소재로 부적합). 성과 요약의
// 합계(totals)에는 그대로 포함된다. 디스플레이는 displayLines로 별도 유지.
const isCoreType = (t: string) => t.includes("파워링크") || t.includes("쇼핑검색");
// 저효율 코멘트에 한해 보조 매체를 다시 넣는다(2026-08-13) — 조치 방향이 다르기 때문:
// core(파워링크·쇼핑검색)는 주력이라 빼기 어려워 입찰가 조정만, sub(플레이스·파워컨텐츠)는
// 노출 제외나 별도 분리도 제안 가능. 브랜드검색/신제품검색은 여전히 어느 쪽에도 안 들어간다.
const isSubType = (t: string) => t.includes("플레이스") || t.includes("파워컨텐츠");

/**
 * 저효율 판정 금액 문턱 — 기간 총광고비의 1.5%(5천~20만, 천원 단위).
 * 고정 5천 원이면 큰 계정에서 소액 키워드가 보고에 올라온다. F-Brief `brief-thresholds.ts`의
 * 자동 보정과 같은 공식이되 하한만 5천 원(그쪽은 캠페인별이라 1만 원) — 규칙 엔진을
 * report 번들로 끌어오지 않으려고 import 대신 여기 둔다.
 */
function lowEffFloor(totalCost: number): number {
  if (!(totalCost > 0)) return 5_000;
  return Math.min(200_000, Math.max(5_000, Math.round((totalCost * 0.015) / 1_000) * 1_000));
}

/**
 * 성별 성과 재료 — 남녀 ROAS 격차가 뚜렷할 때만 만든다(없으면 빈 배열 → 문구에 성별 미등장).
 * 격차 판정을 AI에 맡기면 보고마다 기준이 흔들려서 여기서 자른다. 배수는 F-Brief `SKEW_RATIO`와 동일.
 * "알수없음"은 가중치를 걸 수 없는 구간이라 제외.
 */
const GENDER_SKEW_RATIO = 1.5;
function buildGenderLines(byGender: NamedMetrics[], floor: number): string[] {
  const male = byGender.find((r) => r.label === "남성");
  const female = byGender.find((r) => r.label === "여성");
  if (!male || !female) return [];
  // 한쪽만 집행된 그룹은 가중치 조정 대상이 아니다(비교 대조군 부재).
  if (male.metrics.cost < floor || female.metrics.cost < floor) return [];
  if (male.metrics.revenue === 0 && female.metrics.revenue === 0) return [];
  const roas = (m: ReportMetrics) => (m.cost > 0 ? m.revenue / m.cost : 0);
  const [hi, lo] = [roas(male.metrics), roas(female.metrics)].sort((a, b) => b - a);
  if (hi < lo * GENDER_SKEW_RATIO) return [];
  return [male, female].map((r) => `- ${r.label}: ${metricLine(r.metrics)}`);
}

function metricLine(m: ReportMetrics): string {
  return `광고비 ${won(m.cost)}, 전환매출 ${won(m.revenue)}, ROAS ${roasOf(m)}, 전환 ${m.purchaseConv.toLocaleString()}건`;
}

/**
 * 이전 기간 검색어별 지표 — "지난 조치 효과" 비교 재료. 수집 1회가 추가되므로
 * 문구 생성이 켜진 경우에만 호출한다(엑셀만 뽑는 경로에는 영향 없음). 실패는 null로
 * graceful — 비교 문단만 빠지고 문구 생성 자체는 진행된다.
 */
export async function collectPrevKeywordMetrics(
  customerId: number, range: DateRange, saCampaignIds?: string[] | null,
): Promise<Map<string, ReportMetrics> | null> {
  try {
    const prev = previousRange(range);
    // collectReportData의 키워드 수집과 동일한 필터/상한 (report-build.ts 주석 참조).
    // 캠페인 선택(saCampaignIds)도 동일하게 — 안 걸면 제외한 캠페인의 이전 기간 키워드가
    // 비교 기준에 섞여 "개선/처음 전환" 문구가 오분류된다 (codex P2, 2026-08-07).
    const filters = (tpCode: string): AdvReportFilter[] => [
      { type: "in", field: "nccCampaignTp", values: [tpCode] },
      { type: "bound", field: "salesAmt", operator: "gt", value: 0 },
      { type: "bound", field: "impCnt", operator: "gt", value: 0 },
      ...(saCampaignIds?.length ? [{ type: "in", field: "nccCampaignId", values: saCampaignIds } as const] : []),
    ];
    const fetchOne = (tpCode: string) => fetchAdvancedReport({
      attributes: ["nccCampaignTp", "nccCampaignId", "nccAdgroupId", "expKeyword"],
      range: prev, customerId, maxRows: 30000, filters: filters(tpCode),
    });
    const [pl, sh] = await Promise.all([
      fetchOne(CAMPAIGN_TP_CODE.파워링크),
      fetchOne(CAMPAIGN_TP_CODE.쇼핑검색),
    ]);
    // 접기(buildKeywordGroups) 전 **원본 행**으로 맵을 만든다 — 접으면 비용이 작은 키워드가
    // "기타 키워드"로 뭉개져 이전 기간에 없던 것처럼 보이고, 비교가 "처음 전환"으로 오분류된다.
    const map = new Map<string, ReportMetrics>();
    // 응답의 nccCampaignTp 셀은 필터 코드(SITE/SHOPPING)가 아니라 표시명이다(buildKeywordGroups 동일).
    for (const [res, tpLabel] of [[pl, "파워링크"] as const, [sh, "쇼핑검색"] as const]) {
      const idx = colIndex(res.head);
      for (const r of res.rows) {
        // 서버 필터가 조용히 안 먹었을 때 남의 유형이 섞이는 걸 막는 안전망(buildKeywordGroups와 동일)
        if ((r[idx["nccCampaignTp"]] ?? "").trim() !== tpLabel) continue;
        const kw = (r[idx["expKeyword"]] ?? "").trim();
        if (!kw || kw === "-") continue;
        const metrics = rowMetrics(r, idx);
        const acc = map.get(kw);
        map.set(kw, acc ? {
          impressions: acc.impressions + metrics.impressions,
          clicks: acc.clicks + metrics.clicks,
          cost: acc.cost + metrics.cost,
          purchaseConv: acc.purchaseConv + metrics.purchaseConv,
          revenue: acc.revenue + metrics.revenue,
          directConv: acc.directConv + metrics.directConv,
          indirectConv: acc.indirectConv + metrics.indirectConv,
        } : metrics);
      }
    }
    return map;
  } catch (e) {
    console.warn("[dv-ads/report] 이전 기간 키워드 조회 실패 → 비교 생략", e);
    return null;
  }
}

/** 수집 결과(ReportData) → 서버로 보낼 요약 payload. */
export function buildSummaryPayload(
  advertiser: string, data: ReportData, range: DateRange,
  prevKeywords?: Map<string, ReportMetrics> | null,
  targetRoas?: number | null,
) {
  const m = data.model;

  // 캠페인별: 유형 내 그룹 행을 캠페인 단위로 합산, 광고비 상위 8개만.
  // 키에 유형을 붙이는 건 동명 캠페인 충돌 방지용 — 문장 재료로는 이름과 유형을 분리해 보낸다
  // (유형을 이름에 섞으면 AI가 "[쇼핑검색광고] OO" 전체를 캠페인명으로 오해한다).
  const campMap = new Map<string, ReportMetrics>();
  const campLabel = new Map<string, string>();
  for (const g of data.campGroups) {
    if (!isCoreType(g.type)) continue;
    for (const r of g.rows) {
      const name = `${g.type}\u0000${r.campaign || r.group}`;
      campLabel.set(name, `캠페인 [${r.campaign || r.group}] (${g.type} 유형)`);
      const prev = campMap.get(name);
      campMap.set(name, prev ? {
        impressions: prev.impressions + r.metrics.impressions,
        clicks: prev.clicks + r.metrics.clicks,
        cost: prev.cost + r.metrics.cost,
        purchaseConv: prev.purchaseConv + r.metrics.purchaseConv,
        revenue: prev.revenue + r.metrics.revenue,
        directConv: prev.directConv + r.metrics.directConv,
        indirectConv: prev.indirectConv + r.metrics.indirectConv,
      } : r.metrics);
    }
  }
  const campaignLines = [...campMap.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 8)
    .map(([name, mm]) => `- ${campLabel.get(name)}: ${metricLine(mm)}`);

  // 전환매출 상위 키워드 5개 (파워링크+쇼핑검색 검색어 기준, 매출 있는 것만).
  // "기타 키워드"는 실존 키워드가 아니라 엑셀 표에서 자잘한 행을 접은 묶음(report-build.ts
  // foldMinorRows) — 문구에 키워드명으로 나가면 광고주가 없는 키워드를 보게 되므로 제외.
  const allKeywords = [...data.plKeywords, ...data.shKeywords]
    .flatMap((g) => g.keywords)
    .filter((k) => k.keyword !== "기타 키워드");
  const keywordLines = allKeywords
    .filter((k) => k.metrics.revenue > 0)
    .sort((a, b) => b.metrics.revenue - a.metrics.revenue)
    .slice(0, 5)
    .map((k) => `- 키워드 [${k.keyword}]: 전환매출 ${won(k.metrics.revenue)}, 광고비 ${won(k.metrics.cost)}, 전환 ${k.metrics.purchaseConv.toLocaleString()}건`);

  // 유형별 합계(파워링크/쇼핑검색/브랜드검색 등 + 디스플레이) — 비중·운영 방향 코멘트 재료.
  const typeLines = [
    ...data.searchTypes
      .filter((t) => isCoreType(t.label) && (t.metrics.cost > 0 || t.metrics.impressions > 0))
      .map((t) => `- ${t.label}: ${metricLine(t.metrics)}`),
    ...(m.displayCurrent.cost > 0 || m.displayCurrent.impressions > 0
      ? [`- 디스플레이: ${metricLine(m.displayCurrent)}`]
      : []),
  ];

  // 디스플레이(GFA) 캠페인별: 유형 내 캠페인 행을 펼쳐 광고비 상위 5개만. 없으면 빈 배열.
  const displayLines = data.displayData.byCampaign
    .flatMap((g) => g.rows.map((r) => ({ type: g.type, name: r.group, m: r.metrics })))
    .sort((a, b) => b.m.cost - a.m.cost)
    .slice(0, 5)
    .map((r) => `- 캠페인 [${r.name}] (디스플레이 - ${r.type}): ${metricLine(r.m)}`);

  // 저효율 = 문턱 이상 썼는데 전환이 0, 또는 목표 ROAS 미달(목표 미설정이면 전환 0만).
  // 목표를 계정 평균으로 자동 추정하지 않는다 — 계정이 통째로 부진한 달에 전부 "정상"이 된다
  // (F-Brief와 같은 원칙, brief/CLAUDE.md).
  const floor = lowEffFloor(m.totalCurrent.cost);
  const roasPct = (mm: ReportMetrics) => (mm.cost > 0 ? (mm.revenue / mm.cost) * 100 : 0);
  const isPoor = (mm: ReportMetrics) =>
    (mm.purchaseConv === 0 && mm.revenue === 0) || (targetRoas != null && roasPct(mm) < targetRoas);
  const isLowEff = (mm: ReportMetrics) => mm.cost >= floor && isPoor(mm);

  // 키워드 저효율 — 이전 기간 지표가 있으면 두 갈래로 나눠 보낸다(케이스마다 한 문단 유도).
  // 이전 기간에 없던 검색어는 비교 근거가 없어 "이번에만"에 넣는다(성급한 제외 제안 방지).
  const lowKeywords = allKeywords
    .filter((k) => isLowEff(k.metrics))
    .sort((a, b) => b.metrics.cost - a.metrics.cost);
  // 전환이 0이면 "전환 0건", 목표 미달이면 실제 전환·매출·ROAS를 실어 근거를 남긴다.
  const perfPart = (mm: ReportMetrics) =>
    mm.purchaseConv === 0 && mm.revenue === 0
      ? "전환 0건"
      : `전환 ${mm.purchaseConv.toLocaleString()}건, 전환매출 ${won(mm.revenue)}, ROAS ${roasOf(mm)}`;
  const curPart = (k: (typeof lowKeywords)[number]) =>
    `- 키워드 [${k.keyword}]: 이번 기간 광고비 ${won(k.metrics.cost)}, 클릭 ${k.metrics.clicks.toLocaleString()}회, ${perfPart(k.metrics)}`;
  const lowKeywordLines: string[] = [];
  const lowKeywordBothLines: string[] = [];
  const lowKeywordRecentLines: string[] = [];
  // 이전 기간 금액은 이전 기간 문턱으로 잰다 — 기간 사이에 계정 광고비가 크게 변하면
  // 현재 문턱으로 재는 순간 케이스가 뒤집힌다(codex P2, 2026-08-13).
  const prevFloor = lowEffFloor(m.totalPrev.cost);
  if (prevKeywords) {
    for (const k of lowKeywords) {
      const p = prevKeywords.get(k.keyword);
      if (p && p.cost >= prevFloor && isPoor(p)) {
        if (lowKeywordBothLines.length < 5) {
          lowKeywordBothLines.push(`${curPart(k)} / 이전 기간 광고비 ${won(p.cost)}, ${perfPart(p)}`);
        }
      } else if (lowKeywordRecentLines.length < 5) {
        // 이전 기간 집행이 문턱 미만이면 "그때는 좋았다"가 아니라 비교 근거가 없는 것 —
        // 숫자만 주면 AI가 "이전에 전환 N건 발생"으로 잘못 쓴다.
        const prevPart = !p
          ? "이전 기간 집행 없음"
          : p.cost < prevFloor
            ? `이전 기간 광고비 ${won(p.cost)}로 집행이 적어 비교 어려움`
            : `이전 기간 광고비 ${won(p.cost)}, ${perfPart(p)}`;
        lowKeywordRecentLines.push(`${curPart(k)} / ${prevPart}`);
      }
    }
  } else {
    // 이전 기간 조회 실패 — 비교 없이 기존 한 묶음으로 폴백(문구 생성 자체는 진행).
    lowKeywordLines.push(...lowKeywords.slice(0, 5).map(curPart));
  }

  // 광고그룹 저효율 — 매체별로 나눈다. 주력은 입찰가 조정, 보조는 제외/분리로 조치가 갈린다.
  const lowGroups = data.campGroups
    .flatMap((g) => g.rows.map((r) => ({ type: g.type, campaign: r.campaign, group: r.group, m: r.metrics })))
    .filter((r) => isLowEff(r.m))
    .sort((a, b) => b.m.cost - a.m.cost);
  const groupLine = (r: (typeof lowGroups)[number]) => {
    const inCamp = r.campaign ? ` (캠페인 [${r.campaign}] 소속, ${r.type} 유형)` : ` (${r.type} 유형)`;
    // perfPart 필수 — "전환 0건" 하드코딩이면 목표 ROAS 미달로 잡힌 그룹(전환은 있다)이
    // 전환 0건으로 나가 광고주에게 거짓 숫자가 간다 (codex P2, 2026-08-13).
    return `- 광고그룹 [${r.group}]${inCamp}: 광고비 ${won(r.m.cost)}, 클릭 ${r.m.clicks.toLocaleString()}회, ${perfPart(r.m)}`;
  };
  const lowGroupLines = lowGroups.filter((r) => isCoreType(r.type)).slice(0, 5).map(groupLine);
  const lowSubGroupLines = lowGroups.filter((r) => isSubType(r.type)).slice(0, 5).map(groupLine);

  // 정보성 검색어 판별은 서버 AI가 한다 — 업종마다 말이 달라 단어 목록을 코드에 두지 않는다.
  // 광고비 상위 50개: 정보성은 키워드마다 금액이 작고 수가 많아 모여야 문제가 된다(실제 AE 보고
  // 사례). 30개면 그 꼬리가 잘린다. 전체를 보내면 프롬프트가 길어져 소형 모델이 규칙을 흘린다.
  const infoCandidateLines = [...allKeywords]
    .sort((a, b) => b.metrics.cost - a.metrics.cost)
    .slice(0, 50)
    .map((k) => `- 키워드 [${k.keyword}]: 광고비 ${won(k.metrics.cost)}, 클릭 ${k.metrics.clicks.toLocaleString()}회, 전환 ${k.metrics.purchaseConv.toLocaleString()}건, 전환매출 ${won(k.metrics.revenue)}, ROAS ${roasOf(k.metrics)}`);

  const genderLines = buildGenderLines(m.byGender, floor);

  // 지난 조치 효과: 이전 기간엔 광고비를 썼는데 전환이 없다가 이번에 전환이 나온 키워드(개선),
  // 이전 기간엔 없다가 이번에 처음 전환이 나온 키워드(신규). 매출 큰 순 5개씩.
  const improvedLines: string[] = [];
  const newConvLines: string[] = [];
  if (prevKeywords) {
    const converted = allKeywords
      .filter((k) => k.metrics.purchaseConv > 0)
      .sort((a, b) => b.metrics.revenue - a.metrics.revenue);
    for (const k of converted) {
      const p = prevKeywords.get(k.keyword);
      if (p && p.cost > 0 && p.purchaseConv === 0 && improvedLines.length < 5) {
        improvedLines.push(
          `- 키워드 [${k.keyword}]: 이전 기간 광고비 ${won(p.cost)}에 전환 0건 → 이번 기간 전환 ${k.metrics.purchaseConv.toLocaleString()}건, 전환매출 ${won(k.metrics.revenue)}`,
        );
      } else if (!p && newConvLines.length < 5) {
        newConvLines.push(
          `- 키워드 [${k.keyword}]: 이번 기간 처음 전환 발생 - 전환 ${k.metrics.purchaseConv.toLocaleString()}건, 전환매출 ${won(k.metrics.revenue)}`,
        );
      }
    }
  }

  // 시작 각도 무작위 지정 — 같은 프롬프트가 모든 계정에 가면 도입이 한 형태로 수렴한다
  // (2026-07-22 "보고 문구가 다 똑같다" 피드백). 생성마다 다른 각도를 뽑아 서버가 도입에 쓴다.
  // 재생성만 해도 다른 각도가 나온다. 해당 데이터가 없는 각도면 서버 프롬프트가 다른 각도로 폴백.
  const ANGLES = [
    "이전 기간 대비 전체 광고비와 매출의 증감",
    "광고비 비중이 가장 큰 캠페인의 성과",
    "캠페인 유형별(파워링크/쇼핑검색/디스플레이) 비중과 역할",
    "효율이 가장 좋았던 키워드",
    "클릭률이나 평균클릭비용 등 효율 지표의 변화",
    "디스플레이 광고의 성과",
    "지난 기간 전환이 없다가 이번에 전환이 나온 키워드",
    "정보를 찾는 검색어와 바로 사려는 검색어의 성과 차이",
    "성별에 따른 성과 차이",
  ];
  const angleHint = ANGLES[Math.floor(Math.random() * ANGLES.length)];

  const cur = m.totalCurrent;
  const prev = m.totalPrev;

  // 인사말용 기간 표현 — "지난주 성과 공유드립니다"처럼 자연스러운 한 단어.
  const days = Math.round(
    (new Date(range.until).getTime() - new Date(range.since).getTime()) / 86_400_000,
  ) + 1;
  const periodDesc = days === 7 ? "지난주" : days >= 28 && days <= 31 ? "지난 한 달" : `최근 ${days}일`;

  return {
    advertiser,
    angleHint,
    periodDesc,
    // 미설정이면 빈 문자열 — 서버가 목표 블록을 통째로 빼고 전환 0건 기준으로만 말한다.
    targetRoasText: targetRoas != null ? `${targetRoas}%` : "",
    periodText: `${range.since.replace(/-/g, ".")} ~ ${range.until.replace(/-/g, ".")}`,
    totals: {
      광고비: won(cur.cost),
      전환매출: won(cur.revenue),
      ROAS: roasOf(cur),
      전환수: `${cur.purchaseConv.toLocaleString()}건`,
      노출: `${cur.impressions.toLocaleString()}회`,
      클릭: `${cur.clicks.toLocaleString()}회`,
      클릭률: ctrOf(cur),
      평균클릭비용: cpcOf(cur),
      전환율: convRateOf(cur),
      전환당매출: orderValueOf(cur),
    },
    prevTotals: {
      광고비: won(prev.cost),
      전환매출: won(prev.revenue),
      ROAS: roasOf(prev),
      전환수: `${prev.purchaseConv.toLocaleString()}건`,
      클릭률: ctrOf(prev),
      평균클릭비용: cpcOf(prev),
      전환율: convRateOf(prev),
      전환당매출: orderValueOf(prev),
    },
    typeLines,
    campaignLines,
    displayLines,
    keywordLines,
    lowKeywordLines,
    lowKeywordBothLines,
    lowKeywordRecentLines,
    lowGroupLines,
    lowSubGroupLines,
    infoCandidateLines,
    genderLines,
    improvedLines,
    newConvLines,
  };
}

export type ReportSummaryPayload = ReturnType<typeof buildSummaryPayload>;

/** Edge Function 호출 — 광고주 안내 문구 텍스트 반환. */
export async function composeReportMessage(payload: ReportSummaryPayload): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("로그인이 필요해요. 설정에서 로그인해 주세요");

  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: "reportSummary", ...payload }),
  });
  if (res.status === 401) throw new Error("로그인이 만료됐어요. 확장 프로그램 설정에서 다시 로그인해 주세요");
  if (!res.ok) throw new Error("리포트 문구를 만들지 못했어요. 잠시 후 다시 시도해 주세요");
  const json = await res.json();
  const message = typeof json.message === "string" ? json.message.trim() : "";
  if (!message) throw new Error("리포트 문구를 만들지 못했어요. 잠시 후 다시 시도해 주세요");
  return message;
}

/** 결과 다이얼로그 — 문구 미리보기 + 수정 + 복사. (단일 광고주) */
export function showReportMessageDialog(advertiserName: string, text: string): void {
  showReportMessagesDialog([{ name: advertiserName, text }]);
}

export interface ReportMessageItem {
  name: string;
  text: string;
}

/** 결과 다이얼로그 — 문구 미리보기 + 수정 + 복사. 여러 광고주면 드롭다운으로 전환(일괄 생성). */
export function showReportMessagesDialog(items: ReportMessageItem[]): void {
  if (items.length === 0) return;
  let current = 0;

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-confirm-backdrop";

  const card = document.createElement("div");
  card.className = "dvads-confirm-card dvads-report-msg-card";
  backdrop.appendChild(card);

  const header = document.createElement("div");
  header.className = "dvads-confirm-header";
  const title = document.createElement("div");
  title.className = "dvads-confirm-title";
  // "리포트 문구 (계정명)" — 계정명은 공용 강조 클래스(DV 주황). DESIGN.md "다이얼로그 제목 강조" 패턴.
  title.textContent = "리포트 문구 ";
  const accent = document.createElement("span");
  accent.className = "dvads-title-accent";
  accent.textContent = `(${items[0].name})`;
  title.appendChild(accent);
  header.appendChild(title);

  // 여러 광고주 — 계정명 자리가 드롭다운 박스로 바뀌고 클릭 시 전환 메뉴.
  // 박스 폭 고정 + chevron 우측 고정(이름 길이에 따라 안 움직임). 복사한 계정은 "(완료)" 파란 표기.
  const copied = new Set<number>();
  if (items.length > 1) {
    accent.textContent = "";
    accent.classList.add("dvads-report-msg-acct");
    accent.setAttribute("role", "button");
    accent.setAttribute("tabindex", "0");
    accent.setAttribute("aria-label", "광고주 선택");
    // role="button"인 span이라 키보드 활성화는 직접 연결 (Enter/Space -> click).
    accent.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        accent.click();
      }
    });
    const nameEl = document.createElement("span");
    nameEl.className = "dvads-report-msg-acct-name";
    nameEl.textContent = items[0].name;
    accent.appendChild(nameEl);
    // 표 정렬 chevron과 동일한 SVG (아래 방향).
    accent.insertAdjacentHTML(
      "beforeend",
      '<svg class="dvads-report-msg-chev" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6 L8 10 L12 6"/></svg>',
    );
    attachActionMenu({
      trigger: accent,
      items: () => items.map((it, i) => ({
        label: it.name,
        checked: i === current,
        suffix: copied.has(i) ? "(완료)" : undefined,
        onClick: () => {
          items[current].text = ta.value; // 보던 문구의 수정 내용 저장
          current = i;
          ta.value = items[i].text;
          nameEl.textContent = items[i].name;
        },
      })),
      ariaLabel: "광고주 선택",
      panelClass: "dvads-report-msg-acct-menu", // 패널 폭을 트리거 박스(220px)에 맞춤
    });
  }
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dvads-confirm-close";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);
  card.appendChild(header);

  const ta = document.createElement("textarea");
  ta.className = "dvads-report-msg-textarea";
  ta.value = items[0].text;
  ta.spellcheck = false;
  card.appendChild(ta);

  const actions = document.createElement("div");
  actions.className = "dvads-confirm-actions";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "dvads-btn dvads-btn-secondary";
  doneBtn.textContent = "닫기";
  actions.appendChild(doneBtn);
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "dvads-btn dvads-btn-primary";
  copyBtn.textContent = "복사";
  actions.appendChild(copyBtn);
  card.appendChild(actions);

  document.body.appendChild(backdrop);

  const teardown = () => {
    closeAllOpenDropdowns(); // 광고주 전환 드롭다운 패널이 열려 있으면 함께 정리
    backdrop.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      document.removeEventListener("keydown", onKey);
      teardown();
    }
  };
  document.addEventListener("keydown", onKey);
  wireBackdropDismiss(backdrop, () => {
    document.removeEventListener("keydown", onKey);
    teardown();
  });
  card.addEventListener("click", (e) => e.stopPropagation());
  closeBtn.addEventListener("click", () => { document.removeEventListener("keydown", onKey); teardown(); });
  doneBtn.addEventListener("click", () => { document.removeEventListener("keydown", onKey); teardown(); });
  copyBtn.addEventListener("click", () => {
    void navigator.clipboard.writeText(ta.value).then(
      () => {
        copied.add(current); // 전환 메뉴에 "(완료)" 표기 — 다음 populate 때 반영
        showToast({ message: "리포트 문구를 복사했어요", variant: "success" });
      },
      () => showToast({ message: "복사하지 못했어요. 문구를 직접 선택해 복사해 주세요", variant: "error" }),
    );
  });
}
