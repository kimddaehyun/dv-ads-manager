/**
 * F-Brief 패널 DOM — 블록 나열 + 블록별 복사.
 *
 * 카톡은 텍스트/이미지를 한 메시지에 못 붙인다. 그래서 "문구 하나 + 표 하나"가 아니라
 * 블록의 나열이고, 각 블록이 자기 복사 버튼을 갖는다(보고 로그의 문단-사진 1:1 구조).
 */

import { type BriefTableSpec, type BriefCandidate, type BriefAction } from "./brief-rules";
import { type BriefReportType, type BriefTone } from "./brief-history";
import { renderTablePng, copyTablePng } from "./brief-table";
import { showToast } from "@/shared/toast";
import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { createDropdown, closeAllOpenDropdowns } from "@/shared/ui-dropdown";
import { type BriefThresholds } from "./brief-rules";
import { resolveThresholds, SENSITIVITY_LABEL, type BriefSensitivity } from "./brief-thresholds";
import { distillTone } from "./brief-compose";
import { loadBriefTone, saveBriefTone } from "./brief-tone";

export interface BriefTextBlock {
  type: "text";
  text: string;
  /** AI가 창작한 액션 문장이면 true — 좌측 주황 선. */
  isAiJudgment?: boolean;
  /** 검산 실패 — 우리가 안 준 숫자가 있다. 차단하지 않고 배지만(오탐 있음, 판단은 AE). */
  numberWarning?: boolean;
}
export interface BriefTableBlock {
  type: "table";
  spec: BriefTableSpec;
}
export type BriefBlock = BriefTextBlock | BriefTableBlock;

export interface BriefPanelOpts {
  advertiserName: string;
  blocks: BriefBlock[];
  /** 머리글 아래 안내 한 줄 (예: 목표 수익률 미설정). 토스트는 금방 사라져 안내로 부적합. */
  notice?: string;
  /** "다시 고르기" — 재수집 없이 선택 화면으로 복귀. */
  onRepick?: () => void;
  /** 텍스트 블록 복사 시 호출 — 전 텍스트 블록의 현재 값(편집 반영)을 합쳐 넘긴다. 이력 저장용(설계 §7: 복사한 순간). */
  onCopyText?: (fullMessage: string) => void;
  /** "저장" — 복사 없이 이력만 저장(saved_only). */
  onSave?: (fullMessage: string) => void;
  /** 재생성 — toneOverride가 없으면 같은 옵션으로 다시. 편집분 유실 확인은 패널이 한다. */
  onRegenerate?: (toneOverride?: BriefTone) => void;
  /** "지난 보고" 버튼 클릭 — 이 계정의 저장된 보고 목록으로. */
  onShowHistory?: () => void;
}

const REGEN_BUTTONS: Array<{ label: string; tone?: BriefTone }> = [
  { label: "다시 생성" },
  { label: "더 짧게", tone: "short" },
  { label: "더 부드럽게", tone: "soft" },
  { label: "숫자 중심", tone: "numeric" },
];

let disposePanel: (() => void) | null = null;

export function closeBriefPanel(): void {
  disposePanel?.();
  disposePanel = null;
}

export function renderBriefPanel(opts: BriefPanelOpts): void {
  closeBriefPanel();

  // 미리보기 blob URL은 revoke하지 않으면 패널을 여닫을 때마다 PNG가 메모리에 쌓인다.
  // disposed 플래그는 닫힌 뒤 늦게 도착한 렌더가 URL을 만들거나 죽은 img에 붙는 것을 막는다.
  const objectUrls: string[] = [];
  let disposed = false;
  const textAreas: HTMLTextAreaElement[] = [];

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-brief-backdrop";

  const card = document.createElement("div");
  card.className = "dvads-brief-card";

  const head = document.createElement("div");
  head.className = "dvads-brief-head";
  head.textContent = `광고 성과 측정 - ${opts.advertiserName}`;
  card.appendChild(head);

  if (opts.notice) {
    const notice = document.createElement("div");
    notice.className = "dvads-brief-notice";
    notice.textContent = opts.notice;
    card.appendChild(notice);
  }

  // 재생성 버튼군 — 편집한 내용이 있으면 확인 후 진행(재생성은 텍스트를 덮어쓴다).
  const originalTexts: string[] = [];
  if (opts.onRegenerate) {
    const bar = document.createElement("div");
    bar.className = "dvads-brief-regen-bar";
    for (const rb of REGEN_BUTTONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "dvads-btn";
      b.textContent = rb.label;
      b.addEventListener("click", () => {
        const edited = textAreas.some((ta, i) => ta.value !== (originalTexts[i] ?? ta.value));
        if (edited && !window.confirm("다시 만들면 지금까지 수정한 내용이 사라져요. 계속할까요?")) return;
        opts.onRegenerate?.(rb.tone);
      });
      bar.appendChild(b);
    }
    card.appendChild(bar);
  }

  const body = document.createElement("div");
  body.className = "dvads-brief-body";

  for (const block of opts.blocks) {
    const wrap = document.createElement("div");
    wrap.className = "dvads-brief-block";

    if (block.type === "text") {
      // 주황 선(::before)은 textarea에 안 먹어 wrap에 붙인다.
      if (block.isAiJudgment) wrap.classList.add("dvads-brief-block-ai");
      const ta = document.createElement("textarea");
      ta.className = "dvads-brief-text";
      ta.value = block.text;
      // 내용에 맞춰 높이 — 스크롤바가 블록 안에 또 생기면 읽기 나쁘다.
      const fit = () => {
        ta.style.height = "auto";
        ta.style.height = `${ta.scrollHeight}px`;
      };
      ta.addEventListener("input", fit);
      textAreas.push(ta);
      originalTexts.push(block.text);
      wrap.appendChild(ta);

      if (block.numberWarning) {
        const warn = document.createElement("div");
        warn.className = "dvads-brief-warn";
        warn.textContent = "데이터에 없는 숫자가 있어요";
        wrap.appendChild(warn);
      }

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dvads-btn dvads-brief-copy";
      btn.textContent = "복사";
      btn.addEventListener("click", () => {
        // 편집된 현재 값을 복사한다. 주황 선은 CSS라 텍스트에 안 딸려간다.
        void navigator.clipboard.writeText(ta.value)
          .then(() => {
            showToast({ message: "문구를 복사했어요", variant: "success" });
            // 저장 시점 = 복사한 순간(설계 §7). 문구 전문은 전 텍스트 블록의 현재 값.
            opts.onCopyText?.(textAreas.map((t) => t.value).filter((v) => v.trim() !== "").join("\n\n"));
          })
          .catch(() => showToast({ message: "복사하지 못했어요. 직접 선택해 복사해 주세요", variant: "error" }));
      });
      wrap.appendChild(btn);
      body.appendChild(wrap);
      // attach 후에 높이를 재야 scrollHeight가 나온다(detached면 0).
      requestAnimationFrame(fit);
    } else {
      const img = document.createElement("img");
      img.className = "dvads-brief-img";
      img.alt = block.spec.title;
      wrap.appendChild(img);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dvads-btn dvads-brief-copy";
      btn.textContent = "이미지 복사";
      btn.addEventListener("click", () => {
        void copyTablePng(block.spec)
          .then(() => showToast({ message: "표 이미지를 복사했어요. 카카오톡에 붙여넣으세요", variant: "success" }))
          .catch((e) => {
            console.warn("[dv-ads/brief] 표 이미지 복사 실패", e);
            showToast({ message: "표 이미지를 복사하지 못했어요", variant: "error" });
          });
      });
      wrap.appendChild(btn);
      body.appendChild(wrap);

      // 미리보기 — 렌더 실패해도 복사 버튼은 살려둔다.
      void renderTablePng(block.spec)
        .then((blob) => {
          if (disposed) return; // 패널이 이미 닫힘 — URL을 만들지 않는다
          const url = URL.createObjectURL(blob);
          objectUrls.push(url);
          img.src = url;
        })
        .catch((e) => console.warn("[dv-ads/brief] 표 미리보기 실패", e));
    }
  }

  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  if (opts.onRepick) {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "dvads-btn";
    pick.textContent = "다시 고르기";
    pick.addEventListener("click", () => opts.onRepick?.());
    foot.appendChild(pick);
  }
  if (opts.onSave) {
    const save = document.createElement("button");
    save.type = "button";
    save.className = "dvads-btn";
    save.textContent = "저장";
    save.addEventListener("click", () => {
      opts.onSave?.(textAreas.map((t) => t.value).filter((v) => v.trim() !== "").join("\n\n"));
    });
    foot.appendChild(save);
  }
  if (opts.onShowHistory) {
    const hist = document.createElement("button");
    hist.type = "button";
    hist.className = "dvads-btn";
    hist.textContent = "지난 보고";
    hist.addEventListener("click", () => opts.onShowHistory?.());
    foot.appendChild(hist);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "dvads-btn dvads-btn-primary";
  close.textContent = "닫기";
  close.addEventListener("click", () => closeBriefPanel());
  foot.appendChild(close);
  card.appendChild(foot);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  // 카드 안에서 텍스트 드래그 → backdrop에서 mouseup 시 잘못 닫히는 것 방지.
  // 직접 구현 금지 — 이 헬퍼가 mousedown 시작 위치를 추적한다. (리스너는 backdrop에 붙어 같이 제거된다)
  wireBackdropDismiss(backdrop, () => closeBriefPanel());

  disposePanel = () => {
    disposed = true;
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls.length = 0;
    backdrop.remove();
  };
}

// ── 후보 선택 화면 (AE선택 모드) ─────────────────────────────────────────
//
// 체크한 후보만 서버로 간다. 액션은 항상 AI가 목록(raise/hold/...)에서 고른다 —
// 액션 지정 dropdown은 가독성 문제로 제거(2026-07-19), action은 비워서 보낸다.

/** 숫자 리스트 문자열을 한 줄 요약으로 — 길면 "가방, 지갑 외 3개"로 줄인다. */
function shortList(raw: unknown, count: unknown): string {
  const items = String(raw ?? "").split(", ").filter((s) => s !== "");
  if (items.length === 0) return "";
  const shown = items.slice(0, 2).join(", ");
  const rest = (typeof count === "number" ? count : items.length) - Math.min(items.length, 2);
  return rest > 0 ? `${shown} 외 ${rest}개` : shown;
}

function wonOf(v: unknown): string {
  return typeof v === "number" ? `${v.toLocaleString()}원` : "";
}

/** 후보 → 제목 + 데이터 한 줄. 긴 판정 문장 대신 "무엇인지 + 근거 수치"를 보여준다. */
export function pickRowText(c: BriefCandidate): { title: string; sub: string } {
  const f = c.facts;
  const join = (parts: Array<string | undefined>) => parts.filter((p) => p && p !== "").join(" · ");
  switch (c.kind) {
    case "pastActionFollowUp":
      return {
        title: `지난 조치 성과 추적 (${f["지난보고일"] ?? ""})`,
        sub: join([shortList(f["대상"], f["count"]), `수익률 ${f["당시수익률"]} → ${f["이번수익률"]}`]),
      };
    case "changeFollowUp":
      return {
        title: `변경 이후 성과 (${f["변경일"] ?? ""})`,
        sub: join([String(f["대상"] ?? ""), String(f["변경내용"] ?? ""), `평가 ${f["평가"] ?? ""}`]),
      };
    case "zeroConvKeyword":
      return { title: "전환 없는 키워드", sub: join([shortList(f["keywords"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "belowTargetKeyword":
      return { title: "목표 수익률 미달 키워드", sub: join([shortList(f["keywords"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "belowTargetGroup":
      return { title: "목표 수익률 미달 광고그룹", sub: join([shortList(f["groups"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "highRoasLowRank":
      return { title: "잘되는데 순위가 낮은 키워드", sub: join([shortList(f["keywords"], f["count"]), `평균 ${f["평균순위"]}위`]) };
    case "zeroConvPlacement":
      return { title: "전환 없는 지면", sub: join([shortList(f["placements"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "lowRoasPlacement":
      return { title: "수익률 낮은 지면", sub: join([shortList(f["placements"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "lowCtrAd":
      return { title: "클릭률 낮은 소재", sub: shortList(f["ads"], f["count"]) };
    case "productConvDrop":
      return { title: "전환 줄어든 상품", sub: join([shortList(f["products"], f["count"]), `매출 ${wonOf(f["매출감소합계"])} 감소`]) };
    case "genderBidSkew":
    case "ageBidSkew":
    case "deviceBidSkew":
    case "hourWeekdaySkew":
    case "regionBidSkew": {
      const dim = String(f["기준"] ?? "").split(" 간 ")[0] || "구간";
      return {
        title: `${dim} 효율 격차`,
        sub: `${f["좋은쪽"]} ${f["좋은쪽수익률"]} vs ${f["나쁜쪽"]} ${f["나쁜쪽수익률"]}`,
      };
    }
    default:
      return { title: String(f["기준"] ?? c.kind), sub: "" };
  }
}

// ── 이슈 유형별 시각 요소 — semantic state 색 + 16px stroke 아이콘 (DESIGN.md Selection Card) ──

const ICON_SVGS: Record<string, string> = {
  // 시계 — 이력 추적(지난 조치·변경 이후)
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  // 금지 원 — 전환 0 (돈만 나감)
  zero: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
  // 하락 화살표 — 목표 미달·성과 하락
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l7 7 4-4 7 7"/><path d="M21 11v6h-6"/></svg>',
  // 상승 화살표 — 기회(잘되는데 순위 낮음)
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l7-7 4 4 7-7"/><path d="M21 13V7h-6"/></svg>',
  // 좌우 분할 원 — 세그먼트 효율 격차 (잘되는 쪽 vs 안되는 쪽)
  skew: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" stroke="none" opacity=".18"/><circle cx="12" cy="12" r="9"/><path d="M12 3v18"/></svg>',
  // 커서 클릭 — 소재(클릭률)
  cursor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7 17 2.5-7.5L21 11z"/></svg>',
};

type PickVisual = { icon: keyof typeof ICON_SVGS; state: "error" | "warning" | "success" | "info" };

/** 후보 kind → 아이콘 + 상태 색. 없는 kind는 info 시계로 폴백. */
export function pickRowVisual(kind: string): PickVisual {
  switch (kind) {
    case "pastActionFollowUp":
    case "changeFollowUp":
      return { icon: "clock", state: "info" };
    case "zeroConvKeyword":
    case "zeroConvPlacement":
      return { icon: "zero", state: "error" };
    case "belowTargetKeyword":
    case "belowTargetGroup":
    case "lowRoasPlacement":
    case "productConvDrop":
      return { icon: "down", state: "warning" };
    case "highRoasLowRank":
      return { icon: "up", state: "success" };
    case "lowCtrAd":
      return { icon: "cursor", state: "warning" };
    case "genderBidSkew":
    case "ageBidSkew":
    case "deviceBidSkew":
    case "hourWeekdaySkew":
    case "regionBidSkew":
      return { icon: "skew", state: "info" };
    default:
      return { icon: "clock", state: "info" };
  }
}

/** 선택 화면의 전체 상태 — "다시 고르기" 복귀 시 그대로 복원한다. */
export interface BriefPickState {
  reportType: BriefReportType;
  tone: BriefTone;
  includePrevHistory: boolean;
  includeChangeHistory: boolean;
  memo: string;
  /** opts.candidates 기준 인덱스. */
  selectedIdx: number[];
  actions: Record<number, BriefAction | undefined>;
  /** 고급옵션 펼침 여부 — 이슈 기준 변경으로 화면을 다시 그릴 때 접히지 않게. */
  advOpen: boolean;
}

const REPORT_TYPE_OPTIONS: Array<{ value: BriefReportType; label: string }> = [
  { value: "post_action_report", label: "사후보고" },
  { value: "pre_action_proposal", label: "사전제안" },
];

const TONE_OPTIONS: Array<{ value: BriefTone; label: string }> = [
  { value: "detailed", label: "상세하게" },
  { value: "short", label: "짧게" },
  { value: "numeric", label: "숫자 중심" },
  { value: "soft", label: "부드럽게" },
  { value: "professional", label: "전문적으로" },
  { value: "friendly", label: "친근하게" },
];

/** 이슈 기준 직접 설정 입력 — 라벨은 비개발자 기준. */
const THRESHOLD_FIELDS: Array<{ key: keyof BriefThresholds; label: string; unit: string; step?: string }> = [
  { key: "costFloor", label: "이슈로 볼 최소 광고비", unit: "원" },
  { key: "skewRatio", label: "격차 기준 (좋은 쪽이 나쁜 쪽의 몇 배)", unit: "배", step: "0.1" },
  { key: "lowCtrPct", label: "낮은 클릭률 기준", unit: "%", step: "0.1" },
  { key: "adImpFloor", label: "소재 판단 최소 노출", unit: "회" },
  { key: "lowRankFloor", label: "낮은 순위 기준", unit: "위" },
  { key: "revenueDropFloor", label: "상품 매출 감소 기준", unit: "원" },
];

/** 토글로 묶여 숨겨질 수 있는 이력성 후보 kind. */
const PREV_HISTORY_KIND = "pastActionFollowUp";
const CHANGE_HISTORY_KIND = "changeFollowUp";

export interface BriefPickOpts {
  advertiserName: string;
  candidates: BriefCandidate[];
  /** 저장된 지난 보고가 1건 이상인지 — 없으면 "이전 보고 이력 포함" 비활성. */
  prevHistoryAvailable: boolean;
  /** 변경 이력 토글을 비활성해야 하는 이유(작업자 목록 없음 등). undefined면 활성. */
  changeDisabledReason?: string;
  /** 광고주별 저장 선호 등에서 온 초기값. selectedIdx 등은 "다시 고르기" 복귀용. */
  initial?: Partial<BriefPickState>;
  /** "보고문 만들기" — 체크된 후보(액션 반영됨)와 화면 상태 전체를 넘긴다. */
  onCompose: (selected: BriefCandidate[], state: BriefPickState) => void;
  /** 이슈 기준 — 고급옵션 안에서 바로 조정(다이얼로그 없음). 바꾸면 호출부가 후보를 다시 만든다. */
  thresholds?: {
    sensitivity: BriefSensitivity;
    custom: Partial<BriefThresholds>;
    /** 자동 보정 재료 — 이 기간 총광고비. */
    totalCost: number;
    onChange: (sensitivity: BriefSensitivity, custom: Partial<BriefThresholds>) => void;
  };
  /** "지난 보고" 버튼. */
  onShowHistory?: () => void;
}

/**
 * 펼침 영역 — 이 이슈의 근거가 된 실제 데이터. 후보가 이미 들고 있는 표를 그대로 그린다
 * (여기서 다시 계산하지 않는다 — 화면과 보고문의 숫자가 갈리면 안 된다).
 */
function buildPickDetail(pick: BriefCandidate): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dvads-brief-pick-detail-inner";

  const basis = pick.facts?.기준;
  if (typeof basis === "string") {
    const b = document.createElement("div");
    b.className = "dvads-brief-pick-detail-basis";
    b.textContent = `기준 - ${basis}`;
    wrap.appendChild(b);
  }

  if (!pick.table) {
    const none = document.createElement("div");
    none.className = "dvads-brief-pick-detail-basis";
    none.textContent = "이 항목은 표로 보여줄 데이터가 없어요";
    wrap.appendChild(none);
    return wrap;
  }

  const scroll = document.createElement("div");
  scroll.className = "dvads-brief-pick-detail-scroll";
  const table = document.createElement("table");
  table.className = "dvads-brief-pick-detail-table";
  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const c of pick.table.columns) {
    const th = document.createElement("th");
    th.textContent = c;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const r of pick.table.rows) {
    const tr = document.createElement("tr");
    if (r.band) tr.classList.add(`dvads-brief-band-${r.band}`);
    for (const cell of r.cells) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  return wrap;
}

export function renderBriefPickPanel(opts: BriefPickOpts): void {
  closeBriefPanel();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-brief-backdrop";
  const card = document.createElement("div");
  // 펼침 표가 들어가는 화면이라 결과 패널보다 넓게.
  card.className = "dvads-brief-card dvads-brief-card-wide";

  const head = document.createElement("div");
  head.className = "dvads-brief-head";
  head.append("광고 성과 측정 ");
  const headName = document.createElement("span");
  headName.className = "dvads-brief-head-name";
  headName.textContent = opts.advertiserName;
  head.appendChild(headName);
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "dvads-brief-body";

  const init = opts.initial ?? {};
  const state: BriefPickState = {
    reportType: init.reportType ?? "post_action_report",
    tone: init.tone ?? "detailed",
    includePrevHistory: init.includePrevHistory ?? opts.prevHistoryAvailable,
    includeChangeHistory:
      init.includeChangeHistory ??
      (opts.changeDisabledReason == null && opts.candidates.some((c) => c.kind === CHANGE_HISTORY_KIND)),
    memo: init.memo ?? "",
    selectedIdx: init.selectedIdx ?? [],
    actions: init.actions ?? {},
    advOpen: init.advOpen ?? false,
  };
  if (!opts.prevHistoryAvailable) state.includePrevHistory = false;
  if (opts.changeDisabledReason != null) state.includeChangeHistory = false;

  // ── 고급옵션(접힘): 보고 유형 / 톤 / 이력 토글 2개 / 설정 버튼들 ──
  const optWrap = document.createElement("div");
  optWrap.className = "dvads-brief-pick-options";

  const ddRow = document.createElement("div");
  ddRow.className = "dvads-brief-pick-opt-row";
  const typeLabel = document.createElement("span");
  typeLabel.textContent = "보고 유형";
  ddRow.appendChild(typeLabel);
  const typeDd = createDropdown<BriefReportType>({
    value: state.reportType,
    options: REPORT_TYPE_OPTIONS,
    ariaLabel: "보고 유형",
    width: 120,
    onChange: (v) => { state.reportType = v; },
  });
  ddRow.appendChild(typeDd.root);
  const toneLabel = document.createElement("span");
  toneLabel.textContent = "말투 톤";
  ddRow.appendChild(toneLabel);
  const toneDd = createDropdown<BriefTone>({
    value: state.tone,
    options: TONE_OPTIONS,
    ariaLabel: "말투 톤",
    width: 120,
    onChange: (v) => { state.tone = v; },
  });
  ddRow.appendChild(toneDd.root);
  optWrap.appendChild(ddRow);

  // 비활성 사유는 라벨에 이어붙이지 않고 아래 작은 줄로 — 라벨은 항상 짧게 유지.
  const makeToggle = (
    text: string,
    checked: boolean,
    disabledReason: string | undefined,
    onChange: (on: boolean) => void,
  ): HTMLElement => {
    const wrap = document.createElement("div");
    const row = document.createElement("label");
    row.className = "dvads-brief-pick-toggle";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked && disabledReason == null;
    cb.disabled = disabledReason != null;
    cb.addEventListener("change", () => onChange(cb.checked));
    row.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = text;
    row.appendChild(span);
    wrap.appendChild(row);
    if (disabledReason != null) {
      const sub = document.createElement("div");
      sub.className = "dvads-brief-pick-sub";
      sub.textContent = disabledReason;
      wrap.appendChild(sub);
    }
    return wrap;
  };

  const refreshRows = () => rowsByIdx.forEach((r) => r.refresh());

  optWrap.appendChild(makeToggle(
    "이전 보고 이력 포함",
    state.includePrevHistory,
    opts.prevHistoryAvailable ? undefined : "아직 저장된 지난 보고가 없어요",
    (on) => { state.includePrevHistory = on; refreshRows(); },
  ));
  optWrap.appendChild(makeToggle(
    "변경 이력 포함",
    state.includeChangeHistory,
    opts.changeDisabledReason,
    (on) => { state.includeChangeHistory = on; refreshRows(); },
  ));

  // ── 후보 목록 — 원본을 건드리지 않고 사본에 선택/액션을 기록. ──
  const picks = opts.candidates.map((c, i) => ({
    ...c,
    selected: state.selectedIdx.includes(i),
    action: state.actions[i],
  }));

  const rowsByIdx: Array<{ refresh: () => void }> = [];

  const updateComposeEnabled = () => {
    composeBtn.disabled = !picks.some((p) => p.selected && !isHiddenKind(p.kind));
    listHeadCount.textContent = `${picks.filter((p) => !isHiddenKind(p.kind)).length}개`;
  };
  const isHiddenKind = (kind: string): boolean =>
    (kind === PREV_HISTORY_KIND && !state.includePrevHistory) ||
    (kind === CHANGE_HISTORY_KIND && !state.includeChangeHistory);

  // 목록 소제목 — 몇 개 찾았고 몇 개 골랐는지, 스크롤 중에도 헷갈리지 않게.
  const listHead = document.createElement("div");
  listHead.className = "dvads-brief-pick-listhead";
  listHead.append("발견한 이슈 ");
  const listHeadCount = document.createElement("span");
  listHeadCount.className = "dvads-brief-pick-listhead-count";
  listHead.appendChild(listHeadCount);
  body.appendChild(listHead);

  const list = document.createElement("div");
  list.className = "dvads-brief-pick-list";

  picks.forEach((pick) => {
    // 행(선택) + 펼침 영역(실제 데이터)을 한 덩어리로 — 구분선은 덩어리 사이에만.
    const item = document.createElement("div");
    item.className = "dvads-brief-pick-item";

    item.classList.toggle("is-selected", pick.selected);

    const row = document.createElement("label");
    row.className = "dvads-brief-pick-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = pick.selected;
    cb.addEventListener("change", () => {
      pick.selected = cb.checked;
      item.classList.toggle("is-selected", cb.checked);
      updateComposeEnabled();
    });
    row.appendChild(cb);

    // 이슈 유형별 아이콘 칩 — 색이 곧 의미(error/warning/success/info)
    const visual = pickRowVisual(pick.kind);
    const iconEl = document.createElement("span");
    iconEl.className = `dvads-brief-pick-icon dvads-brief-pick-icon-${visual.state}`;
    iconEl.innerHTML = ICON_SVGS[visual.icon];
    row.appendChild(iconEl);

    const { title, sub } = pickRowText(pick);
    const main = document.createElement("span");
    main.className = "dvads-brief-pick-label";
    const titleEl = document.createElement("div");
    titleEl.className = "dvads-brief-pick-title";
    titleEl.textContent = title;
    main.appendChild(titleEl);
    if (sub) {
      const subEl = document.createElement("div");
      subEl.className = "dvads-brief-pick-data";
      subEl.textContent = sub;
      main.appendChild(subEl);
    }
    row.appendChild(main);

    // 아래 화살표 — 누르면 이 이슈의 실제 데이터(표)를 펼친다. 선택과는 별개 동작이라
    // label 안의 버튼 기본 동작(체크 토글)을 막는다.
    const detail = document.createElement("div");
    detail.className = "dvads-brief-pick-detail";
    const chev = document.createElement("button");
    chev.type = "button";
    chev.className = "dvads-brief-pick-chev";
    chev.setAttribute("aria-expanded", "false");
    chev.setAttribute("aria-label", "실제 데이터 보기");
    chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    let detailBuilt = false;
    chev.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!detailBuilt) {
        detailBuilt = true;
        detail.appendChild(buildPickDetail(pick));
      }
      const open = item.classList.toggle("is-expanded");
      chev.setAttribute("aria-expanded", open ? "true" : "false");
    });
    row.appendChild(chev);

    item.appendChild(row);
    item.appendChild(detail);
    list.appendChild(item);

    // 토글 off면 해당 이력성 후보는 숨김 + 체크 해제(보내면 안 된다).
    const refresh = () => {
      const hidden = isHiddenKind(pick.kind);
      item.style.display = hidden ? "none" : "";
      if (hidden && pick.selected) {
        pick.selected = false;
        cb.checked = false;
        item.classList.remove("is-selected");
      }
      updateComposeEnabled();
    };
    rowsByIdx.push({ refresh });
  });
  body.appendChild(list);

  // 고급옵션 안의 소제목 — 네이버는 항목마다 굵은 라벨 + 설명 한 줄.
  const addSubHead = (title: string, desc: string) => {
    const h = document.createElement("div");
    h.className = "dvads-brief-adv-sub";
    const t = document.createElement("div");
    t.className = "dvads-brief-adv-sub-title";
    t.textContent = title;
    h.appendChild(t);
    const d = document.createElement("div");
    d.className = "dvads-brief-pick-sub";
    d.style.margin = "2px 0 0";
    d.textContent = desc;
    h.appendChild(d);
    optWrap.appendChild(h);
  };

  // ── 이슈 기준 — 프리셋 칩 + 직접 설정, 다이얼로그 없이 여기서 바로. ──
  if (opts.thresholds) {
    const th = opts.thresholds;
    addSubHead("이슈 기준", "어느 정도 변화부터 이슈로 볼지 정합니다.");
    let sensitivity: BriefSensitivity = th.sensitivity;

    const chipRow = document.createElement("div");
    chipRow.className = "dvads-brief-preset-row";
    const customWrap = document.createElement("div");
    customWrap.style.marginTop = "8px";
    const inputs = new Map<keyof BriefThresholds, HTMLInputElement>();
    for (const f of THRESHOLD_FIELDS) {
      const row = document.createElement("div");
      row.className = "dvads-brief-custom-row";
      const label = document.createElement("span");
      label.textContent = f.label;
      row.appendChild(label);
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      if (f.step) input.step = f.step;
      input.className = "dvads-brief-custom-input";
      row.appendChild(input);
      const unit = document.createElement("span");
      unit.textContent = f.unit;
      unit.className = "dvads-brief-custom-unit";
      row.appendChild(unit);
      customWrap.appendChild(row);
      inputs.set(f.key, input);
    }
    // 직접 설정은 타이핑마다 목록을 다시 만들 수 없어(재계산) 적용 버튼으로 확정.
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "dvads-btn";
    applyBtn.style.marginTop = "8px";
    applyBtn.textContent = "기준 적용";
    applyBtn.addEventListener("click", () => {
      const custom: Partial<BriefThresholds> = {};
      for (const [key, input] of inputs) {
        const v = Number(input.value);
        if (Number.isFinite(v) && v > 0) custom[key] = v;
      }
      if (Object.keys(custom).length === 0) {
        showToast({ message: "기준값을 입력해 주세요", variant: "error" });
        return;
      }
      th.onChange("custom", custom);
    });
    customWrap.appendChild(applyBtn);

    const chips = (Object.keys(SENSITIVITY_LABEL) as BriefSensitivity[]).map((s) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "dvads-brief-preset-chip";
      chip.textContent = SENSITIVITY_LABEL[s];
      chip.addEventListener("click", () => {
        sensitivity = s;
        refreshThreshold();
        // 프리셋은 고르는 즉시 반영. 직접 설정만 값 입력 후 "기준 적용".
        if (s !== "custom") {
          th.onChange(s, {});
        }
      });
      chipRow.appendChild(chip);
      return { s, chip };
    });
    const refreshThreshold = () => {
      for (const { s, chip } of chips) chip.classList.toggle("is-on", s === sensitivity);
      customWrap.style.display = sensitivity === "custom" ? "" : "none";
      if (sensitivity === "custom") {
        const resolved = resolveThresholds({ sensitivity: "custom", custom: th.custom, totalCost: th.totalCost });
        for (const [key, input] of inputs) {
          if (input.value === "") input.value = String(resolved[key]);
        }
      }
    };
    optWrap.appendChild(chipRow);
    optWrap.appendChild(customWrap);
    refreshThreshold();
  }

  // ── 내 말투 — 채팅 붙여넣기 → 말투 규칙 생성 → 저장. 역시 여기서 바로. ──
  addSubHead("내 말투", "실제로 보냈던 보고 채팅을 붙여넣으면 그 말투로 씁니다.");
  const toneSamples = document.createElement("textarea");
  toneSamples.className = "dvads-brief-tone-ta";
  toneSamples.rows = 4;
  toneSamples.placeholder = "예) 안녕하세요:) 지난 30일 동안 ...";
  optWrap.appendChild(toneSamples);
  const tonePrompt = document.createElement("textarea");
  tonePrompt.className = "dvads-brief-tone-ta";
  tonePrompt.rows = 4;
  tonePrompt.style.marginTop = "8px";
  tonePrompt.placeholder = "\"말투 만들기\"를 누르면 여기에 말투 규칙이 생겨요. 직접 고칠 수 있어요";
  optWrap.appendChild(tonePrompt);
  const toneBtnRow = document.createElement("div");
  toneBtnRow.className = "dvads-brief-pick-setting-row";
  const makeToneBtn = document.createElement("button");
  makeToneBtn.type = "button";
  makeToneBtn.className = "dvads-btn";
  makeToneBtn.textContent = "말투 만들기";
  makeToneBtn.addEventListener("click", () => {
    const samples = toneSamples.value.trim();
    if (samples.length < 50) {
      showToast({ message: "채팅 이력을 조금 더 붙여넣어 주세요 (최소 두세 문장)", variant: "error" });
      return;
    }
    makeToneBtn.disabled = true;
    makeToneBtn.textContent = "만드는 중...";
    void distillTone(samples)
      .then((p) => { tonePrompt.value = p; })
      .catch((e) => showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" }))
      .finally(() => { makeToneBtn.disabled = false; makeToneBtn.textContent = "말투 만들기"; });
  });
  toneBtnRow.appendChild(makeToneBtn);
  const saveToneBtn = document.createElement("button");
  saveToneBtn.type = "button";
  saveToneBtn.className = "dvads-btn";
  saveToneBtn.textContent = "말투 저장";
  saveToneBtn.addEventListener("click", () => {
    const p = tonePrompt.value.trim();
    if (!p) {
      showToast({ message: "먼저 \"말투 만들기\"로 말투 규칙을 만들어 주세요", variant: "error" });
      return;
    }
    saveToneBtn.disabled = true;
    void saveBriefTone({ samples: toneSamples.value.trim(), tonePrompt: p })
      .then(() => showToast({ message: "말투를 저장했어요. 다음 보고부터 내 말투로 만들어져요", variant: "success" }))
      .catch((e) => showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" }))
      .finally(() => { saveToneBtn.disabled = false; });
  });
  toneBtnRow.appendChild(saveToneBtn);
  optWrap.appendChild(toneBtnRow);
  void loadBriefTone().then((rec) => {
    if (!rec) return;
    if (toneSamples.value === "") toneSamples.value = rec.samples;
    if (tonePrompt.value === "") tonePrompt.value = rec.tonePrompt;
  });

  // 지난 보고는 "설정"이 아니라 열람이라 화면 전환 — 버튼으로 남긴다.
  if (opts.onShowHistory) {
    addSubHead("지난 보고", "이 광고주에게 보냈던 지난 보고를 확인합니다.");
    const histRow = document.createElement("div");
    histRow.className = "dvads-brief-pick-setting-row";
    const hist = document.createElement("button");
    hist.type = "button";
    hist.className = "dvads-btn";
    hist.textContent = "지난 보고 보기";
    hist.addEventListener("click", () => opts.onShowHistory?.());
    histRow.appendChild(hist);
    optWrap.appendChild(histRow);
  }

  // 네이버 광고관리자 "고급옵션" 아코디언과 동일한 구조 — 제목+설명 줄 클릭으로 펼침.
  const adv = document.createElement("div");
  adv.className = "dvads-brief-adv";
  const advHead = document.createElement("button");
  advHead.type = "button";
  advHead.className = "dvads-brief-adv-head";
  adv.classList.toggle("is-open", state.advOpen);
  advHead.setAttribute("aria-expanded", state.advOpen ? "true" : "false");
  const advText = document.createElement("span");
  advText.className = "dvads-brief-adv-text";
  advText.innerHTML =
    '<span class="dvads-brief-adv-title">고급옵션</span>' +
    '<span class="dvads-brief-adv-desc">고급옵션에서는 보고 유형·말투, 포함할 이력, 이슈 기준을 설정/수정할 수 있습니다.</span>';
  advHead.appendChild(advText);
  const advChev = document.createElement("span");
  advChev.className = "dvads-brief-adv-chev";
  advChev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  advHead.appendChild(advChev);
  advHead.addEventListener("click", () => {
    const open = adv.classList.toggle("is-open");
    state.advOpen = open;
    advHead.setAttribute("aria-expanded", open ? "true" : "false");
  });
  adv.appendChild(advHead);
  adv.appendChild(optWrap);
  body.appendChild(adv);

  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dvads-btn";
  cancel.textContent = "닫기";
  cancel.addEventListener("click", () => closeBriefPanel());
  foot.appendChild(cancel);
  const composeBtn = document.createElement("button");
  composeBtn.type = "button";
  composeBtn.className = "dvads-btn dvads-btn-primary";
  composeBtn.textContent = "생성";
  composeBtn.addEventListener("click", () => {
    const selected = picks.filter((p) => p.selected && !isHiddenKind(p.kind));
    if (selected.length === 0) {
      showToast({ message: "말할 내용을 하나 이상 골라 주세요", variant: "error" });
      return;
    }
    state.selectedIdx = picks.map((p, i) => (p.selected ? i : -1)).filter((i) => i >= 0);
    state.actions = Object.fromEntries(picks.map((p, i) => [i, p.action]));
    closeBriefPanel();
    opts.onCompose(selected, state);
  });
  foot.appendChild(composeBtn);
  card.appendChild(foot);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  wireBackdropDismiss(backdrop, () => closeBriefPanel());

  // 첫 렌더 반영 — 토글 초기 off면 후보 숨김, 선택 0개면 만들기 비활성.
  rowsByIdx.forEach((r) => r.refresh());
  updateComposeEnabled(); // 후보가 0개면 위 루프가 비어 소제목이 안 채워진다.

  disposePanel = () => {
    closeAllOpenDropdowns();
    backdrop.remove();
  };
}
