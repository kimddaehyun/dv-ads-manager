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
import type { HeadlinePosition, PromoKind } from "@/content/asset-bulk-popup";

// ─── 공개 타입 ───

export type AssetKind = "headline" | "description" | "image" | "promo";

export interface ExistingAssets {
  /** 이미 등록된 추가제목 텍스트 (trim 후) */
  headlines: Set<string>;
  /** 이미 등록된 추가설명 텍스트 (trim 후) */
  descriptions: Set<string>;
  /** 이미 등록된 홍보문구 추가설명 텍스트 (trim 후) */
  promos: Set<string>;
  /** 이미 등록된 파워링크 이미지 개수 — 한도(2장)에서 차감해 남은 슬롯 계산. */
  imageCount: number;
}

export type AssetItemSource =
  | { kind: "headline"; text: string; position: HeadlinePosition }
  | { kind: "description"; text: string }
  | {
      kind: "image";
      files: File[];
      /**
       * true면 파일 주입 후 자동으로 저장 버튼을 누르지 않고 사용자가 직접 자르기/검토 후
       * 페이지의 [저장]을 누를 때까지 대기. 모달이 닫히면 다음 항목으로 진행.
       * 자동화 1건당 보통 ~1초인데 manual 모드는 사용자 작업 시간만큼 늘어남(최대 5분).
       */
      manualCrop?: boolean;
    }
  | { kind: "promo"; description: string; promoKind: PromoKind };

export type AssetFailure =
  | "no-trigger"          // "+ 새 확장 소재" 버튼 못 찾음
  | "no-menu-item"        // 드롭다운 li 못 찾음 (i18n 불일치 등)
  | "no-modal"            // 모달 등장 안 함
  | "no-input"            // 모달 안 입력 칸 못 찾음
  | "no-file-input"       // 이미지 모달 file input 못 찾음
  | "no-submit"           // 저장 버튼 못 찾음
  | "submit-disabled"     // 저장 버튼이 입력 후에도 활성화 안 됨 (validation 실패)
  | "position-failed"     // 추가제목 노출 위치 dropdown 선택 실패
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
// 이미지 모달은 5MB 클라이언트 리사이즈/검증 단계가 있어 다른 모달보다 오래 걸림 — 별도 wait.
const IMAGE_SUBMIT_ENABLE_WAIT_MS = 6000;
// 수동 자르기 모드 — 사용자가 페이지 모달에서 직접 [저장] 누를 때까지 대기 (최대 5분).
const MANUAL_CROP_WAIT_MS = 300_000;
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
  promo: "홍보문구",
};

// 홍보종류 dropdown 옵션 라벨 (페이지 텍스트 그대로 — "선택 안 함"이 default).
const PROMO_KIND_LABELS: Record<PromoKind, string> = {
  none: "선택 안 함",
  discount: "할인",
  freebie: "사은품",
  "extra-gift": "추가선물증정",
  event: "이벤트",
  newitem: "신상품",
};

// ─── 페이지 트리거·메뉴 ───

/**
 * "+ 새 확장 소재" 드롭다운 트리거 버튼. 클래스 + 내부 텍스트 둘 다 보고 식별 —
 * 같은 페이지에 다른 dropdown-trigger가 떠있어도 오인하지 않게.
 */
/**
 * 확장소재 페이지의 등록 목록 테이블에서 이미 등록된 추가제목/추가설명 텍스트를 스캔.
 * 페이지의 `tr.ad-cms-table-row[data-row-key]` 행을 순회 — measure-row(aria-hidden) 제외.
 *
 * 행 구조(2026-05-19 정찰):
 *   td[0] checkbox · td[1] on/off · td[2] 확장소재 텍스트 · td[3] 상태 · td[4] 유형 · ...
 *   확장소재 텍스트는 td[2] > .extension-text > ul > li:first-child > .extension-dot
 *   유형은 td[4] textContent ("추가제목" / "추가설명" / ...)
 *
 * 이미지는 파일 비교가 복잡하고 사용자가 매번 다른 파일을 올리는 경우가 보통이라 스캔 범위 밖.
 */
/**
 * 확장소재 테이블 하단의 페이지 크기 selector(`10 / 30 / 50 페이지`)를 `50/페이지`로
 * 강제 변경한다. 광고그룹당 확장소재는 보통 50개 이내라 한 페이지에 모두 mount되어
 * 후속 `scanExistingAssets`가 누락 없이 잡는다.
 *
 * 페이지네이션이 1페이지뿐인 케이스(이미 50/페이지)도 정상 동작 — selector를 못 찾거나
 * 이미 50인 상태면 no-op.
 */
export async function ensurePageSizeFifty(): Promise<void> {
  // ads.naver.com은 antd fork에 `ad-cms-` prefix를 씀.
  // 트리거: .ad-cms-pagination-options-size-changer (selector wrapper)
  // 현재 값: .ad-cms-select-content-value (title 속성 + textContent "N / 페이지")
  const sizeChanger = document.querySelector<HTMLElement>(
    ".ad-cms-pagination-options-size-changer",
  );
  if (!sizeChanger) {
    console.warn("[dv-ads/asset-bulk] page size selector not found - skip");
    return;
  }

  // 이미 50/페이지면 변경 불필요
  const currentValue = sizeChanger
    .querySelector<HTMLElement>(".ad-cms-select-content-value")
    ?.textContent?.trim() ?? "";
  if (/^50\s*\/\s*페이지/.test(currentValue)) {
    return;
  }

  // antd fork는 mousedown 기반으로 dropdown을 토글 — click만으론 안 열릴 수 있어
  // mousedown + click을 같이 dispatch. 이벤트 target은 selector 내부 content 영역이
  // 정확. 그 안 .ad-cms-select-content가 실제 클릭 hit target.
  const clickTarget =
    sizeChanger.querySelector<HTMLElement>(".ad-cms-select-content") ?? sizeChanger;
  dispatchMouseSequence(clickTarget);

  const optionsRoot = await waitForPageSizeOptions();
  if (!optionsRoot) {
    console.warn("[dv-ads/asset-bulk] page size options dropdown not mounted - skip");
    return;
  }
  const items = optionsRoot.querySelectorAll<HTMLElement>(
    ".ad-cms-select-item-option, [role='option']",
  );
  let target: HTMLElement | null = null;
  for (const it of Array.from(items)) {
    const t = (it.textContent ?? "").trim();
    if (/^50\s*\/\s*페이지$/.test(t)) {
      target = it;
      break;
    }
  }
  if (!target) {
    console.warn("[dv-ads/asset-bulk] 50/페이지 option not found - skip");
    dispatchMouseSequence(clickTarget); // 드롭다운 닫기 시도
    return;
  }
  dispatchMouseSequence(target);

  // 페이지 re-render(추가 행 mount) 대기 — 600ms로 여유 확보
  await new Promise((r) => setTimeout(r, 600));
}

function dispatchMouseSequence(el: HTMLElement): void {
  // antd Select는 mousedown으로 dropdown을 토글. click도 같이 dispatch해서 다른 리스너 cover.
  const opts = { bubbles: true, cancelable: true, view: window } as const;
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
}

async function waitForPageSizeOptions(): Promise<HTMLElement | null> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const root = document.querySelector<HTMLElement>(
      ".ad-cms-select-dropdown:not(.ad-cms-select-dropdown-hidden), " +
        ".ad-cms-select-dropdown, " +
        "[role='listbox']",
    );
    if (
      root &&
      root.querySelector(
        ".ad-cms-select-item-option, [role='option']",
      )
    ) {
      return root;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return null;
}

/**
 * 페이지 표시 라벨 → `PromoKind` enum. 행 텍스트 "홍보종류: ___" 파싱용.
 * 홍보종류가 없는 행(= 사용자가 "선택 안 함"으로 등록한 경우)은 행에 "홍보종류:" 라인이
 * 통째로 없어서 fallback으로 "none"으로 간주.
 */
const PROMO_KIND_LABEL_TO_ENUM: Record<string, PromoKind> = {
  "선택 안 함": "none",
  "할인": "discount",
  "사은품": "freebie",
  "추가선물증정": "extra-gift",
  "이벤트": "event",
  "신상품": "newitem",
};

/**
 * 홍보문구 dedup 키 형식 — `${kind}|${description}`.
 * 페이지 정책상 추가설명이 같아도 홍보종류가 다르면 별개 항목으로 등록되므로
 * 종류+설명 쌍을 dedup 단위로 삼는다.
 */
export function promoDedupKey(kind: PromoKind, description: string): string {
  return `${kind}|${description.trim()}`;
}

export function scanExistingAssets(): ExistingAssets {
  const headlines = new Set<string>();
  const descriptions = new Set<string>();
  const promos = new Set<string>();
  let imageCount = 0;

  const rows = document.querySelectorAll<HTMLElement>(
    "tr.ad-cms-table-row[data-row-key]",
  );
  for (const row of Array.from(rows)) {
    const cells = row.querySelectorAll<HTMLElement>("td.ad-cms-table-cell");
    if (cells.length < 5) continue;

    const typeText = (cells[4].textContent ?? "").trim();
    if (typeText === "파워링크 이미지") {
      // 이미지 파일 dedup은 비용 대비 가치 낮음(파일명·해시 비교 필요) → 개수만 카운트.
      // 한도(2장) 초과 차단·남은 슬롯 표시에는 충분.
      imageCount += 1;
      continue;
    }
    if (typeText !== "추가제목" && typeText !== "추가설명" && typeText !== "홍보문구") continue;

    // 홍보문구 행은 cell[2] 안에 "홍보종류: ___" / "추가설명: ___" 두 줄 형태로 표시.
    // 추가설명만 단독으로 있으면 종류는 "선택 안 함"(none). dedup은 (종류, 설명) 쌍 기준.
    if (typeText === "홍보문구") {
      const parsed = parsePromoCell(cells[2]);
      if (parsed && parsed.description) {
        promos.add(promoDedupKey(parsed.kind, parsed.description));
      }
      console.log(
        "[dv-ads/asset-scan-row]",
        "type=홍보문구",
        "parsed=", parsed,
      );
      continue;
    }

    // 본문 텍스트 추출 — 추가제목/추가설명 DOM 구조가 다를 수 있어 3단계 fallback:
    //   1) 첫 li 안 .extension-dot textContent
    //   2) 첫 li 직속 textContent
    //   3) cells[2] 자체 textContent에서 button/input 영역 clone 제거 후 추출
    let text = "";
    const firstLi = cells[2].querySelector<HTMLElement>(
      ".extension-text ul li:first-child",
    );
    let stage = "none";
    if (firstLi) {
      const dot = firstLi.querySelector<HTMLElement>(".extension-dot");
      if (dot && (dot.textContent ?? "").trim()) {
        text = (dot.textContent ?? "").trim();
        stage = "dot";
      } else if ((firstLi.textContent ?? "").trim()) {
        text = (firstLi.textContent ?? "").trim();
        stage = "li";
      }
    }
    if (!text) {
      // cells[2] 전체 텍스트 — button/input/링크 같은 보조 영역은 clone에서 제거
      const cloned = cells[2].cloneNode(true) as HTMLElement;
      cloned
        .querySelectorAll("button, input, a, .ad-cms-button, [role='button']")
        .forEach((el) => el.remove());
      text = (cloned.textContent ?? "").trim();
      stage = "cell";
    }
    console.log(
      "[dv-ads/asset-scan-row]",
      "type=" + typeText,
      "firstLi=" + !!firstLi,
      "stage=" + stage,
      "text=" + JSON.stringify(text),
    );
    if (!text) continue;

    if (typeText === "추가제목") headlines.add(text);
    else descriptions.add(text);
  }

  // 진단 로그 — 출시 전 제거. scan 결과를 콘솔에서 즉시 확인 가능.
  console.log(
    "[dv-ads/asset-scan] headlines:",
    Array.from(headlines),
    "descriptions:",
    Array.from(descriptions),
    "promos:",
    Array.from(promos),
    "imageCount:",
    imageCount,
  );

  return { headlines, descriptions, promos, imageCount };
}

/**
 * 홍보문구 행 cell에서 (kind, description) 쌍 파싱.
 *
 * 페이지 DOM (2026-05-20 정찰):
 *   <td>...<ul>
 *     <li><span class="extension-dot">홍보종류: 추가선물증정</span></li>
 *     <li><span class="extension-dot">추가설명: 1234</span></li>
 *   </ul>...</td>
 * 홍보종류 "선택 안 함"인 경우 첫 번째 li가 통째로 없고 추가설명 라인 하나만 존재.
 */
function parsePromoCell(
  cell: HTMLElement,
): { kind: PromoKind; description: string } | null {
  let kind: PromoKind = "none";
  let description = "";

  const dots = cell.querySelectorAll<HTMLElement>(
    ".extension-text li .extension-dot",
  );
  for (const dot of Array.from(dots)) {
    const clean = (dot.textContent ?? "").trim().replace(/^[\s·•・]+/, "");
    if (clean.startsWith("홍보종류:")) {
      const label = clean.slice("홍보종류:".length).trim();
      if (label in PROMO_KIND_LABEL_TO_ENUM) {
        kind = PROMO_KIND_LABEL_TO_ENUM[label];
      }
    } else if (clean.startsWith("추가설명:")) {
      description = clean.slice("추가설명:".length).trim();
    }
  }

  if (!description) return null;
  return { kind, description };
}

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

/**
 * 현재 떠있는 메뉴 패널이 있으면 ESC로 닫는다. 트리거 click(토글)은 메뉴를 다시 여는
 * 부작용이 있어 사이클마다 깜빡임을 만들었기에 사용하지 않는다. ESC는 메뉴만 닫고
 * 우리 popup·페이지 모달은 이미 close된 시점이라 부수효과 없음.
 */
export async function closeOpenMenu(): Promise<void> {
  if (listMenuItems().length === 0) return;
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await sleep(80);
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

// 추가제목 모달의 "노출 가능 위치 지정" dropdown 옵션 라벨 (페이지 텍스트 그대로).
const POSITION_OPTION_LABELS: Record<HeadlinePosition, string> = {
  all: "모든 위치에 노출 가능",
  p1: "위치 1에만 노출 가능",
  p2: "위치 2에만 노출 가능",
};

/**
 * 추가제목 모달의 "노출 가능 위치" dropdown을 열어 지정된 옵션을 선택. default ("all")이면 no-op.
 * trigger는 모달 body 안에서 현재 라벨("모든 위치에 노출 가능" 등)을 textContent로 갖는 dropdown-trigger.
 * 옵션 li는 트리거 클릭 시 portal로 body에 mount되는 `li.ad-cms-dropdown-menu-item`.
 */
async function selectHeadlinePosition(
  modal: HTMLElement,
  position: HeadlinePosition,
): Promise<boolean> {
  if (position === "all") return true;

  const body = modal.querySelector<HTMLElement>(MODAL_BODY_SELECTOR) ?? modal;
  // 모달 안의 dropdown trigger 후보들. 현재 라벨로 어느 게 위치 dropdown인지 식별.
  const triggers = body.querySelectorAll<HTMLElement>(
    ".ad-cms-dropdown-trigger, button.ad-cms-dropdown-trigger, .ad-cms-select",
  );
  let positionTrigger: HTMLElement | null = null;
  for (const t of Array.from(triggers)) {
    const txt = (t.textContent ?? "").trim();
    if (
      txt.includes(POSITION_OPTION_LABELS.all) ||
      txt.includes(POSITION_OPTION_LABELS.p1) ||
      txt.includes(POSITION_OPTION_LABELS.p2)
    ) {
      positionTrigger = t;
      break;
    }
  }
  if (!positionTrigger) return false;
  positionTrigger.click();

  const targetLabel = POSITION_OPTION_LABELS[position];
  const opt = await waitFor(() => {
    const items = document.querySelectorAll<HTMLElement>(
      "li.ad-cms-dropdown-menu-item, li[role='option'], .ad-cms-select-option",
    );
    for (const li of Array.from(items)) {
      const text = (li.textContent ?? "").trim();
      if (text === targetLabel) return li;
    }
    return null;
  }, MENU_WAIT_MS);
  if (!opt) return false;
  opt.click();
  return true;
}

/**
 * 홍보문구 모달의 "홍보종류" dropdown을 열어 지정된 옵션을 선택. default ("none")이면 no-op.
 * trigger는 모달 body 안에서 현재 라벨("선택 안 함"|"할인"|...)을 가진 dropdown.
 * antd-like select(`.ad-cms-select`) 또는 dropdown trigger(`.ad-cms-dropdown-trigger`) 둘 다 시도.
 */
async function selectPromoKind(
  modal: HTMLElement,
  kind: PromoKind,
): Promise<boolean> {
  if (kind === "none") return true;

  const body = modal.querySelector<HTMLElement>(MODAL_BODY_SELECTOR) ?? modal;
  const triggers = body.querySelectorAll<HTMLElement>(
    ".ad-cms-dropdown-trigger, button.ad-cms-dropdown-trigger, .ad-cms-select",
  );
  let kindTrigger: HTMLElement | null = null;
  for (const t of Array.from(triggers)) {
    const txt = (t.textContent ?? "").trim();
    // 현재 라벨이 홍보종류 옵션 중 하나면 그 dropdown이 우리 타깃.
    const allLabels = Object.values(PROMO_KIND_LABELS);
    if (allLabels.some((l) => txt === l || txt.includes(l))) {
      kindTrigger = t;
      break;
    }
  }
  if (!kindTrigger) return false;
  // antd Select는 mousedown으로도 열림. click과 둘 다 dispatch해 다른 리스너 cover.
  const opts = { bubbles: true, cancelable: true, view: window } as const;
  kindTrigger.dispatchEvent(new MouseEvent("mousedown", opts));
  kindTrigger.dispatchEvent(new MouseEvent("mouseup", opts));
  kindTrigger.click();

  const targetLabel = PROMO_KIND_LABELS[kind];
  const opt = await waitFor(() => {
    const items = document.querySelectorAll<HTMLElement>(
      "li.ad-cms-dropdown-menu-item, li[role='option'], .ad-cms-select-option, .ad-cms-select-item-option",
    );
    for (const li of Array.from(items)) {
      const text = (li.textContent ?? "").trim();
      if (text === targetLabel) return li;
    }
    return null;
  }, MENU_WAIT_MS);
  if (!opt) return false;
  opt.dispatchEvent(new MouseEvent("mousedown", opts));
  opt.dispatchEvent(new MouseEvent("mouseup", opts));
  opt.click();
  return true;
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
async function waitForSubmitEnabled(modal: HTMLElement, timeoutMs = SUBMIT_ENABLE_WAIT_MS): Promise<boolean> {
  const ready = await waitFor(() => {
    const btn = findSubmitButton(modal);
    if (!btn) return null;
    return btn.disabled ? null : btn;
  }, timeoutMs);
  return ready != null;
}

// ─── 각 종류별 등록 ───

async function registerTextItem(
  kind: "headline" | "description",
  text: string,
  position?: HeadlinePosition,
): Promise<AssetResult> {
  const label = KIND_LABELS[kind];
  const trimmed = text.trim();
  if (!trimmed) {
    return { kind, ok: true, label: `${label} (빈 항목)`, reason: "empty" };
  }
  const positionSuffix =
    kind === "headline" && position && position !== "all"
      ? ` (${POSITION_OPTION_LABELS[position]})`
      : "";
  const displayLabel = `${label} "${trimmed}"${positionSuffix}`;

  const opened = await openMenuAndClick(label);
  if (!opened) {
    return { kind, ok: false, label: displayLabel, reason: "no-menu-item" };
  }

  const modal = await waitFor(() => findOpenModal(kind), MODAL_WAIT_MS);
  if (!modal) {
    return { kind, ok: false, label: displayLabel, reason: "no-modal" };
  }

  // React mount 직후 페이지 측 input/dropdown 리스너가 한 cycle 더 필요한 케이스가 있어
  // 첫 모달에서 submit click이 무시되는 race가 보고됨. setReactInputValue 전에 짧게 양보.
  await sleep(80);

  const input = findTextInput(modal, kind);
  if (!input) {
    findCloseButton(modal)?.click();
    return { kind, ok: false, label: displayLabel, reason: "no-input" };
  }

  setReactInputValue(input, trimmed);

  // 추가제목 모달의 노출 위치 dropdown — default("all")가 아니면 dropdown 조작.
  if (kind === "headline" && position && position !== "all") {
    const positionOk = await selectHeadlinePosition(modal, position);
    if (!positionOk) {
      findCloseButton(modal)?.click();
      return { kind, ok: false, label: displayLabel, reason: "position-failed" };
    }
  }

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

  // submit click race fix — 페이지가 가끔 첫/마지막 사이클의 click을 무시한다.
  // 1차 click 후 모달이 안 닫히면 input/change 한 번 더 dispatch + click 재시도.
  submitBtn.click();
  const closed = await waitForModalClosedRetry(modal, submitBtn, input, trimmed);
  if (!closed) {
    return { kind, ok: false, label: displayLabel, reason: "modal-not-closed" };
  }
  return { kind, ok: true, label: displayLabel };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function raf(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/**
 * 저장 클릭 후 모달 unmount 대기. 1차 대기에서 안 닫히면 input 이벤트 재dispatch + click 재시도.
 * 사용자 보고된 race(첫·마지막 모달의 submit click 무시)에 대응.
 */
async function waitForModalClosedRetry(
  modal: HTMLElement,
  submitBtn: HTMLButtonElement,
  input: HTMLInputElement | null,
  inputValue: string,
): Promise<boolean> {
  // 1차 짧은 대기 — 정상 케이스는 보통 200~500ms 안에 unmount.
  const fast = await waitFor(() => {
    if (!modal.isConnected) return true;
    const r = modal.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    return null;
  }, 800);
  if (fast === true) return true;

  // 1차 실패 — input state를 한 번 더 commit하고 저장 재클릭.
  if (input) {
    setReactInputValue(input, inputValue);
  }
  await sleep(120);
  const stillEnabled = !submitBtn.disabled;
  if (stillEnabled && submitBtn.isConnected) {
    submitBtn.click();
  }

  // 2차 — 본래 timeout의 남은 시간.
  const slow = await waitFor(() => {
    if (!modal.isConnected) return true;
    const r = modal.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return true;
    return null;
  }, MODAL_CLOSE_WAIT_MS - 800);
  return slow === true;
}

/**
 * 파워링크 이미지 등록 — 한 모달에서 multiple file을 한 번에 등록 (file input이 multiple).
 * 페이지가 "이미지 라이브러리에 등록합니다" 체크박스 기본 checked로 두는데 우리는 건드리지 않음.
 */
async function registerImageItem(
  files: File[],
  opts?: { manualCrop?: boolean },
): Promise<AssetResult> {
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

  // DataTransfer로 file 주입. 페이지(React)가 file 받자마자 canvas로 미리보기 처리 —
  // canvas ref가 mount되기 전에 `.toBlob()` 호출되면 "Cannot read properties of null"
  // 에러. input/change를 같은 tick에 dispatch하면 React batched 처리로 ref mount 시점이
  // 어긋남. raf 사이에 두 이벤트를 분리하고 short delay로 canvas mount 시간 확보.
  const dt = new DataTransfer();
  for (const f of validFiles) dt.items.add(f);
  fileInput.files = dt.files;
  validFiles.forEach((f) => {
    console.log(
      `[dv-ads/asset-bulk] image inject name="${f.name}" size=${f.size}b type="${f.type}"`,
    );
  });
  fileInput.dispatchEvent(new Event("input", { bubbles: true }));
  await raf();
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  // 페이지의 file picker dismissal 흉내 — blur 후 페이지가 canvas mount 진행.
  await sleep(50);
  fileInput.dispatchEvent(new Event("blur", { bubbles: true }));

  // 수동 자르기 모드 — 자동 [저장] 클릭 없이 사용자가 페이지 모달에서 직접 자르고 저장할 때까지
  // 대기. 모달이 닫히면 success로 간주(취소·X 클릭도 같은 신호라 v1은 구분 안 함).
  if (opts?.manualCrop) {
    const userClosed = await waitFor(() => {
      if (!modal.isConnected) return true;
      const r = modal.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return true;
      return null;
    }, MANUAL_CROP_WAIT_MS);
    if (userClosed !== true) {
      findCloseButton(modal)?.click();
      return { kind: "image", ok: false, label: displayLabel, reason: "modal-not-closed" };
    }
    return { kind: "image", ok: true, label: displayLabel };
  }

  // 페이지가 이미지 업로드 처리(클라이언트 리사이즈/검증)를 마치고 저장 버튼을 활성화할 때까지 대기.
  // 5MB·2000x2000 한도. URL 다운로드 받은 이미지가 큰 경우 리사이즈에 수 초 걸릴 수 있어
  // 이미지 모달은 다른 모달보다 긴 wait(6초) 적용.
  const enabled = await waitForSubmitEnabled(modal, IMAGE_SUBMIT_ENABLE_WAIT_MS);
  const submitBtn = findSubmitButton(modal);
  if (!enabled || !submitBtn) {
    // 진단 — 페이지가 모달에 띄운 에러 메시지(있다면)를 콘솔로 남겨 어떤 검증이 실패했는지 추적.
    const modalText = (modal.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    console.warn("[dv-ads/asset-bulk] submit-disabled - modal text:", modalText);
    findCloseButton(modal)?.click();
    return {
      kind: "image",
      ok: false,
      label: displayLabel,
      reason: submitBtn ? "submit-disabled" : "no-submit",
    };
  }
  submitBtn.click();

  // 이미지 모달도 첫/마지막 사이클에서 click 무시 race가 있어 retry 적용.
  const closed = await waitForModalClosedRetry(modal, submitBtn, null, "");
  if (!closed) {
    return { kind: "image", ok: false, label: displayLabel, reason: "modal-not-closed" };
  }
  return { kind: "image", ok: true, label: displayLabel };
}

/**
 * 홍보문구 등록 — 홍보종류 dropdown(선택 안 함 default) + 추가설명 14자 입력 후 저장.
 * 텍스트 모달과 흐름은 같되 dropdown 선택이 한 단계 추가됨.
 */
async function registerPromoItem(
  description: string,
  promoKind: PromoKind,
): Promise<AssetResult> {
  const label = KIND_LABELS.promo;
  const trimmed = description.trim();
  if (!trimmed) {
    return { kind: "promo", ok: true, label: `${label} (빈 항목)`, reason: "empty" };
  }
  const kindSuffix =
    promoKind !== "none" ? ` [${PROMO_KIND_LABELS[promoKind]}]` : "";
  const displayLabel = `${label} "${trimmed}"${kindSuffix}`;

  const opened = await openMenuAndClick(label);
  if (!opened) {
    return { kind: "promo", ok: false, label: displayLabel, reason: "no-menu-item" };
  }

  const modal = await waitFor(() => findOpenModal("promo"), MODAL_WAIT_MS);
  if (!modal) {
    return { kind: "promo", ok: false, label: displayLabel, reason: "no-modal" };
  }

  // React mount 직후 페이지 리스너 settle을 위해 짧게 양보 (텍스트 모달과 동일).
  await sleep(80);

  // 홍보종류를 먼저 선택 — dropdown이 setState하면서 input 영역 재mount 가능성.
  if (promoKind !== "none") {
    const kindOk = await selectPromoKind(modal, promoKind);
    if (!kindOk) {
      findCloseButton(modal)?.click();
      return { kind: "promo", ok: false, label: displayLabel, reason: "position-failed" };
    }
    // dropdown close + 다음 단계 input 안정화 짧은 대기.
    await sleep(120);
  }

  // 추가설명 input — 모달 body 안의 단일 text input.
  const input = findTextInput(modal, "description");
  if (!input) {
    findCloseButton(modal)?.click();
    return { kind: "promo", ok: false, label: displayLabel, reason: "no-input" };
  }
  setReactInputValue(input, trimmed);

  const enabled = await waitForSubmitEnabled(modal);
  const submitBtn = findSubmitButton(modal);
  if (!enabled || !submitBtn) {
    findCloseButton(modal)?.click();
    return {
      kind: "promo",
      ok: false,
      label: displayLabel,
      reason: submitBtn ? "submit-disabled" : "no-submit",
    };
  }
  submitBtn.click();
  const closed = await waitForModalClosedRetry(modal, submitBtn, input, trimmed);
  if (!closed) {
    return { kind: "promo", ok: false, label: displayLabel, reason: "modal-not-closed" };
  }
  return { kind: "promo", ok: true, label: displayLabel };
}

/**
 * 외부 진입점 — 한 항목 등록. 종류별 분기.
 */
export async function registerAssetItem(item: AssetItemSource): Promise<AssetResult> {
  try {
    if (item.kind === "headline") {
      return await registerTextItem("headline", item.text, item.position);
    }
    if (item.kind === "description") {
      return await registerTextItem("description", item.text);
    }
    if (item.kind === "promo") {
      return await registerPromoItem(item.description, item.promoKind);
    }
    return await registerImageItem(item.files, { manualCrop: item.manualCrop });
  } catch (e) {
    console.warn("[dv-ads/asset-bulk] register failed", e);
    return {
      kind: item.kind,
      ok: false,
      label: KIND_LABELS[item.kind],
      reason: "unknown",
    };
  }
  // 사이클 사이에 closeOpenMenu를 호출하지 않는다 — 페이지가 li click 시 메뉴를
  // 자연스럽게 닫기 때문에. 우리가 트리거 click을 추가로 누르면 메뉴가 다시 열려
  // 깜빡임이 생긴다. 마지막 cleanup은 orchestrator의 runBulkRegistration에서 한 번만.
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
    case "position-failed":
      return "노출 위치 선택에 실패했습니다";
    case "modal-not-closed":
      return "저장 후 모달이 닫히지 않았습니다 (페이지 측 오류일 수 있음)";
    case "empty":
      return "빈 항목으로 건너뛰었습니다";
    default:
      return "알 수 없는 오류가 발생했습니다";
  }
}
