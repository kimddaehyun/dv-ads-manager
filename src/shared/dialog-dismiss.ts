/**
 * 오버레이 다이얼로그 "배경 클릭으로 닫기" 공통 처리 — 드래그 오작동 방지.
 *
 * 문제: 카드(내부 입력창 등) 안에서 mousedown → 카드 밖 backdrop에서 mouseup(텍스트 드래그 후
 * 밖에서 손 뗌)하면 브라우저가 backdrop을 target으로 `click`을 발화해, 단순 `e.target === backdrop`
 * 판정만으로는 다이얼로그가 잘못 닫힌다.
 *
 * 해결: **mousedown이 backdrop 자체에서 시작한 경우에만** 닫는다. 또한 다이얼로그 위 click이
 * 부모 popover의 "바깥 클릭 시 닫기"로 새지 않도록 항상 stopPropagation.
 *
 * 새 오버레이 다이얼로그는 backdrop 클릭 dismiss를 직접 구현하지 말고 반드시 이 헬퍼를 쓴다.
 */
export function wireBackdropDismiss(
  backdrop: HTMLElement,
  onDismiss: () => void,
  isBlocked?: () => boolean,
): void {
  let downOnBackdrop = false;
  backdrop.addEventListener("mousedown", (e) => {
    downOnBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener("click", (e) => {
    e.stopPropagation();
    const startedOnBackdrop = downOnBackdrop;
    downOnBackdrop = false;
    if (isBlocked?.()) return;
    // mousedown도 backdrop에서 시작했고 click target도 backdrop일 때만 닫는다.
    if (e.target === backdrop && startedOnBackdrop) onDismiss();
  });
}
