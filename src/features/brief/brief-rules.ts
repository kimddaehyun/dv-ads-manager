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
  | "zeroConvKeyword"      // 비용 임계 이상인데 전환 0
  | "highRoasLowRank"      // 목표 달성인데 순위가 낮음 (Task 7)
  | "belowTargetKeyword"   // 전환은 있으나 none 구간
  | "belowTargetGroup"     // 그룹 집계 ROAS가 none 구간 (Task 12)
  | "genderBidSkew"        // 성별 간 ROAS 격차 (Task 13)
  | "ageBidSkew"           // 연령대 간 ROAS 격차 (Task 13)
  | "zeroConvPlacement"    // 지면 비용 임계 이상인데 전환 0
  | "lowRoasPlacement"     // 지면 전환은 있으나 none 구간 (Task 12)
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
  /** 성별 성과(검색광고). model.byGender를 그대로 넘긴다. */
  byGender?: NamedMetrics[];
  /** 연령대 성과(검색광고, 8구간). model.byAge를 그대로 넘긴다. */
  byAge?: NamedMetrics[];
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

// ── 타게팅 격차(skew) 공통 — 성별/연령 (Task 13), 이후 기기/시간/지역도 이 판정을 쓴다 ──

/** 격차 임계 — 좋은쪽 ROAS가 나쁜쪽의 이 배수 이상이어야 후보(설계 §5 "격차 판정 공통 규칙"). */
export const SKEW_RATIO = 1.5;

/** 가중치를 걸 수 없는 세그먼트(성별 "알 수 없음" 등)는 비교에서 뺀다. */
const UNKNOWN_SEGMENT = /알\s*수\s*없음|알수없음|기타/;

/**
 * 세그먼트 간 상대 격차 판정. 절대 성과가 아니라 **구간 간 비교**다 — 모든 계정에 늘 있는
 * 미세한 차이는 (a) 양쪽 비용 문턱 (b) 격차 임계로 거른다. 통과 못 하면 null.
 */
export function findSkew(segments: NamedMetrics[]): { best: NamedMetrics; worst: NamedMetrics } | null {
  const comparable = segments.filter(
    (s) => s.metrics.cost >= COST_FLOOR && !UNKNOWN_SEGMENT.test(s.label),
  );
  if (comparable.length < 2) return null;
  const byRoas = [...comparable].sort((a, b) => roasPct(b.metrics) - roasPct(a.metrics));
  const best = byRoas[0];
  const worst = byRoas[byRoas.length - 1];
  // 전부 매출 0이면 0% vs 0% — 격차가 아니다(0 < 0x1.5가 false로 통과하는 함정).
  if (roasPct(best.metrics) <= 0) return null;
  if (roasPct(best.metrics) < roasPct(worst.metrics) * SKEW_RATIO) return null;
  return { best, worst };
}

function segmentTable(title: string, dim: string, segments: NamedMetrics[], targetRoas?: number): BriefTableSpec {
  return {
    title,
    columns: [dim, "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
    rows: segments.map((s) => ({
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
  targetRoas?: number,
): BriefCandidate | null {
  if (!segments) return null;
  const skew = findSkew(segments);
  if (!skew) return null;
  return {
    kind,
    facts: {
      기준: `${dim} 간 수익률 격차 ${SKEW_RATIO}배 이상 — 효율 좋은 쪽 가중치 상향, 낮은 쪽 하향 검토`,
      좋은쪽: skew.best.label,
      좋은쪽수익률: `${roasPct(skew.best.metrics).toFixed(0)}%`,
      나쁜쪽: skew.worst.label,
      나쁜쪽수익률: `${roasPct(skew.worst.metrics).toFixed(0)}%`,
    },
    table: segmentTable(`${dim} 성과`, dim, segments, targetRoas),
    selected: false,
  };
}

/** 지면별 성과 표 — 전환 0(③)과 저수익률(⑦) 지면 후보가 같은 표를 쓴다. 전체 지면 문맥 포함. */
function placementTable(placements: NamedMetrics[], targetRoas?: number): BriefTableSpec {
  return {
    title: "지면별 성과",
    columns: ["지면", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
    rows: [...placements].sort(byCostDesc).map((p) => ({
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

  // ⑥ 그룹 집계 ROAS가 none — 키워드 개별(②)과 달리 그룹 단위 요약 후보.
  // 초록·노랑이 섞인 그룹은 **합산** ROAS가 기준이다 — 합산이 살아 있으면 그룹 후보를 만들지 않는다.
  if (targetRoas != null && targetRoas > 0) {
    // KeywordGroup 항목 하나가 이미 캠페인+그룹 단위다 — 이름으로 재집계하면 파워링크/쇼핑에
    // 같은 이름의 캠페인·그룹이 있을 때 지표가 합쳐지므로(코덱스 리뷰 P2) 항목별로 집계한다.
    // 합산 전환 0 그룹은 제외 — 그 키워드들은 이미 ①(zeroConvKeyword)이 다룬다.
    const badGroups = input.keywords
      .map((g) => ({
        campaign: g.campaign,
        group: g.group,
        metrics: g.keywords.reduce((s, k) => addMetrics(s, k.metrics), ZERO_METRICS),
      }))
      .filter((g) => g.metrics.cost >= COST_FLOOR && g.metrics.purchaseConv > 0 &&
        roasBand(roasPct(g.metrics), targetRoas) === "none")
      .sort(byCostDesc);
    if (badGroups.length > 0) {
      out.push({
        kind: "belowTargetGroup",
        facts: {
          기준: `광고그룹 합산 수익률이 목표 ${targetRoas}%에 크게 미달`,
          groups: badGroups.map((g) => `${g.campaign} > ${g.group}`).join(", "),
          count: badGroups.length,
          비용합계: badGroups.reduce((s, g) => s + g.metrics.cost, 0),
        },
        table: {
          title: `목표 수익률 ${targetRoas}% 미달 광고그룹`,
          columns: ["광고그룹", "노출", "클릭", "총비용", "구매완료", "매출액", "수익률"],
          rows: badGroups.map((g) => ({
            cells: [
              `${g.campaign} > ${g.group}`,
              g.metrics.impressions.toLocaleString(),
              g.metrics.clicks.toLocaleString(),
              `${g.metrics.cost.toLocaleString()}원`,
              String(g.metrics.purchaseConv),
              `${g.metrics.revenue.toLocaleString()}원`,
              `${roasPct(g.metrics).toFixed(0)}%`,
            ],
            band: roasBand(roasPct(g.metrics), targetRoas),
          })),
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
      table: placementTable(input.placements, targetRoas),
      selected: false,
    });
  }

  // ⑦ 지면 전환은 있으나 none 구간 — ③(전환 0)과 겹치지 않게 purchaseConv > 0만.
  if (targetRoas != null && targetRoas > 0) {
    const lowPlace = input.placements
      .filter((p) => p.metrics.cost >= COST_FLOOR && p.metrics.purchaseConv > 0 &&
        roasBand(roasPct(p.metrics), targetRoas) === "none")
      .sort(byCostDesc);
    if (lowPlace.length > 0) {
      out.push({
        kind: "lowRoasPlacement",
        facts: {
          기준: `지면 수익률이 목표 ${targetRoas}%에 크게 미달`,
          placements: lowPlace.map((p) => p.label).join(", "),
          count: lowPlace.length,
          비용합계: lowPlace.reduce((s, p) => s + p.metrics.cost, 0),
        },
        table: placementTable(input.placements, targetRoas),
        selected: false,
      });
    }
  }

  // ⑧⑨ 성별/연령 가중치 — 상대 격차라 목표 ROAS 없이도 동작한다(표 색칠에만 사용).
  const gender = skewCandidate("genderBidSkew", "성별", input.byGender, targetRoas);
  if (gender) out.push(gender);
  const age = skewCandidate("ageBidSkew", "연령대", input.byAge, targetRoas);
  if (age) out.push(age);

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
