// 모든 시트를 채운 완전 샘플 생성(합성 데이터) → Downloads. 실데이터 연결 전 육안 검증용.
// node --import ./scripts/ts-resolve.mjs scripts/make-full-sample.ts
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, forceRecalc, removeSheets, removeSheetDrawing, removeCalcChain, replaceChartColor, readText, writeText, hideRowRange } from "../src/features/report/report-excel.ts";
import { fillFixedSheets, type ReportModel } from "../src/features/report/report-fill.ts";
import { renderKeywordSheet, renderCampaignSheet, renderSummaryTypes, renderDetailPlacement } from "../src/features/report/report-variable.ts";
import type { ReportMetrics } from "../src/features/report/report-data.ts";

const M = (i: number, c: number, co: number, r: number, d: number, n: number): ReportMetrics =>
  ({ impressions: i, clicks: c, cost: co, revenue: r, directConv: d, indirectConv: n });

const model: ReportModel = {
  advertiserName: "샘플 광고주",
  periodText: "2026.06.15 ~ 2026.06.21",
  authorName: "디브이마케팅",
  createdDate: "2026.06.23",
  curPeriodLabel: "설정 기간(2026.06.15~2026.06.21)",
  prevPeriodLabel: "이전 기간(2026.06.08~2026.06.14)",
  totalCurrent: M(225000, 7510, 7252000, 21715000, 252, 109),
  totalPrev: M(214000, 7100, 6980000, 20600000, 240, 100),
  searchCurrent: M(225000, 7510, 7252000, 21715000, 252, 109),
  searchPrev: M(214000, 7100, 6980000, 20600000, 240, 100),
  displayCurrent: M(0, 0, 0, 0, 0, 0),
  summaryByDay: [],
  summaryByDayIsSearchOnly: false,
  byDay: [
    { label: "06/15 (월)", metrics: M(28000, 980, 920000, 2500000, 34, 14) },
    { label: "06/16 (화)", metrics: M(26500, 910, 880000, 2300000, 30, 13) },
    { label: "06/17 (수)", metrics: M(27200, 940, 900000, 2400000, 33, 12) },
    { label: "06/18 (목)", metrics: M(25800, 870, 850000, 2150000, 28, 15) },
    { label: "06/19 (금)", metrics: M(26000, 900, 870000, 2250000, 31, 13) },
    { label: "06/20 (토)", metrics: M(29500, 1010, 940000, 2600000, 36, 16) },
    { label: "06/21 (일)", metrics: M(25200, 900, 840000, 2400000, 30, 14) },
  ],
  byPlacement: [
    { label: "네이버 통합검색_PC", metrics: M(35000, 1250, 1560000, 4200000, 48, 20) },
    { label: "네이버 통합검색_모바일", metrics: M(78000, 2600, 2200000, 6800000, 90, 38) },
    { label: "네이버 쇼핑_PC", metrics: M(22000, 560, 720000, 1900000, 26, 11) },
    { label: "네이버 쇼핑_모바일", metrics: M(41000, 980, 1180000, 2300000, 30, 14) },
  ],
  byGender: [
    { label: "남성", metrics: M(95000, 3100, 2900000, 7200000, 105, 45) },
    { label: "여성", metrics: M(88000, 3200, 3100000, 8800000, 110, 48) },
    { label: "알수없음", metrics: M(5200, 210, 200000, 400000, 5, 2) },
  ],
  byAge: [
    { label: "19~24세", metrics: M(18000, 620, 520000, 1300000, 18, 8) },
    { label: "25~29세", metrics: M(32000, 1150, 1050000, 3200000, 42, 18) },
    { label: "30~34세", metrics: M(38000, 1320, 1280000, 3900000, 50, 22) },
    { label: "35~39세", metrics: M(34000, 1180, 1120000, 3300000, 44, 19) },
  ],
  hasSearch: true,
  hasDisplay: false,
};

const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
fillFixedSheets(files, model);
renderSummaryTypes(
  files,
  [
    { label: "파워링크", metrics: M(120000, 3200, 3000000, 9000000, 80, 35) },
    { label: "쇼핑검색광고", metrics: M(105000, 4310, 4252000, 12715000, 172, 74) },
  ],
  [],
);
renderCampaignSheet(files, "xl/worksheets/sheet3.xml", [
  {
    type: "파워링크",
    rows: [
      { group: "브랜드", metrics: M(25000, 720, 820000, 2900000, 30, 12) },
      { group: "핵심키워드", metrics: M(38000, 980, 1120000, 2400000, 18, 8) },
      { group: "세부키워드", metrics: M(20000, 540, 560000, 800000, 8, 4) },
    ],
  },
  {
    type: "쇼핑검색광고",
    rows: [
      { group: "핵심상품", metrics: M(40000, 920, 1380000, 3600000, 90, 42) },
      { group: "신상품", metrics: M(18000, 320, 490000, 1160000, 20, 9) },
    ],
  },
]);
renderKeywordSheet(files, "xl/worksheets/sheet5.xml", [
  {
    campaign: "파워링크",
    group: "브랜드",
    keywords: [
      { keyword: "케라셀", metrics: M(7000, 300, 540000, 1900000, 26, 11) },
      { keyword: "케라셀네일", metrics: M(2400, 95, 140000, 360000, 4, 2) },
    ],
  },
  {
    campaign: "파워링크",
    group: "핵심키워드",
    keywords: [
      { keyword: "발톱영양제", metrics: M(8500, 310, 480000, 1400000, 18, 8) },
      { keyword: "손톱강화제", metrics: M(6200, 240, 360000, 980000, 12, 5) },
    ],
  },
]);
renderKeywordSheet(
  files,
  "xl/worksheets/sheet6.xml",
  [
    {
      campaign: "쇼핑검색광고",
      group: "핵심상품",
      keywords: [
        { keyword: "케라셀 풋크림", metrics: M(18000, 420, 640000, 2200000, 55, 25) },
        { keyword: "케라셀 네일", metrics: M(12000, 300, 460000, 1100000, 28, 12) },
      ],
    },
  ],
  "쇼핑검색 키워드별 성과",
);

// 검색_상세 지면별 → 맨 아래 동적 + 옛 영역 삭제 + 지면 그래프 제거(내부) + 성별 여성색
renderDetailPlacement(files, model.byPlacement);
replaceChartColor(files, "xl/charts/chart5.xml", "92D050", "F67676");
// 종합 시트 그래프 2개 제외 + 빈 영역(3~16행) 숨김
removeSheetDrawing(files, "xl/worksheets/sheet2.xml");
writeText(files, "xl/worksheets/sheet2.xml", hideRowRange(readText(files, "xl/worksheets/sheet2.xml"), 3, 16));
// 디스플레이 미진행 → 디스플레이 시트 2개 제거
if (!model.hasDisplay) removeSheets(files, ["디스플레이", "디스플레이_상세"]);
removeCalcChain(files);
forceRecalc(files);

const out = buildXlsx(files);
const dest = process.argv[2] ?? "dist-full-sample.xlsx";
writeFileSync(dest, out);
console.log(`완전 샘플 생성 → ${dest} (${out.length} bytes)`);
