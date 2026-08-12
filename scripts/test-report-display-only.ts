// 검색광고 제외(saCampaignIds=[]) 디스플레이 단독 리포트 검증 (합성 데이터).
// hasSearch=false 경로: 종합 검색광고 행 숨김 + 검색 계열 시트 제거 + 합계는 디스플레이 값만.
// node --import ./scripts/ts-resolve.mjs scripts/test-report-display-only.ts
import { readFileSync, writeFileSync } from "node:fs";
import {
  openXlsx, buildXlsx, readText, writeText, forceRecalc, removeSheets, removeSheetDrawing, hideRowRange,
} from "../src/features/report/report-excel.ts";
import { fillFixedSheets, type ReportModel } from "../src/features/report/report-fill.ts";
import { renderCampaignSheet, DISPLAY_CAMPAIGN_LAYOUT, type CampaignTypeGroup } from "../src/features/report/report-variable.ts";
import type { ReportMetrics } from "../src/features/report/report-data.ts";

const M = (imp: number, clk: number, cost: number, pc: number, rev: number, dir: number, indir: number): ReportMetrics => ({
  impressions: imp, clicks: clk, cost, purchaseConv: pc, revenue: rev, directConv: dir, indirectConv: indir,
});
const ZERO = M(0, 0, 0, 0, 0, 0, 0);

// 검색광고 제외 — search* 지표는 전부 0, 종합 = 디스플레이 값.
const model: ReportModel = {
  advertiserName: "디스플레이 단독 테스트",
  periodText: "2026.06.16 ~ 2026.06.22",
  authorName: "홍길동",
  createdDate: "2026.06.24",
  curPeriodLabel: "설정 기간(2026.06.16~2026.06.22)",
  prevPeriodLabel: "이전 기간(2026.06.09~2026.06.15)",
  totalCurrent: M(5820000, 26400, 5300000, 580, 8500000, 0, 0),
  totalPrev: M(5621000, 25500, 5100000, 560, 8200000, 0, 0),
  searchCurrent: ZERO,
  searchPrev: ZERO,
  displayCurrent: M(5820000, 26400, 5300000, 580, 8500000, 0, 0),
  displayPrev: M(5621000, 25500, 5100000, 560, 8200000, 0, 0),
  summaryByDay: [],
  summaryByDayIsSearchOnly: false,
  byDay: [],
  byPlacement: [],
  byGender: [],
  byAge: [],
  displayByDay: [],
  displayByPlacement: [],
  displayByGender: [],
  displayByAge: [],
  hasSearch: false,
  hasDisplay: true,
  hasDisplayDetail: false,
};

const byCampaign: CampaignTypeGroup[] = [
  {
    type: "웹사이트전환",
    rows: [{ group: "리타겟 캠페인", metrics: M(5820000, 26400, 5300000, 580, 8500000, 0, 0) }],
  },
];

// renderReportBytes의 hasSearch=false 경로와 동일한 시퀀스.
const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
fillFixedSheets(files, model);
renderCampaignSheet(files, "xl/worksheets/sheet7.xml", byCampaign, DISPLAY_CAMPAIGN_LAYOUT);
removeSheetDrawing(files, "xl/worksheets/sheet7.xml"); // hasDisplayDetail=false 가드와 동일
writeText(files, "xl/worksheets/sheet7.xml", hideRowRange(readText(files, "xl/worksheets/sheet7.xml"), 3, 13));
removeSheets(files, ["검색광고", "검색_상세", "디스플레이_상세", "파워링크_키워드", "쇼핑검색_키워드", "쇼핑검색_상품"]);
forceRecalc(files);
const out = buildXlsx(files);
writeFileSync("dist-report-display-only-sample.xlsx", out);

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const re = openXlsx(out);

ok(re["xl/worksheets/sheet3.xml"] === undefined, "검색광고 시트 파트 제거됨");
ok(re["xl/worksheets/sheet4.xml"] === undefined, "검색_상세 시트 파트 제거됨");
ok(re["xl/worksheets/sheet7.xml"] !== undefined, "디스플레이 시트 유지");
const wb = readText(re, "xl/workbook.xml");
ok(!wb.includes("검색광고"), "workbook에서 검색광고 시트 항목 제거");
ok(!wb.includes("검색_상세"), "workbook에서 검색_상세 시트 항목 제거");
ok(wb.includes("디스플레이"), "workbook에 디스플레이 시트 유지");

const s2 = readText(re, "xl/worksheets/sheet2.xml");
ok(/<row r="25"[^>]*hidden="1"/.test(s2), "종합 매체표 검색광고 행(25) 숨김");
ok(!/<row r="26"[^>]*hidden="1"/.test(s2), "디스플레이 행(26)은 안 숨김");
ok(/<c r="C26"[^>]*><v>5820000<\/v>/.test(s2), "디스플레이 행 노출(C26)=5820000");
ok(/<c r="C27"[^>]*><v>5820000<\/v>/.test(s2), "합계행 노출(C27)=디스플레이 값만");
ok(/<c r="C18"[^>]*><v>5820000<\/v>/.test(s2), "종합 섹션1 설정 기간 노출(C18)=디스플레이 값");

const s7 = readText(re, "xl/worksheets/sheet7.xml");
ok(/<c r="C15"[^>]*><v>5820000<\/v>/.test(s7), "디스플레이 섹션1 설정 기간 노출(C15)=5820000");

if (fail > 0) { console.error(`\n실패 ${fail}건 ❌`); process.exit(1); }
console.log(`\n전체 통과 ✅  (샘플: dist-report-display-only-sample.xlsx, ${out.length} bytes)`);
