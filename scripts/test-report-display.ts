// 디스플레이 시트(sheet7) 섹션1(주간요약)+섹션2(캠페인별) 검증 (합성 데이터).
// node --import ./scripts/ts-resolve.mjs scripts/test-report-display.ts
import { readFileSync, writeFileSync } from "node:fs";
import {
  openXlsx, buildXlsx, readText, writeText, forceRecalc, removeSheets, removeSheetDrawing, hideRowRange,
} from "../src/lib/report-excel.ts";
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
  curPeriodLabel: "설정 기간(2026.06.16~2026.06.22)",
  prevPeriodLabel: "이전 기간(2026.06.09~2026.06.15)",
  totalCurrent: M(6000000, 30000, 8000000, 900, 12000000, 0, 0),
  totalPrev: M(5800000, 29000, 7700000, 870, 11500000, 0, 0),
  searchCurrent: M(180000, 3600, 2700000, 320, 3500000, 0, 0),
  searchPrev: M(179000, 3500, 2600000, 310, 3300000, 0, 0),
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
// buildReportBytes의 hasDisplayDetail=false 가드와 동일 — 콤보 그래프가 참조하는 상세 시트가
// 사라지므로 그림 제거 + 자리 숨김.
removeSheetDrawing(files, "xl/worksheets/sheet7.xml");
writeText(files, "xl/worksheets/sheet7.xml", hideRowRange(readText(files, "xl/worksheets/sheet7.xml"), 3, 13));
removeSheets(files, ["디스플레이_상세"]); // hasDisplayDetail=false
forceRecalc(files);
const out = buildXlsx(files);
writeFileSync("dist-report-display-sheet-sample.xlsx", out);

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const re = openXlsx(out);

ok(re["xl/worksheets/sheet7.xml"] !== undefined, "디스플레이 시트 유지(hasDisplay=true)");
const s7 = readText(re, "xl/worksheets/sheet7.xml");

// 섹션1 요약
ok(/<c r="C15"[^>]*><v>5820000<\/v>/.test(s7), "디스플레이 섹션1 설정 기간 노출(C15)=5820000");
ok(/<c r="C16"[^>]*><v>5621000<\/v>/.test(s7), "디스플레이 섹션1 이전 기간 노출(C16)=5621000");
ok(/<c r="M15"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션1 설정 기간 직접전환(M15)='-'");
ok(/<c r="N15"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션1 설정 기간 간접전환(N15)='-'");
ok(/<c r="B15"[^>]*t="inlineStr"[^>]*><is><t[^>]*>설정 기간\(2026\.06\.16~2026\.06\.22\)<\/t>/.test(s7),
  "디스플레이 증감표 B15=설정 기간(날짜)");
ok(/<c r="B16"[^>]*t="inlineStr"[^>]*><is><t[^>]*>이전 기간\(2026\.06\.09~2026\.06\.15\)<\/t>/.test(s7),
  "디스플레이 증감표 B16=이전 기간(날짜)");
ok(/<c r="B2"[^>]*t="inlineStr"[^>]*><is><t[^>]*>1\. 디스플레이 요약<\/t>/.test(s7),
  "디스플레이 섹션1 제목에서 '주간' 제거");

// 섹션2 캠페인별 — 제목(2행) 아래 3~13행이 일자별 콤보 그래프 자리라 +11 밀림:
// 21 헤더, 22-23 웹사이트전환 2캠페인, 24 소계, 25 카탈로그 **(1행뿐이라 소계 없음)**, 26 전체합계
ok(/<c r="B21"[^>]*><is><t[^>]*>캠페인 유형<\/t>/.test(s7), "섹션2 헤더(B21=캠페인 유형)");
ok(/<c r="B22"[^>]*><is><t[^>]*>웹사이트전환<\/t>/.test(s7), "섹션2 유형 첫행(B22=웹사이트전환)");
ok(/<c r="C22"[^>]*><is><t[^>]*>리타겟 캠페인<\/t>/.test(s7), "섹션2 캠페인명(C22)");
ok(/<c r="C24"[^>]*><is><t[^>]*>웹사이트전환 소계<\/t>/.test(s7), "섹션2 소계행(C24)에 유형명 포함('웹사이트전환 소계')");
ok(/<c r="D24"[^>]*><v>1053000<\/v>/.test(s7), "섹션2 소계 노출=643000+410000=1053000(D24)");
ok(/<c r="B25"[^>]*><is><t[^>]*>카탈로그<\/t>/.test(s7), "섹션2 카탈로그 유형(B25)");
// 캠페인이 1개뿐인 유형(카탈로그)은 소계를 안 넣는다 — 데이터행을 그대로 베낀 값이라 표만 길어진다.
ok(!/<is><t[^>]*>카탈로그 소계<\/t>/.test(s7), "캠페인 1개인 유형은 소계행 없음('카탈로그 소계' 안 나옴)");
ok(!/<mergeCell ref="B25:B25"\/>/.test(s7), "캠페인 1개인 유형은 B열 1칸 병합도 안 만듦");
ok(/<c r="B26"[^>]*><is><t[^>]*>전체 합계<\/t>/.test(s7), "섹션2 전체합계행(B26)");
// 소계행을 건너뛴 유형(카탈로그 290000)도 전체합계에는 그대로 들어가야 한다
ok(/<c r="D26"[^>]*><v>1343000<\/v>/.test(s7), "섹션2 전체합계 노출=1053000+290000=1343000(D26)");
ok(/<mergeCell ref="B26:C26"\/>/.test(s7), "섹션2 전체합계 병합(B26:C26)");
// 직접/간접 전환(N/O) '-' 표기
ok(/<c r="N22"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션2 직접전환(N22)='-'");
ok(/<c r="O22"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션2 간접전환(O22)='-'");
ok(/<c r="N26"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s7), "섹션2 전체합계 직접전환(N26)='-'");
// 양식 표본 잔여행(46 = 35+11) 제거 확인
ok(!/<row r="46"/.test(s7), "양식 표본 잔여행(46) 제거됨");
// hasDisplayDetail=false → 디스플레이_상세를 참조하는 콤보 그래프(chart12)가 #REF!가 되지 않게
// 그림을 통째로 빼고 자리를 숨겼는지 (report-build의 가드와 동일 처리를 여기서도 재현)
ok(re["xl/worksheets/_rels/sheet7.xml.rels"] === undefined || !readText(re, "xl/worksheets/sheet7.xml").includes("<drawing "),
  "디스플레이_상세 없으면 sheet7 그래프 제거됨(끊긴 참조 방지)");

console.log(fail === 0 ? `\n전체 통과 ✅  (샘플: dist-report-display-sheet-sample.xlsx, ${out.length} bytes)` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
