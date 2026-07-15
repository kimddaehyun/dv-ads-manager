// 디스플레이_상세(sheet8) 양식 주입 무결성 검증 (정찰 실데이터, 계정 146889 2026.06.15~21).
// node --import ./scripts/ts-resolve.mjs scripts/test-report-display-detail.ts
import { readFileSync, writeFileSync } from "node:fs";
import {
  openXlsx, buildXlsx, forceRecalc, removeSheets, removeSheetDrawing, removeCalcChain,
  replaceChartColor, readText, writeText, hideRowRange,
} from "../src/lib/report-excel.ts";
import { fillFixedSheets, type ReportModel } from "../src/lib/report-fill.ts";
import { renderDetailPlacement, DISPLAY_PLACEMENT } from "../src/lib/report-variable.ts";
import type { ReportMetrics } from "../src/lib/report-data.ts";

const M = (imp: number, clk: number, cost: number, pc: number, rev: number, dir: number, indir: number): ReportMetrics => ({
  impressions: imp, clicks: clk, cost, purchaseConv: pc, revenue: rev, directConv: dir, indirectConv: indir,
});

// 정찰 실데이터: 디스플레이 분해 4종 (CSV 그대로 → build 정규화 결과 모사)
const model: ReportModel = {
  advertiserName: "테스트 광고주",
  periodText: "2026.06.15 ~ 2026.06.21",
  authorName: "홍길동",
  createdDate: "2026.06.24",
  curPeriodLabel: "설정 기간(2026.06.15~2026.06.21)",
  prevPeriodLabel: "이전 기간(2026.06.08~2026.06.14)",
  totalCurrent: M(280000, 6800, 7300000, 250, 17000000, 222, 97),
  totalPrev: M(270000, 6500, 7100000, 240, 16000000, 210, 92),
  searchCurrent: M(180000, 3600, 4200000, 130, 8500000, 320, 130),
  searchPrev: M(179000, 3500, 4100000, 125, 8000000, 310, 125),
  displayCurrent: M(283248, 1869, 1388894, 0, 980790, 0, 0),
  displayPrev: M(271000, 1790, 1320000, 0, 940000, 0, 0),
  summaryByDay: [],
  summaryByDayIsSearchOnly: false,
  byDay: [{ label: "06/15 (월)", metrics: M(28000, 980, 920000, 48, 2500000, 34, 14) }],
  byPlacement: [{ label: "네이버 통합검색_PC", metrics: M(35000, 1250, 1560000, 68, 4200000, 48, 20) }],
  byGender: [{ label: "남성", metrics: M(95000, 3100, 2900000, 150, 7200000, 105, 45) }],
  byAge: [{ label: "25~29세", metrics: M(32000, 1150, 1050000, 60, 3200000, 42, 18) }],
  // ── 디스플레이_상세 (정찰 실데이터) ──
  displayByDay: [
    { label: "06/15 (월)", metrics: M(55483, 371, 233941, 46, 670850, 0, 0) },
    { label: "06/16 (화)", metrics: M(54939, 341, 235735, 40, 497700, 0, 0) },
    { label: "06/17 (수)", metrics: M(44471, 286, 186547, 27, 335570, 0, 0) },
    { label: "06/18 (목)", metrics: M(33755, 287, 184321, 32, 373170, 0, 0) },
    { label: "06/19 (금)", metrics: M(32307, 312, 191815, 23, 318640, 0, 0) },
    { label: "06/20 (토)", metrics: M(29632, 282, 168691, 29, 355880, 0, 0) },
    { label: "06/21 (일)", metrics: M(33661, 308, 188129, 23, 292820, 0, 0) },
  ],
  displayByPlacement: [
    { label: "ADVoost 쇼핑 통합", metrics: M(213345, 1099, 1141046, 159, 2037900, 0, 0) },
    { label: "네이버+ > 피드", metrics: M(19581, 625, 142091, 26, 325560, 0, 0) },
    { label: "네이버+ > 네이버 메인", metrics: M(8568, 148, 34321, 9, 121260, 0, 0) },
    { label: "네이버+ > 스마트채널", metrics: M(34906, 139, 32758, 14, 191440, 0, 0) },
    { label: "네이버+ > 서비스 통합", metrics: M(6255, 141, 31344, 8, 94480, 0, 0) },
    { label: "네이버+ > 쇼핑", metrics: M(1593, 35, 7619, 4, 73990, 0, 0) },
  ],
  displayByGender: [
    { label: "남성", metrics: M(120477, 1521, 907259, 154, 2055370, 0, 0) },
    { label: "여성", metrics: M(54585, 542, 422180, 56, 662170, 0, 0) },
    { label: "알수없음", metrics: M(109186, 124, 59741, 10, 127090, 0, 0) },
  ],
  displayByAge: [
    { label: "만 13~18세", metrics: M(37724, 28, 13073, 3, 33700, 0, 0) },
    { label: "19~24세", metrics: M(5023, 52, 29045, 9, 105320, 0, 0) },
    { label: "25~29세", metrics: M(9372, 102, 78131, 12, 150440, 0, 0) },
    { label: "30~34세", metrics: M(15439, 168, 158728, 23, 303420, 0, 0) },
    { label: "35~39세", metrics: M(18302, 183, 147264, 28, 450590, 0, 0) },
    { label: "40~44세", metrics: M(25348, 297, 190508, 27, 361490, 0, 0) },
    { label: "45~49세", metrics: M(28547, 388, 234783, 39, 512570, 0, 0) },
    { label: "50세 이상", metrics: M(60917, 844, 476043, 70, 829840, 0, 0) },
    { label: "알 수 없음", metrics: M(83576, 125, 61604, 9, 97260, 0, 0) },
  ],
  hasSearch: true,
  hasDisplay: true,
  hasDisplayDetail: true,
};

const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
fillFixedSheets(files, model);
removeSheetDrawing(files, "xl/worksheets/sheet2.xml");
writeText(files, "xl/worksheets/sheet2.xml", hideRowRange(readText(files, "xl/worksheets/sheet2.xml"), 3, 16));
renderDetailPlacement(files, model.byPlacement); // 검색_상세
replaceChartColor(files, "xl/charts/chart5.xml", "92D050", "F67676");
renderDetailPlacement(files, model.displayByPlacement, DISPLAY_PLACEMENT); // 디스플레이_상세
replaceChartColor(files, "xl/charts/chart9.xml", "92D050", "F67676");
removeSheets(files, ["디스플레이"]); // 디스플레이(캠페인표)만 제거, 디스플레이_상세 유지
removeCalcChain(files);
forceRecalc(files);
const out = buildXlsx(files);
writeFileSync("dist-report-display-sample.xlsx", out);

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const re = openXlsx(out);
const s8 = readText(re, "xl/worksheets/sheet8.xml");

ok(re["xl/worksheets/sheet8.xml"] !== undefined, "디스플레이_상세 시트 유지됨(hasDisplayDetail=true)");
ok(/<c r="C15"[^>]*><v>55483<\/v>/.test(s8), "디스플레이_상세 일자 06/15 노출(C15)=55483");
ok(s8.includes("06/21 (일)"), "디스플레이_상세 일자 라벨 주입");
// 성별/연령은 지면 영역 삭제(-32)로 위로 당겨짐: 성별 68→36, 연령 50세이상 81→49
ok(/<c r="G36"[^>]*><v>907259<\/v>/.test(s8), "디스플레이_상세 성별 남성 비용(G36)=907259");
ok(/<c r="G49"[^>]*><v>476043<\/v>/.test(s8), "디스플레이_상세 연령 50세이상 비용(G49)=476043(3버킷 합산)");
// 알 수 없음 행: 연령 82 → shift(-32) → 50
ok(/<c r="G50"[^>]*><v>61604<\/v>/.test(s8), "디스플레이_상세 연령 알수없음 비용(G50)=61604");
// 지면 동적 섹션 맨 아래
ok(s8.includes("지면별 성과") && s8.includes("ADVoost 쇼핑 통합"), "디스플레이_상세 지면 동적 섹션(총비용순 1위 ADVoost)");
// 직접/간접 전환 '-' (일자 데이터행 M15, 일자 합계 M22, 성별 남성 M36)
ok(/<c r="M15"[^>]*t="inlineStr"><is><t[^>]*>-<\/t>/.test(s8), "디스플레이_상세 일자 직접전환(M15)='-'");
ok(/<c r="N22"[^>]*t="inlineStr"><is><t[^>]*>-<\/t>/.test(s8), "디스플레이_상세 일자합계 간접전환(N22)='-'");
ok(/<c r="M36"[^>]*t="inlineStr"><is><t[^>]*>-<\/t>/.test(s8), "디스플레이_상세 성별 직접전환(M36)='-'");
// 복구 대화상자 방지: dimension이 실제 max행과 일치
const dim = s8.match(/<dimension ref="[A-Z]+\d+:[A-Z]+(\d+)"/);
const maxRow = Math.max(...[...s8.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])));
ok(dim != null && Number(dim[1]) === maxRow, `디스플레이_상세 dimension 끝행(${dim?.[1]}) == 실제 max행(${maxRow})`);
// well-formed: row 번호 오름차순, 셀 닫힘
const rows = [...s8.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
ok(rows.every((v, i) => i === 0 || v > rows[i - 1]), "디스플레이_상세 행 번호 오름차순(중복/역순 없음)");
ok(re["xl/charts/chart8.xml"] === undefined || !readText(re, "xl/drawings/drawing3.xml").includes("rId2"), "지면 그래프(chart8) drawing3에서 제거");
ok(re["xl/worksheets/sheet7.xml"] === undefined, "디스플레이(캠페인표) 시트 제거됨");

console.log(fail === 0 ? `\n전체 통과 ✅  (샘플: dist-report-display-sample.xlsx, ${out.length} bytes)` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
