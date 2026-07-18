/**
 * F-Brief 보고 이력 — 서버 저장/조회 (설계 §7).
 *
 * 저장은 원본 구조(kind/facts/action + 숫자 targets) — LLM용 가공 금지(프롬프트가 바뀌면
 * 과거 이력이 구형식이 된다). 소비는 그때그때 변환: AE 목록 화면 / 지난 조치 추적 후보.
 * 저장 시점은 "복사한 순간"이며 실패해도 복사를 막지 않는다(호출부 책임).
 */

import { getSupabase } from "@/shared/supabase";
import { type BriefCandidate, type BriefKind, type BriefAction, type BriefTargetSnapshot } from "./brief-rules";

export interface BriefHistoryAction {
  kind: BriefKind;
  facts: Record<string, string | number>;
  action?: BriefAction;
  actionText?: string;
  targets: BriefTargetSnapshot[];
}

export interface BriefTotals {
  cost: number;
  revenue: number;
  roas: number;
}

export interface BriefHistoryRecord {
  id: string;
  adAccountNo: number;
  advertiserName: string;
  /** YYYY-MM-DD */
  periodSince: string;
  periodUntil: string;
  /** 보낸 문구 전문 — 복사 시점의 편집 반영 텍스트. */
  message: string;
  actions: BriefHistoryAction[];
  snapshot: { totals: BriefTotals; prevTotals: BriefTotals };
  createdAt: string;
}

export function candidatesToActions(cands: BriefCandidate[]): BriefHistoryAction[] {
  return cands.map((c) => ({ kind: c.kind, facts: c.facts, action: c.action, actionText: c.actionText, targets: c.targets }));
}

/** 같은 id면 갱신(upsert) — 패널 1회당 레코드 1건, 재복사 시 최신 편집본으로 덮인다. */
export async function saveBriefHistory(rec: Omit<BriefHistoryRecord, "createdAt">): Promise<void> {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("로그인이 만료됐어요. 다시 로그인해 주세요");
  const { error } = await sb.from("brief_history").upsert({
    id: rec.id,
    user_id: session.user.id,
    ad_account_no: rec.adAccountNo,
    advertiser_name: rec.advertiserName,
    period_since: rec.periodSince,
    period_until: rec.periodUntil,
    message: rec.message,
    actions: rec.actions,
    snapshot: rec.snapshot,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.warn("[dv-ads/brief] 이력 저장 오류", error);
    throw new Error("보고 이력을 저장하지 못했어요");
  }
}

const EMPTY_TOTALS: BriefTotals = { cost: 0, revenue: 0, roas: 0 };

/** 이 계정의 이력 최신순. RLS로 본인 것만 온다. */
export async function fetchBriefHistory(adAccountNo: number, limit = 10): Promise<BriefHistoryRecord[]> {
  const { data, error } = await getSupabase()
    .from("brief_history")
    .select("id, ad_account_no, advertiser_name, period_since, period_until, message, actions, snapshot, created_at")
    .eq("ad_account_no", adAccountNo)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.warn("[dv-ads/brief] 이력 조회 오류", error);
    throw new Error("지난 보고를 불러오지 못했어요");
  }
  return (data ?? []).map((r) => ({
    id: r.id as string,
    adAccountNo: Number(r.ad_account_no),
    advertiserName: (r.advertiser_name as string) ?? "",
    periodSince: (r.period_since as string) ?? "",
    periodUntil: (r.period_until as string) ?? "",
    message: (r.message as string) ?? "",
    actions: (r.actions ?? []) as BriefHistoryAction[],
    snapshot: (r.snapshot && typeof r.snapshot === "object" && "totals" in (r.snapshot as object)
      ? r.snapshot
      : { totals: EMPTY_TOTALS, prevTotals: EMPTY_TOTALS }) as BriefHistoryRecord["snapshot"],
    createdAt: (r.created_at as string) ?? "",
  }));
}
