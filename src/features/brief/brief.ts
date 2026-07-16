/**
 * F-Brief — 광고주 보고 문구 생성 오케스트레이터 (콘텐츠 스크립트).
 *
 * F-MultiAccount popover 행 메뉴 "보고 문구"에서 진입. 계정 1개만(일괄은 범위 밖).
 * 기간 선택 → collectBriefData → 규칙 엔진 → 패널.
 *
 * 진행/취소 패턴은 report.ts와 동일 — 취소해도 진행 중 fetch는 못 멈추므로 토큰으로 무효화.
 * 진행 오버레이(showProgress/hideProgress)는 report.ts에서 import — 복제하면 DOM이 두 개 생긴다.
 * 단 취소 함수는 각자: report의 cancelRun은 report의 runToken을 올리므로 가져다 쓰면 안 된다.
 */

import { showToast } from "@/shared/toast";
import { friendlyApiError } from "@/shared/friendly-error";
import { type ReportTarget } from "@/features/report/report-build";
import { type DateRange } from "@/features/report/report-period";
import { openReportDatePicker } from "@/features/report/report-datepicker";
import { showProgress, hideProgress } from "@/features/report/report";
import { closePopover } from "@/features/multi-account/multi-account";
import { loadAllUserMeta } from "@/features/multi-account/multi-account-storage";
import { collectBriefData, buildSummaryText, buildSummarySpec } from "./brief-data";
import { extractCandidates } from "./brief-rules";
import { renderBriefPanel, type BriefBlock } from "./brief-panel";

let running = false;
let runToken = 0;

function cancelRun(): void {
  runToken++;
  running = false;
  hideProgress();
}

export function openBriefFlow(anchor: HTMLElement, target: ReportTarget): void {
  if (target.masterCustomerId == null) {
    showToast({ message: "이 계정 정보를 불러올 수 없어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
    return;
  }
  if (running) return;
  openReportDatePicker({
    anchor,
    subText: target.name,
    showAuthor: false, // 문구에 담당자명이 안 들어간다
    onConfirm: (range) => void run(target, range),
  });
}

async function run(target: ReportTarget, range: DateRange): Promise<void> {
  if (running) return;
  running = true;
  const token = ++runToken;
  const stale = () => token !== runToken;
  closePopover();
  showProgress("보고 문구를 만드는 중...", cancelRun);
  try {
    const metaMap = await loadAllUserMeta();
    const targetRoas = metaMap[target.adAccountNo]?.targetRoas;
    const data = await collectBriefData(target, range);
    if (stale()) return;

    const candidates = extractCandidates({
      keywords: [...data.plKeywords, ...data.shKeywords],
      placements: data.model.byPlacement,
      targetRoas,
    });

    // Task 10 전까지는 요약 + 후보별 표만. AI 문장은 아직 없다.
    const blocks: BriefBlock[] = [
      { type: "text", text: buildSummaryText(data) },
      { type: "table", spec: buildSummarySpec(data) },
    ];
    for (const c of candidates) {
      blocks.push({ type: "table", spec: c.table });
    }

    hideProgress();
    renderBriefPanel({
      advertiserName: target.name,
      blocks,
      // 토스트는 금방 사라져 안내로 부적합 — 패널 상단 고정 안내줄 (설계 §5).
      notice: targetRoas == null
        ? "목표 수익률을 설정하면 키워드 분류를 제안해요. 계정 메뉴의 \"목표 수익률\"에서 입력할 수 있어요"
        : undefined,
    });
  } catch (e) {
    console.warn("[dv-ads/brief] 보고 문구 생성 실패", e);
    if (stale()) return;
    hideProgress();
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    if (!stale()) running = false;
  }
}
