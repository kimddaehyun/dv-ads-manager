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
  dropRowCellsAfter,
  setHyperlinks,
  addHyperlinkStyle,
  type ZipFiles,
  type CellValue,
} from "./report-excel";
import {
  metricValues, addMetrics, ZERO_METRICS, colWidthLen, widthFor, metricStr, METRIC_HEADERS,
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
  for (const c of KW_COLS) wmax[c] = colWidthLen(KW_HEADERS[c] ?? "");
  const noteText = (col: string, s: string) => { wmax[col] = Math.max(wmax[col] ?? 0, colWidthLen(s)); };
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
    // 소계 — 키워드가 1개뿐이면 데이터행을 그대로 베낀 값이라 넣지 않는다.
    if (g.keywords.length > 1) {
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
    }
    grand = addMetrics(grand, groupSum); // 소계행을 건너뛰어도 전체 합계에는 항상 반영
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

// ── 쇼핑검색 상품별 성과 (sheet9) ──
// 키워드 시트와 달리 **캠페인/그룹을 안 나누고 상품명 한 열**만 쓴다(같은 상품은 이미 합산됨).
// 그래서 열 배치가 [B 상품명][C~N 12지표]로 종합/상세 표와 같다 — 키워드 시트(B~D 라벨 + E~P)와 다름.
// 양식은 sheet6(쇼핑검색_키워드) 복제라 표본 스타일은 그 시트 것(4=데이터, B:D 병합행=전체합계)을 쓰고,
// 지표 스타일은 E~P에 있으므로 C~N으로 옮겨 붙인다.
// 상품명 열 상한. 기본 55보다는 넓게 두되(상품명이 잘리면 못 알아본다) 무제한은 아니다.
const PROD_NAME_MAX_WIDTH = 90;
const PROD_COLS = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
const PROD_METRIC_COLS = ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
const PROD_SAMPLE_METRIC_COLS = ["E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P"];

export interface ProductRow {
  label: string; // 상품명 (못 얻었으면 소재ID)
  metrics: ReportMetrics;
  url?: string; // 상품 페이지 링크 — 있으면 상품명 셀에 하이퍼링크
}

export function renderProductSheet(
  files: ZipFiles,
  sheetPath: string,
  rows: ProductRow[],
  title: string,
): void {
  let xml = readText(files, sheetPath);
  xml = setString(xml, "B2", title);
  // 양식(키워드 시트 복제)의 제목행은 B~P에 주황 스타일 셀이 깔려 있다. 이 배치는 N에서 끝나므로
  // O2/P2를 지우지 않으면 표 오른쪽에 주황 칸 2개가 떠 있는다(제목 병합이 B2:N2라 병합도 못 덮는다).
  xml = dropRowCellsAfter(xml, 2, "N");

  // 표본 스타일: 3=헤더, 4=데이터, 전체합계(B:D 병합행). 지표 스타일은 E~P → C~N으로 이동.
  const shift = (st: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = { B: st.B ?? "" };
    PROD_METRIC_COLS.forEach((c, i) => { out[c] = st[PROD_SAMPLE_METRIC_COLS[i]] ?? ""; });
    return out;
  };
  const sHeader = shift(harvestRowStyles(xml, 3));
  const sData = shift(harvestRowStyles(xml, 4));
  const totalM = xml.match(/<mergeCell ref="B(\d+):D\1"\/>/);
  const sTotal = shift(harvestRowStyles(xml, totalM ? Number(totalM[1]) : 11));

  const wmax: Record<string, number> = { B: colWidthLen("상품명") };
  PROD_METRIC_COLS.forEach((c, i) => { wmax[c] = colWidthLen(METRIC_HEADERS[i]); });
  const noteMetrics = (m: ReportMetrics) => {
    const vals = metricValues(m);
    PROD_METRIC_COLS.forEach((c, i) => { wmax[c] = Math.max(wmax[c], colWidthLen(metricStr(i, vals[i]))); });
  };

  const out: string[] = [];
  let r = 3;
  const headerVals: Record<string, CellValue> = { B: "상품명" };
  PROD_METRIC_COLS.forEach((c, i) => { headerVals[c] = METRIC_HEADERS[i]; });
  out.push(buildRow(r++, PROD_COLS, sHeader, headerVals));

  // 링크 있는 상품명 셀은 파랑+밑줄로 — 안 그러면 눌러보기 전엔 링크인 줄 모른다.
  // 스타일은 데이터행 B 스타일에서 글꼴만 바꿔 뜬 것이라 배경·테두리는 그대로 유지된다.
  // 링크 없는 상품(url 미수집)은 원래 스타일 그대로 — 파랗기만 하고 안 눌리면 그게 더 나쁘다.
  const baseB = Number((sData.B?.match(/s="(\d+)"/) ?? [])[1] ?? 0);
  const linkStyle = ` s="${addHyperlinkStyle(files, baseB)}"`;

  let total = ZERO_METRICS;
  const links: { addr: string; url: string }[] = [];
  for (const row of rows) {
    wmax.B = Math.max(wmax.B, colWidthLen(row.label));
    noteMetrics(row.metrics);
    const v: Record<string, CellValue> = { B: row.label };
    metricValues(row.metrics).forEach((val, i) => { v[PROD_METRIC_COLS[i]] = val; });
    const style = row.url ? { ...sData, B: linkStyle } : sData;
    if (row.url) links.push({ addr: `B${r}`, url: row.url });
    out.push(buildRow(r++, PROD_COLS, style, v));
    total = addMetrics(total, row.metrics);
  }

  noteMetrics(total);
  const tv: Record<string, CellValue> = { B: "전체 합계" };
  metricValues(total).forEach((val, i) => { tv[PROD_METRIC_COLS[i]] = val; });
  out.push(buildRow(r, PROD_COLS, sTotal, tv));

  xml = replaceRowsFrom(xml, 3, out);
  // 제목 병합만 남긴다 — 양식의 전체합계 B:D 병합은 이 배치에서 의미 없다(라벨 열이 B 하나).
  xml = setMergeCells(xml, ["B2:N2"]);
  const widths: Record<string, number> = {};
  for (const c of PROD_COLS) widths[c] = widthFor(wmax[c]);
  // 상품명은 잘리면 어느 상품인지 못 알아보니 기본 55자 상한보다는 넓게. 다만 무제한으로 두면
  // 네이버 상품명이 워낙 길어(실측 654개, 최장은 폭 ~90) 표가 화면을 벗어난다.
  // 90 = 사용자가 직접 맞춰 보내준 폭. 대부분의 상품명은 다 들어가고 최장급만 살짝 잘린다.
  widths.B = widthFor(wmax.B, PROD_NAME_MAX_WIDTH);
  xml = setColumnWidths(xml, widths);
  writeText(files, sheetPath, xml);
  // 하이퍼링크는 시트 rels를 건드리므로 시트 XML을 다 쓴 뒤에.
  setHyperlinks(files, sheetPath, links);
}

// ── 검색광고 캠페인별 성과 (sheet3 섹션2) ──
// 표본행(첫 데이터행/소계/합계)의 지표 스타일은 항상 D~O(12개)에 있다 — 거기서 떠와 실제 배치로 옮긴다.
// 섹션1(요약 4~7행)은 report-fill이 채우므로 첫 데이터행부터 재생성(이상 행만 교체).
const CAMP_SAMPLE_METRIC_COLS = ["D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"];

// 섹션2 행 위치. 원래 9/10/11이었는데 제목(2행) 아래 3~13에 일자별 콤보 그래프 자리가 생기며
// +11 밀렸다 (scripts/build-report-template-charts.ts). 양식을 다시 손대면 이 상수도 같이 맞춰야 한다.
const CAMP_BAR_ROW = 20;    // 섹션 헤더 바 (B~마지막지표열 병합)
const CAMP_HEADER_ROW = 21; // 컬럼 헤더
const CAMP_FIRST_ROW = 22;  // 첫 데이터행 (= 표본 스타일 행)

export interface CampaignTypeGroup {
  type: string; // 파워링크/쇼핑검색광고/...
  rows: { campaign?: string; group: string; metrics: ReportMetrics }[]; // campaign은 withGroup일 때만
}

// 시트별 표본 행 위치. 그래프 자리 11행 삽입 후 검색광고(sheet3)=25/38, 디스플레이(sheet7)=24/46.
// dashConv=true면 직접/간접 전환(마지막 2개 지표열)을 '-'로 (디스플레이는 split 없음).
// withGroup=true면 [유형|캠페인|그룹|지표(E~P)] 3단계 + 같은 캠페인 세로병합 (검색광고).
// false면 [유형|캠페인|지표(D~O)] 2단계 (디스플레이는 캠페인 단위라 그룹 없음).
export interface CampaignSheetLayout {
  subtotalSampleRow: number;
  totalSampleRow: number;
  dashConv?: boolean;
  withGroup?: boolean;
}
const SEARCH_CAMPAIGN_LAYOUT: CampaignSheetLayout = { subtotalSampleRow: 25, totalSampleRow: 38, withGroup: true };
export const DISPLAY_CAMPAIGN_LAYOUT: CampaignSheetLayout = { subtotalSampleRow: 24, totalSampleRow: 46, dashConv: true };

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

  const sFirst = harvestRowStyles(xml, CAMP_FIRST_ROW);
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

  // 컬럼 헤더행. withGroup이면 지표 라벨이 E~P로 밀리므로 행 전체 재구성(그룹 열 신설).
  // 아니면 B/C 라벨만 교체(디스플레이는 지표 라벨이 양식 그대로 D~O).
  if (withGroup) {
    const headerStyle = styleFor(harvestRowStyles(xml, CAMP_HEADER_ROW), false);
    const headerValues: Record<string, CellValue> = { B: "캠페인 유형", C: "캠페인", D: "그룹" };
    metricCols.forEach((mc, i) => { headerValues[mc] = METRIC_HEADERS[i]; });
    xml = xml.replace(
      new RegExp(`<row r="${CAMP_HEADER_ROW}"[^>]*>[\\s\\S]*?</row>`),
      buildRow(CAMP_HEADER_ROW, cols, headerStyle, headerValues),
    );
  } else {
    xml = setString(xml, `B${CAMP_HEADER_ROW}`, "캠페인 유형");
    xml = setString(xml, `C${CAMP_HEADER_ROW}`, "캠페인");
  }

  const dashLast = (cells: Record<string, CellValue>): Record<string, CellValue> => {
    if (!layout.dashConv) return cells;
    const last2 = metricCols.slice(-2);
    return { ...cells, [last2[0]]: "-", [last2[1]]: "-" };
  };

  const headerLabel: Record<string, string> = { B: "캠페인 유형", C: "캠페인", D: "그룹" };
  const wmax: Record<string, number> = {};
  for (const c of labelCols) wmax[c] = colWidthLen(headerLabel[c] ?? "");
  metricCols.forEach((mc, i) => { wmax[mc] = colWidthLen(METRIC_HEADERS[i]); });
  const noteText = (col: string, s: string) => { wmax[col] = Math.max(wmax[col] ?? 0, colWidthLen(s)); };
  const noteMetrics = (m: ReportMetrics) => {
    const vals = metricValues(m);
    metricCols.forEach((c, i) => noteText(c, metricStr(i, vals[i])));
  };

  const rows: string[] = [];
  const merges = ["B2:N2", `B${CAMP_BAR_ROW}:${lastCol}${CAMP_BAR_ROW}`];
  let r = CAMP_FIRST_ROW;
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
    // 소계 — 행이 1개뿐이면 데이터행을 그대로 베낀 값이라 넣지 않는다.
    if (g.rows.length > 1) {
      noteMetrics(typeSum);
      // 소계 라벨에 유형명을 붙인다("파워링크 소계") — 표가 길어지면 세로 병합된 B열 유형명이
      // 화면 밖으로 밀려 무슨 소계인지 안 보인다.
      const subLabel = `${g.type} 소계`;
      noteText("C", subLabel);
      const subValues: Record<string, CellValue> = {
        B: null, C: subLabel, ...dashLast(metricCells(metricCols, typeSum)),
      };
      if (withGroup) subValues.D = null;
      rows.push(buildRow(r++, cols, subStyle, subValues));
    }
    // 유형(B) 세로 병합 — 데이터행 + (있으면) 소계행. 행이 1개면 병합할 게 없다
    // (B{r}:B{r} 같은 1칸 병합은 엑셀이 싫어한다).
    if (r - 1 > r0) merges.push(`B${r0}:B${r - 1}`);
    grand = addMetrics(grand, typeSum); // 소계행을 건너뛰어도 전체 합계에는 항상 반영
  }
  noteMetrics(grand);

  merges.push(`B${r}:${withGroup ? "D" : "C"}${r}`);
  const totalValues: Record<string, CellValue> = {
    B: "전체 합계", C: null, ...dashLast(metricCells(metricCols, grand)),
  };
  if (withGroup) totalValues.D = null;
  rows.push(buildRow(r, cols, totalStyle, totalValues));

  xml = replaceRowsFrom(xml, CAMP_FIRST_ROW, rows);
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

  const wmax: Record<string, number> = { B: colWidthLen("광고영역") };
  DETAIL_METRIC_COLS.forEach((c, i) => (wmax[c] = colWidthLen(METRIC_HEADERS[i])));
  const noteMetrics = (m: ReportMetrics) => {
    const vals = metricValues(m);
    DETAIL_METRIC_COLS.forEach((c, i) => (wmax[c] = Math.max(wmax[c], colWidthLen(metricStr(i, vals[i])))));
  };

  // 이 섹션은 appendRows로 새로 붙는다 → 양식 행 높이(24pt)를 못 물려받아 기본(~15pt)으로 낮게
  // 나온다(위 일자/성별/연령은 applyCells로 양식 행에 값만 채워 높이 유지). 그래서 명시적으로 맞춘다.
  const ROW_HT = 24;
  // 지면별은 양식상 2번 섹션이지만 여기서 맨 아래(성별·연령대 3번 섹션 뒤)로 옮겨지므로
  // 최종 순서에선 4번 섹션 — 다른 섹션 제목과 번호 형식을 맞춘다("N. XXX 성과").
  const titleRow = r++;
  rows.push(buildRow(titleRow, ["B"], { B: sTitle.B ?? "" }, { B: "4. 지면별 성과" }, ROW_HT));
  newMerges.push(`B${titleRow}:N${titleRow}`);

  const headerVals: Record<string, CellValue> = { B: "광고영역" };
  DETAIL_METRIC_COLS.forEach((c, i) => (headerVals[c] = METRIC_HEADERS[i]));
  rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sHeader, headerVals, ROW_HT));

  let total = ZERO_METRICS;
  for (const p of placements) {
    wmax.B = Math.max(wmax.B, colWidthLen(p.label));
    noteMetrics(p.metrics);
    const v: Record<string, CellValue> = { B: p.label };
    metricValues(p.metrics).forEach((val, i) => (v[DETAIL_METRIC_COLS[i]] = val));
    if (dashConv) { v.M = "-"; v.N = "-"; }
    rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sData, v, ROW_HT));
    total = addMetrics(total, p.metrics);
  }

  noteMetrics(total);
  const tv: Record<string, CellValue> = { B: "합계" };
  metricValues(total).forEach((val, i) => (tv[DETAIL_METRIC_COLS[i]] = val));
  if (dashConv) { tv.M = "-"; tv.N = "-"; }
  rows.push(buildRow(r++, DETAIL_PLACEMENT_COLS, sTotal, tv, ROW_HT));

  xml = appendRows(xml, rows);
  const existing = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
  xml = setMergeCells(xml, [...existing, ...newMerges]);
  const widths: Record<string, number> = {};
  for (const c of DETAIL_PLACEMENT_COLS) widths[c] = widthFor(wmax[c]);
  xml = setColumnWidths(xml, widths);
  writeText(files, path, xml);
}
