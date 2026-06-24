// F-Report 고정형 시트 채우기 — ReportModel을 양식 셀에 주입.
//
// 원칙: **데이터 행은 12개 열(C~N: 노출/클릭/클릭률/CPC/총비용/구매완료/전환율/전환당비용/
// 매출액/ROAS/직접/간접)을 전부 계산해 숫자로 넣는다.** 소계/합계 행(SUM 수식)은 안 건드려
// 자동 합산되게 둔다. 수식 데이터 셀을 올바른 숫자로 덮어쓰는 건 무해(파생값이 그대로 박힘).
//
// 가변형 시트(검색광고 섹션2, 키워드 시트)는 행 수가 가변이라 별도 모듈에서 동적 생성.

import { applyCells, readText, writeText, setString, setNumber, setRowHidden, setColumnWidths, centerCells } from "./report-excel";
import type { ZipFiles } from "./report-excel";
import {
  metricValues, visualLen, widthFor, metricStr, METRIC_HEADERS, ZERO_METRICS, type ReportMetrics,
} from "./report-data";

// 라벨열(B) + 12지표열(C~N) 너비 계산. metricRows=표시 지표행, labels=B열 라벨 후보.
function metricColWidths(metricRows: ReportMetrics[], labels: string[]): Record<string, number> {
  const w: Record<string, number> = {};
  w["B"] = widthFor(Math.max(2, ...labels.map(visualLen)));
  ["C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"].forEach((col, i) => {
    let mx = visualLen(METRIC_HEADERS[i]);
    for (const m of metricRows) mx = Math.max(mx, visualLen(metricStr(i, metricValues(m)[i])));
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
  // 종합 + 검색광고 주간요약
  totalCurrent: ReportMetrics; // 계정 전체 금주
  totalPrev: ReportMetrics; // 계정 전체 전주
  searchCurrent: ReportMetrics; // 검색광고 금주 (매체별 + 검색광고 시트 섹션1)
  searchPrev: ReportMetrics; // 검색광고 전주
  displayCurrent: ReportMetrics; // 디스플레이 금주 (매체별)
  // 검색_상세
  byDay: NamedMetrics[];
  byPlacement: NamedMetrics[]; // 7 버킷(양식 라벨)
  byGender: NamedMetrics[]; // 남성/여성/알수없음
  byAge: NamedMetrics[]; // 8 버킷(양식 라벨)
  // 시트 제거 판단
  hasSearch: boolean;
  hasDisplay: boolean;
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

// 금주/전주/증감/증감률 4행 블록(열 C~N). 종합 섹션1과 검색광고 섹션1이 동일 레이아웃.
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
// section1 총계: 18 금주 / 19 전주 / 20 증감 / 21 증감률
// section2 매체: 25 검색광고 / 26 디스플레이 (27 합계=수식). 디스플레이 미진행 시 26행 숨김.
// section3 캠페인유형은 동적(report-variable.renderSummaryTypes)이라 여기서 안 건드림.
const SUMMARY_PATH = "xl/worksheets/sheet2.xml";

function fillSummary(files: ZipFiles, model: ReportModel): void {
  applyCells(files, SUMMARY_PATH, {
    ...summaryBlock(18, 19, 20, 21, model.totalCurrent, model.totalPrev),
    ...rowCells(25, display(model.searchCurrent)),
    ...rowCells(26, display(model.displayCurrent)),
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
    "구분", "금주", "전주", "증감", "증감률", "매체 유형", "검색광고", "디스플레이", "합계", "캠페인 유형",
    "파워링크", "쇼핑검색광고", "플레이스", "브랜드·신제품검색", "파워컨텐츠", "웹사이트전환", "앱전환",
    "인지도 및 트래픽", "동영상 조회", "애드부스트", "카탈로그", "쇼핑프로모션", "참여유도",
    "검색광고 소계", "디스플레이 소계", "전체 합계",
  ];
  const rows = [model.totalCurrent, model.totalPrev, model.searchCurrent, model.displayCurrent];
  writeText(files, SUMMARY_PATH, setColumnWidths(readText(files, SUMMARY_PATH), metricColWidths(rows, labels)));
}

// ── 검색광고 시트 섹션1 (sheet3) ──
// 주간요약: 4 금주 / 5 전주 / 6 증감 / 7 증감률 (열 C~N, 종합과 동일). 섹션2는 동적.
const SEARCH_PATH = "xl/worksheets/sheet3.xml";

function fillSearchSummary(files: ZipFiles, model: ReportModel): void {
  applyCells(files, SEARCH_PATH, summaryBlock(4, 5, 6, 7, model.searchCurrent, model.searchPrev));
  // 섹션1(C~N) 열 너비 — 섹션2(renderCampaignSheet)와 max 병합됨
  const labels = ["구분", "금주", "전주", "증감", "증감률"];
  writeText(files, SEARCH_PATH, setColumnWidths(readText(files, SEARCH_PATH), metricColWidths([model.searchCurrent, model.searchPrev], labels)));
}

// ── 검색_상세 시트 (sheet4) ──
// 일자별 15~21(7행, 합계22) / 지면별 49~55(합계56) / 성별 76~78(합계79) / 연령 82~89(합계90)
const DETAIL_PATH = "xl/worksheets/sheet4.xml";
const DAY_ROWS = [15, 16, 17, 18, 19, 20, 21];
const GENDER_ROWS: Record<string, number> = { 남성: 76, 여성: 77, 알수없음: 78 };
const AGE_ROWS: Record<string, number> = {
  "만 13~18세": 82,
  "19~24세": 83,
  "25~29세": 84,
  "30~34세": 85,
  "35~39세": 86,
  "40~44세": 87,
  "45~49세": 88,
  "50세 이상": 89,
};

function fillDetail(files: ZipFiles, model: ReportModel): void {
  let xml = readText(files, DETAIL_PATH);

  // 일자별 — byDay를 7행에 채우고 남는 행은 비움 (월간 N>7 확장은 별도 처리 예정)
  DAY_ROWS.forEach((r, i) => {
    const d = model.byDay[i];
    if (d) {
      xml = setString(xml, `B${r}`, d.label);
      for (const [addr, v] of Object.entries(rowCells(r, display(d.metrics)))) xml = setNumber(xml, addr, v);
    } else {
      xml = clearRow(xml, r, true);
    }
  });

  // 지면별 / 성별 / 연령 — 양식 고정 라벨 행에 매칭
  const byLabel = (rows: Record<string, number>, data: NamedMetrics[]) => {
    const map = new Map(data.map((d) => [d.label, d.metrics]));
    for (const [label, r] of Object.entries(rows)) {
      const m = map.get(label) ?? ZERO_METRICS;
      for (const [addr, v] of Object.entries(rowCells(r, display(m)))) xml = setNumber(xml, addr, v);
    }
  };
  // 지면별은 차트와 얽혀 맨 아래로 동적 이동(renderDetailPlacement). 여기선 일자/성별/연령만.
  byLabel(GENDER_ROWS, model.byGender);
  byLabel(AGE_ROWS, model.byAge);

  // 열 너비 — B열은 일자/성별/연령 라벨.
  const labels = [
    "일자", "성별", "연령대", "합계",
    ...model.byDay.map((d) => d.label),
    ...model.byGender.map((d) => d.label),
    ...model.byAge.map((d) => d.label),
  ];
  const rows = [...model.byDay, ...model.byGender, ...model.byAge].map((n) => n.metrics);
  xml = setColumnWidths(xml, metricColWidths(rows, labels));

  writeText(files, DETAIL_PATH, xml);

  // 일자별/성별/연령 표는 데이터행 + 합계행까지 B~N 가운데 정렬.
  // (지면별은 renderDetailPlacement에서 이 행들을 -34행 당기므로 정렬 스타일은 셀과 함께 이동)
  const cols = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N"];
  const centerRows = [
    ...DAY_ROWS, 22, // 일자별 + 합계
    76, 77, 78, 79, // 성별 + 합계
    82, 83, 84, 85, 86, 87, 88, 89, 90, // 연령 + 합계
  ];
  const addrs: string[] = [];
  for (const r of centerRows) for (const c of cols) addrs.push(`${c}${r}`);
  centerCells(files, DETAIL_PATH, addrs);
}

// ── 표지 시트 (sheet1) ──
// B7:I9 = 보고서 제목(고정), 계정/담당자/기간 입력칸. 정확한 셀은 양식 구조에 맞춰 주입.
const COVER_PATH = "xl/worksheets/sheet1.xml";

function fillCover(files: ZipFiles, model: ReportModel): void {
  let xml = readText(files, COVER_PATH);
  // 표지 입력칸: D12 계정명 / D13 리포트 기간 / D15 담당자 / D16 작성일.
  // (D14 "네이버"=매체 고정, B7:I9 보고서 제목 고정)
  xml = setString(xml, "D12", model.advertiserName);
  xml = setString(xml, "D13", model.periodText);
  xml = setString(xml, "D15", model.authorName);
  xml = setString(xml, "D16", model.createdDate);
  writeText(files, COVER_PATH, xml);
}

// 고정형 시트 전체 채우기 + 비진행 매체 시트 제거는 호출 측(orchestrator)에서 removeSheets로.
export function fillFixedSheets(files: ZipFiles, model: ReportModel): void {
  fillCover(files, model);
  fillSummary(files, model);
  fillSearchSummary(files, model);
  fillDetail(files, model);
}
