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
import { type BriefThresholds } from "./brief-rules";
import { resolveThresholds, SENSITIVITY_LABEL, type BriefSensitivity } from "./brief-thresholds";
import { distillTone } from "./brief-compose";
import { loadBriefTone, saveBriefTone } from "./brief-tone";
import { showTooltip, hideTooltip } from "@/shared/tooltip";

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
  const join = (parts: Array<string | undefined>) => parts.filter((p) => p && p !== "").join(", ");
  switch (c.kind) {
    case "pastActionFollowUp":
      return {
        title: `지난 조치 성과 추적 (${f["지난보고일"] ?? ""})`,
        sub: join([shortList(f["대상"], f["count"]), `ROAS ${f["당시수익률"]} → ${f["이번수익률"]}`]),
      };
    case "changeFollowUp":
      return {
        title: `변경 이후 성과 (${f["변경일"] ?? ""})`,
        sub: join([String(f["대상"] ?? ""), String(f["변경내용"] ?? ""), `평가 ${f["평가"] ?? ""}`]),
      };
    case "zeroConvKeyword":
      return { title: "전환 없는 키워드", sub: join([shortList(f["keywords"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "belowTargetKeyword":
      return { title: "목표 ROAS 미달 키워드", sub: join([shortList(f["keywords"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "belowTargetGroup":
      return { title: "그룹 합산 목표 ROAS 미달", sub: join([`광고비 ${wonOf(f["비용합계"])}`, `ROAS ${f["수익률"] ?? ""}`]) };
    case "highRoasLowRank":
      return { title: "잘되는데 순위가 낮은 키워드", sub: join([shortList(f["keywords"], f["count"]), `평균 ${f["평균순위"]}위`]) };
    case "zeroConvPlacement":
      return { title: "전환 없는 지면", sub: join([shortList(f["placements"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "lowRoasPlacement":
      return { title: "ROAS 낮은 지면", sub: join([shortList(f["placements"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]) };
    case "lowCtrAd":
      return { title: "클릭률 낮은 소재", sub: shortList(f["ads"], f["count"]) };
    case "productConvDrop":
      return { title: "전환 줄어든 상품", sub: join([shortList(f["products"], f["count"]), `매출 ${wonOf(f["매출감소합계"])} 감소`]) };
    case "genderBidSkew":
    case "ageBidSkew":
    case "deviceBidSkew":
    case "hourWeekdaySkew":
    case "regionBidSkew": {
      // 2026-07-21 A안 — 상대 비교 폐기, 목표 미달 구간 전부 나열.
      const dim = String(f["차원"] ?? "구간");
      return {
        title: `목표 ROAS 미달 ${dim}`,
        sub: join([shortList(f["구간"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]),
      };
    }
    case "zeroConvSegment":
      return {
        title: `전환 없는 ${String(f["차원"] ?? "구간")}`,
        sub: join([shortList(f["구간"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]),
      };
    case "lowCtrSegment":
      return {
        title: `클릭률 낮은 ${String(f["차원"] ?? "구간")}`,
        sub: join([shortList(f["구간"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]),
      };
    case "highRoasSegment":
      return {
        title: `성과 좋은 ${String(f["차원"] ?? "구간")} - 가중치 상향 여지`,
        sub: join([shortList(f["구간"], f["count"]), `광고비 ${wonOf(f["비용합계"])}`]),
      };
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
  // 커서 클릭 — 소재(클릭률)
  cursor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l7 17 2.5-7.5L21 11z"/></svg>',
  // 사람 — 성별/연령대 구간
  person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>',
  // 모니터+스마트폰 — 기기 구간
  device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="14" height="10" rx="2"/><path d="M8 18h4"/><path d="M10 14v4"/><rect x="15" y="10" width="6" height="10" rx="2" fill="#fff"/><rect x="15" y="10" width="6" height="10" rx="2"/></svg>',
  // 달력 — 요일 구간
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/></svg>',
  // 지도 핀 — 지역 구간
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
};

type PickVisual = { icon: keyof typeof ICON_SVGS; state: "error" | "warning" | "success" | "info" };

/** 세그먼트 이슈의 차원 라벨 → 아이콘. 모르는 차원은 사람. */
const DIM_ICON: Record<string, keyof typeof ICON_SVGS> = {
  성별: "person", 연령대: "person", 기기: "device", 시간대: "clock", 요일: "calendar", 지역: "pin",
};
function dimIcon(facts?: Record<string, string | number>): keyof typeof ICON_SVGS {
  return DIM_ICON[String(facts?.차원 ?? "")] ?? "person";
}

/** 후보 kind → 아이콘 + 상태 색. 세그먼트 계열은 facts.차원으로 아이콘을 고른다. */
export function pickRowVisual(kind: string, facts?: Record<string, string | number>): PickVisual {
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
      return { icon: dimIcon(facts), state: "warning" };
    case "zeroConvSegment":
      return { icon: dimIcon(facts), state: "error" };
    case "lowCtrSegment":
      return { icon: dimIcon(facts), state: "warning" };
    case "highRoasSegment":
      return { icon: dimIcon(facts), state: "success" };
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

/** 이슈 기준 직접 설정 입력 — 라벨은 비개발자 기준. */
const THRESHOLD_FIELDS: Array<{ key: keyof BriefThresholds; label: string; unit: string; step?: string }> = [
  { key: "costFloor", label: "이슈로 볼 최소 광고비", unit: "원" },
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
  /** 광고관리자 URL용 — 있으면 그룹 단위 후보에 "광고관리자에서 열기" 링크를 단다. */
  adAccountNo?: number;
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
  // 판정에 쓴 지표 열은 굵게 — 강조(problem 빨강/good 초록) 행에만, 강조 행이 없는 표는 전 행에.
  const boldIdx = new Set((pick.table.boldColumns ?? []).map((c) => pick.table!.columns.indexOf(c)));
  const hasMark = pick.table.rows.some((r) => r.problem || r.good);
  for (const r of pick.table.rows) {
    const tr = document.createElement("tr");
    if (r.problem) tr.classList.add("dvads-brief-row-problem");
    if (r.good) tr.classList.add("dvads-brief-row-good");
    r.cells.forEach((cell, i) => {
      const td = document.createElement("td");
      td.textContent = cell;
      if (boldIdx.has(i) && (r.problem || r.good || !hasMark)) td.classList.add("dvads-brief-cell-bold");
      tr.appendChild(td);
    });
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

  // 호스트 페이지(광고관리자)가 문서 레벨에서 휠을 가로채 카드 위 세로 휠이 목록을 못
  // 내리는 문제 — 카드 어디서든 세로 휠은 목록(.dvads-brief-body)을 직접 내린다.
  // 가로 제스처(deltaX 우세)와 shift+휠은 표 가로 스크롤용이라 그대로 둔다.
  card.addEventListener(
    "wheel",
    (e) => {
      if (e.shiftKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      e.preventDefault();
      // 말투 입력칸처럼 자체 스크롤이 있는 요소 위에서는 그 요소를 먼저 스크롤.
      const ta = (e.target as HTMLElement | null)?.closest?.("textarea");
      if (ta && ta.scrollHeight > ta.clientHeight) {
        const before = ta.scrollTop;
        ta.scrollTop += e.deltaY;
        if (ta.scrollTop !== before) return; // 끝에 닿았을 때만 목록으로 넘어간다
      }
      body.scrollTop += e.deltaY;
    },
    { passive: false },
  );

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

  // ── 고급옵션(접힘): 보고 유형 / 이슈 기준 / 대화 스타일 — 섹션은 아래에서 순서대로 조립 ──
  const optWrap = document.createElement("div");
  optWrap.className = "dvads-brief-pick-options";

  // ── 후보 목록 — 원본을 건드리지 않고 사본에 선택/액션을 기록. ──
  const picks = opts.candidates.map((c, i) => ({
    ...c,
    selected: state.selectedIdx.includes(i),
    action: state.actions[i],
  }));

  const rowsByIdx: Array<{ refresh: () => void; setSelected: (on: boolean) => void }> = [];

  // 캠페인/그룹 머리글 선택 표시 동기화 — 자식이 전부 선택되면 머리글도 주황으로.
  const headSyncs: Array<() => void> = [];

  const updateComposeEnabled = () => {
    composeBtn.disabled = !picks.some((p) => p.selected && !isHiddenKind(p.kind));
    headSyncs.forEach((sync) => sync());
  };
  const isHiddenKind = (kind: string): boolean =>
    (kind === PREV_HISTORY_KIND && !state.includePrevHistory) ||
    (kind === CHANGE_HISTORY_KIND && !state.includeChangeHistory);

  const list = document.createElement("div");
  list.className = "dvads-brief-pick-list";

  // ── 캠페인 > 그룹 계층으로 묶는다(2026-07-20 개편). 계정 공통(이력·변경·상품) 이슈가 먼저. ──
  interface PickSection { campaign?: string; group?: string; picks: BriefCandidate[] }
  const sectionMap = new Map<string, PickSection>();
  const sectionList: PickSection[] = [];
  for (const p of picks) {
    const key = p.scope ? `${p.scope.campaign}||${p.scope.group}` : "";
    let s = sectionMap.get(key);
    if (!s) {
      s = { campaign: p.scope?.campaign, group: p.scope?.group, picks: [] };
      sectionMap.set(key, s);
      sectionList.push(s);
    }
    s.picks.push(p);
  }
  sectionList.sort((a, b) => {
    if (!a.campaign) return b.campaign ? -1 : 0;
    if (!b.campaign) return 1;
    return a.campaign.localeCompare(b.campaign, "ko") || (a.group ?? "").localeCompare(b.group ?? "", "ko");
  });
  const hasScoped = sectionList.some((s) => s.campaign);

  // 캠페인/그룹 머리글 — 클릭하면 그 아래 자식 이슈 전체를 선택/해제하고,
  // 호버하면 어디까지가 자식인지 전체가 함께 하이라이트된다.
  interface SectionCtrl {
    picks: Array<{ kind: string; selected: boolean }>;
    rows: Array<(on: boolean) => void>;
    items: HTMLElement[];
  }
  const wireHead = (el: HTMLElement, ctrl: SectionCtrl) => {
    headSyncs.push(() => {
      const visible = ctrl.picks.filter((p) => !isHiddenKind(p.kind));
      el.classList.toggle("is-selected", visible.length > 0 && visible.every((p) => p.selected));
    });
    el.addEventListener("click", () => {
      const visible = ctrl.picks.filter((p) => !isHiddenKind(p.kind));
      const turnOn = !(visible.length > 0 && visible.every((p) => p.selected));
      ctrl.rows.forEach((set) => set(turnOn));
      updateComposeEnabled();
    });
    // 머리글 자신도 자식들과 함께 하이라이트 — 클릭 단위가 한 덩어리로 보이게.
    el.addEventListener("mouseenter", () =>
      [el, ...ctrl.items].forEach((i) => i.classList.add("dvads-kids-hover")));
    el.addEventListener("mouseleave", () =>
      [el, ...ctrl.items].forEach((i) => i.classList.remove("dvads-kids-hover")));
  };
  // 머리글 제목 — 클릭하면 광고관리자 해당 화면을 새 탭으로 연다(선택 토글과 분리).
  const addHeadTitle = (head: HTMLElement, text: string, url?: string) => {
    const t = document.createElement("span");
    t.className = "dvads-brief-pick-head-title";
    t.textContent = text;
    if (url) {
      t.title = "광고관리자에서 열기";
      t.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(url, "_blank", "noopener");
      });
    }
    head.appendChild(t);
  };
  // 캠페인 상세: /sa/campaigns/{nccCampaignId} — 2026-07-21 사용자 제공 URL로 검증
  // (예: /manage/ad-accounts/454196/sa/campaigns/cmp-a001-01-000000003544633).
  const campaignUrlOf = (campaignId?: string): string | undefined =>
    opts.adAccountNo != null && campaignId
      ? `${location.origin}/manage/ad-accounts/${opts.adAccountNo}/sa/campaigns/${campaignId}`
      : undefined;
  const groupUrlOf = (adgroupId?: string): string | undefined =>
    opts.adAccountNo != null && adgroupId
      ? `${location.origin}/manage/ad-accounts/${opts.adAccountNo}/sa/adgroups/${adgroupId}`
      : undefined;

  const makeCampHead = (label: string, url?: string): SectionCtrl => {
    const camp = document.createElement("div");
    camp.className = "dvads-brief-pick-camp";
    addHeadTitle(camp, label, url);
    list.appendChild(camp);
    const ctrl: SectionCtrl = { picks: [], rows: [], items: [] };
    wireHead(camp, ctrl);
    return ctrl;
  };

  let prevCampaign: string | undefined;
  let curCamp: SectionCtrl | undefined;
  let curGroup: SectionCtrl | undefined;
  for (const section of sectionList) {
    if (section.campaign) {
      if (section.campaign !== prevCampaign) {
        const campId = section.picks.find((p) => p.scope?.nccCampaignId)?.scope?.nccCampaignId;
        curCamp = makeCampHead(section.campaign, campaignUrlOf(campId));
        prevCampaign = section.campaign;
      }
      const grouphead = document.createElement("div");
      grouphead.className = "dvads-brief-pick-grouphead";
      const groupId = section.picks.find((p) => p.scope?.nccAdgroupId)?.scope?.nccAdgroupId;
      addHeadTitle(grouphead, section.group ?? "", groupUrlOf(groupId));
      list.appendChild(grouphead);
      curCamp?.items.push(grouphead);
      curGroup = { picks: [], rows: [], items: [] };
      wireHead(grouphead, curGroup);
    } else if (hasScoped) {
      curCamp = makeCampHead("계정 공통");
      curGroup = undefined;
    }

    section.picks.forEach((pick) => {
    curCamp?.picks.push(pick);
    curGroup?.picks.push(pick);
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
    const visual = pickRowVisual(pick.kind, pick.facts);
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

    // 행+펼침 영역은 한 덩어리 — 펼친 데이터 영역을 눌러도 선택 토글.
    // (표 숫자를 드래그로 긁는 경우는 선택 텍스트가 있으면 토글하지 않는다)
    detail.addEventListener("click", () => {
      if (window.getSelection()?.toString()) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });

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
    // 모두 선택/선택 해제용 — 숨긴 이슈는 켜지 않는다(보내면 안 되는 후보).
    const setSelected = (on: boolean) => {
      if (on && isHiddenKind(pick.kind)) return;
      pick.selected = on;
      cb.checked = on;
      item.classList.toggle("is-selected", on);
    };
    rowsByIdx.push({ refresh, setSelected });
    curCamp?.rows.push(setSelected);
    curGroup?.rows.push(setSelected);
    curCamp?.items.push(item);
    curGroup?.items.push(item);
    });
  }
  body.appendChild(list);

  // 고급옵션 안의 소제목 — 굵은 라벨 한 줄.
  const addSubHead = (title: string): HTMLElement => {
    const h = document.createElement("div");
    h.className = "dvads-brief-adv-sub";
    const t = document.createElement("div");
    t.className = "dvads-brief-adv-sub-title";
    t.textContent = title;
    h.appendChild(t);
    optWrap.appendChild(h);
    return t;
  };

  // i 아이콘 — 클릭하면 설명 툴팁. 회색 원 + 흰 i.
  const makeInfoIcon = (text: string): HTMLElement => {
    const info = document.createElement("button");
    info.type = "button";
    info.className = "dvads-brief-info-icon";
    info.setAttribute("aria-label", "설명");
    info.textContent = "i";
    let open = false;
    info.addEventListener("click", (e) => {
      e.stopPropagation();
      open = !open;
      if (open) showTooltip(info, text, "top");
      else hideTooltip();
    });
    info.addEventListener("mouseleave", () => { open = false; hideTooltip(); });
    return info;
  };

  // ── 보고 유형 — 이슈 기준과 같은 2택 칩 구조. ──
  {
    const t = addSubHead("보고 유형");
    t.appendChild(makeInfoIcon(
      "사후보고 - 이미 조치한 내용을 알리는 보고예요\n" +
      "사전제안 - 앞으로 이렇게 하겠다고 먼저 제안하는 보고예요",
    ));
    const row = document.createElement("div");
    row.className = "dvads-brief-preset-row";
    const syncChips = () =>
      chips.forEach(({ value, chip }) => chip.classList.toggle("is-on", value === state.reportType));
    const chips = REPORT_TYPE_OPTIONS.map(({ value, label }) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "dvads-brief-preset-chip";
      chip.textContent = label;
      chip.addEventListener("click", () => { state.reportType = value; syncChips(); });
      row.appendChild(chip);
      return { value, chip };
    });
    syncChips();
    optWrap.appendChild(row);
  }

  // ── 이슈 기준 — 프리셋 칩 + 직접 설정, 다이얼로그 없이 여기서 바로. ──
  if (opts.thresholds) {
    const th = opts.thresholds;
    const thTitle = addSubHead("이슈 기준");
    thTitle.appendChild(makeInfoIcon(
      "민감하게 - 작은 변화도 이슈로 잡아요\n" +
      "보통 - 이 기간 광고비에 맞춘 기본 기준이에요\n" +
      "느슨하게 - 큰 변화만 이슈로 잡아요\n" +
      "직접 설정 - 기준값을 하나하나 직접 정해요",
    ));
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

  // ── 대화 스타일 — 팝업 없이 여기서 바로 입력 → 화살표로 규칙 생성 → 저장.
  // (지난 보고 보기는 잠시 내림 — DB 저장은 유지, 2026-07-21) ──
  // 서버 compose가 저장된 brief_tone을 읽으므로, 진행 중인 저장은 "생성" 전에 끝나야 한다(코덱스 P2).
  let pendingToneSave: Promise<unknown> = Promise.resolve();
  addSubHead("대화 스타일");
  {
    const hint = document.createElement("div");
    hint.className = "dvads-brief-tone-hint";
    hint.textContent = "실제로 보냈던 보고 채팅을 붙여넣어 주세요";
    optWrap.appendChild(hint);

    const samplesTa = document.createElement("textarea");
    samplesTa.className = "dvads-brief-tone-ta";
    samplesTa.rows = 5;
    samplesTa.placeholder = "예) 안녕하세요:) 지난 30일 동안 ...";
    optWrap.appendChild(samplesTa);

    const makeBtn = document.createElement("button");
    makeBtn.type = "button";
    makeBtn.className = "dvads-brief-tone-make";
    makeBtn.setAttribute("aria-label", "말투 규칙 생성");
    makeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
    optWrap.appendChild(makeBtn);

    const promptTa = document.createElement("textarea");
    promptTa.className = "dvads-brief-tone-ta";
    promptTa.rows = 5;
    promptTa.placeholder = "화살표를 누르면 여기에 말투 규칙이 생겨요. 직접 고칠 수도 있어요";
    optWrap.appendChild(promptTa);

    // 저장 버튼 없이 자동 저장 — 규칙이 생성되거나 직접 고친 뒤 포커스를 떠나면 저장.
    let lastSaved = "";
    const autoSave = () => {
      const tonePrompt = promptTa.value.trim();
      if (!tonePrompt || tonePrompt === lastSaved) return;
      lastSaved = tonePrompt;
      pendingToneSave = saveBriefTone({ samples: samplesTa.value.trim(), tonePrompt })
        .catch((e) => {
          lastSaved = ""; // 실패했으면 다음 기회에 재시도
          showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" });
        });
    };

    makeBtn.addEventListener("click", () => {
      const samples = samplesTa.value.trim();
      if (samples.length < 50) {
        showToast({ message: "채팅 이력을 조금 더 붙여넣어 주세요 (최소 두세 문장)", variant: "error" });
        return;
      }
      makeBtn.disabled = true;
      makeBtn.classList.add("is-busy");
      void distillTone(samples)
        .then((prompt) => {
          promptTa.value = prompt;
          autoSave();
        })
        .catch((e) => showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" }))
        .finally(() => {
          makeBtn.disabled = false;
          makeBtn.classList.remove("is-busy");
        });
    });
    promptTa.addEventListener("change", autoSave);
    // 기존 설정 불러오기 — 있으면 재생성/수정 가능. 불러온 값은 이미 저장본이라 재저장 안 함.
    void loadBriefTone().then((rec) => {
      if (!rec) return;
      if (samplesTa.value === "") samplesTa.value = rec.samples;
      if (promptTa.value === "") {
        promptTa.value = rec.tonePrompt;
        lastSaved = rec.tonePrompt.trim();
      }
    });
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
  advText.innerHTML = '<span class="dvads-brief-adv-title">고급 옵션</span>';
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
    // 방금 만든 말투가 서버에 저장되기 전에 조립이 시작되면 옛 말투로 생성된다 — 저장 완료를 기다린다.
    void pendingToneSave.catch(() => undefined).then(() => opts.onCompose(selected, state));
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
    backdrop.remove();
  };
}
