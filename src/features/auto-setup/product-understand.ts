/**
 * F-AutoSetup — [2단계] AI 상품 이해. Edge Function 호출 + 시드 키워드 정리.
 *
 * 이 결과는 **사용자에게 먼저 보여주고 확인받는 게이트**다(설계 §5.2). AI가 상품을 잘못 이해하면
 * 그 뒤가 통째로 틀린 채 초안이 나오고, AE는 키워드 200개를 훑다가 뒤늦게 알아챈다.
 * 한 줄짜리 이해를 먼저 보여주면 3초면 판별되고 "여기 남성용 아니라 여성용이야" 한마디로 끝난다.
 *
 * 서버: `supabase/functions/autosetup-understand/index.ts`.
 * 배포: `npx supabase functions deploy autosetup-understand --no-verify-jwt`
 */

import { getSupabase } from "@/shared/supabase";
import type { ProductPageInfo, ProductUnderstanding } from "@/types/auto-setup";

// manifest.config.ts의 host_permissions와 동일 도메인이어야 한다 — 다르면 요청이 차단된다.
const FN_URL = "https://gvyvrjncpwmcwycebrhf.supabase.co/functions/v1/autosetup-understand";

/**
 * 검색광고 키워드 도구(`hintKeywords`) 제약에 맞춰 시드를 다듬는다.
 * 제약: 한글·영문·숫자만, 공백 제거 기준 30자 이내. 어긋나면 그 배치(5개)가 통째로 400이 난다.
 *
 * 순수 함수 — 테스트는 `product-understand.test.ts`.
 */
export function cleanSeedKeywords(raw: string[], max = 10): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    // 허용 문자 외(특수문자·이모지 등)는 공백으로 바꾼 뒤 정리 — 통째로 버리면 멀쩡한 시드를 잃는다.
    const cleaned = item
      .replace(/[^0-9A-Za-z가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) continue;
    // 길이 판정은 실제 전송 형태(공백 제거) 기준.
    if (cleaned.replace(/\s+/g, "").length > 30) continue;
    const key = cleaned.replace(/\s+/g, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= max) break;
  }
  return out;
}

async function loadToken(): Promise<string> {
  const { data } = await getSupabase().auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) throw new Error("로그인이 필요해요. 설정에서 로그인해 주세요");
  return accessToken;
}

/**
 * 확인 화면이 떠 있는 동안 서버를 미리 데운다(F-Brief `warmCompose`와 같은 이유).
 * 실패해도 아무 일도 안 일어난다.
 */
const WARM_GAP_MS = 60_000;
let lastWarmAt = 0;

export function warmUnderstand(): void {
  if (Date.now() - lastWarmAt < WARM_GAP_MS) return;
  lastWarmAt = Date.now();
  void loadToken()
    .then((token) =>
      fetch(FN_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ mode: "warmup" }),
      }),
    )
    .catch(() => {});
}

/**
 * @param correction 사용자가 자유 텍스트로 바로잡은 내용. 다시 태울 때 넘긴다.
 */
export async function understandProduct(
  page: ProductPageInfo,
  correction = "",
): Promise<ProductUnderstanding> {
  const token = await loadToken();
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      page: {
        url: page.url,
        title: page.title,
        description: page.description,
        price: page.price,
        category: page.category,
        bodyText: page.bodyText,
      },
      correction,
    }),
  });

  if (res.status === 401) {
    throw new Error("로그인이 만료됐어요. 확장 프로그램 설정에서 다시 로그인해 주세요");
  }
  if (!res.ok) {
    const upstream = await res.json().then((d) => d?.upstream).catch(() => undefined);
    throw new Error(
      upstream === 429
        ? "토큰 한도에 도달했어요! 운영팀에 문의해 주세요"
        : "상품 정보를 정리하지 못했어요. 잠시 후 다시 시도해 주세요",
    );
  }

  const data = await res.json();
  const u = data?.understanding as Partial<ProductUnderstanding> | undefined;
  if (!u?.product && !u?.business) {
    console.warn("[dv-ads/auto-setup] 상품 이해 응답이 비어 있음", data);
    throw new Error("이 페이지에서는 상품을 파악하지 못했어요. 다른 링크를 넣어 주세요");
  }

  const seedKeywords = cleanSeedKeywords(u.seedKeywords ?? []);
  if (seedKeywords.length === 0) {
    throw new Error("검색할 키워드를 찾지 못했어요. 상품 페이지 링크가 맞는지 확인해 주세요");
  }

  return {
    business: u.business ?? "",
    product: u.product ?? "",
    priceRange: u.priceRange || undefined,
    targets: u.targets ?? [],
    strengths: u.strengths ?? [],
    isLocal: u.isLocal === true,
    seedKeywords,
  };
}
