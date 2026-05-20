/**
 * F-MultiAccount — 다계정 대시보드 (ads.naver.com 페이지 내 오버레이).
 *
 * 동작:
 *   1. `/manage/ad-accounts/` URL에 진입 시 우상단 fixed 버튼 주입
 *   2. 버튼 클릭 → dvads-popover로 광고계정 명단 + 어제 6지표/비즈머니/계약 D-day
 *   3. 행 클릭 → 해당 광고계정 페이지로 SPA 전환
 *   4. 명단은 첫 로드 시 자동 fetch + 캐시 (1일 stale)
 *   5. 다른 계정 데이터는 background tab으로 수집 위임 (`MULTI_ACCOUNT_COLLECT_ACCOUNT`)
 *   6. 현재 활성 계정 데이터는 즉시 fetch (background tab 우회)
 *   7. 옵션 페이지에서 `MULTI_ACCOUNT_REFRESH_DIRECTORY` 메시지 → 디렉터리 강제 갱신
 *   8. background에서 `MULTI_ACCOUNT_COLLECT_ACTIVE` 메시지 → 현재 페이지 활성 계정 수집 응답
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
  collectActiveAccount,
  yesterdayKST,
} from "@/lib/multi-account-data";
import type {
  MultiAccountDirectoryCache,
  MultiAccountDirectoryEntry,
  MultiAccountUserMeta,
  MultiAccountSnapshot,
} from "@/types/storage";

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
 * 그 계정 데이터를 자동으로 캐시 갱신. 백그라운드 탭 없이 같은 페이지 컨텍스트에서 직접 fetch.
 * 사용자가 평소 일하면서 자연스럽게 자주 보는 계정들이 채워진다.
 */
async function autoUpdateActiveAccount() {
  const activeNo = extractActiveAdAccountNo();
  if (activeNo === null) return;
  // stale 체크 — 신선한 캐시가 있으면 굳이 다시 안 부름
  const cached = await loadSnapshot(activeNo);
  if (cached && isSnapshotFresh(cached)) return;
  try {
    const payload = await collectActiveAccount(yesterdayKST());
    const snap: MultiAccountSnapshot = {
      adAccountNo: activeNo,
      bizMoney: payload.bizMoney,
      yesterday: payload.yesterday,
      contracts: payload.contracts,
      fetched_at: new Date().toISOString(),
    };
    await saveSnapshot(snap);
    // popover가 열려있으면 즉시 반영
    if (popoverEl) paintRow(activeNo, snap);
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
    if (t === "MULTI_ACCOUNT_COLLECT_ACTIVE") {
      void (async () => {
        console.log("[content/multi-account] COLLECT_ACTIVE 받음, 수집 시작");
        try {
          const payload = await collectActiveAccount(yesterdayKST());
          console.log("[content/multi-account] 수집 완료", payload);
          sendResponse({ ok: true, ...payload });
        } catch (e) {
          console.warn("[content/multi-account] 수집 실패", e);
          sendResponse({ ok: false, error: friendlyMessage(e) });
        }
      })();
      return true;
    }
    return false;
  });
}

async function ensureDirectoryFresh() {
  if (directoryFetchInFlight) return directoryFetchInFlight;
  const existing = await loadDirectory();
  if (existing && !isDirectoryStale(existing)) return;
  directoryFetchInFlight = (async () => {
    try {
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
  btn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="2.5" y1="4" x2="13.5" y2="4"/>' +
    '<line x1="2.5" y1="8" x2="13.5" y2="8"/>' +
    '<line x1="2.5" y1="12" x2="13.5" y2="12"/>' +
    "</svg>";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popoverEl) closePopover();
    else void openPopover();
  });

  chip.parentElement.insertBefore(btn, chip);
  buttonEl = btn;
  lastButtonContainer = chip.parentElement;
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
  // 상단 영역에 있는 후보 element만 검사 (전체 DOM walker는 비용 큼)
  const candidates = document.querySelectorAll<HTMLElement>("button, span, div, a");
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
  // 버튼 바로 아래로 정렬. 버튼 위치를 기준으로 popover 왼쪽 정렬.
  const btnRect = buttonEl?.getBoundingClientRect();
  if (btnRect) {
    const popoverWidth = 1100;
    const margin = 8;
    // 가능하면 버튼 좌측 정렬. 화면 우측 밖으로 나가면 우측 정렬로 폴백.
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
  wrap.innerHTML = `<div class="dvads-multi-loading">불러오는 중…</div>`;
  document.body.appendChild(wrap);
  popoverEl = wrap;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopover();
  };
  const onClickOutside = (e: MouseEvent) => {
    if (!popoverEl) return;
    if (popoverEl.contains(e.target as Node)) return;
    if (buttonEl?.contains(e.target as Node)) return;
    closePopover();
  };
  document.addEventListener("keydown", onKey);
  // 같은 클릭이 listener에 잡히지 않도록 다음 tick부터 등록
  setTimeout(() => document.addEventListener("click", onClickOutside), 0);
  (wrap as unknown as { __cleanup: () => void }).__cleanup = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("click", onClickOutside);
  };

  await renderPopoverBody(wrap);
}

function closePopover() {
  if (!popoverEl) return;
  const cleanup = (popoverEl as unknown as { __cleanup?: () => void }).__cleanup;
  cleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverView = "list";
}

type PopoverView = "list" | "search";
let popoverView: PopoverView = "list";

async function renderPopoverBody(wrap: HTMLElement) {
  if (popoverView === "search") {
    await renderSearchView(wrap);
    return;
  }
  await renderListView(wrap);
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

async function renderListView(wrap: HTMLElement) {
  const [dir, meta, addedList] = await Promise.all([
    loadDirectory(),
    loadAllUserMeta(),
    loadAddedList(),
  ]);

  const entries = pickAddedEntries(dir?.entries ?? [], addedList);
  wrap.innerHTML = "";

  const hdr = document.createElement("div");
  hdr.className = "dvads-multi-hdr";
  hdr.innerHTML = `
    <div class="dvads-multi-title-wrap">
      <div class="dvads-multi-title">광고계정</div>
    </div>
    <div class="dvads-multi-hdr-actions">
      <button class="dvads-multi-add-btn" type="button" title="광고계정 추가">+ 추가</button>
      <button class="dvads-multi-refresh-all" type="button" title="모든 계정 새로고침">↻ 전체</button>
    </div>
  `;
  wrap.appendChild(hdr);

  hdr.querySelector<HTMLButtonElement>(".dvads-multi-add-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    switchView("search");
  });
  hdr.querySelector<HTMLButtonElement>(".dvads-multi-refresh-all")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void refreshAllStale(entries);
  });

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dvads-multi-empty";
    empty.innerHTML = `
      <p>아직 추가된 광고계정이 없어요.</p>
      <p class="dvads-multi-empty-sub">자주 보는 광고계정을 추가하면 여기에 데이터가 표시됩니다.</p>
      <button class="dvads-multi-empty-cta" type="button">+ 광고계정 추가</button>
    `;
    wrap.appendChild(empty);
    empty.querySelector<HTMLButtonElement>(".dvads-multi-empty-cta")?.addEventListener("click", () => {
      switchView("search");
    });
    return;
  }

  const tableWrap = document.createElement("div");
  tableWrap.className = "dvads-multi-table-wrap";
  const table = document.createElement("table");
  table.className = "dvads-bid-table dvads-multi-table";
  table.innerHTML = `
    <thead><tr>
      ${COLUMN_DEFS.map((c) => {
        const numCls = c.numeric ? "dvads-multi-th-num" : "";
        const sortInd =
          sortState.key === c.key ? (sortState.dir === "asc" ? "▲" : "▼") : "";
        return `<th class="dvads-multi-th-sort ${numCls}" data-sort-key="${c.key}">
          <span>${c.label}</span><span class="dvads-multi-sort-ind">${sortInd}</span>
        </th>`;
      }).join("")}
      <th class="dvads-multi-th-act"></th>
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
  // 캐시 미리 로드해 정렬용 데이터 준비
  const snapshots = await Promise.all(entries.map((e) => loadSnapshot(e.adAccountNo)));
  const sorted = sortEntries(entries, snapshots, meta, sortState);
  for (const { entry, snap } of sorted) {
    const tr = renderTableRow(entry, meta[entry.adAccountNo]);
    tbody.appendChild(tr);
    if (snap) paintRow(entry.adAccountNo, snap);
    else paintRowEmpty(entry.adAccountNo);
  }
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  // 활성 계정 자연 갱신 (같은 페이지라 새 탭 안 띄움)
  const activeNo = extractActiveAdAccountNo();
  for (const entry of entries) {
    if (entry.adAccountNo === activeNo) {
      void refreshRow(entry, activeNo, { force: false });
    }
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
  wrap.innerHTML = "";
  const [dir, meta, addedList] = await Promise.all([
    loadDirectory(),
    loadAllUserMeta(),
    loadAddedList(),
  ]);
  const addedSet = new Set(addedList);
  const all = (dir?.entries ?? [])
    .filter((e) => e.adPlatformType === "SA" && !e.disabled && !e.deleted)
    .sort((a, b) => (b.lastAccessTime ?? "").localeCompare(a.lastAccessTime ?? ""));

  const hdr = document.createElement("div");
  hdr.className = "dvads-multi-hdr dvads-multi-hdr-search";
  hdr.innerHTML = `
    <button class="dvads-multi-back-btn" type="button" title="뒤로가기">‹</button>
    <input class="dvads-multi-search-input" type="text" placeholder="계정명 또는 계정번호 검색" />
    <button class="dvads-multi-done-btn" type="button">완료</button>
  `;
  wrap.appendChild(hdr);

  const backBtn = hdr.querySelector<HTMLButtonElement>(".dvads-multi-back-btn")!;
  const doneBtn = hdr.querySelector<HTMLButtonElement>(".dvads-multi-done-btn")!;
  const input = hdr.querySelector<HTMLInputElement>(".dvads-multi-search-input")!;

  backBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    switchView("list");
  });
  doneBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    switchView("list");
  });

  const listWrap = document.createElement("div");
  listWrap.className = "dvads-multi-search-list-wrap";
  wrap.appendChild(listWrap);

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
    listWrap.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dvads-multi-search-empty";
      empty.textContent = "검색 결과가 없어요.";
      listWrap.appendChild(empty);
      return;
    }
    const ul = document.createElement("ul");
    ul.className = "dvads-multi-search-list";
    for (const entry of filtered) {
      ul.appendChild(renderSearchRow(entry, meta[entry.adAccountNo], addedSet));
    }
    listWrap.appendChild(ul);
  };

  renderList("");
  input.addEventListener("input", () => renderList(input.value));
  setTimeout(() => input.focus(), 30);
}

function renderSearchRow(
  entry: MultiAccountDirectoryEntry,
  meta: MultiAccountUserMeta | undefined,
  addedSet: Set<number>,
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "dvads-multi-search-row";
  li.dataset.adAccountNo = String(entry.adAccountNo);

  const isAdded = addedSet.has(entry.adAccountNo);
  const displayName = meta?.displayName?.trim() || entry.name;

  li.innerHTML = `
    <div class="dvads-multi-search-info">
      <div class="dvads-multi-search-name">${escapeHtml(displayName)}</div>
      <div class="dvads-multi-search-meta">
        ${meta?.displayName ? `<span class="dvads-multi-search-origin">원래 ${escapeHtml(entry.name)}</span> · ` : ""}
        <span class="dvads-multi-search-no">${entry.adAccountNo}</span>
      </div>
    </div>
    <div class="dvads-multi-search-actions">
      ${
        isAdded
          ? `
            <button class="dvads-multi-edit-alias" type="button" title="별칭 편집">✎</button>
            <button class="dvads-multi-remove" type="button" title="추가 해제">삭제</button>
          `
          : `<button class="dvads-multi-add-one" type="button">+ 추가</button>`
      }
    </div>
  `;

  if (!isAdded) {
    li.querySelector<HTMLButtonElement>(".dvads-multi-add-one")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = await addAccountToList(entry.adAccountNo);
      addedSet.clear();
      next.forEach((n) => addedSet.add(n));
      replaceSearchRow(li, entry);
    });
  } else {
    li.querySelector<HTMLButtonElement>(".dvads-multi-remove")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const next = await removeAccountFromList(entry.adAccountNo);
      addedSet.clear();
      next.forEach((n) => addedSet.add(n));
      replaceSearchRow(li, entry);
    });
    li.querySelector<HTMLButtonElement>(".dvads-multi-edit-alias")?.addEventListener("click", (e) => {
      e.stopPropagation();
      startInlineEdit(li, entry, meta);
    });
  }

  return li;
}

async function replaceSearchRow(li: HTMLLIElement, entry: MultiAccountDirectoryEntry) {
  const [meta, addedList] = await Promise.all([loadAllUserMeta(), loadAddedList()]);
  const addedSet = new Set(addedList);
  const newRow = renderSearchRow(entry, meta[entry.adAccountNo], addedSet);
  li.replaceWith(newRow);
}

function startInlineEdit(
  li: HTMLLIElement,
  entry: MultiAccountDirectoryEntry,
  meta: MultiAccountUserMeta | undefined,
) {
  const info = li.querySelector<HTMLElement>(".dvads-multi-search-info");
  if (!info) return;
  const initial = meta?.displayName?.trim() ?? "";
  info.innerHTML = `
    <input class="dvads-multi-alias-input" type="text" placeholder="별칭 (없으면 ${escapeHtml(entry.name)})" maxlength="24" />
    <div class="dvads-multi-search-meta">${entry.adAccountNo}</div>
  `;
  const input = info.querySelector<HTMLInputElement>(".dvads-multi-alias-input")!;
  input.value = initial;
  const actions = li.querySelector<HTMLElement>(".dvads-multi-search-actions");
  if (actions) {
    actions.innerHTML = `
      <button class="dvads-multi-alias-save" type="button">저장</button>
      <button class="dvads-multi-alias-cancel" type="button">취소</button>
    `;
    actions.querySelector<HTMLButtonElement>(".dvads-multi-alias-save")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await updateUserMeta(entry.adAccountNo, { displayName: input.value.trim().slice(0, 24) });
      await replaceSearchRow(li, entry);
    });
    actions.querySelector<HTMLButtonElement>(".dvads-multi-alias-cancel")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await replaceSearchRow(li, entry);
    });
  }
  input.focus();
  input.select();
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await updateUserMeta(entry.adAccountNo, { displayName: input.value.trim().slice(0, 24) });
      await replaceSearchRow(li, entry);
    }
    if (e.key === "Escape") {
      e.preventDefault();
      await replaceSearchRow(li, entry);
    }
  });
}

async function switchView(next: PopoverView) {
  if (!popoverEl) return;
  popoverView = next;
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

  const displayName = meta?.displayName?.trim() || entry.name;
  const isActive =
    location.pathname.startsWith(`/manage/ad-accounts/${entry.adAccountNo}/`);
  if (isActive) tr.classList.add("dvads-multi-tr-active");

  tr.innerHTML = `
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
      <button class="dvads-multi-row-refresh" type="button" title="이 계정 새로고침">↻</button>
    </td>
  `;

  const refreshBtn = tr.querySelector<HTMLButtonElement>(".dvads-multi-row-refresh");
  refreshBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    void refreshRow(entry, extractActiveAdAccountNo(), { force: true });
  });

  tr.addEventListener("click", () => {
    if (isActive) {
      closePopover();
      return;
    }
    closePopover();
    const url = `/manage/ad-accounts/${entry.adAccountNo}/sa/campaigns-by/WEB_SITE`;
    location.assign(url);
  });

  return tr;
}

/**
 * 명시적 사용자 액션. popover 헤더 "↻ 전체" 버튼에서 호출.
 * 동시 1개씩 차례대로 — 각 계정마다 active 탭이 잠깐 활성화되었다 복귀하므로
 * 여러 개 동시에 깜빡이면 어지러움. 진행 상황을 버튼 라벨로 표시("3/4 받는 중...").
 */
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
  if (btn) {
    btn.disabled = true;
    updateLabel();
  }
  for (const entry of entries) {
    try {
      await refreshRow(entry, activeNo, { force: true });
    } catch (e) {
      console.warn("[content/multi-account] refresh 실패", entry.adAccountNo, e);
    }
    done++;
    updateLabel();
  }
  if (btn && popoverEl?.contains(btn)) {
    btn.disabled = false;
    btn.textContent = "↻ 전체";
  }
}

/**
 * 한 광고계정의 데이터 새로고침.
 * 활성 계정 = 현재 페이지에서 직접 fetch (백그라운드 탭 X).
 * 다른 계정 = background hidden tab으로 위임 — 명시적 사용자 액션에서만 호출.
 */
async function refreshRow(
  entry: MultiAccountDirectoryEntry,
  activeNo: number | null,
  opts: { force: boolean } = { force: false },
): Promise<void> {
  console.log(
    `[multi-account/refreshRow] start ad=${entry.adAccountNo} active=${activeNo} force=${opts.force}`,
  );
  if (!opts.force) {
    const cached = await loadSnapshot(entry.adAccountNo);
    if (cached && isSnapshotFresh(cached)) return;
  }
  paintRowLoading(entry.adAccountNo);
  try {
    if (entry.adAccountNo === activeNo) {
      const payload = await collectActiveAccount(yesterdayKST());
      const snap: MultiAccountSnapshot = {
        adAccountNo: entry.adAccountNo,
        bizMoney: payload.bizMoney,
        yesterday: payload.yesterday,
        contracts: payload.contracts,
        fetched_at: new Date().toISOString(),
      };
      await saveSnapshot(snap);
      paintRow(entry.adAccountNo, snap);
    } else {
      const res = await collectOtherAccount(entry.adAccountNo);
      if (res?.ok) {
        const snap: MultiAccountSnapshot = {
          adAccountNo: entry.adAccountNo,
          bizMoney: res.bizMoney ?? null,
          yesterday: res.yesterday ?? null,
          contracts: res.contracts ?? [],
          fetched_at: new Date().toISOString(),
        };
        await saveSnapshot(snap);
        paintRow(entry.adAccountNo, snap);
      } else {
        paintRowError(entry.adAccountNo, res?.error ?? "데이터를 가져오지 못했어요");
      }
    }
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

function paintRow(adAccountNo: number, snap: MultiAccountSnapshot) {
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

/**
 * 다른 계정 데이터 수집 — background hidden tab으로 위임.
 * background가 chrome.tabs.create({active:false})로 그 계정 페이지를 띄워
 * SPA가 정상 init된 후 콘텐츠 스크립트가 활성 계정 fetch.
 * iframe 방식은 광고관리자 SPA가 iframe 안에서 활성 계정 컨텍스트를 안 잡아서 폐기.
 */
/**
 * Port API로 background와 통신 — sendMessage의 "channel closed before response" 회피.
 * Port는 long-lived connection이라 MV3 service worker가 idle 종료되어도 응답 안전.
 */
interface CollectOtherResult {
  ok: boolean;
  bizMoney?: number | null;
  yesterday?: MultiAccountSnapshot["yesterday"];
  contracts?: MultiAccountSnapshot["contracts"];
  error?: string;
}

/**
 * Port API로 background와 통신 — sendMessage의 "channel closed before response" 회피.
 * Port는 long-lived connection이라 MV3 service worker가 idle 종료되어도 응답 안전.
 */
async function collectOtherAccount(adAccountNo: number): Promise<CollectOtherResult> {
  console.log(`[multi-account/collectOther] port.connect ad=${adAccountNo}`);
  return new Promise<CollectOtherResult>((resolve) => {
    const port = chrome.runtime.connect({ name: "dvads-multi-account-collect" });
    let settled = false;
    const settle = (res: CollectOtherResult) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch {}
      resolve(res);
    };
    port.onMessage.addListener((res: CollectOtherResult) => {
      console.log(`[multi-account/collectOther] port message ad=${adAccountNo}`, res);
      settle(res);
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      const err = chrome.runtime.lastError?.message ?? "포트 연결 끊김";
      console.warn(`[multi-account/collectOther] port disconnect ad=${adAccountNo}`, err);
      settle({ ok: false, error: err });
    });
    port.postMessage({ type: "MULTI_ACCOUNT_COLLECT_ACCOUNT", adAccountNo });
  });
}

function friendlyMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.includes("HTTP 401") || raw.includes("HTTP 403")) {
    return "광고관리자 로그인이 만료됐을 수 있어요. 페이지를 새로고침 후 다시 시도해주세요.";
  }
  if (raw.includes("HTTP 5")) {
    return "서버가 잠시 응답하지 않아요. 잠시 후 다시 시도해주세요.";
  }
  if (raw.includes("Could not establish connection")) {
    return "다른 계정 탭과 통신하지 못했어요.";
  }
  return "데이터를 가져오지 못했어요.";
}
