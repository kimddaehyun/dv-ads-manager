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

// secretKey는 거의 고정이라 importKey 결과(CryptoKey)를 모듈 레벨에 캐시.
// timestamp가 들어간 message 서명(crypto.subtle.sign)만 매 호출 새로 수행.
const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function getHmacKey(secret: string): Promise<CryptoKey> {
  let keyPromise = hmacKeyCache.get(secret);
  if (!keyPromise) {
    const enc = new TextEncoder();
    keyPromise = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    hmacKeyCache.set(secret, keyPromise);
  }
  return keyPromise;
}

async function sign(
  timestamp: string,
  method: string,
  uri: string,
  secret: string,
): Promise<string> {
  const message = `${timestamp}.${method}.${uri}`;
  const enc = new TextEncoder();
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- F001 — 키워드별 1~10위 예상 입찰가 ----

import { MAX_POSITION, MAX_POSITION_BY_DEVICE, type RankPosition } from "@/types/storage";
import type { AdDevice } from "@/types/device";

const POSITION_BID_ENDPOINT = "/estimate/average-position-bid/keyword";
const POSITION_BID_BATCH_KEYWORDS = 5; // 한 요청에 키워드 최대 5개 (각 1~10위 = 50 items)

export interface PositionBidsItem {
  keyword: string;
  /** 1~10위 → 예상 입찰가(원). 응답에서 빠진 순위는 누락됨 */
  rank_to_bid: Partial<Record<RankPosition, number>>;
}

/**
 * Spike C — 응답 schema 확정 (2026-05-18): `{device: "PC", estimate: [{key, position, bid}, ...]}`.
 * 50 items/batch = 5 keywords × 10 positions. parser는 `extractItemsArray`의 `estimate` 키로 잡혀
 * 정상 동작 확인. 만약 네이버가 향후 wrapper/필드명을 바꿔도 defensive fallback이 흡수.
 */
interface RawPositionBidItem {
  key?: string;
  keyword?: string;
  position?: number;
  rank?: number;
  bid?: number | string;
}

let spikeLogged = false;

// 검색광고 estimate API 배치 동시 실행 상한. 직렬+sleep(300) 대신 이 동시성 풀로 페이싱한다.
// 429는 각 배치의 백오프(sleep 1500 재시도)가 흡수. 라이브 측정 전이라 보수적으로 2.
const SEARCHAD_BATCH_CONCURRENCY = 2;

// 배치 인덱스 0..count-1을 동시성 limit로 실행 후 결과 평탄화(순서는 호출 측이 키워드로 재정렬).
async function runBatchesPooled<T>(
  count: number,
  limit: number,
  runOne: (i: number) => Promise<T[]>,
): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  const worker = async () => {
    while (next < count) out.push(...(await runOne(next++)));
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return out;
}

export async function fetchPositionBids(
  keywords: string[],
  cred: SearchadCredentials,
  device: AdDevice,
): Promise<PositionBidsItem[]> {
  const cleaned = Array.from(
    new Set(keywords.map((k) => k.trim()).filter(Boolean)),
  );
  if (cleaned.length === 0) return [];

  const batches: string[][] = [];
  for (let i = 0; i < cleaned.length; i += POSITION_BID_BATCH_KEYWORDS) {
    batches.push(cleaned.slice(i, i + POSITION_BID_BATCH_KEYWORDS));
  }

  const runOne = async (batch: string[]): Promise<PositionBidsItem[]> => {
    try {
      return await callPositionBid(batch, cred, device);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429")) {
        // 동시성 풀에서 두 배치가 동시에 429를 맞을 때 재시도가 같은 순간에 겹쳐
        // 또 429 나는 걸 막으려 지터를 더한다(동시 재시도 burst 분산).
        await sleep(1500 + Math.random() * 800);
        try {
          return await callPositionBid(batch, cred, device);
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          if (m2.includes("400")) {
            console.warn("[searchad] position-bid batch 400 after 429 retry, skipping", batch);
            return [];
          }
          throw e2;
        }
      } else if (msg.includes("400")) {
        console.warn("[searchad] position-bid batch 400, skipping", batch);
        return [];
      }
      throw e;
    }
  };

  return runBatchesPooled(batches.length, SEARCHAD_BATCH_CONCURRENCY, (i) =>
    runOne(batches[i]),
  );
}

async function callPositionBid(
  keywords: string[],
  cred: SearchadCredentials,
  device: AdDevice,
): Promise<PositionBidsItem[]> {
  const timestamp = Date.now().toString();
  const method = "POST";
  const signature = await sign(timestamp, method, POSITION_BID_ENDPOINT, cred.secretKey);

  // device별 position 상한 — PC: 1~10, MOBILE: 1~5. 초과 시 batch 전체가 400으로 거부됨.
  const maxPos = MAX_POSITION_BY_DEVICE[device];
  const items = keywords.flatMap((k) =>
    Array.from({ length: maxPos }, (_, i) => ({ key: k, position: i + 1 })),
  );
  const body = JSON.stringify({ device, items });

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
  // MAX_POSITION(10) = PC 상한 = 전 디바이스 통틀어 최대치. 응답에 디바이스별 cap을 넘는
  // position이 올 일 없지만 defensive로 10으로 검증.
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

// ---- F001 — 키워드 × 입찰가 → 예상 성과(노출/클릭/CPC/광고비) ----

import type { KeywordPerformanceCache } from "@/types/storage";

const PERFORMANCE_ENDPOINT = "/estimate/performance-bulk";
const PERFORMANCE_BATCH_SIZE = 200; // 한 요청당 최대 {keyword, bid} 조합

interface RawPerformanceItem {
  key?: string;
  keyword?: string;
  bid?: number | string;
  impressions?: number | string;
  impression?: number | string;
  impCnt?: number | string;
  clicks?: number | string;
  click?: number | string;
  clkCnt?: number | string;
  cpc?: number | string;
  avgCpc?: number | string;
  cost?: number | string; // 서버가 광고비를 cost로 반환 (2026-05-18 확인)
  salesAmt?: number | string;
  salesAmount?: number | string;
}

let perfSpikeLogged = false;

/**
 * Spike (Phase 1) — 응답 schema 확정 후 parser 좁히기.
 * 후보 wrapper(`estimate`/`performance`/`result`/`items`/`data`)와
 * 필드명 변형(`impressions`/`impCnt`, `clicks`/`clkCnt`, `cpc`/`avgCpc`, `salesAmt`/`salesAmount`)을
 * defensive하게 모두 시도. raw 응답은 1회 콘솔 출력.
 */
export async function fetchPerformance(
  items: Array<{ keyword: string; bid: number }>,
  cred: SearchadCredentials,
  device: AdDevice,
): Promise<KeywordPerformanceCache[]> {
  const cleaned = items
    .map((q) => ({ keyword: q.keyword.trim(), bid: q.bid }))
    .filter((q) => q.keyword && Number.isFinite(q.bid) && q.bid > 0);
  if (cleaned.length === 0) return [];

  const batches: Array<Array<{ keyword: string; bid: number }>> = [];
  for (let i = 0; i < cleaned.length; i += PERFORMANCE_BATCH_SIZE) {
    batches.push(cleaned.slice(i, i + PERFORMANCE_BATCH_SIZE));
  }

  const runOne = async (
    batch: Array<{ keyword: string; bid: number }>,
  ): Promise<KeywordPerformanceCache[]> => {
    try {
      return await callPerformance(batch, cred, device);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("429")) {
        // 동시 재시도 burst 분산용 지터(fetchPositionBids와 동일 이유).
        await sleep(1500 + Math.random() * 800);
        try {
          return await callPerformance(batch, cred, device);
        } catch (e2) {
          const m2 = e2 instanceof Error ? e2.message : String(e2);
          if (m2.includes("400")) {
            console.warn("[searchad] performance batch 400 after 429 retry, skipping", batch.length, "items");
            return [];
          }
          throw e2;
        }
      } else if (msg.includes("400")) {
        console.warn("[searchad] performance batch 400, skipping", batch.length, "items");
        return [];
      }
      throw e;
    }
  };

  return runBatchesPooled(batches.length, SEARCHAD_BATCH_CONCURRENCY, (i) =>
    runOne(batches[i]),
  );
}

async function callPerformance(
  items: Array<{ keyword: string; bid: number }>,
  cred: SearchadCredentials,
  device: AdDevice,
): Promise<KeywordPerformanceCache[]> {
  const timestamp = Date.now().toString();
  const method = "POST";
  const signature = await sign(timestamp, method, PERFORMANCE_ENDPOINT, cred.secretKey);

  // 서버 POJO `KeyAndBidPerformance` 필드명: keyword / bid / device (per-item).
  // 2026-05-18 400 에러 분석으로 확정 — `key` 보내면 keyword=null로 파싱돼 "keyword is empty" 400.
  // hintKeywords와 동일 — searchad API는 공백 포함 키워드 거부
  const apiItems = items.map((q) => ({
    keyword: q.keyword.replace(/\s+/g, ""),
    bid: q.bid,
    device,
  }));
  const body = JSON.stringify({ items: apiItems });

  const res = await fetch(BASE_URL + PERFORMANCE_ENDPOINT, {
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
    console.warn(`[searchad] performance API ${res.status}`, text);
    throw new Error(`검색광고 API ${res.status}`);
  }

  const json = (await res.json()) as unknown;
  if (!perfSpikeLogged) {
    perfSpikeLogged = true;
    console.log("[searchad] performance raw response (Spike 1회 보정용)", json);
  }
  return parsePerformanceResponse(json, items, device);
}

function parsePerformanceResponse(
  json: unknown,
  requested: Array<{ keyword: string; bid: number }>,
  device: AdDevice,
): KeywordPerformanceCache[] {
  const arr = extractPerfArray(json);
  const now = new Date().toISOString();
  const byKey = new Map<string, KeywordPerformanceCache>();
  for (const raw of arr) {
    const kw = (raw.key ?? raw.keyword)?.toString();
    if (!kw) continue;
    const bid = numField(raw.bid);
    if (bid == null) continue;
    const impressions = numField(raw.impressions ?? raw.impression ?? raw.impCnt) ?? 0;
    const clicks = numField(raw.clicks ?? raw.click ?? raw.clkCnt) ?? 0;
    const cpc = numField(raw.cpc ?? raw.avgCpc) ?? 0;
    // 서버 응답 광고비 필드 = cost (2026-05-18 확인). salesAmt/salesAmount는 fallback.
    const salesAmt = numField(raw.cost ?? raw.salesAmt ?? raw.salesAmount) ?? 0;
    byKey.set(`${kw}:${bid}`, {
      keyword: kw,
      device,
      bid,
      impressions,
      clicks,
      cpc,
      salesAmt,
      fetched_at: now,
    });
  }
  // 요청 순서로 정렬 + 응답에 없는 항목은 skip. 키워드는 원본(공백 포함 가능)으로 복원.
  const out: KeywordPerformanceCache[] = [];
  for (const q of requested) {
    const entry = byKey.get(`${q.keyword.replace(/\s+/g, "")}:${q.bid}`);
    if (entry) out.push({ ...entry, keyword: q.keyword });
  }
  return out;
}

function extractPerfArray(json: unknown): RawPerformanceItem[] {
  if (Array.isArray(json)) return json as RawPerformanceItem[];
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  for (const k of ["performance", "estimate", "result", "items", "data", "keywordList"]) {
    const v = obj[k];
    if (Array.isArray(v)) return v as RawPerformanceItem[];
  }
  return [];
}

function numField(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
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
