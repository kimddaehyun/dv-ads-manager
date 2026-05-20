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

import {
  closeAllOpenDropdowns,
  createDropdown,
} from "@/content/ui-dropdown";
import {
  resolveAndExtract,
  clearProductPageCache,
  type ExtractResult,
} from "@/lib/product-page-extract";

/**
 * 파워링크 이미지 영역 입력값.
 *
 * v1의 슬롯 N개 구조를 폐기하고 단일 영역으로 통합.
 *   - files: 사용자가 직접 첨부한 파일 (multiple 지원)
 *   - selectedUrls: 상품 페이지에서 추출된 후보 중 사용자가 체크한 이미지 URL
 *
 * 페이지 모달은 file input multiple 한 번에 1세트 업로드 — 슬롯 분리할 이유 없음.
 * 한도는 페이지에 이미 등록된 이미지 수를 차감한 (2 - existing.imageCount)장.
 */
export interface AssetBulkImagesInput {
  files: File[];
  /** 사용자가 마지막으로 입력한 페이지 URL/ID — 재펼침·재시도 상태 보존용 */
  pageUrl: string;
  /** 마지막 가져오기 결과 후보 URL */
  candidates: string[];
  /** 그리드에서 체크한 이미지 URL */
  selectedUrls: string[];
}

/**
 * 추가제목 노출 위치 — 페이지 모달의 "노출 가능 위치 지정" dropdown과 1:1 매핑.
 *   "all" → "모든 위치에 노출 가능"  (default)
 *   "p1"  → "위치 1에만 노출 가능"
 *   "p2"  → "위치 2에만 노출 가능"
 */
export type HeadlinePosition = "all" | "p1" | "p2";

export interface HeadlineSlotInput {
  text: string;
  position: HeadlinePosition;
}

/**
 * 홍보문구 종류 — 페이지 모달의 "홍보종류" dropdown과 1:1 매핑.
 *   "none"       → "선택 안 함"      (default)
 *   "discount"   → "할인"
 *   "freebie"    → "사은품"
 *   "extra-gift" → "추가선물증정"
 *   "event"      → "이벤트"
 *   "newitem"    → "신상품"
 */
export type PromoKind =
  | "none"
  | "discount"
  | "freebie"
  | "extra-gift"
  | "event"
  | "newitem";

export interface PromoSlotInput {
  kind: PromoKind;
  description: string;
}

export interface AssetBulkInput {
  images: AssetBulkImagesInput;
  headlines: HeadlineSlotInput[];
  descriptions: string[];
  promos: PromoSlotInput[];
}

export interface AssetBulkPopupOptions {
  /**
   * 사용자가 "일괄 등록"을 누른 시점에 호출. 이 동안 팝업은 자동 hidden 처리되며,
   * 끝나면 자동 닫힘. 호출자는 진행률/결과를 토스트로 표시한다.
   */
  onSubmit: (data: AssetBulkInput) => Promise<void>;
  onCancel?: () => void;
  /** 페이지에 이미 등록된 추가제목 텍스트 — 슬롯에 실시간 중복 경고 표시. */
  existingHeadlines?: Set<string>;
  /** 페이지에 이미 등록된 추가설명 텍스트 — 슬롯에 실시간 중복 경고 표시. */
  existingDescriptions?: Set<string>;
  /** 페이지에 이미 등록된 홍보문구 추가설명 텍스트 — 슬롯에 실시간 중복 경고 표시. */
  existingPromos?: Set<string>;
}

/**
 * popup이 열린 후 외부에서 기존 등록 데이터를 갱신할 수 있는 핸들.
 * 페이지 크기 변경 + scan을 popup backdrop 뒤에서 비동기로 진행하기 위해 필요.
 */
export interface AssetBulkPopupHandle {
  setExisting(existing: {
    headlines: Set<string>;
    descriptions: Set<string>;
    promos: Set<string>;
    imageCount: number;
  }): void;
}

// 추가제목/추가설명/홍보문구 maxlength — 페이지의 maxlength 속성 실측. 갈리면 여기만 고치면 됨.
const HEADLINE_MAX = 15;
const DESCRIPTION_MAX = 45;
const PROMO_DESC_MAX = 14;
// 페이지 정책상 광고그룹당 추가설명 최대 1개 — 모달 안내문 명시 ("추가설명은 최대 1개만 노출됩니다").
const DESCRIPTION_SLOT_LIMIT = 4;
// 홍보문구는 광고그룹당 최대 2개 — 사용자 정책 (PRD).
const PROMO_SLOT_LIMIT = 2;
// 추가제목 UI 상한 — 페이지가 받는 만큼 늘릴 수 있되 현실적 상한.
const HEADLINE_SLOT_LIMIT = 8;
// 파워링크 이미지는 광고그룹당 최대 2장. 페이지 등록 개수만큼 차감해 남은 슬롯 표시.
const IMAGE_TOTAL_LIMIT = 2;

let openCleanup: (() => void) | null = null;

export function openAssetBulkPopup(opts: AssetBulkPopupOptions): AssetBulkPopupHandle {
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

  const body = document.createElement("div");
  body.className = "dvads-asset-bulk-body";
  card.appendChild(body);

  const state: AssetBulkInput = {
    images: { files: [], pageUrl: "", candidates: [], selectedUrls: [] },
    headlines: [{ text: "", position: "all" }],
    descriptions: [""],
    promos: [{ kind: "none", description: "" }],
  };

  // 이미지 영역. 페이지 등록 이미지 개수는 외부에서 setExisting으로 늦게 들어올 수 있어
  // mutable holder로 두고 section이 매 카운터 계산 시 최신 값을 본다.
  const imageExisting = { count: 0 };
  const imageBlock = buildImageBlock(state, imageExisting, IMAGE_TOTAL_LIMIT);
  body.appendChild(imageBlock.root);

  // 외부에서 갱신 가능하도록 Set은 mutable reference로 보관 — section은 이 Set을 참조.
  // setExisting 호출 시 Set.clear() + add()로 갱신하면 section의 recompute가 새 값을 본다.
  const headlineSet = new Set<string>(opts.existingHeadlines ?? []);
  const descSet = new Set<string>(opts.existingDescriptions ?? []);
  const promoSet = new Set<string>(opts.existingPromos ?? []);

  const headlineSection = buildHeadlineSection({
    label: "추가제목",
    getValues: () => state.headlines,
    setValues: (next) => {
      state.headlines = next;
    },
    maxLength: HEADLINE_MAX,
    slotLimit: HEADLINE_SLOT_LIMIT,
    existingTexts: headlineSet,
  });
  body.appendChild(headlineSection.root);

  // 광고그룹당 추가설명은 페이지 기준 최대 4개. slotLimit은 보수적으로 처음에 4로 고정
  // (외부 scan 결과가 늦게 도착해도 사용자 데이터 보호) — submit 시 자동 skip으로 처리.
  const descSection = buildTextSection({
    label: "추가설명",
    getValues: () => state.descriptions,
    setValues: (next) => {
      state.descriptions = next;
    },
    maxLength: DESCRIPTION_MAX,
    slotLimit: DESCRIPTION_SLOT_LIMIT,
    existingTexts: descSet,
  });
  body.appendChild(descSection.root);

  const promoSection = buildPromoSection({
    getValues: () => state.promos,
    setValues: (next) => {
      state.promos = next;
    },
    slotLimit: PROMO_SLOT_LIMIT,
    maxLength: PROMO_DESC_MAX,
    existingTexts: promoSet,
  });
  body.appendChild(promoSection.root);

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
  submitBtn.textContent = "등록";
  actions.appendChild(submitBtn);
  card.appendChild(actions);

  document.body.appendChild(backdrop);

  let busy = false;

  // input 텍스트를 드래그해서 backdrop 위에서 mouseup하면 click 이벤트의 target이
  // backdrop으로 잡혀 의도치 않게 닫히는 버그 방지 — pointerdown이 card 안에서
  // 시작됐으면 그 직후 click은 skip.
  let pressedInsideCard = false;
  const onPointerDown = (e: PointerEvent) => {
    pressedInsideCard = card.contains(e.target as Node);
  };
  const onBackdropClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    if (pressedInsideCard) {
      pressedInsideCard = false;
      return;
    }
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

  backdrop.addEventListener("pointerdown", onPointerDown);
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
    backdrop.removeEventListener("pointerdown", onPointerDown);
    backdrop.removeEventListener("click", onBackdropClick);
    document.removeEventListener("keydown", onKey);
    // portal로 body에 mount된 dropdown 패널은 backdrop.remove()로 못 잡아 별도 정리.
    closeAllOpenDropdowns();
    // 상품 페이지 추출 결과 캐시는 popup 사이클 단위. 닫히면 폐기.
    clearProductPageCache();
    backdrop.remove();
    if (openCleanup === teardown) openCleanup = null;
  }

  return {
    setExisting(existing) {
      // popup이 이미 닫혔으면 무시
      if (!backdrop.isConnected) return;
      headlineSet.clear();
      existing.headlines.forEach((t) => headlineSet.add(t));
      descSet.clear();
      existing.descriptions.forEach((t) => descSet.add(t));
      promoSet.clear();
      existing.promos.forEach((t) => promoSet.add(t));
      imageExisting.count = existing.imageCount;
      headlineSection.recompute();
      descSection.recompute();
      promoSection.recompute();
      imageBlock.recompute();
      // 추가설명 한도 동적 갱신 — 페이지 등록 N개 + 입력 가능 슬롯 = 4 유지.
      // 한도 초과 시 마지막 빈 슬롯 제거되어 더 이상 입력 못 함.
      const remainingDescSlots = Math.max(0, DESCRIPTION_SLOT_LIMIT - descSet.size);
      descSection.setSlotLimit(remainingDescSlots);
      // 홍보문구도 동일 — 페이지 등록 N개 + 입력 가능 슬롯 = 2 유지.
      const remainingPromoSlots = Math.max(0, PROMO_SLOT_LIMIT - promoSet.size);
      promoSection.setSlotLimit(remainingPromoSlots);
    },
  };
}

export function closeAssetBulkPopup(): void {
  openCleanup?.();
  openCleanup = null;
}

// ─── 이미지 영역 ───

/**
 * 파워링크 이미지 영역 — 파일 첨부 + 상품 페이지 URL 후보 그리드 통합.
 *
 * 한도(2장)는 페이지에 이미 등록된 imageCount + 사용자 선택(files + selectedUrls) 합으로 계산.
 * 한도 초과 시도는 inline 메시지(1.5초)로 안내, 자동 선택 해제는 안 함(사용자 작업 보호).
 */
function buildImageBlock(
  state: AssetBulkInput,
  existing: { count: number },
  totalLimit: number,
): { root: HTMLElement; recompute: () => void } {
  const root = document.createElement("section");
  root.className = "dvads-asset-bulk-section";

  const head = document.createElement("div");
  head.className = "dvads-asset-bulk-section-head";
  const title = document.createElement("h3");
  title.className = "dvads-asset-bulk-section-title";
  title.textContent = "파워링크 이미지";
  head.appendChild(title);
  const counter = document.createElement("span");
  counter.className = "dvads-asset-bulk-counter";
  head.appendChild(counter);
  root.appendChild(head);

  // 파일 첨부 영역
  const fileRow = document.createElement("div");
  fileRow.className = "dvads-asset-bulk-file-row";
  const addFileBtn = document.createElement("button");
  addFileBtn.type = "button";
  addFileBtn.className = "dvads-btn dvads-btn-secondary";
  addFileBtn.textContent = "+ 파일 첨부";
  const hiddenFileInput = document.createElement("input");
  hiddenFileInput.type = "file";
  hiddenFileInput.multiple = true;
  hiddenFileInput.accept = "image/png,image/jpeg,image/bmp,.png,.jpg,.jpeg,.bmp";
  hiddenFileInput.style.display = "none";
  const fileList = document.createElement("ul");
  fileList.className = "dvads-asset-bulk-file-list";
  fileRow.append(addFileBtn, hiddenFileInput, fileList);
  root.appendChild(fileRow);

  // URL/ID 가져오기 영역
  const urlRow = document.createElement("div");
  urlRow.className = "dvads-asset-bulk-url-row";
  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.placeholder = "상품 링크 또는 상품ID";
  urlInput.className = "dvads-asset-bulk-url-input";
  const fetchBtn = document.createElement("button");
  fetchBtn.type = "button";
  fetchBtn.className = "dvads-btn dvads-btn-secondary";
  fetchBtn.textContent = "가져오기";
  urlRow.append(urlInput, fetchBtn);
  root.appendChild(urlRow);

  // 후보 그리드 (가져오기 성공 시 mount)
  const grid = document.createElement("div");
  grid.className = "dvads-asset-bulk-thumb-grid";
  grid.hidden = true;
  root.appendChild(grid);

  // 상태 메시지(로딩/에러/안내) inline
  const status = document.createElement("div");
  status.className = "dvads-asset-bulk-image-status";
  status.hidden = true;
  root.appendChild(status);

  // race 가드용 token — 가져오기 중복 호출 시 stale resolve 무시.
  let fetchToken = 0;
  // 한도 초과 토글 안내 일시 표시용 timeout id.
  let limitHintTimeout: number | null = null;

  addFileBtn.addEventListener("click", () => {
    if (remaining() <= 0) return;
    hiddenFileInput.click();
  });

  hiddenFileInput.addEventListener("change", () => {
    const picked = Array.from(hiddenFileInput.files ?? []);
    if (picked.length === 0) return;
    // dedup: 파일명+size로 동일한 파일 두 번 첨부 방지.
    const existingKeys = new Set(state.images.files.map((f) => `${f.name}|${f.size}`));
    const room = remaining();
    let added = 0;
    for (const f of picked) {
      if (added >= room) break;
      const key = `${f.name}|${f.size}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      state.images.files.push(f);
      added++;
    }
    if (added < picked.length) {
      flashLimitHint(`최대 ${totalLimit}장까지 등록할 수 있어요`);
    }
    hiddenFileInput.value = ""; // 같은 파일 재선택 가능하도록 reset
    renderFiles();
    renderCounter();
  });

  urlInput.addEventListener("input", () => {
    state.images.pageUrl = urlInput.value;
  });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerFetch();
    }
  });
  fetchBtn.addEventListener("click", () => {
    triggerFetch();
  });

  async function triggerFetch(): Promise<void> {
    const raw = urlInput.value.trim();
    if (!raw) return;
    const myToken = ++fetchToken;
    // 새 가져오기는 기존 후보·선택 reset(파일은 유지).
    state.images.candidates = [];
    state.images.selectedUrls = [];
    grid.hidden = true;
    grid.replaceChildren();
    showStatus("불러오는 중...", "loading");
    fetchBtn.disabled = true;
    urlInput.disabled = true;
    try {
      const result: ExtractResult = await resolveAndExtract(raw);
      if (myToken !== fetchToken) return; // stale
      if (result.candidates.length === 0) {
        showStatus(
          "이 페이지에서 이미지를 찾지 못했어요. 다른 상품 페이지를 시도하거나 파일로 직접 첨부해 주세요",
          "error",
        );
        return;
      }
      state.images.candidates = result.candidates;
      renderGrid();
      hideStatus();
    } catch (e) {
      if (myToken !== fetchToken) return;
      const msg = e instanceof Error && e.message ? e.message : "상품 페이지를 불러오지 못했어요";
      showStatus(msg, "error");
    } finally {
      if (myToken === fetchToken) {
        fetchBtn.disabled = false;
        urlInput.disabled = false;
      }
    }
  }

  function renderFiles(): void {
    fileList.replaceChildren();
    state.images.files.forEach((f, idx) => {
      const li = document.createElement("li");
      li.className = "dvads-asset-bulk-file-item";
      const name = document.createElement("span");
      name.className = "dvads-asset-bulk-file-name";
      name.textContent = f.name;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "dvads-asset-bulk-text-clear";
      removeBtn.setAttribute("aria-label", "파일 제거");
      removeBtn.textContent = "×";
      removeBtn.addEventListener("click", () => {
        state.images.files.splice(idx, 1);
        renderFiles();
        renderCounter();
      });
      li.append(name, removeBtn);
      fileList.appendChild(li);
    });
  }

  function renderGrid(): void {
    grid.replaceChildren();
    state.images.candidates.forEach((url) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dvads-asset-bulk-thumb";
      const img = document.createElement("img");
      img.src = url;
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      const check = document.createElement("span");
      check.className = "dvads-asset-bulk-thumb-check";
      check.textContent = "✓";
      btn.append(img, check);
      const applySelected = () => {
        const isSelected = state.images.selectedUrls.includes(url);
        btn.classList.toggle("dvads-asset-bulk-thumb-selected", isSelected);
      };
      applySelected();
      btn.addEventListener("click", () => {
        const i = state.images.selectedUrls.indexOf(url);
        if (i >= 0) {
          state.images.selectedUrls.splice(i, 1);
          applySelected();
          renderCounter();
          return;
        }
        if (remaining() <= 0) {
          flashLimitHint(
            existing.count > 0
              ? `최대 ${totalLimit}장까지 등록할 수 있어요 (페이지에 ${existing.count}장 이미 등록)`
              : `최대 ${totalLimit}장까지 등록할 수 있어요`,
          );
          return;
        }
        state.images.selectedUrls.push(url);
        applySelected();
        renderCounter();
      });
      grid.appendChild(btn);
    });
    grid.hidden = false;
  }

  function showStatus(msg: string, kind: "loading" | "error"): void {
    status.textContent = msg;
    status.classList.toggle("dvads-asset-bulk-image-status-error", kind === "error");
    status.classList.toggle("dvads-asset-bulk-image-status-loading", kind === "loading");
    status.hidden = false;
  }

  function hideStatus(): void {
    status.hidden = true;
    status.textContent = "";
  }

  function flashLimitHint(msg: string): void {
    showStatus(msg, "error");
    if (limitHintTimeout != null) window.clearTimeout(limitHintTimeout);
    limitHintTimeout = window.setTimeout(() => {
      if (status.textContent === msg) hideStatus();
      limitHintTimeout = null;
    }, 1500);
  }

  function selectedCount(): number {
    return state.images.files.length + state.images.selectedUrls.length;
  }
  function remaining(): number {
    return Math.max(0, totalLimit - existing.count - selectedCount());
  }

  function renderCounter(): void {
    const sel = selectedCount();
    const ex = existing.count;
    const noteParts: string[] = [];
    if (ex > 0) noteParts.push(`페이지에 이미 ${ex}장 등록`);
    const note = noteParts.length > 0 ? ` (${noteParts.join(", ")})` : "";
    counter.textContent = `선택 ${sel}/${Math.max(0, totalLimit - ex)}${note}`;
    const fullyBlocked = totalLimit - ex <= 0;
    addFileBtn.disabled = fullyBlocked || remaining() <= 0;
    urlInput.disabled = fullyBlocked;
    fetchBtn.disabled = fullyBlocked;
    counter.classList.toggle("dvads-asset-bulk-counter-blocked", fullyBlocked);
    if (fullyBlocked && status.hidden) {
      showStatus("이미 최대치 등록됨 — 페이지에서 일부 삭제 후 재시도해 주세요", "error");
    }
  }

  renderFiles();
  renderCounter();

  return { root, recompute: renderCounter };
}

// ─── 추가제목 섹션 (텍스트 + 노출 위치 dropdown) ───

interface HeadlineSectionOpts {
  label: string;
  getValues: () => HeadlineSlotInput[];
  setValues: (next: HeadlineSlotInput[]) => void;
  maxLength: number;
  slotLimit: number;
  existingTexts: Set<string>;
}

const HEADLINE_POSITION_LABELS: Record<HeadlinePosition, string> = {
  all: "모든 위치",
  p1: "위치 1만",
  p2: "위치 2만",
};

function buildHeadlineSection(opts: HeadlineSectionOpts): {
  root: HTMLElement;
  recompute: () => void;
} {
  const root = document.createElement("section");
  root.className = "dvads-asset-bulk-section";

  const head = document.createElement("div");
  head.className = "dvads-asset-bulk-section-head";
  const title = document.createElement("h3");
  title.className = "dvads-asset-bulk-section-title";
  title.textContent = opts.label;
  head.appendChild(title);
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "dvads-asset-bulk-slots";
  root.appendChild(list);

  // 슬롯 input 1개 변경 시 같은 섹션 내 모든 슬롯의 중복 상태를 재계산해야 함
  // (페이지 등록 + 다른 슬롯과의 동일성 둘 다 판정). row 생성 시 콜백을 등록해두고
  // 입력 이벤트마다 일괄 호출.
  const rowUpdaters: Array<(allTexts: string[]) => void> = [];
  const recomputeAllDup = (): void => {
    const texts = opts.getValues().map((v) => v.text);
    rowUpdaters.forEach((fn) => fn(texts));
  };

  // 입력 시 마지막 슬롯이 비어있지 않고 limit 미만이면 빈 슬롯을 끝에 append.
  // 전체 재렌더가 아닌 row 한 개만 추가 → 입력 중인 input의 focus를 잃지 않음.
  const maybeAppendEmpty = (): void => {
    const cur = opts.getValues();
    if (cur.length >= opts.slotLimit) return;
    if (cur[cur.length - 1]?.text.trim().length === 0) return;
    const newIdx = cur.length;
    const newSlot: HeadlineSlotInput = { text: "", position: "all" };
    opts.setValues([...cur, newSlot]);
    list.appendChild(createRow(newSlot, newIdx));
    recomputeAllDup();
  };

  function createRow(slot: HeadlineSlotInput, idx: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "dvads-asset-bulk-text-row dvads-asset-bulk-headline-row";

    const inputWrap = document.createElement("div");
    inputWrap.className = "dvads-asset-bulk-input-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = opts.maxLength;
    input.value = slot.text;
    input.className = "dvads-asset-bulk-text-input";
    input.placeholder = `${opts.label} ${idx + 1}`;
    const counter = document.createElement("span");
    counter.className = "dvads-asset-bulk-text-counter";
    counter.textContent = `${slot.text.length}/${opts.maxLength}`;
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "dvads-asset-bulk-text-clear";
    clearBtn.setAttribute("aria-label", "슬롯 삭제");
    clearBtn.textContent = "×";
    clearBtn.hidden = slot.text.length === 0;
    const dupWarn = document.createElement("span");
    dupWarn.className = "dvads-asset-bulk-dup-warn";
    const applyDupState = (allTexts: string[]): void => {
      const t = (allTexts[idx] ?? "").trim();
      if (!t) {
        row.classList.remove("dvads-asset-bulk-dup");
        return;
      }
      const isDup =
        opts.existingTexts.has(t) ||
        allTexts.some((other, i) => i !== idx && other.trim() === t);
      if (isDup) {
        dupWarn.textContent = `이미 등록된 ${opts.label}입니다`;
        row.classList.add("dvads-asset-bulk-dup");
      } else {
        row.classList.remove("dvads-asset-bulk-dup");
      }
    };
    rowUpdaters.push(applyDupState);
    input.addEventListener("input", () => {
      const cur = opts.getValues();
      cur[idx] = { ...cur[idx], text: input.value };
      counter.textContent = `${input.value.length}/${opts.maxLength}`;
      clearBtn.hidden = input.value.length === 0;
      opts.setValues(cur);
      recomputeAllDup();
      maybeAppendEmpty();
    });
    clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = opts.getValues();
      // 슬롯이 1개뿐이면 텍스트만 클리어. 2개 이상이면 해당 슬롯 삭제 후 전체 재렌더
      // (idx shift 처리 필요해서 partial render 불가).
      if (cur.length <= 1) {
        cur[idx] = { ...cur[idx], text: "" };
        input.value = "";
        counter.textContent = `0/${opts.maxLength}`;
        clearBtn.hidden = true;
        opts.setValues(cur);
        recomputeAllDup();
        return;
      }
      cur.splice(idx, 1);
      opts.setValues(cur);
      renderSlots();
    });

    inputWrap.append(input, counter, clearBtn);
    row.append(inputWrap, dupWarn);

    // 노출 위치 dropdown — 페이지 모달의 dropdown과 1:1 매핑.
    const positionDropdown = createDropdown<HeadlinePosition>({
      value: slot.position,
      options: (["all", "p1", "p2"] as HeadlinePosition[]).map((p) => ({
        value: p,
        label: HEADLINE_POSITION_LABELS[p],
      })),
      ariaLabel: "노출 위치",
      width: 120,
      onChange: (value) => {
        const cur = opts.getValues();
        cur[idx] = { ...cur[idx], position: value };
        opts.setValues(cur);
      },
    });
    row.appendChild(positionDropdown.root);

    return row;
  }

  renderSlots();
  return { root, recompute: recomputeAllDup };

  function renderSlots(): void {
    list.replaceChildren();
    rowUpdaters.length = 0;
    const values = opts.getValues();
    // 항상 마지막에 빈 슬롯 1개를 두는 자동-append UX. 처음 mount 시 빈 슬롯이 없으면 보강.
    if (values.length === 0 || values[values.length - 1].text.length > 0) {
      if (values.length < opts.slotLimit) {
        const padded = [...values, { text: "", position: "all" as HeadlinePosition }];
        opts.setValues(padded);
      }
    }
    opts.getValues().forEach((slot, idx) => {
      list.appendChild(createRow(slot, idx));
    });
    recomputeAllDup();
  }
}

// ─── 텍스트 섹션 (추가설명 전용) ───

interface TextSectionOpts {
  label: string;
  getValues: () => string[];
  setValues: (next: string[]) => void;
  maxLength: number;
  slotLimit: number;
  existingTexts: Set<string>;
}

function buildTextSection(opts: TextSectionOpts): {
  root: HTMLElement;
  recompute: () => void;
  setSlotLimit: (next: number) => void;
} {
  const root = document.createElement("section");
  root.className = "dvads-asset-bulk-section";

  const head = document.createElement("div");
  head.className = "dvads-asset-bulk-section-head";
  const title = document.createElement("h3");
  title.className = "dvads-asset-bulk-section-title";
  title.textContent = opts.label;
  head.appendChild(title);
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "dvads-asset-bulk-slots";
  root.appendChild(list);

  // slotLimit은 외부에서 갱신 가능 — scan 결과에 따라 동적으로 줄어듦.
  // maybeAppendEmpty / renderSlots에서 이 mutable 값을 참조.
  let currentSlotLimit = opts.slotLimit;

  // headline 섹션과 동일한 패턴 — input 1개 변경이 같은 섹션의 모든 슬롯
  // 중복 상태에 영향을 미치므로 row별 콜백을 등록해 일괄 재계산.
  const rowUpdaters: Array<(allTexts: string[]) => void> = [];
  const recomputeAllDup = (): void => {
    const texts = opts.getValues();
    rowUpdaters.forEach((fn) => fn(texts));
  };

  const maybeAppendEmpty = (): void => {
    const cur = opts.getValues();
    if (cur.length >= currentSlotLimit) return;
    if (cur[cur.length - 1]?.trim().length === 0) return;
    const newIdx = cur.length;
    opts.setValues([...cur, ""]);
    list.appendChild(createRow("", newIdx));
    recomputeAllDup();
  };

  function createRow(value: string, idx: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "dvads-asset-bulk-text-row";

    const inputWrap = document.createElement("div");
    inputWrap.className = "dvads-asset-bulk-input-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = opts.maxLength;
    input.value = value;
    input.className = "dvads-asset-bulk-text-input";
    input.placeholder = `${opts.label} ${idx + 1}`;
    const counter = document.createElement("span");
    counter.className = "dvads-asset-bulk-text-counter";
    counter.textContent = `${value.length}/${opts.maxLength}`;
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "dvads-asset-bulk-text-clear";
    clearBtn.setAttribute("aria-label", "슬롯 삭제");
    clearBtn.textContent = "×";
    clearBtn.hidden = value.length === 0;
    const dupWarn = document.createElement("span");
    dupWarn.className = "dvads-asset-bulk-dup-warn";
    const applyDupState = (allTexts: string[]): void => {
      const t = (allTexts[idx] ?? "").trim();
      if (!t) {
        row.classList.remove("dvads-asset-bulk-dup");
        return;
      }
      const isDup =
        opts.existingTexts.has(t) ||
        allTexts.some((other, i) => i !== idx && other.trim() === t);
      if (isDup) {
        dupWarn.textContent = `이미 등록된 ${opts.label}입니다`;
        row.classList.add("dvads-asset-bulk-dup");
      } else {
        row.classList.remove("dvads-asset-bulk-dup");
      }
    };
    rowUpdaters.push(applyDupState);
    input.addEventListener("input", () => {
      const cur = opts.getValues();
      cur[idx] = input.value;
      counter.textContent = `${input.value.length}/${opts.maxLength}`;
      clearBtn.hidden = input.value.length === 0;
      opts.setValues(cur);
      recomputeAllDup();
      maybeAppendEmpty();
    });
    clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = opts.getValues();
      if (cur.length <= 1) {
        cur[idx] = "";
        input.value = "";
        counter.textContent = `0/${opts.maxLength}`;
        clearBtn.hidden = true;
        opts.setValues(cur);
        recomputeAllDup();
        return;
      }
      cur.splice(idx, 1);
      opts.setValues(cur);
      renderSlots();
    });

    inputWrap.append(input, counter, clearBtn);
    row.append(inputWrap, dupWarn);

    return row;
  }

  renderSlots();
  return {
    root,
    recompute: recomputeAllDup,
    setSlotLimit: (next) => {
      currentSlotLimit = next;
      // 사용자가 아직 아무 슬롯에도 입력 안 했으면 안전하게 재렌더
      // (limit이 0이면 슬롯 다 제거, 양수면 빈 슬롯 1개로 정리)
      const cur = opts.getValues();
      const anyFilled = cur.some((t) => t.trim().length > 0);
      if (!anyFilled) {
        renderSlots();
        return;
      }
      // 입력 중인 데이터는 보호. 단 마지막 빈 슬롯은 limit 초과면 제거해서
      // 추가 입력 못 하게 안내.
      const filled = cur.filter((t) => t.trim().length > 0);
      if (filled.length >= currentSlotLimit) {
        opts.setValues(filled);
        renderSlots();
      }
    },
  };

  function renderSlots(): void {
    list.replaceChildren();
    rowUpdaters.length = 0;
    if (currentSlotLimit === 0) {
      // limit이 0이면 슬롯 자체를 그리지 않음 (hint 텍스트로 사유 안내).
      opts.setValues([]);
      return;
    }
    const values = opts.getValues();
    if (values.length === 0 || values[values.length - 1].length > 0) {
      if (values.length < currentSlotLimit) {
        opts.setValues([...values, ""]);
      }
    }
    opts.getValues().forEach((value, idx) => {
      list.appendChild(createRow(value, idx));
    });
    recomputeAllDup();
  }
}

// ─── 홍보문구 섹션 (홍보종류 select + 14자 추가설명 input) ───

const PROMO_KIND_LABELS: Record<PromoKind, string> = {
  none: "선택 안 함",
  discount: "할인",
  freebie: "사은품",
  "extra-gift": "추가선물증정",
  event: "이벤트",
  newitem: "신상품",
};

interface PromoSectionOpts {
  getValues: () => PromoSlotInput[];
  setValues: (next: PromoSlotInput[]) => void;
  slotLimit: number;
  maxLength: number;
  existingTexts: Set<string>;
}

function buildPromoSection(opts: PromoSectionOpts): {
  root: HTMLElement;
  recompute: () => void;
  setSlotLimit: (next: number) => void;
} {
  const root = document.createElement("section");
  root.className = "dvads-asset-bulk-section";

  const head = document.createElement("div");
  head.className = "dvads-asset-bulk-section-head";
  const title = document.createElement("h3");
  title.className = "dvads-asset-bulk-section-title";
  title.textContent = "홍보문구";
  head.appendChild(title);
  root.appendChild(head);

  const list = document.createElement("div");
  list.className = "dvads-asset-bulk-slots";
  root.appendChild(list);

  let currentSlotLimit = opts.slotLimit;

  // 홍보문구 dedup은 (종류, 설명) 쌍 기준 — 페이지 정책상 추가설명이 같아도
  // 종류가 다르면 별개 항목으로 등록되므로. composite key 형식: `${kind}|${description}`.
  // input 1개 변경 또는 종류 dropdown 변경 시 모든 슬롯 중복 상태 재계산.
  const rowUpdaters: Array<(allKeys: string[]) => void> = [];
  const composeKey = (p: PromoSlotInput): string => `${p.kind}|${p.description.trim()}`;
  const recomputeAllDup = (): void => {
    const keys = opts.getValues().map(composeKey);
    rowUpdaters.forEach((fn) => fn(keys));
  };

  const maybeAppendEmpty = (): void => {
    const cur = opts.getValues();
    if (cur.length >= currentSlotLimit) return;
    if (cur[cur.length - 1]?.description.trim().length === 0) return;
    const newIdx = cur.length;
    const newSlot: PromoSlotInput = { kind: "none", description: "" };
    opts.setValues([...cur, newSlot]);
    list.appendChild(createRow(newSlot, newIdx));
    recomputeAllDup();
  };

  function createRow(slot: PromoSlotInput, idx: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "dvads-asset-bulk-text-row dvads-asset-bulk-promo-row";

    const inputWrap = document.createElement("div");
    inputWrap.className = "dvads-asset-bulk-input-wrap";

    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = opts.maxLength;
    input.value = slot.description;
    input.className = "dvads-asset-bulk-text-input";
    input.placeholder = `홍보문구 ${idx + 1}`;
    const counter = document.createElement("span");
    counter.className = "dvads-asset-bulk-text-counter";
    counter.textContent = `${slot.description.length}/${opts.maxLength}`;
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "dvads-asset-bulk-text-clear";
    clearBtn.setAttribute("aria-label", "슬롯 삭제");
    clearBtn.textContent = "×";
    clearBtn.hidden = slot.description.length === 0;
    const dupWarn = document.createElement("span");
    dupWarn.className = "dvads-asset-bulk-dup-warn";
    const applyDupState = (allKeys: string[]): void => {
      const cur = opts.getValues();
      const slot = cur[idx];
      // 추가설명이 비어있으면 dup 무시 (빈 슬롯은 어차피 등록 안됨)
      if (!slot || slot.description.trim().length === 0) {
        row.classList.remove("dvads-asset-bulk-dup");
        return;
      }
      const myKey = `${slot.kind}|${slot.description.trim()}`;
      const isDup =
        opts.existingTexts.has(myKey) ||
        allKeys.some((other, i) => i !== idx && other === myKey);
      if (isDup) {
        dupWarn.textContent = `이미 등록된 홍보문구입니다`;
        row.classList.add("dvads-asset-bulk-dup");
      } else {
        row.classList.remove("dvads-asset-bulk-dup");
      }
    };
    rowUpdaters.push(applyDupState);
    input.addEventListener("input", () => {
      const cur = opts.getValues();
      cur[idx] = { ...cur[idx], description: input.value };
      counter.textContent = `${input.value.length}/${opts.maxLength}`;
      clearBtn.hidden = input.value.length === 0;
      opts.setValues(cur);
      recomputeAllDup();
      maybeAppendEmpty();
    });
    clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const cur = opts.getValues();
      if (cur.length <= 1) {
        cur[idx] = { ...cur[idx], description: "" };
        input.value = "";
        counter.textContent = `0/${opts.maxLength}`;
        clearBtn.hidden = true;
        opts.setValues(cur);
        recomputeAllDup();
        return;
      }
      cur.splice(idx, 1);
      opts.setValues(cur);
      renderSlots();
    });

    inputWrap.append(input, counter, clearBtn);
    row.append(inputWrap, dupWarn);

    // 홍보종류 dropdown — 추가제목 노출 위치처럼 오른쪽에 배치, 동일 디자인 컴포넌트.
    const kindDropdown = createDropdown<PromoKind>({
      value: slot.kind,
      options: (Object.keys(PROMO_KIND_LABELS) as PromoKind[]).map((k) => ({
        value: k,
        label: PROMO_KIND_LABELS[k],
      })),
      ariaLabel: "홍보종류",
      width: 130,
      onChange: (value) => {
        const cur = opts.getValues();
        cur[idx] = { ...cur[idx], kind: value };
        opts.setValues(cur);
        // 종류 변경도 dedup key를 바꾸므로 모든 행 재계산
        recomputeAllDup();
      },
    });
    row.appendChild(kindDropdown.root);

    return row;
  }

  renderSlots();
  return {
    root,
    recompute: recomputeAllDup,
    setSlotLimit: (next) => {
      currentSlotLimit = next;
      const cur = opts.getValues();
      const anyFilled = cur.some((p) => p.description.trim().length > 0);
      if (!anyFilled) {
        renderSlots();
        return;
      }
      const filled = cur.filter((p) => p.description.trim().length > 0);
      if (filled.length >= currentSlotLimit) {
        opts.setValues(filled);
        renderSlots();
      }
    },
  };

  function renderSlots(): void {
    list.replaceChildren();
    rowUpdaters.length = 0;
    if (currentSlotLimit === 0) {
      opts.setValues([]);
      return;
    }
    const values = opts.getValues();
    if (values.length === 0 || values[values.length - 1].description.length > 0) {
      if (values.length < currentSlotLimit) {
        opts.setValues([...values, { kind: "none", description: "" }]);
      }
    }
    opts.getValues().forEach((slot, idx) => {
      list.appendChild(createRow(slot, idx));
    });
    recomputeAllDup();
  }
}
