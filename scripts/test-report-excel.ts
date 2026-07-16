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
  insertRowsAt,
  dropRowCellsAfter,
} from "../src/features/report/report-excel.ts";

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

// ── insertRowsAt이 조건부 서식(sqref)도 같이 민다 ──
// 안 밀면 셀만 내려가고 서식은 옛 행에 남아 "증감 빨강/초록이 사라진" 것처럼 보인다.
// 실제로 검색광고/디스플레이 증감표에서 그렇게 됐다(콤보 그래프 자리 11행 삽입 때).
{
  const sheet =
    `<worksheet><sheetData>` +
    `<row r="1"><c r="C1"><v>1</v></c></row>` +
    `<row r="6"><c r="C6"><v>6</v></c></row>` +
    `<row r="7"><c r="C7"><v>7</v></c></row>` +
    `</sheetData>` +
    `<conditionalFormatting sqref="C6:N7"><cfRule type="cellIs"/></conditionalFormatting>` +
    `</worksheet>`;
  const shifted = insertRowsAt(sheet, 3, [`<row r="3"/>`, `<row r="4"/>`]);
  ok(shifted.includes(`sqref="C8:N9"`), `삽입 행 아래 조건부 서식 범위가 +2 이동 (실제 ${shifted.match(/sqref="[^"]+"/)?.[0]})`);
  ok(!shifted.includes(`sqref="C6:N7"`), "옛 범위가 남지 않음");

  // 삽입 지점보다 위(1행)는 그대로 — 위쪽 서식까지 밀면 안 된다
  const above =
    `<worksheet><sheetData><row r="1"><c r="C1"><v>1</v></c></row></sheetData>` +
    `<conditionalFormatting sqref="C1:N1"><cfRule type="cellIs"/></conditionalFormatting></worksheet>`;
  ok(insertRowsAt(above, 3, [`<row r="3"/>`]).includes(`sqref="C1:N1"`), "삽입 지점 위 조건부 서식은 그대로");

  // 여러 범위(공백 구분)도 각각
  const multi =
    `<worksheet><sheetData><row r="6"><c r="C6"><v>6</v></c></row></sheetData>` +
    `<conditionalFormatting sqref="C6:N6 P6:Q6"><cfRule type="cellIs"/></conditionalFormatting></worksheet>`;
  ok(insertRowsAt(multi, 3, [`<row r="3"/>`]).includes(`sqref="C7:N7 P7:Q7"`), "공백으로 나뉜 여러 범위도 각각 이동");
}

// ── dropRowCellsAfter: 양식 복제 시트의 표 밖 잔여 셀 제거 ──
{
  const r = `<worksheet><sheetData><row r="2" spans="2:16">` +
    `<c r="B2" s="47"/><c r="N2" s="47"/><c r="O2" s="47"/><c r="P2" s="47"/>` +
    `</row><row r="3"><c r="O3" s="1"/></row></sheetData></worksheet>`;
  const dropped = dropRowCellsAfter(r, 2, "N");
  ok(dropped.includes(`<c r="N2"`) && !dropped.includes(`<c r="O2"`) && !dropped.includes(`<c r="P2"`),
    "지정 열 오른쪽 셀만 제거(N은 유지, O/P 제거)");
  ok(dropped.includes(`<c r="O3"`), "다른 행은 안 건드림");
  // 자기닫힘 행(<row .../>)은 셀이 없으니 그대로 — setRowHidden과 같은 함정.
  // 걸러내지 않으면 `[\s\S]*?</row>`가 뒤쪽 행의 </row>까지 삼켜 남의 셀을 지운다.
  const selfClosing = `<worksheet><sheetData><row r="2" ht="24" customHeight="1"/><row r="3"><c r="O3"/></row></sheetData></worksheet>`;
  ok(dropRowCellsAfter(selfClosing, 2, "N") === selfClosing, "자기닫힘 행은 그대로 — 뒤 행의 셀을 삼키지 않음");
  // 속성 없는 행 — `[^>]*[^/]>` 식으로 쓰면 `>` 앞 한 글자를 못 채워 조용히 no-op이 된다
  const bare = `<worksheet><sheetData><row r="2"><c r="B2"/><c r="O2"/></row></sheetData></worksheet>`;
  const bareOut = dropRowCellsAfter(bare, 2, "N");
  ok(bareOut.includes(`<c r="B2"`) && !bareOut.includes(`<c r="O2"`), "속성 없는 <row r=\"2\">에서도 동작");
}

console.log(fail === 0 ? "\n전체 통과 ✅" : `\n${fail}건 실패 ❌`);
process.exit(fail === 0 ? 0 : 1);
