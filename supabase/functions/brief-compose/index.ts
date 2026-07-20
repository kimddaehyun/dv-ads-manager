// F-Brief AI 조립 — 사내 AE 전용. 사실 목록을 디브이 말투 문장으로 옮기기만 한다.
//
// AI는 "분석가"가 아니라 "번역기"다. 분석은 확장의 규칙 엔진이, 판단은 AE가 한다.
// 여기 오는 facts는 AE가 체크한 것만이다 — 안 보낸 건 지어낼 재료가 없다(설계 §3 2겹).
//
// 저장하지 않는다. 로그에 남기지 않는다 (광고주 데이터).

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
// 번역 작업이라 소형 모델로 충분 + 한국어 존댓말 강점. 설계는 2.5 Flash-Lite였으나
// 2026-07 신규 키에 제공 중단("no longer available to new users")되어 후속 정식판으로 교체.
const MODEL = "gemini-3.1-flash-lite";

// 실제 AE 보고 로그. 톤을 설명하지 말고 보여준다.
const TONE_SAMPLES = `
안녕하세요:)

지난 30일 동안 검색광고, GFA 포함

▶광고비 : 267,558원
▶전환매출액 : 1,660,420원
▶광고수익률 : 620.58%로 집계되었습니다.

지난 동기간 대비 매출은 약 34만 원 감소하였으며, 수익률 또한 862% > 621%로 하락하는 추세를 보였습니다.

다만, 이는 객단가가 높은 [온열 찜질기] 상품에서 전환이 발생하지 않아 전체 매출 및 수익률이 하락한 영향으로 판단됩니다.

이에, 우선 현재 입찰가를 유지하며 추이를 확인한 뒤, 지속적으로 성과가 저조할 경우 입찰가 조정 진행하겠습니다.
---
최근 30일간 광고비 1만 원 이상 소진되었으나 전환이 발생하지 않은 '대나무돗자리' 키워드는 저효율 그룹으로 이동하여 운영하고자 합니다.

다만, 전환이 발생한 주요 키워드들의 노출 순위가 2페이지로 다소 낮게 확인되어, 해당 그룹의 입찰가는 소폭 상향 조정하여 운영하겠습니다.
---
해당 캠페인의 경우 현재 목표 수익률 300% 미만으로 다소 저조한 것을 확인했습니다.

특히, 캠페인 총비용 절반 이상을 소진한 [#돋보기] 단독 키워드 그룹에서 수익률이 300% 미만으로 저조합니다.

이에, 추가적인 입찰가 하향 조정을 통해 수익률을 개선해 볼 수 있도록 하겠습니다.
`.trim();

const ACTION_LABEL: Record<string, string> = {
  raise: "입찰가 상향 조정",
  hold: "입찰가 유지 후 추이 확인",
  lower: "입찰가 하향 조정",
  exclude: "제외 처리",
  ask: "광고주 확인 요청",
};

// CORS — 콘텐츠 스크립트는 ads.naver.com 페이지 컨텍스트에서 fetch하므로(MV3),
// 브라우저 preflight(OPTIONS)와 응답의 CORS 헤더가 없으면 "Failed to fetch"로 죽는다.
// origin을 광고관리자로 좁힌다. 인증은 어차피 토큰 화이트리스트가 한다.
const CORS_HEADERS = {
  "access-control-allow-origin": "https://ads.naver.com",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  // 유저 컨텍스트 클라이언트로 JWT 검증 (credentials-vault와 동일 패턴)
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }
  const userId = userData.user.id;

  // service role 클라이언트로 승인 상태 확인 (RLS 우회는 검증 후에만)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("status")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr || profile?.status !== "approved") {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const body = await req.json();

  // ── 모드: 말투 프롬프트 생성 (T5.5) — AE 본인의 채팅 이력을 말투 규칙으로 요약 ──
  if (body.mode === "distillTone") {
    const samples = typeof body.samples === "string" ? body.samples.trim() : "";
    if (samples.length < 50) {
      return new Response(JSON.stringify({ error: "samples" }), {
        status: 400, headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }
    const distillPrompt = [
      "아래는 한 광고 대행사 AE가 광고주에게 실제로 보낸 보고 채팅 모음이다.",
      "이 사람의 말투를 다른 보고문 작성에 재사용할 수 있게 정리해라.",
      "",
      "[채팅 모음]",
      samples.slice(0, 8000),
      "",
      "[정리 형식 - 텍스트로만]",
      "1) 말투 규칙: 인사 방식, 자주 쓰는 어미(예: ~로 판단됩니다, ~하겠습니다), 존댓말 수준,",
      "   숫자 표기 습관, 문단 길이 습관을 항목당 한 줄로.",
      "2) 대표 예문: 채팅 모음에서 말투가 가장 잘 드러나는 문단 3~5개를 그대로 옮겨 적기.",
      "채팅에 없는 표현을 지어내지 마라. 설명이나 머리말 없이 정리 내용만 출력해라.",
    ].join("\n");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: distillPrompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2000 },
      }),
    });
    if (!res.ok) {
      console.error("gemini error", res.status);
      return new Response(JSON.stringify({ error: "upstream" }), {
        status: 502, headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }
    const data = await res.json();
    const tonePrompt = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return new Response(JSON.stringify({ tonePrompt }), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const facts = (body.facts ?? []) as Array<Record<string, unknown>>;
  if (facts.length === 0 && !body.memo) {
    return new Response(JSON.stringify({ blocks: [] }), { headers: { "content-type": "application/json", ...CORS_HEADERS } });
  }

  const factLines = facts.map((f) => {
    const action = typeof f.action === "string" ? (f.actionText || ACTION_LABEL[f.action] || f.action) : "";
    const detail = Object.entries(f.facts ?? {}).map(([k, v]) => `${k}: ${v}`).join(" / ");
    return `- ${detail}${action ? ` → 액션: ${action}` : ""}`;
  });
  if (body.memo) factLines.push(`- AE 메모: ${body.memo}`);

  // AE 개인 말투 — brief_tone에 저장된 프롬프트가 있으면 그걸 쓰고, 없으면 기본 샘플.
  // 클라이언트 payload가 아니라 서버가 JWT의 사용자 id로 직접 읽는다(조작 방지).
  let toneSection = TONE_SAMPLES;
  try {
    const { data: toneRow } = await admin
      .from("brief_tone")
      .select("tone_prompt")
      .eq("user_id", userId)
      .maybeSingle();
    if (toneRow?.tone_prompt && String(toneRow.tone_prompt).trim() !== "") {
      toneSection = String(toneRow.tone_prompt).trim();
    }
  } catch (_) { /* 말투 조회 실패는 기본 샘플로 진행 */ }

  // 보고 유형 — 사후보고(이미 조치함) vs 사전제안(조치 전, 동의 요청). 기본은 사후보고.
  const isProposal = body.reportType === "pre_action_proposal";
  const typeLines = isProposal
    ? [
        "- 이번 보고는 **사전제안**이다: 아직 아무것도 수정하지 않았다.",
        "  '~한 상태입니다. ~해 볼 수 있도록 하겠습니다' 또는 '~조정 진행해도 괜찮을까요?' 같은",
        "  근거 + 제안 + 동의 요청 구조로 써라. '~했습니다' 같은 완료형 표현 금지.",
      ]
    : [
        "- 이번 보고는 **사후보고**다: 액션이 지정된 항목은 이미 조치를 끝낸 것이다.",
        "  '~하여 운영하고자 합니다 / ~조정하여 운영하겠습니다 / ~진행하였습니다' 같은 완료+계획 구조로 써라.",
      ];

  // 톤 — 어떤 톤이든 말투 샘플의 어미 범위 안에서만.
  const TONE_RULE: Record<string, string> = {
    short: "- 톤: 짧게 - 문단당 1~2문장, 수식어 최소화. 핵심 사실과 액션만.",
    detailed: "- 톤: 상세하게 - 근거 수치와 판단 이유를 문장으로 풀어서.",
    numeric: "- 톤: 숫자 중심 - 모든 주장 옆에 근거 숫자를 병기. 형용사 대신 수치로 말해라.",
    soft: "- 톤: 부드럽게 - 단정 대신 완곡한 표현(~로 보입니다 대신 ~로 판단됩니다, ~해 볼 수 있을 것 같습니다).",
    professional: "- 톤: 전문적으로 - 격식 있는 존댓말, 감탄사·이모티콘 없이.",
    friendly: "- 톤: 친근하게 - 딱딱하지 않게, 말투 샘플의 인사·구어체 습관을 살려서.",
  };
  const toneRule = TONE_RULE[String(body.tone ?? "")] ?? TONE_RULE.detailed;

  // 지난 보고 — 이어지는 보고로 쓰되 지난 수치를 새 수치처럼 재사용하지 않게.
  const prevReport = body.prevReport as { message?: string; actions?: Array<{ kind?: string; actionText?: string }> } | undefined;
  const prevLines = prevReport?.message
    ? [
        "",
        "[지난 보고]",
        String(prevReport.message).slice(0, 800),
        "- 지난 보고와 자연스럽게 이어지게 써라 (예: 지난번 안내드린 ~ 이후).",
        "- 지난 보고의 숫자를 이번 성과 숫자처럼 재사용하지 마라 - 비교 언급만 허용.",
      ]
    : [];

  const prompt = [
    "너는 디브이마케팅 AE다. 아래 말투로 광고주 보고 문구를 써라.",
    "",
    "[말투 샘플]",
    toneSection,
    "",
    "[이번 데이터]",
    `광고주: ${body.advertiser}`,
    `기간: ${body.periodText}`,
    `광고비 ${body.totals?.cost} / 전환매출 ${body.totals?.revenue} / ROAS ${body.totals?.roas}%`,
    `이전 기간 ROAS ${body.prevTotals?.roas}%`,
    "",
    "[말할 것]",
    ...factLines,
    ...prevLines,
    "",
    "[규칙]",
    "- 위에 준 사실 외에는 쓰지 마라. 시즌·트렌드 등 일반 상식을 끼워 넣지 마라.",
    "- 숫자를 바꾸지 마라. 위에 없는 숫자를 만들지 마라.",
    "- 인사말과 지표 요약은 쓰지 마라 — 이미 따로 만들었다. 진단과 액션만 써라.",
    "- 말할 것 하나당 문단 하나. 문단은 빈 줄로 구분.",
    "- em dash(—)를 쓰지 마라. 일반 하이픈(-)만.",
    "- 가운뎃점(·)을 쓰지 마라. 나열은 쉼표(,)로, 구분은 하이픈(-)으로.",
    ...typeLines,
    toneRule,
    "- 말투 샘플에 없는 상투어 금지: '흐름입니다', '~하는 모습입니다', '~로 보여집니다' 등을 쓰지 말고 샘플의 어미만 써라.",
    "- '지난 보고에서 조치한 항목의 이번 성과 비교' 항목은 당시/이번 숫자를 그대로 써서, 좋아졌으면 조치 결과 어조로, 나빠졌으면 아쉬움+새 계획 어조로 써라.",
    "- '우리 팀이 진행한 변경 내역과 이후 성과' 항목은 '지난 ~에 ~를 조정하였으며, 이후 ~한 것을 확인했습니다. 이에 ~하겠습니다' 구조로 써라. 평가가 '판단 보류'면 성과를 단정하지 말고 변경 사실만 전해라.",
    "",
    "JSON만 출력: {\"blocks\":[{\"text\":\"문단\",\"isAiJudgment\":true}]}",
    "isAiJudgment는 그 문단에 액션 선언·판단이 들어갔으면 true, 데이터 서술뿐이면 false.",
  ].join("\n");

  // Gemini generateContent. 키는 쿼리 파라미터로(헤더 x-goog-api-key도 가능).
  // responseMimeType: application/json으로 JSON만 받게 강제 — 코드펜스/설명문 혼입 방지.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2000, responseMimeType: "application/json" },
    }),
  });

  if (!res.ok) {
    console.error("gemini error", res.status); // 상태코드만 — 본문엔 광고주 데이터가 있다
    return new Response(JSON.stringify({ error: "upstream" }), {
      status: 502, headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  // responseMimeType로 JSON을 받지만, 방어적으로 첫 { ~ 마지막 } 만 취한다.
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? '{"blocks":[]}';
  return new Response(json, { headers: { "content-type": "application/json", ...CORS_HEADERS } });
});
