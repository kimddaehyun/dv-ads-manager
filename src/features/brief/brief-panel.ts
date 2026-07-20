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
  head.textContent = `보고 문구 - ${opts.advertiserName}`;
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
  // 저울 — 세그먼트 효율 격차
  skew: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 21h8"/><path d="M5 6h14"/><path d="M5 6l-2 5a2.5 2.5 0 0 0 4.9 0z"/><path d="M19 6l-2 5a2.5 2.5 0 0 0 4.9 0z"/></svg>',
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
  /** "내 말투 설정" 버튼. */
  onToneSettings?: () => void;
  /** "이슈 기준" 버튼 — 민감도/직접 설정. */
  onThresholdSettings?: () => void;
  /** "지난 보고" 버튼. */
  onShowHistory?: () => void;
}

export function renderBriefPickPanel(opts: BriefPickOpts): void {
  closeBriefPanel();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-brief-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-brief-card";

  const head = document.createElement("div");
  head.className = "dvads-brief-head";
  head.textContent = `말할 내용 고르기 - ${opts.advertiserName}`;
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
  };
  if (!opts.prevHistoryAvailable) state.includePrevHistory = false;
  if (opts.changeDisabledReason != null) state.includeChangeHistory = false;

  // ── 옵션 영역: 보고 유형 / 톤 / 이력 토글 2개 ──
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
  body.appendChild(optWrap);

  // ── 후보 목록 — 원본을 건드리지 않고 사본에 선택/액션을 기록. ──
  const picks = opts.candidates.map((c, i) => ({
    ...c,
    selected: state.selectedIdx.includes(i),
    action: state.actions[i],
  }));

  const rowsByIdx: Array<{ refresh: () => void }> = [];

  const updateComposeEnabled = () => {
    composeBtn.disabled = !picks.some((p) => p.selected && !isHiddenKind(p.kind)) && memoTa.value.trim() === "";
  };
  const isHiddenKind = (kind: string): boolean =>
    (kind === PREV_HISTORY_KIND && !state.includePrevHistory) ||
    (kind === CHANGE_HISTORY_KIND && !state.includeChangeHistory);

  const list = document.createElement("div");
  list.className = "dvads-brief-pick-list";

  picks.forEach((pick) => {
    const row = document.createElement("label");
    row.className = "dvads-brief-pick-row";
    row.classList.toggle("is-selected", pick.selected);

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = pick.selected;
    cb.addEventListener("change", () => {
      pick.selected = cb.checked;
      row.classList.toggle("is-selected", cb.checked);
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

    // 우측 원형 체크 — 선택 시 주황 채움 + 흰 체크
    const check = document.createElement("span");
    check.className = "dvads-brief-pick-check";
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l5 5L20 6"/></svg>';
    row.appendChild(check);

    list.appendChild(row);

    // 토글 off면 해당 이력성 후보는 숨김 + 체크 해제(보내면 안 된다).
    const refresh = () => {
      const hidden = isHiddenKind(pick.kind);
      row.style.display = hidden ? "none" : "";
      if (hidden && pick.selected) {
        pick.selected = false;
        cb.checked = false;
        row.classList.remove("is-selected");
      }
      updateComposeEnabled();
    };
    rowsByIdx.push({ refresh });
  });
  body.appendChild(list);

  // 자유 입력 — 데이터가 모르는 맥락(예: "6월 말부터 CPC 낮춰 운영 중").
  const memoTa = document.createElement("textarea");
  memoTa.className = "dvads-brief-pick-memo";
  memoTa.placeholder = "추가로 전할 내용이 있다면 적어주세요";
  memoTa.rows = 3;
  memoTa.value = state.memo;
  memoTa.addEventListener("input", () => updateComposeEnabled());
  body.appendChild(memoTa);

  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  if (opts.onThresholdSettings) {
    const thBtn = document.createElement("button");
    thBtn.type = "button";
    thBtn.className = "dvads-btn";
    thBtn.textContent = "이슈 기준";
    thBtn.addEventListener("click", () => opts.onThresholdSettings?.());
    foot.appendChild(thBtn);
  }
  if (opts.onToneSettings) {
    const toneBtn = document.createElement("button");
    toneBtn.type = "button";
    toneBtn.className = "dvads-btn";
    toneBtn.textContent = "내 말투";
    toneBtn.addEventListener("click", () => opts.onToneSettings?.());
    foot.appendChild(toneBtn);
  }
  if (opts.onShowHistory) {
    const hist = document.createElement("button");
    hist.type = "button";
    hist.className = "dvads-btn";
    hist.textContent = "지난 보고";
    hist.addEventListener("click", () => opts.onShowHistory?.());
    foot.appendChild(hist);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dvads-btn";
  cancel.textContent = "닫기";
  cancel.addEventListener("click", () => closeBriefPanel());
  foot.appendChild(cancel);
  const composeBtn = document.createElement("button");
  composeBtn.type = "button";
  composeBtn.className = "dvads-btn dvads-btn-primary";
  composeBtn.textContent = "보고문 만들기";
  composeBtn.addEventListener("click", () => {
    const selected = picks.filter((p) => p.selected && !isHiddenKind(p.kind));
    if (selected.length === 0 && !memoTa.value.trim()) {
      showToast({ message: "말할 내용을 하나 이상 골라 주세요", variant: "error" });
      return;
    }
    state.memo = memoTa.value.trim();
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

  disposePanel = () => {
    closeAllOpenDropdowns();
    backdrop.remove();
  };
}
