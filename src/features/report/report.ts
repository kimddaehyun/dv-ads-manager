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
  buildReportBytes, buildReportBytesFromData, collectReportData, fetchSaCampaignList,
  type ReportCollectOptions, type ReportRenderOptions, type ReportTarget,
} from "@/features/report/report-build";
import { fetchGfaCampaignList } from "@/features/report/report-gfa";
import { type DateRange } from "@/features/report/report-period";
import {
  buildSummaryPayload, collectPrevKeywordMetrics, composeReportMessage, showReportMessageDialog,
  showReportMessagesDialog, type ReportMessageItem,
} from "./report-message";
import { openReportDatePicker } from "./report-datepicker";
import {
  openReportSettings, type ReportPickerSettings, type ReportSettingsHooks,
} from "./report-settings";
import {
  loadAllUserMeta, updateUserMeta, updateUserMetaMany, loadReportAuthor,
} from "@/features/multi-account/multi-account-storage";
import type { MultiAccountUserMeta } from "@/types/storage";
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
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── 계정별 리포트 설정 (MultiAccountUserMeta ↔ 설정 화면/수집 옵션 변환) ──
const DEFAULT_MINOR_RATIO = 0.005;

function settingsFromMeta(meta: MultiAccountUserMeta | undefined): ReportPickerSettings {
  return {
    author: meta?.reportAuthorName ?? "", // 계정별 담당자 — 미설정이면 훅/생성부가 공통값으로 채움
    minorRatio: meta?.reportMinorRatio ?? DEFAULT_MINOR_RATIO,
    targetRoas: meta?.targetRoas ?? null, // F-Brief와 공유 — 광고주당 목표는 하나
    showConvSplit: meta?.reportShowConvSplit ?? false, // 기본 끔 (2026-08-12, 명시 저장값만 존중)
    saCampaignIds: meta?.reportSaCampaignIds ?? null,
    gfaCampaignIds: meta?.reportGfaCampaignIds ?? null,
  };
}
function collectOptsFrom(s: ReportPickerSettings): ReportCollectOptions {
  return { minorRatio: s.minorRatio, saCampaignIds: s.saCampaignIds, gfaCampaignIds: s.gfaCampaignIds };
}
function renderOptsFrom(s: ReportPickerSettings): ReportRenderOptions {
  return { showConvSplit: s.showConvSplit };
}

// 설정 flyout(report-settings)이 쓸 저장/조회/캠페인 목록 훅. 기본값은 키 제거로 저장해 깔끔하게 유지.
// updateUserMeta는 전체 meta를 읽고-고치고-쓰는 구조라, 연속 변경(접기 기준 → 토글)을 병렬로
// 보내면 나중 쓰기가 먼저 것의 필드를 되돌린다 — 체인으로 직렬화 (codex P2, 2026-08-07).
// 모듈 레벨인 이유: 설정 flyout 분리 후 생성이 저장소에서 설정을 읽는데, 설정 변경 직후
// 바로 생성하면 저장(서버 왕복) 완료 전에 읽어 직전 변경이 빠진다 — 생성 시작 시 이 체인을
// 기다려 경합 제거 (codex P2, 2026-08-10). 체인은 링크마다 catch라 reject 없음.
let settingsSaveChain: Promise<unknown> = Promise.resolve();

// 설정 patch → meta patch 변환 + 저장 체인 등록. 단일(updateUserMeta)/일괄(updateUserMetaMany) 공용.
// 담당자(author)도 계정별(meta.reportAuthorName) — 빈 값 저장 = 키 제거(공통값 fallback 복귀).
function queueSettingsSave(adAccountNos: number[], patch: Partial<ReportPickerSettings>): void {
  const metaPatch: Partial<Omit<MultiAccountUserMeta, "adAccountNo">> = {};
  if ("author" in patch) metaPatch.reportAuthorName = patch.author || undefined;
  if ("minorRatio" in patch) {
    metaPatch.reportMinorRatio = patch.minorRatio === DEFAULT_MINOR_RATIO ? undefined : patch.minorRatio;
  }
  if ("targetRoas" in patch) metaPatch.targetRoas = patch.targetRoas ?? undefined;
  if ("showConvSplit" in patch) metaPatch.reportShowConvSplit = patch.showConvSplit;
  if ("saCampaignIds" in patch) metaPatch.reportSaCampaignIds = patch.saCampaignIds ?? undefined;
  if ("gfaCampaignIds" in patch) metaPatch.reportGfaCampaignIds = patch.gfaCampaignIds ?? undefined;
  // 실패해도 flyout의 표시는 그대로 — 저장만 다음 기회로.
  settingsSaveChain = settingsSaveChain
    .then(async () => {
      if (Object.keys(metaPatch).length === 0) return;
      if (adAccountNos.length === 1) await updateUserMeta(adAccountNos[0], metaPatch);
      else await updateUserMetaMany(adAccountNos, metaPatch);
    })
    .catch((e) => console.warn("[dv-ads/report] 리포트 설정 저장 실패", e));
}

function settingsHooksFor(target: ReportTarget): ReportSettingsHooks {
  return {
    load: async () => {
      const [meta, fallbackAuthor] = await Promise.all([loadAllUserMeta(), loadReportAuthor()]);
      const s = settingsFromMeta(meta[target.adAccountNo]);
      return { ...s, author: s.author || fallbackAuthor }; // 계정별 값 우선, 없으면 공통값
    },
    save: (patch) => queueSettingsSave([target.adAccountNo], patch),
    loadCampaigns: async () => {
      const cid = target.masterCustomerId;
      if (cid == null) throw new Error("계정 정보를 불러올 수 없어요");
      // 목록 조회 기간(GFA dashboard가 기간 필수) — 최근 30일이면 운영 중 캠페인은 다 잡힌다.
      const today = new Date();
      const since = new Date(today);
      since.setDate(since.getDate() - 29);
      const range: DateRange = { since: isoDate(since), until: isoDate(today) };
      const [sa, gfa] = await Promise.all([
        fetchSaCampaignList(cid),
        // GFA 미운영 계정은 실패/빈 응답이 정상 — 검색광고 목록만이라도 보여준다.
        fetchGfaCampaignList(target.adAccountNo, cid, range).catch(() => []),
      ]);
      return { sa, gfa };
    },
  };
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
    toggleKey: `report-gen:${target.adAccountNo}`, // 메뉴 재클릭 토글(anchor는 클릭마다 새 proxy)
    showAuthor: false, // 담당자는 리포트 설정으로 이동 (2026-08-12) — 저장값을 생성 시 읽는다
    showMessageToggle: true,
    onConfirm: (range, _author, _roas, withMessage) =>
      void runSingle(target, range, withMessage),
  });
}

// ── 리포트 설정 (행 메뉴 "리포트 설정" → flyout, 계정별 저장) ──
export function openReportSettingsFlow(anchor: HTMLElement, target: ReportTarget): void {
  if (target.masterCustomerId == null) {
    showToast({ message: "이 계정 정보를 불러올 수 없어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
    return;
  }
  openReportSettings({
    anchor,
    subText: target.name,
    toggleKey: `report-settings:${target.adAccountNo}`, // 메뉴 재클릭 토글(anchor는 클릭마다 새 proxy)
    hooks: settingsHooksFor(target),
  });
}

// 여러 계정 일괄 설정 — 캠페인 선택은 계정마다 달라 제외(담당자/분류 기준/직간접만).
// 값이 계정마다 다르면 기본값으로 보여주고, 사용자가 바꾼 항목만 전 계정에 저장된다.
export function openReportSettingsFlowBatch(
  anchor: HTMLElement, targets: ReportTarget[], anchorRect?: DOMRect, subText?: string,
): void {
  if (targets.length === 0) {
    showToast({ message: "설정할 광고주를 선택해 주세요", variant: "error" });
    return;
  }
  const nos = targets.map((t) => t.adAccountNo);
  const common = <T,>(vals: T[], fallback: T): T =>
    vals.every((v) => v === vals[0]) ? vals[0] : fallback;
  openReportSettings({
    anchor,
    anchorRect,
    subText: subText ?? `${targets.length}개 광고주`,
    toggleKey: `report-settings-batch:${[...nos].sort((a, b) => a - b).join(",")}`,
    showCampaigns: false,
    hooks: {
      load: async () => {
        const [meta, fallbackAuthor] = await Promise.all([loadAllUserMeta(), loadReportAuthor()]);
        const list = nos.map((no) => settingsFromMeta(meta[no]));
        return {
          // 계정별 실제 표기값(미설정은 공통값)이 전부 같으면 그 값, 다르면 빈 칸.
          author: common(list.map((s) => s.author || fallbackAuthor), ""),
          minorRatio: common(list.map((s) => s.minorRatio), DEFAULT_MINOR_RATIO),
          targetRoas: common(list.map((s) => s.targetRoas), null),
          showConvSplit: common(list.map((s) => s.showConvSplit), false),
          saCampaignIds: null,
          gfaCampaignIds: null,
        };
      },
      save: (patch) => queueSettingsSave(nos, patch),
      loadCampaigns: async () => ({ sa: [], gfa: [] }), // showCampaigns=false — 호출되지 않음
    },
  });
}

async function runSingle(
  target: ReportTarget, range: DateRange, withMessage: boolean,
): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken; // 취소됐거나 새 실행이 시작됨
  closePopover(); // 진행 오버레이가 뜨면 다계정 대시보드 팝오버는 닫는다
  showProgress("리포트를 만드는 중...", cancelRun);
  try {
    // 계정별 리포트 설정 — 행 메뉴 "리포트 설정"에서 저장해 둔 값을 읽어 적용(읽기 실패 시 기본값).
    // 진행 중인 설정 저장이 있으면 먼저 기다린다 — 직전 변경 누락 경합 방지.
    await settingsSaveChain;
    const s = settingsFromMeta(
      (await loadAllUserMeta().catch(() => ({}) as Awaited<ReturnType<typeof loadAllUserMeta>>))[
        target.adAccountNo
      ],
    );
    // 담당자는 리포트 설정으로 이동(2026-08-12) — 계정별 값, 미설정이면 공통값(reportAuthor).
    const author = (s.author || (await loadReportAuthor().catch(() => ""))).trim();
    const meta = { authorName: author, createdDate: fmtDate(new Date()) };
    // 문구 포함이면 수집 결과를 엑셀 렌더와 문구 조립이 공유한다(수집 2회 방지).
    // 이전 기간 키워드(지난 조치 효과 비교)는 문구 생성 시에만 — 본 수집과 병렬 출발, 실패 시 null.
    // 캠페인 선택 필터도 본 수집과 동일하게 적용.
    const prevKwP = withMessage && target.masterCustomerId != null && s.saCampaignIds?.length !== 0
      ? collectPrevKeywordMetrics(target.masterCustomerId, range, s.saCampaignIds)
      : null;
    const data = withMessage ? await collectReportData(target, range, meta, collectOptsFrom(s)) : null;
    const bytes = data
      ? await buildReportBytesFromData(data, renderOptsFrom(s))
      : await buildReportBytes(target, range, meta, collectOptsFrom(s), renderOptsFrom(s));
    if (stale()) return; // 결과 폐기 — 오버레이·running은 취소/새 실행이 이미 처리
    const filename = `${safeFile(target.name)}_리포트_${range.since}~${range.until}.xlsx`;
    downloadBytes(bytes, filename);
    trackUsage("report_excel");
    if (data) {
      showProgress("리포트 문구를 만드는 중...", cancelRun);
      try {
        const message = await composeReportMessage(buildSummaryPayload(target.name, data, range, await prevKwP, s.targetRoas));
        if (stale()) return;
        hideProgress();
        showToast({ message: "리포트를 내려받았어요", variant: "success", keyword: filename });
        showReportMessageDialog(target.name, message);
      } catch (e) {
        // 엑셀은 이미 내려받았다 — 문구 실패만 안내하고 성공 흐름으로 마무리.
        // 에러 토스트만 띄우면 전체가 실패한 걸로 오인한다 — 내려받음 안내를 먼저 (runBatch와 동일 패턴).
        console.warn("[dv-ads/report] 안내 문구 생성 실패", e);
        if (stale()) return;
        hideProgress();
        showToast({ message: "리포트를 내려받았어요", variant: "success", keyword: filename });
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
export function openReportFlowBatch(
  anchor: HTMLElement, targets: ReportTarget[], anchorRect?: DOMRect, subText?: string,
): void {
  const valid = targets.filter((t) => t.masterCustomerId != null);
  if (valid.length === 0) {
    showToast({ message: "리포트를 만들 광고주를 선택해 주세요", variant: "error" });
    return;
  }
  if (running) return;
  openReportDatePicker({
    anchor,
    anchorRect,
    // 넘어온 라벨(그룹명+개수)은 대상 수가 그대로일 때만 — 계정 정보 없는 광고주가 걸러졌으면
    // 실제 생성 수와 어긋나므로 기본 문구로 되돌린다 (codex P2, 2026-08-12).
    subText: (subText && valid.length === targets.length) ? subText : `${valid.length}개 광고주`,
    toggleKey: "report-gen-batch", // 일괄 메뉴 재클릭 토글
    showAuthor: false, // 담당자는 리포트 설정으로 이동 (2026-08-12)
    showMessageToggle: true,
    onConfirm: (range, _author, _roas, withMessage) => void runBatch(valid, range, withMessage),
  });
}

async function runBatch(targets: ReportTarget[], range: DateRange, withMessage: boolean): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken;
  // 담당자는 계정별 값 우선, 미설정 계정은 공통값(reportAuthor) — 계정별 meta는 worker에서.
  const fallbackAuthor = (await loadReportAuthor().catch(() => "")).trim();
  const createdDate = fmtDate(new Date());
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
    // 동명 계정이 있으면 zip 키가 같아 조용히 덮어써 파일이 사라진다 — 겹칠 때만 계정번호로 구분.
    const nameCount = new Map<string, number>();
    for (const t of targets) {
      const k = safeFile(t.name);
      nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
    }
    const fileBase = (t: ReportTarget) => {
      const k = safeFile(t.name);
      return (nameCount.get(k) ?? 1) > 1 ? `${k}_${t.adAccountNo}` : k;
    };
    showProgress(`리포트를 만드는 중... (0/${targets.length})`, cancelRun);
    // 일괄 생성에도 각 계정의 저장된 리포트 설정(접기 기준/캠페인 선택/직간접 표기)을 개별 적용.
    // 진행 중인 설정 저장이 있으면 먼저 기다린다 — 직전 변경 누락 경합 방지.
    await settingsSaveChain;
    const allMeta = await loadAllUserMeta().catch(() => ({}) as Awaited<ReturnType<typeof loadAllUserMeta>>);
    const worker = async () => {
      // 취소되면 남은 광고주는 시작도 안 한다(진행 중인 것만 흘려보냄).
      while (next < targets.length && !stale()) {
        const t = targets[next++];
        const s = settingsFromMeta(allMeta[t.adAccountNo]);
        const meta = { authorName: (s.author || fallbackAuthor).trim(), createdDate };
        try {
          if (withMessage) {
            // 수집 결과를 엑셀과 문구가 공유. 문구 실패는 엑셀을 막지 않는다(txt만 빠짐).
            const prevKwP = t.masterCustomerId != null && s.saCampaignIds?.length !== 0
              ? collectPrevKeywordMetrics(t.masterCustomerId, range, s.saCampaignIds)
              : null;
            const data = await collectReportData(t, range, meta, collectOptsFrom(s));
            files[`${fileBase(t)}_${range.since}~${range.until}.xlsx`] = await buildReportBytesFromData(data, renderOptsFrom(s));
            try {
              const message = await composeReportMessage(buildSummaryPayload(t.name, data, range, await prevKwP, s.targetRoas));
              files[`${fileBase(t)}_리포트문구.txt`] = strToU8(message);
              messages.push({ name: t.name, text: message });
            } catch (e) {
              console.warn(`[dv-ads/report] ${t.name} 안내 문구 실패`, e);
              msgFailed++;
            }
          } else {
            files[`${fileBase(t)}_${range.since}~${range.until}.xlsx`] =
              await buildReportBytes(t, range, meta, collectOptsFrom(s), renderOptsFrom(s));
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
