/**
 * dvads 공용 툴팁 — 다크 톤 + 캐럿. document.body에 portal로 mount해 host overflow 회피,
 * 전역 단일 element 재사용 (메모리/DOM 노드 절약).
 *
 * 도입 사유: ads.naver.com이 자체 hover 처리(행 하이라이트 등)로 native `title` 속성이
 * 안 뜨는 케이스 확인됨 (2026-05-19, F001 rank 배지). placement는 호출자가 선택 — 기본
 * "top"(트리거 위) + 공간 부족 시 자동 flip.
 */

export type TooltipPlacement = "top" | "bottom";

export interface AttachTooltipOptions {
  placement?: TooltipPlacement;
}

let tooltipEl: HTMLElement | null = null;

function ensureTooltipEl(): HTMLElement {
  if (tooltipEl) return tooltipEl;
  const el = document.createElement("div");
  el.className = "dvads dvads-tooltip";
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

export function showTooltip(
  anchor: HTMLElement,
  text: string,
  preferred: TooltipPlacement = "top",
): void {
  const el = ensureTooltipEl();
  el.textContent = text;
  el.style.display = "block";
  // rAF로 다음 frame에서 측정 — display:block 직후 getBoundingClientRect가 0일 수 있음.
  requestAnimationFrame(() => {
    if (!tooltipEl || tooltipEl.style.display === "none") return;
    if (!anchor.isConnected) {
      hideTooltip();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    const tt = el.getBoundingClientRect();
    // 가로: 트리거 중앙 정렬 + viewport 좌우 8px clamp.
    let left = rect.left + rect.width / 2 - tt.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tt.width - 8));

    // 세로: preferred 방향 시도 → 공간 부족 시 반대로 flip.
    let placement: TooltipPlacement = preferred;
    let top: number;
    if (preferred === "top") {
      top = rect.top - tt.height - 8;
      if (top < 8) {
        top = rect.bottom + 8;
        placement = "bottom";
      }
    } else {
      top = rect.bottom + 8;
      if (top + tt.height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - tt.height - 8);
        placement = "top";
      }
    }
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.dataset.placement = placement;

    // 캐럿 가로 위치 — anchor 중앙 기준. tooltip이 viewport clamp로 어긋났을 때도
    // 캐럿은 anchor를 가리키게 별도 계산. tooltip 내부에서 8px 안쪽으로 clamp해 모서리 탈출 방지.
    const anchorCenter = rect.left + rect.width / 2;
    const caretLeft = Math.max(10, Math.min(tt.width - 10, anchorCenter - left));
    el.style.setProperty("--dvads-tooltip-caret-x", `${caretLeft}px`);
  });
}

export function hideTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = "none";
}

export function attachTooltip(
  anchor: HTMLElement,
  text: string,
  opts: AttachTooltipOptions = {},
): void {
  const placement = opts.placement ?? "top";
  // 프로퍼티 할당 — 호출자가 `onmouseenter = null`로 해제하는 기존 패턴(F001 배지 등)과 호환.
  // 같은 anchor에 재호출 시에도 listener 중첩 안 됨, 마지막 호출만 살아남.
  anchor.onmouseenter = () => showTooltip(anchor, text, placement);
  anchor.onmouseleave = hideTooltip;
}
