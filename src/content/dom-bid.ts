/**
 * ads.naver.com 입찰가 변경 UI 자동화.
 *
 * 호스트 페이지의 입찰가 셀을 클릭 → 자체 popover 내 input에 값 주입 →
 * "변경" 버튼 클릭 → 셀 텍스트 갱신 확인. 검색광고 API를 호출하지 않고
 * 사용자가 직접 수정하는 것과 동일한 경로를 흉내내, 즉시 반영·권한 동일·
 * nccKeywordId 추출 부담 회피.
 *
 * 깨질 위험을 한 파일에 모았다. ads.naver.com이 클래스명을 갈면 여기만 고치면 된다.
 *
 * 셀렉터 출처: 2026-05-18 실측 (스크린샷 정찰). aria-valuemin="70" /
 * aria-valuemax="100000"이 가장 안정적 — 입찰가 input만 가지는 조합.
 */

const BID_INPUT_SELECTOR =
  'input.ad-cms-input-number-input[aria-valuemin="70"][aria-valuemax="100000"]';
const BID_SUBMIT_BTN_SELECTOR = "button.ad-cms-btn-primary";
const CONFIRM_MODAL_BTN_SELECTOR = "button.ad-cms-btn-primary";

/** 입찰가 변경 popover의 input 등장 대기 시간 */
const INPUT_WAIT_MS = 800;
/** "변경" 클릭 후 페이지가 셀 텍스트를 갱신할 때까지 대기 */
const CELL_REFLECT_MS = 4000;
/** 변경 성공 후 페이지가 띄우는 "변경되었습니다" 모달을 자동 닫을 때까지 대기 */
const CONFIRM_MODAL_WAIT_MS = 2000;

export type ApplyBidFailure =
  | "no-trigger"
  | "no-input"
  | "no-submit"
  | "value-not-reflected"
  | "row-detached"
  | "unknown";

export interface ApplyBidResult {
  ok: boolean;
  previousBid?: number;
  reason?: ApplyBidFailure;
}

export interface ApplyBidOptions {
  /** 같은 행 안의 입찰가 셀(td). closest("tr")로 행 식별. */
  bidCell: HTMLElement;
  targetBid: number;
}

/** "1,700원" / "[기본] 700 원" 등에서 첫 숫자 그룹. */
const BID_TEXT_RE = /([\d,]+)\s*원/;

export function parseBidCellValue(cell: HTMLElement): number | null {
  const m = (cell.textContent ?? "").match(BID_TEXT_RE);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 입찰가 셀 안의 클릭 트리거를 찾아 popover를 연다.
 * 셀 자체가 link/button인 경우도 있고 자식이 트리거인 경우도 있어 둘 다 시도.
 */
function clickBidCell(cell: HTMLElement): boolean {
  // 우선순위: 셀 안의 <a>, <button>, role="link"/"button" 자식
  const candidate =
    cell.querySelector<HTMLElement>(
      'a, button, [role="link"], [role="button"]',
    ) ?? cell;
  candidate.click();
  return true;
}

/**
 * MutationObserver 기반 등장 대기. timeout 초과 시 null.
 * predicate가 즉시 true면 즉시 반환.
 */
function waitFor<T>(
  predicate: () => T | null | undefined,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const found = predicate();
    if (found) {
      resolve(found);
      return;
    }
    const obs = new MutationObserver(() => {
      const v = predicate();
      if (v) {
        cleanup();
        resolve(v);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const t = window.setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
    function cleanup() {
      obs.disconnect();
      window.clearTimeout(t);
    }
  });
}

/**
 * React가 관리하는 input의 값을 변경한다.
 * 단순 `input.value = "X"`는 React state를 우회하지 못해 저장 시 원래값으로 복구됨.
 * nativeInputValueSetter + bubbling input/change 이벤트가 필수.
 */
function setReactInputValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input);
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  const setter = desc?.set;
  if (setter) {
    setter.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * 변경 후 페이지가 띄우는 "입찰가가 변경되었습니다" 모달의 "닫기"를 자동 클릭.
 * 못 찾으면 조용히 통과 — 사용자가 직접 닫으면 됨.
 */
function autoDismissConfirmModal(): void {
  void waitFor(() => {
    // 모달 안에는 ad-cms-btn-primary 한 개("닫기") + dialog role 컨테이너가 있다.
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    for (const d of Array.from(dialogs)) {
      const btn = d.querySelector<HTMLButtonElement>(CONFIRM_MODAL_BTN_SELECTOR);
      if (btn && (btn.textContent ?? "").trim() === "닫기") return btn;
    }
    return null;
  }, CONFIRM_MODAL_WAIT_MS).then((btn) => {
    if (btn) btn.click();
  });
}

export async function applyBidToRow(
  opts: ApplyBidOptions,
): Promise<ApplyBidResult> {
  const { bidCell, targetBid } = opts;

  if (!bidCell.isConnected) {
    return { ok: false, reason: "row-detached" };
  }

  const previousBid = parseBidCellValue(bidCell);
  if (previousBid === targetBid) {
    return { ok: true, previousBid };
  }

  if (!clickBidCell(bidCell)) {
    return { ok: false, reason: "no-trigger" };
  }

  // popover input 등장 대기. document 전체에서 검색 — popover가 어디 portal될지 모름.
  const input = await waitFor<HTMLInputElement>(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>(BID_INPUT_SELECTOR);
    // 가장 최근에 추가된(마지막) input 채택. 보통 1개만 떠 있음.
    return inputs.length > 0 ? inputs[inputs.length - 1] : null;
  }, INPUT_WAIT_MS);

  if (!input) {
    return { ok: false, reason: "no-input", previousBid: previousBid ?? undefined };
  }

  setReactInputValue(input, String(targetBid));

  // input과 같은 popover scope 안의 primary 버튼 = "변경"
  // document.body로 fallback하면 페이지의 다른 primary 버튼(헤더 "저장" 등)을 잘못
  // 누를 수 있으므로, scope를 찾지 못하면 즉시 실패 처리.
  const popoverScope = input.closest<HTMLElement>('[role="dialog"], .ad-cms-popover');
  if (!popoverScope) {
    return { ok: false, reason: "no-submit", previousBid: previousBid ?? undefined };
  }
  const submitBtn = popoverScope.querySelector<HTMLButtonElement>(
    BID_SUBMIT_BTN_SELECTOR,
  );
  if (!submitBtn) {
    return { ok: false, reason: "no-submit", previousBid: previousBid ?? undefined };
  }
  submitBtn.click();

  // 셀 텍스트 갱신 대기 — previousBid가 targetBid로 바뀔 때까지.
  const reflected = await waitFor(() => {
    const cur = parseBidCellValue(bidCell);
    return cur === targetBid ? true : null;
  }, CELL_REFLECT_MS);

  // 변경 성공 모달 자동 닫기 (best-effort, 비동기로 진행)
  autoDismissConfirmModal();

  if (!reflected) {
    return {
      ok: false,
      reason: "value-not-reflected",
      previousBid: previousBid ?? undefined,
    };
  }

  return { ok: true, previousBid: previousBid ?? undefined };
}

export function describeFailure(reason: ApplyBidFailure | undefined): string {
  switch (reason) {
    case "no-trigger":
      return "입찰가 셀을 클릭할 수 없습니다";
    case "no-input":
      return "입찰가 입력 칸을 찾지 못했습니다";
    case "no-submit":
      return "변경 버튼을 찾지 못했습니다";
    case "value-not-reflected":
      return "변경이 페이지에 반영되지 않았습니다";
    case "row-detached":
      return "키워드 행이 화면에서 사라졌습니다";
    default:
      return "알 수 없는 오류가 발생했습니다";
  }
}
