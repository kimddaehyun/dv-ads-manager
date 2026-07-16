/**
 * F-Brief 패널 DOM — 블록 나열 + 블록별 복사.
 *
 * 카톡은 텍스트/이미지를 한 메시지에 못 붙인다. 그래서 "문구 하나 + 표 하나"가 아니라
 * 블록의 나열이고, 각 블록이 자기 복사 버튼을 갖는다(보고 로그의 문단-사진 1:1 구조).
 */

import { type BriefTableSpec } from "./brief-rules";
import { renderTablePng, copyTablePng } from "./brief-table";
import { showToast } from "@/shared/toast";
import { wireBackdropDismiss } from "@/shared/dialog-dismiss";

export interface BriefTextBlock {
  type: "text";
  text: string;
  /** AI가 창작한 액션 문장이면 true — 좌측 주황 선. Task 10에서 채운다. */
  isAiJudgment?: boolean;
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
}

let disposePanel: (() => void) | null = null;

export function closeBriefPanel(): void {
  disposePanel?.();
  disposePanel = null;
}

export function renderBriefPanel(opts: BriefPanelOpts): void {
  closeBriefPanel();

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
      wrap.appendChild(ta);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dvads-btn dvads-brief-copy";
      btn.textContent = "복사";
      btn.addEventListener("click", () => {
        // 편집된 현재 값을 복사한다. 주황 선은 CSS라 텍스트에 안 딸려간다.
        void navigator.clipboard.writeText(ta.value)
          .then(() => showToast({ message: "문구를 복사했어요", variant: "success" }))
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
          img.src = URL.createObjectURL(blob);
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
    backdrop.remove();
  };
}
