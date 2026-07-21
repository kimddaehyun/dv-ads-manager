/**
 * 지난 조치 추적 후보 (설계 §7) — "지난 보고(7/10)에서 하향한 키워드 3개, 이번 광고비 -32%".
 *
 * 순수 함수: 서버 이력 + 현재 지표 맵만 받는다. 라벨 문자열 매칭(키워드/그룹/지면/상품/소재
 * 공통) — 키워드명이 바뀌면 추적이 끊긴다(허용된 한계). 비교 계산은 코드가 하고 AI에는
 * facts 숫자만 간다(3겹 방어 유지).
 */

import { type BriefCandidate, type BriefKeywordRow, type BriefTargetSnapshot } from "./brief-rules";
import { type BriefHistoryRecord } from "./brief-history";

const ACTION_LABEL: Record<string, string> = {
  raise: "상향", hold: "유지", lower: "하향", exclude: "제외", ask: "문의", custom: "조정",
};

function roasOf(t: BriefTargetSnapshot): number {
  return t.cost > 0 ? (t.revenue / t.cost) * 100 : 0;
}

/** 현재 기간의 라벨 → 지표 맵. 전체 키워드 행 + 후보 targets(지면·상품·소재 포함)로 구성. */
export function currentTargetMap(cands: BriefCandidate[], keywords: BriefKeywordRow[]): Map<string, BriefTargetSnapshot> {
  const map = new Map<string, BriefTargetSnapshot>();
  for (const r of keywords) {
    map.set(r.keyword, {
      label: r.keyword, cost: r.metrics.cost, revenue: r.metrics.revenue,
      purchaseConv: r.metrics.purchaseConv, clicks: r.metrics.clicks, impressions: r.metrics.impressions,
    });
  }
  for (const c of cands) for (const t of c.targets) if (!map.has(t.label)) map.set(t.label, t);
  return map;
}

export function buildFollowUpCandidate(
  history: BriefHistoryRecord,
  current: Map<string, BriefTargetSnapshot>,
): BriefCandidate | null {
  // 지난 보고에서 조치가 붙었던 대상 우선, 없으면(완전자동 등) 언급된 전 대상을 점검.
  const acted = history.actions.filter((a) => a.action != null);
  const pool = acted.length > 0 ? acted : history.actions;
  const rows: Array<{ then: BriefTargetSnapshot; now: BriefTargetSnapshot; actionLabel: string }> = [];
  const seen = new Set<string>();
  for (const a of pool) {
    for (const t of a.targets ?? []) {
      if (seen.has(t.label)) continue;
      const now = current.get(t.label);
      if (!now) continue;
      seen.add(t.label);
      rows.push({ then: t, now, actionLabel: a.action ? ACTION_LABEL[a.action] ?? "조정" : "점검" });
    }
  }
  if (rows.length === 0) return null;

  const day = history.periodUntil; // "지난 보고(7/10)" 표기 — 보고 대상 기간의 종료일
  const thenCost = rows.reduce((s, r) => s + r.then.cost, 0);
  const nowCost = rows.reduce((s, r) => s + r.now.cost, 0);
  const thenRoas = thenCost > 0 ? (rows.reduce((s, r) => s + r.then.revenue, 0) / thenCost) * 100 : 0;
  const nowRoas = nowCost > 0 ? (rows.reduce((s, r) => s + r.now.revenue, 0) / nowCost) * 100 : 0;

  return {
    kind: "pastActionFollowUp",
    facts: {
      기준: `지난 보고(${day})에서 조치한 항목의 이번 성과 비교`,
      지난보고일: day,
      대상: rows.map((r) => `${r.then.label}(${r.actionLabel})`).join(", "),
      count: rows.length,
      당시광고비: thenCost,
      이번광고비: nowCost,
      당시수익률: `${thenRoas.toFixed(0)}%`,
      이번수익률: `${nowRoas.toFixed(0)}%`,
    },
    table: {
      title: `지난 조치 항목 성과 (${day} 보고 대비)`,
      columns: ["항목", "조치", "당시 광고비", "이번 광고비", "당시 ROAS", "이번 ROAS"],
      rows: rows.map((r) => ({
        cells: [
          r.then.label,
          r.actionLabel,
          `${r.then.cost.toLocaleString()}원`,
          `${r.now.cost.toLocaleString()}원`,
          `${roasOf(r.then).toFixed(0)}%`,
          `${roasOf(r.now).toFixed(0)}%`,
        ],
      })),
    },
    targets: rows.map((r) => r.now),
    selected: false,
  };
}
