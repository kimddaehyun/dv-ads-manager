/**
 * 네이버 검색광고 API (키워드 도구) 통합.
 * https://naver.github.io/searchad-apidoc/
 */

export interface SearchadCredentials {
  customerId: string;
  accessLicense: string;
  secretKey: string;
}

export interface KeywordVolume {
  keyword: string;
  monthlyPc: number; // < 10 인 경우 -1 로 표기
  monthlyMobile: number;
  monthlyTotal: number;
  competition?: "낮음" | "중간" | "높음";
}

const BASE_URL = "https://api.searchad.naver.com";
const ENDPOINT = "/keywordstool";
const BATCH_SIZE = 5; // hintKeywords 한 요청 최대 개수

export async function fetchVolumes(
  keywords: string[],
  cred: SearchadCredentials,
): Promise<KeywordVolume[]> {
  const cleaned = Array.from(
    new Set(keywords.map((k) => k.trim()).filter(Boolean)),
  );
  const results: KeywordVolume[] = [];

  for (let i = 0; i < cleaned.length; i += BATCH_SIZE) {
    const batch = cleaned.slice(i, i + BATCH_SIZE);
    let part: KeywordVolume[];
    try {
      part = await callKeywordTool(batch, cred);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429")) {
        // 429 Too Many Requests는 한 번 더 기다려서 재시도
        await sleep(1500);
        try {
          part = await callKeywordTool(batch, cred);
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          if (m2.includes("400")) {
            console.warn("[searchad] batch 400 after 429 retry, skipping", batch);
            part = [];
          } else {
            throw e2;
          }
        }
      } else if (msg.includes("400")) {
        // 단일 배치의 hintKeywords가 부적합(길이 초과·비표준 문자 등)할 때 400 반환 →
        // 해당 5개만 건너뛰고 나머지 배치는 계속 진행. 인증/서버 에러는 그대로 throw.
        console.warn("[searchad] batch 400, skipping", batch);
        part = [];
      } else {
        throw e;
      }
    }
    results.push(...part);
    // 네이버 searchad rate limit 보호 — 짧은 시간 누적 호출 시 429 방지
    if (i + BATCH_SIZE < cleaned.length) await sleep(300);
  }
  return results;
}

/**
 * 메인 키워드(hint) 1개에 대한 연관 검색어 풀 전체를 반환.
 * fetchVolumes는 hint와 정확히 일치하는 항목만 픽하지만, 이 함수는 keywordList 전체를
 * 그대로 돌려준다 — 자동 태그 추천(메인 키워드의 연관어 → 확장 태그 후보) 용도.
 * 한 번 호출당 keywordList는 최대 1000개.
 */
export async function fetchRelatedKeywords(
  hint: string,
  cred: SearchadCredentials,
): Promise<KeywordVolume[]> {
  const cleaned = hint.trim();
  if (!cleaned) return [];

  const timestamp = Date.now().toString();
  const method = "GET";
  const signature = await sign(timestamp, method, ENDPOINT, cred.secretKey);
  const hintForApi = cleaned.replace(/\s+/g, "");
  const url =
    BASE_URL +
    ENDPOINT +
    "?hintKeywords=" +
    encodeURIComponent(hintForApi) +
    "&showDetail=1";

  const doFetch = async () => {
    const res = await fetch(url, {
      method,
      headers: {
        "X-Timestamp": timestamp,
        "X-API-KEY": cred.accessLicense,
        "X-Customer": cred.customerId,
        "X-Signature": signature,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[searchad] related API ${res.status}`, text);
      throw new Error(`검색광고 API ${res.status}`);
    }
    return (await res.json()) as { keywordList?: RawKeywordItem[] };
  };

  let json: { keywordList?: RawKeywordItem[] };
  try {
    json = await doFetch();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("429")) {
      await sleep(1500);
      // 재서명 필요 — timestamp 만료 가능성 (5분)이 짧진 않지만 안전하게 재시도 시점 그대로 사용
      json = await doFetch();
    } else {
      throw e;
    }
  }

  const list = json.keywordList ?? [];
  const out: KeywordVolume[] = [];
  for (const k of list) {
    out.push({
      keyword: k.relKeyword,
      monthlyPc: parseQc(k.monthlyPcQcCnt),
      monthlyMobile: parseQc(k.monthlyMobileQcCnt),
      monthlyTotal: parseQc(k.monthlyPcQcCnt) + parseQc(k.monthlyMobileQcCnt),
      competition: k.compIdx as KeywordVolume["competition"],
    });
  }
  return out;
}

async function callKeywordTool(
  hints: string[],
  cred: SearchadCredentials,
): Promise<KeywordVolume[]> {
  const timestamp = Date.now().toString();
  const method = "GET";
  const signature = await sign(timestamp, method, ENDPOINT, cred.secretKey);

  // searchad API는 hintKeywords에 공백이 포함된 다단어 키워드를 받으면 400을 반환한다.
  // 전송 시 공백을 제거하고, 응답 매칭은 normalize() 기준이라 원본과 동일하게 매칭된다.
  const hintsForApi = hints.map((h) => h.replace(/\s+/g, ""));
  // showDetail=1 → hintKeywords 자체도 응답에 포함
  const url =
    BASE_URL +
    ENDPOINT +
    "?hintKeywords=" +
    encodeURIComponent(hintsForApi.join(",")) +
    "&showDetail=1";

  const res = await fetch(url, {
    method,
    headers: {
      "X-Timestamp": timestamp,
      "X-API-KEY": cred.accessLicense,
      "X-Customer": cred.customerId,
      "X-Signature": signature,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[searchad] API ${res.status}`, text);
    throw new Error(`검색광고 API ${res.status}`);
  }

  const json = (await res.json()) as { keywordList?: RawKeywordItem[] };
  const list = json.keywordList ?? [];

  // hint 별로 정확히 일치하는 항목만 픽 (관련 키워드는 제외)
  const out: KeywordVolume[] = [];
  for (const hint of hints) {
    const found = list.find(
      (k) => normalize(k.relKeyword) === normalize(hint),
    );
    if (!found) continue;
    out.push({
      keyword: hint,
      monthlyPc: parseQc(found.monthlyPcQcCnt),
      monthlyMobile: parseQc(found.monthlyMobileQcCnt),
      monthlyTotal:
        parseQc(found.monthlyPcQcCnt) + parseQc(found.monthlyMobileQcCnt),
      competition: found.compIdx as KeywordVolume["competition"],
    });
  }
  return out;
}

interface RawKeywordItem {
  relKeyword: string;
  monthlyPcQcCnt: number | string;
  monthlyMobileQcCnt: number | string;
  compIdx?: string;
}

function parseQc(v: number | string | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  // "< 10" 같은 형식 → -1 로 표기 (호출자가 "—" 처리)
  if (v.startsWith("<")) return -1;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

async function sign(
  timestamp: string,
  method: string,
  uri: string,
  secret: string,
): Promise<string> {
  const message = `${timestamp}.${method}.${uri}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const CRED_KEY = "searchadCredentials";

export async function loadCredentials(): Promise<SearchadCredentials | null> {
  const r = await chrome.storage.local.get(CRED_KEY);
  return (r[CRED_KEY] as SearchadCredentials) ?? null;
}

export async function saveCredentials(c: SearchadCredentials): Promise<void> {
  await chrome.storage.local.set({ [CRED_KEY]: c });
}

export async function clearCredentials(): Promise<void> {
  await chrome.storage.local.remove(CRED_KEY);
}
