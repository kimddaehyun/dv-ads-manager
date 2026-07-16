/**
 * F-Report 날짜 선택기 — 네이버 광고 날짜 선택기를 그대로 옮긴 flyout (컬러만 DV 주황).
 *
 * 설정 드롭다운/행 메뉴의 "리포트 생성" 클릭 시, 메뉴를 닫고 어두운 모달을 띄우는 대신
 * 메뉴 옆으로 펼쳐진다(`registerMenuSibling`로 메뉴가 함께 닫히지 않게 등록).
 *
 * 레이아웃: [좌] 기간 프리셋 세로 리스트  [우] from/to 입력 + 연/월 네비 + 요일헤더 +
 * 스크롤되는 월별 달력. 하단에 담당자 입력 + 취소/확인. 미래 날짜는 비활성.
 * 전부 native DOM (React 미사용).
 */

import { rangeForPreset, PRESET_LABELS, type ReportPreset, type DateRange } from "@/features/report/report-period";
import { registerMenuSibling, closeAllOpenDropdowns } from "@/shared/ui-dropdown";

const PRESETS = Object.keys(PRESET_LABELS) as ReportPreset[];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// 마지막 입력 담당자명 영속 키 (chrome.storage.local).
const AUTHOR_KEY = "report_last_author";

// 달력에 보여줄 월 범위: 오늘 기준 과거 18개월 ~ 미래 2개월.
const MONTHS_BACK = 18;
const MONTHS_FWD = 2;

let openEl: HTMLElement | null = null;
let dispose: (() => void) | null = null;

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDot(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}.`;
}
function monthKey(y: number, m: number): string {
  return `${y}-${m}`;
}

export interface OpenDatePickerOpts {
  /** 옆으로 펼칠 기준 element (클릭된 메뉴 항목). */
  anchor: HTMLElement;
  /** anchor의 위치를 미리 캡처한 rect (호출원이 await 후 열어 anchor가 떨어진 경우 사용). */
  anchorRect?: DOMRect;
  /** 상단 컨텍스트 한 줄 (예: 광고주명 / "N개 광고주"). */
  subText: string;
  /** 담당자 입력란 표시 여부. 기본 true. F-Brief는 문구에 담당자명이 안 들어가 false. */
  showAuthor?: boolean;
  onConfirm: (range: DateRange, author: string) => void;
}

export function closeReportDatePicker(): void {
  dispose?.();
}

export function openReportDatePicker(opts: OpenDatePickerOpts): void {
  // 이미 열려 있으면 닫고 새로 (중복 flyout 방지).
  closeReportDatePicker();

  const today = dayStart(new Date());
  const init = rangeForPreset("lastWeek", today);
  let start = parseIso(init.since);
  let end = parseIso(init.until);
  let activePreset: ReportPreset | null = "lastWeek";
  let activeField: "start" | "end" = "start";

  // ── 패널 골격 ──
  const el = document.createElement("div");
  el.className = "dvads dvads-rdp";
  el.innerHTML = `
    <div class="dvads-rdp-sub"></div>
    <div class="dvads-rdp-main">
      <div class="dvads-rdp-presets"></div>
      <div class="dvads-rdp-cal">
        <div class="dvads-rdp-fields">
          <input type="text" class="dvads-rdp-field" data-field="start" inputmode="numeric" aria-label="시작일" />
          <span class="dvads-rdp-arrow" aria-hidden="true">→</span>
          <input type="text" class="dvads-rdp-field" data-field="end" inputmode="numeric" aria-label="종료일" />
        </div>
        <div class="dvads-rdp-navhead">
          <button type="button" class="dvads-rdp-nav" data-nav="py" aria-label="이전 해">&laquo;</button>
          <button type="button" class="dvads-rdp-nav" data-nav="pm" aria-label="이전 달">&lsaquo;</button>
          <span class="dvads-rdp-navlabel"></span>
          <button type="button" class="dvads-rdp-nav" data-nav="nm" aria-label="다음 달">&rsaquo;</button>
          <button type="button" class="dvads-rdp-nav" data-nav="ny" aria-label="다음 해">&raquo;</button>
        </div>
        <div class="dvads-rdp-weekhead">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
        <div class="dvads-rdp-scroll"></div>
      </div>
    </div>
    <div class="dvads-rdp-foot">
      <input type="text" class="dvads-rdp-author" placeholder="담당자명" />
      <div class="dvads-rdp-foot-btns">
        <button type="button" class="dvads-rdp-cancel">취소</button>
        <button type="button" class="dvads-rdp-confirm">확인</button>
      </div>
    </div>
  `;
  (el.querySelector(".dvads-rdp-sub") as HTMLElement).textContent = opts.subText;

  const presetsBox = el.querySelector<HTMLElement>(".dvads-rdp-presets")!;
  const scrollBox = el.querySelector<HTMLElement>(".dvads-rdp-scroll")!;
  const navLabel = el.querySelector<HTMLElement>(".dvads-rdp-navlabel")!;
  const fieldStart = el.querySelector<HTMLInputElement>('.dvads-rdp-field[data-field="start"]')!;
  const fieldEnd = el.querySelector<HTMLInputElement>('.dvads-rdp-field[data-field="end"]')!;
  const authorInput = el.querySelector<HTMLInputElement>(".dvads-rdp-author")!;

  if (opts.showAuthor === false) {
    // 담당자 미사용(F-Brief) — 입력란만 숨기고 onConfirm의 author는 빈 문자열로 나간다.
    authorInput.style.display = "none";
  } else {
    // 마지막에 입력한 담당자명 복원 — 다음 리포트 생성 때 자동으로 채워둔다.
    chrome.storage.local.get(AUTHOR_KEY).then((r) => {
      const saved = r[AUTHOR_KEY];
      if (typeof saved === "string" && saved && document.activeElement !== authorInput && !authorInput.value) {
        authorInput.value = saved;
      }
    });
  }

  // ── 프리셋 버튼 ──
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dvads-rdp-preset";
    b.dataset.preset = p;
    b.textContent = PRESET_LABELS[p];
    b.addEventListener("click", () => {
      const r = rangeForPreset(p, today);
      start = parseIso(r.since);
      end = parseIso(r.until);
      activePreset = p;
      activeField = "start";
      paint();
      scrollToMonth(end.getFullYear(), end.getMonth());
    });
    presetsBox.appendChild(b);
  }

  // ── 월별 달력 빌드 ──
  const months: Array<{ y: number; m: number }> = [];
  {
    let cur = new Date(today.getFullYear(), today.getMonth() - MONTHS_BACK, 1);
    const last = new Date(today.getFullYear(), today.getMonth() + MONTHS_FWD, 1);
    while (cur <= last) {
      months.push({ y: cur.getFullYear(), m: cur.getMonth() });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  }
  const monthEls = new Map<string, HTMLElement>();
  for (const { y, m } of months) {
    const sec = document.createElement("div");
    sec.className = "dvads-rdp-month";
    sec.dataset.ym = monthKey(y, m);

    const label = document.createElement("div");
    label.className = "dvads-rdp-mlabel";
    label.textContent = `${y}년 ${String(m + 1).padStart(2, "0")}월`;
    sec.appendChild(label);

    const grid = document.createElement("div");
    grid.className = "dvads-rdp-grid";
    const lead = new Date(y, m, 1).getDay(); // 0=일
    for (let i = 0; i < lead; i++) {
      const blank = document.createElement("span");
      blank.className = "dvads-rdp-blank";
      grid.appendChild(blank);
    }
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "dvads-rdp-day";
      cell.dataset.date = iso(new Date(y, m, d));
      cell.textContent = String(d);
      const isFuture = new Date(y, m, d).getTime() > today.getTime();
      if (isFuture) {
        cell.classList.add("is-disabled");
        cell.disabled = true;
      } else {
        cell.addEventListener("click", () => onDayClick(new Date(y, m, d)));
      }
      grid.appendChild(cell);
    }
    sec.appendChild(grid);
    scrollBox.appendChild(sec);
    monthEls.set(monthKey(y, m), sec);
  }

  function onDayClick(d: Date): void {
    activePreset = null;
    if (activeField === "start") {
      start = d;
      if (end.getTime() < start.getTime()) end = d;
      activeField = "end";
    } else {
      end = d;
      if (end.getTime() < start.getTime()) {
        // 끝이 시작보다 앞이면 시작/끝 교체.
        const tmp = start;
        start = end;
        end = tmp;
      }
      activeField = "start";
    }
    paint();
  }

  // ── 칠하기: 프리셋 활성, from/to, 날짜 셀 범위 강조 ──
  function paint(): void {
    presetsBox.querySelectorAll<HTMLElement>(".dvads-rdp-preset").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.preset === activePreset);
    });
    // 편집 중(focus)인 칸의 값은 덮어쓰지 않는다 — 사용자가 타이핑하던 내용 보존.
    if (document.activeElement !== fieldStart) fieldStart.value = fmtDot(start);
    if (document.activeElement !== fieldEnd) fieldEnd.value = fmtDot(end);
    fieldStart.classList.toggle("is-active", activeField === "start");
    fieldEnd.classList.toggle("is-active", activeField === "end");

    const s = start.getTime();
    const e = end.getTime();
    scrollBox.querySelectorAll<HTMLElement>(".dvads-rdp-day").forEach((cell) => {
      const t = parseIso(cell.dataset.date!).getTime();
      cell.classList.toggle("is-start", t === s);
      cell.classList.toggle("is-end", t === e);
      cell.classList.toggle("is-in-range", t > s && t < e);
      cell.classList.toggle("is-single", s === e && t === s);
    });
  }

  function scrollToMonth(y: number, m: number): void {
    const sec = monthEls.get(monthKey(y, m));
    if (!sec) return;
    // 컨테이너 scrollTop 직접 조정 — scrollIntoView는 호스트 페이지까지 스크롤시킬 수 있어 회피.
    const target = sec.offsetTop - Math.max(0, (scrollBox.clientHeight - sec.offsetHeight) / 2);
    scrollBox.scrollTop = Math.max(0, target);
  }

  // 네비게이션 버튼 — 현재 라벨 기준 월 이동 후 스크롤.
  let navY = end.getFullYear();
  let navM = end.getMonth();
  function clampNav(): void {
    const min = new Date(today.getFullYear(), today.getMonth() - MONTHS_BACK, 1);
    const max = new Date(today.getFullYear(), today.getMonth() + MONTHS_FWD, 1);
    let cur = new Date(navY, navM, 1);
    if (cur < min) cur = min;
    if (cur > max) cur = max;
    navY = cur.getFullYear();
    navM = cur.getMonth();
  }
  function applyNav(): void {
    clampNav();
    navLabel.textContent = `${navY}년 ${String(navM + 1).padStart(2, "0")}월`;
    scrollToMonth(navY, navM);
  }
  el.querySelectorAll<HTMLButtonElement>(".dvads-rdp-nav").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.nav;
      if (k === "py") navY -= 1;
      else if (k === "ny") navY += 1;
      else if (k === "pm") navM -= 1;
      else if (k === "nm") navM += 1;
      applyNav();
    });
  });

  // 스크롤 시 상단에 보이는 월로 네비 라벨 동기화.
  // 각 월 섹션 offsetTop은 한 번만 측정해 캐시(레이아웃 확정 후 lazy) + rAF throttle로
  // 매 tick 레이아웃 읽기·맵 조회 제거. 달력 내용은 고정폭이라 mount 후 offsetTop 불변.
  let monthOffsets: Array<{ y: number; m: number; top: number }> | null = null;
  let scrollRaf = 0;
  scrollBox.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!monthOffsets) {
        monthOffsets = months.map(({ y, m }) => ({
          y,
          m,
          top: monthEls.get(monthKey(y, m))!.offsetTop,
        }));
      }
      const top = scrollBox.scrollTop;
      let best: { y: number; m: number } | null = null;
      for (const o of monthOffsets) {
        if (o.top <= top + 8) best = { y: o.y, m: o.m };
        else break;
      }
      if (best) {
        navY = best.y;
        navM = best.m;
        navLabel.textContent = `${navY}년 ${String(navM + 1).padStart(2, "0")}월`;
      }
    });
  });

  // from/to 입력칸 키보드 편집 — 지우고 숫자 입력해 날짜 지정. (네이버 방식)
  // "YYYY.MM.DD" / "YYYY-M-D" / "YYYYMMDD" 등 허용. 커밋(Enter·포커스 해제) 시 파싱·반영.
  const earliest = new Date(today.getFullYear(), today.getMonth() - MONTHS_BACK, 1);
  function parseTyped(s: string): Date | null {
    let y: number, m: number, d: number;
    const parts = s.split(/[^\d]+/).filter(Boolean);
    if (parts.length >= 3) {
      [y, m, d] = parts.map(Number);
    } else {
      const digits = s.replace(/\D/g, "");
      if (digits.length !== 8) return null;
      y = +digits.slice(0, 4); m = +digits.slice(4, 6); d = +digits.slice(6, 8);
    }
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    // 02.30 같은 무효 날짜 거르기 (롤오버 검출).
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }
  function commitField(field: "start" | "end", input: HTMLInputElement): void {
    let dt = parseTyped(input.value);
    if (!dt) { paint(); return; } // 파싱 실패 → 원래 값 복원
    // 허용 범위로 clamp: 미래 불가(상한 today), 달력 표시 하한.
    if (dt.getTime() > today.getTime()) dt = new Date(today);
    if (dt.getTime() < earliest.getTime()) dt = new Date(earliest);
    activePreset = null;
    if (field === "start") {
      start = dt;
      if (end.getTime() < start.getTime()) end = new Date(start);
    } else {
      end = dt;
      if (end.getTime() < start.getTime()) start = new Date(end);
    }
    paint();
    input.value = fmtDot(field === "start" ? start : end); // focus 중이라 paint가 건너뛴 값 직접 갱신
    scrollToMonth(dt.getFullYear(), dt.getMonth());
  }
  for (const [field, input] of [["start", fieldStart], ["end", fieldEnd]] as const) {
    input.addEventListener("focus", () => { activeField = field; paint(); input.select(); });
    input.addEventListener("blur", () => commitField(field, input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitField(field, input); input.select(); }
    });
  }

  // ── 닫기/확정 ──
  // 옆에 함께 떠 있던 설정/행 메뉴(action menu)도 같이 닫는다 (확인·취소 버튼 경로).
  function finish(): void {
    closeAllOpenDropdowns();
    dispose?.();
  }
  function confirmReport(): void {
    const author = authorInput.value.trim();
    const range: DateRange = { since: iso(start), until: iso(end) };
    if (author) void chrome.storage.local.set({ [AUTHOR_KEY]: author });
    finish();
    opts.onConfirm(range, author);
  }
  el.querySelector(".dvads-rdp-cancel")?.addEventListener("click", finish);
  el.querySelector(".dvads-rdp-confirm")?.addEventListener("click", confirmReport);
  // 담당자명 칸에서 Enter -> 확인과 동일. 핸들러가 없으면 Enter가 호스트 페이지로
  // 전파돼 엉뚱한 동작을 부른다(`e.stopPropagation`). 한글 조합 중 Enter는 무시.
  authorInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      confirmReport();
    }
  });

  // ── mount + 위치 + 리스너 ──
  // ★ anchor 위치는 지금(동기) 캡처한다. 호출원이 keepOpen 메뉴라 onClick 직후 메뉴가
  //   재렌더(populate)되며 클릭된 anchor 버튼이 DOM에서 떨어져 나가, 이후 rAF 시점엔
  //   getBoundingClientRect가 0을 반환하기 때문.
  let anchorRect = opts.anchorRect ?? opts.anchor.getBoundingClientRect();
  document.body.appendChild(el);
  openEl = el;
  const unregister = registerMenuSibling(el);

  function position(): void {
    if (opts.anchor.isConnected) anchorRect = opts.anchor.getBoundingClientRect();
    const r = anchorRect;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 우선 메뉴 왼쪽으로, 공간 없으면 오른쪽.
    let left = r.left - 8 - w;
    if (left < 8) left = r.right + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    let top = r.top;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h);
    if (top < 8) top = 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  paint();
  applyNav();
  // 위치 계산은 layout 확정 후 (rAF).
  requestAnimationFrame(() => {
    position();
    // 초기 스크롤 — 선택 끝 월이 가운데 오게.
    scrollToMonth(end.getFullYear(), end.getMonth());
  });

  // 바깥 클릭/ESC 닫기 (flyout 내부 스크롤은 제외).
  const onDocPointer = (e: MouseEvent | PointerEvent): void => {
    const t = e.target as Node;
    if (el.contains(t) || opts.anchor.contains(t)) return;
    finish();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
  };
  const onWinScroll = (e: Event): void => {
    // 페이지 스크롤이면 닫고, flyout 내부 스크롤은 유지.
    if (e.target instanceof Node && el.contains(e.target)) return;
    finish();
  };
  const onResize = (): void => position();
  setTimeout(() => {
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onWinScroll, true);
    window.addEventListener("resize", onResize);
  }, 0);

  dispose = () => {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onWinScroll, true);
    window.removeEventListener("resize", onResize);
    unregister();
    el.remove();
    if (openEl === el) openEl = null;
    dispose = null;
  };
}
