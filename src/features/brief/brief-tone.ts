/**
 * AE 개인 말투 (T5.5) — 채팅 이력 원문 + AI가 뽑은 말투 프롬프트를 서버(brief_tone)에 저장.
 * 보고 compose 때는 서버가 JWT의 사용자 id로 tone_prompt를 직접 읽는다 — 클라이언트가
 * 프롬프트를 payload로 보내지 않는다(조작 방지). 여기는 설정 화면용 저장/조회만.
 */

import { getSupabase } from "@/shared/supabase";

export interface BriefToneRecord {
  samples: string;
  tonePrompt: string;
}

export async function loadBriefTone(): Promise<BriefToneRecord | null> {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return null;
  const { data, error } = await sb
    .from("brief_tone")
    .select("samples, tone_prompt")
    .eq("user_id", session.user.id)
    .maybeSingle();
  if (error) {
    console.warn("[dv-ads/brief] 말투 설정 조회 오류", error);
    return null;
  }
  if (!data) return null;
  return { samples: (data.samples as string) ?? "", tonePrompt: (data.tone_prompt as string) ?? "" };
}

export async function saveBriefTone(rec: BriefToneRecord): Promise<void> {
  const sb = getSupabase();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("로그인이 만료됐어요. 다시 로그인해 주세요");
  const { error } = await sb.from("brief_tone").upsert({
    user_id: session.user.id,
    samples: rec.samples,
    tone_prompt: rec.tonePrompt,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.warn("[dv-ads/brief] 말투 설정 저장 오류", error);
    throw new Error("말투 설정을 저장하지 못했어요");
  }
}
