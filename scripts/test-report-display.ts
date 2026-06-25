// 디스플레이 시트(sheet7) 섹션1(주간요약)+섹션2(캠페인별) 검증 (합성 데이터).
// node --import ./scripts/ts-resolve.mjs scripts/test-report-display.ts
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, readText, forceRecalc, removeSheets } from "../src/lib/report-excel.ts";
import { fillFixedSheets, type ReportModel } from "../src/lib/report-fill.ts";
import { renderCampaignSheet, DISPLAY_CAMPAIGN_LAYOUT, type CampaignTypeGroup } from "../src/lib/report-variable.ts";
import type { ReportMetrics } from "../src/lib/report-data.ts";

// imp, clk, cost, purchaseConv, revenue, direct, indirect
const M = (imp: number, clk: number, cost: number, pc: number, rev: number, dir: number, indir: number): ReportMetrics => ({
  impressions: imp, clicks: clk, cost, purchaseConv: pc, revenue: rev, directConv: dir, indirectConv: indir,
});

const model: ReportModel = {
  advertiserName: "디스플레이 테스트",
  periodText: "2026.06.16 ~ 2026.06.22",
  authorName: "홍길동",
  createdDate: "2026.06.24",
  totalCurrent: M(6000000, 30000, 8000000, 900, 12000000, 0, 0),
  totalPrev: M(5800000, 29000, 7700000, 870, 11500000, 0, 0),
  searchCurrent: M(180000, 3600, 2700000, 320, 3500000, 0, 0),
  searchPrev: M(179000, 3500, 2600000, 310, 3300000, 0, 0),
  displayCurrent: M(5820000, 26400, 5300000, 580, 8500000, 0, 0),
  displayPrev: M(5621000, 25500, 5100000, 560, 8200000, 0, 0),
  byDay: [],
  byPlacement: [],
  byGender: [],
  byAge: [],
  displayByDay: [],
  displayByPlacement: [],
  displayByGender: [],
  displayByAge: [],
  hasSearch: true,
  hasDisplay: true,
  hasDisplayDetail: false,
};

// 디스플레이 캠페인별: 웹사이트전환 2캠페인 / 카탈로그 1캠페인
const byCampaign: CampaignTypeGroup[] = [
  {
    type: "웹사이트전환",
    rows: [
      { group: "리타겟 캠페인", metrics: M(643000, 5795, 1296000, 76, 926000, 0, 0) },
      { group: "신규유입 캠페인", metrics: M(410000, 3200, 720000, 46, 540000, 0, 0) },
    ],
  },
  {
    type: "카탈로그",
    rows: [{ group: "다이내믹 카탈로그", metrics: M(290000, 1850, 463000, 49, 1442000, 0, 0) }],
  },
];

const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
fillFixedSheets(files, model);
renderCampaignSheet(files, "xl/worksheets/sheet7.xml", byCampaign, DISPLAY_CAMPAIGN_LAYOUT);
removeSheets(files, ["디스플레이_상세"]); // hasDisplayDetail=false
forceRecalc(files);
const out = buildXlsx(files);
writeFileSync("dist-report-display-sheet-sample.xlsx", out);

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const re = openXlsx(out);

ok(re["xl/worksheets/sheet7.xml"] !== undefined, "디스플레이 시트 유지(hasDisplay=true)");
const s7 = readText(re, "xl/worksheets/sheet7.xml");

// 섹션1 주간요약
ok(/<c r="C4"[^>]*><v>5820000<\/v>/.test(s7), "디스플레이 섹션1 금주 노출(C4)=5820000");
ok(/<c r="C5"[^>]*><v>5621000<\/v>/.test(s7), "디스플레이 섹션1 전주 노출(C5)=5621000");
ok(/<c r="M4"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션1 금주 직접전환(M4)='-'");
ok(/<c r="N4"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션1 금주 간접전환(N4)='-'");

// 섹션2 캠페인별: r11-12 웹사이트전환 2캠페인, r13 소계, r14 카탈로그, r15 소계, r16 전체합계
ok(/<c r="B11"[^>]*><is><t[^>]*>웹사이트전환<\/t>/.test(s7), "섹션2 유형 첫행(B11=웹사이트전환)");
ok(/<c r="C11"[^>]*><is><t[^>]*>리타겟 캠페인<\/t>/.test(s7), "섹션2 캠페인명(C11)");
ok(/<c r="C13"[^>]*><is><t[^>]*>소계<\/t>/.test(s7), "섹션2 웹사이트전환 소계행(C13)");
ok(/<c r="D13"[^>]*><v>1053000<\/v>/.test(s7), "섹션2 소계 노출=643000+410000=1053000(D13)");
ok(/<c r="B14"[^>]*><is><t[^>]*>카탈로그<\/t>/.test(s7), "섹션2 카탈로그 유형(B14)");
ok(/<c r="B16"[^>]*><is><t[^>]*>전체 합계<\/t>/.test(s7), "섹션2 전체합계행(B16)");
ok(/<c r="D16"[^>]*><v>1343000<\/v>/.test(s7), "섹션2 전체합계 노출=1053000+290000=1343000(D16)");
ok(/<mergeCell ref="B16:C16"\/>/.test(s7), "섹션2 전체합계 병합(B16:C16)");
// 직접/간접 전환(N/O) '-' 표기
ok(/<c r="N11"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션2 직접전환(N11)='-'");
ok(/<c r="O11"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션2 간접전환(O11)='-'");
ok(/<c r="N16"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션2 전체합계 직접전환(N16)='-'");
ok(/<c r="B10"[^>]*><is><t[^>]*>캠페인 유형<\/t>/.test(s7), "섹션2 헤더 B10=캠페인 유형");
// 양식 표본 잔여행(35) 제거 확인
ok(!/<row r="35"/.test(s7), "양식 표본 잔여행(35) 제거됨");

console.log(fail === 0 ? `\n전체 통과 ✅  (샘플: dist-report-display-sheet-sample.xlsx, ${out.length} bytes)` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
