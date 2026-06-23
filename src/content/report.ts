/**
 * F-Report — 리포트 생성 UI 오케스트레이터 (콘텐츠 스크립트).
 *
 * F-MultiAccount popover 행 메뉴 "리포트 생성"(단일) + 설정 드롭다운(일괄)에서 진입.
 * 기간 프리셋 선택 + 담당자 입력 → advanced-report 실수집(report-build) → 양식 주입 → 다운로드.
 * 일괄은 fflate로 zip 1개로 묶어 다운로드. 전부 클라이언트 사이드, 외부 전송 0건.
 *
 * 디스플레이(GFA)는 분해 endpoint 미정찰이라 현재 검색광고만 채움(디스플레이 시트는 자동 제거).
 */

import { zipSync } from "fflate";
import { showToast } from "./toast";
import { friendlyApiError } from "@/lib/friendly-error";
import { buildReportBytes, type ReportTarget } from "@/lib/report-build";
import { rangeForPreset, PRESET_LABELS, type ReportPreset, type DateRange } from "@/lib/report-period";

let modalEl: HTMLElement | null = null;
let running = false;

const ORANGE = "#E6783B";
const PRESETS = Object.keys(PRESET_LABELS) as ReportPreset[];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
function safeFile(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

function closeModal(): void {
  modalEl?.remove();
  modalEl = null;
}

// ── 진행 오버레이 (setup.ts와 동일 CSS 클래스 재사용) ──
let overlayEl: HTMLElement | null = null;
function showProgress(text: string): void {
  if (!overlayEl) {
    const el = document.createElement("div");
    el.className = "dvads dvads-auto-overlay";
    el.innerHTML = `<div class="dvads-auto-overlay-card"><div class="dvads-auto-overlay-spinner"></div><div class="dvads-auto-overlay-text"></div></div>`;
    document.body.appendChild(el);
    overlayEl = el;
  }
  overlayEl.style.display = "";
  const t = overlayEl.querySelector<HTMLElement>(".dvads-auto-overlay-text");
  if (t) t.textContent = text;
}
function hideProgress(): void {
  if (overlayEl) overlayEl.style.display = "none";
}

function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── 기간 선택 모달 (프리셋 + 담당자) ──
// onConfirm(range, author)로 위임. 단일/일괄 공용.
function openPickerModal(titleText: string, subText: string, onConfirm: (range: DateRange, author: string) => void): void {
  if (modalEl || running) return;
  const today = new Date();
  let selected: ReportPreset = "lastWeek";

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-setup-backdrop";
  const modal = document.createElement("div");
  modal.className = "dvads-setup-modal";
  modal.style.maxWidth = "440px";
  modal.innerHTML = `
    <div class="dvads-setup-head">
      <div class="dvads-setup-title">${escapeHtml(titleText)}</div>
      <div class="dvads-setup-sub">${escapeHtml(subText)}</div>
      <button class="dvads-setup-close" type="button" aria-label="닫기">×</button>
    </div>
    <div class="dvads-setup-body" style="padding:16px 20px;">
      <label style="display:block;font-size:12px;color:#666;margin-bottom:6px;">담당자</label>
      <input class="dvads-report-author" type="text" placeholder="담당자명 (선택)"
        style="width:100%;height:32px;box-sizing:border-box;border:1px solid #ddd;border-radius:8px;padding:0 10px;font-size:13px;margin-bottom:14px;" />
      <label style="display:block;font-size:12px;color:#666;margin-bottom:6px;">기간</label>
      <div class="dvads-report-presets" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;"></div>
      <div class="dvads-report-range" style="margin-top:10px;font-size:12px;color:#888;text-align:center;"></div>
      <button class="dvads-report-go" type="button"
        style="margin-top:14px;width:100%;height:36px;border:0;border-radius:8px;background:${ORANGE};color:#fff;font-weight:600;font-size:14px;cursor:pointer;">리포트 생성</button>
    </div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modalEl = backdrop;

  const presetsBox = modal.querySelector<HTMLElement>(".dvads-report-presets")!;
  const rangeLabel = modal.querySelector<HTMLElement>(".dvads-report-range")!;
  const paint = () => {
    const r = rangeForPreset(selected, today);
    rangeLabel.textContent = `${r.since} ~ ${r.until}`;
    presetsBox.querySelectorAll<HTMLElement>("button").forEach((b) => {
      const on = b.dataset.preset === selected;
      b.style.background = on ? ORANGE : "#f5f5f5";
      b.style.color = on ? "#fff" : "#333";
      b.style.fontWeight = on ? "600" : "400";
    });
  };
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.preset = p;
    b.textContent = PRESET_LABELS[p];
    b.style.cssText = "height:30px;border:0;border-radius:8px;font-size:12px;cursor:pointer;";
    b.addEventListener("click", () => { selected = p; paint(); });
    presetsBox.appendChild(b);
  }
  paint();

  backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) closeModal(); });
  modal.querySelector(".dvads-setup-close")?.addEventListener("click", closeModal);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && modalEl) { e.preventDefault(); closeModal(); document.removeEventListener("keydown", onKey, true); }
  };
  document.addEventListener("keydown", onKey, true);

  modal.querySelector(".dvads-report-go")?.addEventListener("click", () => {
    const author = modal.querySelector<HTMLInputElement>(".dvads-report-author")?.value.trim() ?? "";
    const range = rangeForPreset(selected, today);
    closeModal();
    onConfirm(range, author);
  });
}

// ── 단일 광고주 ──
export function openReportFlow(target: ReportTarget): void {
  if (target.masterCustomerId == null) {
    showToast({ message: "이 계정 정보를 불러올 수 없어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
    return;
  }
  openPickerModal("리포트 생성", target.name, (range, author) => void runSingle(target, range, author));
}

async function runSingle(target: ReportTarget, range: DateRange, author: string): Promise<void> {
  if (running) return;
  running = true;
  showProgress("리포트를 만드는 중...");
  try {
    const meta = { authorName: author, createdDate: fmtDate(new Date()) };
    const bytes = await buildReportBytes(target, range, meta);
    const filename = `${safeFile(target.name)}_리포트_${range.since}~${range.until}.xlsx`;
    downloadBytes(bytes, filename);
    hideProgress();
    showToast({ message: "리포트를 내려받았어요", variant: "success", keyword: filename });
  } catch (e) {
    hideProgress();
    console.warn("[dv-ads/report] 리포트 생성 실패", e);
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    running = false;
  }
}

// ── 일괄 (여러 광고주 → zip 1개) ──
export function openReportFlowBatch(targets: ReportTarget[]): void {
  const valid = targets.filter((t) => t.masterCustomerId != null);
  if (valid.length === 0) {
    showToast({ message: "리포트를 만들 광고주를 선택해 주세요", variant: "error" });
    return;
  }
  openPickerModal("리포트 일괄 생성", `${valid.length}개 광고주`, (range, author) => void runBatch(valid, range, author));
}

async function runBatch(targets: ReportTarget[], range: DateRange, author: string): Promise<void> {
  if (running) return;
  running = true;
  const meta = { authorName: author, createdDate: fmtDate(new Date()) };
  const files: Record<string, Uint8Array> = {};
  let done = 0;
  try {
    for (const t of targets) {
      showProgress(`리포트를 만드는 중... (${done + 1}/${targets.length}) ${t.name}`);
      try {
        const bytes = await buildReportBytes(t, range, meta);
        files[`${safeFile(t.name)}_${range.since}~${range.until}.xlsx`] = bytes;
      } catch (e) {
        console.warn(`[dv-ads/report] ${t.name} 리포트 실패`, e);
      }
      done++;
    }
    const made = Object.keys(files).length;
    if (made === 0) throw new Error("생성된 리포트가 없어요");
    showProgress("압축하는 중...");
    const zip = zipSync(files, { level: 6, mtime: Date.UTC(1980, 0, 1) });
    downloadBytes(zip, `리포트_${range.since}~${range.until}_${made}개.zip`);
    hideProgress();
    showToast({ message: `리포트 ${made}개를 압축해 내려받았어요`, variant: "success" });
  } catch (e) {
    hideProgress();
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    running = false;
  }
}
