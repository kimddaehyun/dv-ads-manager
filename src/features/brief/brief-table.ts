/**
 * F-Brief 분석 표 이미지 — BriefTableSpec을 canvas에 그려 PNG로.
 *
 * **캡처가 아니라 생성이다.** 표 데이터를 우리가 이미 갖고 있어 화면을 찍을 이유가 없다.
 * 스크롤에 안 잘리고, ads.naver.com DOM이 바뀌어도 무관하고, 색칠이 자동이다.
 * AE가 엑셀 열어서 손으로 칠하던 작업이 여기서 사라진다.
 *
 * 설계: docs/superpowers/specs/2026-07-16-f-brief-design.md §9
 */

import { type BriefTableSpec, type BriefTableRow, type RoasBand } from "./brief-rules";

/** 행 수 상한. 초과분은 "외 N개"로 접되 **잘린 사실을 표에 명시**한다(조용한 절단 금지). */
export const MAX_TABLE_ROWS = 20;

const PAD = 16;
const ROW_H = 30;
const HEAD_H = 34;
const TITLE_H = 34;
const FONT = "Pretendard, -apple-system, sans-serif";

// 행 배경 — DESIGN.md Semantic (State Colors)를 10% 투명도로 재사용.
// success #16a34a / warning #d97706. DV 주황은 쓰지 않는다(3% 규칙).
const BAND_BG: Record<RoasBand, string> = {
  green: "rgba(22, 163, 74, 0.10)",
  yellow: "rgba(217, 119, 6, 0.10)",
  none: "transparent",
};

/** 열 너비 — 각 열의 최장 텍스트를 실측해 정한다. 첫 열(라벨)은 넓게, 지표는 우측 정렬. */
function measureCols(ctx: CanvasRenderingContext2D, spec: BriefTableSpec, rows: BriefTableRow[]): number[] {
  const widths: number[] = [];
  for (let c = 0; c < spec.columns.length; c++) {
    ctx.font = `600 13px ${FONT}`;
    let max = ctx.measureText(spec.columns[c]).width;
    ctx.font = `400 13px ${FONT}`;
    for (const r of rows) {
      max = Math.max(max, ctx.measureText(r.cells[c] ?? "").width);
    }
    widths.push(Math.ceil(max) + 20);
  }
  return widths;
}

/** 상한 초과 시 비용 상위 MAX_TABLE_ROWS개 + "외 N개" 행. 잘린 사실을 표에 남긴다. */
function capRows(spec: BriefTableSpec): BriefTableRow[] {
  if (spec.rows.length <= MAX_TABLE_ROWS) return spec.rows;
  const kept = spec.rows.slice(0, MAX_TABLE_ROWS);
  const hidden = spec.rows.length - MAX_TABLE_ROWS;
  const filler = new Array(Math.max(0, spec.columns.length - 1)).fill("");
  kept.push({ cells: [`외 ${hidden}개`, ...filler] });
  return kept;
}

export async function renderTablePng(spec: BriefTableSpec): Promise<Blob> {
  // 폰트가 로드되기 전에 그리면 fallback 폰트로 그려져 폭 측정이 어긋난다.
  await document.fonts.ready;

  const rows = capRows(spec);
  const probe = document.createElement("canvas").getContext("2d");
  if (!probe) throw new Error("표 이미지를 만들지 못했어요");
  const cols = measureCols(probe, spec, rows);

  const w = PAD * 2 + cols.reduce((a, b) => a + b, 0);
  const h = PAD * 2 + TITLE_H + HEAD_H + rows.length * ROW_H;

  // 카톡에서 흐릿하지 않게 화면 배율만큼 크게 그린다.
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(w * dpr);
  canvas.height = Math.ceil(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("표 이미지를 만들지 못했어요");
  ctx.scale(dpr, dpr);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);

  // 제목
  ctx.fillStyle = "#171717";
  ctx.font = `600 16px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(spec.title, PAD, PAD + TITLE_H / 2);

  let y = PAD + TITLE_H;

  // 헤더
  ctx.fillStyle = "#f4f5f7";
  ctx.fillRect(PAD, y, w - PAD * 2, HEAD_H);
  ctx.fillStyle = "#171717";
  ctx.font = `600 13px ${FONT}`;
  let x = PAD;
  for (let c = 0; c < spec.columns.length; c++) {
    ctx.textAlign = c === 0 ? "left" : "right";
    ctx.fillText(spec.columns[c], c === 0 ? x + 10 : x + cols[c] - 10, y + HEAD_H / 2);
    x += cols[c];
  }
  y += HEAD_H;

  // 본문
  ctx.font = `400 13px ${FONT}`;
  for (const r of rows) {
    if (r.band && r.band !== "none") {
      ctx.fillStyle = BAND_BG[r.band];
      ctx.fillRect(PAD, y, w - PAD * 2, ROW_H);
    }
    ctx.fillStyle = "#171717";
    x = PAD;
    for (let c = 0; c < spec.columns.length; c++) {
      ctx.textAlign = c === 0 ? "left" : "right";
      ctx.fillText(r.cells[c] ?? "", c === 0 ? x + 10 : x + cols[c] - 10, y + ROW_H / 2);
      x += cols[c];
    }
    // 행 구분선
    ctx.strokeStyle = "#eef0f3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, y + ROW_H - 0.5);
    ctx.lineTo(w - PAD, y + ROW_H - 0.5);
    ctx.stroke();
    y += ROW_H;
  }

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("표 이미지를 만들지 못했어요"))), "image/png");
  });
}

/** 표를 PNG로 만들어 클립보드에. AE는 카카오톡에서 붙여넣기만 하면 된다. */
export async function copyTablePng(spec: BriefTableSpec): Promise<void> {
  const blob = await renderTablePng(spec);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
