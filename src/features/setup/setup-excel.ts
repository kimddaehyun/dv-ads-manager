/**
 * F-Setup — 세팅안 워크북 생성 + 다운로드.
 *
 * write-excel-file/browser (MV3 콘텐츠 스크립트 호환, Node 의존성 없음)로 캠페인마다 시트 1개:
 *   - 상단: 캠페인 타이틀 + 그룹 요약표(그룹/일예산/디바이스/지역/요일시간/소재노출)
 *   - 중단: 키워드 가로 블록 — 그룹을 옆으로 나란히, 그룹마다 [키워드/입찰가/예상순위]
 *   - 하단: 소재 섹션 (광고그룹/소재유형/제목/설명/연결 URL)
 *
 * 한 시트에 폭이 다른 표가 섞여 columnSpan으로 셀을 넓혀 정렬한다. 컬럼 폭 그리드는
 * 키워드 블록 기준(그룹당 [키워드/입찰가/순위]).
 *
 * 디자인: 컬럼 헤더는 DV 주황(#E6783B) 흰글씨, 그룹명 헤더는 옅은 살구 배경. 짝대기는 하이픈만.
 */

import writeXlsxFile from "write-excel-file/browser";
import type { Cell, Image, SheetData } from "write-excel-file/browser";
import { typeHasKeywords } from "./setup-adapters";
import type { SetupAdgroup, SetupCampaign } from "@/types/setup";

/** url → 이미지 binary (background에서 fetch). 쇼핑 소재 이미지 삽입용. */
export type SetupImageMap = Map<string, ArrayBuffer>;

// 소재 이미지 크기(px) + 그 행 높이(pt 여유). 소재유형 컬럼(폭 COL_BID)에 들어가는 정사각 썸네일.
const IMG_PX = 60;
const IMG_ROW_HEIGHT = 64;

const ORANGE = "#E6783B";
const PEACH = "#FBE3D3"; // 그룹명 헤더 옅은 살구
const WHITE = "#FFFFFF";
const GRID = "#E5E5E5";
const INK = "#171717";
const MONEY_FMT = '#,##0"원"';

// 키워드 블록 컬럼 폭 그리드 (그룹당 3컬럼 반복).
const COL_KW = 24;
const COL_BID = 11;
const COL_RANK = 10;

function headerCell(text: string, columnSpan?: number): Cell {
  return {
    value: text,
    fontWeight: "bold",
    backgroundColor: ORANGE,
    textColor: WHITE,
    align: "center",
    alignVertical: "center",
    borderColor: WHITE,
    borderStyle: "thin",
    columnSpan,
    wrap: true,
  };
}

function groupHeaderCell(text: string, columnSpan: number): Cell {
  return {
    value: text,
    fontWeight: "bold",
    backgroundColor: PEACH,
    textColor: INK,
    align: "center",
    alignVertical: "center",
    borderColor: WHITE,
    borderStyle: "thin",
    columnSpan,
  };
}

function titleCell(text: string, columnSpan: number): Cell {
  return {
    value: text,
    fontWeight: "bold",
    fontSize: 13,
    textColor: INK,
    alignVertical: "center",
    columnSpan,
  };
}

function sectionCell(text: string, columnSpan: number): Cell {
  return {
    value: text,
    fontWeight: "bold",
    fontSize: 11,
    textColor: ORANGE,
    alignVertical: "center",
    columnSpan,
  };
}

interface TextOpts {
  align?: "left" | "center" | "right";
  bold?: boolean;
  columnSpan?: number;
}

function tc(value: string, opts: TextOpts = {}): Cell {
  return {
    value: value || "-",
    borderColor: GRID,
    borderStyle: "thin",
    alignVertical: "center",
    align: opts.align,
    fontWeight: opts.bold ? "bold" : undefined,
    columnSpan: opts.columnSpan,
    wrap: true,
  };
}

function moneyCell(value: number): Cell {
  return {
    type: Number,
    value,
    format: MONEY_FMT,
    borderColor: GRID,
    borderStyle: "thin",
    alignVertical: "center",
    align: "right",
  };
}

function budgetCell(value: number | null): Cell {
  return value === null ? tc("제한없음", { align: "center" }) : moneyCell(value);
}

function rankText(rank: number | "out" | null): string {
  if (rank === null) return "-";
  if (rank === "out") return "10위 밖";
  return `${rank}위`;
}

function blankRow(): Cell[] {
  return [null];
}

/** 그리드 폭 배열 — 키워드 블록(그룹당 3컬럼) 기준, 최소 8컬럼(소재 섹션 columnSpan 여유). */
function columnWidths(groupCount: number): { width: number }[] {
  const total = Math.max(groupCount * 3, 8);
  const out: { width: number }[] = [];
  const pattern = [COL_KW, COL_BID, COL_RANK];
  for (let i = 0; i < total; i++) out.push({ width: pattern[i % 3] });
  return out;
}

function buildCampaignSheet(
  c: SetupCampaign,
  imageMap: SetupImageMap,
): { data: SheetData; columns: { width: number }[]; images: Image[] } {
  const kwGroups = typeHasKeywords(c.typeCode)
    ? c.adgroups.filter((g) => g.keywords.length > 0)
    : [];
  const columns = columnWidths(Math.max(1, kwGroups.length));
  const totalCols = columns.length;
  const rows: SheetData = [];
  const images: Image[] = [];

  // 1) 캠페인 타이틀.
  rows.push([
    titleCell(`${c.name}   ·   ${c.typeLabel}   ·   일예산 ${formatBudgetText(c.dailyBudget)}`, totalCols),
  ]);
  rows.push(blankRow());

  // 2) 그룹 요약표.
  rows.push([sectionCell("그룹 설정", totalCols)]);
  rows.push(
    ["그룹", "일예산", "디바이스", "지역", "요일/시간", "소재노출"].map((h) => headerCell(h)),
  );
  for (const g of c.adgroups) {
    rows.push([
      tc(g.name),
      budgetCell(g.dailyBudget),
      tc(g.targeting.device, { align: "center" }),
      tc(g.targeting.region, { align: "center" }),
      tc(g.targeting.schedule, { align: "center" }),
      tc(g.targeting.adRolling, { align: "center" }),
    ]);
  }
  rows.push(blankRow());
  rows.push(blankRow());

  // 3) 소재 섹션 (제목/설명/URL은 columnSpan=2로 넓게). 쇼핑 소재는 소재유형 칸에 이미지.
  rows.push([sectionCell("소재", totalCols)]);
  rows.push([
    headerCell("광고그룹"),
    headerCell("소재유형"),
    headerCell("제목/대표명", 2),
    null,
    headerCell("설명", 2),
    null,
    headerCell("연결 URL", 2),
    null,
  ]);
  for (const g of c.adgroups) {
    if (g.ads.length === 0) {
      rows.push([
        tc(g.name),
        tc("-", { align: "center" }),
        tc("(소재 없음)", { columnSpan: 2 }),
        null,
        tc("-", { columnSpan: 2 }),
        null,
        tc("-", { columnSpan: 2 }),
        null,
      ]);
      continue;
    }
    for (const ad of g.ads) {
      const buf = ad.imageUrl ? imageMap.get(ad.imageUrl) : undefined;
      let typeCell: Cell;
      if (buf) {
        // 소재유형 칸을 이미지로 — 빈 셀 + 행 높이 키우고 이미지 anchor.
        const rowIndex = rows.length + 1; // 1-based (다음에 push할 행)
        typeCell = {
          value: "",
          borderColor: GRID,
          borderStyle: "thin",
          height: IMG_ROW_HEIGHT,
        };
        images.push({
          content: buf,
          contentType: "image/jpeg",
          width: IMG_PX,
          height: IMG_PX,
          dpi: 96,
          anchor: { row: rowIndex, column: 2 }, // B열 = 소재유형 (1-based)
          offsetX: 8,
          offsetY: 4,
        });
      } else {
        typeCell = tc(ad.typeLabel, { align: "center" });
      }
      rows.push([
        tc(g.name),
        typeCell,
        tc(ad.title, { columnSpan: 2 }),
        null,
        tc(ad.body, { columnSpan: 2 }),
        null,
        tc(ad.url, { columnSpan: 2 }),
        null,
      ]);
    }
  }
  rows.push(blankRow());
  rows.push(blankRow());

  // 4) 키워드 가로 블록 (키워드 있는 그룹만).
  if (kwGroups.length > 0) {
    rows.push([sectionCell("키워드", totalCols)]);
    rows.push(buildHorizontalRow(kwGroups, (g, i) => [groupHeaderCell(`${i + 1}. ${g.name}`, 3), null, null]));
    rows.push(
      buildHorizontalRow(kwGroups, () => [
        headerCell("키워드"),
        headerCell("입찰가"),
        headerCell("예상순위"),
      ]),
    );
    const maxLen = Math.max(...kwGroups.map((g) => g.keywords.length));
    for (let r = 0; r < maxLen; r++) {
      rows.push(
        buildHorizontalRow(kwGroups, (g) => {
          const k = g.keywords[r];
          if (!k) return [null, null, null];
          return [tc(k.keyword), moneyCell(k.bidAmt), tc(rankText(k.rank), { align: "center" })];
        }),
      );
    }
  }

  return { data: rows, columns, images };
}

/**
 * 그룹들을 가로로 펼친 한 행 빌드. 각 그룹당 cellsFor가 3개 셀을 반환(columnSpan 셀 뒤 null 포함).
 */
function buildHorizontalRow(
  groups: SetupAdgroup[],
  cellsFor: (g: SetupAdgroup, index: number) => Cell[],
): Cell[] {
  const row: Cell[] = [];
  groups.forEach((g, i) => {
    row.push(...cellsFor(g, i));
  });
  return row;
}

function formatBudgetText(v: number | null): string {
  return v === null ? "제한없음" : `${v.toLocaleString("ko-KR")}원`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").trim() || "광고계정";
}

/** 엑셀 시트명 제약: <=31자, []:*?/\ 불가, 중복 불가. */
function sheetName(name: string, used: Set<string>): string {
  const base = (name.replace(/[[\]:*?/\\]/g, " ").trim() || "캠페인").slice(0, 28);
  let candidate = base;
  let i = 2;
  while (used.has(candidate)) {
    candidate = `${base} (${i++})`.slice(0, 31);
  }
  used.add(candidate);
  return candidate;
}

function todayStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 캠페인마다 시트 1개로 세팅안 워크북 생성 + 다운로드. 반환: 파일명.
 */
export async function generateSetupWorkbook(
  accountName: string,
  campaigns: SetupCampaign[],
  imageMap: SetupImageMap,
): Promise<string> {
  const usedNames = new Set<string>();
  const sheets = campaigns.map((c) => {
    const { data, columns, images } = buildCampaignSheet(c, imageMap);
    return { data, columns, images, showGridLines: false, sheet: sheetName(c.name, usedNames) };
  });

  const result = await writeXlsxFile(sheets, {
    fontFamily: "맑은 고딕",
    fontSize: 10,
  });
  const blob = await result.toBlob();

  const filename = `세팅안_${sanitizeFileName(accountName)}_${todayStamp()}.xlsx`;
  downloadBlob(blob, filename);
  return filename;
}
