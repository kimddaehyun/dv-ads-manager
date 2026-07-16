/**
 * F-Brief 규칙 엔진 — 리포트 데이터에서 "말할 거리" 후보를 뽑는다. AI 미사용.
 *
 * 이 파일은 순수 함수만 담는다 — chrome API·DOM·네트워크 무의존. 그래서 테스트할 수 있고,
 * Supabase/AI 인프라 없이 먼저 만들어 쓸 수 있다(설계 §4 모듈 경계).
 *
 * 설계: docs/superpowers/specs/2026-07-16-f-brief-design.md §5
 */

import { type ReportMetrics } from "@/features/report/report-data";

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
