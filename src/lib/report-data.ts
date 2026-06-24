// F-Report 데이터 수집 — 검색광고 다차원보고서(advanced-report) 클라이언트.
//
// `GET /apis/sa/api/advanced-report/values`는 attributes(분해 차원)만 바꿔가며 일자별/지면별/
// 성별·연령/검색어/키워드/캠페인유형 등을 동기 한 번에 준다(2026-06-23 정찰, 메모리
// project_f_report_endpoints). 응답은 {head, body[][], totalResults} — head 순서 = row 값 순서.
//
// cross-account는 다른 sa/api 패턴과 동일하게 x-ad-customer-id(masterCustomerId) 헤더로 — 단
// advanced-report 자체의 헤더 cross-account는 라이브 미검증이라 호출 측에서 결과 검증 필요.

import { authFetch } from "./multi-account-data";
import type { DateRange } from "./report-period";

// 양식이 쓰는 전체 지표. 숫자는 원 단위(salesAmt=광고비/총비용, convAmt=전체전환매출).
export const REPORT_METRICS =
  "impCnt,clkCnt,ctr,cpc,salesAmt,ccnt,drtCcnt,idrtCcnt,crto,ror,purchaseCcnt,purchaseConvAmt,convAmt";

export interface AdvReportResult {
  head: string[];
  rows: string[][];
  totalResults: number;
}

export interface AdvReportQuery {
  attributes: string[]; // 분해 차원 (빈 배열 = 전체 합계 1행)
  range: DateRange;
  customerId: number;
  fields?: string; // 기본 REPORT_METRICS
  pageSize?: number; // 기본 1000
  maxRows?: number; // 안전 상한 (기본 5000)
}

// 한 차원 조합으로 advanced-report 호출. totalResults가 pageSize를 넘으면 startIndex로 페이지네이션.
export async function fetchAdvancedReport(q: AdvReportQuery): Promise<AdvReportResult> {
  const fields = q.fields ?? REPORT_METRICS;
  const pageSize = q.pageSize ?? 1000;
  const maxRows = q.maxRows ?? 5000;
  const valuesParam = encodeURIComponent(JSON.stringify({ type: "metric", fields }));
  const attrParam = q.attributes.join(",");

  let head: string[] = [];
  const rows: string[][] = [];
  let total = 0;
  let start = 0;
  do {
    const url =
      `/apis/sa/api/advanced-report/values?attributes=${attrParam}` +
      `&values=${valuesParam}` +
      `&since=${q.range.since}&until=${q.range.until}` +
      `&startIndex=${start}&numberOfResults=${pageSize}&requestTotalResults=1`;
    const json = await authFetch<{
      head?: string[];
      body?: string[][];
      totalResults?: number;
    }>(url, undefined, q.customerId);
    head = json.head ?? head;
    const body = json.body ?? [];
    rows.push(...body);
    total = json.totalResults ?? rows.length;
    start += pageSize;
    if (body.length === 0) break;
  } while (rows.length < total && rows.length < maxRows);

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

// ── 열 너비 자동 계산 (내용 잘림 방지). 한글/전각=2칸. 엑셀 열너비 단위 ≈ 문자 수. ──
export function visualLen(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xff00 && c <= 0xffef);
    n += wide ? 2 : 1;
  }
  return n;
}
export function widthFor(maxVisual: number): number {
  return Math.min(55, Math.max(8, maxVisual * 1.1 + 3));
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
