// 월간(30일) 일자별 확장 검증 — 일자 행 삽입 + 아래 표/차트 이동 + 일자 그래프 범위 확장 + 구조 정합.
// node --import ./scripts/ts-resolve.mjs scripts/test-report-monthly.ts
import { readFileSync, writeFileSync } from "node:fs";
import {
  openXlsx, buildXlsx, readText, forceRecalc, removeCalcChain, removeSheetDrawing, removeSheets,
  writeText, hideRowRange, replaceChartColor,
} from "../src/lib/report-excel.ts";
import {
  fillFixedSheets, expandDailyRows, insertSummaryDaily, SEARCH_DAILY_EXPAND, DISPLAY_DAILY_EXPAND,
  type ReportModel,
} from "../src/lib/report-fill.ts";
import { renderDetailPlacement, renderSummaryTypes, DISPLAY_PLACEMENT } from "../src/lib/report-variable.ts";
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
  curPeriodLabel: "설정 기간(2026.06.01~2026.06.30)",
  prevPeriodLabel: "이전 기간(2026.05.02~2026.05.31)",
  totalCurrent: M(280000, 6800, 7300000, 250, 17000000, 222, 97),
  totalPrev: M(270000, 6500, 7100000, 240, 16000000, 210, 92),
  searchCurrent: M(180000, 3600, 4200000, 130, 8500000, 320, 130),
  searchPrev: M(179000, 3500, 4100000, 125, 8000000, 310, 125),
  displayCurrent: M(283248, 1869, 1388894, 50, 980790, 0, 0),
  displayPrev: M(271000, 1790, 1320000, 48, 940000, 0, 0),
  summaryByDay: byDay30,
  summaryByDayIsSearchOnly: false,
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
// 종합 섹션3(유형별) → 섹션2(일자별) 삽입 순서는 buildReportBytes와 동일해야 함
renderSummaryTypes(files,
  [{ label: "파워링크", metrics: M(45000, 980, 1078000, 42, 3000000, 20, 22) }],
  [{ label: "웹사이트전환", metrics: M(1053000, 8995, 2016000, 122, 4000000, 0, 0) }],
);
insertSummaryDaily(files, model);
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

// ── 검색광고 시트의 일자별 콤보 그래프도 30일로 넓어졌는지 ──
// 이 그래프는 다른 시트(검색_상세)의 일자 표를 참조하므로 expandDailyRows가 같이 넓혀야 한다.
// 빠뜨리면 월간 리포트인데 그래프만 7일치가 그려진다.
{
  const c = readText(re, "xl/charts/chart11.xml");
  ok(c.includes("검색_상세!$B$15:$B$44"), "검색광고 콤보 그래프 카테고리 범위 $B$15:$B$44");
  ok(c.includes("검색_상세!$G$15:$G$44"), "검색광고 콤보 그래프 막대(광고비) 범위 $G$15:$G$44");
  ok(c.includes("검색_상세!$K$15:$K$44"), "검색광고 콤보 그래프 선(매출) 범위 $K$15:$K$44");
  ok(!/\$1[0-9]:\$[A-Z]+\$21\b/.test(c), "검색광고 콤보 그래프 끝행 21 잔여 없음");
  ok(/<c:barChart>/.test(c) && /<c:lineChart>/.test(c), "검색광고 콤보 구조(막대+선) 유지");
}
// 디스플레이 시트를 제거하면 그 시트만 쓰던 그림/차트 파트도 같이 정리돼야 한다
// (removeSheets의 고아 파트 청소 — 새로 추가한 drawing6/chart12에도 적용되는지 확인).
ok(re["xl/charts/chart12.xml"] === undefined, "디스플레이 시트 제거 시 콤보 그래프(chart12) 파트도 정리됨");
ok(re["xl/drawings/drawing6.xml"] === undefined, "디스플레이 시트 제거 시 그림(drawing6) 파트도 정리됨");
ok(!readText(re, "[Content_Types].xml").includes("chart12.xml"), "제거된 chart12가 Content_Types에도 안 남음");

// ── 종합 섹션2 "일자별 운영 요약" (30일) ──
// 삽입 행 수 L = 제목1 + 헤더1 + 일자30 + 합계1 + 여백1 = 34.
// 23 제목 / 24 헤더 / 25~54 일자 / 55 합계 / 56 여백 / 57 옛23(매체) / 63 옛29(캠페인유형)
{
  const s2 = readText(re, "xl/worksheets/sheet2.xml");
  const inline = (addr: string, text: string) =>
    new RegExp(`<c r="${addr}"[^>]*t="inlineStr"[^>]*><is><t[^>]*>${text}</t>`).test(s2);

  ok(inline("B23", "2\\. 일자별 운영 요약"), "종합 섹션2 제목(B23)=2. 일자별 운영 요약");
  ok(inline("B24", "일자"), "종합 섹션2 헤더(B24)=일자");
  ok(inline("B25", "06/01"), "종합 섹션2 첫 일자(B25=06/01)");
  ok(inline("B54", "06/30"), "종합 섹션2 마지막 일자(B54=06/30, 30행)");
  ok(inline("B55", "합계"), "종합 섹션2 합계행(B55)");
  const sumImp = byDay30.reduce((a, d) => a + d.metrics.impressions, 0);
  ok(new RegExp(`<c r="C55"[^>]*><v>${sumImp}</v>`).test(s2), `종합 섹션2 합계 노출(C55=${sumImp})`);

  // 아래 섹션이 34행 밀리고 번호가 3./4.로 재부여됐는지
  ok(inline("B57", "3\\. 매체 유형별 요약"), "옛 섹션2 → B57 '3. 매체 유형별 요약'으로 밀림+재번호");
  ok(inline("B63", "4\\. 캠페인 유형별 요약"), "옛 섹션3 → B63 '4. 캠페인 유형별 요약'으로 밀림+재번호");
  ok(/<c r="C59"[^>]*><v>180000<\/v>/.test(s2), "매체 유형별 검색광고 노출이 25→59행으로 이동");
  ok(/<c r="B65"[^>]*><is><t[^>]*>파워링크<\/t>/.test(s2), "캠페인 유형별 첫 행이 31→65행으로 이동");

  // 병합 이동 — 새 제목 병합 + 기존 병합이 함께 밀렸는지
  const merges = [...s2.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
  ok(merges.includes("B23:N23"), "새 섹션2 제목 병합(B23:N23)");
  ok(merges.includes("B57:N57") && merges.includes("B63:N63"), `기존 제목 병합 이동(B23→B57, B29→B63) 실제: ${merges.join(",")}`);
  ok(merges.includes("B2:N2"), "삽입 위쪽 병합(B2:N2)은 그대로");

  // 구조 정합 — 엑셀 '복구' 대화상자 방지
  const rowNums = [...s2.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  let asc = true;
  for (let i = 1; i < rowNums.length; i++) if (rowNums[i] <= rowNums[i - 1]) asc = false;
  ok(asc, "종합 행번호 오름차순(중복/역순 없음)");
  const dimEnd = Number((s2.match(/<dimension ref="[A-Z]+\d+:[A-Z]+(\d+)"/) ?? [])[1]);
  ok(dimEnd === Math.max(...rowNums), `종합 dimension 끝행(${dimEnd}) == 실제 max(${Math.max(...rowNums)})`);
  // 섹션1은 삽입 위쪽이라 그대로여야 함
  ok(/<c r="C18"[^>]*><v>280000<\/v>/.test(s2), "섹션1 총계(C18)는 삽입 영향 없음");
}

console.log(fail === 0 ? `\n전체 통과 ✅  (샘플: dist-report-monthly-sample.xlsx, ${out.length} bytes)` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
