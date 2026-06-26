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
import { type DateRange } from "@/lib/report-period";
import { openReportDatePicker } from "./report-datepicker";
import { closePopover } from "./multi-account";

let running = false;

function fmtDate(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
function safeFile(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

// ── 진행 오버레이 (setup.ts와 동일 CSS 클래스 재사용) ──
let overlayEl: HTMLElement | null = null;
let onProgressCancel: (() => void) | null = null;
let reportCancelled = false;
function showProgress(text: string, onCancel?: () => void): void {
  if (!overlayEl) {
    const el = document.createElement("div");
    el.className = "dvads dvads-auto-overlay";
    el.innerHTML = `<div class="dvads-auto-overlay-card"><button class="dvads-auto-overlay-cancel" type="button" aria-label="취소">×</button><div class="dvads-auto-overlay-spinner"></div><div class="dvads-auto-overlay-text"></div></div>`;
    el.querySelector(".dvads-auto-overlay-cancel")?.addEventListener("click", () => onProgressCancel?.());
    document.body.appendChild(el);
    overlayEl = el;
  }
  onProgressCancel = onCancel ?? null;
  const cancelBtn = overlayEl.querySelector<HTMLElement>(".dvads-auto-overlay-cancel");
  if (cancelBtn) cancelBtn.style.display = onCancel ? "" : "none";
  overlayEl.style.display = "";
  const t = overlayEl.querySelector<HTMLElement>(".dvads-auto-overlay-text");
  if (t) t.textContent = text;
}
function hideProgress(): void {
  if (overlayEl) overlayEl.style.display = "none";
  onProgressCancel = null;
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

// ── 단일 광고주 ──
export function openReportFlow(anchor: HTMLElement, target: ReportTarget): void {
  if (target.masterCustomerId == null) {
    showToast({ message: "이 계정 정보를 불러올 수 없어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
    return;
  }
  if (running) return;
  openReportDatePicker({
    anchor,
    subText: target.name,
    onConfirm: (range, author) => void runSingle(target, range, author),
  });
}

async function runSingle(target: ReportTarget, range: DateRange, author: string): Promise<void> {
  if (running) return;
  running = true;
  reportCancelled = false;
  closePopover(); // 진행 오버레이가 뜨면 다계정 대시보드 팝오버는 닫는다
  showProgress("리포트를 만드는 중...", () => { reportCancelled = true; hideProgress(); });
  try {
    const meta = { authorName: author, createdDate: fmtDate(new Date()) };
    const bytes = await buildReportBytes(target, range, meta);
    if (reportCancelled) return; // 취소됨 — 결과 폐기
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
export function openReportFlowBatch(anchor: HTMLElement, targets: ReportTarget[], anchorRect?: DOMRect): void {
  const valid = targets.filter((t) => t.masterCustomerId != null);
  if (valid.length === 0) {
    showToast({ message: "리포트를 만들 광고주를 선택해 주세요", variant: "error" });
    return;
  }
  if (running) return;
  openReportDatePicker({
    anchor,
    anchorRect,
    subText: `${valid.length}개 광고주`,
    onConfirm: (range, author) => void runBatch(valid, range, author),
  });
}

async function runBatch(targets: ReportTarget[], range: DateRange, author: string): Promise<void> {
  if (running) return;
  running = true;
  reportCancelled = false;
  const meta = { authorName: author, createdDate: fmtDate(new Date()) };
  const files: Record<string, Uint8Array> = {};
  let done = 0;
  closePopover(); // 진행 오버레이가 뜨면 다계정 대시보드 팝오버는 닫는다
  try {
    // 광고주 동시성 2 병렬 — 계정별 검색광고 수집이 겹쳐 돌고, 디스플레이 다운로드 POST는
    // report-gfa-detail의 전역 게이트가 403을 막는다(계정 간 7초 간격 유지).
    const REPORT_CONCURRENCY = 2;
    let next = 0;
    showProgress(`리포트를 만드는 중... (완료 0/${targets.length})`, () => { reportCancelled = true; hideProgress(); });
    const worker = async () => {
      while (next < targets.length && !reportCancelled) {
        const t = targets[next++];
        try {
          const bytes = await buildReportBytes(t, range, meta);
          files[`${safeFile(t.name)}_${range.since}~${range.until}.xlsx`] = bytes;
        } catch (e) {
          console.warn(`[dv-ads/report] ${t.name} 리포트 실패`, e);
        }
        done++;
        if (!reportCancelled) showProgress(`리포트를 만드는 중... (완료 ${done}/${targets.length})`, () => { reportCancelled = true; hideProgress(); });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(REPORT_CONCURRENCY, targets.length) }, worker),
    );
    if (reportCancelled) return; // 취소됨 — zip/다운로드 생략
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
