/**
 * F-Brief 패널 DOM — 블록 나열 + 블록별 복사.
 *
 * 카톡은 텍스트/이미지를 한 메시지에 못 붙인다. 그래서 "문구 하나 + 표 하나"가 아니라
 * 블록의 나열이고, 각 블록이 자기 복사 버튼을 갖는다(보고 로그의 문단-사진 1:1 구조).
 */

import { type BriefTableSpec, type BriefCandidate, type BriefAction } from "./brief-rules";
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
  /** "직접 고르기" 클릭. Task 10에서 후보 선택 화면으로. */
  onPickManually?: () => void;
  /** 텍스트 블록 복사 시 호출 — 전 텍스트 블록의 현재 값(편집 반영)을 합쳐 넘긴다. 이력 저장용(설계 §7: 복사한 순간). */
  onCopyText?: (fullMessage: string) => void;
  /** "지난 보고" 버튼 클릭 — 이 계정의 저장된 보고 목록으로. */
  onShowHistory?: () => void;
}

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
      wrap.appendChild(ta);

      if (block.numberWarning) {
        const warn = document.createElement("div");
        warn.className = "dvads-brief-warn";
        warn.textContent = "확인 필요 - 데이터에 없는 숫자가 있어요";
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
  if (opts.onPickManually) {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "dvads-btn";
    pick.textContent = "직접 고르기";
    pick.addEventListener("click", () => opts.onPickManually?.());
    foot.appendChild(pick);
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
// 완전자동과 같은 엔진 — 완전자동은 체크박스를 AI가 미리 채운 상태일 뿐(설계 §7).
// 체크한 후보만 서버로 간다. 액션 dropdown의 "AI가 판단"은 action을 비워 보내
// AI가 목록(raise/hold/...)에서 고르게 한다.

/** 액션 dropdown 값 — "ai"는 action 미지정(AI가 고름). */
type PickAction = "ai" | BriefAction;

const PICK_ACTION_OPTIONS: Array<{ value: PickAction; label: string }> = [
  { value: "ai", label: "AI가 판단" },
  { value: "raise", label: "입찰가 상향" },
  { value: "hold", label: "유지 후 관찰" },
  { value: "lower", label: "입찰가 하향" },
  { value: "exclude", label: "제외 처리" },
  { value: "ask", label: "광고주에게 문의" },
];

export interface BriefPickOpts {
  advertiserName: string;
  candidates: BriefCandidate[];
  /** "문구 만들기" — 체크된 후보(액션 반영됨)와 자유 메모를 넘긴다. */
  onCompose: (selected: BriefCandidate[], memo: string) => void;
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

  // 후보별 상태 — 원본을 건드리지 않고 사본에 선택/액션을 기록.
  const picks = opts.candidates.map((c) => ({ ...c, selected: false, action: undefined as BriefAction | undefined }));

  picks.forEach((pick) => {
    const row = document.createElement("label");
    row.className = "dvads-brief-pick-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.addEventListener("change", () => {
      pick.selected = cb.checked;
    });
    row.appendChild(cb);

    const label = document.createElement("span");
    label.className = "dvads-brief-pick-label";
    label.textContent = String(pick.facts["기준"] ?? pick.kind);
    row.appendChild(label);

    const dd = createDropdown<PickAction>({
      value: "ai",
      options: PICK_ACTION_OPTIONS,
      ariaLabel: "액션 선택",
      width: 140,
      onChange: (v) => {
        pick.action = v === "ai" ? undefined : v;
      },
    });
    // dropdown 클릭이 label 체크박스를 토글하지 않게.
    dd.root.addEventListener("click", (e) => e.preventDefault());
    row.appendChild(dd.root);

    body.appendChild(row);
  });

  // 자유 입력 — 데이터가 모르는 맥락(예: "6월 말부터 CPC 낮춰 운영 중").
  const memoTa = document.createElement("textarea");
  memoTa.className = "dvads-brief-pick-memo";
  memoTa.placeholder = "데이터에 없는 맥락이 있으면 적어주세요 (예: 6월 말부터 단가 낮춰 운영 중)";
  memoTa.rows = 3;
  body.appendChild(memoTa);

  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dvads-btn";
  cancel.textContent = "취소";
  cancel.addEventListener("click", () => closeBriefPanel());
  foot.appendChild(cancel);
  const compose = document.createElement("button");
  compose.type = "button";
  compose.className = "dvads-btn dvads-btn-primary";
  compose.textContent = "문구 만들기";
  compose.addEventListener("click", () => {
    const selected = picks.filter((p) => p.selected);
    if (selected.length === 0 && !memoTa.value.trim()) {
      showToast({ message: "말할 내용을 하나 이상 골라 주세요", variant: "error" });
      return;
    }
    const memo = memoTa.value.trim();
    closeBriefPanel();
    opts.onCompose(selected, memo);
  });
  foot.appendChild(compose);
  card.appendChild(foot);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  wireBackdropDismiss(backdrop, () => closeBriefPanel());

  disposePanel = () => {
    closeAllOpenDropdowns();
    backdrop.remove();
  };
}
