/**
 * 숫자 입력 다이얼로그 — F-MultiAccount 비즈머니/브랜드검색 알림 임계값 설정용.
 *
 * confirm-dialog/rename-dialog 패턴과 동일 — backdrop+card, ESC/배경 클릭 닫기, 카드 내부
 * click은 swallow해 부모 popover의 외부 클릭 닫힘 로직에 누설되지 않게 한다.
 *
 * 차이점: input 한 줄 + suffix 라벨("원"/"일") + 기존값 있을 때 "해제" 버튼.
 */

let openDialogCleanup: (() => void) | null = null;

export interface InputDialogOptions {
  /** 모달 제목 */
  title: string;
  /** 본문 설명 한 줄 (선택) */
  description?: string;
  /** 입력 prefill 값. null이면 빈 input */
  initialValue: number | null;
  /** 단위 라벨 (예: "원", "일") */
  suffix: string;
  /** input placeholder */
  placeholder?: string;
  /** "확인" 클릭 시 호출 (양의 정수만 들어옴) */
  onConfirm: (value: number) => void | Promise<void>;
  /** 정의되면 "해제" 버튼 노출 — 클릭 시 호출. 임계값 제거 흐름에 사용. */
  onClear?: () => void | Promise<void>;
}

export function openInputDialog(opts: InputDialogOptions): void {
  // 동시에 한 개만
  closeInputDialog();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-input-backdrop";

  const card = document.createElement("div");
  card.className = "dvads-input-card";
  backdrop.appendChild(card);

  const titleEl = document.createElement("div");
  titleEl.className = "dvads-input-title";
  titleEl.textContent = opts.title;
  card.appendChild(titleEl);

  if (opts.description) {
    const descEl = document.createElement("div");
    descEl.className = "dvads-input-desc";
    descEl.textContent = opts.description;
    card.appendChild(descEl);
  }

  const inputWrap = document.createElement("div");
  inputWrap.className = "dvads-input-input-wrap";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "dvads-input-input";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.placeholder = opts.placeholder ?? "";
  if (opts.initialValue != null) input.value = String(opts.initialValue);

  const suffixEl = document.createElement("span");
  suffixEl.className = "dvads-input-suffix";
  suffixEl.textContent = opts.suffix;

  inputWrap.appendChild(input);
  inputWrap.appendChild(suffixEl);
  card.appendChild(inputWrap);

  const actions = document.createElement("div");
  actions.className = "dvads-input-actions";

  // 기존 값이 있을 때만 "해제" 노출 — 다이얼로그 좌측. 우측은 취소/확인.
  let clearBtn: HTMLButtonElement | null = null;
  if (opts.onClear) {
    clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "dvads-btn dvads-btn-secondary dvads-input-clear";
    clearBtn.textContent = "해제";
    actions.appendChild(clearBtn);
  }

  const spacer = document.createElement("div");
  spacer.className = "dvads-input-actions-spacer";
  actions.appendChild(spacer);

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "dvads-btn dvads-btn-secondary";
  cancelBtn.textContent = "취소";
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "dvads-btn dvads-btn-primary";
  confirmBtn.textContent = "확인";
  actions.appendChild(confirmBtn);

  card.appendChild(actions);
  document.body.appendChild(backdrop);

  // input value 변경에 따라 확인 버튼 활성/비활성 동기화. 빈 값/0/음수/비숫자는 비활성.
  const syncConfirmEnabled = () => {
    const v = parseInt(input.value.replace(/[^\d]/g, ""), 10);
    const ok = Number.isFinite(v) && v > 0;
    confirmBtn.disabled = !ok;
    confirmBtn.classList.toggle("is-disabled", !ok);
  };
  input.addEventListener("input", () => {
    // 숫자 외 입력 즉시 정리 — UX 단순화. 0 시작 0001 같은 케이스도 정수 parse 단계서 처리.
    const cleaned = input.value.replace(/[^\d]/g, "");
    if (cleaned !== input.value) input.value = cleaned;
    syncConfirmEnabled();
  });
  syncConfirmEnabled();

  let busy = false;

  // 카드 내부 click이 document로 전파되지 않도록 차단 — 부모 popover의 외부 클릭 닫힘 방지.
  const swallow = (e: MouseEvent) => e.stopPropagation();
  const onBackdropClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    if (e.target === backdrop) teardown();
  };
  const onKey = (e: KeyboardEvent) => {
    if (busy) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      teardown();
    } else if (e.key === "Enter") {
      e.stopPropagation();
      if (!confirmBtn.disabled) void runConfirm();
    }
  };

  backdrop.addEventListener("click", onBackdropClick);
  card.addEventListener("click", swallow);
  document.addEventListener("keydown", onKey);

  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (busy) return;
    teardown();
  });

  confirmBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (busy || confirmBtn.disabled) return;
    void runConfirm();
  });

  clearBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (busy) return;
    void runClear();
  });

  // 입력 즉시 가능하도록 자동 포커스 + 기존 값 전체 선택 (덮어쓰기 편의).
  // setTimeout으로 다음 tick에 호출 — 일부 브라우저가 mount 직후 focus를 무시할 수 있음.
  setTimeout(() => {
    input.focus();
    if (opts.initialValue != null) input.select();
  }, 0);

  openDialogCleanup = teardown;

  async function runConfirm() {
    const v = parseInt(input.value.replace(/[^\d]/g, ""), 10);
    if (!Number.isFinite(v) || v <= 0) return;
    busy = true;
    confirmBtn.classList.add("dvads-btn-loading");
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    try {
      await opts.onConfirm(v);
    } finally {
      teardown();
    }
  }

  async function runClear() {
    if (!opts.onClear) return;
    busy = true;
    if (clearBtn) clearBtn.classList.add("dvads-btn-loading");
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    try {
      await opts.onClear();
    } finally {
      teardown();
    }
  }

  function teardown() {
    if (!backdrop.isConnected) return;
    backdrop.removeEventListener("click", onBackdropClick);
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (openDialogCleanup === teardown) openDialogCleanup = null;
  }
}

export function closeInputDialog(): void {
  openDialogCleanup?.();
  openDialogCleanup = null;
}
