// report-fill.ts 고정형 시트 채우기 검증 (합성 데이터). node scripts/test-report-fill.ts
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, readText, forceRecalc, removeSheets } from "../src/lib/report-excel.ts";
import { fillFixedSheets, type ReportModel } from "../src/lib/report-fill.ts";
import type { ReportMetrics } from "../src/lib/report-data.ts";

const M = (imp: number, clk: number, cost: number, rev: number, dir: number, indir: number): ReportMetrics => ({
  impressions: imp, clicks: clk, cost, revenue: rev, directConv: dir, indirectConv: indir,
});

const model: ReportModel = {
  advertiserName: "테스트 광고주",
  periodText: "2026.06.15 ~ 2026.06.21",
  authorName: "홍길동",
  createdDate: "2026.06.23",
  curPeriodLabel: "설정 기간(2026.06.15~2026.06.21)",
  prevPeriodLabel: "이전 기간(2026.06.08~2026.06.14)",
  totalCurrent: M(188200, 6510, 6174000, 16415000, 222, 97),
  totalPrev: M(179000, 6300, 5980000, 15600000, 210, 92),
  searchCurrent: M(180000, 3600, 4200000, 16500000, 320, 130),
  searchPrev: M(179000, 3500, 4100000, 16000000, 310, 125),
  displayCurrent: M(5820000, 26400, 5300000, 8500000, 200, 200),
  displayPrev: M(5600000, 25800, 5100000, 8200000, 190, 190),
  summaryByDay: [],
  summaryByDayIsSearchOnly: false,
  byDay: [
    { label: "06/15 (월)", metrics: M(28000, 980, 920000, 2500000, 34, 14) },
    { label: "06/16 (화)", metrics: M(26500, 910, 880000, 2300000, 30, 13) },
    { label: "06/17 (수)", metrics: M(27200, 940, 900000, 2400000, 33, 12) },
  ],
  byPlacement: [
    { label: "네이버 통합검색_PC", metrics: M(35000, 1250, 1560000, 4200000, 48, 20) },
    { label: "네이버 쇼핑_모바일", metrics: M(41000, 980, 1180000, 2300000, 30, 14) },
  ],
  byGender: [
    { label: "남성", metrics: M(95000, 3100, 2900000, 7200000, 105, 45) },
    { label: "여성", metrics: M(88000, 3200, 3100000, 8800000, 110, 48) },
  ],
  byAge: [
    { label: "25~29세", metrics: M(32000, 1150, 1050000, 3200000, 42, 18) },
    { label: "30~34세", metrics: M(38000, 1320, 1280000, 3900000, 50, 22) },
  ],
  hasSearch: true,
  hasDisplay: false,
};

const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
fillFixedSheets(files, model);
if (!model.hasDisplay) removeSheets(files, ["디스플레이", "디스플레이_상세"]);
forceRecalc(files);
const out = buildXlsx(files);
writeFileSync("dist-report-sample.xlsx", out);

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) fail++; };
const re = openXlsx(out);
const s2 = readText(re, "xl/worksheets/sheet2.xml");
const s4 = readText(re, "xl/worksheets/sheet4.xml");
const d4 = readText(re, "xl/drawings/drawing4.xml");

ok(/<c r="C18"[^>]*><v>188200<\/v>/.test(s2), "종합 설정 기간 노출(C18)=188200");
ok(/<c r="E18"[^>]*><v>0\.034[0-9]*<\/v>/.test(s2), "종합 설정 기간 클릭률(E18) 계산 주입");
ok(/<c r="C25"[^>]*><v>180000<\/v>/.test(s2), "종합 검색광고 매체 노출(C25)=180000");
ok(/<f>C25\+C26<\/f>/.test(s2), "종합 매체 합계 수식(C27) 보존");
ok(/<row r="26"[^>]*hidden="1"/.test(s2), "디스플레이 매체 행(26) 숨김(hasDisplay=false)");
const s3 = readText(re, "xl/worksheets/sheet3.xml");
ok(/<c r="C15"[^>]*><v>180000<\/v>/.test(s3), "검색광고 섹션1 설정 기간 노출(C15)=180000");

// 기간 라벨 — 양식의 "금주/전주/주간"이 실제 기간 표기로 교체됐는지. 월간 리포트에서 "금주"가
// 찍히던 문제(양식 sharedStrings 고정값)의 회귀 방지.
const inlineStr = (xml: string, addr: string, text: string) =>
  new RegExp(`<c r="${addr}"[^>]*t="inlineStr"[^>]*><is><t[^>]*>${text}</t>`).test(xml);
ok(inlineStr(s2, "B18", "설정 기간\\(2026\\.06\\.15~2026\\.06\\.21\\)"), "종합 증감표 B18=설정 기간(날짜)");
ok(inlineStr(s2, "B19", "이전 기간\\(2026\\.06\\.08~2026\\.06\\.14\\)"), "종합 증감표 B19=이전 기간(날짜)");
ok(inlineStr(s2, "B2", "1\\. 운영 요약"), "종합 섹션1 제목에서 '주간' 제거");
ok(inlineStr(s3, "B15", "설정 기간\\(2026\\.06\\.15~2026\\.06\\.21\\)"), "검색광고 증감표 B15=설정 기간(날짜)");
ok(inlineStr(s3, "B16", "이전 기간\\(2026\\.06\\.08~2026\\.06\\.14\\)"), "검색광고 증감표 B16=이전 기간(날짜)");
ok(inlineStr(s3, "B2", "1\\. 검색광고 요약"), "검색광고 섹션1 제목에서 '주간' 제거");
// sharedStrings의 "금주"/"전주"는 양식에 남아있어도 무해(참조가 끊김) — 셀이 안 가리키는지만 확인.
ok(!/<c r="B(18|19)"[^>]*t="s"/.test(s2) && !/<c r="B(15|16)"[^>]*t="s"/.test(s3),
  "증감표 라벨 셀이 양식 공유문자열(금주/전주)을 더는 참조 안 함");
ok(/<c r="C15"[^>]*><v>28000<\/v>/.test(s4), "검색_상세 일자 06/15 노출(C15)=28000");
ok(s4.includes("06/15 (월)"), "검색_상세 일자 라벨 주입");
ok(/<c r="C18"[^>]*><v>0<\/v>/.test(s4), "검색_상세 빈 일자행(C18) 비움");
ok(/<c r="C49"[^>]*><v>35000<\/v>/.test(s4), "검색_상세 지면 통합검색PC(C49)=35000");
ok(/<c r="C76"[^>]*><v>95000<\/v>/.test(s4), "검색_상세 성별 남성(C76)=95000");
ok(d4.includes("테스트 광고주") && !d4.includes("__ADV__"), "표지 업체명 주입(도면)");
ok(d4.includes("2026.06.15 ~ 2026.06.21") && !d4.includes("__PERIOD__"), "표지 기간 주입(도면)");
ok(d4.includes("홍길동") && !d4.includes("__AUTHOR__"), "표지 담당자 주입(도면)");
ok(d4.includes("2026.06.23") && !d4.includes("__CREATED__"), "표지 작성일 주입(도면)");
ok(!/cx="1355032" cy="256761"/.test(d4), "업체명 박스 폭 확장(긴 이름)");
ok(re["xl/worksheets/sheet7.xml"] === undefined, "디스플레이 시트 제거됨(hasDisplay=false)");

console.log(fail === 0 ? `\n전체 통과 ✅  (샘플 파일: dist-report-sample.xlsx, ${out.length} bytes)` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
