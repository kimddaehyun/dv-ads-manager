// F-Brief AI 조립 — 사내 AE 전용. 사실 목록을 디브이 말투 문장으로 옮기기만 한다.
//
// AI는 "분석가"가 아니라 "번역기"다. 분석은 확장의 규칙 엔진이, 판단은 AE가 한다.
// 여기 오는 facts는 AE가 체크한 것만이다 — 안 보낸 건 지어낼 재료가 없다(설계 §3 2겹).
//
// 저장하지 않는다. 로그에 남기지 않는다 (광고주 데이터).

const TOKENS = new Set((Deno.env.get("BRIEF_TOKENS") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !TOKENS.has(token)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { "content-type": "application/json" },
    });
  }

  const body = await req.json();
  const facts = (body.facts ?? []) as Array<Record<string, unknown>>;
  if (facts.length === 0 && !body.memo) {
    return new Response(JSON.stringify({ blocks: [] }), { headers: { "content-type": "application/json" } });
  }

  const factLines = facts.map((f) => {
    const action = typeof f.action === "string" ? (f.actionText || ACTION_LABEL[f.action] || f.action) : "";
    const detail = Object.entries(f.facts ?? {}).map(([k, v]) => `${k}: ${v}`).join(" / ");
    return `- ${detail}${action ? ` → 액션: ${action}` : ""}`;
  });
  if (body.memo) factLines.push(`- AE 메모: ${body.memo}`);

  const prompt = [
    "너는 디브이마케팅 AE다. 아래 말투로 광고주 보고 문구를 써라.",
    "",
    "[말투 샘플]",
    TONE_SAMPLES,
    "",
    "[이번 데이터]",
    `광고주: ${body.advertiser}`,
    `기간: ${body.periodText}`,
    `광고비 ${body.totals?.cost} / 전환매출 ${body.totals?.revenue} / ROAS ${body.totals?.roas}%`,
    `이전 기간 ROAS ${body.prevTotals?.roas}%`,
    "",
    "[말할 것]",
    ...factLines,
    "",
    "[규칙]",
    "- 위에 준 사실 외에는 쓰지 마라. 시즌·트렌드 등 일반 상식을 끼워 넣지 마라.",
    "- 숫자를 바꾸지 마라. 위에 없는 숫자를 만들지 마라.",
    "- 인사말과 지표 요약은 쓰지 마라 — 이미 따로 만들었다. 진단과 액션만 써라.",
    "- 말할 것 하나당 문단 하나. 문단은 빈 줄로 구분.",
    "- em dash(—)를 쓰지 마라. 일반 하이픈(-)만.",
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
      status: 502, headers: { "content-type": "application/json" },
    });
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  // responseMimeType로 JSON을 받지만, 방어적으로 첫 { ~ 마지막 } 만 취한다.
  const json = text.match(/\{[\s\S]*\}/)?.[0] ?? '{"blocks":[]}';
  return new Response(json, { headers: { "content-type": "application/json" } });
});
