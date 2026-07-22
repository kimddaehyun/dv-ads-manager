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

  // 사용량 기록 — Gemini usageMetadata의 토큰 수를 usage_daily에 누적(관리자 조회용).
  // 실패해도 본 응답에 영향 없어야 하므로 예외는 삼킨다. 광고주 데이터는 남기지 않는다(숫자만).
  const recordAiUsage = async (event: string, usage: unknown) => {
    try {
      const u = (usage ?? {}) as Record<string, unknown>;
      await admin.rpc("bump_usage", {
        p_user_id: userId,
        p_event: event,
        p_count: 1,
        p_tokens_in: typeof u.promptTokenCount === "number" ? u.promptTokenCount : 0,
        p_tokens_out: typeof u.candidatesTokenCount === "number" ? u.candidatesTokenCount : 0,
      });
    } catch (_) { /* 기록 실패 무시 */ }
  };

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
    await recordAiUsage("ai_tone", data.usageMetadata);
    const tonePrompt = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    return new Response(JSON.stringify({ tonePrompt }), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  // ── 모드: 리포트 안내 문구 (F-Report "문구 포함 생성") — 리포트 총계를 카톡 보고 문구로 ──
  // F-Brief와 달리 규칙 엔진 없이 총계·캠페인별·상위 키워드 요약만 받아 짧은 안내문을 만든다.
  if (body.mode === "reportSummary") {
    const t = (body.totals ?? {}) as Record<string, string>;
    const p = (body.prevTotals ?? {}) as Record<string, string>;
    const campaignLines = Array.isArray(body.campaignLines) ? body.campaignLines.slice(0, 10) : [];
    const displayLines = Array.isArray(body.displayLines) ? body.displayLines.slice(0, 10) : [];
    const typeLines = Array.isArray(body.typeLines) ? body.typeLines.slice(0, 10) : [];
    const improvedLines = Array.isArray(body.improvedLines) ? body.improvedLines.slice(0, 5) : [];
    const newConvLines = Array.isArray(body.newConvLines) ? body.newConvLines.slice(0, 5) : [];
    const keywordLines = Array.isArray(body.keywordLines) ? body.keywordLines.slice(0, 10) : [];
    const lowKeywordLines = Array.isArray(body.lowKeywordLines) ? body.lowKeywordLines.slice(0, 10) : [];
    const lowGroupLines = Array.isArray(body.lowGroupLines) ? body.lowGroupLines.slice(0, 10) : [];
    const periodDesc = typeof body.periodDesc === "string" && body.periodDesc ? body.periodDesc : "해당 기간";
    const summaryPrompt = [
      "너는 네이버 검색광고 대행사의 퍼포먼스 마케터야.",
      "아래 네이버 광고 데이터를 보고, 광고주(대표님)에게 카카오톡으로 보낼 성과 리포트 안내 문구를 작성해줘.",
      "",
      "[작성 규칙]",
      "1. 형식 - 아래 템플릿의 구조와 줄바꿈을 그대로 따라라. 빈 줄도 템플릿 그대로 넣어라.",
      "   (괄호)는 채워 넣을 자리이고, 분석 코멘트는 문장 1~2개마다 문단을 나누고 문단 사이에 빈 줄을 넣어라.",
      "",
      "===템플릿 시작===",
      "안녕하세요 대표님,",
      `${periodDesc} 네이버 광고 성과 공유드립니다.`,
      "",
      "■ 성과 요약",
      `- 기간: ${body.periodText}`,
      "- 광고비: (데이터 그대로)",
      "- 전환매출: (데이터 그대로)",
      "- ROAS: (데이터 그대로)",
      "- 전환수: (데이터 그대로)",
      "",
      "(분석 코멘트 - 2~3개 문단. 잘된 부분과 개선할 부분, 조치를 담되 순서와 문단 구성은 데이터에 맞게 자유롭게. 문단 사이에 빈 줄)",
      "",
      "자세한 데이터는 함께 보내드린 리포트 파일을 참고 부탁드립니다!",
      "===템플릿 끝===",
      "",
      "2. 분석 코멘트 기준:",
      "- 아래 예시는 실제 대행사 AE가 광고주에게 보내는 보고 화법이다. 이 어투를 따르되 문장 구조를 그대로 베끼지 말고, 매 보고마다 도입과 구성을 다르게 해라 (숫자와 이름은 이번 데이터의 것으로):",
      "  예시1) 전주 대비 전체 수익률이 개선되었으나, [OO] 캠페인에서는 구매전환이 발생하지 않았습니다. 해당 캠페인은 입찰가를 하향하여 보수적으로 운영하겠습니다.",
      "  예시2) [OO] 키워드는 광고비 3만 원에 매출 90만 원이 발생하여 효율이 준수합니다. 반면 [XX] 키워드는 클릭은 있으나 전환이 발생하지 않아 입찰가를 하향 조정하고 반응을 확인해 보겠습니다.",
      "  예시3) 지난 기간 전환이 없던 [OO] 키워드에서 이번 주 전환 3건이 발생했습니다. 다만 전체 매출은 이전 기간보다 감소한 상황입니다.",
      "- 서술어는 위 예시처럼 직설적인 것만 써라: 발생했습니다 / 발생하지 않았습니다 / 개선되었습니다 / 감소했습니다 / 저조합니다 / 준수합니다 / 유지 중입니다 / 운영 중입니다 / ~한 상황입니다.",
      "- 소설식 서술어 전면 금지: '성과를 이끌었습니다', '흐름을 보여주고 있습니다', '매출을 만들어내며', '~를 기록하며', '~하는 모습입니다' 같은 묘사체를 쓰지 마라. 사실과 숫자, 그리고 조치만 써라.",
      "- 코멘트 소재를 매번 '매출 상위 키워드 + 전환 없는 키워드' 조합으로만 고르지 마라. 데이터에서 실제로 눈에 띄는 각도를 골라라: 이전 기간 대비 광고비/매출/전환수 변화, 클릭률이나 평균클릭비용이나 전환율이나 전환당매출의 변화, 특정 캠페인 유형이 전체에서 차지하는 비중, 디스플레이 성과 등. 근거 숫자가 [데이터]에 있는 것만 말해라.",
      "- [지난 기간 대비 개선]이나 [이번 기간 처음 전환] 목록은 규모가 의미 있을 때만 언급해라(전환 1~2건짜리를 첫 문장에 올리지 마라). 언급하더라도 문단 중간이나 뒤에 넣어도 된다.",
      `- 첫 코멘트 문단은 "${typeof body.angleHint === "string" && body.angleHint ? body.angleHint : "이번 데이터에서 가장 두드러진 것"}" 각도에서 시작해라. 단, 그 각도의 근거 숫자가 [데이터]에 없거나 미미하면 다른 두드러진 각도로 시작해라.`,
      "- 캠페인명, 그룹명, 키워드명, 상품명을 언급할 때는 반드시 대괄호로 감싸라. 예: [전체상품 저입찰] 캠페인, [원피스] 키워드",
      "- 캠페인 유형(파워링크, 쇼핑검색광고, 브랜드검색, 플레이스, 파워컨텐츠, 디스플레이)은 이름이 아니다 - 대괄호로 감싸지 마라. '쇼핑검색광고의 [OO] 캠페인'처럼 유형은 풀어서 써라. [데이터]의 (X 유형) 표기가 유형이다.",
      "- 반드시 네이버 광고(검색광고, 디스플레이) 운영과 직접 관련된 내용만 작성",
      "- [디스플레이 캠페인별] 목록에 항목이 있으면 성과가 두드러진 것(좋든 나쁘든)을 코멘트에서 함께 짚어라. '디스플레이 광고의 [OO] 캠페인'처럼 언급해라. 목록이 (없음)이면 디스플레이는 언급하지 마라.",
      "- 캠페인별 ROAS 차이가 크면 구체적으로 언급",
      "- 특정 키워드가 매출 대부분을 차지하면 키워드명 언급",
      "- ROAS 낮을 때 다음 액션 예시: 입찰가 하향 조정, 저효율 키워드 제외, 소재 문구 수정, 확장소재 추가, 조정 후 데이터 확인 등",
      "- ROAS 양호할 때: 현재 세팅 유지하면서 데이터 확인, 주요 키워드 입찰가 조정 검토 등",
      "- 이전 기간 대비 변화가 있으면 간단히 언급",
      "- 광고비와 ROAS 증감 해석 주의: 광고비를 줄이면 ROAS가 오르는 것은 자연스러운 결과이니 '광고비가 줄었음에도 ROAS가 올랐다'는 식으로 성과처럼 쓰지 마라. 광고비가 줄었을 때 의미 있는 건 매출과 전환수가 유지됐는지다 - 매출이 유지됐으면 그걸 말하고, 매출도 같이 줄었으면 줄었다고 그대로 말해라. 반대로 광고비를 늘렸는데 ROAS가 유지되거나 올랐다면 그건 언급할 만한 성과다.",
      "- [저효율] 목록에 항목이 있으면 아쉬운 부분 문단에서 대표 1~2개를 이름과 함께 짚고 다음 액션을 붙여라. 목록을 다 나열하지는 마라",
      "- 쉽고 자연스러운 말투로, 카톡 메시지답게 작성",
      "",
      "3. 금지 사항 (절대 사용 금지):",
      "- 광고 외 내용 금지: 상세페이지 수정, 랜딩페이지 개선, 홈페이지 변경, 상품 구성 변경 등 광고 운영 외 제안 절대 금지",
      "- 어려운 표현 금지: 견인, 도모, 제고, 끌어올리다, 스케일업, 레버리지, 효율 극대화, 뒷받침, 기여했습니다 등 사용 금지. 쉬운 말로 바꿔서 쓸 것 (예: '매출 대부분이 [OO] 키워드에서 나왔습니다')",
      "- 스스로 평가하는 표현 금지: '보탬이 되었습니다', '긍정적인 변화가 있었습니다', '큰 역할을 했습니다', '유의미한 전환' 같은 자평을 붙이지 마라. 평가 없이 사실만 써라 - '전환이 발생했습니다', '매출 대부분이 여기서 나왔습니다'처럼. 잘됐는지는 숫자가 말하게 둬라.",
      "- 비유적, 문학적 표현 전면 금지: '탄탄하게 만들었습니다', '성과를 견고히 다졌습니다', '효자 노릇을 했습니다', '날개를 달았습니다' 같은 꾸미는 표현을 일절 쓰지 마라. 성과 서술은 '유지했습니다', '도움이 되었습니다', '~에서 매출 대부분이 나왔습니다'처럼 사실만 담백하게 써라. 확신이 없는 표현은 쓰지 말고 평이한 서술로 대체해라",
      "- 보장/확신 표현 금지: '끌어올리겠습니다', '개선하겠습니다', '높이겠습니다' 등 결과를 보장하는 표현 금지. 대신 '조정해 보겠습니다', '조정하고 지켜보겠습니다', '테스트해 보겠습니다', '확인해 보겠습니다' 등 사용",
      "- 마크다운 문법 금지. em dash(—) 금지, 하이픈(-)만. 가운뎃점(·) 금지",
      "- 분석 코멘트는 최대 3문단 - 길게 늘어놓지 마라",
      "- 불확실한 추측 금지",
      "- 'AI가 분석했습니다' 같은 표현 금지",
      "",
      "[데이터]",
      `- 업체명: ${body.advertiser}`,
      `- 기간: ${body.periodText}`,
      ...Object.entries(t).map(([k, v]) => `- ${k}: ${v}`),
      "",
      "[이전 기간]",
      ...Object.entries(p).map(([k, v]) => `- ${k}: ${v}`),
      "",
      "[캠페인 유형별 합계]",
      ...(typeLines.length > 0 ? typeLines : ["(없음)"]),
      "",
      "[지난 기간 대비 개선 - 이전 기간 전환이 없다가 이번에 전환이 나온 키워드]",
      ...(improvedLines.length > 0 ? improvedLines : ["(없음)"]),
      "",
      "[이번 기간 처음 전환이 발생한 키워드]",
      ...(newConvLines.length > 0 ? newConvLines : ["(없음)"]),
      "",
      "[캠페인별]",
      ...(campaignLines.length > 0 ? campaignLines : ["(없음)"]),
      "",
      "[디스플레이 캠페인별]",
      ...(displayLines.length > 0 ? displayLines : ["(없음)"]),
      "",
      "[전환매출 상위 키워드]",
      ...(keywordLines.length > 0 ? keywordLines : ["(없음)"]),
      "",
      "[저효율 - 광고비를 썼는데 전환이 없는 키워드]",
      ...(lowKeywordLines.length > 0 ? lowKeywordLines : ["(없음)"]),
      "",
      "[저효율 - 광고비를 썼는데 전환이 없는 광고그룹]",
      ...(lowGroupLines.length > 0 ? lowGroupLines : ["(없음)"]),
      "",
      "숫자는 제공된 데이터를 정확히 사용해. 임의로 반올림하거나 변경하지 마.",
      "설명이나 머리말, ===템플릿=== 표시 없이 카톡에 그대로 붙여넣을 문구만 출력해.",
      "줄바꿈과 빈 줄을 템플릿대로 반드시 유지해 - 한 덩어리로 이어 붙이지 마.",
      "마지막 점검: 뒷받침/견인/도모/제고/기여 같은 단어가 한 번이라도 들어갔으면 쉬운 말로 바꾼 뒤 출력해라.",
    ].join("\n");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
    const callGemini = async (text: string): Promise<string | null> => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text }] }],
          // 문구가 매번 비슷하다는 피드백(2026-07-22)으로 0.4 → 0.7 상향 - 표현 변주용.
          generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
        }),
      });
      if (!res.ok) {
        console.error("gemini error", res.status); // 상태코드만 — 본문엔 광고주 데이터가 있다
        return null;
      }
      const data = await res.json();
      await recordAiUsage("ai_report_msg", data.usageMetadata); // 고쳐쓰기 포함 Gemini 호출당 1회
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    };
    let message = await callGemini(summaryPrompt);
    if (message === null) {
      return new Response(JSON.stringify({ error: "upstream" }), {
        status: 502, headers: { "content-type": "application/json", ...CORS_HEADERS },
      });
    }
    // 금지 표현 검출 시 1회 고쳐쓰기 — 소형 모델이 목록 중간 규칙을 흘려버리는 일이 잦아
    // 프롬프트만으론 안 막힌다. 고쳐쓰기 실패(null)면 원문 유지(문구 자체는 유효하므로).
    const BANNED = /뒷받침|견인|도모|제고|스케일업|레버리지|기여했|탄탄하|탄탄히|탄탄해|견고히|견고하|효자 노릇|날개를 달|보탬|긍정적인 변화|큰 역할을|이끌었|흐름을 보여|만들어내며|보여주고 있습니다|하는 모습입니다/;
    if (BANNED.test(message)) {
      const rewritten = await callGemini([
        "아래 문구에서 '뒷받침, 견인, 도모, 제고, 스케일업, 레버리지, 기여했습니다, 탄탄하게, 견고히 다졌습니다, 성과를 이끌었습니다, 흐름을 보여주고 있습니다' 같은 비유적이거나 묘사적인 표현만 직설적인 서술(발생했습니다, 개선되었습니다, 저조합니다 등)로 바꿔라.",
        "예: '전체 효율을 뒷받침했습니다' → '전체 성과를 끌어올린 주요 요인이었습니다' 대신 '매출 대부분이 여기서 나왔습니다'처럼 평이하게.",
        "그 외의 문장, 숫자, 줄바꿈, 빈 줄은 절대 바꾸지 마라. 고친 전체 문구만 출력해라.",
        "",
        message,
      ].join("\n"));
      if (rewritten) message = rewritten;
    }
    return new Response(JSON.stringify({ message }), {
      headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const facts = (body.facts ?? []) as Array<Record<string, unknown>>;
  if (facts.length === 0 && !body.memo) {
    return new Response(JSON.stringify({ blocks: [] }), { headers: { "content-type": "application/json", ...CORS_HEADERS } });
  }

  // 번호는 클라이언트의 factIndex 매칭 기준 — 문단이 어느 표 앞에 붙을지 이 번호로 정해진다.
  const factLines = facts.map((f, i) => {
    const action = typeof f.action === "string" ? (f.actionText || ACTION_LABEL[f.action] || f.action) : "";
    const detail = Object.entries(f.facts ?? {}).map(([k, v]) => `${k}: ${v}`).join(" / ");
    return `${i + 1}. ${detail}${action ? ` → 액션: ${action}` : ""}`;
  });
  if (body.memo) factLines.push(`${facts.length + 1}. AE 메모: ${body.memo}`);

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

  const prompt = [
    "너는 네이버 광고 대행사의 마케터다. 아래 말투로 광고주 보고 문구를 써라.",
    "",
    "[말투 샘플]",
    toneSection,
    "",
    "[이번 데이터 - 참고용 맥락일 뿐, 이 총계를 문단으로 다시 서술하지 마라]",
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
    "- 인사말을 쓰지 마라 - 인사는 이미 따로 만들었다.",
    "- blocks에는 인사말과 지표 요약을 쓰지 마라 - '기간 성과를 전달드립니다', '광고비는 ~원, ROAS ~%를 기록했습니다' 같은 총계 소개 문단은 이미 따로 만들었다. 도입부 없이 각 '말할 것' 항목의 진단과 액션만 써라.",
    "- 캠페인명과 그룹명을 문장에 쓰지 마라 - 문단 위에 [캠페인 > 그룹] 제목이 따로 붙는다. '해당 그룹', '이 그룹의 ~ 지면'처럼만 지칭해라. 키워드명, 지면명, 구간명은 써도 된다.",
    "- 어려운 표현 금지: 견인, 도모, 제고, 레버리지, 스케일업, 효율 극대화 등은 쉬운 말로 바꿔 써라.",
    "- 결과를 보장하는 표현 금지: '개선하겠습니다', '높이겠습니다' 대신 '조정하고 지켜보겠습니다', '테스트해 보겠습니다'처럼 써라.",
    "- 광고 운영 외 제안 금지: 상세페이지, 홈페이지, 상품 구성 변경 등은 쓰지 마라.",
    "- 'AI가 분석했습니다' 같은 표현 금지. 마크다운 문법(별표, 샵 등) 금지.",
    "- 말할 것 하나당 문단 하나. 문단은 빈 줄로 구분.",
    "- 각 문단은 진단에서 조치로 자연스럽게 흐르는 2~3문장으로 써라. '진단', '조치' 같은 라벨이나 ▶ 기호는 붙이지 마라. 말투 샘플에 문단 길이 습관이 있으면 그것을 우선해라.",
    "- 진단: 무엇이 문제/기회인지 근거 숫자와 함께 서술해라 (예: [자전거스탠드] 키워드에서 11,110원의 광고비가 소진되었으나 구매 전환이 발생하지 않았습니다). 여러 구간은 쉼표로 짧게 나열해라.",
    "- 조치: '이에 따라', '따라서', '다만' 같은 연결어로 진단에 자연스럽게 이어서, 무엇을 했는지 존댓말로 써라 (예: 이에 따라 해당 키워드는 제외 처리하였습니다). 진단에 준 숫자 외의 새 숫자·판단 근거를 만들어 붙이지는 마라.",
    "- 키워드명, 지면명, 구간명은 [대괄호]로 감싸라.",
    "- em dash(—)를 쓰지 마라. 일반 하이픈(-)만.",
    "- 가운뎃점(·)을 쓰지 마라. 나열은 쉼표(,)로, 구분은 하이픈(-)으로.",
    ...typeLines,
    toneRule,
    "- 여러 문단을 쓸 때 같은 문장 패턴을 반복하지 마라 - '~이 소진되었으나 ~에 미달하였습니다'를 문단마다 똑같이 쓰지 말고 어미와 문장 구성을 다르게 써라.",
    "- 말투 샘플에 없는 상투어 금지: '흐름입니다', '~하는 모습입니다', '~로 보여집니다' 등을 쓰지 말고 샘플의 어미만 써라.",
    "- 지난 보고나 과거 조치를 언급하지 마라 - 이번 기간 데이터로만 말해라.",
    "",
    "JSON만 출력: {\"blocks\":[{\"factIndex\":1,\"text\":\"문단\",\"isAiJudgment\":true}]}",
    "factIndex는 그 문단이 다루는 [말할 것] 번호(정수).",
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
      // 이슈를 많이 고르면 문단이 많아진다 — 2000이면 JSON이 중간에 잘려 빈 blocks로
      // 떨어지는 사고(2026-07-21). 잘림 방지로 넉넉하게.
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192, responseMimeType: "application/json" },
    }),
  });

  if (!res.ok) {
    console.error("gemini error", res.status); // 상태코드만 — 본문엔 광고주 데이터가 있다
    // upstream 상태를 넘겨 클라이언트가 한도 초과(429)를 구분해 안내할 수 있게 한다.
    return new Response(JSON.stringify({ error: "upstream", upstream: res.status }), {
      status: 502, headers: { "content-type": "application/json", ...CORS_HEADERS },
    });
  }

  const data = await res.json();
  await recordAiUsage("ai_brief", data.usageMetadata);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  // responseMimeType로 JSON을 받지만, 방어적으로 첫 { ~ 마지막 } 만 취한다.
  const match = text.match(/\{[\s\S]*\}/)?.[0];
  if (!match) {
    // 원인 추적용 — 본문 없이 종료 사유만 남긴다(MAX_TOKENS=잘림, SAFETY=차단 등).
    console.error("gemini empty text", data.candidates?.[0]?.finishReason ?? "no-candidate");
  }
  return new Response(match ?? '{"blocks":[]}', { headers: { "content-type": "application/json", ...CORS_HEADERS } });
});
