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

// ---- F001 — 키워드별 1~10위 예상 입찰가 ----

import { MAX_POSITION, type RankPosition } from "@/types/storage";

const POSITION_BID_ENDPOINT = "/estimate/average-position-bid/keyword";
const POSITION_BID_BATCH_KEYWORDS = 5; // 한 요청에 키워드 최대 5개 (각 1~10위 = 50 items)

export interface PositionBidsItem {
  keyword: string;
  /** 1~10위 → 예상 입찰가(원). 응답에서 빠진 순위는 누락됨 */
  rank_to_bid: Partial<Record<RankPosition, number>>;
}

/**
 * Spike C — 응답 schema는 첫 실호출로 확정. 알려진 후보 wrapper(`estimate`/`result`/`items`)와
 * 필드명(`key`/`keyword`/`position`/`rank`/`bid`)을 defensive하게 모두 시도하고,
 * raw 응답은 콘솔에 1회 출력해 사용자가 비교·보정할 수 있게 한다.
 */
interface RawPositionBidItem {
  key?: string;
  keyword?: string;
  position?: number;
  rank?: number;
  bid?: number | string;
}

let spikeLogged = false;

export async function fetchPositionBids(
  keywords: string[],
  cred: SearchadCredentials,
): Promise<PositionBidsItem[]> {
  const cleaned = Array.from(
    new Set(keywords.map((k) => k.trim()).filter(Boolean)),
  );
  if (cleaned.length === 0) return [];

  const results: PositionBidsItem[] = [];
  for (let i = 0; i < cleaned.length; i += POSITION_BID_BATCH_KEYWORDS) {
    const batch = cleaned.slice(i, i + POSITION_BID_BATCH_KEYWORDS);
    let part: PositionBidsItem[];
    try {
      part = await callPositionBid(batch, cred);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429")) {
        await sleep(1500);
        try {
          part = await callPositionBid(batch, cred);
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          if (m2.includes("400")) {
            console.warn("[searchad] position-bid batch 400 after 429 retry, skipping", batch);
            part = [];
          } else {
            throw e2;
          }
        }
      } else if (msg.includes("400")) {
        console.warn("[searchad] position-bid batch 400, skipping", batch);
        part = [];
      } else {
        throw e;
      }
    }
    results.push(...part);
    if (i + POSITION_BID_BATCH_KEYWORDS < cleaned.length) await sleep(300);
  }
  return results;
}

async function callPositionBid(
  keywords: string[],
  cred: SearchadCredentials,
): Promise<PositionBidsItem[]> {
  const timestamp = Date.now().toString();
  const method = "POST";
  const signature = await sign(timestamp, method, POSITION_BID_ENDPOINT, cred.secretKey);

  const items = keywords.flatMap((k) =>
    Array.from({ length: MAX_POSITION }, (_, i) => ({ key: k, position: i + 1 })),
  );
  const body = JSON.stringify({ device: "PC", items });

  const res = await fetch(BASE_URL + POSITION_BID_ENDPOINT, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": timestamp,
      "X-API-KEY": cred.accessLicense,
      "X-Customer": cred.customerId,
      "X-Signature": signature,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[searchad] position-bid API ${res.status}`, text);
    throw new Error(`검색광고 API ${res.status}`);
  }

  const json = (await res.json()) as unknown;
  if (!spikeLogged) {
    spikeLogged = true;
    console.log("[searchad] position-bid raw response (Spike C 1회 보정용)", json);
  }
  return parsePositionBidResponse(json, keywords);
}

function parsePositionBidResponse(
  json: unknown,
  requestedKeywords: string[],
): PositionBidsItem[] {
  const items = extractItemsArray(json);
  const byKeyword = new Map<string, Partial<Record<RankPosition, number>>>();
  for (const raw of items) {
    const keyword = raw.key ?? raw.keyword;
    const position = raw.position ?? raw.rank;
    const bid = typeof raw.bid === "string" ? parseInt(raw.bid, 10) : raw.bid;
    if (
      typeof keyword !== "string" ||
      typeof position !== "number" ||
      !Number.isInteger(position) ||
      position < 1 ||
      position > MAX_POSITION ||
      typeof bid !== "number" ||
      !Number.isFinite(bid)
    ) {
      continue;
    }
    const existing = byKeyword.get(keyword) ?? {};
    existing[position as RankPosition] = bid;
    byKeyword.set(keyword, existing);
  }

  // 요청 키워드 순서로 결과 정렬
  return requestedKeywords
    .map((k) => ({ keyword: k, rank_to_bid: byKeyword.get(k) ?? {} }))
    .filter((r) => Object.keys(r.rank_to_bid).length > 0);
}

function extractItemsArray(json: unknown): RawPositionBidItem[] {
  if (Array.isArray(json)) return json as RawPositionBidItem[];
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  for (const k of ["estimate", "result", "items", "data", "keywordList"]) {
    const v = obj[k];
    if (Array.isArray(v)) return v as RawPositionBidItem[];
  }
  return [];
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
