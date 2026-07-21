/**
 * F-Brief AI 조립 클라이언트 — Edge Function 호출 + 숫자 검산 적용.
 *
 * 체크된 후보의 facts만 보낸다 — 리포트 전체를 보내지 않는다(설계 §3 2겹).
 * 검산은 차단하지 않고 numberWarning 표시만 — 판단은 AE에게(설계 §6.5).
 * 보고 유형(사후보고/사전제안)·톤·지난 보고 요약은 구조 개편(선택 우선 흐름)에서 추가.
 */

import { extractNumbers, verifyBlock } from "./brief-verify";
import { type BriefCandidate } from "./brief-rules";
import { type BriefReportType, type BriefTone } from "./brief-history";
import { getSupabase } from "@/shared/supabase";

// manifest.config.ts의 host_permissions와 동일 도메인이어야 한다 — 다르면 요청이 차단된다.
const FN_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co/functions/v1/brief-compose";

export interface ComposeRequest {
  advertiser: string;
  periodText: string;
  totals: Record<string, string>;
  prevTotals: Record<string, string>;
  selected: BriefCandidate[];
  memo: string;
  reportType: BriefReportType;
  tone: BriefTone;
}

export interface ComposedBlock {
  text: string;
  isAiJudgment: boolean;
  /** 이 문단이 다루는 이슈 번호(1부터, 서버 [말할 것] 번호). 없으면 매칭 불가 문단. */
  factIndex?: number;
  /** 검산 실패 — 우리가 안 준 숫자가 문장에 있다. 차단하지 않고 AE에게 표시만. */
  numberWarning: boolean;
}

async function loadToken(): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("로그인이 필요해요. 설정에서 로그인해 주세요");
  return accessToken;
}

export interface ComposeResult {
  /** AI가 말투 샘플의 인사 습관대로 쓴 인사 한 줄. 비어 있으면 클라이언트 기본값 사용. */
  greeting: string;
  blocks: ComposedBlock[];
}

export async function composeBlocks(req: ComposeRequest): Promise<ComposeResult> {
  const token = await loadToken();
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      advertiser: req.advertiser,
      periodText: req.periodText,
      totals: req.totals,
      prevTotals: req.prevTotals,
      // 체크된 후보의 facts만. 리포트 전체를 보내지 않는다(설계 §3 2겹).
      facts: req.selected.map((c) => ({ facts: c.facts, action: c.action, actionText: c.actionText })),
      memo: req.memo,
      reportType: req.reportType,
      tone: req.tone,
    }),
  });
  if (res.status === 401) throw new Error("로그인이 만료됐어요. 확장 프로그램 설정에서 다시 로그인해 주세요");
  if (!res.ok) throw new Error("문구를 만들지 못했어요. 잠시 후 다시 시도해 주세요");

  const data = await res.json();

  // 허용 숫자 집합 = 우리가 보낸 모든 값에서 뽑은 숫자.
  const allowed = new Set<string>();
  for (const v of [...Object.values(req.totals), ...Object.values(req.prevTotals)]) {
    extractNumbers(String(v)).forEach((n) => allowed.add(n));
  }
  for (const c of req.selected) {
    for (const v of Object.values(c.facts)) {
      extractNumbers(String(v)).forEach((n) => allowed.add(n));
    }
  }
  extractNumbers(req.memo).forEach((n) => allowed.add(n));

  return {
    greeting: typeof data.greeting === "string" ? data.greeting.trim() : "",
    blocks: (data.blocks ?? []).map((b: { text: string; isAiJudgment?: boolean; factIndex?: unknown }) => ({
      text: b.text,
      isAiJudgment: b.isAiJudgment === true,
      factIndex: typeof b.factIndex === "number" && Number.isInteger(b.factIndex) ? b.factIndex : undefined,
      numberWarning: !verifyBlock(b.text, allowed),
    })),
  };
}

/** 채팅 이력 → AI 말투 프롬프트 생성 (T5.5). 광고주 데이터가 아니라 AE 본인의 글이다. */
export async function distillTone(samples: string): Promise<string> {
  const token = await loadToken();
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode: "distillTone", samples }),
  });
  if (res.status === 401) throw new Error("로그인이 만료됐어요. 확장 프로그램 설정에서 다시 로그인해 주세요");
  if (!res.ok) throw new Error("말투를 분석하지 못했어요. 잠시 후 다시 시도해 주세요");
  const data = await res.json();
  const prompt = typeof data.tonePrompt === "string" ? data.tonePrompt.trim() : "";
  if (!prompt) throw new Error("말투를 분석하지 못했어요. 채팅 이력을 조금 더 붙여넣어 주세요");
  return prompt;
}
