/**
 * F-Report — 리포트 생성 UI 오케스트레이터 (콘텐츠 스크립트).
 *
 * F-MultiAccount popover 행 메뉴 "리포트 생성"(단일) + 설정 드롭다운(일괄)에서 진입.
 * 기간 프리셋 선택 + 담당자 입력 → advanced-report 실수집(report-build) → 양식 주입 → 다운로드.
 * 일괄은 fflate로 zip 1개로 묶어 다운로드. 전부 클라이언트 사이드, 외부 전송 0건.
 *
 * 디스플레이(GFA)는 분해 endpoint 미정찰이라 현재 검색광고만 채움(디스플레이 시트는 자동 제거).
 */

import { zipSync, strToU8 } from "fflate";
import { showToast } from "@/shared/toast";
import { trackUsage } from "@/shared/usage";
import { friendlyApiError } from "@/shared/friendly-error";
import {
  buildReportBytes, buildReportBytesFromData, collectReportData, type ReportTarget,
} from "@/features/report/report-build";
import { type DateRange } from "@/features/report/report-period";
import {
  buildSummaryPayload, collectPrevKeywordMetrics, composeReportMessage, showReportMessageDialog,
  showReportMessagesDialog, type ReportMessageItem,
} from "./report-message";
import { openReportDatePicker } from "./report-datepicker";
import { closePopover } from "@/features/multi-account/multi-account";

// running = 실행 중 재진입 차단. runToken = 실행 식별자.
// 취소해도 진행 중인 수집(fetch)은 못 멈춘다. 예전엔 취소 후에도 그게 끝날 때까지(수십 초)
// running이 true로 남아 "리포트 생성"을 눌러도 조용히 무시됐다. 이제 취소가 running을 즉시 풀고,
// **토큰**으로 옛 실행을 무효화한다 — 단순히 running만 풀면 늦게 끝난 옛 실행이 파일을 내려받거나
// 새 실행의 running을 꺼버린다(reportCancelled 불리언 하나로는 새 실행이 그 값을 리셋해 못 막음).
let running = false;
let runToken = 0;

function fmtDate(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
function safeFile(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
}

// ── 진행 오버레이 (setup.ts와 동일 CSS 클래스 재사용) ──
let overlayEl: HTMLElement | null = null;
let onProgressCancel: (() => void) | null = null;

// 취소 — 지금 실행을 무효화하고 즉시 재시도 가능하게. 진행 중 fetch는 계속 돌지만 결과는 버려진다.
function cancelRun(): void {
  runToken++;
  running = false;
  hideProgress();
}
// export: F-Brief(brief.ts)와 공유 — 복제하면 진행 오버레이 DOM이 두 개 생긴다.
// cancelRun은 export하지 않는다 — 이 파일의 runToken을 올리는 함수라, brief가 가져다 쓰면
// 자기 실행 대신 리포트 실행을 취소한다. 취소 함수는 각자 자기 토큰으로 만들 것.
export function showProgress(text: string, onCancel?: () => void): void {
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
  // "backdrop" 마커 — scroll-lock.ts의 셀렉터에 걸려 배경 스크롤이 잠긴다 (스타일 없음).
  overlayEl.classList.add("dvads-progress-backdrop");
  const t = overlayEl.querySelector<HTMLElement>(".dvads-auto-overlay-text");
  if (t) t.textContent = text;
}
export function hideProgress(): void {
  if (overlayEl) {
    overlayEl.style.display = "none";
    overlayEl.classList.remove("dvads-progress-backdrop");
  }
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
    // 문구 포함 생성 = 담당자명 옆 토글로 선택 (2026-07-21, 드롭다운 방식 폐기).
    showMessageToggle: true,
    onConfirm: (range, author, _roas, withMessage) => void runSingle(target, range, author, withMessage),
  });
}

async function runSingle(target: ReportTarget, range: DateRange, author: string, withMessage: boolean): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken; // 취소됐거나 새 실행이 시작됨
  closePopover(); // 진행 오버레이가 뜨면 다계정 대시보드 팝오버는 닫는다
  showProgress("리포트를 만드는 중...", cancelRun);
  try {
    const meta = { authorName: author, createdDate: fmtDate(new Date()) };
    // 문구 포함이면 수집 결과를 엑셀 렌더와 문구 조립이 공유한다(수집 2회 방지).
    // 이전 기간 키워드(지난 조치 효과 비교)는 문구 생성 시에만 — 본 수집과 병렬 출발, 실패 시 null.
    const prevKwP = withMessage && target.masterCustomerId != null
      ? collectPrevKeywordMetrics(target.masterCustomerId, range)
      : null;
    const data = withMessage ? await collectReportData(target, range, meta) : null;
    const bytes = data ? await buildReportBytesFromData(data) : await buildReportBytes(target, range, meta);
    if (stale()) return; // 결과 폐기 — 오버레이·running은 취소/새 실행이 이미 처리
    const filename = `${safeFile(target.name)}_리포트_${range.since}~${range.until}.xlsx`;
    downloadBytes(bytes, filename);
    trackUsage("report_excel");
    if (data) {
      showProgress("리포트 문구를 만드는 중...", cancelRun);
      try {
        const message = await composeReportMessage(buildSummaryPayload(target.name, data, range, await prevKwP));
        if (stale()) return;
        hideProgress();
        showToast({ message: "리포트를 내려받았어요", variant: "success", keyword: filename });
        showReportMessageDialog(target.name, message);
      } catch (e) {
        // 엑셀은 이미 내려받았다 — 문구 실패만 안내하고 성공 흐름으로 마무리.
        console.warn("[dv-ads/report] 안내 문구 생성 실패", e);
        if (stale()) return;
        hideProgress();
        showToast({ message: e instanceof Error ? e.message : "리포트 문구를 만들지 못했어요", variant: "error" });
      }
      return;
    }
    hideProgress();
    showToast({ message: "리포트를 내려받았어요", variant: "success", keyword: filename });
  } catch (e) {
    console.warn("[dv-ads/report] 리포트 생성 실패", e);
    if (stale()) return; // 취소한 실행의 에러로 새 실행의 오버레이를 지우면 안 된다
    hideProgress();
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    if (!stale()) running = false; // 새 실행이 잡은 running을 옛 실행이 풀지 않게
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
    showMessageToggle: true,
    onConfirm: (range, author, _roas, withMessage) => void runBatch(valid, range, author, withMessage),
  });
}

async function runBatch(targets: ReportTarget[], range: DateRange, author: string, withMessage: boolean): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken;
  const meta = { authorName: author, createdDate: fmtDate(new Date()) };
  const files: Record<string, Uint8Array> = {};
  // 문구는 zip의 txt에 더해 다이얼로그로도 보여준다(단일 생성과 동일 UX). 실패 광고주는 따로 센다.
  const messages: ReportMessageItem[] = [];
  let msgFailed = 0;
  let done = 0;
  closePopover(); // 진행 오버레이가 뜨면 다계정 대시보드 팝오버는 닫는다
  try {
    // 광고주 동시성 2 병렬 — 계정별 검색광고 수집이 겹쳐 돌고, 디스플레이 다운로드 POST는
    // report-gfa-detail의 전역 게이트(기본 1초, 403 시 7초 복귀)가 간격을 관리한다.
    const REPORT_CONCURRENCY = 2;
    let next = 0;
    showProgress(`리포트를 만드는 중... (0/${targets.length})`, cancelRun);
    const worker = async () => {
      // 취소되면 남은 광고주는 시작도 안 한다(진행 중인 것만 흘려보냄).
      while (next < targets.length && !stale()) {
        const t = targets[next++];
        try {
          if (withMessage) {
            // 수집 결과를 엑셀과 문구가 공유. 문구 실패는 엑셀을 막지 않는다(txt만 빠짐).
            const prevKwP = t.masterCustomerId != null
              ? collectPrevKeywordMetrics(t.masterCustomerId, range)
              : null;
            const data = await collectReportData(t, range, meta);
            files[`${safeFile(t.name)}_${range.since}~${range.until}.xlsx`] = await buildReportBytesFromData(data);
            try {
              const message = await composeReportMessage(buildSummaryPayload(t.name, data, range, await prevKwP));
              files[`${safeFile(t.name)}_리포트문구.txt`] = strToU8(message);
              messages.push({ name: t.name, text: message });
            } catch (e) {
              console.warn(`[dv-ads/report] ${t.name} 안내 문구 실패`, e);
              msgFailed++;
            }
          } else {
            files[`${safeFile(t.name)}_${range.since}~${range.until}.xlsx`] = await buildReportBytes(t, range, meta);
          }
        } catch (e) {
          console.warn(`[dv-ads/report] ${t.name} 리포트 실패`, e);
        }
        done++;
        if (!stale()) showProgress(`리포트를 만드는 중... (${done}/${targets.length})`, cancelRun);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(REPORT_CONCURRENCY, targets.length) }, worker),
    );
    if (stale()) return; // 취소됨 — zip/다운로드 생략
    // 문구 txt는 부속물 — 개수 집계·성공 판정은 엑셀 기준.
    const made = Object.keys(files).filter((f) => f.endsWith(".xlsx")).length;
    if (made === 0) throw new Error("생성된 리포트가 없어요");
    showProgress("압축하는 중...");
    const zip = zipSync(files, { level: 6, mtime: Date.UTC(1980, 0, 1) });
    downloadBytes(zip, `리포트_${range.since}~${range.until}_${made}개.zip`);
    trackUsage("report_excel");
    hideProgress();
    showToast({ message: `리포트 ${made}개를 압축해 내려받았어요`, variant: "success" });
    if (withMessage) {
      // 계정 이름순으로 정렬 — 병렬 수집이라 완료 순서가 매번 다르다.
      messages.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      if (messages.length > 0) showReportMessagesDialog(messages);
      if (msgFailed > 0) {
        showToast({
          message: `광고주 ${msgFailed}곳의 리포트 문구는 만들지 못했어요. 잠시 후 다시 시도해 주세요`,
          variant: "error",
        });
      }
    }
  } catch (e) {
    console.warn("[dv-ads/report] 일괄 리포트 실패", e);
    if (stale()) return;
    hideProgress();
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    if (!stale()) running = false;
  }
}
