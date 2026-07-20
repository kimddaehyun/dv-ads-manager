/**
 * 배경 스크롤 잠금 — dvads backdrop(중앙 다이얼로그의 dim 배경)이 하나라도 떠 있는 동안
 * 페이지 스크롤을 막는다.
 *
 * 개별 다이얼로그가 각자 잠금/해제를 관리하면 backdrop 생성 지점(10곳+)마다 누락 위험이
 * 있어, body를 감시하는 단일 관찰자로 처리한다. 모든 backdrop 클래스는 "backdrop"을
 * 포함하므로(`dvads-confirm-backdrop`, `dvads-brief-backdrop`, ...) 셀렉터 하나로 현재·미래
 * 다이얼로그를 전부 커버한다. 페이지 자체 모달에 길을 비켜주는 `.dvads-recede` 상태는
 * 화면에서 숨겨진 것이므로 잠금 대상에서 제외.
 */

// backdrop은 전부 document.body 직속으로 mount된다 (:scope > 로 페이지 내부 오탐 방지).
const BACKDROP_SELECTOR = ':scope > .dvads[class*="backdrop"]:not(.dvads-recede)';

let locked = false;
let savedHtmlOverflow = "";
let savedBodyOverflow = "";

function evaluate(): void {
  const shouldLock = !!document.body.querySelector(BACKDROP_SELECTOR);
  if (shouldLock === locked) return;
  locked = shouldLock;
  const html = document.documentElement;
  if (shouldLock) {
    savedHtmlOverflow = html.style.overflow;
    savedBodyOverflow = document.body.style.overflow;
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  } else {
    html.style.overflow = savedHtmlOverflow;
    document.body.style.overflow = savedBodyOverflow;
  }
}

/** 콘텐츠 스크립트 진입점에서 1회 호출. */
export function initScrollLock(): void {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      evaluate();
    });
  };
  // childList: backdrop mount/remove 감지. attributes(class): `.dvads-recede` 토글 감지.
  new MutationObserver(schedule).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  evaluate();
}
