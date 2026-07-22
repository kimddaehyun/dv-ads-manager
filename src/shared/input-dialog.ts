/**
 * 숫자 입력 다이얼로그 — F-MultiAccount 비즈머니/브랜드검색 알림 임계값 설정용.
 *
 * confirm-dialog/rename-dialog 패턴과 동일 — backdrop+card, ESC/배경 클릭 닫기, 카드 내부
 * click은 swallow해 부모 popover의 외부 클릭 닫힘 로직에 누설되지 않게 한다.
 *
 * 차이점: input 한 줄 + suffix 라벨("원"/"일") + 입력창 우측 켜기/끄기 토글(변경이력 알림
 * 다이얼로그와 동일 패턴). 끄고 확인 = 알림 해제.
 */

import { wireBackdropDismiss } from "./dialog-dismiss";

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
  /** 입력창 우측 켜기/끄기 토글 초기값. 확인 시 onConfirm의 두 번째 인자로 전달. */
  toggleInitial: boolean;
  /**
   * "확인" 클릭 시 호출. on=true면 value는 양의 정수, on=false면 알림 해제 요청
   * (이때 value는 입력이 유효하면 그 값, 아니면 null).
   */
  onConfirm: (value: number | null, on: boolean) => void | Promise<void>;
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

  // 입력창 + 우측 토글 한 줄 — 변경이력 알림 다이얼로그와 동일 배치.
  const inputRow = document.createElement("div");
  inputRow.className = "dvads-input-row";
  inputRow.appendChild(inputWrap);

  const toggleLabel = document.createElement("label");
  toggleLabel.className = "dvads-input-toggle";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "dvads-asset-bulk-switch";
  toggle.checked = opts.toggleInitial;
  toggle.setAttribute("aria-label", "알림 켜기");
  toggleLabel.appendChild(toggle);
  inputRow.appendChild(toggleLabel);
  card.appendChild(inputRow);

  const actions = document.createElement("div");
  actions.className = "dvads-input-actions";

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
  // 단, 토글이 꺼져 있으면(=해제 요청) 값 없이도 확인 가능.
  const syncConfirmEnabled = () => {
    const v = parseInt(input.value.replace(/[^\d]/g, ""), 10);
    const ok = !toggle.checked || (Number.isFinite(v) && v > 0);
    confirmBtn.disabled = !ok;
    confirmBtn.classList.toggle("is-disabled", !ok);
  };
  toggle.addEventListener("change", syncConfirmEnabled);
  input.addEventListener("input", () => {
    // 숫자 외 입력 즉시 정리 — UX 단순화. 0 시작 0001 같은 케이스도 정수 parse 단계서 처리.
    const cleaned = input.value.replace(/[^\d]/g, "");
    if (cleaned !== input.value) input.value = cleaned;
    // 꺼진 상태에서 값을 입력하면 자동으로 켠다 — 안 그러면 "값 입력 후 확인"이
    // 토글을 안 건드렸다는 이유로 조용히 해제로 처리된다.
    if (!toggle.checked && input.value !== "") toggle.checked = true;
    syncConfirmEnabled();
  });
  syncConfirmEnabled();

  let busy = false;

  // 카드 내부 click이 document로 전파되지 않도록 차단 — 부모 popover의 외부 클릭 닫힘 방지.
  const swallow = (e: MouseEvent) => e.stopPropagation();
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

  // 배경 클릭 닫기 — 드래그 오작동 방지 + 처리 중(busy)엔 무시.
  wireBackdropDismiss(backdrop, teardown, () => busy);
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

  // 입력 즉시 가능하도록 자동 포커스 + 기존 값 전체 선택 (덮어쓰기 편의).
  // setTimeout으로 다음 tick에 호출 — 일부 브라우저가 mount 직후 focus를 무시할 수 있음.
  setTimeout(() => {
    input.focus();
    if (opts.initialValue != null) input.select();
  }, 0);

  openDialogCleanup = teardown;

  async function runConfirm() {
    const parsed = parseInt(input.value.replace(/[^\d]/g, ""), 10);
    const valid = Number.isFinite(parsed) && parsed > 0;
    if (toggle.checked && !valid) return;
    busy = true;
    confirmBtn.classList.add("dvads-btn-loading");
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    toggle.disabled = true;
    try {
      await opts.onConfirm(valid ? parsed : null, toggle.checked);
    } finally {
      teardown();
    }
  }

  function teardown() {
    if (!backdrop.isConnected) return;
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (openDialogCleanup === teardown) openDialogCleanup = null;
  }
}

export function closeInputDialog(): void {
  openDialogCleanup?.();
  openDialogCleanup = null;
}
