/**
 * F-AssetBulk — 파워링크 확장소재 등록 UI 자동화.
 *
 * "+ 새 확장 소재" 드롭다운에서 추가제목/추가설명/파워링크 이미지 한 종을 골라
 * 페이지가 띄우는 모달에 입력값을 주입하고 저장 버튼을 누른다. 검색광고 API나
 * 비공식 ad-extension endpoint를 호출하지 않고 사용자가 직접 등록하는 경로를
 * 그대로 흉내내 권한·validation·이미지 라이브러리 등록을 페이지에 위임한다.
 *
 * ads.naver.com이 클래스명/구조를 갈면 이 파일만 고치면 된다. 셀렉터 출처:
 * 2026-05-19 실측 (사용자 정찰).
 *
 *   드롭다운 li: <li class="ad-cms-dropdown-menu-item" role="menuitem">
 *                <span class="ad-cms-dropdown-menu-title-content">추가제목</span></li>
 *   모달:        <div class="ad-cms-modal-wrap"><div role="dialog" class="ad-cms-modal">…</div></div>
 *   모달 헤더:   "새 확장 소재 추가 (추가제목|추가설명|파워링크 이미지)"
 *   추가제목 input: <input id="headline-adextension" maxlength="15">
 *   추가설명:    모달 body 안 단일 텍스트 input (id는 환경 따라 다를 수 있어 textContent 기준 발견)
 *   이미지 file: <input type="file" multiple accept="image/...">  (모달 body 안 hidden input)
 *   저장 버튼:   .ad-cms-modal-footer .ad-cms-btn-color-primary  (텍스트 "저장", disabled로 시작)
 */

import { setReactInputValue, waitFor } from "@/content/dom-bid";

// ─── 공개 타입 ───

export type AssetKind = "headline" | "description" | "image";

export type AssetItemSource =
  | { kind: "headline"; text: string }
  | { kind: "description"; text: string }
  | { kind: "image"; files: File[] };

export type AssetFailure =
  | "no-trigger"          // "+ 새 확장 소재" 버튼 못 찾음
  | "no-menu-item"        // 드롭다운 li 못 찾음 (i18n 불일치 등)
  | "no-modal"            // 모달 등장 안 함
  | "no-input"            // 모달 안 입력 칸 못 찾음
  | "no-file-input"       // 이미지 모달 file input 못 찾음
  | "no-submit"           // 저장 버튼 못 찾음
  | "submit-disabled"     // 저장 버튼이 입력 후에도 활성화 안 됨 (validation 실패)
  | "modal-not-closed"    // 저장 후 모달 안 닫힘 (등록 실패 가능성)
  | "empty"               // 입력값이 비어있어 자동 skip
  | "unknown";

export interface AssetResult {
  kind: AssetKind;
  ok: boolean;
  label: string;          // 토스트에서 사용할 사용자 식별자 — "추가제목 '오늘 특가'", "이미지 2장"
  reason?: AssetFailure;
}

// ─── 셀렉터 상수 ───

const DROPDOWN_TRIGGER_TEXT = "새 확장 소재";
const DROPDOWN_TRIGGER_SELECTOR = "button.ad-cms-dropdown-trigger";
const MENU_ITEM_SELECTOR = "li.ad-cms-dropdown-menu-item";
const MENU_ITEM_LABEL_SELECTOR = "span.ad-cms-dropdown-menu-title-content";

const MODAL_SELECTOR = 'div.ad-cms-modal[role="dialog"]';
const MODAL_BODY_SELECTOR = ".ad-cms-modal-body";
const MODAL_FOOTER_SELECTOR = ".ad-cms-modal-footer";
const MODAL_PRIMARY_BTN_SELECTOR = "button.ad-cms-btn-color-primary";
const MODAL_CLOSE_BTN_SELECTOR = "button.ad-cms-modal-close";

const HEADLINE_INPUT_ID = "headline-adextension";

// 모달 등장 대기. 페이지 트랜지션 + React 렌더 합쳐 보통 200~500ms.
const MODAL_WAIT_MS = 2500;
// 저장 버튼 활성화 대기 (validation 통과 + setState 반영).
const SUBMIT_ENABLE_WAIT_MS = 1500;
// 저장 클릭 후 모달 unmount 대기. 이미지 업로드 처리가 길 수 있어 넉넉히.
const MODAL_CLOSE_WAIT_MS = 10_000;
// 드롭다운 li 등장 대기 (트리거 클릭 후).
const MENU_WAIT_MS = 1200;

// 라벨 매핑 — 모달 헤더 "새 확장 소재 추가 (추가제목)"의 괄호 안 텍스트와도 매치.
const KIND_LABELS: Record<AssetKind, string> = {
  headline: "추가제목",
  description: "추가설명",
  image: "파워링크 이미지",
};

// ─── 페이지 트리거·메뉴 ───

/**
 * "+ 새 확장 소재" 드롭다운 트리거 버튼. 클래스 + 내부 텍스트 둘 다 보고 식별 —
 * 같은 페이지에 다른 dropdown-trigger가 떠있어도 오인하지 않게.
 */
export function findExtensionDropdownTrigger(): HTMLButtonElement | null {
  const buttons = document.querySelectorAll<HTMLButtonElement>(DROPDOWN_TRIGGER_SELECTOR);
  for (const btn of Array.from(buttons)) {
    const text = (btn.textContent ?? "").trim();
    if (text.includes(DROPDOWN_TRIGGER_TEXT)) return btn;
  }
  return null;
}

/** 현재 떠있는 메뉴 li 모음. 펼친 상태가 아니면 빈 배열. */
function listMenuItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
}

/**
 * "+ 새 확장 소재" 메뉴 li 중 라벨 매칭으로 하나 찾기. 메뉴가 아직 안 떴으면 null.
 * 메뉴 컨테이너는 portal로 떠다니므로 document 전체에서 찾는다.
 */
function findMenuItemByLabel(label: string): HTMLElement | null {
  for (const li of listMenuItems()) {
    const content = li.querySelector<HTMLElement>(MENU_ITEM_LABEL_SELECTOR);
    const text = (content?.textContent ?? li.textContent ?? "").trim();
    if (text === label) return li;
  }
  return null;
}

/**
 * 드롭다운을 열고 (이미 열려 있으면 그대로) 특정 라벨의 li를 클릭한다.
 * 라벨이 안 보이면 잠시 기다린다 — 메뉴는 트리거 클릭 직후 mount되기 때문.
 */
async function openMenuAndClick(label: string): Promise<boolean> {
  // 이미 메뉴가 떠있고 우리가 찾는 li가 보이면 바로 클릭
  let item = findMenuItemByLabel(label);
  if (!item) {
    const trigger = findExtensionDropdownTrigger();
    if (!trigger) return false;
    trigger.click();
    item = await waitFor(() => findMenuItemByLabel(label), MENU_WAIT_MS);
  }
  if (!item) return false;
  item.click();
  return true;
}

/** 현재 떠있는 메뉴 패널이 있으면 닫는다 (트리거 click toggle 또는 body click). */
function closeOpenMenu(): void {
  if (listMenuItems().length === 0) return;
  // rc-menu는 body click으로 닫힘. document.body 자체 클릭은 외부 click 리스너에도 영향이라
  // 트리거를 한 번 더 누르는 게 안전 (toggle).
  const trigger = findExtensionDropdownTrigger();
  if (trigger) trigger.click();
}

// ─── 모달 ───

/**
 * 라벨에 해당하는 모달이 떠있는지 확인. 라벨은 모달 헤더 텍스트 안에 포함된
 * "(추가제목)" 같은 표기로 식별. 페이지에 다른 우리 모달이 동시에 떠있을 가능성은
 * 낮지만, 헤더 텍스트 매칭으로 안전하게 격리한다.
 */
function findOpenModal(kind: AssetKind): HTMLElement | null {
  const label = KIND_LABELS[kind];
  const modals = document.querySelectorAll<HTMLElement>(MODAL_SELECTOR);
  for (const m of Array.from(modals)) {
    const text = (m.textContent ?? "").trim();
    // "새 확장 소재 추가 (추가제목)" 형태. 라벨이 본문에 그대로 등장하기만 해도 OK —
    // 모달 안에 같은 단어가 두 번 들어가도 매칭은 한 번이면 충분.
    if (text.includes(`(${label})`)) return m;
  }
  return null;
}

/** 모달 안의 첫 텍스트 입력 — 추가제목/추가설명 모달용. */
function findTextInput(modal: HTMLElement, kind: AssetKind): HTMLInputElement | null {
  // 추가제목은 id가 명확.
  if (kind === "headline") {
    const byId = modal.querySelector<HTMLInputElement>(`input#${HEADLINE_INPUT_ID}`);
    if (byId) return byId;
  }
  // fallback: 모달 body 안의 단일 텍스트 input. 노출 위치 등 다른 input은 type이 hidden/checkbox이거나
  // 트리거 버튼 형태라 일반 text input 한 개만 잡힌다.
  const body = modal.querySelector<HTMLElement>(MODAL_BODY_SELECTOR) ?? modal;
  const inputs = body.querySelectorAll<HTMLInputElement>('input[type="text"]');
  return inputs.length > 0 ? inputs[0] : null;
}

/** 모달 안의 hidden file input — 이미지 모달용. multiple 지원. */
function findFileInput(modal: HTMLElement): HTMLInputElement | null {
  return modal.querySelector<HTMLInputElement>('input[type="file"]');
}

/** 모달 footer의 "저장" primary 버튼. disabled 상태도 그대로 돌려준다. */
function findSubmitButton(modal: HTMLElement): HTMLButtonElement | null {
  const footer = modal.querySelector<HTMLElement>(MODAL_FOOTER_SELECTOR);
  const scope = footer ?? modal;
  // footer 안의 primary 버튼 중 텍스트가 "저장"인 것. footer에 primary가 1개뿐이라
  // 텍스트 검사는 안전 가드 수준.
  const buttons = scope.querySelectorAll<HTMLButtonElement>(MODAL_PRIMARY_BTN_SELECTOR);
  for (const b of Array.from(buttons)) {
    const t = (b.textContent ?? "").trim();
    if (t === "저장" || t.endsWith("저장")) return b;
  }
  return buttons.length > 0 ? buttons[0] : null;
}

/** 모달 우상단 × 버튼 — 실패 시 강제 닫기에 사용. */
function findCloseButton(modal: HTMLElement): HTMLButtonElement | null {
  return modal.querySelector<HTMLButtonElement>(MODAL_CLOSE_BTN_SELECTOR);
}

/** 저장 버튼이 활성화될 때까지 대기. 시간 초과 시 false. */
async function waitForSubmitEnabled(modal: HTMLElement): Promise<boolean> {
  const ready = await waitFor(() => {
    const btn = findSubmitButton(modal);
    if (!btn) return null;
    return btn.disabled ? null : btn;
  }, SUBMIT_ENABLE_WAIT_MS);
  return ready != null;
}

/** 모달이 DOM에서 제거되거나 숨겨질 때까지 대기. 시간 초과 시 false. */
async function waitForModalClosed(modal: HTMLElement): Promise<boolean> {
  const closed = await waitFor(() => {
    if (!modal.isConnected) return true;
    // 일부 라이브러리는 closing 애니메이션 동안 display:none 처리 — visibility 체크.
    const r = modal.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    return null;
  }, MODAL_CLOSE_WAIT_MS);
  return closed === true;
}

// ─── 각 종류별 등록 ───

async function registerTextItem(
  kind: "headline" | "description",
  text: string,
): Promise<AssetResult> {
  const label = KIND_LABELS[kind];
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind, ok: true, label: `${label} (빈 항목)`, reason: "empty" };
  }
  const displayLabel = `${label} "${trimmed}"`;

  const opened = await openMenuAndClick(label);
  if (!opened) {
    return { kind, ok: false, label: displayLabel, reason: "no-menu-item" };
  }

  const modal = await waitFor(() => findOpenModal(kind), MODAL_WAIT_MS);
  if (!modal) {
    return { kind, ok: false, label: displayLabel, reason: "no-modal" };
  }

  const input = findTextInput(modal, kind);
  if (!input) {
    findCloseButton(modal)?.click();
    return { kind, ok: false, label: displayLabel, reason: "no-input" };
  }

  setReactInputValue(input, trimmed);

  const enabled = await waitForSubmitEnabled(modal);
  const submitBtn = findSubmitButton(modal);
  if (!enabled || !submitBtn) {
    findCloseButton(modal)?.click();
    return {
      kind,
      ok: false,
      label: displayLabel,
      reason: submitBtn ? "submit-disabled" : "no-submit",
    };
  }
  submitBtn.click();

  const closed = await waitForModalClosed(modal);
  if (!closed) {
    return { kind, ok: false, label: displayLabel, reason: "modal-not-closed" };
  }
  return { kind, ok: true, label: displayLabel };
}

/**
 * 파워링크 이미지 등록 — 한 모달에서 multiple file을 한 번에 등록 (file input이 multiple).
 * 페이지가 "이미지 라이브러리에 등록합니다" 체크박스 기본 checked로 두는데 우리는 건드리지 않음.
 */
async function registerImageItem(files: File[]): Promise<AssetResult> {
  const label = KIND_LABELS.image;
  const validFiles = files.filter((f) => f && f.size > 0);
  if (validFiles.length === 0) {
    return { kind: "image", ok: true, label: `${label} (빈 항목)`, reason: "empty" };
  }
  const displayLabel = `${label} ${validFiles.length}장`;

  const opened = await openMenuAndClick(label);
  if (!opened) {
    return { kind: "image", ok: false, label: displayLabel, reason: "no-menu-item" };
  }

  const modal = await waitFor(() => findOpenModal("image"), MODAL_WAIT_MS);
  if (!modal) {
    return { kind: "image", ok: false, label: displayLabel, reason: "no-modal" };
  }

  const fileInput = findFileInput(modal);
  if (!fileInput) {
    findCloseButton(modal)?.click();
    return { kind: "image", ok: false, label: displayLabel, reason: "no-file-input" };
  }

  // DataTransfer로 file 주입 — 페이지의 onChange가 정상 트리거되도록 change 이벤트도 dispatch.
  const dt = new DataTransfer();
  for (const f of validFiles) dt.items.add(f);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event("input", { bubbles: true }));
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));

  // 페이지가 이미지 업로드 처리(클라이언트 리사이즈/검증)를 마치고 저장 버튼을 활성화할 때까지 대기.
  // 5MB·2000x2000 한도라 single image는 보통 1초 이내, 여러 장이면 더 걸릴 수 있음.
  const enabled = await waitForSubmitEnabled(modal);
  const submitBtn = findSubmitButton(modal);
  if (!enabled || !submitBtn) {
    findCloseButton(modal)?.click();
    return {
      kind: "image",
      ok: false,
      label: displayLabel,
      reason: submitBtn ? "submit-disabled" : "no-submit",
    };
  }
  submitBtn.click();

  const closed = await waitForModalClosed(modal);
  if (!closed) {
    return { kind: "image", ok: false, label: displayLabel, reason: "modal-not-closed" };
  }
  return { kind: "image", ok: true, label: displayLabel };
}

/**
 * 외부 진입점 — 한 항목 등록. 종류별 분기.
 */
export async function registerAssetItem(item: AssetItemSource): Promise<AssetResult> {
  try {
    if (item.kind === "headline" || item.kind === "description") {
      return await registerTextItem(item.kind, item.text);
    }
    return await registerImageItem(item.files);
  } catch (e) {
    console.warn("[dv-ads/asset-bulk] register failed", e);
    return {
      kind: item.kind,
      ok: false,
      label: KIND_LABELS[item.kind],
      reason: "unknown",
    };
  } finally {
    // 안전망 — 어떤 이유로 메뉴가 떠있는 채로 종료됐다면 닫는다.
    // 다음 항목의 openMenuAndClick에서 토글 충돌 없도록.
    closeOpenMenu();
  }
}

export function describeAssetFailure(reason: AssetFailure | undefined): string {
  switch (reason) {
    case "no-trigger":
      return "확장 소재 드롭다운을 찾지 못했습니다";
    case "no-menu-item":
      return "드롭다운 항목을 찾지 못했습니다";
    case "no-modal":
      return "등록 모달이 열리지 않았습니다";
    case "no-input":
      return "입력 칸을 찾지 못했습니다";
    case "no-file-input":
      return "이미지 업로드 칸을 찾지 못했습니다";
    case "no-submit":
      return "저장 버튼을 찾지 못했습니다";
    case "submit-disabled":
      return "입력값 검증을 통과하지 못했습니다 (저장 비활성)";
    case "modal-not-closed":
      return "저장 후 모달이 닫히지 않았습니다 (페이지 측 오류일 수 있음)";
    case "empty":
      return "빈 항목으로 건너뛰었습니다";
    default:
      return "알 수 없는 오류가 발생했습니다";
  }
}
