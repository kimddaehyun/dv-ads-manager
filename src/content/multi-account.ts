/**
 * F-MultiAccount — 다계정 대시보드 (ads.naver.com 페이지 내 오버레이).
 *
 * 동작:
 *   1. `/manage/ad-accounts/` URL에 진입 시 우상단 fixed 버튼 주입
 *   2. 버튼 클릭 → dvads-popover로 광고계정 명단 + 어제 6지표/비즈머니/계약 D-day
 *   3. 행 클릭 → 해당 광고계정 페이지로 SPA 전환
 *   4. 명단은 첫 로드 시 자동 fetch + 캐시 (1일 stale)
 *   5. 모든 계정 데이터는 사용자 페이지 컨텍스트에서 직접 fetch — `x-ad-customer-id` 헤더 +
 *      bmgate URL 조합으로 cross-account 가능 (메모리 `project_naver_cross_account_technique`).
 *      hidden tab/approach/Port 통신 모두 폐기됨 (2026-05-21).
 *   6. popover 진입 시 stale 항목 자동 background refresh (worker pool 4)
 *   7. 옵션 페이지에서 `MULTI_ACCOUNT_REFRESH_DIRECTORY` 메시지 → 디렉터리 강제 갱신
 */

import {
  loadDirectory,
  saveDirectory,
  isDirectoryStale,
  loadAllUserMeta,
  updateUserMeta,
  loadAddedList,
  addAccountToList,
  removeAccountFromList,
  loadSnapshot,
  saveSnapshot,
  isSnapshotFresh,
} from "@/lib/multi-account-storage";
import {
  fetchAllDirectory,
  collectAccount,
  yesterdayKST,
} from "@/lib/multi-account-data";
import type {
  MultiAccountDirectoryCache,
  MultiAccountDirectoryEntry,
  MultiAccountUserMeta,
  MultiAccountSnapshot,
} from "@/types/storage";
import { attachActionMenu, type ActionMenuItem } from "./ui-dropdown";
import { openInputDialog } from "./input-dialog";

const ADACCT_URL_PATTERN = /\/manage\/ad-accounts\//;
const BTN_MARK = "data-dvads-multi-btn";

let buttonEl: HTMLButtonElement | null = null;
let lastButtonContainer: HTMLElement | null = null;
let popoverEl: HTMLDivElement | null = null;
let directoryFetchInFlight: Promise<void> | null = null;

export function initMultiAccount() {
  // 동일 origin에서 두 번 초기화되면 listener 중복 등록 방지
  const w = window as unknown as { __dvadsMultiAccountInit?: boolean };
  if (w.__dvadsMultiAccountInit) return;
  w.__dvadsMultiAccountInit = true;

  registerMessageListener();
  registerStorageListener();

  let lastUrl = location.href;
  const onTick = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // 자연 캐싱: 다른 계정 페이지 진입 시 그 계정 데이터를 자동 캐싱.
      // 사용자가 어차피 그 계정 보러 왔으니 백그라운드 탭 없이 직접 fetch.
      void autoUpdateActiveAccount();
    }
    // 매 tick: 헤더 칩 옆에 버튼 살아있는지 확인. SPA가 헤더 다시 그리면 re-mount.
    syncMount();
  };
  setInterval(onTick, 300);
  window.addEventListener("popstate", () => {
    lastUrl = location.href;
    syncMount();
    void autoUpdateActiveAccount();
  });
  window.addEventListener("resize", syncMount);

  // 첫 페이지 진입 시 디렉터리 자동 갱신 + 마운트
  void ensureDirectoryFresh();
  syncMount();
  // 첫 진입 시 활성 계정 자연 캐싱
  void autoUpdateActiveAccount();
}

/**
 * 자연 캐싱 — 사용자가 광고관리자에서 특정 계정 페이지에 진입할 때마다
 * 그 계정 데이터를 자동으로 캐시 갱신. directory에서 customerId 찾아 직접 fetch.
 */
async function autoUpdateActiveAccount() {
  const activeNo = extractActiveAdAccountNo();
  if (activeNo === null) return;
  // stale 체크 — 신선한 캐시가 있으면 굳이 다시 안 부름
  const cached = await loadSnapshot(activeNo);
  if (cached && isSnapshotFresh(cached)) return;
  const dir = await loadDirectory();
  const entry = dir?.entries.find((e) => e.adAccountNo === activeNo);
  if (!entry?.masterCustomerId) return; // directory가 아직 안 받아왔거나 customerId 없는 계정 — skip
  try {
    const payload = await collectAccount(activeNo, entry.masterCustomerId, yesterdayKST());
    const snap: MultiAccountSnapshot = {
      adAccountNo: activeNo,
      bizMoney: payload.bizMoney,
      yesterday: payload.yesterday,
      contracts: payload.contracts,
      fetched_at: new Date().toISOString(),
    };
    await saveSnapshot(snap);
    if (popoverEl) {
      const all = await loadAllUserMeta();
      paintRow(activeNo, snap, all[activeNo]);
    }
    void refreshBadge();
  } catch (e) {
    console.warn("[dv-ads/multi-account] 자연 캐싱 실패", e);
  }
}

function registerMessageListener() {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    const t = (msg as { type?: string }).type;
    if (t === "MULTI_ACCOUNT_REFRESH_DIRECTORY") {
      void (async () => {
        try {
          const entries = await fetchAllDirectory();
          const cache: MultiAccountDirectoryCache = {
            fetched_at: new Date().toISOString(),
            entries,
          };
          await saveDirectory(cache);
          sendResponse({ ok: true, count: entries.length });
        } catch (e) {
          sendResponse({ ok: false, error: friendlyMessage(e) });
        }
      })();
      return true;
    }
    if (t === "PING") {
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
}

async function ensureDirectoryFresh() {
  if (directoryFetchInFlight) return directoryFetchInFlight;
  // in-flight Promise를 *await 전에* 즉시 잠근다. 그렇지 않으면 loadDirectory 대기 중에
  // 두 번째 호출이 들어와 둘 다 fetch를 시작하는 race가 발생.
  directoryFetchInFlight = (async () => {
    try {
      const existing = await loadDirectory();
      if (existing && !isDirectoryStale(existing)) return;
      const entries = await fetchAllDirectory();
      await saveDirectory({ fetched_at: new Date().toISOString(), entries });
    } catch (e) {
      console.warn("[dv-ads/multi-account] directory fetch 실패", e);
    } finally {
      directoryFetchInFlight = null;
    }
  })();
  return directoryFetchInFlight;
}

/**
 * F-PoP `mountButton` 패턴과 동일하게 — 페이지 헤더 DOM에 직접 inject.
 * `position: fixed` 안 쓰고 광고계정 칩의 좌측 형제 노드로 들어가 자연스럽게 정렬.
 * SPA가 헤더 다시 그리면 우리 버튼이 사라질 수 있어 매 tick(300ms) 살아있는지 확인 → re-mount.
 */
function syncMount() {
  const isTopWindow = window === window.top;
  const shouldMount = isTopWindow && ADACCT_URL_PATTERN.test(location.pathname);
  if (!shouldMount) {
    unmountButton();
    return;
  }
  const chip = findOperationChip();
  if (!chip || !chip.parentElement) {
    // 헤더가 아직 로딩 중 → 마운트 보류 (버튼 자체 미존재)
    unmountButton();
    return;
  }
  // 이미 같은 컨테이너에 살아있으면 skip
  if (
    buttonEl &&
    buttonEl.isConnected &&
    lastButtonContainer === chip.parentElement
  ) {
    return;
  }
  // 다른 컨테이너로 갈렸을 가능성 → 정리
  unmountButton();
  // 페이지에 stray 버튼 남아있으면 제거 (재mount race)
  chip.parentElement.querySelectorAll(`button[${BTN_MARK}]`).forEach((el) => el.remove());

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dvads dvads-multi-btn";
  btn.setAttribute(BTN_MARK, "1");
  btn.setAttribute("aria-label", "광고계정 명단");
  btn.title = "광고계정 명단";
  // 모핑 햄버거 → close 아이콘. open 시 .is-open 클래스로 토글되면 CSS가 회전 + stroke-dasharray로
  // 햄버거 두 줄 → X 형태로 부드럽게 전환. viewBox 0 0 32 32 기준이라 width/height만 조절.
  btn.innerHTML =
    '<svg class="dvads-multi-btn-icon" width="18" height="18" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path class="dvads-multi-btn-icon-morph" d="M27 10 13 10C10.8 10 9 8.2 9 6 9 3.5 10.8 2 13 2 15.2 2 17 3.8 17 6L17 26C17 28.2 18.8 30 21 30 23.2 30 25 28.2 25 26 25 23.8 23.2 22 21 22L7 22"/>' +
    '<path d="M7 16 27 16"/>' +
    "</svg>";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popoverEl) closePopover();
    else void openPopover();
  });

  // iOS 스타일 알림 배지 — 사용자가 설정한 임계값(비즈머니/브랜드검색) 알림 카운트.
  // 초기엔 숨겨두고 refreshBadge가 카운트>0일 때 노출.
  const badge = document.createElement("span");
  badge.className = "dvads-multi-btn-badge";
  badge.setAttribute("aria-hidden", "true");
  badge.style.display = "none";
  btn.appendChild(badge);

  chip.parentElement.insertBefore(btn, chip);
  buttonEl = btn;
  lastButtonContainer = chip.parentElement;
  void refreshBadge();
}

function unmountButton() {
  closePopover();
  if (buttonEl && buttonEl.isConnected) buttonEl.remove();
  buttonEl = null;
  lastButtonContainer = null;
}

/**
 * "운영 관리" 텍스트를 가진 헤더 칩 element 탐색.
 * 광고관리자 SPA 헤더에 광고계정명 + 운영 관리 dropdown 칩이 항상 있어 휴리스틱으로 사용.
 * 텍스트 walker는 헤더 영역(top < 100px)만 검사해 비용 최소화.
 */
function findOperationChip(): HTMLElement | null {
  const cached = document.querySelector<HTMLElement>("[data-dvads-op-chip]");
  if (cached) {
    const r = cached.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top < 120) return cached;
    cached.removeAttribute("data-dvads-op-chip");
  }
  // 상단 영역에 있는 후보 element만 검사. naver SPA 헤더의 "운영 관리" 텍스트는 항상 span에
  // 들어있으므로 candidate를 span으로 좁힘 — 대형 페이지(수천 노드)에서 매 tick 비용 절감.
  const candidates = document.querySelectorAll<HTMLElement>("span");
  for (const el of candidates) {
    if (el === buttonEl) continue;
    if (el.children.length > 0) continue; // leaf만
    const text = (el.textContent ?? "").trim();
    if (text !== "운영 관리") continue;
    let chipParent: HTMLElement | null = el.parentElement;
    for (let i = 0; i < 6 && chipParent; i++, chipParent = chipParent.parentElement) {
      const r = chipParent.getBoundingClientRect();
      if (r.top >= 120 || r.top < 0) break;
      // 광고계정명 + "운영 관리"가 함께 들어있는 wrapper는 가로 100~500px 사이
      if (r.width >= 100 && r.width <= 500 && r.height >= 20 && r.height <= 60) {
        chipParent.setAttribute("data-dvads-op-chip", "1");
        return chipParent;
      }
    }
    // wrapper 못 찾으면 텍스트 부모 자체 반환
    if (el.parentElement) {
      el.parentElement.setAttribute("data-dvads-op-chip", "1");
      return el.parentElement;
    }
  }
  return null;
}

async function openPopover() {
  closePopover();
  popoverView = "list"; // 매번 list view로 시작
  const wrap = document.createElement("div");
  wrap.className = "dvads dvads-popover dvads-multi-popover";
  wrap.style.position = "fixed";
  wrap.style.zIndex = "2147483647";
  applyAnchoredPosition(wrap);
  wrap.innerHTML = `<div class="dvads-multi-loading">불러오는 중…</div>`;
  document.body.appendChild(wrap);
  popoverEl = wrap;
  // 초기 view("list")의 폭으로 시작. switchView가 search로 가면 더 좁혀짐.
  applyPopoverWidth(popoverView);

  // popover-attached 보조 모달이 열려있는지 — 이름 수정 등. 이게 떠 있을 동안엔
  // 외부 클릭/ESC가 popover를 닫지 않도록 모든 dismiss 트리거를 가드.
  const auxModalOpen = (): boolean =>
    !!document.querySelector(".dvads-rename-backdrop");
  const inAuxModal = (t: Node): boolean =>
    !!document.querySelector(".dvads-rename-backdrop")?.contains(t);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      // 보조 모달이 떠 있으면 모달 자체 핸들러에 맡김. popover 닫지 않음.
      if (auxModalOpen()) return;
      closePopover();
    }
  };
  // popover 안에서 시작한 mousedown 추적 — 드래그하다가 밖에서 release하면 click이
  // 외부에서 발화해서 popover를 닫아버리는 사고 방지. mousedown 시작점이 popover 내부면
  // 그 다음 click 1번은 outside-close에서 면제한다.
  let mousedownInsidePopover = false;
  const onMouseDown = (e: MouseEvent) => {
    if (!popoverEl) return;
    const t = e.target as Node;
    mousedownInsidePopover =
      popoverEl.contains(t) ||
      (buttonEl?.contains(t) ?? false) ||
      inAuxModal(t);
  };
  const onClickOutside = (e: MouseEvent) => {
    if (!popoverEl) return;
    // 드래그 release면 (시작점이 popover 내부) 이번 click은 무시
    if (mousedownInsidePopover) {
      mousedownInsidePopover = false;
      return;
    }
    if (popoverEl.contains(e.target as Node)) return;
    if (buttonEl?.contains(e.target as Node)) return;
    // 보조 모달(이름 수정 등) 내부 클릭은 popover 외부지만 닫지 않음.
    if (inAuxModal(e.target as Node)) return;
    closePopover();
  };
  document.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onMouseDown, true);
  // 같은 클릭이 listener에 잡히지 않도록 다음 tick부터 등록
  setTimeout(() => document.addEventListener("click", onClickOutside), 0);
  (wrap as unknown as { __cleanup: () => void }).__cleanup = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("click", onClickOutside);
  };

  // 햄버거 → close 아이콘 모핑 트리거 (CSS transition)
  buttonEl?.classList.add("is-open");

  await renderPopoverBody(wrap);
}

function closePopover() {
  if (!popoverEl) return;
  const cleanup = (popoverEl as unknown as { __cleanup?: () => void }).__cleanup;
  cleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverView = "list";
  listSearchQuery = "";
  popoverFullscreen = false;
  document.querySelector(".dvads-multi-backdrop")?.remove();
  selectedAccountNos.clear();
  // close 아이콘 → 햄버거로 복귀
  buttonEl?.classList.remove("is-open");
}

type PopoverView = "list" | "search";
let popoverView: PopoverView = "list";

// 내 계정(list view) 검색 쿼리 — 추가된 계정만 필터링. 행 DOM은 그대로 두고
// display:none 토글로 visibility 제어 → 입력 중 focus 유지. popover 닫힐 때 초기화.
let listSearchQuery = "";

// 다중 선택 상태 — 체크박스로 선택한 계정 번호 집합. 두 view 공유 안 함 (view 전환 시 초기화).
// 헤더 우측 "설정 (N)" 버튼이 N=size를 표시하고, 클릭 시 일괄 액션 메뉴 노출.
const selectedAccountNos = new Set<number>();

// 크게 보기(전체화면 모달) 모드. 평소엔 anchored popover(640px)로 4컬럼만 노출,
// 사용자가 kebab에서 "크게 보기" 선택 시 viewport-사이즈 modal로 진입 + 모든 컬럼 + 회색 backdrop.
// ESC/backdrop click으로 종료 = popover 자체 종료 (단순). 두 view 공통.
let popoverFullscreen = false;

async function renderPopoverBody(wrap: HTMLElement) {
  if (popoverView === "search") {
    await renderSearchView(wrap);
    return;
  }
  await renderListView(wrap);
}

/**
 * Vercel Tabs 패턴 — 두 탭(내 계정 / 전체 계정) + 슬라이딩 active underline + hover 하이라이트.
 * 같은 popover 안에서 view 전환용. 클릭 시 switchView 호출 후 view 재렌더 — 새 탭바가 다시
 * 빌드되며 새 active 위치로 indicator 스냅.
 *
 * indicator/hover layer는 absolute positioning + offsetLeft/offsetWidth 기반으로 slide.
 * 초기 위치는 rAF로 layout 후 계산해야 정확.
 */
function buildTabsBar(activeView: PopoverView): HTMLElement {
  const container = document.createElement("div");
  container.className = "dvads-multi-tabs";
  container.innerHTML = `
    <div class="dvads-multi-tabs-list">
      <div class="dvads-multi-tabs-hover" aria-hidden="true"></div>
      <div class="dvads-multi-tabs-indicator" aria-hidden="true"></div>
      <button type="button" class="dvads-multi-tab-item${activeView === "list" ? " is-active" : ""}" data-view="list">내 계정</button>
      <button type="button" class="dvads-multi-tab-item${activeView === "search" ? " is-active" : ""}" data-view="search">전체 계정</button>
    </div>
  `;

  const items = container.querySelectorAll<HTMLButtonElement>(".dvads-multi-tab-item");
  const indicator = container.querySelector<HTMLElement>(".dvads-multi-tabs-indicator")!;
  const hover = container.querySelector<HTMLElement>(".dvads-multi-tabs-hover")!;

  const positionIndicator = (el: HTMLElement) => {
    indicator.style.left = `${el.offsetLeft}px`;
    indicator.style.width = `${el.offsetWidth}px`;
  };

  // 초기 active 위치 — layout 끝나고 offsetLeft/Width 계산 (rAF).
  requestAnimationFrame(() => {
    const active = container.querySelector<HTMLElement>(".dvads-multi-tab-item.is-active");
    if (active) positionIndicator(active);
  });

  items.forEach((item) => {
    item.addEventListener("mouseenter", () => {
      hover.style.left = `${item.offsetLeft}px`;
      hover.style.width = `${item.offsetWidth}px`;
      hover.style.opacity = "1";
    });
    item.addEventListener("mouseleave", () => {
      hover.style.opacity = "0";
    });
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      const view = item.dataset.view as PopoverView | undefined;
      if (!view || view === activeView) return;
      // 즉각 시각 피드백 — switchView await 동안 indicator/text가 새 위치로 슬라이드.
      items.forEach((i) => i.classList.toggle("is-active", i === item));
      positionIndicator(item);
      void switchView(view);
    });
  });

  return container;
}

type SortKey =
  | "name"
  | "impressions"
  | "clicks"
  | "ctr"
  | "cpc"
  | "cost"
  | "revenue"
  | "conversions"
  | "roas"
  | "bizMoney";
type SortDir = "asc" | "desc";
let sortState: { key: SortKey; dir: SortDir } = { key: "name", dir: "asc" };

const COLUMN_DEFS: { key: SortKey; label: string; numeric: boolean }[] = [
  { key: "name", label: "계정", numeric: false },
  { key: "bizMoney", label: "비즈머니", numeric: true },
  { key: "impressions", label: "노출수", numeric: true },
  { key: "clicks", label: "클릭수", numeric: true },
  { key: "ctr", label: "클릭률", numeric: true },
  { key: "cpc", label: "CPC", numeric: true },
  { key: "cost", label: "총비용", numeric: true },
  { key: "revenue", label: "매출", numeric: true },
  { key: "conversions", label: "전환수", numeric: true },
  { key: "roas", label: "ROAS", numeric: true },
];

// 정렬 rapid 클릭 / 빠른 뷰 전환에서 마지막에 시작된 render만 화면을 덮어쓰도록 token 사용.
// 매 호출이 token을 증가시키고, await 후 본인 token이 최신인지 체크 — 아니면 조용히 포기.
let renderListViewToken = 0;

async function renderListView(wrap: HTMLElement) {
  const token = ++renderListViewToken;
  // ─── 1단계: 모든 데이터 비동기 로드 (DOM 손대지 않음) ───
  // 이전엔 wrap.innerHTML="" 후 await loadSnapshot 했더니 그 사이 popover가 빈 상태로 깜빡임.
  // 모든 await을 *먼저* 끝낸 뒤 메모리에 새 DOM을 빌드 → 마지막에 단 한 번 replaceChildren으로
  // atomic swap. 기존 콘텐츠는 새 콘텐츠 준비 완료 시점까지 그대로 유지된다.
  const [dir, meta, addedList] = await Promise.all([
    loadDirectory(),
    loadAllUserMeta(),
    loadAddedList(),
  ]);
  if (token !== renderListViewToken) return;
  const entries = pickAddedEntries(dir?.entries ?? [], addedList);
  const snapshots = await Promise.all(entries.map((e) => loadSnapshot(e.adAccountNo)));
  if (token !== renderListViewToken) return;
  const sorted = sortEntries(entries, snapshots, meta, sortState);

  // ─── 2단계: 메모리에 새 DOM 트리 빌드 ───
  const fragment = document.createDocumentFragment();

  // 헤더 = 탭바(좌) + 검색 wrap + ⋮ kebab 메뉴(우). 옛 설정/펼치기/↻ 버튼은 kebab 안으로 흡수.
  const hdr = document.createElement("div");
  hdr.className = "dvads-multi-hdr";
  hdr.appendChild(buildTabsBar("list"));
  const actions = document.createElement("div");
  actions.className = "dvads-multi-hdr-actions";
  actions.appendChild(buildSearchInput("list"));
  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "dvads-multi-settings-btn";
  settingsBtn.textContent = "설정";
  actions.appendChild(settingsBtn);
  hdr.appendChild(actions);
  fragment.appendChild(hdr);

  attachActionMenu({
    trigger: settingsBtn,
    ariaLabel: "내 계정 메뉴",
    // 함수형 — open할 때마다 다시 빌드해서 선택 상태(disabled 등) 반영.
    items: () => listKebabItems(entries),
  });

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dvads-multi-empty";
    empty.innerHTML = `
      <p>아직 추가된 광고계정이 없어요.</p>
      <p class="dvads-multi-empty-sub">자주 보는 광고계정을 추가하면 여기에 데이터가 표시됩니다.</p>
      <button class="dvads-multi-empty-cta" type="button">+ 광고계정 추가</button>
    `;
    fragment.appendChild(empty);
    empty.querySelector<HTMLButtonElement>(".dvads-multi-empty-cta")?.addEventListener("click", () => {
      switchView("search");
    });
    wrap.replaceChildren(fragment);
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "dvads-multi-table-wrap";
  const table = document.createElement("table");
  table.className = "dvads-bid-table dvads-multi-table" + (popoverFullscreen ? "" : " is-collapsed");
  table.innerHTML = `
    <thead><tr>
      <th class="dvads-multi-th-cb">${checkboxHTML(false, "전체 선택", "dvads-multi-cb-all")}</th>
      ${COLUMN_DEFS.map((c) => {
        const numCls = c.numeric ? "dvads-multi-th-num" : "";
        const active = sortState.key === c.key;
        const dirCls = active ? (sortState.dir === "asc" ? "is-asc" : "is-desc") : "";
        // chevron SVG — 위쪽 화살표 path. CSS에서 is-desc일 때 rotate(180deg)로 아래로 뒤집어
        // asc/desc 모두 같은 path 재사용. 비활성 컬럼은 sortInd 자체가 비어 깔끔.
        const sortInd = active
          ? '<svg class="dvads-multi-sort-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10 L8 6 L12 10"/></svg>'
          : "";
        return `<th class="dvads-multi-th-sort ${numCls} ${dirCls}" data-sort-key="${c.key}">
          <span>${c.label}</span><span class="dvads-multi-sort-ind">${sortInd}</span>
        </th>`;
      }).join("")}
      <th class="dvads-multi-th-act">작업</th>
    </tr></thead>
    <tbody></tbody>
  `;
  // 헤더 정렬 클릭
  table.querySelectorAll<HTMLTableCellElement>("th.dvads-multi-th-sort").forEach((th) => {
    th.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = th.dataset.sortKey as SortKey | undefined;
      if (!key) return;
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState = { key, dir: key === "name" ? "asc" : "desc" };
      }
      void renderListView(wrap);
    });
  });

  const tbody = table.querySelector("tbody")!;
  for (const { entry } of sorted) {
    const tr = renderTableRow(entry, meta[entry.adAccountNo]);
    tbody.appendChild(tr);
  }
  tableWrap.appendChild(table);
  fragment.appendChild(tableWrap);

  // ─── 3단계: 단일 atomic swap. 깜빡임 0 ───
  // swap 직전 마지막 token 체크 — 빌드 중 rapid 클릭으로 더 새 render가 시작됐다면 포기.
  if (token !== renderListViewToken) return;
  wrap.replaceChildren(fragment);

  // ─── 4단계: paint (이제 table이 popoverEl 서브트리에 있어 findRow 동작) ───
  for (const { entry, snap } of sorted) {
    if (snap) paintRow(entry.adAccountNo, snap, meta[entry.adAccountNo]);
    else paintRowEmpty(entry.adAccountNo);
  }
  void refreshBadge();

  // 기존 검색 쿼리가 있으면(예: sort 변경 후 재렌더) 적용.
  if (listSearchQuery) applyListSearchFilter(wrap, listSearchQuery);

  // select-all 헤더 체크박스 wire + 초기 UI(설정 버튼 라벨/select-all 상태) 동기화.
  wireSelectAll(wrap);
  updateBulkActionUI(wrap);

  // 백그라운드 stale refresh — 화면은 캐시로 즉시 표시되었고, TTL 지난 행만 silent
  // refresh. force:false라 fresh 행은 자동 skip. 결과 도착하는 대로 paintRow가 행 업데이트.
  // popover 닫혀도 fetch는 끝까지 진행되어 다음 진입 시 fresh 캐시 보장.
  void backgroundRefreshStale(entries, snapshots);
}

/**
 * 추가된 계정 명단 안에서 substring 필터 적용. 행 DOM을 재빌드하지 않고 display:none 토글
 * → input focus/cursor 유지. tr.dataset.searchHaystack(renderTableRow에서 세팅)을 활용.
 */
function applyListSearchFilter(wrap: HTMLElement, query: string): void {
  const q = query.trim().toLowerCase();
  const rows = wrap.querySelectorAll<HTMLTableRowElement>("tr.dvads-multi-tr");
  rows.forEach((row) => {
    const hay = row.dataset.searchHaystack || "";
    const match = !q || hay.includes(q);
    row.style.display = match ? "" : "none";
  });
}

/**
 * popover 진입 시 호출. stale snapshot(혹은 없는 행)만 골라 worker 풀로 동시 N개 갱신.
 * force:false라 매 호출이 다시 한번 fresh 체크 (race로 다른 경로가 먼저 갱신한 경우 skip).
 * 사용자가 ↻ 전체 누르는 것과 다른 점: 버튼 라벨 업데이트 없고, 묵묵히 진행.
 *
 * popover를 빠르게 reopen하면 이전 호출이 끝나기 전에 새 호출이 들어와 worker pool이
 * 중복 실행될 수 있다. in-flight 플래그로 한 사이클이 끝날 때까지 새 시작 차단.
 */
let backgroundRefreshStaleInFlight = false;

async function backgroundRefreshStale(
  entries: MultiAccountDirectoryEntry[],
  snapshots: (MultiAccountSnapshot | null)[],
): Promise<void> {
  if (backgroundRefreshStaleInFlight) return;
  const activeNo = extractActiveAdAccountNo();
  const stale: MultiAccountDirectoryEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const snap = snapshots[i];
    if (!snap || !isSnapshotFresh(snap)) stale.push(entries[i]);
  }
  if (stale.length === 0) return;
  backgroundRefreshStaleInFlight = true;
  try {
    const queue = [...stale];
    const workers = Array.from(
      { length: Math.min(REFRESH_ALL_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length > 0) {
          const entry = queue.shift();
          if (!entry) break;
          try {
            await refreshRow(entry, activeNo, { force: false });
          } catch (e) {
            console.warn("[content/multi-account] background refresh 실패", entry.adAccountNo, e);
          }
        }
      },
    );
    await Promise.all(workers);
  } finally {
    backgroundRefreshStaleInFlight = false;
  }
}

function sortEntries(
  entries: MultiAccountDirectoryEntry[],
  snapshots: (MultiAccountSnapshot | null)[],
  meta: Record<number, MultiAccountUserMeta>,
  state: { key: SortKey; dir: SortDir },
): { entry: MultiAccountDirectoryEntry; snap: MultiAccountSnapshot | null }[] {
  const pairs = entries.map((e, i) => ({ entry: e, snap: snapshots[i] }));
  pairs.sort((a, b) => {
    const cmp = compareByKey(a, b, state.key, meta);
    return state.dir === "asc" ? cmp : -cmp;
  });
  return pairs;
}

function compareByKey(
  a: { entry: MultiAccountDirectoryEntry; snap: MultiAccountSnapshot | null },
  b: { entry: MultiAccountDirectoryEntry; snap: MultiAccountSnapshot | null },
  key: SortKey,
  meta: Record<number, MultiAccountUserMeta>,
): number {
  if (key === "name") {
    const an = (meta[a.entry.adAccountNo]?.displayName || a.entry.name).toLowerCase();
    const bn = (meta[b.entry.adAccountNo]?.displayName || b.entry.name).toLowerCase();
    return an.localeCompare(bn);
  }
  if (key === "bizMoney") {
    const av = a.snap?.bizMoney ?? -Infinity;
    const bv = b.snap?.bizMoney ?? -Infinity;
    return av - bv;
  }
  const av = a.snap?.yesterday ? Number(a.snap.yesterday[key as keyof typeof a.snap.yesterday] ?? 0) : -Infinity;
  const bv = b.snap?.yesterday ? Number(b.snap.yesterday[key as keyof typeof b.snap.yesterday] ?? 0) : -Infinity;
  return av - bv;
}

/**
 * 검색 화면 — 같은 popover 안에서 view 전환. 헤더에 뒤로가기, 검색 input.
 * 리스트 행: 추가된 계정은 "추가됨" + 삭제 + 별칭 편집 버튼. 안 된 계정은 [+ 추가] 버튼.
 */
async function renderSearchView(wrap: HTMLElement) {
  // renderListView와 동일 패턴 — 비동기 로드 먼저, 메모리에 fragment 빌드, 마지막에 atomic swap.
  // wrap.innerHTML="" 후 await하던 이전 코드는 그 사이 빈 popover가 노출되어 깜빡임.
  const [dir, meta, addedList] = await Promise.all([
    loadDirectory(),
    loadAllUserMeta(),
    loadAddedList(),
  ]);
  const addedSet = new Set(addedList);
  const all = (dir?.entries ?? [])
    .filter((e) => e.adPlatformType === "SA" && !e.disabled && !e.deleted)
    .sort((a, b) => (b.lastAccessTime ?? "").localeCompare(a.lastAccessTime ?? ""));

  const fragment = document.createDocumentFragment();

  // 헤더 = 탭바(좌) + 검색 wrap + ⋮ kebab. list view와 동일 레이아웃, items만 다름.
  const hdr = document.createElement("div");
  hdr.className = "dvads-multi-hdr";
  hdr.appendChild(buildTabsBar("search"));
  const actions = document.createElement("div");
  actions.className = "dvads-multi-hdr-actions";
  const searchWrap = buildSearchInput("search");
  actions.appendChild(searchWrap);
  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "dvads-multi-settings-btn";
  settingsBtn.textContent = "설정";
  actions.appendChild(settingsBtn);
  hdr.appendChild(actions);
  fragment.appendChild(hdr);
  const input = searchWrap.querySelector<HTMLInputElement>(".dvads-multi-search-input")!;

  attachActionMenu({
    trigger: settingsBtn,
    ariaLabel: "전체 계정 메뉴",
    items: () => searchKebabItems(),
  });

  // 테이블 구조 — list view와 동일 .dvads-multi-table 베이스. thead는 sticky로 스크롤 시 고정.
  // 검색 view 컬럼: [cb][계정][상태][ID][작업]. 상태는 roleName(MASTER/OPERATOR/...)을 한글 매핑.
  const tableWrap = document.createElement("div");
  tableWrap.className = "dvads-multi-table-wrap";
  const table = document.createElement("table");
  table.className = "dvads-bid-table dvads-multi-table dvads-multi-search-table";
  table.innerHTML = `
    <thead><tr>
      <th class="dvads-multi-th-cb">${checkboxHTML(false, "전체 선택", "dvads-multi-cb-all")}</th>
      <th class="dvads-multi-th-search-name">계정</th>
      <th class="dvads-multi-th-search-id">ID</th>
      <th class="dvads-multi-th-search-status">상태</th>
      <th class="dvads-multi-th-act">작업</th>
    </tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody")!;
  tableWrap.appendChild(table);
  fragment.appendChild(tableWrap);

  const renderList = (query: string) => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? all.filter((e) => {
          const alias = meta[e.adAccountNo]?.displayName?.toLowerCase() ?? "";
          return (
            e.name.toLowerCase().includes(q) ||
            String(e.adAccountNo).includes(q) ||
            alias.includes(q)
          );
        })
      : all;
    tbody.innerHTML = "";
    if (filtered.length === 0) {
      tbody.innerHTML = `<tr class="dvads-multi-search-empty-row"><td colspan="5" class="dvads-multi-search-empty">검색 결과가 없어요.</td></tr>`;
      if (popoverEl) updateBulkActionUI(popoverEl);
      return;
    }
    for (const entry of filtered) {
      tbody.appendChild(renderSearchRow(entry, meta[entry.adAccountNo], addedSet));
    }
    if (popoverEl) updateBulkActionUI(popoverEl);
  };

  renderList("");
  input.addEventListener("input", () => renderList(input.value));
  // atomic swap — fragment 빌드 완료 후 한 번에 popover에 mount.
  wrap.replaceChildren(fragment);
  // select-all 헤더 체크박스 wire + 초기 헤더 동기화.
  wireSelectAll(wrap);
  updateBulkActionUI(wrap);
  setTimeout(() => input.focus(), 30);
}

// 광고관리자 권한 코드 → 사용자 친화 한글 라벨. 네이버 호스트 페이지(`광고 계정` 모달)와 동일한 표기.
// MASTER/OWNER는 대행사 컨텍스트에서 위임 운영 권한 — 네이버 라벨 "운영 관리".
const ROLE_LABEL: Record<string, string> = {
  MASTER: "운영 관리",
  OWNER: "운영 관리",
  MANAGER: "관리자",
  OPERATOR: "운영 관리",
  VIEWER: "조회",
  READ_ONLY: "조회",
  READONLY: "조회",
  READ_WRITE: "편집",
  WRITE: "편집",
  ADMIN: "관리자",
};
function roleLabel(roleName: string | undefined): string {
  if (!roleName) return "-";
  return ROLE_LABEL[roleName] ?? roleName;
}

function renderSearchRow(
  entry: MultiAccountDirectoryEntry,
  meta: MultiAccountUserMeta | undefined,
  addedSet: Set<number>,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "dvads-multi-tr";
  tr.dataset.adAccountNo = String(entry.adAccountNo);
  tr.dataset.searchHaystack = (
    `${entry.name} ${entry.adAccountNo} ${meta?.displayName ?? ""}`
  ).toLowerCase();

  const isAdded = addedSet.has(entry.adAccountNo);
  if (isAdded) tr.classList.add("is-added");
  const displayName = meta?.displayName?.trim() || entry.name;

  tr.innerHTML = `
    <td class="dvads-multi-td-cb">${checkboxHTML(false, `${displayName} 선택`)}</td>
    <td class="dvads-multi-td-name">
      <div class="dvads-multi-name" title="${escapeHtml(entry.name)}">${escapeHtml(displayName)}</div>
      ${meta?.displayName ? `<div class="dvads-multi-no">${escapeHtml(entry.name)}</div>` : ""}
    </td>
    <td class="dvads-multi-td-id">${entry.adAccountNo}</td>
    <td class="dvads-multi-td-status">${escapeHtml(roleLabel(entry.roleName))}</td>
    <td class="dvads-multi-td-act">
      <button class="dvads-multi-action-trigger" type="button" aria-label="작업 메뉴">⋯</button>
    </td>
  `;

  wireRowCheckbox(tr, entry.adAccountNo);

  // 행 click → 체크박스 토글. 액션 트리거/체크박스 자체는 제외(각자 핸들러).
  // 내 계정과 달리 이름 셀 별도 클릭 없음 (전체 계정 view에선 바로가기가 메뉴 항목에 있음).
  tr.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.closest(".dvads-multi-action-trigger")) return;
    if (t.closest(".dvads-multi-cb")) return;
    const cb = tr.querySelector<HTMLInputElement>(".dvads-multi-cb input");
    if (cb) {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    }
  });

  const actionTrigger = tr.querySelector<HTMLButtonElement>(".dvads-multi-action-trigger");
  if (actionTrigger) {
    attachActionMenu({
      trigger: actionTrigger,
      ariaLabel: `${displayName} 작업 메뉴`,
      // 함수형 — 열 때마다 최신 addedSet 기반으로 항목 결정(추가/삭제 후 다음 열림에 반영).
      items: () => searchRowActionItems(entry, addedSet, tr),
    });
  }

  return tr;
}

// 검색 행 작업 메뉴 — 추가 여부에 따라 항목 다름. 사용자 요구사항:
//   미추가: 계정 추가 / 바로가기
//   추가됨: 이름 변경 / 바로가기 / 삭제
function searchRowActionItems(
  entry: MultiAccountDirectoryEntry,
  addedSet: Set<number>,
  tr: HTMLTableRowElement,
): ActionMenuItem[] {
  const isAdded = addedSet.has(entry.adAccountNo);
  const goTo = () => {
    // anchor click 패턴 — window.open 차단 회피, 사용자 제스처 직결로 새 탭 안정적 오픈.
    const url = `/manage/ad-accounts/${entry.adAccountNo}/sa/campaigns-by/WEB_SITE`;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  };
  const items: ActionMenuItem[] = [];
  // 순서: 바로가기 → (이름 수정 / 계정 추가) → 삭제. 사용자 빈도 순 + 파괴적 액션은 맨 아래.
  items.push({ label: "바로가기", onClick: goTo });
  if (isAdded) {
    items.push({
      label: "이름 수정",
      onClick: () => openRenameDialog(entry, () => replaceSearchRow(tr, entry, addedSet)),
    });
  } else {
    items.push({
      label: "계정 추가",
      onClick: () => {
        void (async () => {
          const next = await addAccountToList(entry.adAccountNo);
          addedSet.clear();
          next.forEach((n) => addedSet.add(n));
          await replaceSearchRow(tr, entry, addedSet);
        })();
      },
    });
  }
  if (isAdded) {
    items.push({
      label: "삭제",
      danger: true,
      onClick: () => {
        void (async () => {
          const next = await removeAccountFromList(entry.adAccountNo);
          addedSet.clear();
          next.forEach((n) => addedSet.add(n));
          await replaceSearchRow(tr, entry, addedSet);
        })();
      },
    });
  }
  return items;
}

async function replaceSearchRow(
  tr: HTMLTableRowElement,
  entry: MultiAccountDirectoryEntry,
  addedSet: Set<number>,
) {
  const meta = await loadAllUserMeta();
  const newRow = renderSearchRow(entry, meta[entry.adAccountNo], addedSet);
  tr.replaceWith(newRow);
}

// 내 계정 list view 행 재렌더 — 별칭 변경 후 fresh 데이터로 갈아끼움. 이후 paintRow로 지표 복원.
async function replaceListRow(
  tr: HTMLTableRowElement,
  entry: MultiAccountDirectoryEntry,
) {
  const [meta, snap] = await Promise.all([
    loadAllUserMeta(),
    loadSnapshot(entry.adAccountNo),
  ]);
  const newRow = renderTableRow(entry, meta[entry.adAccountNo]);
  tr.replaceWith(newRow);
  if (snap) paintRow(entry.adAccountNo, snap, meta[entry.adAccountNo]);
  else paintRowEmpty(entry.adAccountNo);
}

// 이름 수정 모달 — 배경 dim + 중앙 카드. inline edit(table colspan)이 컬럼 reflow 이슈가
// 있어 별도 모달로 전환. backdrop click/ESC/취소로 닫힘, 저장 시 updateUserMeta + replaceRow.
function openRenameDialog(
  entry: MultiAccountDirectoryEntry,
  replaceRow: () => Promise<void>,
): void {
  closeRenameDialog();
  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-rename-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-rename-card";
  card.innerHTML = `
    <div class="dvads-rename-title">이름 수정</div>
    <div class="dvads-rename-input-wrap">
      <input class="dvads-rename-input" type="text" maxlength="24" placeholder="이름 입력" />
      <button class="dvads-rename-clear" type="button" aria-label="입력 지우기">×</button>
    </div>
    <div class="dvads-rename-actions">
      <button class="dvads-rename-cancel" type="button">취소</button>
      <button class="dvads-rename-save" type="button">저장</button>
    </div>
  `;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const input = card.querySelector<HTMLInputElement>(".dvads-rename-input")!;
  // 초기 표시 — 기존 별칭이 있으면 그걸, 없으면 서버측 원본 이름.
  void (async () => {
    const m = (await loadAllUserMeta())[entry.adAccountNo];
    input.value = m?.displayName?.trim() || entry.name;
    input.focus();
    input.select();
  })();

  const cleanup = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const save = async () => {
    await updateUserMeta(entry.adAccountNo, { displayName: input.value.trim().slice(0, 24) });
    cleanup();
    await replaceRow();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void save(); }
  };

  // 모달 내부 click이 document로 전파되면 popover의 outside-click 핸들러가 popover를 닫음.
  // 모든 핸들러에서 stopPropagation으로 차단. backdrop 자신은 target=backdrop인 경우만 닫기.
  backdrop.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === backdrop) cleanup();
  });
  // 카드 내부 모든 click도 stopPropagation — 입력칸 클릭/포커스 등이 popover dismiss 안 일으키게.
  card.addEventListener("click", (e) => e.stopPropagation());
  card.querySelector<HTMLButtonElement>(".dvads-rename-cancel")?.addEventListener("click", cleanup);
  card.querySelector<HTMLButtonElement>(".dvads-rename-save")?.addEventListener("click", () => void save());
  card.querySelector<HTMLButtonElement>(".dvads-rename-clear")?.addEventListener("click", () => {
    input.value = "";
    input.focus();
  });
  document.addEventListener("keydown", onKey, true);
}

function closeRenameDialog(): void {
  document.querySelector(".dvads-rename-backdrop")?.remove();
}

// ─── 다중 선택 + 일괄 액션 ───
// 각 행 좌측 체크박스 + 헤더 "설정 (N)" 버튼. selectedAccountNos는 모듈 전역.

function checkboxHTML(checked: boolean, ariaLabel: string, extraClass = ""): string {
  return (
    `<label class="dvads-multi-cb ${extraClass}" aria-label="${escapeHtml(ariaLabel)}">` +
    `<input type="checkbox" ${checked ? "checked" : ""} />` +
    `<span class="dvads-multi-cb-box" aria-hidden="true"></span>` +
    `</label>`
  );
}

function wireRowCheckbox(rowEl: HTMLElement, accountNo: number): void {
  const cb = rowEl.querySelector<HTMLInputElement>(".dvads-multi-cb input");
  if (!cb) return;
  cb.checked = selectedAccountNos.has(accountNo);
  // 체크박스 클릭이 행 click(이름 셀 네비게이션 등)으로 버블링되지 않게.
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", () => {
    if (cb.checked) selectedAccountNos.add(accountNo);
    else selectedAccountNos.delete(accountNo);
    if (popoverEl) updateBulkActionUI(popoverEl);
  });
}

// 현재 view에서 화면에 보이는(display 켜진) 행의 adAccountNo. select-all 동기화에 사용.
function getVisibleAccountNos(wrap: HTMLElement): number[] {
  const items = wrap.querySelectorAll<HTMLElement>("[data-ad-account-no]");
  const out: number[] = [];
  items.forEach((el) => {
    if (el.style.display === "none") return;
    const no = Number(el.dataset.adAccountNo);
    if (no) out.push(no);
  });
  return out;
}

// 헤더 select-all 체크박스 상태 + 설정 버튼 라벨 동기화. 메뉴 항목 자체는 dynamic resolve.
function updateBulkActionUI(wrap: HTMLElement): void {
  const count = selectedAccountNos.size;
  const settingsBtn = wrap.querySelector<HTMLButtonElement>(".dvads-multi-settings-btn");
  if (settingsBtn) {
    // 폭 안정성은 CSS min-width로 보장 — 라벨만 갈아끼움.
    settingsBtn.textContent = count > 0 ? `설정 (${count})` : "설정";
    settingsBtn.classList.toggle("has-selection", count > 0);
  }
  const selectAll = wrap.querySelector<HTMLInputElement>(".dvads-multi-cb-all input");
  if (selectAll) {
    const visible = getVisibleAccountNos(wrap);
    const allSelected = visible.length > 0 && visible.every((no) => selectedAccountNos.has(no));
    const someSelected = visible.some((no) => selectedAccountNos.has(no));
    selectAll.checked = allSelected;
    selectAll.indeterminate = !allSelected && someSelected;
  }
}

// 헤더 select-all 토글 — 현재 보이는 행 전부 선택/해제.
function wireSelectAll(wrap: HTMLElement): void {
  const selectAll = wrap.querySelector<HTMLInputElement>(".dvads-multi-cb-all input");
  if (!selectAll) return;
  selectAll.addEventListener("click", (e) => e.stopPropagation());
  selectAll.addEventListener("change", () => {
    const visible = getVisibleAccountNos(wrap);
    if (selectAll.checked) visible.forEach((no) => selectedAccountNos.add(no));
    else visible.forEach((no) => selectedAccountNos.delete(no));
    // 보이는 각 행의 체크박스 동기화
    visible.forEach((no) => {
      const row = wrap.querySelector<HTMLElement>(`[data-ad-account-no="${no}"]`);
      const cb = row?.querySelector<HTMLInputElement>(".dvads-multi-cb input");
      if (cb) cb.checked = selectAll.checked;
    });
    updateBulkActionUI(wrap);
  });
}

/**
 * 검색 input 빌더 — 양쪽에 아이콘 슬롯(돋보기/x). 두 view 공통 (list/search 모두).
 * value 있을 땐 wrapper에 has-value 클래스로 x 버튼 노출. x 클릭 시 값 비우고 필터 재적용.
 * view별 다른 점: list는 listSearchQuery(추가된 명단 필터) wire, search는 caller가 input 참조해
 * 자체 renderList 콜백 wire.
 */
function buildSearchInput(view: PopoverView): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dvads-multi-search-wrap";
  wrap.innerHTML = `
    <svg class="dvads-multi-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="5"/><path d="M11 11 L14 14"/>
    </svg>
    <input class="dvads-multi-search-input" type="text" placeholder="계정명 또는 계정번호 검색" />
    <button class="dvads-multi-search-clear" type="button" aria-label="검색어 지우기" tabindex="-1">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M3 3 L13 13 M13 3 L3 13"/>
      </svg>
    </button>
  `;
  const input = wrap.querySelector<HTMLInputElement>("input")!;
  const clearBtn = wrap.querySelector<HTMLButtonElement>(".dvads-multi-search-clear")!;
  const syncHasValue = () => wrap.classList.toggle("has-value", input.value.length > 0);

  if (view === "list") {
    input.value = listSearchQuery;
    syncHasValue();
    input.addEventListener("input", () => {
      listSearchQuery = input.value;
      syncHasValue();
      if (popoverEl) {
        applyListSearchFilter(popoverEl, listSearchQuery);
        updateBulkActionUI(popoverEl);
      }
    });
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = "";
      listSearchQuery = "";
      syncHasValue();
      if (popoverEl) {
        applyListSearchFilter(popoverEl, "");
        updateBulkActionUI(popoverEl);
      }
      input.focus();
    });
  } else {
    // search view: caller가 input 참조해 renderList 콜백 wire함. 여기선 x 처리 + has-value 동기화만.
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      input.value = "";
      syncHasValue();
      // input 이벤트 강제 발화 — search view의 renderList 콜백 트리거.
      input.dispatchEvent(new Event("input"));
      input.focus();
    });
    input.addEventListener("input", syncHasValue);
  }

  return wrap;
}

// 내 계정(list view) ⋮ kebab 메뉴 — 크게 보기 / 새로고침 / 알림 2종 / 삭제. 알림·삭제는 선택 필요.
// 첫 항목은 fullscreen 상태 토글 — 평소 "크게 보기", 진입 후엔 "작게 보기"로 라벨 바뀜.
function listKebabItems(entries: MultiAccountDirectoryEntry[]): ActionMenuItem[] {
  const hasSelection = selectedAccountNos.size > 0;
  return [
    {
      label: popoverFullscreen ? "작게 보기" : "크게 보기",
      onClick: () => setFullscreen(!popoverFullscreen),
    },
    { label: "새로고침", onClick: () => void refreshAllStale(entries) },
    { separator: true },
    {
      label: "비즈머니 알림",
      disabled: !hasSelection,
      onClick: () => openBizMoneyDialogFor(Array.from(selectedAccountNos)),
    },
    {
      label: "브랜드검색 알림",
      disabled: !hasSelection,
      onClick: () => openBrandSearchDialogFor(Array.from(selectedAccountNos)),
    },
    { separator: true },
    {
      label: "삭제",
      danger: true,
      disabled: !hasSelection,
      onClick: () => {
        const nos = Array.from(selectedAccountNos);
        if (nos.length === 0) return;
        void (async () => {
          for (const no of nos) await removeAccountFromList(no);
          selectedAccountNos.clear();
          if (popoverEl) await renderListView(popoverEl);
        })();
      },
    },
  ];
}

// 전체 계정(search view) ⋮ kebab 메뉴 — 사용자 요구대로 단순히 계정 추가 / 삭제만.
function searchKebabItems(): ActionMenuItem[] {
  const hasSelection = selectedAccountNos.size > 0;
  return [
    {
      label: "계정 추가",
      disabled: !hasSelection,
      onClick: () => {
        const nos = Array.from(selectedAccountNos);
        if (nos.length === 0) return;
        void (async () => {
          for (const no of nos) await addAccountToList(no);
          selectedAccountNos.clear();
          if (popoverEl) await renderSearchView(popoverEl);
        })();
      },
    },
    {
      label: "삭제",
      danger: true,
      disabled: !hasSelection,
      onClick: () => {
        const nos = Array.from(selectedAccountNos);
        if (nos.length === 0) return;
        void (async () => {
          for (const no of nos) await removeAccountFromList(no);
          selectedAccountNos.clear();
          if (popoverEl) await renderSearchView(popoverEl);
        })();
      },
    },
  ];
}

// popover 기본 폭 — 두 탭 동일 776px (큰 수치 표시 시 행이 짤리지 않게 좌우 8px씩 추가).
// 크게 보기 모드에선 CSS가 폭 무시하고 viewport 채움.
function applyPopoverWidth(_view: PopoverView): void {
  popoverEl?.style.setProperty("--dvads-multi-popover-width", "776px");
}

/**
 * popover 좌표를 트리거 버튼 기준으로 잡음 (anchored 모드). openPopover 초기 진입과
 * 크게 보기 종료 시 재호출. buttonEl 못 찾으면 우상단 고정.
 */
function applyAnchoredPosition(wrap: HTMLElement): void {
  const btnRect = buttonEl?.getBoundingClientRect();
  if (btnRect) {
    const popoverWidth = 1100;
    const margin = 8;
    const wouldOverflow = btnRect.left + popoverWidth > window.innerWidth - margin;
    if (wouldOverflow) {
      wrap.style.right = `${Math.max(margin, window.innerWidth - btnRect.right)}px`;
      wrap.style.left = "";
    } else {
      wrap.style.left = `${btnRect.left}px`;
      wrap.style.right = "";
    }
    wrap.style.top = `${btnRect.bottom + margin}px`;
  } else {
    wrap.style.top = "60px";
    wrap.style.right = "24px";
  }
}

/**
 * 크게 보기 모드 진입/종료. 진입 시 inline 위치 클리어 → CSS inset 인계, backdrop 추가, 테이블
 * is-collapsed 해제. 종료 시 anchored 위치 재계산 + backdrop 제거.
 */
function setFullscreen(on: boolean): void {
  popoverFullscreen = on;
  if (!popoverEl) return;
  popoverEl.classList.toggle("is-fullscreen", on);
  popoverEl.querySelector(".dvads-multi-table")?.classList.toggle("is-collapsed", !on);
  if (on) {
    // anchored 좌표 inline 스타일 비우면 CSS .is-fullscreen의 inset이 인계받음.
    popoverEl.style.top = "";
    popoverEl.style.left = "";
    popoverEl.style.right = "";
    let backdrop = document.querySelector<HTMLDivElement>(".dvads-multi-backdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "dvads dvads-multi-backdrop";
      backdrop.addEventListener("click", () => closePopover());
      document.body.appendChild(backdrop);
    }
  } else {
    document.querySelector(".dvads-multi-backdrop")?.remove();
    // 작게 복귀 — 버튼 기준 anchored 위치로 다시 잡음.
    applyAnchoredPosition(popoverEl);
  }
}

async function switchView(next: PopoverView) {
  if (!popoverEl) return;
  popoverView = next;
  // view마다 선택 컨텍스트가 달라 (내 계정 vs 전체 계정) — 전환 시 선택 초기화.
  selectedAccountNos.clear();
  // width 변경을 먼저 트리거 — render 중 transition이 시작되어 새 폭으로 슬라이드.
  applyPopoverWidth(next);
  await renderPopoverBody(popoverEl);
}

function pickAddedEntries(
  rawEntries: MultiAccountDirectoryEntry[],
  addedList: number[],
): MultiAccountDirectoryEntry[] {
  const byNo = new Map(rawEntries.map((e) => [e.adAccountNo, e]));
  const out: MultiAccountDirectoryEntry[] = [];
  for (const no of addedList) {
    const e = byNo.get(no);
    if (e && e.adPlatformType === "SA" && !e.disabled && !e.deleted) {
      out.push(e);
    }
  }
  return out;
}


function renderTableRow(
  entry: MultiAccountDirectoryEntry,
  meta: MultiAccountUserMeta | undefined,
): HTMLTableRowElement {
  const tr = document.createElement("tr");
  tr.className = "dvads-multi-tr";
  tr.dataset.adAccountNo = String(entry.adAccountNo);
  // 검색 haystack — 계정명/번호/별칭을 하나로 합쳐 lowercase. listSearchQuery substring match.
  tr.dataset.searchHaystack = (
    `${entry.name} ${entry.adAccountNo} ${meta?.displayName ?? ""}`
  ).toLowerCase();

  const displayName = meta?.displayName?.trim() || entry.name;
  const isActive =
    location.pathname.startsWith(`/manage/ad-accounts/${entry.adAccountNo}/`);
  if (isActive) tr.classList.add("dvads-multi-tr-active");

  tr.innerHTML = `
    <td class="dvads-multi-td-cb">${checkboxHTML(false, `${displayName} 선택`)}</td>
    <td class="dvads-multi-td-name">
      <div class="dvads-multi-name" title="${escapeHtml(entry.name)}">${escapeHtml(displayName)}</div>
      <div class="dvads-multi-no">${entry.adAccountNo}</div>
    </td>
    <td class="dvads-multi-td-num" data-k="bizMoney">-</td>
    <td class="dvads-multi-td-num" data-k="impressions">-</td>
    <td class="dvads-multi-td-num" data-k="clicks">-</td>
    <td class="dvads-multi-td-num" data-k="ctr">-</td>
    <td class="dvads-multi-td-num" data-k="cpc">-</td>
    <td class="dvads-multi-td-num" data-k="cost">-</td>
    <td class="dvads-multi-td-num" data-k="revenue">-</td>
    <td class="dvads-multi-td-num" data-k="conversions">-</td>
    <td class="dvads-multi-td-num" data-k="roas">-</td>
    <td class="dvads-multi-td-act">
      <button class="dvads-multi-action-trigger" type="button" aria-label="작업 메뉴">⋯</button>
    </td>
  `;

  // 이름 셀(계정명+계정번호) 클릭 → 해당 계정 페이지를 새 탭으로. popover는 유지(원본 탭).
  // anchor click 패턴 — window.open은 일부 콘텐츠 스크립트 컨텍스트에서 차단될 수 있어,
  // 임시 <a target="_blank">.click()이 가장 신뢰성 높음 (사용자 제스처 직결).
  const goTo = () => {
    const url = `/manage/ad-accounts/${entry.adAccountNo}/sa/campaigns-by/WEB_SITE`;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  };

  const nameTd = tr.querySelector<HTMLTableCellElement>(".dvads-multi-td-name");
  nameTd?.classList.add("dvads-multi-td-name-clickable");
  nameTd?.addEventListener("click", goTo);

  // 체크박스 wire — 선택 토글 + 헤더 카운트 동기화.
  wireRowCheckbox(tr, entry.adAccountNo);

  // 행 click → 체크박스 토글. 단 이름 셀(바로가기)과 액션 트리거/체크박스 자체는 제외 (각자 핸들러).
  tr.addEventListener("click", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    if (t.closest(".dvads-multi-td-name")) return;
    if (t.closest(".dvads-multi-action-trigger")) return;
    if (t.closest(".dvads-multi-cb")) return;
    const cb = tr.querySelector<HTMLInputElement>(".dvads-multi-cb input");
    if (cb) {
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    }
  });

  // 작업 메뉴 — kebab "..." 트리거 + 항목.
  const actionTrigger = tr.querySelector<HTMLButtonElement>(".dvads-multi-action-trigger");
  if (actionTrigger) {
    attachActionMenu({
      trigger: actionTrigger,
      ariaLabel: `${displayName} 작업 메뉴`,
      items: [
        { label: "바로가기", onClick: goTo },
        {
          label: "이름 수정",
          onClick: () => openRenameDialog(entry, () => replaceListRow(tr, entry)),
        },
        {
          label: "비즈머니 알림",
          onClick: () => openBizMoneyDialogFor([entry.adAccountNo]),
        },
        {
          label: "브랜드검색 알림",
          onClick: () => openBrandSearchDialogFor([entry.adAccountNo]),
        },
        {
          label: "삭제",
          danger: true,
          onClick: () => {
            // 검색 뷰의 ".dvads-multi-remove"와 동일한 흐름 — confirm 없이 즉시 제거.
            // 광고계정 자체가 삭제되는 게 아니라 사용자 추가 목록에서만 빠지는 거라
            // 안전 측 (재추가는 검색 뷰에서 가능).
            void (async () => {
              await removeAccountFromList(entry.adAccountNo);
              if (popoverEl) await renderListView(popoverEl);
            })();
          },
        },
      ],
    });
  }

  return tr;
}

/**
 * 명시적 사용자 액션. popover 헤더 "↻ 전체" 버튼에서 호출.
 * cross-account 직접 fetch라 동시 실행 안전. 동시 4개로 cap — 서버 부담/rate limit 고려.
 */
const REFRESH_ALL_CONCURRENCY = 4;

async function refreshAllStale(entries: MultiAccountDirectoryEntry[]) {
  if (!popoverEl) return;
  const btn = popoverEl.querySelector<HTMLButtonElement>(".dvads-multi-refresh-all");
  const activeNo = extractActiveAdAccountNo();
  const total = entries.length;
  let done = 0;
  const updateLabel = () => {
    if (btn && popoverEl?.contains(btn)) {
      btn.textContent = `↻ ${done}/${total} 받는 중...`;
    }
  };
  // popover가 fetch 시작 직전에 닫혀 btn이 stale 노드일 수 있어 contains guard로
  // updateLabel과 동일한 일관성 유지.
  if (btn && popoverEl?.contains(btn)) {
    btn.disabled = true;
    updateLabel();
  }
  // 작업자 풀 패턴 — 동시 N개씩 처리
  const queue = [...entries];
  const workers = Array.from({ length: Math.min(REFRESH_ALL_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) break;
      try {
        await refreshRow(entry, activeNo, { force: true });
      } catch (e) {
        console.warn("[content/multi-account] refresh 실패", entry.adAccountNo, e);
      }
      done++;
      updateLabel();
    }
  });
  await Promise.all(workers);
  if (btn && popoverEl?.contains(btn)) {
    btn.disabled = false;
    btn.textContent = "↻ 전체";
  }
}

/**
 * 한 광고계정의 데이터 새로고침. 활성/비활성 구분 없음 — 모두 같은 경로:
 * 현재 페이지 컨텍스트에서 `x-ad-customer-id` 헤더로 cross-account 직접 fetch.
 * hidden tab/approach 안 씀.
 */
async function refreshRow(
  entry: MultiAccountDirectoryEntry,
  _activeNo: number | null,
  opts: { force: boolean } = { force: false },
): Promise<void> {
  if (!opts.force) {
    const cached = await loadSnapshot(entry.adAccountNo);
    if (cached && isSnapshotFresh(cached)) return;
  }
  if (!entry.masterCustomerId) {
    paintRowError(entry.adAccountNo, "customerId 누락 — 새로고침 후 다시 시도해주세요");
    return;
  }
  paintRowLoading(entry.adAccountNo);
  try {
    const payload = await collectAccount(
      entry.adAccountNo,
      entry.masterCustomerId,
      yesterdayKST(),
    );
    const snap: MultiAccountSnapshot = {
      adAccountNo: entry.adAccountNo,
      bizMoney: payload.bizMoney,
      yesterday: payload.yesterday,
      contracts: payload.contracts,
      fetched_at: new Date().toISOString(),
    };
    await saveSnapshot(snap);
    const all = await loadAllUserMeta();
    paintRow(entry.adAccountNo, snap, all[entry.adAccountNo]);
    void refreshBadge();
  } catch (e) {
    paintRowError(entry.adAccountNo, friendlyMessage(e));
  }
}

function paintRowEmpty(adAccountNo: number) {
  if (!popoverEl) return;
  const row = findRow(adAccountNo);
  if (!row) return;
  row.classList.add("dvads-multi-tr-empty");
}

function paintRowLoading(adAccountNo: number) {
  if (!popoverEl) return;
  const row = findRow(adAccountNo);
  if (!row) return;
  row.classList.add("dvads-multi-tr-loading");
  row.classList.remove("dvads-multi-tr-empty");
}

// ─── 알림 임계값 다이얼로그 + 배지 갱신 ─────────────────────────────────
//
// 행/헤더 메뉴에서 "비즈머니 알림" / "브랜드검색 알림" 클릭 시 호출.
// 단일 계정이면 기존 값을 prefill, 다중 선택(헤더 kebab)이면 일괄 적용.
// 저장 후 popover 재렌더 + 페이지 우상단 버튼 배지 갱신.

async function openBizMoneyDialogFor(nos: number[]) {
  if (nos.length === 0) return;
  const metaMap = await loadAllUserMeta();
  const initial = nos.length === 1 ? (metaMap[nos[0]]?.bizMoneyThreshold ?? null) : null;
  // 해제 버튼 노출 조건:
  //  - 단일 선택: 기존 임계값이 있을 때만 (이미 해제 상태인 계정엔 의미 없음)
  //  - 다중 선택: 선택 계정 중 일부만 설정돼 있을 수 있어 항상 일괄 해제 가능
  const anyConfigured = nos.some((no) => metaMap[no]?.bizMoneyThreshold != null);
  const showClear = nos.length === 1 ? initial != null : anyConfigured;
  openInputDialog({
    title: "비즈머니 알림 설정",
    description: nos.length === 1
      ? "비즈머니가 이 금액 이하로 떨어지면 알림"
      : `선택된 ${nos.length}개 계정에 일괄 적용 - 비즈머니가 이 금액 이하면 알림`,
    initialValue: initial,
    suffix: "원",
    placeholder: "예: 100000",
    onConfirm: async (value) => {
      for (const no of nos) await updateUserMeta(no, { bizMoneyThreshold: value });
      if (popoverEl) await renderListView(popoverEl);
      void refreshBadge();
    },
    onClear: showClear ? async () => {
      for (const no of nos) await updateUserMeta(no, { bizMoneyThreshold: undefined });
      if (popoverEl) await renderListView(popoverEl);
      void refreshBadge();
    } : undefined,
  });
}

async function openBrandSearchDialogFor(nos: number[]) {
  if (nos.length === 0) return;
  const metaMap = await loadAllUserMeta();
  const initial = nos.length === 1 ? (metaMap[nos[0]]?.brandSearchDaysThreshold ?? null) : null;
  const anyConfigured = nos.some((no) => metaMap[no]?.brandSearchDaysThreshold != null);
  const showClear = nos.length === 1 ? initial != null : anyConfigured;
  openInputDialog({
    title: "브랜드검색 알림 설정",
    description: nos.length === 1
      ? "브랜드검색 계약 만료가 이 일수 이하로 남으면 알림"
      : `선택된 ${nos.length}개 계정에 일괄 적용 - 브랜드검색 만료가 이 일수 이하면 알림`,
    initialValue: initial,
    suffix: "일",
    placeholder: "예: 7",
    onConfirm: async (value) => {
      for (const no of nos) await updateUserMeta(no, { brandSearchDaysThreshold: value });
      if (popoverEl) await renderListView(popoverEl);
      void refreshBadge();
    },
    onClear: showClear ? async () => {
      for (const no of nos) await updateUserMeta(no, { brandSearchDaysThreshold: undefined });
      if (popoverEl) await renderListView(popoverEl);
      void refreshBadge();
    } : undefined,
  });
}

/**
 * 페이지 우상단 햄버거 버튼의 알림 배지를 갱신. 사용자가 설정한 임계값을 가진 계정 중
 * 비즈머니가 임계 이하이거나 브랜드검색 D-day가 임계 이하인 계정 수를 합산해 표시.
 *
 * 호출 시점: syncMount 직후, popover 렌더 후, snapshot 갱신 후, 다이얼로그 onConfirm/onClear,
 * 그리고 storage onChanged 콜백.
 */
async function refreshBadge() {
  if (!buttonEl) return;
  const badge = buttonEl.querySelector<HTMLSpanElement>(".dvads-multi-btn-badge");
  if (!badge) return;
  const addedList = await loadAddedList();
  const metaMap = await loadAllUserMeta();
  let count = 0;
  for (const no of addedList) {
    const meta = metaMap[no];
    if (!meta) continue;
    if (meta.bizMoneyThreshold == null && meta.brandSearchDaysThreshold == null) continue;
    const snap = await loadSnapshot(no);
    if (!snap) continue;
    let alerted = false;
    if (meta.bizMoneyThreshold != null && snap.bizMoney != null && snap.bizMoney <= meta.bizMoneyThreshold) {
      alerted = true;
    }
    if (!alerted && meta.brandSearchDaysThreshold != null) {
      const dday = computeMinDday(snap.contracts);
      if (dday !== null && dday <= meta.brandSearchDaysThreshold) alerted = true;
    }
    if (alerted) count++;
  }
  if (count > 0) {
    const text = count > 99 ? "99+" : String(count);
    badge.textContent = text;
    badge.style.display = "";
    // 자릿수에 따라 font-size 축소 클래스 — 정원 유지하면서 글자 fit.
    badge.classList.toggle("is-two-digit", text.length === 2);
    badge.classList.toggle("is-three-digit", text.length >= 3);
    buttonEl.title = `광고계정 명단 (알림 ${count}건)`;
  } else {
    badge.textContent = "";
    badge.style.display = "none";
    badge.classList.remove("is-two-digit", "is-three-digit");
    buttonEl.title = "광고계정 명단";
  }
}

/**
 * 다른 탭에서 임계값/추가목록/스냅샷이 바뀐 경우도 배지 동기화하려면 storage 변경 구독 필요.
 * `initMultiAccount`에서 1회 등록. 콘텐츠 스크립트당 1회 리스너만 유지(중복 등록은 init 가드).
 */
function registerStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const k of Object.keys(changes)) {
      if (
        k === "multi_account_user_meta" ||
        k === "multi_account_added_list" ||
        k.startsWith("multi_account_snapshot:")
      ) {
        void refreshBadge();
        return;
      }
    }
  });
}

function paintRow(adAccountNo: number, snap: MultiAccountSnapshot, meta?: MultiAccountUserMeta) {
  if (!popoverEl) return;
  const row = findRow(adAccountNo);
  if (!row) return;
  row.classList.remove("dvads-multi-tr-loading", "dvads-multi-tr-empty");
  if (isSnapshotFresh(snap)) row.classList.remove("dvads-multi-tr-stale");
  else row.classList.add("dvads-multi-tr-stale");

  const setCell = (k: string, value: string) => {
    const td = row.querySelector<HTMLTableCellElement>(`td[data-k="${k}"]`);
    if (td) td.textContent = value;
  };
  if (snap.yesterday) {
    const y = snap.yesterday;
    setCell("impressions", formatNumber(y.impressions));
    setCell("clicks", formatNumber(y.clicks));
    setCell("ctr", formatPercent(y.ctr));
    setCell("cpc", formatWon(y.cpc));
    setCell("cost", formatWon(y.cost));
    setCell("revenue", formatWon(y.revenue));
    setCell("conversions", formatNumber(y.conversions));
    setCell("roas", formatPercent(y.roas));
  } else {
    for (const k of ["impressions","clicks","ctr","cpc","cost","revenue","conversions","roas"]) {
      setCell(k, "-");
    }
  }
  setCell("bizMoney", snap.bizMoney != null ? formatWon(snap.bizMoney) : "-");

  // 계약 D-day는 행 자체에 시각 cue (테두리/title)
  row.classList.remove("dvads-multi-tr-contract-warning", "dvads-multi-tr-contract-expired");
  row.removeAttribute("title");
  const dday = computeMinDday(snap.contracts);
  if (dday !== null) {
    if (dday <= 0) {
      row.classList.add("dvads-multi-tr-contract-expired");
      row.title = "브랜드검색 계약 만료";
    } else if (dday <= 5) {
      row.classList.add("dvads-multi-tr-contract-warning");
      row.title = `브랜드검색 D-${dday} - 계약 종료 임박`;
    }
  }

  // ─── 사용자 임계값 알림 cue ───
  // 비즈머니 셀 빨강 — 임계값 설정되어 있고 잔액이 그 이하일 때.
  const bizCell = row.querySelector<HTMLTableCellElement>(`td[data-k="bizMoney"]`);
  const bizAlert = meta?.bizMoneyThreshold != null
    && snap.bizMoney != null
    && snap.bizMoney <= meta.bizMoneyThreshold;
  bizCell?.classList.toggle("dvads-multi-td-biz-alert", bizAlert);

  // 브랜드검색 임계 도달 — 행 좌측 보더 + 계정명 빨강(펄스). 기존 hardcoded ≤5일 cue와는
  // 별개 클래스로 동작. 둘 다 맞으면 CSS 단일 색이라 한 번만 그려짐.
  const brandAlert = meta?.brandSearchDaysThreshold != null
    && dday !== null
    && dday <= meta.brandSearchDaysThreshold;
  row.classList.toggle("dvads-multi-tr-brand-alert", brandAlert);
  if (brandAlert) {
    // 임계 도달이 hardcoded cue보다 강한 신호 — title 덮어쓴다.
    row.title = dday! <= 0 ? "브랜드검색 만료" : `브랜드검색 만료 ${dday}일 전`;
  }
}

function paintRowError(adAccountNo: number, message: string) {
  if (!popoverEl) return;
  const row = findRow(adAccountNo);
  if (!row) return;
  row.classList.remove("dvads-multi-tr-loading");
  const nameTd = row.querySelector<HTMLTableCellElement>(".dvads-multi-td-name");
  if (!nameTd) return;
  let errEl = nameTd.querySelector<HTMLSpanElement>(".dvads-multi-row-error");
  if (!errEl) {
    errEl = document.createElement("span");
    errEl.className = "dvads-multi-row-error";
    nameTd.appendChild(errEl);
  }
  errEl.textContent = message;
}

function findRow(adAccountNo: number): HTMLTableRowElement | null {
  if (!popoverEl) return null;
  return popoverEl.querySelector<HTMLTableRowElement>(
    `tr.dvads-multi-tr[data-ad-account-no="${adAccountNo}"]`,
  );
}

function computeMinDday(contracts: MultiAccountSnapshot["contracts"]): number | null {
  if (!contracts || contracts.length === 0) return null;
  let minDays: number | null = null;
  const now = Date.now();
  for (const c of contracts) {
    if (!c.endDate) continue;
    const ms = new Date(c.endDate).getTime();
    if (!Number.isFinite(ms)) continue;
    const days = Math.ceil((ms - now) / (24 * 60 * 60 * 1000));
    if (minDays === null || days < minDays) minDays = days;
  }
  return minDays;
}

function extractActiveAdAccountNo(): number | null {
  const m = location.pathname.match(/\/manage\/ad-accounts\/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function formatNumber(n: number): string {
  return n.toLocaleString("ko-KR");
}

function formatWon(n: number): string {
  return Math.round(n).toLocaleString("ko-KR") + "원";
}

function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(1) + "%";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function friendlyMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes("HTTP 401") || raw.includes("HTTP 403")) {
    return "광고관리자 로그인이 만료됐을 수 있어요. 페이지를 새로고침 후 다시 시도해주세요.";
  }
  if (raw.includes("HTTP 429")) {
    return "잠시 많은 요청이 몰렸어요. 잠시 후 다시 시도해주세요.";
  }
  if (raw.includes("HTTP 5")) {
    return "서버가 잠시 응답하지 않아요. 잠시 후 다시 시도해주세요.";
  }
  return "데이터를 가져오지 못했어요.";
}
