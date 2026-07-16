// F-Report 데이터 수집 — 검색광고 다차원보고서(advanced-report) 클라이언트.
//
// `GET /apis/sa/api/advanced-report/values`는 attributes(분해 차원)만 바꿔가며 일자별/지면별/
// 성별·연령/검색어/키워드/캠페인유형 등을 동기 한 번에 준다(2026-06-23 정찰, 메모리
// project_f_report_endpoints). 응답은 {head, body[][], totalResults} — head 순서 = row 값 순서.
//
// cross-account는 다른 sa/api 패턴과 동일하게 x-ad-customer-id(masterCustomerId) 헤더로 — 단
// advanced-report 자체의 헤더 cross-account는 라이브 미검증이라 호출 측에서 결과 검증 필요.

import { authFetch } from "@/features/multi-account/multi-account-data";
import type { DateRange } from "./report-period";

// 양식이 쓰는 전체 지표. 숫자는 원 단위(salesAmt=광고비/총비용, convAmt=전체전환매출).
export const REPORT_METRICS =
  "impCnt,clkCnt,ctr,cpc,salesAmt,ccnt,drtCcnt,idrtCcnt,crto,ror,purchaseCcnt,purchaseConvAmt,convAmt";

export interface AdvReportResult {
  head: string[];
  rows: string[][];
  totalResults: number;
}

// 서버 필터 (2026-07-16 라이브 정찰, 메모리 project_advanced_report_filters).
// leaf는 `in`(집합)과 `bound`(수치 비교) 둘뿐이고, 최상위는 항상 and로 묶인다.
// `in`의 값은 표시명이 아니라 **코드** — 표시명을 넣으면 에러 없이 조용히 0건이 되니 주의.
export type AdvReportFilter =
  | { type: "in"; field: string; values: string[] }
  | { type: "bound"; field: string; operator: "gt" | "lt" | "gte" | "lte"; value: number };

// nccCampaignTp 필터값. ncc API의 enum(WEB_SITE/SHOPPING_NS...)과 **다르다**.
export const CAMPAIGN_TP_CODE = { 파워링크: "SITE", 쇼핑검색: "SHOPPING", 브랜드검색: "BRAND" } as const;

export interface AdvReportQuery {
  attributes: string[]; // 분해 차원 (빈 배열 = 전체 합계 1행)
  range: DateRange;
  customerId: number;
  fields?: string; // 기본 REPORT_METRICS
  pageSize?: number; // 기본 1000
  maxRows?: number; // 안전 상한 (기본 5000)
  filters?: AdvReportFilter[]; // 서버 필터 (and 결합). 총행수를 줄여 왕복 횟수를 줄이는 게 핵심.
}

// 한 차원 조합으로 advanced-report 호출. totalResults가 pageSize를 넘으면 startIndex로 페이지네이션.
export async function fetchAdvancedReport(q: AdvReportQuery): Promise<AdvReportResult> {
  const fields = q.fields ?? REPORT_METRICS;
  const pageSize = q.pageSize ?? 1000;
  const maxRows = q.maxRows ?? 5000;
  const valuesParam = encodeURIComponent(JSON.stringify({ type: "metric", fields }));
  const attrParam = q.attributes.join(",");
  // 최상위 type은 반드시 "and" (서버가 강제). 필터가 없으면 파라미터 자체를 빼야 400이 안 난다.
  const filterParam = q.filters?.length
    ? `&filters=${encodeURIComponent(JSON.stringify({ type: "and", filters: q.filters }))}`
    : "";

  let head: string[] = [];
  const rows: string[][] = [];
  let total = 0;
  let start = 0;
  do {
    // requestTotalResults는 첫 페이지에만. 매 페이지마다 켜면 서버가 그때마다 총개수를 다시 세서,
    // 페이지가 많을수록 순전한 낭비가 된다(총개수는 안 변한다).
    const url =
      `/apis/sa/api/advanced-report/values?attributes=${attrParam}` +
      `&values=${valuesParam}` +
      `&since=${q.range.since}&until=${q.range.until}` +
      `&startIndex=${start}&numberOfResults=${pageSize}` +
      (start === 0 ? "&requestTotalResults=1" : "") +
      filterParam;
    const json = await authFetch<{
      head?: string[];
      body?: string[][];
      totalResults?: number;
    }>(url, undefined, q.customerId);
    head = json.head ?? head;
    const body = json.body ?? [];
    rows.push(...body);
    // 총개수는 첫 페이지에서만 확정한다. 매 페이지 덮어쓰면 2페이지부터 totalResults가 없어
    // total이 rows.length가 되고 루프가 그 자리에서 멈춘다(= 조용한 데이터 누락).
    if (start === 0) total = json.totalResults ?? body.length;
    start += pageSize;
    if (body.length === 0) break;
  } while (rows.length < total && rows.length < maxRows);

  // maxRows에 걸려 끊기면 뒤쪽 행이 통째로 빠진다. 응답이 유형별로 뭉쳐 오면 특정 광고 유형이
  // 0건이 되어 시트가 사라지기까지 한다(쇼핑검색 키워드 실종 사고). 조용히 지나가면 원인 추적이
  // 불가능하므로 반드시 남긴다.
  if (rows.length < total) {
    console.warn(
      `[dv-ads/report] advanced-report 잘림 — ${attrParam}: ${rows.length}/${total}행만 수집(maxRows=${maxRows})`,
    );
  }

  return { head, rows, totalResults: total };
}

// head 기준 컬럼 인덱스 맵 — row[idx[col]]로 값 접근.
export function colIndex(head: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  head.forEach((h, i) => (m[h] = i));
  return m;
}

// "[저당 베이글 6개입](cmp-a001-02-000000010757785)" → {name, id}
export function parseEntity(cell: string): { name: string; id: string } {
  const m = cell.match(/^\[(.*)\]\(([^)]+)\)$/);
  if (m) return { name: m[1].trim(), id: m[2] };
  return { name: cell.trim(), id: "" };
}

export function num(v: string | undefined): number {
  if (v == null) return 0;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

// 양식 한 행(금주/전주/매체별/일자별...)에 들어갈 정규화 지표.
// 전환 파생값(전환율/전환당비용/ROAS)은 모두 '구매완료' 기준. 직접/간접 전환수만 별도 표기.
export interface ReportMetrics {
  impressions: number; // C 노출
  clicks: number; // D 클릭
  cost: number; // G 총비용 (salesAmt)
  purchaseConv: number; // H 구매완료 전환수 (purchaseCcnt)
  revenue: number; // K 매출액 = 구매완료 전환매출 (purchaseConvAmt)
  directConv: number; // M 직접 전환수 (drtCcnt)
  indirectConv: number; // N 간접 전환수 (idrtCcnt)
}

export const ZERO_METRICS: ReportMetrics = {
  impressions: 0,
  clicks: 0,
  cost: 0,
  purchaseConv: 0,
  revenue: 0,
  directConv: 0,
  indirectConv: 0,
};

// advanced-report row → ReportMetrics (양식 입력칸 추출, 파생은 양식 수식/metricValues가 계산).
export function rowMetrics(row: string[], idx: Record<string, number>): ReportMetrics {
  return {
    impressions: num(row[idx["impCnt"]]),
    clicks: num(row[idx["clkCnt"]]),
    cost: num(row[idx["salesAmt"]]),
    purchaseConv: num(row[idx["purchaseCcnt"]]),
    revenue: num(row[idx["purchaseConvAmt"]]),
    directConv: num(row[idx["drtCcnt"]]),
    indirectConv: num(row[idx["idrtCcnt"]]),
  };
}

// 양식 12지표 순서: 노출/클릭/클릭률/CPC/총비용/구매완료/전환율/전환당비용/매출액/ROAS/직접/간접.
// 비율(클릭률/전환율/ROAS)은 소수 — 양식 셀 서식이 %로 표시.
export function metricValues(m: ReportMetrics): number[] {
  const d = (a: number, b: number) => (b ? a / b : 0);
  return [
    m.impressions,
    m.clicks,
    d(m.clicks, m.impressions),
    d(m.cost, m.clicks),
    m.cost,
    m.purchaseConv, // 구매완료
    d(m.purchaseConv, m.clicks), // 전환율 (구매완료 기준)
    d(m.cost, m.purchaseConv), // 전환당비용 (구매완료 기준)
    m.revenue, // 매출액 (구매완료 전환매출)
    d(m.revenue, m.cost), // ROAS (구매완료 기준)
    m.directConv,
    m.indirectConv,
  ];
}

function isWide(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xffef)
  );
}

// 한글/전각=2칸으로 세는 표시 길이. **표지 업체명 박스 폭 계산 전용**(ADV_BOX_PER_UNIT이 이 기준으로
// 보정돼 있다). 열 너비에는 쓰지 말 것 — 아래 colWidthLen을 쓴다.
export function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) n += isWide(ch) ? 2 : 1;
  return n;
}

// ── 열 너비 자동 계산 ──
// 엑셀 열 너비 단위 = 기본 글꼴 '0' 글자 폭. 한글은 그 1.7배쯤이지 2배가 아니다.
// 2로 세면 한글이 많은 열(캠페인/그룹/키워드/상품명)이 15%씩 넓어진다.
// 1.7은 라이브 보정값 — 사용자가 엑셀에서 직접 맞춘 상품명 열(폭 90.3, 한글 40자 + 그 외 21자)을
// 역산해 나온 값이다(그 폭이면 한글 1자 ≈ 1.71칸). 숫자·영문 열은 영향 없다.
const WIDE_CHAR_WIDTH = 1.7;
export function colWidthLen(s: string): number {
  let n = 0;
  for (const ch of s) n += isWide(ch) ? WIDE_CHAR_WIDTH : 1;
  return n;
}

// +2 = 셀 좌우 여백 + 볼드 헤더 몫. 예전엔 `*1.1 + 3`이라 9자리 숫자 열에 12.9를 줘(43% 여유)
// 표가 쓸데없이 넓었다. cap 기본 55 — 상품명처럼 전체가 보여야 하는 열만 호출부에서 올려 넘긴다.
export function widthFor(maxLen: number, cap = 55): number {
  return Math.min(cap, Math.max(7, maxLen + 2));
}
// 너비 추정용 표시 문자열(클릭률/전환율/ROAS=%, 나머지=콤마 숫자). i = metricValues 순서.
export function metricStr(i: number, v: number): string {
  if (i === 2 || i === 6 || i === 9) return (v * 100).toFixed(1) + "%";
  return Math.round(v).toLocaleString("ko-KR");
}
// 12지표 헤더(양식 공통). 너비 계산용.
export const METRIC_HEADERS = [
  "노출", "클릭", "클릭률", "CPC", "총비용", "구매완료", "전환율", "전환당비용",
  "매출액", "ROAS", "직접 전환수", "간접 전환수",
];

export function addMetrics(a: ReportMetrics, b: ReportMetrics): ReportMetrics {
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    cost: a.cost + b.cost,
    purchaseConv: a.purchaseConv + b.purchaseConv,
    revenue: a.revenue + b.revenue,
    directConv: a.directConv + b.directConv,
    indirectConv: a.indirectConv + b.indirectConv,
  };
}
