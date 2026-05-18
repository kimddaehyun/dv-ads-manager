/**
 * 오버레이 토스트 — 우하단 고정, 5초 자동 닫힘, 선택적 Undo 버튼.
 *
 * 호스트 페이지의 토스트와는 독립. z-index 최대값으로 항상 위.
 * DESIGN.md "Overlay Card" 패턴 차용 (흰 배경 + 옅은 그림자, 보더 없음).
 *
 * 동시 호출 시 stacking — 최신 토스트가 위에 쌓이고, ttl 만료 또는
 * 닫기 버튼으로 개별 dismiss.
 */

const ROOT_ID = "dvads-toast-root";
const MAX_STACK = 3;

export interface ShowToastOptions {
  message: string;
  variant: "success" | "error";
  /** Undo 버튼. 클릭 시 토스트 즉시 닫고 onClick. */
  undo?: {
    label: string;
    onClick: () => void;
    /** 잔여 시간 progress bar — 기본 5000ms */
    ttlMs?: number;
  };
  /** undo 없을 때 자동 닫힘 시간 — 기본 3000ms */
  ttlMs?: number;
}

function ensureRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement("div");
  root.id = ROOT_ID;
  root.className = "dvads dvads-toast-root";
  document.body.appendChild(root);
  return root;
}

export function showToast(opts: ShowToastOptions): void {
  const root = ensureRoot();

  // 큐 한도 초과 시 가장 오래된 것부터 즉시 제거
  while (root.children.length >= MAX_STACK) {
    root.firstElementChild?.remove();
  }

  const ttl = opts.undo ? opts.undo.ttlMs ?? 5000 : opts.ttlMs ?? 3000;

  const card = document.createElement("div");
  card.className = `dvads-toast dvads-toast-${opts.variant}`;

  const body = document.createElement("div");
  body.className = "dvads-toast-body";

  const icon = document.createElement("span");
  icon.className = "dvads-toast-icon";
  icon.textContent = opts.variant === "success" ? "✓" : "!";
  body.appendChild(icon);

  const msg = document.createElement("span");
  msg.className = "dvads-toast-msg";
  msg.textContent = opts.message;
  body.appendChild(msg);

  if (opts.undo) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dvads-toast-undo";
    btn.textContent = opts.undo.label;
    btn.addEventListener("click", () => {
      // 토스트는 즉시 닫고 콜백
      dismiss();
      opts.undo?.onClick();
    });
    body.appendChild(btn);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "dvads-toast-close";
  close.setAttribute("aria-label", "닫기");
  close.textContent = "×";
  close.addEventListener("click", () => dismiss());
  body.appendChild(close);

  card.appendChild(body);

  // 진행바 — 잔여 시간 시각화
  const bar = document.createElement("div");
  bar.className = "dvads-toast-bar";
  const fill = document.createElement("div");
  fill.className = "dvads-toast-bar-fill";
  fill.style.animationDuration = `${ttl}ms`;
  bar.appendChild(fill);
  card.appendChild(bar);

  root.appendChild(card);

  // 마운트 직후 transition을 위해 다음 프레임에 visible class
  requestAnimationFrame(() => {
    card.classList.add("dvads-toast-in");
  });

  const t = window.setTimeout(dismiss, ttl);

  function dismiss() {
    window.clearTimeout(t);
    if (!card.isConnected) return;
    card.classList.remove("dvads-toast-in");
    card.classList.add("dvads-toast-out");
    window.setTimeout(() => card.remove(), 180);
  }
}
