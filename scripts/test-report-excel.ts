// report-excel.ts 템플릿 주입 엔진 검증 (Node 24 직접 실행: `node scripts/test-report-excel.ts`)
import { readFileSync } from "node:fs";
import {
  openXlsx,
  buildXlsx,
  readText,
  applyCells,
  setString,
  writeText,
  forceRecalc,
  removeSheets,
  listSheets,
} from "../src/lib/report-excel.ts";

const tpl = new Uint8Array(readFileSync("src/assets/report-template.xlsx"));
const files = openXlsx(tpl);

let fail = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) fail++;
};

// 1) 종합(sheet2) 입력칸 숫자 교체
applyCells(files, "xl/worksheets/sheet2.xml", { C18: 999999, D18: 88888, M18: 7, N18: 3 });
// 2) 표지(sheet1) 문자열 교체 — B7 영역(보고서 제목 자리, t="s" 공유문자열 셀)
let s1 = readText(files, "xl/worksheets/sheet1.xml");
s1 = setString(s1, "B7", "테스트 광고주 리포트");
writeText(files, "xl/worksheets/sheet1.xml", s1);
// 3) 강제 재계산
forceRecalc(files);
// 4) 디스플레이 시트 2개 제거
removeSheets(files, ["디스플레이", "디스플레이_상세"]);

// 5) 다시 압축 → 다시 열기(왕복 유효성)
const out = buildXlsx(files);
ok(out.length > 0, `zip 출력 생성됨 (${out.length} bytes)`);
const reopened = openXlsx(out);

// 검증
const sheet2 = readText(reopened, "xl/worksheets/sheet2.xml");
ok(/<c r="C18"[^>]*><v>999999<\/v>/.test(sheet2), "종합 C18 = 999999 반영");
ok(/<c r="M18"[^>]*><v>7<\/v>/.test(sheet2), "종합 M18 = 7 반영");
ok(/IFERROR\(D18\/C18,0\)/.test(sheet2), "종합 수식(E18 클릭률) 보존됨");

const sheet1 = readText(reopened, "xl/worksheets/sheet1.xml");
ok(sheet1.includes("테스트 광고주 리포트"), "표지 B7 문자열 반영");

const wb = readText(reopened, "xl/workbook.xml");
ok(/fullCalcOnLoad="1"/.test(wb), "fullCalcOnLoad 설정됨");

const sheets = listSheets(reopened);
ok(sheets.length === 6, `시트 6개 남음 (실제 ${sheets.length}: ${sheets.map((s) => s.name).join(",")})`);
ok(!sheets.some((s) => s.name.startsWith("디스플레이")), "디스플레이 시트 workbook에서 제거됨");
ok(!reopened["xl/worksheets/sheet7.xml"], "sheet7.xml 파트 삭제됨");
ok(!reopened["xl/worksheets/sheet8.xml"], "sheet8.xml 파트 삭제됨");
ok(!reopened["xl/charts/chart7.xml"], "디스플레이 차트(chart7) 파트 삭제됨");

const ct = readText(reopened, "[Content_Types].xml");
ok(!ct.includes("sheet7.xml"), "Content_Types에서 sheet7 Override 제거됨");
ok(!/Id="[^"]*"\s+Type="[^"]*worksheet"[^>]*Target="worksheets\/sheet7/.test(readText(reopened, "xl/_rels/workbook.xml.rels")), "rels에서 sheet7 관계 제거됨");

console.log(fail === 0 ? "\n전체 통과 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
