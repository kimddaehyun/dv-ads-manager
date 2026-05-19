/**
 * F-AssetBulk — 일괄 등록 팝업 UI.
 *
 * "+ 새 확장 소재 ▾" 드롭다운에 우리가 주입한 "일괄 등록" 항목을 클릭하면 떠는
 * native DOM 모달. 파워링크 이미지·추가제목·추가설명 3종을 한 번에 입력받아
 * 호출자(asset-bulk.ts orchestrator)에 넘긴다. 자동화 진행은 호출자가 담당.
 *
 * confirm-dialog.ts와 동일하게 dvads- prefix + z-index 최대값. 자동화 진행 중에는
 * 팝업+백드롭을 visibility hidden으로 잠깐 뒤로 보낸다 — 페이지 확장소재 모달이
 * 화면 가운데에 자유롭게 떠 사용자가 자동화 흐름을 직접 보도록.
 */

export type ImageMode = "file" | "url";

export interface ImageSlotInput {
  /** 모드 미선택 = null (초기 상태). 사용자가 [파일]/[URL] 버튼을 누르면 선택됨. */
  mode: ImageMode | null;
  file?: File;
  url?: string;
}

export interface AssetBulkInput {
  images: ImageSlotInput[];
  headlines: string[];
  descriptions: string[];
}

export interface AssetBulkPopupOptions {
  /**
   * 사용자가 "일괄 등록"을 누른 시점에 호출. 이 동안 팝업은 자동 hidden 처리되며,
   * 끝나면 자동 닫힘. 호출자는 진행률/결과를 토스트로 표시한다.
   */
  onSubmit: (data: AssetBulkInput) => Promise<void>;
  onCancel?: () => void;
}

// 추가제목/추가설명 maxlength — 페이지의 maxlength 속성 실측. 갈리면 여기만 고치면 됨.
const HEADLINE_MAX = 15;
const DESCRIPTION_MAX = 45;
// 페이지 정책상 광고그룹당 추가설명 최대 1개 — 모달 안내문 명시 ("추가설명은 최대 1개만 노출됩니다").
const DESCRIPTION_SLOT_LIMIT = 1;
// 추가제목·이미지 UI 상한 — 페이지가 받는 만큼 늘릴 수 있되 현실적 상한.
const HEADLINE_SLOT_LIMIT = 8;
const IMAGE_SLOT_LIMIT = 8;

let openCleanup: (() => void) | null = null;

export function openAssetBulkPopup(opts: AssetBulkPopupOptions): void {
  closeAssetBulkPopup();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-confirm-backdrop dvads-asset-bulk-backdrop";

  const card = document.createElement("div");
  card.className = "dvads-confirm-card dvads-asset-bulk-card";
  backdrop.appendChild(card);

  const header = document.createElement("div");
  header.className = "dvads-confirm-header";
  const title = document.createElement("div");
  title.className = "dvads-confirm-title";
  title.textContent = "확장 소재 일괄 등록";
  header.appendChild(title);
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dvads-confirm-close";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "×";
  header.appendChild(closeBtn);
  card.appendChild(header);

  const intro = document.createElement("div");
  intro.className = "dvads-asset-bulk-intro";
  intro.textContent =
    "파워링크 이미지 · 추가제목 · 추가설명을 한 번에 등록합니다. 입력한 항목만 순서대로 자동 등록됩니다.";
  card.appendChild(intro);

  const body = document.createElement("div");
  body.className = "dvads-asset-bulk-body";
  card.appendChild(body);

  const state: AssetBulkInput = {
    images: [{ mode: null }],
    headlines: [""],
    descriptions: [""],
  };

  body.appendChild(buildImageSection(state, IMAGE_SLOT_LIMIT).root);

  body.appendChild(
    buildTextSection({
      label: "추가제목",
      hint: `각 ${HEADLINE_MAX}자 이내. 입력한 칸 수만큼 순차 등록됩니다.`,
      getValues: () => state.headlines,
      setValues: (next) => {
        state.headlines = next;
      },
      maxLength: HEADLINE_MAX,
      slotLimit: HEADLINE_SLOT_LIMIT,
    }).root,
  );

  body.appendChild(
    buildTextSection({
      label: "추가설명",
      hint: `${DESCRIPTION_MAX}자 이내. 광고그룹당 추가설명은 1개만 노출됩니다.`,
      getValues: () => state.descriptions,
      setValues: (next) => {
        state.descriptions = next;
      },
      maxLength: DESCRIPTION_MAX,
      slotLimit: DESCRIPTION_SLOT_LIMIT,
    }).root,
  );

  const actions = document.createElement("div");
  actions.className = "dvads-confirm-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "dvads-btn dvads-btn-secondary";
  cancelBtn.textContent = "취소";
  actions.appendChild(cancelBtn);
  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "dvads-btn dvads-btn-primary";
  submitBtn.textContent = "일괄 등록";
  actions.appendChild(submitBtn);
  card.appendChild(actions);

  document.body.appendChild(backdrop);

  let busy = false;

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
  const swallow = (e: MouseEvent) => e.stopPropagation();

  backdrop.addEventListener("click", onBackdropClick);
  card.addEventListener("click", swallow);
  document.addEventListener("keydown", onKey);

  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (busy) return;
    cancel();
  });
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (busy) return;
    cancel();
  });

  submitBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (busy) return;
    busy = true;
    // 자동화 동안 팝업은 시각만 hidden — 사용자가 페이지 모달이 자동으로 열리고
    // 닫히는 흐름을 직접 본다. 진행률/결과는 호출자가 토스트로 표시.
    backdrop.classList.add("dvads-recede");
    try {
      await opts.onSubmit(state);
    } finally {
      teardown();
    }
  });

  openCleanup = teardown;

  function cancel() {
    teardown();
    opts.onCancel?.();
  }

  function teardown() {
    if (!backdrop.isConnected) return;
    backdrop.removeEventListener("click", onBackdropClick);
    document.removeEventListener("keydown", onKey);
    backdrop.remove();
    if (openCleanup === teardown) openCleanup = null;
  }
}

export function closeAssetBulkPopup(): void {
  openCleanup?.();
  openCleanup = null;
}

// ─── 이미지 섹션 ───

function buildImageSection(
  state: AssetBulkInput,
  slotLimit: number,
): { root: HTMLElement } {
  const root = document.createElement("section");
  root.className = "dvads-asset-bulk-section";

  const head = document.createElement("div");
  head.className = "dvads-asset-bulk-section-head";
  const title = document.createElement("h3");
  title.className = "dvads-asset-bulk-section-title";
  title.textContent = "파워링크 이미지";
  head.appendChild(title);
  const hint = document.createElement("span");
  hint.className = "dvads-asset-bulk-section-hint";
  hint.textContent =
    "BMP / JPG / PNG · 최대 2000x2000 · 5MB. 한 모달에 여러 장 함께 등록됩니다.";
  head.appendChild(hint);
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "dvads-asset-bulk-slots";
  root.appendChild(list);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "dvads-asset-bulk-add";
  addBtn.textContent = "+ 이미지 슬롯 추가";
  addBtn.addEventListener("click", () => {
    if (state.images.length >= slotLimit) return;
    state.images.push({ mode: null });
    renderSlots();
  });
  root.appendChild(addBtn);

  renderSlots();
  return { root };

  function renderSlots(): void {
    list.replaceChildren();
    state.images.forEach((_slot, idx) => {
      list.appendChild(buildImageSlot(idx));
    });
    addBtn.disabled = state.images.length >= slotLimit;
  }

  function buildImageSlot(idx: number): HTMLElement {
    const slot = state.images[idx];
    const row = document.createElement("div");
    row.className = "dvads-asset-bulk-image-row";

    const modeWrap = document.createElement("div");
    modeWrap.className = "dvads-asset-bulk-mode";
    const modeFile = makeModeBtn("파일", slot.mode === "file");
    const modeUrl = makeModeBtn("URL", slot.mode === "url");
    modeFile.addEventListener("click", () => {
      if (slot.mode === "file") return;
      state.images[idx] = { mode: "file" };
      renderSlots();
    });
    modeUrl.addEventListener("click", () => {
      if (slot.mode === "url") return;
      state.images[idx] = { mode: "url" };
      renderSlots();
    });
    modeWrap.append(modeFile, modeUrl);
    row.appendChild(modeWrap);

    const inputArea = document.createElement("div");
    inputArea.className = "dvads-asset-bulk-image-input";
    if (slot.mode === "file") {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/png,image/jpeg,image/bmp,.png,.jpg,.jpeg,.bmp";
      fileInput.className = "dvads-asset-bulk-file";
      const fileName = document.createElement("span");
      fileName.className = "dvads-asset-bulk-file-name";
      fileName.textContent = slot.file ? slot.file.name : "";
      fileInput.addEventListener("change", () => {
        const f = fileInput.files?.[0];
        state.images[idx] = f ? { mode: "file", file: f } : { mode: "file" };
        fileName.textContent = f ? f.name : "";
      });
      inputArea.append(fileInput, fileName);
    } else if (slot.mode === "url") {
      const urlInput = document.createElement("input");
      urlInput.type = "url";
      urlInput.placeholder = "https://...";
      urlInput.className = "dvads-asset-bulk-url";
      urlInput.value = slot.url ?? "";
      urlInput.addEventListener("input", () => {
        const v = urlInput.value.trim();
        state.images[idx] = v ? { mode: "url", url: v } : { mode: "url" };
      });
      inputArea.appendChild(urlInput);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "dvads-asset-bulk-image-placeholder";
      placeholder.textContent = "파일 또는 URL을 선택하세요";
      inputArea.appendChild(placeholder);
    }
    row.appendChild(inputArea);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "dvads-asset-bulk-remove";
    removeBtn.setAttribute("aria-label", "슬롯 삭제");
    removeBtn.textContent = "×";
    removeBtn.disabled = state.images.length <= 1;
    removeBtn.addEventListener("click", () => {
      if (state.images.length <= 1) return;
      state.images.splice(idx, 1);
      renderSlots();
    });
    row.appendChild(removeBtn);

    return row;
  }

  function makeModeBtn(label: string, active: boolean): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = active
      ? "dvads-asset-bulk-mode-btn dvads-asset-bulk-mode-btn-active"
      : "dvads-asset-bulk-mode-btn";
    b.textContent = label;
    return b;
  }
}

// ─── 텍스트 섹션 (추가제목 / 추가설명 공용) ───

interface TextSectionOpts {
  label: string;
  hint: string;
  getValues: () => string[];
  setValues: (next: string[]) => void;
  maxLength: number;
  slotLimit: number;
}

function buildTextSection(opts: TextSectionOpts): { root: HTMLElement } {
  const root = document.createElement("section");
  root.className = "dvads-asset-bulk-section";

  const head = document.createElement("div");
  head.className = "dvads-asset-bulk-section-head";
  const title = document.createElement("h3");
  title.className = "dvads-asset-bulk-section-title";
  title.textContent = opts.label;
  head.appendChild(title);
  const hint = document.createElement("span");
  hint.className = "dvads-asset-bulk-section-hint";
  hint.textContent = opts.hint;
  head.appendChild(hint);
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "dvads-asset-bulk-slots";
  root.appendChild(list);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "dvads-asset-bulk-add";
  addBtn.textContent = `+ ${opts.label} 슬롯 추가`;
  addBtn.addEventListener("click", () => {
    const values = opts.getValues();
    if (values.length >= opts.slotLimit) return;
    const next = [...values, ""];
    opts.setValues(next);
    renderSlots();
  });
  root.appendChild(addBtn);

  renderSlots();
  return { root };

  function renderSlots(): void {
    list.replaceChildren();
    const values = opts.getValues();
    values.forEach((value, idx) => {
      const row = document.createElement("div");
      row.className = "dvads-asset-bulk-text-row";

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = opts.maxLength;
      input.value = value;
      input.className = "dvads-asset-bulk-text-input";
      input.placeholder = `${opts.label} ${idx + 1}`;
      const counter = document.createElement("span");
      counter.className = "dvads-asset-bulk-text-counter";
      counter.textContent = `${value.length}/${opts.maxLength}`;
      input.addEventListener("input", () => {
        const cur = opts.getValues();
        cur[idx] = input.value;
        counter.textContent = `${input.value.length}/${opts.maxLength}`;
        opts.setValues(cur);
      });
      row.append(input, counter);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "dvads-asset-bulk-remove";
      removeBtn.setAttribute("aria-label", "슬롯 삭제");
      removeBtn.textContent = "×";
      removeBtn.disabled = values.length <= 1;
      removeBtn.addEventListener("click", () => {
        const cur = opts.getValues();
        if (cur.length <= 1) return;
        cur.splice(idx, 1);
        opts.setValues(cur);
        renderSlots();
      });
      row.appendChild(removeBtn);

      list.appendChild(row);
    });
    addBtn.disabled = opts.getValues().length >= opts.slotLimit;
  }
}
