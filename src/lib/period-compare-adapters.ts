/**
 * F-PoP — 매체별 capture 인식·정규화 어댑터.
 *
 * 6개 매체 페이지에서 페이지가 직접 호출하는 stats fetch는 endpoint와 응답
 * schema가 매체마다 다르다. 이 모듈은:
 *   1. URL/pathname → 매체 식별 (detectMedia)
 *   2. capture가 "stats 응답"인지 휴리스틱으로 판별 (isStatsLikeCapture)
 *   3. 매체별 응답 schema → 6지표 정규화 (extractMetricsFromResponse)
 *   4. URL/body의 startDate/endDate를 직전 기간으로 shift (shiftDateParams)
 *
 * 매체별 endpoint·schema는 Spike (사용자 6개 페이지 방문 시 콘솔 로그)로 확정 후
 * MEDIA_RULES·METRIC_KEYS에 추가한다. 첫 출시까지 generic 휴리스틱으로
 * 대부분의 매체를 자동 cover하도록 작성.
 */

export type PeriodCompareMedia =
  | "powerlink"
  | "shopping"
  | "place"
  | "brandsearch"
  | "powercontents"
  | "gfa";

export interface PeriodCompareCapture {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  status: number;
  response: unknown;
  ts: number;
}

// ─── 매체 페이지 감지 ───
//
// 페이지 URL의 pathname을 기반으로 현재 어느 매체 페이지를 보고 있는지 판별.
// detectMedia(null, pathname) — 현재 페이지 매체 감지용
// detectMedia(fetchUrl, pathname) — capture가 어느 매체용 fetch인지 판별용
//
// 6개 매체의 정확한 pathname은 Spike에서 확정. 아래는 추정 패턴(왼쪽 메뉴
// 라벨 + ads.naver.com URL 관례) — 사용자가 페이지 방문 시 콘솔에 출력되는
// pathname을 참고해 보정.

interface MediaRule {
  media: PeriodCompareMedia;
  // 현재 페이지를 이 매체로 인식하는 pathname 매칭
  pagePattern: RegExp;
  // fetch URL이 이 매체의 stats fetch로 인식되는 패턴
  fetchPattern: RegExp;
}

// pathname 패턴은 ads.naver.com 광고관리자 SPA의 실제 URL을 반영.
// `/manage/ad-accounts/{accountId}/sa/campaigns-by/WEB_SITE` 형태가 파워링크 캠페인 리스트.
// 다른 매체는 campaigns-by/{TYPE}의 TYPE 부분으로 구분 (예: SHOPPING_NS, POWER_CONTENTS).
// fetch URL은 `/apis/sa/api/stats`, `/apis/sa/api/dashboard`, `/apis/gfa/...` 등.
const MEDIA_RULES: MediaRule[] = [
  {
    media: "powerlink",
    pagePattern: /\/sa\/(campaigns-by\/WEB_SITE|powerlink|adgroups)|campaignType=WEB_SITE/i,
    fetchPattern: /\/apis\/sa\/(api|admng)\/.*(WEB_SITE|powerlink)/i,
  },
  {
    media: "shopping",
    pagePattern: /\/sa\/(campaigns-by\/(SHOPPING|SHOP)|shopping)|campaignType=SHOPPING/i,
    fetchPattern: /\/apis\/sa\/(api|admng)\/.*(SHOPPING|shop|product)/i,
  },
  {
    media: "brandsearch",
    pagePattern: /\/sa\/(campaigns-by\/(BRAND|NEW_PROD|NEW_PRODUCT)|brand|new-product|newproduct)|campaignType=(BRAND|NEW_PROD)/i,
    fetchPattern: /\/apis\/sa\/(api|admng)\/.*(BRAND|NEW_PROD|brand|newprod)/i,
  },
  {
    media: "powercontents",
    pagePattern: /\/sa\/(campaigns-by\/(POWER_CONTENTS|CONTENTS|CATALOG)|contents|powercontents)|campaignType=(POWER_CONTENTS|CATALOG)/i,
    fetchPattern: /\/apis\/sa\/(api|admng)\/.*(POWER_CONTENTS|CATALOG|contents)/i,
  },
  {
    media: "place",
    pagePattern: /\/sa\/(campaigns-by\/PLACE|place)|\/place|campaignType=PLACE/i,
    fetchPattern: /\/apis\/(place|sa)\/.*(place|local|PLACE)/i,
  },
  {
    media: "gfa",
    pagePattern: /\/(da|gfa|display)/i,
    fetchPattern: /\/apis\/(da|gfa)\//i,
  },
];

export function detectMedia(
  fetchUrl: string | null,
  pathname: string,
): PeriodCompareMedia | null {
  if (fetchUrl) {
    for (const r of MEDIA_RULES) {
      if (r.fetchPattern.test(fetchUrl)) return r.media;
    }
  }
  for (const r of MEDIA_RULES) {
    if (r.pagePattern.test(pathname)) return r.media;
  }
  return null;
}

// ─── stats-like 휴리스틱 ───
//
// 6개 매체 페이지가 호출하는 fetch 중 stats fetch만 capture하도록 필터링.
// 통계 응답은 거의 항상:
//   - JSON 객체 + data/list/items/rows 등 array 필드
//   - array 원소가 impCnt/clickCnt/cost/salesAmt 같은 숫자 키 보유
//   - 또는 총계 객체(total/summary)에 같은 키
// 키워드/계정 메타데이터 fetch와 구분.

const STATS_HINT_KEYS = [
  // 한국어 광고 통계에서 흔히 보이는 키 (sa, admng 계열)
  "impcnt",
  "impressions",
  "impression",
  "clkcnt",
  "clickcnt",
  "clicks",
  "cost",
  "crpamt",
  "crpcnt",
  "sales",
  "salesamt",
  "salesamount",
  "ccnt",
  "cvcnt",
  "convcnt",
  "conversion",
  "conversions",
  "drtcnt",
  "drtcnto",
  "cpc",
  "ctr",
];

export function isStatsLikeCapture(cap: PeriodCompareCapture): boolean {
  if (cap.status !== 200) return false;
  if (cap.response == null || typeof cap.response !== "object") return false;
  return walkForStatsKeys(cap.response, 0);
}

function walkForStatsKeys(node: unknown, depth: number): boolean {
  if (depth > 4) return false;
  if (node == null) return false;
  if (typeof node !== "object") return false;
  if (Array.isArray(node)) {
    for (let i = 0; i < Math.min(node.length, 3); i++) {
      if (walkForStatsKeys(node[i], depth + 1)) return true;
    }
    return false;
  }
  const obj = node as Record<string, unknown>;
  let hits = 0;
  for (const k of Object.keys(obj)) {
    const lower = k.toLowerCase();
    if (STATS_HINT_KEYS.some((h) => lower === h || lower.includes(h))) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  if (hits >= 2) return true;
  // 한 단계 더 내려가 보기
  for (const v of Object.values(obj).slice(0, 12)) {
    if (walkForStatsKeys(v, depth + 1)) return true;
  }
  return false;
}

// ─── 응답 → 6지표 정규화 ───

export interface NormalizedMetrics {
  impressions: number | null;
  clicks: number | null;
  /** CTR (%) — 클릭수 / 노출수 * 100. impressions <= 0이면 null. */
  ctr: number | null;
  cpc: number | null;
  cost: number | null;
  revenue: number | null;
  conversions: number | null;
  /** ROAS (%) — 매출 / 총비용 * 100. 둘 중 하나라도 null 또는 cost <= 0이면 null. */
  roas: number | null;
}

// 매체별 우선 키 매핑. 매체별로 다를 수 있어 각각 정의 가능.
// 첫 출시는 generic — Spike 결과로 매체별 override 추가.
type MetricKey = keyof NormalizedMetrics;

// 검색광고(SA) POST /apis/sa/api/stats 응답 schema 기준. 사용자 Spike(2026-05-19)에서 확정.
// 응답에 *Micros suffix가 붙은 키는 마이크로 단위 (1,000,000 = 1원). collectAggregates에서 자동 변환.
//
// "salesAmt"는 네이버 컨벤션상 "광고비"(=광고주가 지불한 금액)이지 매출이 아니다.
// "구매완료 전환매출"은 별도 키 `purchaseConvAmtMicros`.
const METRIC_ALIASES: Record<MetricKey, string[]> = {
  // roas/ctr는 계산값. 응답 키 매핑은 fallback. 항상 base totals에서 재계산하므로 별칭 매칭은 그저 1차 추출.
  roas: [],
  ctr: ["ctr", "ctrPct", "clickRatio", "clickRate"],
  // SA 검색광고 캠페인 stats는 `impCnt`/`clkCnt`. 검색광고 대시보드·GFA는
  // 풀 네임(impressionCount/clickCount) 등 변형. case-insensitive 정확 매칭.
  impressions: ["impCnt", "impCount", "impressionCount", "impressions", "impression", "imp"],
  clicks: ["clkCnt", "clickCnt", "clickCount", "clicks", "click", "clk"],
  // 검색광고 대시보드는 averageCpcMicros 우선. SA campaign stats는 `cpc` 직접 키.
  cpc: ["cpc", "cpcMicros", "averageCpcMicros", "avgCpcMicros", "averageCpc", "avgCpc"],
  // 총비용 — 매체별 키 이름·단위가 다양:
  //   SA campaign stats (POST /apis/sa/api/stats): salesAmtMicros (Micros, /1M=원)
  //   검색광고 dashboard (POST /apis/dashboard/v1/.../reports|campaigns/{overview|search}): grossCostMicros
  //   GFA campaign stats (GET /apis/gfa/v1/.../stats/campaignStats): "sales" (원 단위) ← spend는 1/100,000원
  //     단위라 우리는 sales 우선. spend는 fallback.
  cost: [
    "salesAmtMicros",
    "salesAmt",
    "grossCostMicros",
    "grossCost",
    "crpAmt",
    "crpAmtMicros",
    "cost",
    "costMicros",
    "totalCost",
    "totalCostMicros",
    "sales",
    "spend",
    "spendMicros",
  ],
  // 매출 = 구매완료 전환매출.
  //   SA: purchaseConvAmtMicros
  //   검색광고 dashboard: purchasedConversionsValueMicros(구매전환매출) > conversionsValueMicros(전체 전환매출)
  //   GFA campaign stats: conversion.convSalesKRW (원 단위)
  revenue: [
    "purchaseConvAmtMicros",
    "purchasedConversionsValueMicros",
    "conversionsValueMicros",
    "convSalesKRW",
    "convAmtMicros",
    "purchaseConvAmt",
    "convAmt",
    "purAmt",
    "purchaseAmount",
    "revenue",
    "revenueMicros",
    "conversionValue",
    "conversionValueMicros",
  ],
  // 전환수.
  //   SA: purchaseCcnt
  //   검색광고 dashboard: conversions(전체) > lastClickConversions(last-click attribution)
  //   GFA: conversion.convCount
  conversions: [
    "purchaseCcnt",
    "conversions",
    "lastClickConversions",
    "convCount",
    "purCnt",
    "ccnt",
    "convCnt",
    "cvCnt",
    "conversionCount",
    "conversion",
  ],
};

// 매체별 override — Spike 결과로 채움. 비어있으면 METRIC_ALIASES에 fallback.
const METRIC_OVERRIDES: Partial<Record<PeriodCompareMedia, Partial<Record<MetricKey, string[]>>>> =
  {
    // SA 4매체(파워링크/쇼핑/브랜드/파워컨텐츠)는 위 alias로 동일.
    // 플레이스·GFA는 Spike 결과로 추후 추가.
  };

export function extractMetricsFromResponse(
  media: PeriodCompareMedia,
  response: unknown,
): NormalizedMetrics {
  const result: NormalizedMetrics = {
    impressions: null,
    clicks: null,
    ctr: null,
    cpc: null,
    cost: null,
    revenue: null,
    conversions: null,
    roas: null,
  };
  if (response == null) return result;

  // 응답 안에서 총합(summary/total) 객체 또는 array sum을 추출
  const aggregates = collectAggregates(response);
  if (!aggregates) return result;

  const overrides = METRIC_OVERRIDES[media] ?? {};
  // roas는 항상 계산 필드. ctr은 응답에 있으면 직접 사용하고 없으면 계산.
  const aliasedKeys: MetricKey[] = [
    "impressions",
    "clicks",
    "ctr",
    "cpc",
    "cost",
    "revenue",
    "conversions",
  ];
  for (const key of aliasedKeys) {
    const aliases = overrides[key] ?? METRIC_ALIASES[key];
    const found = pickFirst(aggregates, aliases);
    if (found != null) result[key] = found;
  }

  // 비율 지표(CTR/CPC/ROAS)는 base totals에서 항상 재계산.
  // 이유: 다중 row 응답을 합산할 때 비율도 합산되면 잘못된 값이 됨
  // (예: 7일치 CTR row 합 = 8.27%, 실제는 1.18%). base는 합산해도 정확.
  // 응답에 비율이 직접 있어도 합산일 가능성이 있어 일관되게 재계산.
  if (result.impressions != null && result.impressions > 0 && result.clicks != null) {
    result.ctr = (result.clicks / result.impressions) * 100;
  }
  if (result.cost != null && result.clicks != null && result.clicks > 0) {
    result.cpc = result.cost / result.clicks;
  }
  if (result.revenue != null && result.cost != null && result.cost > 0) {
    result.roas = (result.revenue / result.cost) * 100;
  }

  return result;
}

/**
 * 응답 구조에서 "전체 집계" 숫자 묶음을 찾아 평탄화된 dict로 반환.
 *
 * 우선순위:
 *   1. 알려진 총계 wrapper 객체 (summary/total/overview/metrics/reportData/data.summary 등)
 *   2. wrapper가 객체이면 안쪽 직접 numeric (data.{metrics 키들})
 *   3. data/list/items/rows array — "전체" 라벨 row 또는 sum
 *   4. response 자체가 단일 stats 객체
 *   5. 깊이 walk — 어떤 nested 위치에 있어도 stats 키가 2개 이상인 노드 찾음
 */
function collectAggregates(response: unknown): Record<string, number> | null {
  if (response == null || typeof response !== "object") return null;
  const root = response as Record<string, unknown>;

  // 1. 알려진 총계 객체 키 — SA: summary, 검색광고 대시보드(/apis/dashboard): overview·metrics·reportData 등 추정
  const SUMMARY_KEYS = [
    "summary", "total", "totals", "totalRow", "aggregates",
    "overview", "metrics", "reportData", "report", "stats",
  ];
  for (const sumKey of SUMMARY_KEYS) {
    const v = root[sumKey];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const num = numericKeys(v as Record<string, unknown>);
      if (statsKeyCount(num) >= 2) return num;
    }
  }

  // 2. data/result/payload wrapper가 객체일 때 — 안쪽 직접 numeric 또는 안쪽의 summary
  const WRAPPERS = ["data", "result", "response", "payload", "body"];
  for (const wrapKey of WRAPPERS) {
    const v = root[wrapKey];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner = v as Record<string, unknown>;
      // 2a. wrapper 자체가 metric 객체
      const numDirect = numericKeys(inner);
      if (statsKeyCount(numDirect) >= 2) return numDirect;
      // 2b. wrapper 안에 summary 키가 또 있음
      for (const sumKey of SUMMARY_KEYS) {
        const v2 = inner[sumKey];
        if (v2 && typeof v2 === "object" && !Array.isArray(v2)) {
          const num = numericKeys(v2 as Record<string, unknown>);
          if (statsKeyCount(num) >= 2) return num;
        }
      }
    }
  }

  // 3. data/list/items/rows를 찾음
  const arr = pickArray(root);
  if (arr && arr.length > 0) {
    // 마지막 원소가 합계라면 라벨 키에 "전체"/"total"/"합계" 등이 들어있음
    const last = arr[arr.length - 1];
    if (last && typeof last === "object") {
      const obj = last as Record<string, unknown>;
      const labelLike = Object.values(obj).find(
        (v) =>
          typeof v === "string" && /전체|total|합계|sum/i.test(v as string),
      );
      if (labelLike !== undefined) {
        const num = numericKeys(obj);
        if (statsKeyCount(num) >= 2) return num;
      }
    }
    // 그 외에는 array 전체 합산
    const summed: Record<string, number> = {};
    for (const row of arr) {
      if (row && typeof row === "object") {
        const num = numericKeys(row as Record<string, unknown>);
        for (const [k, v] of Object.entries(num)) {
          summed[k] = (summed[k] ?? 0) + v;
        }
      }
    }
    if (statsKeyCount(summed) >= 2) return summed;
  }

  // 4. 응답 자체가 단일 stats 객체 (top-level에 metric 키들이 펼쳐져 있는 경우)
  const numTop = numericKeys(root);
  if (statsKeyCount(numTop) >= 2) return numTop;

  // 5. 깊이 walk fallback — 응답이 임의 구조여도 stats 노드(또는 stats row 배열) 찾음.
  // 대시보드/GFA처럼 wrapper 키 이름이 다르거나 더 깊이 nested 된 경우 cover.
  return deepFindStatsNode(root, 0);
}

/**
 * 응답 트리를 walk하면서 stats node를 찾는다. 두 가지 패턴 cover:
 *   A. 객체 자체가 stats 노드 (직접 + 1-level nested 머지)
 *   B. 객체가 `{id: statsRow|null}` 맵 (GFA campaignStats 패턴) — 각 value를 stats row로 보고 합산
 * 둘 중 stats hint key가 더 많은 쪽 채택.
 */
function deepFindStatsNode(node: unknown, depth: number): Record<string, number> | null {
  if (depth > 6 || node == null) return null;
  if (Array.isArray(node)) {
    const arrSummed = sumStatsRows(node);
    if (arrSummed) return arrSummed;
    // 합산 실패 → 배열 안 row 안쪽으로 재귀 (또 다른 nested 구조)
    for (let i = 0; i < Math.min(node.length, 3); i++) {
      const inner = deepFindStatsNode(node[i], depth + 1);
      if (inner) return inner;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  // Pattern A — 자체 stats 노드
  const direct = shallowMergedStats(obj);
  // Pattern B — 자식 value들을 stats row로 합산 (GFA의 {camp_id: campaignObj} 패턴)
  //   extractStatsFromRow가 1-level nested 머지하므로 campaign 안쪽 conversion 데이터까지 포함.
  const fromChildren = sumStatsRows(Object.values(obj));

  const directScore = statsKeyCount(direct);
  const childrenScore = fromChildren ? statsKeyCount(fromChildren) : 0;

  // 더 풍부한 쪽 채택. 동점이면 직접(단순 케이스 보존).
  if (childrenScore > directScore && childrenScore >= 2 && fromChildren) {
    return fromChildren;
  }
  if (directScore >= 2) return direct;

  // 둘 다 부족 — 자식 노드 개별 재귀 fallback
  for (const v of Object.values(obj)) {
    const inner = deepFindStatsNode(v, depth + 1);
    if (inner) return inner;
  }
  return null;
}

/**
 * 배열 또는 객체 values 배열을 받아 stats row로 보고 합산.
 */
function sumStatsRows(rows: unknown[]): Record<string, number> | null {
  const summed: Record<string, number> = {};
  let contributed = 0;
  for (let i = 0; i < Math.min(rows.length, 200); i++) {
    const rowStats = extractStatsFromRow(rows[i]);
    if (rowStats) {
      for (const [k, v] of Object.entries(rowStats)) summed[k] = (summed[k] ?? 0) + v;
      contributed++;
    }
  }
  return contributed > 0 && statsKeyCount(summed) >= 2 ? summed : null;
}

/**
 * 단일 row에서 stats 숫자 dict 추출.
 * - GFA: 평탄 (impCount/cpc/sales) + nested conversion.{convCount, convSalesKRW} 머지 필요
 * - 검색광고 dashboard: row = {segments: {day}, metrics: {impressions, ...}} — metrics가 nested
 * 둘 다 cover하려면 직접 + 1단계 nested 모두 머지. 같은 키 충돌 시 직접 우선.
 */
function extractStatsFromRow(row: unknown): Record<string, number> | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const merged = shallowMergedStats(row as Record<string, unknown>);
  return statsKeyCount(merged) >= 2 ? merged : null;
}

/**
 * 객체의 직접 numeric + 1단계 nested 객체의 numeric을 머지.
 * 같은 키가 양쪽에 있으면 직접(상위) 값 유지.
 */
function shallowMergedStats(obj: Record<string, unknown>): Record<string, number> {
  const merged: Record<string, number> = {};
  Object.assign(merged, numericKeys(obj));
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = numericKeys(v as Record<string, unknown>);
      for (const [nk, nv] of Object.entries(nested)) {
        if (merged[nk] === undefined) merged[nk] = nv;
      }
    }
  }
  return merged;
}

/**
 * obj의 키들 중 stats hint key(impCnt, clkCnt, cost 등 — STATS_HINT_KEYS와 일치)에
 * 해당하는 개수를 센다. 2개 이상이면 그 노드는 stats 응답으로 간주.
 */
function statsKeyCount(obj: Record<string, number>): number {
  let n = 0;
  for (const k of Object.keys(obj)) {
    const lower = k.toLowerCase();
    if (STATS_HINT_KEYS.some((h) => lower === h || lower.includes(h))) n++;
  }
  return n;
}

function pickArray(root: Record<string, unknown>): unknown[] | null {
  for (const k of ["data", "list", "items", "rows", "result", "results", "records"]) {
    const v = root[k];
    if (Array.isArray(v)) return v;
    // 한 단계 안에 또 있는 케이스: { data: { list: [...] } }
    if (v && typeof v === "object") {
      const inner = v as Record<string, unknown>;
      for (const k2 of ["list", "items", "rows", "data"]) {
        const v2 = inner[k2];
        if (Array.isArray(v2)) return v2;
      }
    }
  }
  return null;
}

function numericKeys(obj: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    let n: number | null = null;
    if (typeof v === "number" && Number.isFinite(v)) n = v;
    // 문자열 숫자도 캐치 (페이지가 큰 숫자를 string으로 보내는 케이스)
    else if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) n = parsed;
    }
    if (n == null) continue;
    // *Micros suffix = 1,000,000 단위 (네이버 SA stats). 원 단위로 정규화.
    if (/Micros$/i.test(k)) n = n / 1_000_000;
    out[k] = n;
  }
  return out;
}

function pickFirst(
  agg: Record<string, number>,
  aliases: string[],
): number | null {
  // case-insensitive 키 매칭
  const lowered = new Map<string, string>();
  for (const k of Object.keys(agg)) lowered.set(k.toLowerCase(), k);
  for (const alias of aliases) {
    const hit = lowered.get(alias.toLowerCase());
    if (hit) return agg[hit];
  }
  return null;
}

// ─── 날짜 shift (URL + body의 startDate/endDate를 직전 기간으로) ───

export interface ShiftedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * capture된 fetch의 URL/body 안에서 `startDate`/`endDate`에 해당하는
 * 날짜 string을 찾아 직전 기간으로 치환.
 *
 * 동작 원리: 현재 기간 start/end를 여러 포맷(YYYY-MM-DD, YYYYMMDD, YYYY.MM.DD)
 * 으로 만든 뒤 URL 쿼리스트링과 body JSON 안의 모든 string을 훑어 매치되는
 * 값만 직전 기간의 같은 포맷 문자열로 교체. 페이지의 어떤 키 이름을 쓰든
 * 무관하게 동작한다 (`startDate`, `from`, `period.start` 등).
 */
export function shiftDateParams(
  cap: PeriodCompareCapture,
  curStart: Date,
  curEnd: Date,
  prevStart: Date,
  prevEnd: Date,
): ShiftedRequest {
  const formats: Array<{ sep: string }> = [
    { sep: "-" },
    { sep: "." },
    { sep: "/" },
    { sep: "" },
  ];

  const replacements: Array<[string, string]> = [];
  for (const fmt of formats) {
    replacements.push([fmtDate(curStart, fmt.sep), fmtDate(prevStart, fmt.sep)]);
    replacements.push([fmtDate(curEnd, fmt.sep), fmtDate(prevEnd, fmt.sep)]);
  }

  // URL replace — query string·path 모두 훑음. 안전을 위해 string replace 사용.
  let newUrl = cap.url;
  for (const [a, b] of replacements) {
    if (a !== b) newUrl = newUrl.split(a).join(b);
  }

  // Body replace
  let newBody: string | null = cap.body;
  if (newBody) {
    try {
      const parsed = JSON.parse(newBody);
      const shifted = shiftDatesInValue(parsed, replacements);
      newBody = JSON.stringify(shifted);
    } catch {
      // JSON 아닌 body — string replace로 폴백
      for (const [a, b] of replacements) {
        if (a !== b && newBody) newBody = newBody.split(a).join(b);
      }
    }
  }

  return {
    url: newUrl,
    method: cap.method,
    headers: cap.headers,
    body: newBody,
  };
}

function fmtDate(d: Date, sep: string): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return sep ? `${y}${sep}${m}${sep}${dd}` : `${y}${m}${dd}`;
}

function shiftDatesInValue(
  v: unknown,
  replacements: Array<[string, string]>,
): unknown {
  if (typeof v === "string") {
    for (const [a, b] of replacements) {
      if (v === a) return b;
    }
    // 부분 매치 — 예: "2026-05-12T00:00:00" 같은 경우
    let mutated = v;
    let changed = false;
    for (const [a, b] of replacements) {
      if (a !== b && mutated.includes(a)) {
        mutated = mutated.split(a).join(b);
        changed = true;
      }
    }
    return changed ? mutated : v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => shiftDatesInValue(x, replacements));
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = shiftDatesInValue(val, replacements);
    }
    return out;
  }
  return v;
}
