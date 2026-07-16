/**
 * F-Brief 규칙 엔진 — 리포트 데이터에서 "말할 거리" 후보를 뽑는다. AI 미사용.
 *
 * 이 파일은 순수 함수만 담는다 — chrome API·DOM·네트워크 무의존. 그래서 테스트할 수 있고,
 * Supabase/AI 인프라 없이 먼저 만들어 쓸 수 있다(설계 §4 모듈 경계).
 *
 * 설계: docs/superpowers/specs/2026-07-16-f-brief-design.md §5
 */

import { type ReportMetrics } from "@/features/report/report-data";
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
  | "zeroConvKeyword"      // 비용 임계 이상인데 전환 0
  | "highRoasLowRank"      // 목표 달성인데 순위가 낮음 (Task 7)
  | "belowTargetKeyword"   // 전환은 있으나 none 구간
  | "zeroConvPlacement"    // 지면 비용 임계 이상인데 전환 0
  | "productConvDrop";     // 전기 대비 전환 빠진 상품 (Task 8)

/** AE가 고르는 액션. AI가 창작하지 않는다 — 완전자동 모드에서도 이 목록에서만 고른다. */
export type BriefAction = "raise" | "hold" | "lower" | "exclude" | "ask" | "custom";

export interface BriefTableRow {
  cells: string[];
  /** 행 배경색. 없으면 무색. */
  band?: RoasBand;
}

/** 표 명세 — brief-table.ts가 이것만 보고 그린다. 규칙 로직을 알 필요가 없다. */
export interface BriefTableSpec {
  title: string;
  columns: string[];
  rows: BriefTableRow[];
}

export interface BriefCandidate {
  kind: BriefKind;
  /** 문구에 들어갈 사실. **AI에게는 이것만 전달된다** (설계 §3 2겹). */
  facts: Record<string, string | number>;
  /** 딸려나올 표. kind가 결정한다 — AE가 고르지 않는다. */
  table: BriefTableSpec;
  selected: boolean;
  action?: BriefAction;
  /** action === "custom"일 때만. */
  actionText?: string;
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
  placements: NamedMetrics[];
  /** 계정별 목표 광고수익률(%). undefined면 구간 분류 후보를 만들지 않는다. */
  targetRoas?: number;
  /** 순위가 보강된 키워드 행. brief.ts가 pickRankTargets 대상만 rank를 채워 넘긴다. */
  rankedRows?: BriefKeywordRow[];
  /** 상품별 현재/전기 지표. 현재 기간에 존재하는 상품만(이름을 얻을 수 있는 것만). */
  products?: BriefProductDelta[];
}

/** 매출 낙폭이 이 값 미만이면 후보로 안 만든다 — 소음 방지. */
export const REVENUE_DROP_FLOOR = 100_000;

export interface BriefProductDelta {
  label: string;
  cur: ReportMetrics;
  prev: ReportMetrics;
}

/** 그룹 계층(캠페인 > 그룹 > 키워드)을 행 목록으로 평탄화. 캠페인/그룹을 각 행에 붙인다. */
export function flattenKeywords(groups: KeywordGroup[]): BriefKeywordRow[] {
  const out: BriefKeywordRow[] = [];
  for (const g of groups) {
    for (const k of g.keywords) {
      out.push({ keyword: k.keyword, campaign: g.campaign, group: g.group, metrics: k.metrics });
    }
  }
  return out;
}

const KW_COLUMNS = ["키워드", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"];

function kwRow(r: BriefKeywordRow, target?: number): BriefTableRow {
  const roas = roasPct(r.metrics);
  return {
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
export function pickRankTargets(rows: BriefKeywordRow[], targetRoas?: number): BriefKeywordRow[] {
  if (targetRoas == null || targetRoas <= 0) return [];
  return rows.filter((r) =>
    r.metrics.cost >= COST_FLOOR && roasBand(roasPct(r.metrics), targetRoas) === "green",
  );
}

export function extractCandidates(input: BriefRuleInput): BriefCandidate[] {
  const { targetRoas } = input;
  const rows = flattenKeywords(input.keywords);
  const out: BriefCandidate[] = [];

  // ① 비용 임계 이상인데 전환 0인 키워드
  const zeroConv = rows.filter((r) => r.metrics.cost >= COST_FLOOR && r.metrics.purchaseConv === 0)
    .sort(byCostDesc);
  if (zeroConv.length > 0) {
    out.push({
      kind: "zeroConvKeyword",
      facts: {
        기준: `광고비 ${COST_FLOOR.toLocaleString()}원 이상 소진, 구매완료 전환 0건`,
        keywords: zeroConv.map((r) => r.keyword).join(", "),
        count: zeroConv.length,
        비용합계: zeroConv.reduce((s, r) => s + r.metrics.cost, 0),
      },
      table: {
        title: `광고비 ${COST_FLOOR.toLocaleString()}원 이상 · 전환 0 키워드`,
        columns: KW_COLUMNS,
        rows: zeroConv.map((r) => kwRow(r, targetRoas)),
      },
      selected: false,
    });
  }

  // ② 전환은 있으나 none 구간(하향 검토). 목표 미설정이면 판정 불가라 만들지 않는다.
  // 전환 0은 ①에서 이미 다뤘으므로 purchaseConv > 0으로 제외 — 중복 후보 방지.
  if (targetRoas != null && targetRoas > 0) {
    const below = rows.filter((r) =>
      r.metrics.cost >= COST_FLOOR &&
      r.metrics.purchaseConv > 0 &&
      roasBand(roasPct(r.metrics), targetRoas) === "none",
    ).sort(byCostDesc);
    if (below.length > 0) {
      out.push({
        kind: "belowTargetKeyword",
        facts: {
          기준: `목표 수익률 ${targetRoas}% 미달`,
          keywords: below.map((r) => r.keyword).join(", "),
          count: below.length,
          비용합계: below.reduce((s, r) => s + r.metrics.cost, 0),
        },
        table: {
          title: `목표 수익률 ${targetRoas}% 미달 키워드`,
          columns: KW_COLUMNS,
          rows: below.map((r) => kwRow(r, targetRoas)),
        },
        selected: false,
      });
    }
  }

  // ④ 목표를 달성했는데 순위가 낮음 → 상향 여지. **F001 순위 + F-Report 효율 결합.**
  // 순위를 못 얻었으면(자격증명 미등록 등) rank가 undefined라 자연히 후보가 안 만들어진다.
  if (targetRoas != null && targetRoas > 0 && input.rankedRows) {
    const lowRank = input.rankedRows
      .filter((r) => r.rank != null && r.rank >= LOW_RANK_FLOOR &&
        roasBand(roasPct(r.metrics), targetRoas) === "green")
      .sort(byCostDesc);
    if (lowRank.length > 0) {
      out.push({
        kind: "highRoasLowRank",
        facts: {
          기준: `목표 수익률 ${targetRoas}% 달성, 추정 순위 ${LOW_RANK_FLOOR}위 이하`,
          keywords: lowRank.map((r) => r.keyword).join(", "),
          count: lowRank.length,
          평균순위: Math.round(lowRank.reduce((s, r) => s + (r.rank ?? 0), 0) / lowRank.length),
        },
        table: {
          title: "목표 달성 · 순위 상승 여지 키워드",
          columns: [...KW_COLUMNS, "추정순위"],
          rows: lowRank.map((r) => {
            const base = kwRow(r, targetRoas);
            return { ...base, cells: [...base.cells, `${r.rank}위`] };
          }),
        },
        selected: false,
      });
    }
  }

  // ③ 지면 비용 임계 이상인데 전환 0
  const zeroPlace = input.placements
    .filter((p) => p.metrics.cost >= COST_FLOOR && p.metrics.purchaseConv === 0)
    .sort(byCostDesc);
  if (zeroPlace.length > 0) {
    out.push({
      kind: "zeroConvPlacement",
      facts: {
        기준: `광고비 ${COST_FLOOR.toLocaleString()}원 이상 소진, 구매완료 전환 0건`,
        placements: zeroPlace.map((p) => p.label).join(", "),
        count: zeroPlace.length,
        비용합계: zeroPlace.reduce((s, p) => s + p.metrics.cost, 0),
      },
      table: {
        title: "지면별 성과",
        columns: ["지면", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
        rows: [...input.placements].sort(byCostDesc).map((p) => ({
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
      },
      selected: false,
    });
  }

  // ⑤ 전기 대비 전환이 빠진 상품 — 보고 로그의 "객단가 높은 [온열 찜질기]에서 전환이
  // 발생하지 않아"가 이것. 매출 낙폭 임계로 소음을 거른다.
  if (input.products) {
    const dropped = input.products
      .filter((p) =>
        p.cur.purchaseConv < p.prev.purchaseConv &&
        p.prev.revenue - p.cur.revenue >= REVENUE_DROP_FLOOR,
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
        selected: false,
      });
    }
  }

  return out;
}
