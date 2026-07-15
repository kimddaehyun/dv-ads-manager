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
  setRowHidden,
  hideRowRange,
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
// 2) 문자열 셀 교체 — 종합(sheet2) B2(t="s" 공유문자열 셀). 표지(sheet1)는 도면 기반이라
//    셀이 없으므로 엔진 setString 검증은 셀이 존재하는 다른 시트에서 한다.
let s2str = readText(files, "xl/worksheets/sheet2.xml");
s2str = setString(s2str, "B2", "테스트 광고주 리포트");
writeText(files, "xl/worksheets/sheet2.xml", s2str);
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

ok(sheet2.includes("테스트 광고주 리포트"), "종합 B2 문자열 반영");

const wb = readText(reopened, "xl/workbook.xml");
ok(/fullCalcOnLoad="1"/.test(wb), "fullCalcOnLoad 설정됨");

const sheets = listSheets(reopened);
// 양식 9시트 - 디스플레이 2개 = 7 (쇼핑검색_상품 추가로 6→7)
ok(sheets.length === 7, `시트 7개 남음 (실제 ${sheets.length}: ${sheets.map((s) => s.name).join(",")})`);
ok(!sheets.some((s) => s.name.startsWith("디스플레이")), "디스플레이 시트 workbook에서 제거됨");
ok(!reopened["xl/worksheets/sheet7.xml"], "sheet7.xml 파트 삭제됨");
ok(!reopened["xl/worksheets/sheet8.xml"], "sheet8.xml 파트 삭제됨");
ok(!reopened["xl/charts/chart7.xml"], "디스플레이 차트(chart7) 파트 삭제됨");

const ct = readText(reopened, "[Content_Types].xml");
ok(!ct.includes("sheet7.xml"), "Content_Types에서 sheet7 Override 제거됨");
ok(!/Id="[^"]*"\s+Type="[^"]*worksheet"[^>]*Target="worksheets\/sheet7/.test(readText(reopened, "xl/_rels/workbook.xml.rels")), "rels에서 sheet7 관계 제거됨");

// setRowHidden — 자기닫힘 행(<row .../>)에도 유효한 XML을 만들어야 한다.
// 내용 없는 여백/그래프 자리 행이 자기닫힘으로 들어오는데, `/ hidden="1">` 같은 깨진 태그가
// 나오면 엑셀이 '복구' 대화상자를 띄우고 시트를 통째로 못 읽는다.
{
  const selfClosing = `<row r="9" spans="2:15" ht="24" customHeight="1"/>`;
  const hiddenSelf = setRowHidden(selfClosing, 9);
  ok(hiddenSelf.includes('hidden="1"/>') && !hiddenSelf.includes("/ hidden"),
    `자기닫힘 행 숨김이 유효한 XML (실제: ${hiddenSelf})`);
  const open = `<row r="9" spans="2:15"><c r="B9"/></row>`;
  const hiddenOpen = setRowHidden(open, 9);
  ok(hiddenOpen.includes('<row r="9" spans="2:15" hidden="1">'),
    `열림 행 숨김 유지 (실제: ${hiddenOpen.slice(0, 45)})`);
  ok(setRowHidden(`<row r="9" hidden="1"/>`, 9) === `<row r="9" hidden="1"/>`, "이미 숨김이면 그대로");

  // hideRowRange가 자기닫힘 행이 섞인 범위에서도 well-formed를 유지하는지 (그래프 자리 숨김 경로)
  const mixed = `<worksheet><sheetData>`
    + `<row r="9" spans="2:15" ht="24" customHeight="1"/>`
    + `<row r="10" spans="2:15"><c r="B10" t="inlineStr"><is><t>값</t></is></c></row>`
    + `<row r="11" spans="2:15" ht="24" customHeight="1"/>`
    + `</sheetData></worksheet>`;
  const hiddenMixed = hideRowRange(mixed, 9, 11);
  const hiddenCount = (hiddenMixed.match(/hidden="1"/g) ?? []).length;
  ok(!hiddenMixed.includes("/ hidden") && hiddenCount === 3,
    `hideRowRange가 자기닫힘 섞인 범위에서도 유효 XML 유지 (숨김 ${hiddenCount}/3)`);
  ok(/<row r="9"[^>]*hidden="1"\/>/.test(hiddenMixed) && /<row r="11"[^>]*hidden="1"\/>/.test(hiddenMixed),
    "hideRowRange가 자기닫힘 행의 `/>`를 보존");
}

console.log(fail === 0 ? "\n전체 통과 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
