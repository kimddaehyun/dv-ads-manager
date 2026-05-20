/**
 * dv-ads 공용 dropdown 컴포넌트 (native DOM, React 미사용).
 *
 * 콘텐츠 오버레이의 모든 단일 선택 UI는 native `<select>` 대신 본 컴포넌트를 사용한다.
 * native `<select>`는 OS·브라우저별 외관 차이가 커서 dvads 시각 톤(주황 강조,
 * 카드형 패널)에 통일이 불가능. DESIGN.md의 "공용 dropdown" 패턴 단일 진실의 원천.
 *
 * 패널은 `document.body`에 portal로 mount해 부모의 `overflow-y:auto` 클리핑을 피한다.
 * z-index는 backdrop(2147483647) 위로 한 단계 더 올려야 popup 안에서 열린 dropdown이
 * 가려지지 않는다. backdrop도 동일 max라 같은 값 사용 + `body.appendChild`로 마지막에
 * 그려지게 보장 (DOM order로 위로).
 *
 * 사용 패턴:
 *   const dd = createDropdown<HeadlinePosition>({
 *     value: "all",
 *     options: [{ value: "all", label: "모든 위치" }, ...],
 *     ariaLabel: "노출 위치",
 *     onChange: (v) => { ... },
 *   });
 *   row.appendChild(dd.root);
 *
 * popup 등 컨테이너가 dismiss될 때 `closeAllOpenDropdowns()`를 호출해 잔여 패널 정리.
 */

export interface DropdownOption<V extends string> {
  value: V;
  label: string;
}

export interface CreateDropdownOptions<V extends string> {
  value: V;
  options: DropdownOption<V>[];
  /** 트리거 aria-label (시각 라벨이 없는 dropdown에 필수) */
  ariaLabel?: string;
  /** 트리거 폭(px). default 130. 옵션 라벨 최장 길이에 맞춰 조정. */
  width?: number;
  /** 트리거 root에 추가될 extra class (레이아웃 미세 조정용) */
  className?: string;
  onChange: (value: V) => void;
}

export interface DropdownHandle<V extends string> {
  /** 트리거 element — 행에 append할 root */
  root: HTMLElement;
  /** 외부에서 값 강제 갱신 (예: 폼 reset) */
  setValue(value: V): void;
  /** dropdown이 열려있으면 닫기 (idempotent) */
  close(): void;
}

// 열려있는 모든 dropdown 패널을 추적해 일괄 정리 가능하게.
const openPanels = new Set<HTMLElement>();

export function closeAllOpenDropdowns(): void {
  // Set 반복 중 mutate 발생 — 스냅샷 후 순회.
  Array.from(openPanels).forEach((panel) => {
    const cleanup = (panel as unknown as { __dvadsCleanup?: () => void })
      .__dvadsCleanup;
    cleanup?.();
  });
  openPanels.clear();
}

export function createDropdown<V extends string>(
  opts: CreateDropdownOptions<V>,
): DropdownHandle<V> {
  let currentValue = opts.value;
  let panel: HTMLElement | null = null;

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dvads-dropdown-trigger";
  if (opts.className) trigger.classList.add(opts.className);
  if (opts.ariaLabel) trigger.setAttribute("aria-label", opts.ariaLabel);
  trigger.style.width = `${opts.width ?? 130}px`;

  const labelEl = document.createElement("span");
  labelEl.className = "dvads-dropdown-label";

  const chevronEl = document.createElement("span");
  chevronEl.className = "dvads-dropdown-chevron";
  chevronEl.setAttribute("aria-hidden", "true");
  // U+25BE BLACK DOWN-POINTING SMALL TRIANGLE — 트리거 chevron.
  chevronEl.textContent = "▾";

  trigger.append(labelEl, chevronEl);

  const renderLabel = (): void => {
    const o = opts.options.find((x) => x.value === currentValue);
    labelEl.textContent = o?.label ?? String(currentValue);
  };
  renderLabel();

  const positionPanel = (): void => {
    if (!panel) return;
    const r = trigger.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.zIndex = "2147483647";
    panel.style.top = `${r.bottom + 4}px`;
    panel.style.left = `${r.left}px`;
    panel.style.minWidth = `${r.width}px`;

    // 화면 하단에 너무 가까우면 위로 펼치기 (panel 높이 계산은 다음 frame).
    requestAnimationFrame(() => {
      if (!panel) return;
      const ph = panel.offsetHeight;
      if (r.bottom + 4 + ph > window.innerHeight - 8) {
        panel.style.top = `${Math.max(8, r.top - 4 - ph)}px`;
      }
    });
  };

  const closePanel = (): void => {
    if (!panel) return;
    const cleanup = (panel as unknown as { __dvadsCleanup?: () => void })
      .__dvadsCleanup;
    cleanup?.();
    openPanels.delete(panel);
    panel.remove();
    panel = null;
    trigger.classList.remove("is-open");
  };

  const openPanel = (): void => {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "dvads dvads-dropdown-panel";

    for (const o of opts.options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "dvads-dropdown-option";
      if (o.value === currentValue) item.classList.add("is-selected");
      item.textContent = o.label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        currentValue = o.value;
        renderLabel();
        opts.onChange(o.value);
        closePanel();
      });
      panel.appendChild(item);
    }

    document.body.appendChild(panel);
    openPanels.add(panel);
    positionPanel();
    trigger.classList.add("is-open");

    const onDocPointer = (e: MouseEvent | PointerEvent): void => {
      if (!panel) return;
      const t = e.target as Node;
      if (panel.contains(t) || trigger.contains(t)) return;
      closePanel();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      }
    };
    const onScrollOrResize = (): void => {
      // 스크롤되면 trigger 위치가 바뀌므로 패널을 닫는 게 단순·예측가능.
      closePanel();
    };

    // 트리거 click 자체가 document로 버블링되면서 onDocPointer가 닫아버리는 race 방지 —
    // 다음 tick부터 등록.
    setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointer, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("scroll", onScrollOrResize, true);
      window.addEventListener("resize", onScrollOrResize);
    }, 0);

    (panel as unknown as { __dvadsCleanup: () => void }).__dvadsCleanup = () => {
      document.removeEventListener("pointerdown", onDocPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  };

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel) closePanel();
    else openPanel();
  });

  return {
    root: trigger,
    setValue(value) {
      currentValue = value;
      renderLabel();
      if (panel) {
        const items = panel.querySelectorAll<HTMLElement>(".dvads-dropdown-option");
        items.forEach((el, i) => {
          el.classList.toggle("is-selected", opts.options[i]?.value === value);
        });
      }
    },
    close() {
      closePanel();
    },
  };
}
