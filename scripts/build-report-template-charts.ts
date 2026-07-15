// 검색광고(sheet3)/디스플레이(sheet7) 시트에 일자별 콤보 그래프(막대=광고비, 선=매출)를
// 양식 바이너리에 1회성 병합한다. 재실행 안전(idempotent).
//
//   node --import ./scripts/ts-resolve.mjs scripts/build-report-template-charts.ts
//
// 두 시트에는 원래 그래프 자리가 없다 → **섹션 제목 바로 아래, 표 위**에 빈 행 11개를 끼워 넣어
// 그래프 자리를 만든다. 검색_상세(sheet4)의 "1. 일자별 성과"(2행) → 그래프(3~13행) → 표(14행~)
// 배치와 행 수·높이·앵커를 그대로 맞춘 것 — 리포트 안에서 그래프 크기가 통일된다. 결과 배치:
//   2      섹션1 제목 (그대로)
//   3~13   그래프 자리  ← 신설 (11행 x 24pt = 264pt, 검색_상세와 동일)
//   14~18  섹션1 요약표 (옛 3~7)
//   20~    섹션2 캠페인별 (옛 9~)
// 이 이동 때문에 아래 두 곳의 행번호도 +11 되어 있어야 한다:
//   - report-fill.ts   : fillSearchSummary/fillDisplaySummary의 summaryBlock(15,16,17,18) + B15/B16
//   - report-variable.ts: CAMP_BAR_ROW/CAMP_HEADER_ROW/CAMP_FIRST_ROW + layout의 표본 행번호
//
// 주입 대상:
//   - xl/charts/chart11.xml, chart12.xml       ← src/assets/charts/combo-daily-chart.xml (__SHEET__ 치환)
//   - xl/drawings/drawing5.xml, drawing6.xml   + 각 _rels
//   - xl/worksheets/_rels/sheet3.xml.rels, sheet7.xml.rels  (신설 — 원래 없음)
//   - [Content_Types].xml                      : chart11/12 + drawing5/6 Override
//
// 그래프는 상세 시트의 일자별 표를 참조한다(새 표를 안 만든다). 디스플레이_상세가 제거되는
// 계정에선 chart12가 끊긴 참조가 되므로 런타임(report-build)에서 sheet7 그림을 통째로 뺀다.
import { readFileSync, writeFileSync } from "node:fs";
import { openXlsx, buildXlsx, readText, writeText, insertRowsAt } from "../src/lib/report-excel.ts";

const TEMPLATE = "src/assets/report-template.xlsx";
const CHART_SRC = "src/assets/charts/combo-daily-chart.xml";

const files = openXlsx(new Uint8Array(readFileSync(TEMPLATE)));

if (files["xl/charts/chart11.xml"]) {
  console.log("이미 병합됨 (xl/charts/chart11.xml 존재) — 건너뜀");
  process.exit(0);
}

// 원본 차트 XML — 문서 주석은 떼고 넣는다(파트는 깔끔하게).
const chartTemplate = readFileSync(CHART_SRC, "utf8").replace(/<!--[\s\S]*?-->\s*/g, "");

const enc = new TextEncoder();
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const relXml = (id: string, type: string, target: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="${REL_NS}">` +
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>` +
  `</Relationships>`;

// 그래프 앵커 — 검색_상세 chart3의 앵커와 동일(B열~N열, 3~13행 = 0-based 2~12).
const drawingXml = (frameId: number) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
  `<xdr:twoCellAnchor editAs="oneCell">` +
  `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>59070</xdr:rowOff></xdr:from>` +
  `<xdr:to><xdr:col>13</xdr:col><xdr:colOff>714374</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>247650</xdr:rowOff></xdr:to>` +
  `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr>` +
  `<xdr:cNvPr id="${frameId}" name="Chart ${frameId}"/><xdr:cNvGraphicFramePr/>` +
  `</xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
  `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/>` +
  `</a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;

// 그래프 자리 빈 행 11개 (3~13). 검색_상세 차트 자리와 같은 행 수·높이(11 x 24pt = 264pt).
const CHART_ROWS = 11;
const CHART_FROM_ROW = 3; // 섹션1 제목(2행) 바로 아래 — 표(옛 3행~)는 아래로 밀린다
const spacerRows = (from: number) =>
  Array.from({ length: CHART_ROWS }, (_, i) => `<row r="${from + i}" spans="2:15" ht="24" customHeight="1"/>`);

const targets = [
  { sheet: "xl/worksheets/sheet3.xml", detail: "검색_상세", chart: "chart11.xml", drawing: "drawing5.xml", frameId: 11 },
  { sheet: "xl/worksheets/sheet7.xml", detail: "디스플레이_상세", chart: "chart12.xml", drawing: "drawing6.xml", frameId: 12 },
];

for (const t of targets) {
  // 1) 차트 파트 (__SHEET__ → 상세 시트명)
  files[`xl/charts/${t.chart}`] = enc.encode(chartTemplate.replace(/__SHEET__/g, t.detail));
  // 2) 그림 파트 + 그림→차트 관계
  files[`xl/drawings/${t.drawing}`] = enc.encode(drawingXml(t.frameId));
  files[`xl/drawings/_rels/${t.drawing}.rels`] = enc.encode(relXml("rId1", "chart", `../charts/${t.chart}`));
  // 3) 시트→그림 관계 (이 두 시트는 원래 rels가 없어 새로 만든다)
  const sheetName = t.sheet.replace("xl/worksheets/", "");
  if (files[`xl/worksheets/_rels/${sheetName}.rels`]) {
    throw new Error(`${sheetName}.rels가 이미 있음 — 관계를 덮어쓰면 안 되니 병합 방식 재검토 필요`);
  }
  files[`xl/worksheets/_rels/${sheetName}.rels`] = enc.encode(relXml("rId1", "drawing", `../drawings/${t.drawing}`));

  // 4) 시트에 <drawing> 참조 + 그래프 자리 빈 행 삽입
  let xml = readText(files, t.sheet);
  if (!xml.includes("<drawing ")) {
    // <drawing>은 스키마상 시트 끝(pageSetup 뒤) — </worksheet> 직전에 붙인다.
    xml = xml.replace("</worksheet>", `<drawing r:id="rId1"/></worksheet>`);
  }
  // 3행 앞에 11행 삽입 → 섹션1 표(3~7)와 섹션2(9~)가 통째로 아래로. 행번호·셀ref·수식ref·병합 전부 이동.
  xml = insertRowsAt(xml, CHART_FROM_ROW, spacerRows(CHART_FROM_ROW));
  writeText(files, t.sheet, xml);
}

// 5) [Content_Types].xml — 차트/그림 Override
let ct = readText(files, "[Content_Types].xml");
for (const t of targets) {
  const chartPart = `/xl/charts/${t.chart}`;
  const drawPart = `/xl/drawings/${t.drawing}`;
  if (!ct.includes(`PartName="${chartPart}"`)) {
    ct = ct.replace("</Types>",
      `<Override PartName="${chartPart}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
  }
  if (!ct.includes(`PartName="${drawPart}"`)) {
    ct = ct.replace("</Types>",
      `<Override PartName="${drawPart}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
  }
}
writeText(files, "[Content_Types].xml", ct);

writeFileSync(TEMPLATE, buildXlsx(files));
console.log(`병합 완료: 콤보 그래프 chart11(검색광고)/chart12(디스플레이)`
  + ` + 그래프 자리 ${CHART_ROWS}행(${CHART_FROM_ROW}~${CHART_FROM_ROW + CHART_ROWS - 1}) → ${TEMPLATE}`);
