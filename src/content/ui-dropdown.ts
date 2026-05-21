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
    // `data-side`는 CSS sweep 애니메이션 방향 결정 — bottom: 위→아래, top: 아래→위.
    // 이 frame에서 처음 세팅 → 그 시점에 키프레임 발동 → 한 번만 깔끔하게 sweep.
    //
    // ★ 중요: rAF 콜백에서 `panel.offsetHeight` 접근으로 강제 layout이 일어나 panel이
    //   첫 paint 전이어도 정확한 높이를 얻는다. CSS 기본 상태가 `clip-path: inset(0 0 100% 0)`
    //   라 panel은 보이지 않지만 layout box는 계산됨. 이 rAF를 동기 호출로 바꾸면 panel
    //   appendChild 직전 layout이 stale이라 잘못된 side 판정 가능 — rAF 유지 필요.
    requestAnimationFrame(() => {
      if (!panel) return;
      const ph = panel.offsetHeight;
      let side: "top" | "bottom" = "bottom";
      if (r.bottom + 4 + ph > window.innerHeight - 8) {
        panel.style.top = `${Math.max(8, r.top - 4 - ph)}px`;
        side = "top";
      }
      panel.dataset.side = side;
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

// ─────────────────────────────────────────────────────────────
// 액션 메뉴 (kebab) — 값 선택 dropdown과 별개의 패턴.
// 각 항목이 서로 다른 동작을 수행하는 메뉴. 트리거는 caller가 소유 (예: "..." 버튼).
// 패널 CSS(.dvads-dropdown-panel/.dvads-dropdown-option)와 정리 레지스트리(openPanels)를
// createDropdown과 공유 — popover dismiss 시 closeAllOpenDropdowns()로 함께 정리됨.
// ─────────────────────────────────────────────────────────────

export interface ActionMenuItem {
  /** 항목 라벨. separator=true면 무시. */
  label?: string;
  /** 클릭 핸들러. 생략 시 placeholder — 메뉴만 닫고 다른 동작 안 함. */
  onClick?: () => void;
  /** 빨강 강조 (삭제 등 destructive 액션). */
  danger?: boolean;
  /** 비활성 — 클릭 불가, 흐릿하게. */
  disabled?: boolean;
  /** 항목 사이 구분선 (수평 hr). 다른 필드 모두 무시. */
  separator?: boolean;
}

export interface AttachActionMenuOptions {
  /** 트리거 element — caller가 소유. 이 element 클릭 시 메뉴 토글. */
  trigger: HTMLElement;
  /** 메뉴 항목. 배열이면 한 번 캡처, 함수면 매 open 시점에 호출해 동적으로 빌드
   *  (예: 선택 상태에 따라 disabled가 바뀌는 경우). */
  items: ActionMenuItem[] | (() => ActionMenuItem[]);
  ariaLabel?: string;
}

export function attachActionMenu(opts: AttachActionMenuOptions): { close: () => void } {
  let panel: HTMLElement | null = null;

  const positionPanel = (): void => {
    if (!panel) return;
    const r = opts.trigger.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.zIndex = "2147483647";
    panel.style.top = `${r.bottom + 4}px`;
    // 좌측 정렬 — 패널의 left edge가 트리거 left에 맞춰지고 오른쪽으로 펼쳐짐.
    // 트리거가 좁은 셀(kebab "..." 등)이라 좌측 정렬이 자연스럽고, 가용 공간이 부족하면
    // rAF 단계에서 우측 정렬로 폴백.
    panel.style.left = `${r.left}px`;
    panel.style.right = "auto";

    requestAnimationFrame(() => {
      if (!panel) return;

      // 가로 overflow 체크 — 패널 우측이 viewport를 넘으면 우측 앵커로 폴백.
      const pw = panel.offsetWidth;
      if (r.left + pw > window.innerWidth - 8) {
        panel.style.left = "auto";
        panel.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      }

      // 세로 overflow 체크 — 하단 공간 부족하면 위로 flip.
      const ph = panel.offsetHeight;
      let side: "top" | "bottom" = "bottom";
      if (r.bottom + 4 + ph > window.innerHeight - 8) {
        panel.style.top = `${Math.max(8, r.top - 4 - ph)}px`;
        side = "top";
      }
      panel.dataset.side = side;
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
    opts.trigger.classList.remove("is-open");
  };

  const openPanel = (): void => {
    if (panel) return;
    panel = document.createElement("div");
    panel.className = "dvads dvads-dropdown-panel dvads-action-menu-panel";
    if (opts.ariaLabel) panel.setAttribute("aria-label", opts.ariaLabel);

    const resolvedItems = typeof opts.items === "function" ? opts.items() : opts.items;
    for (const item of resolvedItems) {
      if (item.separator) {
        const hr = document.createElement("div");
        hr.className = "dvads-dropdown-separator";
        hr.setAttribute("role", "separator");
        panel.appendChild(hr);
        continue;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dvads-dropdown-option";
      if (item.danger) btn.classList.add("is-danger");
      if (item.disabled) {
        btn.classList.add("is-disabled");
        btn.disabled = true;
      }
      btn.textContent = item.label ?? "";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.disabled) return;
        // placeholder(onClick 미지정)도 메뉴는 닫는다.
        closePanel();
        item.onClick?.();
      });
      panel.appendChild(btn);
    }

    document.body.appendChild(panel);
    openPanels.add(panel);
    positionPanel();
    opts.trigger.classList.add("is-open");

    const onDocPointer = (e: MouseEvent | PointerEvent): void => {
      if (!panel) return;
      const t = e.target as Node;
      if (panel.contains(t) || opts.trigger.contains(t)) return;
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
      closePanel();
    };

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

  opts.trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (panel) closePanel();
    else openPanel();
  });

  return {
    close() {
      closePanel();
    },
  };
}
