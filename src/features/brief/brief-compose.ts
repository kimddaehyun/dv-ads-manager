/**
 * F-Brief AI 조립 클라이언트 — Edge Function 호출 + 숫자 검산 적용.
 *
 * 체크된 후보의 facts만 보낸다 — 리포트 전체를 보내지 않는다(설계 §3 2겹).
 * 검산은 차단하지 않고 numberWarning 표시만 — 판단은 AE에게(설계 §6.5).
 */

import { extractNumbers, verifyBlock } from "./brief-verify";
import { type BriefCandidate } from "./brief-rules";
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
}

export interface ComposedBlock {
  text: string;
  isAiJudgment: boolean;
  /** 검산 실패 — 우리가 안 준 숫자가 문장에 있다. 차단하지 않고 AE에게 표시만. */
  numberWarning: boolean;
}

async function loadToken(): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("로그인이 필요해요. 설정에서 로그인해 주세요");
  return accessToken;
}

export async function composeBlocks(req: ComposeRequest): Promise<ComposedBlock[]> {
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
    }),
  });
  if (res.status === 401) throw new Error("보고 문구 이용 코드가 올바르지 않아요. 확장 프로그램 설정에서 다시 확인해 주세요");
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

  return (data.blocks ?? []).map((b: { text: string; isAiJudgment?: boolean }) => ({
    text: b.text,
    isAiJudgment: b.isAiJudgment === true,
    numberWarning: !verifyBlock(b.text, allowed),
  }));
}
