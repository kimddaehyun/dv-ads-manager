/**
 * F-Brief 규칙 엔진 — 리포트 데이터에서 "말할 거리" 후보를 뽑는다. AI 미사용.
 *
 * 이 파일은 순수 함수만 담는다 — chrome API·DOM·네트워크 무의존. 그래서 테스트할 수 있고,
 * Supabase/AI 인프라 없이 먼저 만들어 쓸 수 있다(설계 §4 모듈 경계).
 *
 * 설계: docs/superpowers/specs/2026-07-16-f-brief-design.md §5
 */

import { addMetrics, ZERO_METRICS, type ReportMetrics } from "@/features/report/report-data";
import { type KeywordGroup } from "@/features/report/report-variable";
import { type NamedMetrics } from "@/features/report/report-fill";

/** 노랑(유지) 구간의 하한 = 목표 x 이 비율. 임유엽 AE 로그(목표 800% / 노랑 600%대)에서 역산. */
export const YELLOW_FLOOR_RATIO = 0.75;

/**
 * ROAS 구간. 색칠과 후보 조건이 **이 함수 하나**를 공유한다 — 두 곳에 따로 쓰면 어긋난다.
 *
 * green  = 목표 달성. 순위 여유가 있으면 상향 여지.
 * yellow = 목표엔 못 미치나 유지할 만함. **하향 대상이 아니다.**
 * none   = 하향 검토.
 */
export type RoasBand = "green" | "yellow" | "none";

export function roasBand(roas: number, target: number): RoasBand {
  // 목표 미설정(0/음수)이면 판정 자체가 불가능 — 호출부가 후보를 만들지 않아야 한다.
  if (!Number.isFinite(target) || target <= 0) return "none";
  if (roas >= target) return "green";
  if (roas >= target * YELLOW_FLOOR_RATIO) return "yellow";
  return "none";
}

/** 광고수익률(%) = 매출액 / 총비용 x 100. 비용 0이면 0(0으로 나누기 방지). */
export function roasPct(m: ReportMetrics): number {
  if (m.cost <= 0) return 0;
  return (m.revenue / m.cost) * 100;
}

// ── 후보 추출 ──

/** 비용 임계 — 보고 로그 5건 중 4건이 "1만원 이상" 문구를 쓴다. */
export const COST_FLOOR = 10_000;

export type BriefKind =
  | "pastActionFollowUp"   // 지난 보고 조치의 이번 성과 추적 (2단계 §7)
  | "zeroConvKeyword"      // 비용 임계 이상인데 전환 0
  | "highRoasLowRank"      // 목표 달성인데 순위가 낮음 (Task 7)
  | "belowTargetKeyword"   // 전환은 있으나 none 구간
  | "belowTargetGroup"     // 그룹 집계 ROAS가 none 구간 (Task 12)
  | "genderBidSkew"        // 성별 간 ROAS 격차 (Task 13)
  | "ageBidSkew"           // 연령대 간 ROAS 격차 (Task 13)
  | "deviceBidSkew"        // PC/모바일 간 ROAS 격차 (Task 14)
  | "lowCtrAd"             // 노출은 충분한데 클릭률 낮은 파워링크 소재 (Task 15)
  | "hourWeekdaySkew"      // 시간대/요일 간 ROAS 격차 (Task 16)
  | "regionBidSkew"        // 지역(시도) 간 ROAS 격차 (Task 17)
  | "zeroConvPlacement"    // 지면 비용 임계 이상인데 전환 0
  | "lowRoasPlacement"     // 지면 전환은 있으나 none 구간 (Task 12)
  | "productConvDrop"      // 전기 대비 전환 빠진 상품 (Task 8)
  | "changeFollowUp";      // 우리 팀 변경 이력 + 이후 성과 평가 (구조 개편 2차)

/** AE가 고르는 액션. AI가 창작하지 않는다 — 완전자동 모드에서도 이 목록에서만 고른다. */
export type BriefAction = "raise" | "hold" | "lower" | "exclude" | "ask" | "custom";

export interface BriefTableRow {
  cells: string[];
  /** ROAS 구간(참고용). 색칠에는 더 이상 쓰지 않는다 — problem이 색칠 기준. */
  band?: RoasBand;
  /** 이 후보를 발화시킨(문제인) 행 — 표에서 이 행만 강조한다. */
  problem?: boolean;
}

/** 표 명세 — brief-table.ts가 이것만 보고 그린다. 규칙 로직을 알 필요가 없다. */
export interface BriefTableSpec {
  title: string;
  columns: string[];
  rows: BriefTableRow[];
}

/** 이력 저장용 대상 스냅샷 — 표(문자열)와 달리 숫자 그대로. 다음 보고의 비교 계산 재료(설계 §7). */
export interface BriefTargetSnapshot {
  label: string;
  cost: number;
  revenue: number;
  purchaseConv: number;
  clicks: number;
  impressions: number;
  /** 광고관리자 바로가기용 — 그룹 단위 후보에만 채워진다(jsonb 저장이라 additive 호환). */
  nccCampaignId?: string;
  nccAdgroupId?: string;
}

/** 이슈가 속한 광고그룹 — 없으면 계정 공통(이력·변경·상품) 이슈. 선택 화면 계층의 기준. */
export interface BriefScope {
  campaign: string;
  group: string;
  nccCampaignId?: string;
  nccAdgroupId?: string;
}

/**
 * 광고그룹 하나의 차원별 성과 묶음 — 계정 합산은 그룹 특성이 섞여 부정확해(2026-07-20 개편)
 * 모든 세그먼트 판정은 이 단위로만 한다. byDay 라벨은 ISO(yyyy-mm-dd).
 */
export interface BriefGroupData {
  campaign: string;
  group: string;
  nccCampaignId: string;
  nccAdgroupId: string;
  byHour?: NamedMetrics[];
  byRegion?: NamedMetrics[];
  byDevice?: NamedMetrics[];
  byGender?: NamedMetrics[];
  byAge?: NamedMetrics[];
  byPlacement?: NamedMetrics[];
  byDay?: NamedMetrics[];
}

/** 파워링크 소재 1건(제목 조인 후) — 그룹 정보 포함. label = 소재 제목. */
export interface BriefAdRow {
  campaign: string;
  group: string;
  nccCampaignId: string;
  nccAdgroupId: string;
  label: string;
  metrics: ReportMetrics;
}

export interface BriefCandidate {
  kind: BriefKind;
  /** 이 이슈가 속한 캠페인 > 그룹. 없으면 계정 공통 이슈(이력·변경·상품). */
  scope?: BriefScope;
  /** 문구에 들어갈 사실. **AI에게는 이것만 전달된다** (설계 §3 2겹). */
  facts: Record<string, string | number>;
  /** 딸려나올 표. kind가 결정한다 — AE가 고르지 않는다. */
  table: BriefTableSpec;
  /** 조치 대상들의 수치 지표 — brief_history 저장 + 지난 조치 추적 비교용. */
  targets: BriefTargetSnapshot[];
  selected: boolean;
  action?: BriefAction;
  /** action === "custom"일 때만. */
  actionText?: string;
  /** kind === "changeFollowUp"일 때만 — 원본 변경이력 이벤트 id (이력 저장 추적용). */
  changeEventId?: string;
}

export interface BriefKeywordRow {
  keyword: string;
  campaign: string;
  group: string;
  metrics: ReportMetrics;
  /** 추정 순위. Task 7에서 채운다. 없으면 순위 후보를 만들지 않는다. */
  rank?: number;
}

export interface BriefRuleInput {
  keywords: KeywordGroup[];
  /** 계정별 목표 광고수익률(%). undefined면 구간 분류 후보를 만들지 않는다. */
  targetRoas?: number;
  /** 순위가 보강된 키워드 행. brief.ts가 pickRankTargets 대상만 rank를 채워 넘긴다. */
  rankedRows?: BriefKeywordRow[];
  /** 상품별 현재/전기 지표. 현재 기간에 존재하는 상품만(이름을 얻을 수 있는 것만). */
  products?: BriefProductDelta[];
  /** 파워링크 소재별 성과(그룹 정보 포함). 이름 못 얻은 소재는 이미 걸러져 온다. */
  plAds?: BriefAdRow[];
  /** 광고그룹별 차원 성과(지면/성별/연령/기기/시간대/지역/일자) — 세그먼트 판정의 유일한 재료. */
  groups?: BriefGroupData[];
  /** "캠페인 > 그룹" 라벨 → id. 키워드 계열 후보의 scope id 보강 재료. */
  groupIds?: Map<string, { campaignId: string; adgroupId: string }>;
  /** 이슈 판정 임계값 — 없으면 기본값(DEFAULT_THRESHOLDS). */
  thresholds?: BriefThresholds;
}

/** 매출 낙폭이 이 값 미만이면 후보로 안 만든다 — 소음 방지. */
export const REVENUE_DROP_FLOOR = 100_000;

/**
 * 이슈 판정 임계값 묶음 — 광고주별 커스텀(프리셋/자동 보정/직접 설정)의 단위.
 * 값의 출처는 brief-thresholds.ts가 정하고, 규칙 엔진은 받은 값만 쓴다.
 */
export interface BriefThresholds {
  /** 키워드·지면·세그먼트 비용 문턱(원). */
  costFloor: number;
  /** 격차 임계 배수 — 좋은쪽 ROAS ≥ 나쁜쪽 x 이 값. */
  skewRatio: number;
  /** 소재 후보 노출 문턱(회). */
  adImpFloor: number;
  /** 클릭률 하한(%) — 미만이면 소재 교체 후보. */
  lowCtrPct: number;
  /** 이 순위 이상(숫자 큼)이면 "낮다". */
  lowRankFloor: number;
  /** 상품 매출 낙폭 문턱(원). */
  revenueDropFloor: number;
}

export interface BriefProductDelta {
  label: string;
  cur: ReportMetrics;
  prev: ReportMetrics;
}

/**
 * 리포트가 자잘한 행을 접어 만든 합계 행("기타 키워드"·"기타 매체")은 실체가 없어
 * 조치 대상이 될 수 없다 — 후보에서 제외한다(표에는 그대로 남는다).
 */
export const isFoldedRow = (label: string): boolean => /^기타(\s|$)/.test(label.trim());

/** 그룹 계층(캠페인 > 그룹 > 키워드)을 행 목록으로 평탄화. 캠페인/그룹을 각 행에 붙인다. */
export function flattenKeywords(groups: KeywordGroup[]): BriefKeywordRow[] {
  const out: BriefKeywordRow[] = [];
  for (const g of groups) {
    for (const k of g.keywords) {
      if (isFoldedRow(k.keyword)) continue;
      out.push({ keyword: k.keyword, campaign: g.campaign, group: g.group, metrics: k.metrics });
    }
  }
  return out;
}

const KW_COLUMNS = ["키워드", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"];

function toTarget(label: string, m: ReportMetrics): BriefTargetSnapshot {
  return { label, cost: m.cost, revenue: m.revenue, purchaseConv: m.purchaseConv, clicks: m.clicks, impressions: m.impressions };
}

function kwRow(r: BriefKeywordRow, target?: number, problem?: boolean): BriefTableRow {
  const roas = roasPct(r.metrics);
  return {
    problem,
    cells: [
      r.keyword,
      r.metrics.impressions.toLocaleString(),
      r.metrics.clicks.toLocaleString(),
      `${r.metrics.cost.toLocaleString()}원`,
      String(r.metrics.purchaseConv),
      `${r.metrics.revenue.toLocaleString()}원`,
      `${roas.toFixed(0)}%`,
    ],
    band: target != null ? roasBand(roas, target) : undefined,
  };
}

/** 비용 많이 쓴 순. 표는 상위가 먼저 보여야 한다. */
function byCostDesc<T extends { metrics: ReportMetrics }>(a: T, b: T): number {
  return b.metrics.cost - a.metrics.cost;
}

/** 이 순위 이상(숫자가 큼)이면 "낮다"고 본다. 로그의 "2페이지"는 PC 11위~지만 보수적으로 6위(설계 §14). */
export const LOW_RANK_FLOOR = 6;

/**
 * 순위를 조회할 키워드만 고른다 — **전체에 걸면 수백 회 호출이다.**
 * 비용 임계를 넘고 목표를 달성한(green) 키워드만. 실측 수십 개 수준.
 */
export function pickRankTargets(
  rows: BriefKeywordRow[],
  targetRoas?: number,
  th: BriefThresholds = DEFAULT_THRESHOLDS,
): BriefKeywordRow[] {
  if (targetRoas == null || targetRoas <= 0) return [];
  return rows.filter((r) =>
    r.metrics.cost >= th.costFloor && roasBand(roasPct(r.metrics), targetRoas) === "green",
  );
}

// ── 소재 클릭률 (Task 15) ──

/** 소재 후보의 노출 임계 — 이만큼 보여지고도 클릭이 안 나와야 "문구 문제"라 말할 수 있다. */
export const AD_IMP_FLOOR = 1_000;
/** 클릭률(%) 하한 — 이 미만이면 소재 문구 교체 후보. */
export const LOW_CTR_PCT = 0.5;

/** 클릭률(%) = 클릭 / 노출 x 100. 노출 0이면 0. */
export function ctrPct(m: ReportMetrics): number {
  if (m.impressions <= 0) return 0;
  return (m.clicks / m.impressions) * 100;
}

// ── 타게팅 격차(skew) 공통 — 성별/연령 (Task 13), 이후 기기/시간/지역도 이 판정을 쓴다 ──

/** 격차 임계 — 좋은쪽 ROAS가 나쁜쪽의 이 배수 이상이어야 후보(설계 §5 "격차 판정 공통 규칙"). */
export const SKEW_RATIO = 1.5;

/** 기본 임계값 세트 — 커스텀이 없을 때. (선언 순서상 모든 상수 뒤에 있어야 한다) */
export const DEFAULT_THRESHOLDS: BriefThresholds = {
  costFloor: COST_FLOOR,
  skewRatio: SKEW_RATIO,
  adImpFloor: AD_IMP_FLOOR,
  lowCtrPct: LOW_CTR_PCT,
  lowRankFloor: LOW_RANK_FLOOR,
  revenueDropFloor: REVENUE_DROP_FLOOR,
};

/** 가중치를 걸 수 없는 세그먼트(성별 "알 수 없음" 등)는 비교에서 뺀다. */
const UNKNOWN_SEGMENT = /알\s*수\s*없음|알수없음|기타/;

/**
 * 세그먼트 간 상대 격차 판정. 절대 성과가 아니라 **구간 간 비교**다 — 모든 계정에 늘 있는
 * 미세한 차이는 (a) 양쪽 비용 문턱 (b) 격차 임계로 거른다. 통과 못 하면 null.
 */
export function findSkew(
  segments: NamedMetrics[],
  th: BriefThresholds = DEFAULT_THRESHOLDS,
): { best: NamedMetrics; worst: NamedMetrics } | null {
  const comparable = segments.filter(
    (s) => s.metrics.cost >= th.costFloor && !UNKNOWN_SEGMENT.test(s.label),
  );
  if (comparable.length < 2) return null;
  const byRoas = [...comparable].sort((a, b) => roasPct(b.metrics) - roasPct(a.metrics));
  const best = byRoas[0];
  const worst = byRoas[byRoas.length - 1];
  // 전부 매출 0이면 0% vs 0% — 격차가 아니다(0 < 0x1.5가 false로 통과하는 함정).
  if (roasPct(best.metrics) <= 0) return null;
  if (roasPct(best.metrics) < roasPct(worst.metrics) * th.skewRatio) return null;
  return { best, worst };
}

const WEEKDAY_ORDER = ["월", "화", "수", "목", "금", "토", "일"];

/**
 * 그룹별 일자(ISO yyyy-mm-dd 라벨) 지표를 요일 7구간으로 접는다.
 * 요일 전용 attribute가 없어(2026-07-17 정찰) ymd 수집분을 접는다 — 추가 호출 없음.
 */
export function foldByWeekday(byDay: NamedMetrics[]): NamedMetrics[] {
  const map = new Map<string, ReportMetrics>();
  for (const d of byDay) {
    const t = new Date(`${d.label}T00:00:00`);
    if (Number.isNaN(t.getTime())) continue;
    const wd = WEEKDAY_ORDER[(t.getDay() + 6) % 7]; // getDay: 0=일 → 월요일 시작으로 회전
    map.set(wd, addMetrics(map.get(wd) ?? ZERO_METRICS, d.metrics));
  }
  return WEEKDAY_ORDER.filter((w) => map.has(w)).map((w) => ({ label: w, metrics: map.get(w)! }));
}

function segmentTable(
  title: string,
  dim: string,
  segments: NamedMetrics[],
  targetRoas?: number,
  problemLabels?: ReadonlySet<string>,
): BriefTableSpec {
  return {
    title,
    columns: [dim, "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
    rows: segments.map((s) => ({
      problem: problemLabels?.has(s.label) || undefined,
      cells: [
        s.label,
        s.metrics.impressions.toLocaleString(),
        s.metrics.clicks.toLocaleString(),
        `${s.metrics.cost.toLocaleString()}원`,
        String(s.metrics.purchaseConv),
        `${s.metrics.revenue.toLocaleString()}원`,
        `${roasPct(s.metrics).toFixed(0)}%`,
      ],
      band: targetRoas != null ? roasBand(roasPct(s.metrics), targetRoas) : undefined,
    })),
  };
}

function skewCandidate(
  kind: BriefKind,
  dim: string,
  segments: NamedMetrics[] | undefined,
  targetRoas: number | undefined,
  th: BriefThresholds,
  scope: BriefScope,
): BriefCandidate | null {
  if (!segments) return null;
  const skew = findSkew(segments, th);
  if (!skew) return null;
  return {
    kind,
    scope,
    facts: {
      캠페인: scope.campaign,
      광고그룹: scope.group,
      기준: `${dim} 간 수익률 차이 ${th.skewRatio}배 이상 - 효율 좋은 쪽 가중치 상향, 낮은 쪽 하향 검토`,
      좋은쪽: skew.best.label,
      좋은쪽수익률: `${roasPct(skew.best.metrics).toFixed(0)}%`,
      나쁜쪽: skew.worst.label,
      나쁜쪽수익률: `${roasPct(skew.worst.metrics).toFixed(0)}%`,
    },
    table: segmentTable(`${scope.campaign} > ${scope.group} - ${dim} 성과`, dim, segments, targetRoas, new Set([skew.worst.label])),
    targets: [
      toTarget(`${scope.campaign} > ${scope.group} > ${skew.best.label}`, skew.best.metrics),
      toTarget(`${scope.campaign} > ${scope.group} > ${skew.worst.label}`, skew.worst.metrics),
    ],
    selected: false,
  };
}

/** 지면별 성과 표 — 전환 0(③)과 저수익률(⑦) 지면 후보가 같은 표를 쓴다. 그룹 내 전체 지면 문맥 포함. */
function placementTable(
  title: string,
  placements: NamedMetrics[],
  targetRoas?: number,
  problemLabels?: ReadonlySet<string>,
): BriefTableSpec {
  return {
    title,
    columns: ["지면", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
    rows: [...placements].sort(byCostDesc).map((p) => ({
      problem: problemLabels?.has(p.label) || undefined,
      cells: [
        p.label,
        p.metrics.impressions.toLocaleString(),
        p.metrics.clicks.toLocaleString(),
        `${p.metrics.cost.toLocaleString()}원`,
        String(p.metrics.purchaseConv),
        `${p.metrics.revenue.toLocaleString()}원`,
        `${roasPct(p.metrics).toFixed(0)}%`,
      ],
      band: targetRoas != null ? roasBand(roasPct(p.metrics), targetRoas) : undefined,
    })),
  };
}

export function extractCandidates(input: BriefRuleInput): BriefCandidate[] {
  const { targetRoas } = input;
  const th = input.thresholds ?? DEFAULT_THRESHOLDS;
  const out: BriefCandidate[] = [];

  // 키워드 계열은 KeywordGroup에 이름만 있어 groupIds 맵으로 id를 보강한다.
  const scopeOf = (campaign: string, group: string): BriefScope => {
    const ids = input.groupIds?.get(`${campaign} > ${group}`);
    return { campaign, group, nccCampaignId: ids?.campaignId, nccAdgroupId: ids?.adgroupId };
  };

  // ── 키워드 규칙(①②④⑥) — 캠페인 > 그룹 단위. 각 그룹은 **그 그룹의 데이터로만** 판정한다
  // (2026-07-20 캠페인>그룹 개편 — 계정 전체 묶음 후보 폐기).
  for (const g of input.keywords) {
    const scope = scopeOf(g.campaign, g.group);
    const scoped = { 캠페인: g.campaign, 광고그룹: g.group };
    const gName = `${g.campaign} > ${g.group}`;
    const rows: BriefKeywordRow[] = g.keywords
      .filter((k) => !isFoldedRow(k.keyword))
      .map((k) => ({ keyword: k.keyword, campaign: g.campaign, group: g.group, metrics: k.metrics }));

    // ① 비용 임계 이상인데 전환 0인 키워드
    const zeroConv = rows.filter((r) => r.metrics.cost >= th.costFloor && r.metrics.purchaseConv === 0)
      .sort(byCostDesc);
    if (zeroConv.length > 0) {
      out.push({
        kind: "zeroConvKeyword",
        scope,
        facts: {
          ...scoped,
          기준: `광고비 ${th.costFloor.toLocaleString()}원 이상 소진, 구매완료 전환 0건`,
          keywords: zeroConv.map((r) => r.keyword).join(", "),
          count: zeroConv.length,
          비용합계: zeroConv.reduce((s, r) => s + r.metrics.cost, 0),
        },
        table: {
          title: `${gName} - 전환 0 키워드`,
          columns: KW_COLUMNS,
          rows: zeroConv.map((r) => kwRow(r, targetRoas, true)),
        },
        // 라벨에 그룹 경로 접두 — 같은 키워드가 여러 그룹에 있을 때 이력 추적 오매칭 방지(코덱스 리뷰 P2).
        targets: zeroConv.map((r) => toTarget(`${gName} > ${r.keyword}`, r.metrics)),
        selected: false,
      });
    }

    // ② 전환은 있으나 none 구간(하향 검토). 목표 미설정이면 판정 불가라 만들지 않는다.
    // 전환 0은 ①에서 이미 다뤘으므로 purchaseConv > 0으로 제외 — 중복 후보 방지.
    if (targetRoas != null && targetRoas > 0) {
      const below = rows.filter((r) =>
        r.metrics.cost >= th.costFloor &&
        r.metrics.purchaseConv > 0 &&
        roasBand(roasPct(r.metrics), targetRoas) === "none",
      ).sort(byCostDesc);
      if (below.length > 0) {
        out.push({
          kind: "belowTargetKeyword",
          scope,
          facts: {
            ...scoped,
            기준: `목표 수익률 ${targetRoas}% 미달`,
            keywords: below.map((r) => r.keyword).join(", "),
            count: below.length,
            비용합계: below.reduce((s, r) => s + r.metrics.cost, 0),
          },
          table: {
            title: `${gName} - 목표 수익률 ${targetRoas}% 미달 키워드`,
            columns: KW_COLUMNS,
            rows: below.map((r) => kwRow(r, targetRoas, true)),
          },
          targets: below.map((r) => toTarget(`${gName} > ${r.keyword}`, r.metrics)),
          selected: false,
        });
      }
    }

    // ④ 목표를 달성했는데 순위가 낮음 → 상향 여지. **F001 순위 + F-Report 효율 결합.**
    // 순위를 못 얻었으면(자격증명 미등록 등) rank가 undefined라 자연히 후보가 안 만들어진다.
    if (targetRoas != null && targetRoas > 0 && input.rankedRows) {
      const lowRank = input.rankedRows
        .filter((r) => r.campaign === g.campaign && r.group === g.group &&
          r.rank != null && r.rank >= th.lowRankFloor &&
          roasBand(roasPct(r.metrics), targetRoas) === "green")
        .sort(byCostDesc);
      if (lowRank.length > 0) {
        out.push({
          kind: "highRoasLowRank",
          scope,
          facts: {
            ...scoped,
            기준: `목표 수익률 ${targetRoas}% 달성, 추정 순위 ${th.lowRankFloor}위 이하`,
            keywords: lowRank.map((r) => r.keyword).join(", "),
            count: lowRank.length,
            평균순위: Math.round(lowRank.reduce((s, r) => s + (r.rank ?? 0), 0) / lowRank.length),
          },
          table: {
            title: `${gName} - 목표 달성, 순위 상승 여지 키워드`,
            columns: [...KW_COLUMNS, "추정순위"],
            rows: lowRank.map((r) => {
              const base = kwRow(r, targetRoas);
              return { ...base, cells: [...base.cells, `${r.rank}위`] };
            }),
          },
          targets: lowRank.map((r) => toTarget(`${gName} > ${r.keyword}`, r.metrics)),
          selected: false,
        });
      }
    }

    // ⑥ 그룹 합산 ROAS가 none — 키워드 개별(②)과 달리 그룹 전체 요약 후보.
    // 초록·노랑이 섞여도 **합산** ROAS가 기준 — 합산이 살아 있으면 만들지 않는다.
    // 합산 전환 0 그룹은 제외 — 그 키워드들은 이미 ①(zeroConvKeyword)이 다룬다.
    if (targetRoas != null && targetRoas > 0) {
      const gm = g.keywords.reduce((s, k) => addMetrics(s, k.metrics), ZERO_METRICS);
      if (gm.cost >= th.costFloor && gm.purchaseConv > 0 &&
        roasBand(roasPct(gm), targetRoas) === "none") {
        out.push({
          kind: "belowTargetGroup",
          scope,
          facts: {
            ...scoped,
            기준: `광고그룹 합산 수익률이 목표 ${targetRoas}%에 크게 미달`,
            비용합계: gm.cost,
            수익률: `${roasPct(gm).toFixed(0)}%`,
          },
          table: {
            title: `${gName} - 그룹 합산 성과`,
            columns: ["광고그룹", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
            rows: [{
              cells: [
                gName,
                gm.impressions.toLocaleString(),
                gm.clicks.toLocaleString(),
                `${gm.cost.toLocaleString()}원`,
                String(gm.purchaseConv),
                `${gm.revenue.toLocaleString()}원`,
                `${roasPct(gm).toFixed(0)}%`,
              ],
              problem: true,
            }],
          },
          targets: [{
            ...toTarget(gName, gm),
            nccCampaignId: scope.nccCampaignId,
            nccAdgroupId: scope.nccAdgroupId,
          }],
          selected: false,
        });
      }
    }
  }

  // ── 차원 규칙(③⑦⑧⑨⑪) — 그룹별 지면/성별/연령/기기/시간대/요일/지역. 전부 그 그룹 데이터로만. ──
  for (const gd of input.groups ?? []) {
    const scope: BriefScope = {
      campaign: gd.campaign, group: gd.group,
      nccCampaignId: gd.nccCampaignId, nccAdgroupId: gd.nccAdgroupId,
    };
    const scoped = { 캠페인: gd.campaign, 광고그룹: gd.group };
    const gName = `${gd.campaign} > ${gd.group}`;

    // ③ 지면 비용 임계 이상인데 전환 0
    const placements = gd.byPlacement ?? [];
    const zeroPlace = placements
      .filter((p) => p.metrics.cost >= th.costFloor && p.metrics.purchaseConv === 0 && !isFoldedRow(p.label))
      .sort(byCostDesc);
    if (zeroPlace.length > 0) {
      out.push({
        kind: "zeroConvPlacement",
        scope,
        facts: {
          ...scoped,
          기준: `광고비 ${th.costFloor.toLocaleString()}원 이상 소진, 구매완료 전환 0건`,
          placements: zeroPlace.map((p) => p.label).join(", "),
          count: zeroPlace.length,
          비용합계: zeroPlace.reduce((s, p) => s + p.metrics.cost, 0),
        },
        table: placementTable(`${gName} - 지면별 성과`, placements, targetRoas, new Set(zeroPlace.map((p) => p.label))),
        targets: zeroPlace.map((p) => toTarget(`${gName} > ${p.label}`, p.metrics)),
        selected: false,
      });
    }

    // ⑦ 지면 전환은 있으나 none 구간 — ③(전환 0)과 겹치지 않게 purchaseConv > 0만.
    if (targetRoas != null && targetRoas > 0) {
      const lowPlace = placements
        .filter((p) => p.metrics.cost >= th.costFloor && p.metrics.purchaseConv > 0 &&
          roasBand(roasPct(p.metrics), targetRoas) === "none" && !isFoldedRow(p.label))
        .sort(byCostDesc);
      if (lowPlace.length > 0) {
        out.push({
          kind: "lowRoasPlacement",
          scope,
          facts: {
            ...scoped,
            기준: `지면 수익률이 목표 ${targetRoas}%에 크게 미달`,
            placements: lowPlace.map((p) => p.label).join(", "),
            count: lowPlace.length,
            비용합계: lowPlace.reduce((s, p) => s + p.metrics.cost, 0),
          },
          table: placementTable(`${gName} - 지면별 성과`, placements, targetRoas, new Set(lowPlace.map((p) => p.label))),
          targets: lowPlace.map((p) => toTarget(`${gName} > ${p.label}`, p.metrics)),
          selected: false,
        });
      }
    }

    // ⑧⑨⑪ 세그먼트 격차 — 상대 격차라 목표 ROAS 없이도 동작(표 색칠에만 사용).
    const dims: Array<[BriefKind, string, NamedMetrics[] | undefined]> = [
      ["genderBidSkew", "성별", gd.byGender],
      ["ageBidSkew", "연령대", gd.byAge],
      ["deviceBidSkew", "기기", gd.byDevice],
      ["hourWeekdaySkew", "시간대", gd.byHour],
      ["hourWeekdaySkew", "요일", gd.byDay ? foldByWeekday(gd.byDay) : undefined],
      ["regionBidSkew", "지역", gd.byRegion],
    ];
    for (const [kind, dim, segs] of dims) {
      const c = skewCandidate(kind, dim, segs, targetRoas, th, scope);
      if (c) out.push(c);
    }
  }

  // ⑩ 노출은 충분한데 클릭률이 낮은 파워링크 소재 — 입찰이 아니라 **문구 교체** 후보.
  // 그룹 단위로, 그룹 안에서 **문구(제목)**별 합산 — 소재ID 단위로 두면 같은 문구가 중복
  // 표기되고 합산 CTR이 건강한 문구를 오탐한다(코덱스 리뷰 P2).
  if (input.plAds) {
    const adGroups = new Map<string, { scope: BriefScope; byLabel: Map<string, ReportMetrics> }>();
    for (const a of input.plAds) {
      let e = adGroups.get(a.nccAdgroupId);
      if (!e) {
        e = {
          scope: { campaign: a.campaign, group: a.group, nccCampaignId: a.nccCampaignId, nccAdgroupId: a.nccAdgroupId },
          byLabel: new Map(),
        };
        adGroups.set(a.nccAdgroupId, e);
      }
      e.byLabel.set(a.label, addMetrics(e.byLabel.get(a.label) ?? ZERO_METRICS, a.metrics));
    }
    for (const { scope, byLabel } of adGroups.values()) {
      const lowCtr = [...byLabel.entries()].map(([label, metrics]) => ({ label, metrics }))
        .filter((a) => a.metrics.impressions >= th.adImpFloor && ctrPct(a.metrics) < th.lowCtrPct)
        .sort((a, b) => b.metrics.impressions - a.metrics.impressions);
      if (lowCtr.length === 0) continue;
      out.push({
        kind: "lowCtrAd",
        scope,
        facts: {
          캠페인: scope.campaign,
          광고그룹: scope.group,
          기준: `노출 ${th.adImpFloor.toLocaleString()}회 이상, 클릭률 ${th.lowCtrPct}% 미만 - 소재 문구 교체 검토`,
          ads: lowCtr.map((a) => a.label).join(", "),
          count: lowCtr.length,
        },
        table: {
          title: `${scope.campaign} > ${scope.group} - 클릭률 낮은 소재`,
          columns: ["소재", "노출", "클릭", "클릭률", "총비용", "구매완료", "매출액"],
          rows: lowCtr.map((a) => ({
            problem: true,
            cells: [
              a.label,
              a.metrics.impressions.toLocaleString(),
              a.metrics.clicks.toLocaleString(),
              `${ctrPct(a.metrics).toFixed(2)}%`,
              `${a.metrics.cost.toLocaleString()}원`,
              String(a.metrics.purchaseConv),
              `${a.metrics.revenue.toLocaleString()}원`,
            ],
          })),
        },
        targets: lowCtr.map((a) => toTarget(`${scope.campaign} > ${scope.group} > ${a.label}`, a.metrics)),
        selected: false,
      });
    }
  }

  // ⑤ 전기 대비 전환이 빠진 상품 — 보고 로그의 "객단가 높은 [온열 찜질기]에서 전환이
  // 발생하지 않아"가 이것. 매출 낙폭 임계로 소음을 거른다.
  if (input.products) {
    const dropped = input.products
      .filter((p) =>
        p.cur.purchaseConv < p.prev.purchaseConv &&
        p.prev.revenue - p.cur.revenue >= th.revenueDropFloor,
      )
      .sort((a, b) => (b.prev.revenue - b.cur.revenue) - (a.prev.revenue - a.cur.revenue));
    if (dropped.length > 0) {
      out.push({
        kind: "productConvDrop",
        facts: {
          기준: "이전 기간 대비 구매완료 전환 감소",
          products: dropped.map((p) => p.label).join(", "),
          count: dropped.length,
          매출감소합계: dropped.reduce((s, p) => s + (p.prev.revenue - p.cur.revenue), 0),
        },
        table: {
          title: "상품별 성과 (이전 기간 대비)",
          columns: ["상품", "총비용", "구매완료", "이전 구매완료", "매출액", "이전 매출액", "수익률"],
          rows: dropped.map((p) => ({
            problem: true,
            cells: [
              p.label,
              `${p.cur.cost.toLocaleString()}원`,
              String(p.cur.purchaseConv),
              String(p.prev.purchaseConv),
              `${p.cur.revenue.toLocaleString()}원`,
              `${p.prev.revenue.toLocaleString()}원`,
              `${roasPct(p.cur).toFixed(0)}%`,
            ],
            band: targetRoas != null ? roasBand(roasPct(p.cur), targetRoas) : undefined,
          })),
        },
        targets: dropped.map((p) => toTarget(p.label, p.cur)),
        selected: false,
      });
    }
  }

  return out;
}
