// F-Report 디스플레이(GFA) 분해 데이터 — 비동기 다운로드 보고서 파이프라인.
//
// 일자/지면/성별/연령 분해는 reportPerformanceDetail이 400이라(메모리 project_f_report_endpoints)
// 공식 "다운로드 요청" 파이프라인으로 받는다 (2026-06-24 라이브 확정, 계정 146889):
//   1) POST report/downloads {reportType:"PERFORMANCE", reportQuery} -> {success:true}
//   2) 폴링 GET report/downloads?reportType=PERFORMANCE -> 배열. reportQuery 매칭 + status COMPLETED 의 no
//   3) GET report/downloads/{no}/download -> ZIP(result.csv). fflate unzip
// ⚠️ 연속 POST는 403 rate-limit (1.5초 간격도 실패, 8초는 성공) -> 4종을 간격 두고 순차 호출.
// path에 adAccountNo가 박혀 URL-aware(bmgate 패턴) — 헤더 없이 cross-account. 안전하게 customerId도 동봉.
//
// CSV 10컬럼(헤더 무시, 인덱스 접근):
//   [0]계정명 [1]계정ID [2]차원라벨 [3]총비용 [4]노출수 [5]클릭수 [6]CPC [7]구매완료수 [8]구매완료매출 [9]ROAS%
// GFA는 직접/간접 전환 split이 없어 directConv/indirectConv=0. CPC/ROAS는 양식 수식이 재계산하므로 무시.

import { unzipSync, strFromU8 } from "fflate";
import { authFetch } from "./multi-account-data";
import { type ReportMetrics } from "./report-data";
import type { DateRange } from "./report-period";
import type { NamedMetrics } from "./report-fill";

const COL_LIST = ["sales", "impCount", "clickCount", "cpc", "purchaseConvCount", "purchaseConvSales", "purchaseRoas"];
const POST_GAP_MS = 7000; // 연속 POST 403 회피용 간격
const POLL_INTERVAL_MS = 1000;
const POLL_MAX = 15;

// 다운로드 POST 전역 게이트 — 여러 계정(일괄 리포트)을 병렬 수집해도 디스플레이 다운로드 POST는
// 전역에서 POST_GAP_MS 간격을 지켜야 403(토큰버킷)이 안 난다. 직전 POST 시각을 모듈 전역으로 공유.
// 게이트는 POST 발사까지만 직렬화하고, 그 뒤 폴링·다운로드는 게이트 밖에서 다른 계정과 겹쳐 돈다.
let gatePostAt = 0;
let gateChain: Promise<unknown> = Promise.resolve();
function gatedPost<T>(fn: () => Promise<T>): Promise<T> {
  const run = gateChain.then(async () => {
    const elapsed = gatePostAt ? Date.now() - gatePostAt : POST_GAP_MS;
    if (elapsed < POST_GAP_MS) await sleep(POST_GAP_MS - elapsed);
    gatePostAt = Date.now();
    return fn();
  });
  gateChain = run.catch(() => {});
  return run;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface DimQuery {
  placeUnit: string;
  reportDateUnit: string;
  reportDimension: string;
}

// 양식 디스플레이_상세 4개 영역 ↔ reportQuery 파라미터.
const DIMS: { key: keyof GfaDetailRaw; q: DimQuery }[] = [
  { key: "byDay", q: { placeUnit: "TOTAL", reportDateUnit: "DAY", reportDimension: "TOTAL" } },
  { key: "byPlacement", q: { placeUnit: "PLACEMENT_GROUP", reportDateUnit: "TOTAL", reportDimension: "TOTAL" } },
  { key: "byGender", q: { placeUnit: "TOTAL", reportDateUnit: "TOTAL", reportDimension: "GENDER" } },
  { key: "byAge", q: { placeUnit: "TOTAL", reportDateUnit: "TOTAL", reportDimension: "AGE" } },
];

interface DownloadJob {
  no: number;
  status: string;
  createdAt: string;
  reportQuery?: {
    startDate?: string;
    endDate?: string;
    placeUnit?: string;
    reportDateUnit?: string;
    reportDimension?: string;
  };
}

// raw 라벨(CSV 그대로) NamedMetrics[] — 양식 라벨 정규화/정렬은 호출 측(report-build)에서.
export interface GfaDetailRaw {
  byDay: NamedMetrics[]; // label = "2026.06.21." (날짜 내림차순으로 옴)
  byPlacement: NamedMetrics[]; // label = "네이버+ > 스마트채널" 등 (동적)
  byGender: NamedMetrics[]; // label = "여성"/"남성"/"알 수 없음"
  byAge: NamedMetrics[]; // label = "14세 ~ 18세" 등
}

async function requestReport(adAccountNo: number, customerId: number, reportQuery: object): Promise<void> {
  await authFetch(
    `/apis/gfa/v1/adAccounts/${adAccountNo}/report/downloads`,
    { method: "POST", body: JSON.stringify({ reportType: "PERFORMANCE", reportQuery }) },
    customerId,
  );
}

// 내 reportQuery에 매칭되는 COMPLETED job의 no (가장 최근 생성). 시간 초과 시 throw.
async function pollJobNo(adAccountNo: number, customerId: number, q: DimQuery, range: DateRange): Promise<number> {
  for (let t = 0; t < POLL_MAX; t++) {
    await sleep(POLL_INTERVAL_MS);
    const arr = await authFetch<DownloadJob[]>(
      `/apis/gfa/v1/adAccounts/${adAccountNo}/report/downloads?reportType=PERFORMANCE`,
      undefined,
      customerId,
    );
    const mine = (Array.isArray(arr) ? arr : [])
      .filter((it) => {
        const rq = it.reportQuery ?? {};
        return (
          it.status === "COMPLETED" &&
          rq.startDate === range.since &&
          rq.endDate === range.until &&
          rq.placeUnit === q.placeUnit &&
          rq.reportDateUnit === q.reportDateUnit &&
          rq.reportDimension === q.reportDimension
        );
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (mine[0]) return mine[0].no;
  }
  throw new Error("디스플레이 보고서 생성 대기 시간이 초과됐어요");
}

// ZIP(result.csv) 다운로드 → CSV 텍스트. binary라 authFetch(=json) 못 쓰고 raw fetch.
async function downloadCsv(adAccountNo: number, no: number): Promise<string> {
  const resp = await fetch(`/apis/gfa/v1/adAccounts/${adAccountNo}/report/downloads/${no}/download`, {
    credentials: "include",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = new Uint8Array(await resp.arrayBuffer());
  const files = unzipSync(buf);
  const csvName = Object.keys(files).find((n) => n.endsWith(".csv"));
  if (!csvName) throw new Error("보고서 파일을 찾을 수 없어요");
  return strFromU8(files[csvName]);
}

const num = (s: string | undefined): number => {
  const v = Number((s ?? "").replace(/,/g, ""));
  return Number.isFinite(v) ? v : 0;
};

function parseRows(csv: string): NamedMetrics[] {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  const out: NamedMetrics[] = [];
  for (let i = 1; i < lines.length; i++) {
    // 0행 = 헤더
    const c = lines[i].split(",");
    if (c.length < 9) continue;
    const label = (c[2] ?? "").trim();
    if (!label) continue;
    out.push({
      label,
      metrics: {
        impressions: num(c[4]),
        clicks: num(c[5]),
        cost: num(c[3]),
        purchaseConv: num(c[7]),
        revenue: num(c[8]),
        directConv: 0,
        indirectConv: 0,
      } satisfies ReportMetrics,
    });
  }
  return out;
}

// 디스플레이 분해 4종을 순차 수집. 어느 한 종이 실패하면 전체 throw — 호출 측에서 graceful 처리.
export async function fetchGfaDetail(adAccountNo: number, customerId: number, range: DateRange): Promise<GfaDetailRaw> {
  const base = {
    adAccountNo,
    startDate: range.since,
    endDate: range.until,
    reportAdUnit: "AD_ACCOUNT",
    colList: COL_LIST,
    reportFilterList: [],
  };
  const result: GfaDetailRaw = { byDay: [], byPlacement: [], byGender: [], byAge: [] };
  // rate-limit은 토큰버킷(충전 ~7초/건, 라이브 측정). POST는 전역 게이트(gatedPost)로 간격을 지키고,
  // 폴링·다운로드는 게이트 밖에서 진행돼 다음 POST 간격에 자연 흡수된다(여러 계정 병렬에도 안전).
  for (let i = 0; i < DIMS.length; i++) {
    const { key, q } = DIMS[i];
    await gatedPost(() => requestReport(adAccountNo, customerId, { ...base, ...q }));
    const no = await pollJobNo(adAccountNo, customerId, q, range);
    result[key] = parseRows(await downloadCsv(adAccountNo, no));
  }
  return result;
}
