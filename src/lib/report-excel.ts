// F-Report 템플릿 주입(Template Injection) 엔진.
//
// 양식 xlsx(=zip)를 그대로 열어 워크시트 셀 값만 바꿔 다시 압축한다. 차트/수식/서식은
// 손대지 않으므로 100% 보존되고, 셀 범위에 바인딩된 네이티브 차트와 수식은 우리가 넣은
// 숫자로 자동 재계산된다(forceRecalc로 열 때 강제 재계산).
//
// 이 모듈은 순수 함수만 — chrome/fetch 의존 없음(Node에서 단독 테스트 가능). 브라우저에서
// 템플릿을 fetch하고 Blob으로 내려주는 부분은 호출 측(content script)이 담당한다.

import { unzipSync, zipSync } from "fflate";

export type ZipFiles = Record<string, Uint8Array>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function openXlsx(bytes: Uint8Array): ZipFiles {
  return unzipSync(bytes);
}

// zip 타임스탬프는 1980-01-01 고정 — 결정적 출력 + zip 허용 범위(1980~2099) 안.
const FIXED_MTIME = Date.UTC(1980, 0, 1);

export function buildXlsx(files: ZipFiles): Uint8Array {
  return zipSync(files, { level: 6, mtime: FIXED_MTIME });
}

export function readText(files: ZipFiles, path: string): string {
  const b = files[path];
  if (!b) throw new Error(`zip 항목 없음: ${path}`);
  return decoder.decode(b);
}

export function writeText(files: ZipFiles, path: string, xml: string): void {
  files[path] = encoder.encode(xml);
}

// XML 1.0이 금지하는 제어문자 제거(실데이터 검색어 등에 섞일 수 있음 → 제거 안 하면 깨진 XML).
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function escapeXml(s: string): string {
  return stripControl(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function styleAttr(attrs: string): string {
  const m = attrs.match(/\ss="(\d+)"/);
  return m ? ` s="${m[1]}"` : "";
}

// 워크시트 XML에서 한 셀을 통째로 교체. 셀의 `s`(스타일) 속성은 보존하고 `t`(타입)/내용은
// 새로 쓴다. 수식 셀(`<f>` 포함)은 호출 측에서 건드리지 않는 게 원칙 — 여기선 매칭되면
// 그냥 덮어쓰므로 입력칸(원본값/빈칸)에만 사용할 것.
//
// 자기닫힘(`<c r="C4" s="1"/>`)과 열림-닫힘(`<c r="C18" s="5"><v>..</v></c>`) 둘 다 처리.
// 셀이 행에 아예 없으면(생략된 경우) false 의미로 원본 반환 — 양식 입력칸은 전부 존재하므로
// 실무상 문제없음.
function replaceCell(
  xml: string,
  addr: string,
  build: (style: string) => string,
): string {
  const selfRe = new RegExp(`<c r="${addr}"([^>]*?)/>`);
  const selfM = xml.match(selfRe);
  if (selfM) return xml.replace(selfRe, build(styleAttr(selfM[1])));

  const openRe = new RegExp(`<c r="${addr}"([^>]*?)>[\\s\\S]*?</c>`);
  const openM = xml.match(openRe);
  if (openM) return xml.replace(openRe, build(styleAttr(openM[1])));

  return xml;
}

export function setNumber(xml: string, addr: string, value: number): string {
  return replaceCell(xml, addr, (s) => `<c r="${addr}"${s}><v>${value}</v></c>`);
}

export function setString(xml: string, addr: string, text: string): string {
  return replaceCell(
    xml,
    addr,
    (s) =>
      `<c r="${addr}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`,
  );
}

// 여러 셀을 한 시트에 적용하는 헬퍼. values는 {주소: 값} 맵.
export function applyCells(
  files: ZipFiles,
  sheetPath: string,
  numbers: Record<string, number>,
  strings?: Record<string, string>,
): void {
  let xml = readText(files, sheetPath);
  for (const [addr, v] of Object.entries(numbers)) {
    if (Number.isFinite(v)) xml = setNumber(xml, addr, v);
  }
  if (strings) {
    for (const [addr, t] of Object.entries(strings)) xml = setString(xml, addr, t);
  }
  writeText(files, sheetPath, xml);
}

// 파일 열 때 수식을 강제 재계산 — 우리가 raw 입력칸만 바꾸므로, 파생 수식(CTR/ROAS/증감 등)이
// 캐시된 옛 값으로 안 남게.
export function forceRecalc(files: ZipFiles): void {
  let wb = readText(files, "xl/workbook.xml");
  wb = wb.replace(/<calcPr([^>]*?)\/>/, (full, a) =>
    /fullCalcOnLoad/.test(a) ? full : `<calcPr${a} fullCalcOnLoad="1"/>`,
  );
  writeText(files, "xl/workbook.xml", wb);
}

export interface SheetRef {
  name: string;
  sheetId: string;
  rId: string;
  partPath: string; // xl/worksheets/sheetN.xml
}

// workbook.xml + rels를 읽어 시트명 → 파트 경로 매핑을 만든다.
export function listSheets(files: ZipFiles): SheetRef[] {
  const wb = readText(files, "xl/workbook.xml");
  const rels = readText(files, "xl/_rels/workbook.xml.rels");
  const relMap = new Map<string, string>(); // rId → target
  for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g)) {
    relMap.set(m[1], m[2]);
  }
  const out: SheetRef[] = [];
  for (const m of wb.matchAll(
    /<sheet\b[^>]*name="([^"]+)"[^>]*sheetId="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g,
  )) {
    const [, name, sheetId, rId] = m;
    const target = relMap.get(rId) ?? "";
    const partPath = "xl/" + target.replace(/^\/?xl\//, "").replace(/^\//, "");
    out.push({ name, sheetId, rId, partPath });
  }
  return out;
}

// 진행하지 않는 매체의 시트를 제거. 양식 무결성을 위해 workbook.xml / rels /
// [Content_Types].xml / 워크시트 파트 + 그 시트가 단독으로 참조하는 drawing/chart 파트까지
// 정리한다.
export function removeSheets(files: ZipFiles, names: string[]): void {
  if (names.length === 0) return;
  const sheets = listSheets(files);
  let wb = readText(files, "xl/workbook.xml");
  let rels = readText(files, "xl/_rels/workbook.xml.rels");
  let ct = readText(files, "[Content_Types].xml");

  for (const name of names) {
    const ref = sheets.find((s) => s.name === name);
    if (!ref) continue;

    // 1) workbook.xml의 <sheet> 항목 제거
    wb = wb.replace(
      new RegExp(`<sheet\\b[^>]*name="${name}"[^>]*/>`),
      "",
    );
    // 2) workbook.xml.rels의 Relationship 제거
    rels = rels.replace(
      new RegExp(`<Relationship\\b[^>]*Id="${ref.rId}"[^>]*/>`),
      "",
    );

    // 3) 시트가 단독 참조하는 drawing/chart 파트 수집(시트 rels 따라가기)
    const partName = ref.partPath.replace(/^xl\/worksheets\//, "");
    const sheetRelsPath = `xl/worksheets/_rels/${partName}.rels`;
    const orphanParts: string[] = [];
    if (files[sheetRelsPath]) {
      const sr = readText(files, sheetRelsPath);
      for (const m of sr.matchAll(/Target="([^"]+)"/g)) {
        const drawingPath = normalizeXlPath(m[1], "xl/worksheets");
        orphanParts.push(drawingPath);
        const drawRelsPath = drawingPath.replace(
          /([^/]+)$/,
          "_rels/$1.rels",
        );
        if (files[drawRelsPath]) {
          const dr = readText(files, drawRelsPath);
          for (const dm of dr.matchAll(/Target="([^"]+)"/g)) {
            orphanParts.push(
              normalizeXlPath(dm[1], drawingPath.replace(/\/[^/]+$/, "")),
            );
          }
          orphanParts.push(drawRelsPath);
        }
      }
      orphanParts.push(sheetRelsPath);
    }

    // 4) 파트 파일 삭제 + Content_Types Override 제거
    for (const p of [ref.partPath, ...orphanParts]) {
      delete files[p];
      ct = ct.replace(
        new RegExp(`<Override\\b[^>]*PartName="/${escapeRe(p)}"[^>]*/>`),
        "",
      );
    }
  }

  writeText(files, "xl/workbook.xml", wb);
  writeText(files, "xl/_rels/workbook.xml.rels", rels);
  writeText(files, "[Content_Types].xml", ct);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// calcChain.xml(수식 셀 계산 순서 캐시) 제거. 행 재생성/시트 삭제 후 이게 stale하면 엑셀이
// "복구하시겠습니까?" 대화상자를 띄운다. 삭제하면 엑셀이 열 때 재계산(fullCalcOnLoad와 함께).
export function removeCalcChain(files: ZipFiles): void {
  if (!files["xl/calcChain.xml"]) return;
  delete files["xl/calcChain.xml"];
  if (files["[Content_Types].xml"]) {
    writeText(
      files,
      "[Content_Types].xml",
      readText(files, "[Content_Types].xml").replace(
        /<Override\b[^>]*PartName="\/xl\/calcChain\.xml"[^>]*\/>/,
        "",
      ),
    );
  }
  const relsPath = "xl/_rels/workbook.xml.rels";
  if (files[relsPath]) {
    writeText(
      files,
      relsPath,
      readText(files, relsPath).replace(/<Relationship\b[^>]*Target="calcChain\.xml"[^>]*\/>/, ""),
    );
  }
}

// 특정 시트의 차트/그림만 제거(시트는 유지). 종합 시트 그래프 2개 제외 등.
// 시트의 <drawing> 참조 + 그 시트가 단독 참조하는 drawing/chart 파트 + Content_Types Override 정리.
export function removeSheetDrawing(files: ZipFiles, sheetPartPath: string): void {
  let xml = readText(files, sheetPartPath);
  if (!/<drawing\b/.test(xml)) return;
  xml = xml.replace(/<drawing\b[^>]*\/>/g, "");
  writeText(files, sheetPartPath, xml);

  const name = sheetPartPath.replace(/^xl\/worksheets\//, "");
  const relsPath = `xl/worksheets/_rels/${name}.rels`;
  if (!files[relsPath]) return;

  const parts: string[] = [];
  const sr = readText(files, relsPath);
  for (const m of sr.matchAll(/Target="([^"]+)"/g)) {
    const dpath = normalizeXlPath(m[1], "xl/worksheets");
    parts.push(dpath);
    const drel = dpath.replace(/([^/]+)$/, "_rels/$1.rels");
    if (files[drel]) {
      const dr = readText(files, drel);
      for (const dm of dr.matchAll(/Target="([^"]+)"/g)) {
        parts.push(normalizeXlPath(dm[1], dpath.replace(/\/[^/]+$/, "")));
      }
      parts.push(drel);
    }
  }
  parts.push(relsPath);

  let ct = readText(files, "[Content_Types].xml");
  for (const p of parts) {
    delete files[p];
    ct = ct.replace(new RegExp(`<Override\\b[^>]*PartName="/${escapeRe(p)}"[^>]*/>`), "");
  }
  writeText(files, "[Content_Types].xml", ct);
}

// ── 동적 행 생성 (가변형 시트: 캠페인별·키워드. 차트 없고 시트 끝까지라 안전) ──

export type CellValue = number | string | null; // null = 빈 셀(스타일만 유지)

// 양식 표본 행에서 열별 스타일 속성(` s="5"`)을 떠온다 — s 인덱스 하드코딩 회피.
export function harvestRowStyles(xml: string, rowNum: number): Record<string, string> {
  const m = xml.match(new RegExp(`<row r="${rowNum}"[^>]*>([\\s\\S]*?)</row>`));
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const c of m[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const sm = c[2].match(/\ss="(\d+)"/);
    out[c[1]] = sm ? ` s="${sm[1]}"` : "";
  }
  return out;
}

// 한 행 XML 생성. cols 순서대로, values[col]에 따라 숫자/문자/빈 셀.
export function buildRow(
  rowNum: number,
  cols: string[],
  styles: Record<string, string>,
  values: Record<string, CellValue>,
): string {
  const cells = cols.map((col) => {
    const s = styles[col] ?? "";
    const v = values[col];
    if (v == null) return `<c r="${col}${rowNum}"${s}/>`;
    if (typeof v === "number")
      return `<c r="${col}${rowNum}"${s}><v>${Number.isFinite(v) ? v : 0}</v></c>`;
    return `<c r="${col}${rowNum}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(v)}</t></is></c>`;
  });
  return `<row r="${rowNum}" spans="1:${cols.length + 1}">${cells.join("")}</row>`;
}

function escapeXmlText(s: string): string {
  return escapeXml(s);
}

// fromRow 이상의 모든 행을 제거하고 newRows를 sheetData 끝에 붙인다.
export function replaceRowsFrom(xml: string, fromRow: number, newRows: string[]): string {
  const sdM = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sdM) return xml;
  let body = sdM[1].replace(
    /<row r="(\d+)"[^>]*>[\s\S]*?<\/row>/g,
    (full, r) => (Number(r) >= fromRow ? "" : full),
  );
  // 자기닫힘 <row .../> 형태도 제거
  body = body.replace(/<row r="(\d+)"[^>]*\/>/g, (full, r) =>
    Number(r) >= fromRow ? "" : full,
  );
  body += newRows.join("");
  const result = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${body}</sheetData>`);
  return updateDimension(result);
}

// 행 범위를 진짜 삭제(아래 행 당겨 올림). 행번호·셀ref·수식ref·mergeCells 모두 이동.
// 차트 c:f / 그림 앵커는 별도(shiftChartRowRefs/shiftDrawingRowAnchors)로 맞춰야 함.
export function deleteRows(xml: string, from: number, to: number): string {
  const delta = to - from + 1;
  const sdM = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sdM) return xml;
  const out: string[] = [];
  // [^>]*? non-greedy: self-closing 빈 행(<row .../>)에서 `/`를 먹어 \/> 분기를 놓치고
  // 다음 행까지 삼키는 것 방지(sheet8 차트 자리 빈행에서 발생). sheet4 일반 행엔 영향 없음.
  for (const m of sdM[1].matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)) {
    const r = Number(m[1]);
    if (r >= from && r <= to) continue; // 삭제
    if (r > to) {
      const nr = r - delta;
      let s = m[0]
        .replace(/^<row r="\d+"/, `<row r="${nr}"`)
        .replace(/<c r="([A-Z]+)\d+"/g, (_c, col) => `<c r="${col}${nr}"`)
        .replace(/<f>([\s\S]*?)<\/f>/g, (_f, body) =>
          `<f>${body.replace(/([A-Z]+)(\d+)/g, (mm: string, col: string, row: string) =>
            Number(row) > to ? `${col}${Number(row) - delta}` : mm,
          )}</f>`,
        );
      out.push(s);
    } else {
      out.push(m[0]);
    }
  }
  let result = xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${out.join("")}</sheetData>`);
  // mergeCells 이동/삭제
  result = result.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, (block) => {
    const kept: string[] = [];
    for (const mm of block.matchAll(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\/>/g)) {
      let r1 = Number(mm[2]), r2 = Number(mm[4]);
      if (r1 >= from && r2 <= to) continue;
      if (r1 > to) r1 -= delta;
      if (r2 > to) r2 -= delta;
      kept.push(`<mergeCell ref="${mm[1]}${r1}:${mm[3]}${r2}"/>`);
    }
    return kept.length ? `<mergeCells count="${kept.length}">${kept.join("")}</mergeCells>` : "";
  });
  return updateDimension(result);
}

// 차트 c:f의 행 참조를 afterRow 초과분에 대해 -delta 이동.
export function shiftChartRowRefs(files: ZipFiles, chartPath: string, afterRow: number, delta: number): void {
  if (!files[chartPath]) return;
  const x = readText(files, chartPath).replace(/<c:f>([^<]*)<\/c:f>/g, (_m, ref) =>
    `<c:f>${ref.replace(/(\$?[A-Z]+\$?)(\d+)/g, (mm: string, col: string, row: string) =>
      Number(row) > afterRow ? `${col}${Number(row) - delta}` : mm,
    )}</c:f>`,
  );
  writeText(files, chartPath, x);
}

// 그림(drawing) 앵커의 <xdr:row>를 afterRow 초과분에 대해 -delta 이동.
export function shiftDrawingRowAnchors(files: ZipFiles, drawingPath: string, afterRow: number, delta: number): void {
  if (!files[drawingPath]) return;
  const x = readText(files, drawingPath).replace(/<xdr:row>(\d+)<\/xdr:row>/g, (full, r) =>
    Number(r) > afterRow ? `<xdr:row>${Number(r) - delta}</xdr:row>` : full,
  );
  writeText(files, drawingPath, x);
}

// sheetData 끝에 행 추가(기존 행 유지). 시트 맨 아래 새 섹션 붙일 때.
export function appendRows(xml: string, newRows: string[]): string {
  if (newRows.length === 0) return xml;
  const result = xml.replace(/<\/sheetData>/, `${newRows.join("")}</sheetData>`);
  return updateDimension(result);
}

// 차트의 특정 색 HEX를 교체(예: 성별 도넛 여성 92D050 → F67676).
export function replaceChartColor(files: ZipFiles, chartPath: string, fromHex: string, toHex: string): void {
  if (!files[chartPath]) return;
  writeText(files, chartPath, readText(files, chartPath).split(fromHex).join(toHex));
}

// 특정 차트 하나만 시트 그림에서 제거(다른 차트 유지). chartFile 예: "chart4.xml".
export function removeChartFromDrawing(files: ZipFiles, drawingPath: string, chartFile: string): void {
  const relsPath = drawingPath.replace(/([^/]+)$/, "_rels/$1.rels");
  if (!files[drawingPath] || !files[relsPath]) return;
  const rels = readText(files, relsPath);
  let rId = "";
  for (const m of rels.matchAll(/<Relationship\b[^>]*\/>/g)) {
    if (m[0].includes(chartFile)) rId = (m[0].match(/Id="([^"]+)"/) ?? [])[1] ?? "";
  }
  if (!rId) return;
  // drawing: rId를 포함한 twoCellAnchor 블록 제거(블록 단위로 개별 검사)
  const d = readText(files, drawingPath).replace(
    /<xdr:twoCellAnchor\b[\s\S]*?<\/xdr:twoCellAnchor>/g,
    (block) => (block.includes(`r:id="${rId}"`) ? "" : block),
  );
  writeText(files, drawingPath, d);
  // rels에서 관계 제거
  writeText(files, relsPath, rels.replace(new RegExp(`<Relationship\\b[^>]*Id="${rId}"[^>]*\\/>`), ""));
  // 차트 파트 + content-types override 제거
  const chartPath = "xl/charts/" + chartFile;
  delete files[chartPath];
  if (files["[Content_Types].xml"]) {
    writeText(
      files,
      "[Content_Types].xml",
      readText(files, "[Content_Types].xml").replace(
        new RegExp(`<Override\\b[^>]*PartName="/${escapeRe(chartPath)}"[^>]*\\/>`),
        "",
      ),
    );
  }
}

// <dimension ref="B2:P16">의 끝 행을 실제 최대 행에 맞춘다. 행 수가 선언 범위를 벗어나면
// 엑셀이 "복구하시겠습니까?" 대화상자를 띄우므로 필수.
export function updateDimension(xml: string): string {
  const rows = [...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1]));
  if (rows.length === 0) return xml;
  const maxRow = Math.max(...rows);
  return xml.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)\d+("\s*\/>)/, `$1${maxRow}$2`);
}

// 행 숨김 (종합 매체별 디스플레이 행 등 — 차트는 plotVisOnly=1이라 숨김행 자동 제외).
export function setRowHidden(xml: string, rowNum: number): string {
  return xml.replace(new RegExp(`<row r="${rowNum}"([^>]*?)>`), (full, a) =>
    /\shidden=/.test(a) ? full : `<row r="${rowNum}"${a} hidden="1">`,
  );
}

// 기존 셀 스타일(cellXfs의 baseIdx)을 복제해 정렬을 추가한 새 스타일 인덱스 반환.
// 세로는 항상 가운데(병합 셀 대비), 가로는 horizontal 인자(기본 가운데). 병합 셀(캠페인/그룹)을
// "병합하고 가운데/왼쪽 맞춤"으로 보이게 하는 데 사용.
export function addCenteredStyle(files: ZipFiles, baseIdx: number, horizontal: "center" | "left" = "center"): number {
  let styles = readText(files, "xl/styles.xml");
  const cxM = styles.match(/<cellXfs count="(\d+)">([\s\S]*?)<\/cellXfs>/);
  if (!cxM) return baseIdx;
  const count = Number(cxM[1]);
  const xfs = cxM[2].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) ?? [];
  const base = xfs[baseIdx];
  if (!base) return baseIdx;
  const openAttrs = (base.match(/^<xf\b([^>]*?)\/?>/) ?? ["", ""])[1].replace(
    /\sapplyAlignment="[^"]*"/g,
    "",
  );
  const newXf = `<xf${openAttrs} applyAlignment="1"><alignment horizontal="${horizontal}" vertical="center"/></xf>`;
  styles = styles.replace(
    /<cellXfs count="\d+">([\s\S]*?)<\/cellXfs>/,
    (_m, body) => `<cellXfs count="${count + 1}">${body}${newXf}</cellXfs>`,
  );
  writeText(files, "xl/styles.xml", styles);
  return count;
}

// 지정 셀들의 스타일을 '가로·세로 가운데 정렬' 변형으로 교체. 기존 스타일별 centered 변형을
// 캐시 재사용해 중복 스타일 폭증을 막는다(고정 시트의 일자/성별/연령 표 가운데정렬용).
export function centerCells(files: ZipFiles, sheetPath: string, addrs: string[]): void {
  let xml = readText(files, sheetPath);
  const cache = new Map<number, number>();
  const centeredFor = (base: number): number => {
    let c = cache.get(base);
    if (c == null) { c = addCenteredStyle(files, base); cache.set(base, c); }
    return c;
  };
  for (const addr of addrs) {
    const re = new RegExp(`<c r="${addr}"([^>]*?)(/?)>`);
    const m = xml.match(re);
    if (!m) continue;
    const attrs = m[1];
    const base = Number((attrs.match(/\ss="(\d+)"/) ?? [])[1] ?? 0);
    const idx = centeredFor(base);
    const newAttrs = /\ss="\d+"/.test(attrs)
      ? attrs.replace(/\ss="\d+"/, ` s="${idx}"`)
      : `${attrs} s="${idx}"`;
    xml = xml.replace(re, `<c r="${addr}"${newAttrs}${m[2]}>`);
  }
  writeText(files, sheetPath, xml);
}

// 열 너비 설정(letter→width). 기존 <cols> 너비는 유지하고 지정 열만 덮어씀.
function colLetterToNum(c: string): number {
  let n = 0;
  for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function setColumnWidths(xml: string, widths: Record<string, number>): string {
  const targets = new Map<number, number>();
  for (const [c, w] of Object.entries(widths)) targets.set(colLetterToNum(c), w);
  const colsM = xml.match(/<cols>([\s\S]*?)<\/cols>/);
  const out: { min: number; tag: string }[] = [];
  const emit = (min: number, max: number, widthAttr: string | undefined, extra: string) => {
    if (min > max) return;
    out.push({ min, tag: `<col min="${min}" max="${max}"${widthAttr ? ` width="${widthAttr}"` : ""}${extra}/>` });
  };
  const existingW = new Map<number, number>(); // 대상 열의 기존 너비(여러 번 적용 시 max 병합)
  if (colsM) {
    // 기존 <col> 범위를 대상 열 주위로 분할(범위를 개별로 펼치지 않음 — max=16384 폭증 방지).
    for (const m of colsM[1].matchAll(/<col\b[^>]*\/>/g)) {
      const t = m[0];
      const mn = Number((t.match(/min="(\d+)"/) ?? [])[1]);
      const mx = Number((t.match(/max="(\d+)"/) ?? [])[1]) || mn;
      if (!mn) continue;
      const w = (t.match(/width="([\d.]+)"/) ?? [])[1];
      const custom = /customWidth="1"/.test(t) ? ` customWidth="1"` : "";
      const styleM = t.match(/style="(\d+)"/);
      const hidden = /hidden="1"/.test(t) ? ` hidden="1"` : "";
      const extra = custom + (styleM ? ` style="${styleM[1]}"` : "") + hidden;
      let cur = mn;
      for (const k of [...targets.keys()].filter((k) => k >= mn && k <= mx).sort((a, b) => a - b)) {
        emit(cur, k - 1, w, extra);
        if (w) existingW.set(k, Number(w));
        cur = k + 1;
      }
      emit(cur, mx, w, extra);
    }
  }
  for (const [i, w] of targets) {
    const finalW = Math.max(w, existingW.get(i) ?? 0); // 기존(이전 적용분) 대비 큰 값 유지
    out.push({ min: i, tag: `<col min="${i}" max="${i}" width="${finalW.toFixed(2)}" customWidth="1"/>` });
  }
  out.sort((a, b) => a.min - b.min);
  const block = `<cols>${out.map((o) => o.tag).join("")}</cols>`;
  if (colsM) return xml.replace(/<cols>[\s\S]*?<\/cols>/, block);
  return out.length ? xml.replace(/<sheetData>/, `${block}<sheetData>`) : xml;
}

// 행 범위 숨김 (from~to 포함). 존재하는 행만 처리.
export function hideRowRange(xml: string, from: number, to: number): string {
  let out = xml;
  for (let r = from; r <= to; r++) out = setRowHidden(out, r);
  return out;
}

// 행 범위를 확실히 접는다(빈/생략 행 포함). 범위 내 기존 행을 제거하고 숨김 빈 행으로 대체 →
// sheetData에 없던 빈 행(차트 자리 등)도 0높이로 collapse. 행 번호는 안 밀림.
export function collapseRows(xml: string, from: number, to: number): string {
  const sdM = xml.match(/<sheetData>([\s\S]*?)<\/sheetData>/);
  if (!sdM) return xml;
  const kept = [...sdM[1].matchAll(/<row r="(\d+)"[^>]*(?:\/>|>[\s\S]*?<\/row>)/g)]
    .map((m) => ({ r: Number(m[1]), s: m[0] }))
    .filter((x) => x.r < from || x.r > to);
  for (let r = from; r <= to; r++) kept.push({ r, s: `<row r="${r}" hidden="1"/>` });
  kept.sort((a, b) => a.r - b.r);
  return xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, `<sheetData>${kept.map((x) => x.s).join("")}</sheetData>`);
}

// mergeCells 블록 교체(없으면 sheetData 뒤에 삽입). refs 비면 블록 제거.
export function setMergeCells(xml: string, refs: string[]): string {
  const block =
    refs.length === 0
      ? ""
      : `<mergeCells count="${refs.length}">${refs
          .map((r) => `<mergeCell ref="${r}"/>`)
          .join("")}</mergeCells>`;
  if (/<mergeCells[\s\S]*?<\/mergeCells>/.test(xml)) {
    return xml.replace(/<mergeCells[\s\S]*?<\/mergeCells>/, block);
  }
  if (block) return xml.replace(/<\/sheetData>/, `</sheetData>${block}`);
  return xml;
}

// "../charts/chart1.xml" 같은 상대 경로를 base 기준으로 "xl/charts/chart1.xml"로 정규화.
function normalizeXlPath(target: string, baseDir: string): string {
  if (target.startsWith("/")) return target.replace(/^\//, "");
  const parts = (baseDir + "/" + target).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else if (p !== "." && p !== "") stack.push(p);
  }
  return stack.join("/");
}
