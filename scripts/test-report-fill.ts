// report-fill.ts 고정형 시트 채우기 검증 (합성 데이터). node scripts/test-report-fill.ts
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, readText, forceRecalc, removeSheets } from "../src/features/report/report-excel.ts";
import { fillFixedSheets, type ReportModel } from "../src/features/report/report-fill.ts";
import type { ReportMetrics } from "../src/features/report/report-data.ts";

// imp, clk, cost, purchaseConv, revenue, direct, indirect (test-report-display.ts와 동일 시그니처)
const M = (imp: number, clk: number, cost: number, pc: number, rev: number, dir: number, indir: number): ReportMetrics => ({
  impressions: imp, clicks: clk, cost, purchaseConv: pc, revenue: rev, directConv: dir, indirectConv: indir,
});

const model: ReportModel = {
  advertiserName: "테스트 광고주",
  periodText: "2026.06.15 ~ 2026.06.21",
  authorName: "홍길동",
  createdDate: "2026.06.23",
  curPeriodLabel: "설정 기간(2026.06.15~2026.06.21)",
  prevPeriodLabel: "이전 기간(2026.06.08~2026.06.14)",
  totalCurrent: M(188200, 6510, 6174000, 319, 16415000, 222, 97),
  totalPrev: M(179000, 6300, 5980000, 302, 15600000, 210, 92),
  searchCurrent: M(180000, 3600, 4200000, 450, 16500000, 320, 130),
  searchPrev: M(179000, 3500, 4100000, 435, 16000000, 310, 125),
  displayCurrent: M(5820000, 26400, 5300000, 400, 8500000, 200, 200),
  displayPrev: M(5600000, 25800, 5100000, 380, 8200000, 190, 190),
  summaryByDay: [],
  summaryByDayIsSearchOnly: false,
  byDay: [
    { label: "06/15 (월)", metrics: M(28000, 980, 920000, 48, 2500000, 34, 14) },
    { label: "06/16 (화)", metrics: M(26500, 910, 880000, 43, 2300000, 30, 13) },
    { label: "06/17 (수)", metrics: M(27200, 940, 900000, 45, 2400000, 33, 12) },
  ],
  byPlacement: [
    { label: "네이버 통합검색_PC", metrics: M(35000, 1250, 1560000, 68, 4200000, 48, 20) },
    { label: "네이버 쇼핑_모바일", metrics: M(41000, 980, 1180000, 44, 2300000, 30, 14) },
  ],
  byGender: [
    { label: "남성", metrics: M(95000, 3100, 2900000, 150, 7200000, 105, 45) },
    { label: "여성", metrics: M(88000, 3200, 3100000, 158, 8800000, 110, 48) },
  ],
  byAge: [
    { label: "25~29세", metrics: M(32000, 1150, 1050000, 60, 3200000, 42, 18) },
    { label: "30~34세", metrics: M(38000, 1320, 1280000, 72, 3900000, 50, 22) },
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
// 매체 합계행(27)은 양식이 C27=C25+C26 / H27=M27+N27 등 수식인데, 825cd60이 집계 숫자 직접 기입으로
// 바꿨다(디스플레이행 M26/N26='-'와 더해져 #VALUE!가 나던 문제). 수식이 되살아나면 회귀.
const rowXml = (xml: string, r: number) => xml.match(new RegExp(`<row r="${r}"[\\s\\S]*?</row>`))?.[0] ?? "";
ok(/<c r="C27"[^>]*><v>180000<\/v>/.test(s2), "종합 매체 합계행 노출(C27)=180000 직접 기입(hasDisplay=false)");
ok(!/<f>/.test(rowXml(s2, 27)), "종합 매체 합계행(27)에 양식 수식 잔존 없음");
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

// ── #VALUE! 회귀 (825cd60) ──
// hasDisplay=true면 디스플레이행 M26/N26이 '-'(텍스트)로 찍힌다. 이때 합계행 27이 양식 수식
// (M27=M25+M26)을 그대로 쓰면 텍스트+숫자 → #VALUE!, 그게 H27=M27+N27 → 전환율(I)/전환당비용(J)
// 까지 번진다. 27행은 수식 없이 집계 숫자만 있어야 한다.
const filesD = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));
fillFixedSheets(filesD, { ...model, hasDisplay: true });
const s2d = readText(openXlsx(buildXlsx(filesD)), "xl/worksheets/sheet2.xml");
const row27d = rowXml(s2d, 27);

ok(/<c r="M26"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s2d), "디스플레이행 직접전환(M26)='-' (#VALUE! 유발 조건 성립)");
ok(/<c r="N26"[^>]*t="inlineStr"[^>]*><is><t[^>]*>-<\/t>/.test(s2d), "디스플레이행 간접전환(N26)='-'");
ok(!/<f>/.test(row27d), "hasDisplay=true 합계행(27)에 수식 없음 — '-'와 더해져 #VALUE! 안 남");
// 검색 180000 + 디스플레이 5820000 = 6000000 / 구매완료 450 + 400 = 850
ok(/<c r="C27"[^>]*><v>6000000<\/v>/.test(s2d), "합계행 노출(C27)=검색+디스플레이 6,000,000");
ok(/<c r="H27"[^>]*><v>850<\/v>/.test(s2d), "합계행 구매완료(H27)=850 — M27+N27 수식 대신 집계값");
// M27은 addMetrics 결과(검색 320 + 디스플레이 200). 실제 GFA는 직접/간접이 늘 0이라 검색광고분과
// 같아지지만, 여기선 합산이 도는지만 본다 — 표기('-')는 26행 얘기지 27행 집계와 무관.
ok(/<c r="M27"[^>]*><v>520<\/v>/.test(s2d), "합계행 직접전환(M27)=검색 320+디스플레이 200");

console.log(fail === 0 ? `\n전체 통과 ✅  (샘플 파일: dist-report-sample.xlsx, ${out.length} bytes)` : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
