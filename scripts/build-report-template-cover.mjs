// 표지(도면 기반) 신규 디자인을 양식 바이너리에 1회성 병합한다. 재실행 안전(idempotent).
//
//   node scripts/build-report-template-cover.mjs
//
// src/assets/cover/ 의 표지 소스(cover-sheet1.xml / cover-drawing.xml / cover-bg.png)를
// src/assets/report-template.xlsx 에 주입:
//   - xl/worksheets/sheet1.xml            ← cover-sheet1.xml (빈 셀 + drawing 참조)
//   - xl/drawings/drawing4.xml            ← cover-drawing.xml (기존 drawing1~3과 충돌 회피)
//   - xl/drawings/_rels/drawing4.xml.rels (→ ../media/image-cover.png)
//   - xl/media/image-cover.png            ← cover-bg.png
//   - xl/worksheets/_rels/sheet1.xml.rels (→ ../drawings/drawing4.xml)
//   - [Content_Types].xml: png Default + drawing4 Override (중복 가드)
//
// 동적 값(업체명/기간/담당자/작성일)은 런타임 fillCover(report-fill.ts)가 도면 토큰을 치환.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unzipSync, zipSync } from "fflate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const A = (p) => join(root, p);

const TEMPLATE = A("src/assets/report-template.xlsx");
const enc = new TextEncoder();
const dec = new TextDecoder();

const files = unzipSync(new Uint8Array(readFileSync(TEMPLATE)));

const coverSheet = readFileSync(A("src/assets/cover/cover-sheet1.xml"));
const coverDraw = readFileSync(A("src/assets/cover/cover-drawing.xml"));
const coverPng = new Uint8Array(readFileSync(A("src/assets/cover/cover-bg.png")));

// 1) 표지 시트 교체 + 도면/이미지/관계 추가
files["xl/worksheets/sheet1.xml"] = new Uint8Array(coverSheet);
files["xl/drawings/drawing4.xml"] = new Uint8Array(coverDraw);
files["xl/media/image-cover.png"] = coverPng;
files["xl/worksheets/_rels/sheet1.xml.rels"] = enc.encode(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing4.xml"/>` +
  `</Relationships>`,
);
files["xl/drawings/_rels/drawing4.xml.rels"] = enc.encode(
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image-cover.png"/>` +
  `</Relationships>`,
);

// 2) [Content_Types].xml — png Default + drawing4 Override (이미 있으면 건너뜀)
let ct = dec.decode(files["[Content_Types].xml"]);
if (!/Extension="png"/.test(ct)) {
  ct = ct.replace(
    /(<Default Extension="xml"[^>]*\/>)/,
    `$1<Default Extension="png" ContentType="image/png"/>`,
  );
}
if (!ct.includes(`PartName="/xl/drawings/drawing4.xml"`)) {
  ct = ct.replace(
    /(<\/Types>)/,
    `<Override PartName="/xl/drawings/drawing4.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>$1`,
  );
}
files["[Content_Types].xml"] = enc.encode(ct);

// 결정적 출력 — report-excel.ts와 동일하게 1980-01-01 고정 mtime
const out = zipSync(files, { level: 6, mtime: Date.UTC(1980, 0, 1) });
writeFileSync(TEMPLATE, out);
console.log(`OK — 표지 병합 완료: ${TEMPLATE} (${out.length} bytes)`);
