/**
 * usage.ts — 기능 사용 횟수 기록 (관리자 사용량 집계용).
 *
 * fire-and-forget: 기록 실패가 기능 동작에 영향을 주면 안 된다 — 어떤 예외도 삼킨다.
 * AI 토큰은 여기가 아니라 Edge Function(brief-compose)이 서버에서 직접 기록한다.
 * 이벤트명은 서버 RPC(track_usage)의 화이트리스트와 일치해야 한다.
 */
import { getSupabase } from "./supabase";

export type UsageEvent =
  | "report_excel" // 리포트 엑셀 다운로드
  | "setup_excel" // 세팅안 엑셀 다운로드
  | "brief_generate" // 보고 문구 생성 완료
  | "history_report" // 관리이력 보고 텍스트 생성
  | "bid_change" // 입찰가 변경 성공
  | "asset_bulk" // 확장소재 일괄 등록 실행
  | "agency_check"; // 대행권 점검 실행

export function trackUsage(event: UsageEvent): void {
  try {
    void getSupabase()
      .rpc("track_usage", { p_event: event })
      .then(undefined, () => {});
  } catch {
    /* 기록 실패 무시 */
  }
}
