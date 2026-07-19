/**
 * 변경 이력 기반 후보 (구조 개편 2차) — "우리 팀이 이렇게 바꿨고, 이후 성과가 이렇다".
 *
 * 순수 함수: 네이버 변경이력 원본 행 + 전/후 지표 맵만 받는다. change-watch의 판정 로직을
 * 역방향으로 쓴다(제외 목록이 아니라 포함 목록). 전/후 성과는 추가 API 호출 없이
 * 이미 수집된 전기/현기 지표를 라벨 문자열 매칭으로 잇는다 — 기간 중간 변경은 전/후 분할이
 * 불가능하므로 "판단 보류"(unknown)로 두고 AI가 성과를 단정하지 않게 한다(프롬프트 이중 방어).
 */

import {
  EVENT_LABEL,
  diffSummary,
  rowTime,
  type RawHistoryRow,
} from "@/features/change-watch/change-watch";
import type { BriefCandidate, BriefTargetSnapshot } from "./brief-rules";

/** 개선/하락 판정 임계 — 이후 ROAS가 이전 대비 ±이 비율을 넘어야 방향을 말한다. */
export const IMPACT_ROAS_RATIO = 0.1;
/** 후보 상한 — 대형 계정에서 변경이 많아도 보고 후보는 이만큼만(최신순). */
export const CHANGE_CANDIDATE_CAP = 8;

export interface BriefChangeEvent {
  id: string;
  actor: string;
  atMs: number;
  entityLabel: string;
  /** 대상 종류 한글 라벨 (키워드/광고그룹/...) */
  what: string;
  /** "키워드 - 입찰가 500원 -> 700원" 같은 사람이 읽는 한 줄. */
  summary: string;
}

export type BriefChangeImpactResult = "positive" | "negative" | "neutral" | "unknown";

export interface BriefChangeImpact {
  event: BriefChangeEvent;
  before: BriefTargetSnapshot | null;
  after: BriefTargetSnapshot | null;
  impact: BriefChangeImpactResult;
}

/** 우리 팀 작업자의 heroes 변경만 추출. actors가 비면 판별 불가 — 빈 배열. */
export function filterOurChanges(rows: RawHistoryRow[], actors: string[]): BriefChangeEvent[] {
  const ours = new Set(actors.map((a) => a.trim().toLowerCase()).filter((a) => a !== ""));
  if (ours.size === 0) return [];
  const out: BriefChangeEvent[] = [];
  for (const row of rows) {
    const eventType = row.eventType ?? "";
    if (!eventType.startsWith("ncc.heroes.")) continue;
    const actor = (row.actorDisplayName ?? "").trim();
    if (!actor || !ours.has(actor.toLowerCase())) continue;
    const ts = rowTime(row);
    if (!ts) continue;
    const what = EVENT_LABEL[eventType] ?? "설정";
    (row.objects ?? []).forEach((obj, i) => {
      const heroes = obj.data?.heroes;
      const entityLabel = obj.displayName || heroes?.nccAdgroupName || heroes?.nccCampaignName || "";
      if (!entityLabel) return;
      const diff = diffSummary(heroes?.before, heroes?.after);
      out.push({
        id: `${row.eventId ?? ts}:${i}`,
        actor,
        atMs: ts,
        entityLabel,
        what,
        summary: diff ? `${what} - ${diff}` : `${what} 변경`,
      });
    });
  }
  out.sort((a, b) => b.atMs - a.atMs || (a.id < b.id ? 1 : -1));
  return out;
}

function roasOf(t: BriefTargetSnapshot): number {
  return t.cost > 0 ? (t.revenue / t.cost) * 100 : 0;
}

/**
 * 변경 이벤트에 전/후 성과를 붙인다.
 * - 변경이 보고 기간 시작 이전 → 전기 지표 = before, 현기 지표 = after로 비교 가능.
 * - 기간 중간 변경 → 정밀 분할 불가, unknown.
 * - 라벨 매칭 실패(이름 변경·삭제) → unknown.
 */
export function evaluateChangeImpacts(
  events: BriefChangeEvent[],
  prev: Map<string, BriefTargetSnapshot>,
  current: Map<string, BriefTargetSnapshot>,
  periodStartMs: number,
): BriefChangeImpact[] {
  return events.map((event) => {
    const before = prev.get(event.entityLabel) ?? null;
    const after = current.get(event.entityLabel) ?? null;
    let impact: BriefChangeImpactResult = "unknown";
    if (event.atMs < periodStartMs && before && after && before.cost > 0 && after.cost > 0) {
      const b = roasOf(before);
      const a = roasOf(after);
      if (b > 0) {
        const delta = (a - b) / b;
        impact = delta > IMPACT_ROAS_RATIO ? "positive" : delta < -IMPACT_ROAS_RATIO ? "negative" : "neutral";
      }
    }
    return { event, before, after, impact };
  });
}

const IMPACT_LABEL: Record<BriefChangeImpactResult, string> = {
  positive: "개선",
  negative: "하락",
  neutral: "유지",
  unknown: "판단 보류",
};

function fmtDay(atMs: number): string {
  const d = new Date(atMs);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 변경 1건 = 후보 1개 (AE가 어느 변경을 보고에 담을지 개별 선택).
 * 같은 대상은 최신 변경 1건만, 전체는 CHANGE_CANDIDATE_CAP까지(최신순).
 */
export function buildChangeHistoryCandidates(impacts: BriefChangeImpact[]): BriefCandidate[] {
  const byEntity = new Map<string, BriefChangeImpact>();
  for (const im of impacts) {
    const prev = byEntity.get(im.event.entityLabel);
    if (!prev || im.event.atMs > prev.event.atMs) byEntity.set(im.event.entityLabel, im);
  }
  const picked = [...byEntity.values()]
    .sort((a, b) => b.event.atMs - a.event.atMs)
    .slice(0, CHANGE_CANDIDATE_CAP);

  return picked.map((im) => {
    const { event, before, after, impact } = im;
    const day = fmtDay(event.atMs);
    const facts: Record<string, string | number> = {
      기준: "우리 팀이 진행한 변경 내역과 이후 성과",
      변경일: day,
      변경자: event.actor,
      대상: event.entityLabel,
      변경내용: event.summary,
      평가: IMPACT_LABEL[impact],
    };
    if (impact !== "unknown" && before && after) {
      facts.이전수익률 = `${roasOf(before).toFixed(0)}%`;
      facts.이후수익률 = `${roasOf(after).toFixed(0)}%`;
      facts.이전광고비 = before.cost;
      facts.이후광고비 = after.cost;
    } else {
      facts.비고 = "변경 이후 기간이 짧거나 지표가 없어 성과 판단 보류";
    }
    const hasMetrics = impact !== "unknown" && before && after;
    return {
      kind: "changeFollowUp" as const,
      facts,
      table: {
        title: `변경 이력 (${day} ${event.entityLabel})`,
        columns: hasMetrics
          ? ["대상", "변경일", "변경내용", "이전 수익률", "이후 수익률", "평가"]
          : ["대상", "변경일", "변경내용", "평가"],
        rows: [
          {
            cells: hasMetrics
              ? [event.entityLabel, day, event.summary, `${roasOf(before).toFixed(0)}%`, `${roasOf(after).toFixed(0)}%`, IMPACT_LABEL[impact]]
              : [event.entityLabel, day, event.summary, IMPACT_LABEL[impact]],
          },
        ],
      },
      targets: after ? [after] : [],
      selected: false,
      changeEventId: event.id,
    };
  });
}
