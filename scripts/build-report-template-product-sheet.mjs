// 쇼핑검색_상품 시트(sheet9)를 양식 바이너리에 1회성 병합한다. 재실행 안전(idempotent).
//
//   node scripts/build-report-template-product-sheet.mjs
//
// 상품별 시트는 쇼핑검색_키워드(sheet6)와 레이아웃이 같다(캠페인/그룹/D열 + 12지표, 그룹 소계,
// 전체합계 B:D 병합). 그래서 새로 디자인하지 않고 sheet6을 그대로 복제해 sheet9로 넣는다:
//   - 표본 행 스타일(4=데이터 / 7=소계 / 11=전체합계)이 같이 따라와 renderKeywordSheet가 바로 먹는다.
//   - D열 헤더("키워드" → "상품명")는 런타임에 renderKeywordSheet가 교체한다.
//
// 주입 대상:
//   - xl/worksheets/sheet9.xml            ← sheet6.xml 복제
//   - xl/workbook.xml                     : <sheets>에 쇼핑검색_키워드 바로 뒤로 <sheet> 삽입
//   - xl/_rels/workbook.xml.rels          : rId13 → worksheets/sheet9.xml
//   - [Content_Types].xml                 : sheet9 Override
//
// 시트 제거(데이터 없을 때)는 런타임 removeSheets가 이름으로 처리하므로 추가 작업 없음.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unzipSync, zipSync } from "fflate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(root, "src/assets/report-template.xlsx");
const enc = new TextEncoder();
const dec = new TextDecoder();

const SHEET_NAME = "쇼핑검색_상품";
const AFTER_SHEET = "쇼핑검색_키워드"; // 이 시트 바로 뒤에 꽂는다
const PART = "xl/worksheets/sheet9.xml";
const RID = "rId13"; // rId1~8=시트, 9=theme, 10=styles, 11=sharedStrings, 12=calcChain

const files = unzipSync(new Uint8Array(readFileSync(TEMPLATE)));

if (files[PART]) {
  console.log(`이미 병합됨 (${PART} 존재) — 건너뜀`);
  process.exit(0);
}

// 1) sheet6(쇼핑검색_키워드) 복제 → sheet9
const src = files["xl/worksheets/sheet6.xml"];
if (!src) throw new Error("xl/worksheets/sheet6.xml 없음 — 양식이 예상과 다름");
files[PART] = new Uint8Array(src);

// 2) workbook.xml — 쇼핑검색_키워드 <sheet> 바로 뒤에 삽입
let wb = dec.decode(files["xl/workbook.xml"]);
const afterRe = new RegExp(`<sheet[^>]*name="${AFTER_SHEET}"[^>]*/>`);
const afterM = wb.match(afterRe);
if (!afterM) throw new Error(`workbook.xml에 "${AFTER_SHEET}" 시트 없음 — 양식이 예상과 다름`);
if (!wb.includes(`name="${SHEET_NAME}"`)) {
  wb = wb.replace(afterRe, `${afterM[0]}<sheet name="${SHEET_NAME}" sheetId="9" r:id="${RID}"/>`);
  files["xl/workbook.xml"] = enc.encode(wb);
}

// 3) workbook.xml.rels — rId13 → sheet9
let rels = dec.decode(files["xl/_rels/workbook.xml.rels"]);
if (rels.includes(`Id="${RID}"`)) throw new Error(`${RID} 이미 사용 중 — 다른 rId를 골라야 함`);
rels = rels.replace(
  "</Relationships>",
  `<Relationship Id="${RID}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet9.xml"/></Relationships>`,
);
files["xl/_rels/workbook.xml.rels"] = enc.encode(rels);

// 4) [Content_Types].xml — sheet9 Override
let ct = dec.decode(files["[Content_Types].xml"]);
if (!ct.includes(`PartName="/${PART}"`)) {
  ct = ct.replace(
    "</Types>",
    `<Override PartName="/${PART}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  );
  files["[Content_Types].xml"] = enc.encode(ct);
}

writeFileSync(TEMPLATE, zipSync(files, { level: 6 }));
console.log(`병합 완료: "${SHEET_NAME}" 시트(${PART}) 추가 → ${TEMPLATE}`);
