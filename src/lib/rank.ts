/**
 * F001 — 사용자 현재 입찰가 → 시장 1~10위 입찰가 비교 → 추정 순위 계산.
 *
 * 알고리즘 (보수적):
 *   추정 순위 = max(N) where market[N] ≤ userBid
 *   모두 미만이면 "out" (순위권 밖)
 *
 * 예:
 *   userBid 700, market { 1:680, 2:610, ... } → 700 ≥ 680 → "1"
 *   userBid 400, market { 3:440, 4:380, ... } → 400 < 440 이지만 400 ≥ 380 → "4"
 *   userBid 50,  market { 9:70, 10:70 }       → 50 < 70(10위) → "out"
 *
 * "보수적"의 의미: 동일 입찰가 구간이 여러 위치에 있을 때(예: 9위=70, 10위=70) 더 낮은 순위로 본다.
 * 실제 노출 순위는 입찰가 외에 품질지수·시간대·경쟁자 동시 변동 등 영향을 받으므로
 * 이 함수는 "추정"이며 실제와 ±1~2위 오차가 있을 수 있다.
 */

import { MAX_POSITION, type RankPosition } from "@/types/storage";

export type EstimatedRank = RankPosition | "out";

export function estimateRank(
  userBid: number,
  rankToBid: Partial<Record<RankPosition, number>>,
): EstimatedRank {
  if (!Number.isFinite(userBid) || userBid <= 0) return "out";
  // 1위부터 내려가며 첫 번째 "내 입찰가 ≥ 시장가" 찾음
  for (let r = 1; r <= MAX_POSITION; r++) {
    const marketBid = rankToBid[r as RankPosition];
    if (marketBid != null && userBid >= marketBid) {
      return r as RankPosition;
    }
  }
  return "out";
}
