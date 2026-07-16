// F-Report 고정형 시트 채우기 — ReportModel을 양식 셀에 주입.
//
// 원칙: **데이터 행은 12개 열(C~N: 노출/클릭/클릭률/CPC/총비용/구매완료/전환율/전환당비용/
// 매출액/ROAS/직접/간접)을 전부 계산해 숫자로 넣는다.** 소계/합계 행(SUM 수식)은 안 건드려
// 자동 합산되게 둔다. 수식 데이터 셀을 올바른 숫자로 덮어쓰는 건 무해(파생값이 그대로 박힘).
//
// 가변형 시트(검색광고 섹션2, 키워드 시트)는 행 수가 가변이라 별도 모듈에서 동적 생성.

import {
  applyCells, readText, writeText, setString, setNumber, setRowHidden, setColumnWidths, centerCells,
  harvestRowStyles, buildRow, insertRowsAt, setMergeCells, shiftDrawingRowAnchors, shiftChartRowRefs,
  setChartRangeEndRow,
} from "./report-excel";
import type { ZipFiles, CellValue } from "./report-excel";
import {
  metricValues, visualLen, colWidthLen, widthFor, metricStr, METRIC_HEADERS, ZERO_METRICS, addMetrics, type ReportMetrics,
} from "./report-data";

// 라벨열(B) + 12지표열(C~N) 너비 계산. metricRows=표시 지표행, labels=B열 라벨 후보.
function metricColWidths(metricRows: ReportMetrics[], labels: string[]): Record<string, number> {
  const w: Record<string, number> = {};
  w["B"] = widthFor(Math.max(2, ...labels.map(visualLen)));
  ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"].forEach((col, i) => {
    let mx = colWidthLen(METRIC_HEADERS[i]);
    for (const m of metricRows) mx = Math.max(mx, colWidthLen(metricStr(i, metricValues(m)[i])));
    w[col] = widthFor(mx);
  });
  return w;
}

export interface NamedMetrics {
  label: string;
  metrics: ReportMetrics;
}

export interface ReportModel {
  advertiserName: string;
  periodText: string; // "2026.06.15 ~ 2026.06.21"
  authorName: string;
  createdDate: string; // 작성일 "2026.06.23"
  // 증감표 행 라벨. 기간이 주 단위가 아닐 수 있어(지난달/최근30일) 실제 날짜를 적는다.
  curPeriodLabel: string; // "설정 기간(2026.06.01~2026.06.30)"
  prevPeriodLabel: string; // "이전 기간(2026.05.02~2026.05.31)"
  // 종합 + 검색광고 요약
  totalCurrent: ReportMetrics; // 계정 전체 설정 기간
  totalPrev: ReportMetrics; // 계정 전체 이전 기간
  searchCurrent: ReportMetrics; // 검색광고 설정 기간 (매체별 + 검색광고 시트 섹션1)
  searchPrev: ReportMetrics; // 검색광고 이전 기간
  displayCurrent: ReportMetrics; // 디스플레이 설정 기간 (매체별 + 디스플레이 시트 섹션1)
  displayPrev: ReportMetrics; // 디스플레이 이전 기간 (디스플레이 시트 섹션1)
  // 종합 섹션2 일자별 — 검색 + 디스플레이 합산. summaryByDayIsSearchOnly면 디스플레이 분해
  // 수집 실패로 검색광고분만 들어있다(제목에 표기해 섹션1 총계와의 차이를 오해 안 하게).
  summaryByDay: NamedMetrics[];
  summaryByDayIsSearchOnly: boolean;
  // 검색_상세
  byDay: NamedMetrics[];
  byPlacement: NamedMetrics[]; // 7 버킷(양식 라벨)
  byGender: NamedMetrics[]; // 남성/여성/알수없음
  byAge: NamedMetrics[]; // 8 버킷(양식 라벨)
  // 디스플레이_상세 (hasDisplayDetail일 때만 채움)
  displayByDay: NamedMetrics[];
  displayByPlacement: NamedMetrics[]; // 동적(노출>0 총비용순)
  displayByGender: NamedMetrics[];
  displayByAge: NamedMetrics[];
  // 시트 제거 판단
  hasSearch: boolean;
  hasDisplay: boolean; // 종합 디스플레이행/유형별 (gfa 합계 기준)
  hasDisplayDetail: boolean; // 디스플레이_상세 시트 (분해 수집 성공)
}

const div = (a: number, b: number) => (b ? a / b : 0);

// 지표 → 양식 12열(C~N) 표시값. ctr/crto/roas는 비율(소수), 양식 셀 서식이 %로 표시.
function display(m: ReportMetrics): Record<string, number> {
  return {
    C: m.impressions,
    D: m.clicks,
    E: div(m.clicks, m.impressions),
    F: div(m.cost, m.clicks),
    G: m.cost,
    H: m.purchaseConv, // 구매완료
    I: div(m.purchaseConv, m.clicks), // 전환율 (구매완료 기준)
    J: div(m.cost, m.purchaseConv), // 전환당비용 (구매완료 기준)
    K: m.revenue, // 매출액 (구매완료 전환매출)
    L: div(m.revenue, m.cost), // ROAS (구매완료 기준)
    M: m.directConv,
    N: m.indirectConv,
  };
}

// 12열 표시값을 특정 행의 셀 주소맵으로 (C{r}..N{r}).
function rowCells(r: number, disp: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [col, v] of Object.entries(disp)) out[`${col}${r}`] = v;
  return out;
}

// 증감(cur-prev) / 증감률((cur-prev)/prev) 열맵.
function deltaCells(r: number, cur: Record<string, number>, prev: Record<string, number>, rate: boolean): Record<string, number> {
  const out: Record<string, number> = {};
  for (const col of Object.keys(cur)) {
    const c = cur[col], p = prev[col];
    out[`${col}${r}`] = rate ? (p ? (c - p) / p : 0) : c - p;
  }
  return out;
}

// 빈 데이터 행 비우기 (양식 샘플값이 남지 않도록). C~N + 라벨 B.
function clearRow(xml: string, r: number, withLabel: boolean): string {
  let out = xml;
  if (withLabel) out = setString(out, `B${r}`, "");
  for (const col of ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"]) {
    out = setNumber(out, `${col}${r}`, 0);
  }
  return out;
}

// 설정 기간/이전 기간/증감/증감률 4행 블록(열 C~N). 종합 섹션1과 검색광고 섹션1이 동일 레이아웃.
function summaryBlock(
  rCur: number, rPrev: number, rDelta: number, rRate: number,
  cur: ReportMetrics, prev: ReportMetrics,
): Record<string, number> {
  const c = display(cur), p = display(prev);
  return {
    ...rowCells(rCur, c),
    ...rowCells(rPrev, p),
    ...deltaCells(rDelta, c, p, false),
    ...deltaCells(rRate, c, p, true),
  };
}

// ── 종합 시트 (sheet2) ──
// section1 총계: 18 설정 기간 / 19 이전 기간 / 20 증감 / 21 증감률
// section2 매체: 25 검색광고 / 26 디스플레이 / 27 합계(양식 수식을 집계 숫자로 덮어씀). 디스플레이 미진행 시 26행 숨김.
// section3 캠페인유형은 동적(report-variable.renderSummaryTypes)이라 여기서 안 건드림.
const SUMMARY_PATH = "xl/worksheets/sheet2.xml";

function fillSummary(files: ZipFiles, model: ReportModel): void {
  // 합계행(27)은 양식이 M27=M25+M26 / N27=N25+N26 / H27=M27+N27 수식이라, 디스플레이행의
  // M26/N26='-'(텍스트)와 더해지면 #VALUE!가 되고 그게 구매완료(H)/전환율/전환당비용까지 번진다.
  // 다른 합계행처럼 집계 숫자를 직접 넣어 수식 의존을 없앤다(setNumber가 <f>를 제거).
  const mediaTotal = model.hasDisplay
    ? addMetrics(model.searchCurrent, model.displayCurrent)
    : model.searchCurrent;
  applyCells(files, SUMMARY_PATH, {
    ...summaryBlock(18, 19, 20, 21, model.totalCurrent, model.totalPrev),
    ...rowCells(25, display(model.searchCurrent)),
    ...rowCells(26, display(model.displayCurrent)),
    ...rowCells(27, display(mediaTotal)),
  });
  // 섹션1 제목 + 증감표 기간 라벨 — 양식은 "주간/금주/전주" 고정이라 실제 기간으로 덮어쓴다.
  applyCells(files, SUMMARY_PATH, {}, {
    B2: "1. 운영 요약",
    B18: model.curPeriodLabel,
    B19: model.prevPeriodLabel,
  });
  if (!model.hasDisplay) {
    writeText(files, SUMMARY_PATH, setRowHidden(readText(files, SUMMARY_PATH), 26));
  } else {
    // 디스플레이(GFA)는 직접/간접 전환 데이터가 없어 M/N 칸은 '-' 표기 (합계행 SUM은 텍스트 무시 → 검색광고분만)
    let xml = readText(files, SUMMARY_PATH);
    xml = setString(xml, "M26", "-");
    xml = setString(xml, "N26", "-");
    writeText(files, SUMMARY_PATH, xml);
  }
  // 열 너비 — B열은 섹션3 캠페인유형명까지 들어가므로 알려진 라벨 전부 고려.
  const labels = [
    "구분", model.curPeriodLabel, model.prevPeriodLabel, "증감", "증감률",
    "매체 유형", "검색광고", "디스플레이", "합계", "캠페인 유형",
    "파워링크", "쇼핑검색광고", "플레이스", "브랜드검색/신제품검색", "파워컨텐츠", "웹사이트전환", "앱전환",
    "인지도 및 트래픽", "동영상 조회", "애드부스트", "카탈로그", "쇼핑프로모션", "참여유도",
    "검색광고 소계", "디스플레이 소계", "전체 합계",
  ];
  const rows = [model.totalCurrent, model.totalPrev, model.searchCurrent, model.displayCurrent];
  writeText(files, SUMMARY_PATH, setColumnWidths(readText(files, SUMMARY_PATH), metricColWidths(rows, labels)));
}

// ── 검색광고 시트 섹션1 (sheet3) ──
// 요약: 15 설정 기간 / 16 이전 기간 / 17 증감 / 18 증감률 (열 C~N, 종합과 동일). 섹션2는 동적.
// 원래 4~7이었는데 제목(2행) 아래 3~13에 일자별 콤보 그래프 자리가 생기며 +11 밀렸다
// (scripts/build-report-template-charts.ts). 양식을 다시 손대면 여기도 같이 맞춰야 한다.
const SEARCH_PATH = "xl/worksheets/sheet3.xml";
const SUMMARY_CUR_ROW = 15;  // 설정 기간
const SUMMARY_PREV_ROW = 16; // 이전 기간

function fillSearchSummary(files: ZipFiles, model: ReportModel): void {
  applyCells(files, SEARCH_PATH, summaryBlock(15, 16, 17, 18, model.searchCurrent, model.searchPrev), {
    B2: "1. 검색광고 요약",
    [`B${SUMMARY_CUR_ROW}`]: model.curPeriodLabel,
    [`B${SUMMARY_PREV_ROW}`]: model.prevPeriodLabel,
  });
  // 섹션1(C~N) 열 너비 — 섹션2(renderCampaignSheet)와 max 병합됨
  const labels = ["구분", model.curPeriodLabel, model.prevPeriodLabel, "증감", "증감률"];
  writeText(files, SEARCH_PATH, setColumnWidths(readText(files, SEARCH_PATH), metricColWidths([model.searchCurrent, model.searchPrev], labels)));
}

// ── 디스플레이 시트 섹션1 (sheet7) ──
// 요약: 15 설정 기간 / 16 이전 기간 / 17 증감 / 18 증감률 (검색광고와 동일 레이아웃 — 그래프 자리 +11).
// 디스플레이(GFA)는 직접/간접 전환 split이 없어 M/N 칸은 '-'.
const DISPLAY_PATH = "xl/worksheets/sheet7.xml";

function fillDisplaySummary(files: ZipFiles, model: ReportModel): void {
  applyCells(files, DISPLAY_PATH, summaryBlock(15, 16, 17, 18, model.displayCurrent, model.displayPrev), {
    B2: "1. 디스플레이 요약",
    [`B${SUMMARY_CUR_ROW}`]: model.curPeriodLabel,
    [`B${SUMMARY_PREV_ROW}`]: model.prevPeriodLabel,
  });
  let xml = readText(files, DISPLAY_PATH);
  for (const r of [15, 16, 17, 18]) {
    xml = setString(xml, `M${r}`, "-");
    xml = setString(xml, `N${r}`, "-");
  }
  const labels = ["구분", model.curPeriodLabel, model.prevPeriodLabel, "증감", "증감률"];
  xml = setColumnWidths(xml, metricColWidths([model.displayCurrent, model.displayPrev], labels));
  writeText(files, DISPLAY_PATH, xml);
}

// ── 검색_상세(sheet4) / 디스플레이_상세(sheet8) ──
// 두 시트는 레이아웃 동일, 지면·성별·연령 영역 행 번호만 다름. 지면별은 차트와 얽혀
// 맨 아래로 동적 이동(renderDetailPlacement)하므로 여기선 일자/성별/연령만 채운다.
interface DetailLayout {
  path: string;
  dayRows: number[]; // 일자별 데이터행 (7행 고정)
  dayTotalRow: number;
  genderRows: Record<string, number>; // 양식 라벨 → 행
  genderTotalRow: number;
  ageRows: Record<string, number>;
  ageTotalRow: number;
}

const SEARCH_DETAIL: DetailLayout = {
  path: "xl/worksheets/sheet4.xml",
  dayRows: [15, 16, 17, 18, 19, 20, 21],
  dayTotalRow: 22,
  genderRows: { 남성: 76, 여성: 77, 알수없음: 78 },
  genderTotalRow: 79,
  ageRows: { "만 13~18세": 82, "19~24세": 83, "25~29세": 84, "30~34세": 85, "35~39세": 86, "40~44세": 87, "45~49세": 88, "50세 이상": 89 },
  ageTotalRow: 90,
};

const DISPLAY_DETAIL: DetailLayout = {
  path: "xl/worksheets/sheet8.xml",
  dayRows: [15, 16, 17, 18, 19, 20, 21],
  dayTotalRow: 22,
  genderRows: { 남성: 68, 여성: 69, 알수없음: 70 },
  genderTotalRow: 71,
  // 연령은 '알 수 없음' 행(82) 포함 9행 — 양식 패치(patch-template-age-unknown.ts)로 추가됨.
  ageRows: { "만 13~18세": 74, "19~24세": 75, "25~29세": 76, "30~34세": 77, "35~39세": 78, "40~44세": 79, "45~49세": 80, "50세 이상": 81, "알 수 없음": 82 },
  ageTotalRow: 83,
};

interface DetailData {
  byDay: NamedMetrics[];
  byGender: NamedMetrics[];
  byAge: NamedMetrics[];
}

function fillDetailSheet(files: ZipFiles, layout: DetailLayout, data: DetailData, dashConv = false): void {
  let xml = readText(files, layout.path);

  // 일자별 — byDay를 7행에 채우고 남는 행은 비움 (월간 N>7 확장은 별도 처리 예정)
  layout.dayRows.forEach((r, i) => {
    const d = data.byDay[i];
    if (d) {
      xml = setString(xml, `B${r}`, d.label);
      for (const [addr, v] of Object.entries(rowCells(r, display(d.metrics)))) xml = setNumber(xml, addr, v);
    } else {
      xml = clearRow(xml, r, true);
    }
  });

  // 성별 / 연령 — 양식 고정 라벨 행에 매칭
  const byLabel = (rows: Record<string, number>, named: NamedMetrics[]) => {
    const map = new Map(named.map((d) => [d.label, d.metrics]));
    for (const [label, r] of Object.entries(rows)) {
      const m = map.get(label) ?? ZERO_METRICS;
      for (const [addr, v] of Object.entries(rowCells(r, display(m)))) xml = setNumber(xml, addr, v);
    }
  };
  byLabel(layout.genderRows, data.byGender);
  byLabel(layout.ageRows, data.byAge);

  // 합계행 — 양식의 일부 칸이 SUM 수식이 아니라 샘플 숫자(구매완료 H=319 등)이거나, 성별 H는
  // =M+N 수식이라 직접/간접이 0인 디스플레이에선 0이 된다. 합계행도 합산값으로 직접 채워 정합.
  const fillTotal = (totalRow: number, named: NamedMetrics[]) => {
    let sum = ZERO_METRICS;
    for (const n of named) sum = addMetrics(sum, n.metrics);
    for (const [addr, v] of Object.entries(rowCells(totalRow, display(sum)))) xml = setNumber(xml, addr, v);
  };
  fillTotal(layout.dayTotalRow, data.byDay);
  fillTotal(layout.genderTotalRow, data.byGender);
  fillTotal(layout.ageTotalRow, data.byAge);

  // 디스플레이는 직접/간접 전환 split이 없어 M/N 칸을 '-'로 (데이터행 + 합계행 전부).
  if (dashConv) {
    const dashRows = [
      ...layout.dayRows.filter((_, i) => data.byDay[i]), layout.dayTotalRow,
      ...Object.values(layout.genderRows), layout.genderTotalRow,
      ...Object.values(layout.ageRows), layout.ageTotalRow,
    ];
    for (const r of dashRows) {
      xml = setString(xml, `M${r}`, "-");
      xml = setString(xml, `N${r}`, "-");
    }
  }

  // 열 너비 — B열은 일자/성별/연령 라벨.
  const labels = [
    "일자", "성별", "연령대", "합계",
    ...data.byDay.map((d) => d.label),
    ...data.byGender.map((d) => d.label),
    ...data.byAge.map((d) => d.label),
  ];
  const rows = [...data.byDay, ...data.byGender, ...data.byAge].map((n) => n.metrics);
  xml = setColumnWidths(xml, metricColWidths(rows, labels));

  writeText(files, layout.path, xml);

  // 일자별/성별/연령 표는 데이터행 + 합계행까지 B~N 가운데 정렬.
  // (지면별은 renderDetailPlacement에서 이 행들을 위로 당기므로 정렬 스타일은 셀과 함께 이동)
  const cols = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
  const centerRows = [
    ...layout.dayRows, layout.dayTotalRow,
    ...Object.values(layout.genderRows), layout.genderTotalRow,
    ...Object.values(layout.ageRows), layout.ageTotalRow,
  ];
  const addrs: string[] = [];
  for (const r of centerRows) for (const c of cols) addrs.push(`${c}${r}`);
  centerCells(files, layout.path, addrs);
}

// ── 표지 시트 (sheet1) ──
// 표지는 셀이 아니라 도면(drawing4) 레이어로 디자인됨 — 배경 PNG + 텍스트박스/도형.
// 동적 값은 도면 XML의 토큰을 치환해 주입한다. 업체명은 주황 박스라 글자 길이에 맞춰 폭을 키운다.
// 표지 디자인 원본/병합은 scripts/build-report-template-cover.mjs 참조.
const COVER_DRAWING_PATH = "xl/drawings/drawing4.xml";

// 도면 텍스트(<a:t>) 안에 들어갈 값 이스케이프.
function escDraw(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 업체명 주황 박스 폭(EMU)을 글자 길이에 맞춰 재계산(14pt 굵게 맑은 고딕 추정).
// 박스는 좌변 고정 → 오른쪽으로 확장. 기본폭(원본, "업체명" 기준) 미만으로는 줄이지 않는다.
const ADV_BOX_DEFAULT_CX = 540000;  // 최소 박스 폭(짧은 이름이 너무 작아지지 않게)
const ADV_BOX_PER_UNIT = 81000;     // visualLen 1단위당 글자폭(12pt 굵게 기준, 한글=2 / 영문=1)
const ADV_BOX_PADDING = 220000;     // 좌우 합산 여백(한쪽당 ~110000 EMU ≈ 0.31cm)
function fillAdvertiserBox(xml: string, name: string): string {
  const adv = (name || "").trim() || "업체명";
  const out = xml.replace("__ADV__", escDraw(adv));
  const cx = Math.max(ADV_BOX_DEFAULT_CX, visualLen(adv) * ADV_BOX_PER_UNIT + ADV_BOX_PADDING);
  // 박스의 두 ext(xdr:ext + a:xfrm/a:ext)가 모두 cy="256761" 쌍이라 한 번에 치환.
  return out.replace(/cx="1355032" cy="256761"/g, `cx="${cx}" cy="256761"`);
}

function fillCover(files: ZipFiles, model: ReportModel): void {
  let xml = readText(files, COVER_DRAWING_PATH);
  xml = xml.replace("__PERIOD__", escDraw(model.periodText));
  xml = xml.replace("__AUTHOR__", escDraw(model.authorName));
  xml = xml.replace("__CREATED__", escDraw(model.createdDate));
  xml = fillAdvertiserBox(xml, model.advertiserName);
  writeText(files, COVER_DRAWING_PATH, xml);
}

// ── 월간(N>7일) 일자별 표 확장 ──
// 양식 일자별 표는 7행(주간) 고정. 기간 일수 N>7이면 8일째~N일째 행을 표 아래에 삽입하고,
// 그 아래의 성별/연령 표·차트·지면 섹션을 모두 아래로 밀고, 일자 그래프 데이터 범위를 N행으로 넓힌다.
// **renderDetailPlacement(지면 동적 이동) 이후 마지막에 호출** — 그래야 성별/연령이 최종 위치에
// 와 있고 한 번에 -extra만큼만 밀면 된다. N<=7이면 아무것도 안 한다(주간 경로 그대로).
export interface DailyExpandConfig {
  sheetPath: string;
  drawingPath: string;
  // 일자 표를 참조하는 그래프 — 데이터 범위 끝행 확장. 상세 시트의 추이 그래프(chart3/chart7)와
  // **검색광고·디스플레이 시트의 콤보 그래프(chart11/chart12)**가 같은 표를 보므로 둘 다 넣는다.
  // (콤보 그래프는 다른 시트에 있지만 데이터는 이 상세 시트를 참조 — 빼먹으면 월간에서 7일만 그려짐)
  dailyCharts: string[];
  otherCharts: string[]; // 성별/연령 그래프 — 데이터 ref를 아래로 이동
}
export const SEARCH_DAILY_EXPAND: DailyExpandConfig = {
  sheetPath: "xl/worksheets/sheet4.xml",
  drawingPath: "xl/drawings/drawing2.xml",
  dailyCharts: ["xl/charts/chart3.xml", "xl/charts/chart11.xml"],
  otherCharts: ["xl/charts/chart5.xml", "xl/charts/chart6.xml"],
};
export const DISPLAY_DAILY_EXPAND: DailyExpandConfig = {
  sheetPath: "xl/worksheets/sheet8.xml",
  drawingPath: "xl/drawings/drawing3.xml",
  dailyCharts: ["xl/charts/chart7.xml", "xl/charts/chart12.xml"],
  otherCharts: ["xl/charts/chart9.xml", "xl/charts/chart10.xml"],
};

const DAY_COLS = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
const DAY_METRIC_COLS = ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];

export function expandDailyRows(
  files: ZipFiles, cfg: DailyExpandConfig, byDay: NamedMetrics[], dashConv = false,
): void {
  const extra = byDay.length - 7; // 양식 일자행 7개 기준 초과분
  if (extra <= 0) return;

  // 8일째(인덱스 7)부터 추가 행 빌드 — 표본은 이미 가운데 정렬된 데이터행(15).
  let xml = readText(files, cfg.sheetPath);
  const style = harvestRowStyles(xml, 15);
  const rows: string[] = [];
  for (let i = 7; i < byDay.length; i++) {
    const r = 15 + i; // 22, 23, ...
    const disp = display(byDay[i].metrics);
    const v: Record<string, CellValue> = { B: byDay[i].label };
    for (const c of DAY_METRIC_COLS) v[c] = disp[c];
    if (dashConv) { v.M = "-"; v.N = "-"; }
    rows.push(buildRow(r, DAY_COLS, style, v));
  }
  // 합계행(22)과 그 아래 전부를 extra만큼 아래로 밀며 새 일자행 삽입
  xml = insertRowsAt(xml, 22, rows);
  writeText(files, cfg.sheetPath, xml);

  // 아래 표/차트 이동 + 일자 그래프 범위 확장
  shiftDrawingRowAnchors(files, cfg.drawingPath, 21, -extra); // 성별/연령 그래프 앵커 아래로
  for (const ch of cfg.otherCharts) shiftChartRowRefs(files, ch, 21, -extra); // 성별/연령 데이터 ref 아래로
  // 일자 표를 보는 그래프 전부 범위 15~(21+extra)로 확장 (없는 파트는 setChartRangeEndRow가 무시)
  for (const ch of cfg.dailyCharts) setChartRangeEndRow(files, ch, 21, 21 + extra);
}

// ── 종합 섹션2 "일자별 운영 요약" 삽입 ──
//
// 양식에는 없는 섹션이라 23행(옛 "2. 매체 유형별 요약") 앞에 통째로 끼워 넣고, 아래 섹션 번호를
// 3./4.로 민다. **renderSummaryTypes(섹션3 동적 재생성) 이후 마지막에 호출** — 그래야 아래 행이
// 최종 위치에 있고 insertRowsAt이 한 번에 민다. 종합 시트는 removeSheetDrawing으로 그림이 통째로
// 빠지므로 옮길 차트·앵커가 없다(상세 시트의 expandDailyRows와 다른 점).
//
// 표본 스타일은 섹션2(매체 유형별)에서 뜬다 — 제목/헤더/데이터/합계 4종이 같은 레이아웃이라.
const SUMMARY_DAY_COLS = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
const SUMMARY_DAY_METRIC_COLS = ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];

// buildRow는 ht를 안 붙인다(양식 데이터행과 동일). 제목(24)/헤더(30)만 양식 높이를 맞춘다.
function withHeight(row: string, ht: number): string {
  return row.replace(/^<row ([^>]*)>/, `<row $1 ht="${ht}" customHeight="1">`);
}

export function insertSummaryDaily(files: ZipFiles, model: ReportModel): void {
  const byDay = model.summaryByDay;
  if (byDay.length === 0) return;

  let xml = readText(files, SUMMARY_PATH);
  // 1) 삽입 전에 아래 섹션 번호부터 민다(양식 고정 주소일 때가 제일 단순).
  xml = setString(xml, "B23", "3. 매체 유형별 요약");
  xml = setString(xml, "B29", "4. 캠페인 유형별 요약");

  // 2) 표본 스타일 (섹션2: 23 제목 / 24 헤더 / 25 데이터 / 27 합계)
  const sTitle = harvestRowStyles(xml, 23);
  const sHeader = harvestRowStyles(xml, 24);
  const sData = harvestRowStyles(xml, 25);
  const sTotal = harvestRowStyles(xml, 27);

  // 3) 행 빌드: 제목 / 헤더 / 일자 N개 / 합계 / 빈 줄(섹션 간 여백 — 양식 22·28행 리듬)
  const rows: string[] = [];
  let r = 23;
  const title = model.summaryByDayIsSearchOnly
    ? "2. 일자별 운영 요약 (검색광고)" // 디스플레이 분해 실패 → 합계가 섹션1과 다름을 명시
    : "2. 일자별 운영 요약";
  rows.push(withHeight(buildRow(r++, ["B"], { B: sTitle.B ?? "" }, { B: title }), 24));

  const headerVals: Record<string, CellValue> = { B: "일자" };
  SUMMARY_DAY_METRIC_COLS.forEach((c, i) => (headerVals[c] = METRIC_HEADERS[i]));
  rows.push(withHeight(buildRow(r++, SUMMARY_DAY_COLS, sHeader, headerVals), 30));

  let total = ZERO_METRICS;
  for (const d of byDay) {
    const disp = display(d.metrics);
    const v: Record<string, CellValue> = { B: d.label };
    for (const c of SUMMARY_DAY_METRIC_COLS) v[c] = disp[c];
    rows.push(buildRow(r++, SUMMARY_DAY_COLS, sData, v));
    total = addMetrics(total, d.metrics);
  }

  const tv: Record<string, CellValue> = { B: "합계" };
  const tDisp = display(total);
  for (const c of SUMMARY_DAY_METRIC_COLS) tv[c] = tDisp[c];
  const totalRow = r++;
  rows.push(buildRow(totalRow, SUMMARY_DAY_COLS, sTotal, tv));

  rows.push(`<row r="${r}" spans="2:14"/>`); // 여백(양식 22·28행처럼 내용 없는 줄)

  // 4) 삽입 — 행번호·셀ref·수식ref·mergeCells 전부 insertRowsAt이 민다.
  xml = insertRowsAt(xml, 23, rows);
  // 제목 병합은 새로 추가(기존 B2/B16/B23→B(23+n)/B29→B(29+n)은 insertRowsAt이 이미 이동시킴)
  const existing = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
  xml = setMergeCells(xml, [...existing, "B23:N23"]);
  writeText(files, SUMMARY_PATH, xml);

  // 5) 데이터+합계행 가운데 정렬 (다른 표와 동일)
  const addrs: string[] = [];
  for (let rr = 25; rr <= totalRow; rr++) for (const c of SUMMARY_DAY_COLS) addrs.push(`${c}${rr}`);
  centerCells(files, SUMMARY_PATH, addrs);

  // 6) B열 너비 — 일자 라벨("06/15 (월)")이 기존 라벨보다 짧아 실제로는 안 넓어지지만,
  //    기간 라벨(설정 기간(...))이 이미 최대치라 재계산해도 그대로다. 누락 방지용으로만.
  writeText(files, SUMMARY_PATH, setColumnWidths(readText(files, SUMMARY_PATH), metricColWidths(
    byDay.map((d) => d.metrics),
    [model.curPeriodLabel, model.prevPeriodLabel, "일자", "합계", ...byDay.map((d) => d.label)],
  )));
}

// 고정형 시트 전체 채우기 + 비진행 매체 시트 제거는 호출 측(orchestrator)에서 removeSheets로.
export function fillFixedSheets(files: ZipFiles, model: ReportModel): void {
  fillCover(files, model);
  fillSummary(files, model);
  fillSearchSummary(files, model);
  if (model.hasDisplay) fillDisplaySummary(files, model);
  fillDetailSheet(files, SEARCH_DETAIL, { byDay: model.byDay, byGender: model.byGender, byAge: model.byAge });
  if (model.hasDisplayDetail) {
    fillDetailSheet(files, DISPLAY_DETAIL, {
      byDay: model.displayByDay,
      byGender: model.displayByGender,
      byAge: model.displayByAge,
    }, true);
  }
}
