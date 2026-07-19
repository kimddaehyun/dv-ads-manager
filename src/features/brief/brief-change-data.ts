/**
 * 변경 이력 fetch 계층 (구조 개편 2차) — change-watch의 이력 API를 재사용해
 * "우리 팀 작업자" 변경 이벤트만 가져온다. 실패해도 보고 흐름을 막지 않는다(후보 0개).
 */

import { fetchChangeHistory } from "@/features/change-watch/change-watch";
import { loadChangeWatchIdentity } from "@/features/multi-account/multi-account-storage";
import { filterOurChanges, type BriefChangeEvent } from "./brief-change-rules";

/** 조회 창을 기간 시작보다 이만큼 당긴다 — 직전 변경의 후속 평가까지 커버. */
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

export interface BriefChangeFetchResult {
  events: BriefChangeEvent[];
  /** 작업자 목록이 비어 판별 자체가 불가능했는지 — 선택 화면 토글 비활성 + 안내에 쓴다. */
  actorsMissing: boolean;
}

/**
 * @param sinceMs 보고 기간 시작(ms) — 실제 조회는 14일 전부터.
 * @param untilMs 보고 기간 끝(ms).
 */
export async function fetchBriefChangeEvents(
  customerId: number,
  sinceMs: number,
  untilMs: number,
): Promise<BriefChangeFetchResult> {
  const actors = await loadChangeWatchIdentity().catch(() => [] as string[]);
  if (actors.length === 0) return { events: [], actorsMissing: true };
  try {
    const rows = await fetchChangeHistory(customerId, sinceMs - LOOKBACK_MS, untilMs);
    return { events: filterOurChanges(rows, actors), actorsMissing: false };
  } catch (e) {
    console.warn("[dv-ads/brief] 변경이력 조회 실패 - 변경 이력 후보 없이 진행", e);
    return { events: [], actorsMissing: false };
  }
}
