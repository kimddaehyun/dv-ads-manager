// F-Report 가변형 시트 렌더러 — 행 수가 계정마다 다른 시트를 동적 생성.
//
// 대상: 파워링크_키워드(sheet5), 쇼핑검색_키워드(sheet6), 검색광고 캠페인별(sheet3 섹션2).
// 이 시트들은 차트가 없고 가변 영역이 시트 끝까지라, "특정 행부터 끝까지 갈아끼우기"로 안전하게
// 재생성한다. 스타일은 양식 표본 행에서 런타임에 떠온다(harvestRowStyles).
//
// 소계/합계는 수식 대신 집계 숫자를 직접 넣는다(데이터를 우리가 가지고 있으므로 더 단순·정확).

import {
  readText,
  writeText,
  setString,
  harvestRowStyles,
  buildRow,
  replaceRowsFrom,
  setMergeCells,
  setColumnWidths,
  addCenteredStyle,
  appendRows,
  deleteRows,
  removeChartFromDrawing,
  shiftChartRowRefs,
  shiftDrawingRowAnchors,
  type ZipFiles,
  type CellValue,
} from "./report-excel";
import {
  metricValues, addMetrics, ZERO_METRICS, visualLen, widthFor, metricStr, METRIC_HEADERS,
  type ReportMetrics,
} from "./report-data";

export interface KeywordRow {
  keyword: string;
  metrics: ReportMetrics;
}
export interface KeywordGroup {
  campaign: string;
  group: string;
  keywords: KeywordRow[];
}

// 키워드 시트 열: B캠페인 C그룹 D키워드 + E~P(12지표)
const KW_LABEL_COLS = ["B", "C", "D"];
const KW_METRIC_COLS = ["E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];
const KW_COLS = [...KW_LABEL_COLS, ...KW_METRIC_COLS];

function metricCells(cols: string[], m: ReportMetrics): Record<string, CellValue> {
  const vals = metricValues(m);
  const out: Record<string, CellValue> = {};
  cols.forEach((c, i) => (out[c] = vals[i]));
  return out;
}

// 파워링크_키워드 / 쇼핑검색_키워드 공통 렌더.
// 양식 표본 행: 4=그룹 첫 데이터행, 5=후속 데이터행, 7=소계행, 16=전체합계행(B:D 병합).
export function renderKeywordSheet(
  files: ZipFiles,
  sheetPath: string,
  groups: KeywordGroup[],
  title?: string, // 제목(B2) 교체 — 미지정 시 양식 원본 유지
): void {
  let xml = readText(files, sheetPath);
  if (title) xml = setString(xml, "B2", title);
  const sFirst = harvestRowStyles(xml, 4); // 데이터행(표본). 파워링크/쇼핑 모두 첫행=후속행 동일 스타일.
  const sSubtotal = harvestRowStyles(xml, 7);
  // 전체합계 행은 시트마다 위치가 다름(파워링크 16 / 쇼핑검색 11) — B?:D? 병합으로 자동 탐지.
  const totalM = xml.match(/<mergeCell ref="B(\d+):D\1"\/>/);
  const sTotal = harvestRowStyles(xml, totalM ? Number(totalM[1]) : 16);

  // 캠페인(B)/그룹(C) 셀: 그룹 데이터행을 세로 병합 + 가운데 정렬. 표본 B/C 스타일 복제.
  const baseB = Number((sFirst.B?.match(/s="(\d+)"/) ?? [])[1] ?? 0);
  const baseC = Number((sFirst.C?.match(/s="(\d+)"/) ?? [])[1] ?? 0);
  const cB = ` s="${addCenteredStyle(files, baseB)}"`;
  const cC = ` s="${addCenteredStyle(files, baseC)}"`;
  const dataStyle = { ...sFirst, B: cB, C: cC };

  // 열 너비 추적 (헤더 + 모든 셀 내용 최대치)
  const KW_HEADERS: Record<string, string> = {
    B: "캠페인", C: "그룹", D: "키워드", E: "노출", F: "클릭", G: "클릭률", H: "CPC",
    I: "총비용", J: "구매완료", K: "전환율", L: "전환당비용", M: "매출액", N: "ROAS",
    O: "직접 전환수", P: "간접 전환수",
  };
  const wmax: Record<string, number> = {};
  for (const c of KW_COLS) wmax[c] = visualLen(KW_HEADERS[c] ?? "");
  const noteText = (col: string, s: string) => { wmax[col] = Math.max(wmax[col] ?? 0, visualLen(s)); };
  const noteMetrics = (m: ReportMetrics) => {
    const vals = metricValues(m);
    KW_METRIC_COLS.forEach((c, i) => noteText(c, metricStr(i, vals[i])));
  };

  const rows: string[] = [];
  const merges = ["B2:P2"]; // 제목 병합 유지
  let r = 4;
  let grand = ZERO_METRICS;

  for (const g of groups) {
    if (g.keywords.length === 0) continue;
    const r0 = r;
    let groupSum = ZERO_METRICS;
    g.keywords.forEach((kw, i) => {
      if (i === 0) { noteText("B", g.campaign); noteText("C", g.group); }
      noteText("D", kw.keyword);
      noteMetrics(kw.metrics);
      const v: Record<string, CellValue> = {
        B: i === 0 ? g.campaign : null,
        C: i === 0 ? g.group : null,
        D: kw.keyword,
        ...metricCells(KW_METRIC_COLS, kw.metrics),
      };
      rows.push(buildRow(r++, KW_COLS, dataStyle, v));
      groupSum = addMetrics(groupSum, kw.metrics);
    });
    const r1 = r - 1;
    if (r1 > r0) merges.push(`B${r0}:B${r1}`, `C${r0}:C${r1}`); // 캠페인/그룹 세로 병합
    // 소계
    noteText("C", g.group);
    noteMetrics(groupSum);
    rows.push(
      buildRow(r++, KW_COLS, sSubtotal, {
        B: null,
        C: g.group,
        D: "소계",
        ...metricCells(KW_METRIC_COLS, groupSum),
      }),
    );
    grand = addMetrics(grand, groupSum);
  }
  noteMetrics(grand);

  // 전체 합계 (B:D 병합)
  merges.push(`B${r}:D${r}`);
  rows.push(
    buildRow(r, KW_COLS, sTotal, {
      B: "전체 합계",
      C: null,
      D: null,
      ...metricCells(KW_METRIC_COLS, grand),
    }),
  );

  xml = replaceRowsFrom(xml, 4, rows);
  xml = setMergeCells(xml, merges);
  const widths: Record<string, number> = {};
  for (const c of KW_COLS) widths[c] = widthFor(wmax[c]);
  xml = setColumnWidths(xml, widths);
  writeText(files, sheetPath, xml);
}

// ── 검색광고 캠페인별 성과 (sheet3 섹션2, 차트 없음) ──
// 열: B유형 C그룹 D~O(12지표). 표본행: 11첫데이터/12후속/14소계/27전체합계(B:C 병합).
// 섹션1(주간요약 4~7행)은 report-fill이 채우므로 11행부터 재생성(이상 행만 교체).
const CAMP_LABEL_COLS = ["B", "C"];
const CAMP_METRIC_COLS = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];
const CAMP_COLS = [...CAMP_LABEL_COLS, ...CAMP_METRIC_COLS];

export interface CampaignTypeGroup {
  type: string; // 파워링크/쇼핑검색광고/...
  rows: { group: string; metrics: ReportMetrics }[];
}

export function renderCampaignSheet(
  files: ZipFiles,
  sheetPath: string,
  groups: CampaignTypeGroup[],
): void {
  let xml = readText(files, sheetPath);
  // 헤더(행 10) 라벨 변경: 캠페인 → 캠페인 유형, 그룹 → 캠페인 (B열=유형, C열=광고그룹 데이터는 그대로)
  xml = setString(xml, "B10", "캠페인 유형");
  xml = setString(xml, "C10", "캠페인");
  const sFirst = harvestRowStyles(xml, 11);
  const sSubtotal = harvestRowStyles(xml, 14);
  const sTotal = harvestRowStyles(xml, 27);

  // 캠페인(B)/그룹(C) 가운데 정렬 — 데이터행·소계행 각각 스타일 복제. B는 유형별 세로 병합.
  const ci = (st: Record<string, string>, col: string) =>
    ` s="${addCenteredStyle(files, Number((st[col]?.match(/s="(\d+)"/) ?? [])[1] ?? 0))}"`;
  const dataStyle = { ...sFirst, B: ci(sFirst, "B"), C: ci(sFirst, "C") };
  const subStyle = { ...sSubtotal, B: ci(sSubtotal, "B"), C: ci(sSubtotal, "C") };

  const CAMP_HEADERS: Record<string, string> = {
    B: "캠페인 유형", C: "캠페인", D: "노출", E: "클릭", F: "클릭률", G: "CPC", H: "총비용",
    I: "구매완료", J: "전환율", K: "전환당비용", L: "매출액", M: "ROAS", N: "직접 전환수", O: "간접 전환수",
  };
  const wmax: Record<string, number> = {};
  for (const c of CAMP_COLS) wmax[c] = visualLen(CAMP_HEADERS[c] ?? "");
  const noteText = (col: string, s: string) => { wmax[col] = Math.max(wmax[col] ?? 0, visualLen(s)); };
  const noteMetrics = (m: ReportMetrics) => {
    const vals = metricValues(m);
    CAMP_METRIC_COLS.forEach((c, i) => noteText(c, metricStr(i, vals[i])));
  };

  const rows: string[] = [];
  const merges = ["B2:N2", "B9:O9"];
  let r = 11;
  let grand = ZERO_METRICS;

  for (const g of groups) {
    if (g.rows.length === 0) continue;
    noteText("B", g.type);
    const r0 = r;
    g.rows.forEach((gr, i) => {
      noteText("C", gr.group);
      noteMetrics(gr.metrics);
      rows.push(
        buildRow(r++, CAMP_COLS, dataStyle, {
          B: i === 0 ? g.type : null,
          C: gr.group,
          ...metricCells(CAMP_METRIC_COLS, gr.metrics),
        }),
      );
    });
    let typeSum = ZERO_METRICS;
    for (const gr of g.rows) typeSum = addMetrics(typeSum, gr.metrics);
    noteMetrics(typeSum);
    rows.push(
      buildRow(r++, CAMP_COLS, subStyle, {
        B: null,
        C: "소계",
        ...metricCells(CAMP_METRIC_COLS, typeSum),
      }),
    );
    merges.push(`B${r0}:B${r - 1}`); // 캠페인(유형) 데이터+소계 세로 병합
    grand = addMetrics(grand, typeSum);
  }
  noteMetrics(grand);

  merges.push(`B${r}:C${r}`);
  rows.push(
    buildRow(r, CAMP_COLS, sTotal, {
      B: "전체 합계",
      C: null,
      ...metricCells(CAMP_METRIC_COLS, grand),
    }),
  );

  xml = replaceRowsFrom(xml, 11, rows);
  xml = setMergeCells(xml, merges);
  const widths: Record<string, number> = {};
  for (const c of CAMP_COLS) widths[c] = widthFor(wmax[c]);
  xml = setColumnWidths(xml, widths);
  writeText(files, sheetPath, xml);
}

// ── 종합 캠페인 유형별 요약 (sheet2 섹션3, 차트 없음) ──
// 안 쓰는 유형 행을 빼서 재생성. 열: B라벨 C~N(12지표). 표본행: 31유형/44검색소계/45디스플레이소계/46전체합계.
// 종합 시트의 기존 병합(B2/B16/B23/B29)을 보존해야 하므로 setMergeCells 호출 안 함(새 병합 없음).
const TYPE_LABEL_COLS = ["B"];
const TYPE_METRIC_COLS = ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
const TYPE_COLS = [...TYPE_LABEL_COLS, ...TYPE_METRIC_COLS];

export interface SummaryType {
  label: string;
  metrics: ReportMetrics;
}

export function renderSummaryTypes(
  files: ZipFiles,
  searchTypes: SummaryType[],
  displayTypes: SummaryType[],
): void {
  const path = "xl/worksheets/sheet2.xml";
  let xml = readText(files, path);
  const sType = harvestRowStyles(xml, 31);
  const sSearchSub = harvestRowStyles(xml, 44);
  const sDisplaySub = harvestRowStyles(xml, 45);
  const sTotal = harvestRowStyles(xml, 46);

  const rows: string[] = [];
  let r = 31;
  let grand = ZERO_METRICS;

  // dashConv=true면 직접(M)/간접(N) 전환 칸을 '-'로 (디스플레이는 직간접 데이터 없음)
  const cellsFor = (m: ReportMetrics, dashConv: boolean): Record<string, CellValue> => {
    const cells = metricCells(TYPE_METRIC_COLS, m);
    if (dashConv) { cells.M = "-"; cells.N = "-"; }
    return cells;
  };
  const emitTypes = (types: SummaryType[], subLabel: string, subStyle: Record<string, string>, dashConv: boolean) => {
    if (types.length === 0) return;
    let sum = ZERO_METRICS;
    for (const t of types) {
      rows.push(buildRow(r++, TYPE_COLS, sType, { B: t.label, ...cellsFor(t.metrics, dashConv) }));
      sum = addMetrics(sum, t.metrics);
    }
    rows.push(buildRow(r++, TYPE_COLS, subStyle, { B: subLabel, ...cellsFor(sum, dashConv) }));
    grand = addMetrics(grand, sum);
  };

  emitTypes(searchTypes, "검색광고 소계", sSearchSub, false);
  emitTypes(displayTypes, "디스플레이 소계", sDisplaySub, true);
  rows.push(buildRow(r, TYPE_COLS, sTotal, { B: "전체 합계", ...metricCells(TYPE_METRIC_COLS, grand) }));

  xml = replaceRowsFrom(xml, 31, rows);
  writeText(files, path, xml);
}

// ── 검색_상세 지면별 (sheet4) — 맨 아래로 이동 + 동적(노출된 모든 지면) ──
// 옛 지면 섹션(행 24~57, 지면 그래프 자리 포함)을 진짜 삭제 → 성별/연령(58~)을 위로 당김(한 칸만 띄움).
// 지면 그래프(chart4)는 제거, 성별/연령 그래프(chart5/6)는 데이터·앵커를 -34행 이동해 유지.
// 표본 스타일은 삭제 전에 떠둔다: 24=타이틀 / 48=헤더 / 49=데이터 / 56=합계.
const DETAIL_PLACEMENT_COLS = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
const DETAIL_METRIC_COLS = ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];

export interface PlacementRow {
  label: string;
  metrics: ReportMetrics;
}

export function renderDetailPlacement(files: ZipFiles, placements: PlacementRow[]): void {
  const path = "xl/worksheets/sheet4.xml";
  const DRAWING = "xl/drawings/drawing2.xml";
  const DEL_FROM = 24, DEL_TO = 57, DELTA = DEL_TO - DEL_FROM + 1; // 34

  // 1) 삭제 전에 지면 표본 스타일 확보
  let xml = readText(files, path);
  const sTitle = harvestRowStyles(xml, 24);
  const sHeader = harvestRowStyles(xml, 48);
  const sData = harvestRowStyles(xml, 49);
  const sTotal = harvestRowStyles(xml, 56);

  // 2) 지면 그래프(chart4) 제거 → 3) 옛 지면 영역 진짜 삭제(아래 당겨 올림)
  removeChartFromDrawing(files, DRAWING, "chart4.xml");
  xml = deleteRows(xml, DEL_FROM, DEL_TO);
  writeText(files, path, xml);

  // 4) 성별/연령 그래프(chart5/6) 데이터 ref + 앵커를 -DELTA 이동(일자 chart3는 24행 미만이라 무영향)
  shiftChartRowRefs(files, "xl/charts/chart5.xml", DEL_TO, DELTA);
  shiftChartRowRefs(files, "xl/charts/chart6.xml", DEL_TO, DELTA);
  shiftDrawingRowAnchors(files, DRAWING, DEL_TO, DELTA);

  // 5) 맨 아래에 지면 섹션 새로 생성(노출된 지면, 총비용순)
  xml = readText(files, path);
  const maxRow = Math.max(0, ...[...xml.matchAll(/<row r="(\d+)"/g)].map((m) => Number(m[1])));
  let r = maxRow + 2; // 한 칸 띄우고
  const rows: string[] = [];
  const newMerges: string[] = [];

  const wmax: Record<string, number> = { B: visualLen("광고영역") };
  DETAIL_METRIC_COLS.forEach((c, i) => (wmax[c] = visualLen(METRIC_HEADERS[i])));
  const noteMetrics = (m: ReportMetrics) => {
    const vals = metricValues(m);
    DETAIL_METRIC_COLS.forEach((c, i) => (wmax[c] = Math.max(wmax[c], visualLen(metricStr(i, vals[i])))));
  };

  const titleRow = r++;
  rows.push(buildRow(titleRow, ["B"], { B: sTitle.B ?? "" }, { B: "지면별 성과" }));
  newMerges.push(`B${titleRow}:N${titleRow}`);

  const headerVals: Record<string, CellValue> = { B: "광고영역" };
  DETAIL_METRIC_COLS.forEach((c, i) => (headerVals[c] = METRIC_HEADERS[i]));
  rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sHeader, headerVals));

  let total = ZERO_METRICS;
  for (const p of placements) {
    wmax.B = Math.max(wmax.B, visualLen(p.label));
    noteMetrics(p.metrics);
    const v: Record<string, CellValue> = { B: p.label };
    metricValues(p.metrics).forEach((val, i) => (v[DETAIL_METRIC_COLS[i]] = val));
    rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sData, v));
    total = addMetrics(total, p.metrics);
  }

  noteMetrics(total);
  const tv: Record<string, CellValue> = { B: "합계" };
  metricValues(total).forEach((val, i) => (tv[DETAIL_METRIC_COLS[i]] = val));
  rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sTotal, tv));

  xml = appendRows(xml, rows);
  const existing = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
  xml = setMergeCells(xml, [...existing, ...newMerges]);
  const widths: Record<string, number> = {};
  for (const c of DETAIL_PLACEMENT_COLS) widths[c] = widthFor(wmax[c]);
  xml = setColumnWidths(xml, widths);
  writeText(files, path, xml);
}
