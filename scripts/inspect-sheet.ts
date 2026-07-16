// 양식 시트의 셀을 사람이 읽기 좋게 덤프 (셀 매핑용).
// 사용: node scripts/inspect-sheet.ts <sheetNumber>
import { readFileSync } from "node:fs";
import { openXlsx, readText } from "../src/features/report/report-excel.ts";

const n = process.argv[2] ?? "2";
const files = openXlsx(new Uint8Array(readFileSync("src/assets/report-template.xlsx")));

// sharedStrings 인덱스 → 평문
const sst: string[] = [];
const sstXml = readText(files, "xl/sharedStrings.xml");
for (const m of sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
  const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("");
  sst.push(text.replace(/\s+/g, " ").trim());
}

const xml = readText(files, `xl/worksheets/sheet${n}.xml`);
console.log(`=== sheet${n} ===`);
for (const row of xml.matchAll(/<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
  const cells: string[] = [];
  for (const c of row[2].matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const addr = c[1];
    const attrs = c[2];
    const inner = c[3] ?? "";
    const isStr = /t="s"/.test(attrs);
    const fM = inner.match(/<f>([\s\S]*?)<\/f>/);
    const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
    let val = "";
    if (fM) val = `=${fM[1]}`;
    else if (vM) val = isStr ? `"${sst[Number(vM[1])] ?? "?"}"` : vM[1];
    else continue;
    cells.push(`${addr}:${val}`);
  }
  if (cells.length) console.log(`r${row[1]}  ` + cells.join("  "));
}
