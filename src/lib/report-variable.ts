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
// 표본행(11/소계/합계)의 지표 스타일은 항상 D~O(12개)에 있다 — 거기서 떠와 실제 배치로 옮긴다.
// 섹션1(주간요약 4~7행)은 report-fill이 채우므로 11행부터 재생성(이상 행만 교체).
const CAMP_SAMPLE_METRIC_COLS = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];

export interface CampaignTypeGroup {
  type: string; // 파워링크/쇼핑검색광고/...
  rows: { campaign?: string; group: string; metrics: ReportMetrics }[]; // campaign은 withGroup일 때만
}

// 시트별 표본 행 위치. 검색광고(sheet3)=14/27, 디스플레이(sheet7)=13/35.
// dashConv=true면 직접/간접 전환(마지막 2개 지표열)을 '-'로 (디스플레이는 split 없음).
// withGroup=true면 [유형|캠페인|그룹|지표(E~P)] 3단계 + 같은 캠페인 세로병합 (검색광고).
// false면 [유형|캠페인|지표(D~O)] 2단계 (디스플레이는 캠페인 단위라 그룹 없음).
export interface CampaignSheetLayout {
  subtotalSampleRow: number;
  totalSampleRow: number;
  dashConv?: boolean;
  withGroup?: boolean;
}
const SEARCH_CAMPAIGN_LAYOUT: CampaignSheetLayout = { subtotalSampleRow: 14, totalSampleRow: 27, withGroup: true };
export const DISPLAY_CAMPAIGN_LAYOUT: CampaignSheetLayout = { subtotalSampleRow: 13, totalSampleRow: 35, dashConv: true };

export function renderCampaignSheet(
  files: ZipFiles,
  sheetPath: string,
  groups: CampaignTypeGroup[],
  layout: CampaignSheetLayout = SEARCH_CAMPAIGN_LAYOUT,
): void {
  let xml = readText(files, sheetPath);
  const withGroup = !!layout.withGroup;

  // 열 배치: withGroup이면 그룹 열 신설로 지표가 E~P로 한 칸 밀린다.
  const labelCols = withGroup ? ["B", "C", "D"] : ["B", "C"];
  const metricCols = withGroup
    ? ["E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"]
    : ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];
  // 검색광고(withGroup)만 표 오른쪽 끝에 색·테두리 없는 좁은 빈 간격 열 1개(Q) 추가.
  // 헤더 바(B9 병합)·컬럼 헤더는 지표 마지막(P)까지만, Q는 빈 셀로만 둬 여백처럼 보이게.
  const spacerCols = withGroup ? ["Q"] : [];
  const cols = [...labelCols, ...metricCols, ...spacerCols];
  const lastCol = metricCols[metricCols.length - 1]; // 지표 마지막(스페이서 제외) — 헤더바 병합 기준

  const sFirst = harvestRowStyles(xml, 11);
  const sSubtotal = harvestRowStyles(xml, layout.subtotalSampleRow);
  const sTotal = harvestRowStyles(xml, layout.totalSampleRow);

  // 표본행 지표 스타일(D~O)을 실제 배치(metricCols)로 이동. align=true면 유형(가운데)/캠페인·그룹(왼쪽)
  // 정렬 변형을 만들어 적용. 그룹(D) 텍스트 스타일은 캠페인(C) 것을 재사용한다.
  const ci = (st: Record<string, string>, col: string, h: "center" | "left") =>
    ` s="${addCenteredStyle(files, Number((st[col]?.match(/s="(\d+)"/) ?? [])[1] ?? 0), h)}"`;
  const styleFor = (st: Record<string, string>, align: boolean): Record<string, string> => {
    const out: Record<string, string> = {};
    out.B = align ? ci(st, "B", "center") : (st.B ?? "");
    out.C = align ? ci(st, "C", "left") : (st.C ?? "");
    if (withGroup) out.D = align ? ci(st, "C", "left") : (st.C ?? "");
    metricCols.forEach((mc, i) => { out[mc] = st[CAMP_SAMPLE_METRIC_COLS[i]] ?? ""; });
    return out;
  };
  const dataStyle = styleFor(sFirst, true);
  const subStyle = styleFor(sSubtotal, true);
  const totalStyle = styleFor(sTotal, false);

  // 헤더(행 10). withGroup이면 지표 라벨이 E~P로 밀리므로 행 전체 재구성(D10=그룹 신설).
  // 아니면 B/C 라벨만 교체(디스플레이는 지표 라벨이 양식 그대로 D~O).
  if (withGroup) {
    const headerStyle = styleFor(harvestRowStyles(xml, 10), false);
    const headerValues: Record<string, CellValue> = { B: "캠페인 유형", C: "캠페인", D: "그룹" };
    metricCols.forEach((mc, i) => { headerValues[mc] = METRIC_HEADERS[i]; });
    xml = xml.replace(/<row r="10"[^>]*>[\s\S]*?<\/row>/, buildRow(10, cols, headerStyle, headerValues));
  } else {
    xml = setString(xml, "B10", "캠페인 유형");
    xml = setString(xml, "C10", "캠페인");
  }

  const dashLast = (cells: Record<string, CellValue>): Record<string, CellValue> => {
    if (!layout.dashConv) return cells;
    const last2 = metricCols.slice(-2);
    return { ...cells, [last2[0]]: "-", [last2[1]]: "-" };
  };

  const headerLabel: Record<string, string> = { B: "캠페인 유형", C: "캠페인", D: "그룹" };
  const wmax: Record<string, number> = {};
  for (const c of labelCols) wmax[c] = visualLen(headerLabel[c] ?? "");
  metricCols.forEach((mc, i) => { wmax[mc] = visualLen(METRIC_HEADERS[i]); });
  const noteText = (col: string, s: string) => { wmax[col] = Math.max(wmax[col] ?? 0, visualLen(s)); };
  const noteMetrics = (m: ReportMetrics) => {
    const vals = metricValues(m);
    metricCols.forEach((c, i) => noteText(c, metricStr(i, vals[i])));
  };

  const rows: string[] = [];
  const merges = ["B2:N2", `B9:${lastCol}9`];
  let r = 11;
  let grand = ZERO_METRICS;

  for (const g of groups) {
    if (g.rows.length === 0) continue;
    noteText("B", g.type);
    const r0 = r;
    let campStart = r;          // 현재 캠페인 병합 시작행
    let campName: string | null = null;
    g.rows.forEach((gr, i) => {
      const values: Record<string, CellValue> = {
        B: i === 0 ? g.type : null,
        ...dashLast(metricCells(metricCols, gr.metrics)),
      };
      if (withGroup) {
        const camp = gr.campaign ?? "";
        if (i === 0 || camp !== campName) {
          if (campName !== null && r - 1 > campStart) merges.push(`C${campStart}:C${r - 1}`);
          campStart = r;
          campName = camp;
        }
        values.C = r === campStart ? camp : null; // 병합 top-left에만 캠페인명
        values.D = gr.group;
        noteText("C", camp);
        noteText("D", gr.group);
      } else {
        values.C = gr.group;
        noteText("C", gr.group);
      }
      noteMetrics(gr.metrics);
      rows.push(buildRow(r++, cols, dataStyle, values));
    });
    if (withGroup && campName !== null && r - 1 > campStart) merges.push(`C${campStart}:C${r - 1}`);

    let typeSum = ZERO_METRICS;
    for (const gr of g.rows) typeSum = addMetrics(typeSum, gr.metrics);
    noteMetrics(typeSum);
    const subValues: Record<string, CellValue> = {
      B: null, C: "소계", ...dashLast(metricCells(metricCols, typeSum)),
    };
    if (withGroup) subValues.D = null;
    rows.push(buildRow(r++, cols, subStyle, subValues));
    merges.push(`B${r0}:B${r - 1}`); // 유형 데이터+소계 세로 병합
    grand = addMetrics(grand, typeSum);
  }
  noteMetrics(grand);

  merges.push(`B${r}:${withGroup ? "D" : "C"}${r}`);
  const totalValues: Record<string, CellValue> = {
    B: "전체 합계", C: null, ...dashLast(metricCells(metricCols, grand)),
  };
  if (withGroup) totalValues.D = null;
  rows.push(buildRow(r, cols, totalStyle, totalValues));

  xml = replaceRowsFrom(xml, 11, rows);
  xml = setMergeCells(xml, merges);
  const widths: Record<string, number> = {};
  for (const c of [...labelCols, ...metricCols]) widths[c] = widthFor(wmax[c]);
  for (const c of spacerCols) widths[c] = 3; // 좁은 빈 간격
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

// ── 검색_상세(sheet4) / 디스플레이_상세(sheet8) 지면별 — 맨 아래로 이동 + 동적(노출된 모든 지면) ──
// 옛 지면 섹션(타이틀~지면 그래프 자리)을 진짜 삭제 → 성별/연령을 위로 당김(한 칸만 띄움).
// 지면 그래프는 제거, 성별/연령 그래프는 데이터·앵커를 -DELTA 이동해 유지.
// 표본 스타일은 삭제 전에 떠둔다(타이틀/헤더/데이터/합계 행).
const DETAIL_PLACEMENT_COLS = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
const DETAIL_METRIC_COLS = ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];

export interface PlacementRow {
  label: string;
  metrics: ReportMetrics;
}

// 시트별 지면 영역 레이아웃. delFrom~delTo = 삭제할 옛 지면 영역(지면 그래프 자리 포함, 성별 타이틀 직전까지).
export interface PlacementLayout {
  sheetPath: string;
  drawingPath: string;
  placeChart: string; // 제거할 지면 그래프 파일명 (예: "chart4.xml")
  shiftCharts: string[]; // 성별/연령 그래프 경로 — 데이터 ref/앵커 -DELTA 이동
  delFrom: number;
  delTo: number;
  titleRow: number;
  headerRow: number;
  dataRow: number;
  totalRow: number;
}

export const SEARCH_PLACEMENT: PlacementLayout = {
  sheetPath: "xl/worksheets/sheet4.xml",
  drawingPath: "xl/drawings/drawing2.xml",
  placeChart: "chart4.xml",
  shiftCharts: ["xl/charts/chart5.xml", "xl/charts/chart6.xml"],
  delFrom: 24, delTo: 57, titleRow: 24, headerRow: 48, dataRow: 49, totalRow: 56,
};

export const DISPLAY_PLACEMENT: PlacementLayout = {
  sheetPath: "xl/worksheets/sheet8.xml",
  drawingPath: "xl/drawings/drawing3.xml",
  placeChart: "chart8.xml",
  shiftCharts: ["xl/charts/chart9.xml", "xl/charts/chart10.xml"],
  delFrom: 24, delTo: 55, titleRow: 24, headerRow: 46, dataRow: 47, totalRow: 54,
};

export function renderDetailPlacement(
  files: ZipFiles,
  placements: PlacementRow[],
  layout: PlacementLayout = SEARCH_PLACEMENT,
  dashConv = false, // 디스플레이는 직접/간접 전환 split 없음 → M/N 칸 '-'
): void {
  const path = layout.sheetPath;
  const DRAWING = layout.drawingPath;
  const DEL_FROM = layout.delFrom, DEL_TO = layout.delTo, DELTA = DEL_TO - DEL_FROM + 1;

  // 1) 삭제 전에 지면 표본 스타일 확보
  let xml = readText(files, path);
  const sTitle = harvestRowStyles(xml, layout.titleRow);
  const sHeader = harvestRowStyles(xml, layout.headerRow);
  const sData = harvestRowStyles(xml, layout.dataRow);
  const sTotal = harvestRowStyles(xml, layout.totalRow);

  // 2) 지면 그래프 제거 → 3) 옛 지면 영역 진짜 삭제(아래 당겨 올림)
  removeChartFromDrawing(files, DRAWING, layout.placeChart);
  xml = deleteRows(xml, DEL_FROM, DEL_TO);
  writeText(files, path, xml);

  // 4) 성별/연령 그래프 데이터 ref + 앵커를 -DELTA 이동(일자 그래프는 24행 미만이라 무영향)
  for (const chart of layout.shiftCharts) shiftChartRowRefs(files, chart, DEL_TO, DELTA);
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

  // 지면별은 양식상 2번 섹션이지만 여기서 맨 아래(성별·연령대 3번 섹션 뒤)로 옮겨지므로
  // 최종 순서에선 4번 섹션 — 다른 섹션 제목과 번호 형식을 맞춘다("N. XXX 성과").
  const titleRow = r++;
  rows.push(buildRow(titleRow, ["B"], { B: sTitle.B ?? "" }, { B: "4. 지면별 성과" }));
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
    if (dashConv) { v.M = "-"; v.N = "-"; }
    rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sData, v));
    total = addMetrics(total, p.metrics);
  }

  noteMetrics(total);
  const tv: Record<string, CellValue> = { B: "합계" };
  metricValues(total).forEach((val, i) => (tv[DETAIL_METRIC_COLS[i]] = val));
  if (dashConv) { tv.M = "-"; tv.N = "-"; }
  rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sTotal, tv));

  xml = appendRows(xml, rows);
  const existing = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
  xml = setMergeCells(xml, [...existing, ...newMerges]);
  const widths: Record<string, number> = {};
  for (const c of DETAIL_PLACEMENT_COLS) widths[c] = widthFor(wmax[c]);
  xml = setColumnWidths(xml, widths);
  writeText(files, path, xml);
}
