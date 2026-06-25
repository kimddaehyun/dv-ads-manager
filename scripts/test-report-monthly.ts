// 월간(30일) 일자별 확장 검증 — 일자 행 삽입 + 아래 표/차트 이동 + 일자 그래프 범위 확장 + 구조 정합.
// node --import ./scripts/ts-resolve.mjs scripts/test-report-monthly.ts
import { readFileSync, writeFileSync } from "node:fs";
import {
  openXlsx, buildXlsx, readText, forceRecalc, removeCalcChain, removeSheetDrawing, removeSheets,
  writeText, hideRowRange, replaceChartColor,
} from "../src/lib/report-excel.ts";
import {
  fillFixedSheets, expandDailyRows, SEARCH_DAILY_EXPAND, DISPLAY_DAILY_EXPAND, type ReportModel,
} from "../src/lib/report-fill.ts";
import { renderDetailPlacement, DISPLAY_PLACEMENT } from "../src/lib/report-variable.ts";
import type { ReportMetrics } from "../src/lib/report-data.ts";

const M = (imp: number, clk: number, cost: number, pc: number, rev: number, dir: number, indir: number): ReportMetrics => ({
  impressions: imp, clicks: clk, cost, purchaseConv: pc, revenue: rev, directConv: dir, indirectConv: indir,
});

// 30일치 일자 데이터 (06/01 ~ 06/30)
const days = (n: number) => Array.from({ length: n }, (_, i) => ({
  label: `06/${String(i + 1).padStart(2, "0")}`,
  metrics: M(1000 + i, 50 + i, 10000 + i * 100, 5 + i, 30000 + i * 100, 3, 2),
}));
const byDay30 = days(30);

const model: ReportModel = {
  advertiserName: "월간 테스트",
  periodText: "2026.06.01 ~ 2026.06.30",
  authorName: "홍길동",
  createdDate: "2026.07.01",
  totalCurrent: M(280000, 6800, 7300000, 250, 17000000, 222, 97),
  totalPrev: M(270000, 6500, 7100000, 240, 16000000, 210, 92),
  searchCurrent: M(180000, 3600, 4200000, 130, 8500000, 320, 130),
  searchPrev: M(179000, 3500, 4100000, 125, 8000000, 310, 125),
  displayCurrent: M(283248, 1869, 1388894, 50, 980790, 0, 0),
  displayPrev: M(271000, 1790, 1320000, 48, 940000, 0, 0),
  byDay: byDay30,
  byPlacement: [
    { label: "네이버 통합검색_PC", metrics: M(35000, 1250, 1560000, 68, 4200000, 48, 20) },
    { label: "네이버 쇼핑_모바일", metrics: M(41000, 980, 1180000, 40, 2300000, 30, 14) },
  ],
  byGender: [
    { label: "남성", metrics: M(95000, 3100, 2900000, 150, 7200000, 105, 45) },
    { label: "여성", metrics: M(88000, 3200, 3100000, 100, 8800000, 110, 48) },
  ],
  byAge: [
    { label: "25~29세", metrics: M(32000, 1150, 1050000, 42, 3200000, 42, 18) },
    { label: "30~34세", metrics: M(38000, 1320, 1280000, 50, 3900000, 50, 22) },
  ],
  displayByDay: byDay30,
  displayByPlacement: [{ label: "네이버+ > 스마트채널", metrics: M(120000, 800, 600000, 20, 400000, 0, 0) }],
  displayByGender: [{ label: "여성", metrics: M(140000, 900, 700000, 25, 500000, 0, 0) }],
  displayByAge: [{ label: "25~29세", metrics: M(90000, 600, 450000, 15, 300000, 0, 0) }],
  hasSearch: true,
  hasDisplay: true,
  hasDisplayDetail: true,
};

const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
fillFixedSheets(files, model);
removeSheetDrawing(files, "xl/worksheets/sheet2.xml");
writeText(files, "xl/worksheets/sheet2.xml", hideRowRange(readText(files, "xl/worksheets/sheet2.xml"), 3, 16));
renderDetailPlacement(files, model.byPlacement);
replaceChartColor(files, "xl/charts/chart5.xml", "92D050", "F67676");
expandDailyRows(files, SEARCH_DAILY_EXPAND, model.byDay);
renderDetailPlacement(files, model.displayByPlacement, DISPLAY_PLACEMENT, true);
replaceChartColor(files, "xl/charts/chart9.xml", "92D050", "F67676");
expandDailyRows(files, DISPLAY_DAILY_EXPAND, model.displayByDay, true);
removeSheets(files, ["디스플레이"]); // 캠페인표 시트는 이 테스트 범위 밖
removeCalcChain(files);
forceRecalc(files);
const out = buildXlsx(files);
writeFileSync("dist-report-monthly-sample.xlsx", out);

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const re = openXlsx(out);

for (const [tag, path, chart, genderImp] of [
  ["검색_상세", "xl/worksheets/sheet4.xml", "xl/charts/chart3.xml", 95000],
  ["디스플레이_상세", "xl/worksheets/sheet8.xml", "xl/charts/chart7.xml", 140000],
] as const) {
  const s = readText(re, path);
  // 일자 30행: 15=06/01, 21=06/07, 22=06/08, 44=06/30, 45=합계
  ok(/<c r="B15"[^>]*><is><t[^>]*>06\/01<\/t>/.test(s), `${tag} 1일째 라벨(B15=06/01)`);
  ok(/<c r="B22"[^>]*><is><t[^>]*>06\/08<\/t>/.test(s), `${tag} 8일째 라벨(B22=06/08, 삽입 시작)`);
  ok(/<c r="B44"[^>]*><is><t[^>]*>06\/30<\/t>/.test(s), `${tag} 30일째 라벨(B44=06/30)`);
  // 합계행: 일자 30행(15~44) 다음 45행. C45에 30일 노출 합계.
  const sumImp = byDay30.reduce((a, d) => a + d.metrics.impressions, 0);
  ok(new RegExp(`<c r="C45"[^>]*><v>${sumImp}</v>`).test(s), `${tag} 합계행 노출(C45=${sumImp})`);
  // 일자 그래프 범위 15~44로 확장
  const c = readText(re, chart);
  ok(c.includes("$B$15:$B$44"), `${tag} 일자 그래프 카테고리 범위 $B$15:$B$44`);
  ok(c.includes("$15:$") && !/\$15:\$[A-Z]+\$21\b/.test(c), `${tag} 일자 그래프 끝행 21→44 확장(21 잔여 없음)`);
  // 구조 정합: 행번호 오름차순(중복/역순 없음) — 엑셀 복구 방지
  const rowNums = [...s.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  let asc = true;
  for (let i = 1; i < rowNums.length; i++) if (rowNums[i] <= rowNums[i - 1]) asc = false;
  ok(asc, `${tag} 행번호 오름차순(중복/역순 없음)`);
  // dimension 끝행 == 실제 최대행
  const dimEnd = Number((s.match(/<dimension ref="[A-Z]+\d+:[A-Z]+(\d+)"/) ?? [])[1]);
  ok(dimEnd === Math.max(...rowNums), `${tag} dimension 끝행(${dimEnd}) == 실제 max(${Math.max(...rowNums)})`);
  // 성별 표가 합계행(45) 아래로 밀려 존재 — 성별 노출 지표값이 45행 초과 행에 있는지 확인
  // (라벨은 sharedString 참조라 텍스트로 안 잡힘 → 지표값으로 검증)
  const genderCell = new RegExp(`<c r="C(\\d+)"[^>]*><v>${genderImp}</v>`).exec(s);
  ok(!!genderCell && Number(genderCell[1]) > 45, `${tag} 성별 표가 합계행 아래로 이동(C${genderCell?.[1]}=${genderImp})`);
}

console.log(fail === 0 ? `\n전체 통과 ✅  (샘플: dist-report-monthly-sample.xlsx, ${out.length} bytes)` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
