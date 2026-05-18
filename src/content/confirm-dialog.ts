/**
 * 입찰가 변경 확인 다이얼로그.
 *
 * 팝오버 행 클릭 시 띄우는 작은 모달. ESC / 배경 클릭으로 취소.
 * "변경" 버튼은 비동기 적용 중 disabled + 스피너.
 *
 * 호스트 페이지의 모달과 충돌하지 않도록 dvads- prefix + z-index 최대.
 */

export interface ConfirmDialogOptions {
  keyword: string;
  currentBid: number | null;
  targetBid: number;
  /** "변경" 클릭 시 호출. 성공/실패 자체는 호출자가 토스트로 처리. */
  onConfirm: () => Promise<void>;
  /** 취소/닫기 시 호출 (선택). */
  onCancel?: () => void;
}

let openDialogCleanup: (() => void) | null = null;

export function openConfirmDialog(opts: ConfirmDialogOptions): void {
  // 동시에 한 개만
  closeConfirmDialog();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-confirm-backdrop";

  const card = document.createElement("div");
  card.className = "dvads-confirm-card";
  backdrop.appendChild(card);

  const header = document.createElement("div");
  header.className = "dvads-confirm-header";

  const title = document.createElement("div");
  title.className = "dvads-confirm-title";
  title.textContent = "입찰가 변경";
  header.appendChild(title);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dvads-confirm-close";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);

  card.appendChild(header);

  // 본문 2줄 구성:
  //   라인 1: "<키워드> 입찰가를"
  //   라인 2: "<현재>원 → <목표>원(±차액)으로 변경하시겠습니까?"
  // 차액 부호는 한국 컨벤션(주식 시세)을 따라 인상=빨강 / 인하=파랑.
  const body = document.createElement("div");
  body.className = "dvads-confirm-body";

  const line1 = document.createElement("div");
  line1.className = "dvads-confirm-line";
  const kwBold = document.createElement("b");
  kwBold.textContent = opts.keyword;
  line1.append(kwBold, " 입찰가를");
  body.appendChild(line1);

  const line2 = document.createElement("div");
  line2.className = "dvads-confirm-line";
  const arrowBold = document.createElement("b");
  arrowBold.className = "dvads-confirm-arrow";
  if (opts.currentBid != null) {
    arrowBold.textContent = `${opts.currentBid.toLocaleString()}원 → ${opts.targetBid.toLocaleString()}원`;
  } else {
    arrowBold.textContent = `${opts.targetBid.toLocaleString()}원`;
  }
  line2.append(arrowBold);

  if (opts.currentBid != null && opts.currentBid !== opts.targetBid) {
    const diff = opts.targetBid - opts.currentBid;
    const sign = diff > 0 ? "+" : "-";
    const delta = document.createElement("span");
    delta.className = diff > 0 ? "dvads-confirm-delta-up" : "dvads-confirm-delta-down";
    delta.textContent = `(${sign}${Math.abs(diff).toLocaleString()})`;
    line2.append(delta);
  }
  line2.append("으로 변경하시겠습니까?");
  body.appendChild(line2);

  card.appendChild(body);

  const actions = document.createElement("div");
  actions.className = "dvads-confirm-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "dvads-btn dvads-btn-secondary";
  cancelBtn.textContent = "취소";
  actions.appendChild(cancelBtn);

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "dvads-btn dvads-btn-primary";
  confirmBtn.textContent = "변경";
  actions.appendChild(confirmBtn);

  card.appendChild(actions);

  document.body.appendChild(backdrop);

  let busy = false;

  // 다이얼로그가 떠 있는 동안 document로 전파되는 click은 모두 차단 —
  // 부모 popover의 "바깥 클릭 시 닫기" 리스너에 도달하지 않게 한다.
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
  };
  const onBackdropClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    if (e.target === backdrop) cancel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (busy) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      cancel();
    }
  };

  backdrop.addEventListener("click", onBackdropClick);
  // 카드 내부 클릭(버튼 포함)도 document로 새지 않도록 위임 차단
  card.addEventListener("click", swallow);
  document.addEventListener("keydown", onKey);

  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    // disabled가 있어도 스페이스바 등으로 이벤트가 들어올 수 있어 명시 가드
    if (busy) return;
    cancel();
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (busy) return;
    cancel();
  });
  confirmBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (busy) return;
    busy = true;
    confirmBtn.classList.add("dvads-btn-loading");
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    // 카드에 busy 클래스 — close 버튼 시각 피드백(opacity/cursor)
    card.classList.add("dvads-confirm-busy");
    try {
      await opts.onConfirm();
    } finally {
      teardown();
    }
  });

  openDialogCleanup = teardown;

  function cancel() {
    teardown();
    opts.onCancel?.();
  }

  function teardown() {
    if (!backdrop.isConnected) return;
    backdrop.removeEventListener("click", onBackdropClick);
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (openDialogCleanup === teardown) openDialogCleanup = null;
  }
}

export function closeConfirmDialog(): void {
  openDialogCleanup?.();
  openDialogCleanup = null;
}
