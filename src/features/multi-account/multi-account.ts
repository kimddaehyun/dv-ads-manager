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
  refreshFromServer,
  updateUserMeta,
  updateUserMetaMany,
  loadAddedList,
  addAccountToList,
  addAccountsToList,
  removeAccountFromList,
  removeAccountsFromList,
  loadSnapshot,
  loadSnapshotMany,
  saveSnapshot,
  isSnapshotFresh,
  clearAllSnapshots,
  clearSnapshots,
  loadPlatformFilter,
  savePlatformFilter,
  loadAgencyIdentity,
  saveAgencyIdentity,
  loadGroups,
  pushAndSaveGroups,
  createGroup,
  renameGroup,
  deleteGroup,
  reorderGroups,
  restoreGroup,
  removeAccountsFromAllGroups,
  loadChangeWatchIdentity,
  saveChangeWatchIdentity,
  loadChangeWatchState,
  loadChangeWatchStateMany,
  saveChangeWatchState,
  clearChangeWatchStates,
  isChangeWatchFresh,
  unreadChangeWatchEvents,
  readUpToFor,
  CHANGE_WATCH_TTL_MS,
  CHANGE_WATCH_BOOTSTRAP_MS,
  CHANGE_WATCH_KEEP_MS,
  type PlatformFilter,
} from "@/features/multi-account/multi-account-storage";
import {
  fetchAllDirectory,
  collectAccount,
  yesterdayKST,
  fetchAgencyOperation,
  fetchBizMoney,
  fetchYesterdayCost,
  type AgencyOperationOutcome,
  type AgencyOperationRow,
} from "@/features/multi-account/multi-account-data";
import { fetchChangeHistory, classifyHistory, observedActors } from "@/features/change-watch/change-watch";
import type {
  MultiAccountDirectoryCache,
  MultiAccountDirectoryEntry,
  MultiAccountUserMeta,
  MultiAccountGroup,
  MultiAccountSnapshot,
  ChangeWatchState,
  ChangeWatchEvent,
} from "@/types/storage";
import { attachActionMenu, closeAllOpenDropdowns, type ActionMenuItem } from "@/shared/ui-dropdown";
import { openInputDialog } from "@/shared/input-dialog";
import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { showToast } from "@/shared/toast";
// "@/features/setup/setup"·"@/features/report/report"은 write-excel-file/fflate(무거운 의존성)을 끌어와 콘텐츠 초기 번들을
// 부풀린다. 호출 직전 동적 import로 분리해 별도 청크로 빠지게 한다(첫 클릭 시 1회 로드).

const ADACCT_URL_PATTERN = /\/manage\/ad-accounts\//;
const BTN_MARK = "data-dvads-multi-btn";

// findOperationChip 전체 span 순회 백오프 — 헤더 칩이 지속적으로 안 보이면(서브페이지 등)
// 매 tick 전체 순회가 낭비라 연속 미스가 임계 이상 쌓이면 일정 간격으로 건너뛴다.
const CHIP_SCAN_MISS_THRESHOLD = 10; // 연속 미스(약 3초)까지는 매 tick 그대로 순회
const CHIP_SCAN_BACKOFF_MS = 1500; // 임계 초과 시 전체 순회 최소 간격
let chipScanMissStreak = 0;
let chipScanSkipUntil = 0;

let buttonEl: HTMLButtonElement | null = null;
let lastButtonContainer: HTMLElement | null = null;
let popoverEl: HTMLDivElement | null = null;
let directoryFetchInFlight: Promise<void> | null = null;
// 광고 유형 필터 — 검색광고(SA)/디스플레이(GFA) 표시 토글. popover 열 때 storage에서 로드.
// collectAccount는 storage를 직접 읽으므로 이건 메뉴 체크 표시용 미러.
let platformFilter: PlatformFilter = { sa: true, da: true };
// popover를 열 때마다 서버 최신 상태로 로컬 캐시를 새로고침 — 중복 실행 방지용 in-flight 플래그.
let serverRefreshInFlight = false;

// F-Accounts(Task 9) — 별칭/그룹/추가목록 저장은 이제 서버 push가 먼저 일어나고 실패 시 throw한다.
// 기존엔 chrome.storage.local만 썼기 때문에 거의 실패하지 않아 대부분의 호출부가 에러를 다루지
// 않았다(그대로 두면 unhandled rejection으로 조용히 사라진다). 서버 저장류 호출을 이 헬퍼로
// 감싸 실패 시 토스트로 알리고, 이어지는 로컬 상태 갱신/렌더는 건너뛴다(undefined 반환으로 신호).
async function withServerSave<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.warn("[multi-account] 서버 저장 실패", e);
    showToast({ message: "저장하지 못했어요. 잠시 후 다시 시도해 주세요", variant: "error" });
    return undefined;
  }
}

export function initMultiAccount() {
  // 동일 origin에서 두 번 초기화되면 listener 중복 등록 방지
  const w = window as unknown as { __dvadsMultiAccountInit?: boolean };
  if (w.__dvadsMultiAccountInit) return;
  w.__dvadsMultiAccountInit = true;

  registerMessageListener();
  registerStorageListener();
  // 변경이력 주기 점검 — iframe(all_frames)에서 중복으로 돌지 않게 최상위 창에서만.
  // 실제 호출은 광고계정 페이지일 때만 나간다(changeWatchTick 내부 가드).
  if (window === window.top) startChangeWatchTimer();

  let lastUrl = location.href;
  const onTick = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // SPA 전환 시 헤더가 다시 그려지므로 칩 순회 백오프를 풀어 즉시 재탐색.
      chipScanMissStreak = 0;
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
    // 뒤로/앞으로도 SPA 전환이므로 칩 순회 백오프를 풀어 즉시 재탐색(onTick과 동일).
    chipScanMissStreak = 0;
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
// in-flight 가드 — collectAccount(수 초, ~10콜)가 도는 동안 같은 계정 안에서 SPA URL이
// 연속으로 바뀌면(캠페인 목록 → 그룹 상세 → 키워드 탭) 스냅샷 저장 전이라 fresh 체크를
// 매번 통과해 동일 계정 수집이 중복 실행된다. 계정번호 단위로 1개만 허용.
const autoUpdateInFlight = new Set<number>();

async function autoUpdateActiveAccount() {
  const activeNo = extractActiveAdAccountNo();
  if (activeNo === null) return;
  if (autoUpdateInFlight.has(activeNo)) return;
  autoUpdateInFlight.add(activeNo);
  try {
    // stale 체크 — 신선한 캐시가 있으면 굳이 다시 안 부름
    const cached = await loadSnapshot(activeNo);
    if (cached && isSnapshotFresh(cached)) return;
    const dir = await loadDirectory();
    const entry = dir?.entries.find((e) => e.adAccountNo === activeNo);
    if (!entry?.masterCustomerId) return; // directory가 아직 안 받아왔거나 customerId 없는 계정 — skip
    const payload = await collectAccount(activeNo, entry.masterCustomerId, yesterdayKST());
    const snap: MultiAccountSnapshot = {
      adAccountNo: activeNo,
      bizMoney: payload.bizMoney,
      yesterday: payload.yesterday,
      contracts: payload.contracts,
      issues: payload.issues,
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
  } finally {
    autoUpdateInFlight.delete(activeNo);
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
  // 버튼이 컨테이너에 그대로 살아있으면 칩 재탐색(querySelector + rect 읽기) 자체를 생략 —
  // steady state에서 300ms 인터벌이 매 tick DOM/layout 읽기를 만들지 않게 한다.
  // 헤더가 SPA로 다시 그려지면 버튼이 detach되어 이 가드를 통과 못 하고 아래 re-mount로 간다.
  if (buttonEl?.isConnected && lastButtonContainer?.isConnected) return;
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
  // 연속 미스가 임계 이상이면 전체 span 순회를 백오프 간격까지 건너뛴다. 임계 미만에선
  // 매 tick 그대로 순회해 일반 페이지 로드의 헤더 지연을 놓치지 않는다.
  const now = Date.now();
  if (chipScanMissStreak >= CHIP_SCAN_MISS_THRESHOLD && now < chipScanSkipUntil) return null;
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
        chipScanMissStreak = 0;
        chipParent.setAttribute("data-dvads-op-chip", "1");
        return chipParent;
      }
    }
    // wrapper 못 찾으면 텍스트 부모 자체 반환
    if (el.parentElement) {
      chipScanMissStreak = 0;
      el.parentElement.setAttribute("data-dvads-op-chip", "1");
      return el.parentElement;
    }
  }
  chipScanMissStreak++;
  if (chipScanMissStreak >= CHIP_SCAN_MISS_THRESHOLD) chipScanSkipUntil = now + CHIP_SCAN_BACKOFF_MS;
  return null;
}

async function openPopover() {
  closePopover();
  // 리포트 모듈을 미리 받아둔다. "리포트 생성"은 클릭 시점에 동적 import를 하는데, 그 첫 클릭만
  // 청크 로드를 기다리느라 아무 반응이 없어 "안 눌린다"로 보였다. popover를 여는 지금 시작해두면
  // 메뉴를 열어 고르는 사이에 끝나 클릭이 즉시 반응한다. 실패해도 클릭 때 다시 import 하므로 무해.
  void import("@/features/report/report").catch(() => {});
  // 서버 최신 상태로 로컬 캐시 새로고침 — 다른 기기/프로필에서 바뀐 별칭·그룹·추가목록 반영.
  // fire-and-forget: 실패해도 로컬 캐시로 그대로 렌더되고, 다음에 열 때 다시 시도된다.
  if (!serverRefreshInFlight) {
    serverRefreshInFlight = true;
    void refreshFromServer()
      .catch((e) => console.warn("[multi-account] 서버 새로고침 실패", e))
      .finally(() => {
        serverRefreshInFlight = false;
      });
  }
  // 광고 유형 필터 로드 (메뉴 체크 표시 동기화용). 실패해도 기본값(둘 다) 유지.
  platformFilter = await loadPlatformFilter().catch(() => ({ sa: true, da: true }));
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
  const inBrandTooltip = (t: Node): boolean =>
    !!brandTooltipEl?.contains(t);
  // 리포트 날짜 선택기(report-datepicker.ts)는 body에 portal로 띄워 popover 밖에 위치한다.
  // 그 안의 날짜/프리셋 클릭이 popover를 닫지 않도록 "내부"로 취급. (팝오버+달력+리스트 동시 유지)
  const inReportPicker = (t: Node): boolean =>
    !!document.querySelector(".dvads-rdp")?.contains(t);

  let mousedownInsidePopover = false;
  const onMouseDown = (e: MouseEvent) => {
    if (!popoverEl) return;
    const t = e.target as Node;
    mousedownInsidePopover =
      popoverEl.contains(t) ||
      (buttonEl?.contains(t) ?? false) ||
      inAuxModal(t) ||
      inBrandTooltip(t) ||
      inReportPicker(t);
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
    // 브랜드검색 알림 툴팁 내부 클릭(=연장하기 버튼)도 popover 닫지 않음.
    if (inBrandTooltip(e.target as Node)) return;
    // 리포트 날짜 선택기 내부 클릭도 popover 닫지 않음.
    if (inReportPicker(e.target as Node)) return;
    closePopover();
  };
  // 스크롤 잠금 — 위에 뜬 창만 스크롤되고 그 아래 창(계정 목록·호스트 페이지)은 멈춘다.
  // 계정 이슈 패널이 떠 있으면 패널 안에서만, 아니면 우리 오버레이 안에서만 스크롤 허용.
  // passive:false여야 preventDefault가 먹는다.
  const onWheelLock = (e: WheelEvent | TouchEvent) => {
    const t = e.target as HTMLElement | null;
    if (changePanelEl) {
      if (!t?.closest?.(".dvads-change-panel")) e.preventDefault();
      return;
    }
    if (!t?.closest?.('[class*="dvads"]')) e.preventDefault();
  };
  document.addEventListener("wheel", onWheelLock, { capture: true, passive: false });
  document.addEventListener("touchmove", onWheelLock, { capture: true, passive: false });
  document.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onMouseDown, true);
  // 같은 클릭이 listener에 잡히지 않도록 다음 tick부터 등록
  setTimeout(() => document.addEventListener("click", onClickOutside), 0);
  (wrap as unknown as { __cleanup: () => void }).__cleanup = () => {
    document.removeEventListener("keydown", onKey);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("click", onClickOutside);
    document.removeEventListener("wheel", onWheelLock, true);
    document.removeEventListener("touchmove", onWheelLock, true);
  };

  // 햄버거 → close 아이콘 모핑 트리거 (CSS transition)
  buttonEl?.classList.add("is-open");

  await renderPopoverBody(wrap);
}

export function closePopover() {
  if (!popoverEl) return;
  const cleanup = (popoverEl as unknown as { __cleanup?: () => void }).__cleanup;
  cleanup?.();
  popoverEl.remove();
  popoverEl = null;
  popoverView = "list";
  listSearchQuery = "";
  activeGroupFilter = "all";
  collapsedSectionKeys.clear();
  popoverFullscreen = false;
  headColSync = null;
  document.querySelector(".dvads-multi-backdrop")?.remove();
  selectedAccountNos.clear();
  // 브랜드검색 알림 툴팁 / 변경이력 패널 잔여 정리 — popover 떠 있을 때만 의미 있음.
  hideBrandTooltip();
  closeChangeWatchPanel();
  // close 아이콘 → 햄버거로 복귀
  buttonEl?.classList.remove("is-open");
}

type PopoverView = "list" | "search";
let popoverView: PopoverView = "list";

// 내 계정(list view) 검색 쿼리 — 추가된 계정만 필터링. 행 DOM은 그대로 두고
// display:none 토글로 visibility 제어 → 입력 중 focus 유지. popover 닫힐 때 초기화.
let listSearchQuery = "";

// 그룹 칩 필터 상태 — "all"(구획 전체) | groupId(그 그룹만) | "unassigned"(미지정만).
// "내 계정" view 전용. popover 닫힐 때 "all"로 리셋.
let activeGroupFilter = "all";

// 접힌 섹션 키(그룹 id 또는 "unassigned"). "전체" view에서만 섹션 헤더가 있어 접기 유효.
// 재렌더에도 접힘 유지, popover 닫힐 때 초기화.
const collapsedSectionKeys = new Set<string>();

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

// 분리형 헤더(list view)의 컬럼 폭 동기화 함수 — renderListView가 설정, popover 닫힐 때 해제.
// paintRow/검색 필터/그룹 접기처럼 컬럼 폭이 바뀔 수 있는 지점들이 scheduleHeadColSync로 호출.
// rAF 디바운스 — 연속 paintRow가 프레임당 1회만 측정하게.
let headColSync: (() => void) | null = null;
let headColSyncQueued = false;
function scheduleHeadColSync(): void {
  if (!headColSync || headColSyncQueued) return;
  headColSyncQueued = true;
  requestAnimationFrame(() => {
    headColSyncQueued = false;
    headColSync?.();
  });
}

async function renderListView(wrap: HTMLElement) {
  const token = ++renderListViewToken;
  // ─── 1단계: 모든 데이터 비동기 로드 (DOM 손대지 않음) ───
  // 이전엔 wrap.innerHTML="" 후 await loadSnapshot 했더니 그 사이 popover가 빈 상태로 깜빡임.
  // 모든 await을 *먼저* 끝낸 뒤 메모리에 새 DOM을 빌드 → 마지막에 단 한 번 replaceChildren으로
  // atomic swap. 기존 콘텐츠는 새 콘텐츠 준비 완료 시점까지 그대로 유지된다.
  const [dir, meta, addedList, groups] = await Promise.all([
    loadDirectory(),
    loadAllUserMeta(),
    loadAddedList(),
    loadGroups(),
  ]);
  if (token !== renderListViewToken) return;
  // 그룹이 삭제됐는데 그 그룹을 필터 중이면 "전체"로 복귀.
  if (
    activeGroupFilter !== "all" &&
    activeGroupFilter !== "unassigned" &&
    !groups.some((g) => g.id === activeGroupFilter)
  ) {
    activeGroupFilter = "all";
  }
  const entries = pickAddedEntries(dir?.entries ?? [], addedList);
  // 스냅샷을 storage.get 1회로 일괄 로드 (계정별 단건 순차 호출 제거).
  const snapMap = await loadSnapshotMany(entries.map((e) => e.adAccountNo));
  const snapshots = entries.map((e) => snapMap.get(e.adAccountNo) ?? null);
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

  // 그룹 칩 바 — 헤더 아래. 전체/각 그룹/미지정 필터 + 새 그룹 생성.
  fragment.appendChild(buildGroupChips(groups, wrap));

  // 헤더는 스크롤 영역 밖 별도 테이블로 분리 — sticky 미사용. sticky는 스크롤 오프셋이
  // 소수점(125% 배율·스무스 휠)일 때 고정 위치 반올림이 프레임마다 달라져 헤더가 1px씩
  // 움직이는 걸 피할 수 없다(2026-07-02 실측). 분리된 헤더는 스크롤과 물리적으로 무관.
  // 컬럼 정렬은 body 첫 가시 행의 셀 폭을 재서 헤더 th에 강제(syncHeadCols + ResizeObserver).
  const headWrap = document.createElement("div");
  headWrap.className = "dvads-multi-table-headwrap";
  const tableClassName =
    "dvads-bid-table dvads-multi-table" + (popoverFullscreen ? "" : " is-collapsed");
  const headTable = document.createElement("table");
  headTable.className = tableClassName;
  headTable.innerHTML = `
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
  `;
  headWrap.appendChild(headTable);

  const tableWrap = document.createElement("div");
  tableWrap.className = "dvads-multi-table-wrap";
  const table = document.createElement("table");
  table.className = tableClassName;
  table.innerHTML = `<tbody></tbody>`;
  // 헤더 정렬 클릭
  headTable.querySelectorAll<HTMLTableCellElement>("th.dvads-multi-th-sort").forEach((th) => {
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
  // 그룹별 섹션으로 나눠 렌더. 섹션 헤더(그룹명/합계/접기 밴드)는 "전체" view + 그룹이 있을 때만.
  // 특정 그룹 탭(또는 미지정)을 고르면 그 리스트만 나오므로 헤더 밴드가 불필요 → 생략.
  const sections = buildSections(sorted, groups);
  const sectioned = activeGroupFilter === "all" && groups.length > 0;
  for (const section of sections) {
    const key = section.group ? section.group.id : "unassigned";
    const collapsed = sectioned && collapsedSectionKeys.has(key);
    if (sectioned) {
      tbody.appendChild(buildSectionHeaderRow(section, wrap));
    }
    for (const { entry } of section.rows) {
      const tr = renderTableRow(entry, meta[entry.adAccountNo]);
      tr.dataset.sectionKey = key;
      if (collapsed) tr.style.display = "none";
      tbody.appendChild(tr);
    }
  }
  tableWrap.appendChild(table);
  fragment.appendChild(headWrap);
  fragment.appendChild(tableWrap);

  // 분리형 헤더 컬럼 폭 동기화 — body 첫 가시 행의 셀 폭(border-box)을 th에 그대로 적용.
  // ResizeObserver가 attach 직후 1회 + 테이블 폭 변화(크게 보기·스크롤바 증감) 시 재동기화.
  // 데이터 도착(paintRow)·검색 필터·그룹 접기는 scheduleHeadColSync 훅이 커버.
  // 폭 측정은 getComputedStyle — getBoundingClientRect는 popover 진입 애니메이션(scale 0.97→1)
  // 도중 축소된 값을 줘서 컬럼이 ~2% 좁게 어긋난다(실측). computed width는 transform 무관 레이아웃 값.
  const syncHeadCols = () => {
    if (!headTable.isConnected || !table.isConnected) return;
    let src: HTMLTableRowElement | null = null;
    for (const r of table.querySelectorAll<HTMLTableRowElement>("tbody tr")) {
      if (r.offsetHeight > 0) { src = r; break; }
    }
    if (!src) return;
    const ths = headTable.querySelectorAll<HTMLTableCellElement>("thead th");
    if (ths.length !== src.children.length) return;
    headTable.style.width = getComputedStyle(table).width;
    for (let i = 0; i < ths.length; i++) {
      const cell = src.children[i] as HTMLElement;
      if (cell.offsetWidth > 0) ths[i].style.width = getComputedStyle(cell).width;
    }
  };
  headColSync = syncHeadCols;
  const headColRO = new ResizeObserver(() => scheduleHeadColSync());
  headColRO.observe(table); // 외곽 폭 변화(크게 보기·뷰포트 리사이즈·스크롤바 증감)
  headColRO.observe(tbody); // 행 증감 등 외곽 폭이 안 변하는 reflow 일부 감지
  // 폰트 로드는 표 외곽 크기를 안 바꾸고 내부 컬럼 폭만 바꿔 RO가 못 잡는다 — 명시 훅.
  void document.fonts.ready.then(() => scheduleHeadColSync());

  // ─── 3단계: 단일 atomic swap. 깜빡임 0 ───
  // swap 직전 마지막 token 체크 — 빌드 중 rapid 클릭으로 더 새 render가 시작됐다면 포기.
  if (token !== renderListViewToken) return;
  wrap.replaceChildren(fragment);

  // ─── 4단계: paint (이제 table이 popoverEl 서브트리에 있어 findRow 동작) ───
  // 캐시가 있으면 즉시 표시. 없는 행은 직후 backgroundRefreshStale이 반드시 새로고침하므로
  // "-" 대신 스켈레톤으로 시작해 로딩 중임을 보여준다 (데이터 도착 시 paintRow가 교체).
  for (const { entry, snap } of sorted) {
    if (snap) paintRow(entry.adAccountNo, snap, meta[entry.adAccountNo]);
    else paintRowLoading(entry.adAccountNo);
  }
  // 변경이력 알림 칩 — 스냅샷과 별개 저장소라 따로 칠한다(fire-and-forget, 캐시 기준 즉시 표시).
  void paintChangeWatchRows(sorted.map((s) => s.entry.adAccountNo));
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
  // 변경이력도 같은 요령으로 — TTL(30분) 지난 계정만 조용히 재점검. 스냅샷과 주기가 달라
  // 별도 호출이고, 자체 in-flight 가드가 있어 주기 타이머와 겹쳐도 안전.
  void scanChangeWatchAll(entries, false);
}

/**
 * 추가된 계정 명단 안에서 substring 필터 적용. 행 DOM을 재빌드하지 않고 display:none 토글
 * → input focus/cursor 유지. tr.dataset.searchHaystack(renderTableRow에서 세팅)을 활용.
 */
function applyListSearchFilter(wrap: HTMLElement, query: string): void {
  const q = query.trim().toLowerCase();
  const rows = wrap.querySelectorAll<HTMLTableRowElement>("tr.dvads-multi-tr");
  rows.forEach((row) => {
    // 섹션 헤더가 있고 접혀 있으면 검색과 무관하게 숨김 유지. 특정 그룹 필터(헤더 없음)에선 항상 표시.
    const key = row.dataset.sectionKey;
    const header = key
      ? wrap.querySelector<HTMLElement>(`tr.dvads-multi-group-tr[data-section-key="${key}"]`)
      : null;
    const collapsed = header?.classList.contains("is-collapsed") ?? false;
    const hay = row.dataset.searchHaystack || "";
    const match = !q || hay.includes(q);
    row.style.display = match && !collapsed ? "" : "none";
  });
  // 그룹 섹션 헤더 — 검색 중일 땐 보이는 계정 행이 하나도 없는 섹션 헤더를 숨긴다(빈 구획 방지).
  // 검색어가 없으면 헤더는 항상 표시(빈 그룹도 관리 가능하도록).
  wrap.querySelectorAll<HTMLTableRowElement>("tr.dvads-multi-group-tr").forEach((header) => {
    const key = header.dataset.sectionKey;
    if (!q || !key) {
      header.style.display = "";
      return;
    }
    const anyVisible = Array.from(
      wrap.querySelectorAll<HTMLElement>(`tr.dvads-multi-tr[data-section-key="${key}"]`),
    ).some((r) => r.style.display !== "none");
    header.style.display = anyVisible ? "" : "none";
  });
  // 가시 행 구성이 바뀌면 auto layout 컬럼 폭도 바뀔 수 있음 — 분리형 헤더 재동기화.
  scheduleHeadColSync();
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
    // 배치 시작 시 1회만 읽어 계정마다 storage 중복 조회 방지 (refreshAllStale과 동일).
    const platforms = await loadPlatformFilter().catch(
      () => ({ sa: true, da: true }) as PlatformFilter,
    );
    const metaAll = await loadAllUserMeta();
    const queue = [...stale];
    const workers = Array.from(
      { length: Math.min(REFRESH_ALL_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length > 0) {
          const entry = queue.shift();
          if (!entry) break;
          try {
            await refreshRow(entry, activeNo, { force: false, platforms, metaAll });
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

// ─── 그룹(팀원별) 렌더링 ───

type SortedRow = { entry: MultiAccountDirectoryEntry; snap: MultiAccountSnapshot | null };
interface Section {
  group: MultiAccountGroup | null; // null = 미지정
  rows: SortedRow[];
}

// 정렬된 계정을 activeGroupFilter에 따라 섹션으로 나눈다. 정렬은 sorted 순서를 그대로 유지하므로
// 각 섹션도 정렬 상태. 한 계정이 여러 그룹에 속하면 여러 섹션에 중복 등장(의도된 동작).
function buildSections(sorted: SortedRow[], groups: MultiAccountGroup[]): Section[] {
  if (activeGroupFilter === "unassigned") {
    const assigned = new Set(groups.flatMap((g) => g.accountNos));
    return [{ group: null, rows: sorted.filter((s) => !assigned.has(s.entry.adAccountNo)) }];
  }
  if (activeGroupFilter !== "all") {
    const g = groups.find((x) => x.id === activeGroupFilter) ?? null;
    const rows = g ? sorted.filter((s) => g.accountNos.includes(s.entry.adAccountNo)) : [];
    return [{ group: g, rows }];
  }
  // "전체" — 그룹 없으면 평평한 단일 섹션(헤더 없이 렌더).
  if (groups.length === 0) return [{ group: null, rows: sorted }];
  const sections: Section[] = groups.map((g) => ({
    group: g,
    rows: sorted.filter((s) => g.accountNos.includes(s.entry.adAccountNo)),
  }));
  const assigned = new Set(groups.flatMap((g) => g.accountNos));
  const unassigned = sorted.filter((s) => !assigned.has(s.entry.adAccountNo));
  if (unassigned.length > 0) sections.push({ group: null, rows: unassigned });
  return sections;
}

// 섹션의 비즈머니/광고비/매출/ROAS 합계 — 스냅샷이 있는 계정만 합산.
// 비즈머니는 어제 데이터와 별개(스냅샷 있으면 언제나) → hasBiz/hasYesterday를 따로 추적.
// ROAS는 합산 매출÷합산 광고비(가중 평균). 광고비 0이면 NaN → formatPercent가 "-" 처리.
// 어제·비즈머니 둘 다 없으면 null("-" 표시).
function computeSectionSubtotal(rows: SortedRow[]): {
  bizMoney: number | null;
  cost: number;
  revenue: number;
  roas: number;
  hasYesterday: boolean;
} | null {
  let cost = 0;
  let revenue = 0;
  let bizMoney = 0;
  let hasYesterday = false;
  let hasBiz = false;
  for (const { snap } of rows) {
    if (snap?.yesterday) {
      cost += snap.yesterday.cost;
      revenue += snap.yesterday.revenue;
      hasYesterday = true;
    }
    if (snap?.bizMoney != null) {
      bizMoney += snap.bizMoney;
      hasBiz = true;
    }
  }
  if (!hasYesterday && !hasBiz) return null;
  const roas = cost > 0 ? (revenue / cost) * 100 : NaN;
  return { bizMoney: hasBiz ? bizMoney : null, cost, revenue, roas, hasYesterday };
}

// 그룹 탭 바 — [‹] [캡슐: 전체 | 그룹... | 미지정] [›] [+ 그룹].
// 캡슐 = 세그먼트 컨트롤(회색 트랙 + 선택 탭 흰 카드). 그룹이 넘치면 좌우 화살표로 스크롤
// (화살표는 넘칠 때만 노출, 탭 바로 양옆). 스크롤바는 숨기고 화살표로만 이동.
function buildGroupChips(groups: MultiAccountGroup[], wrap: HTMLElement): HTMLElement {
  const row = document.createElement("div");
  row.className = "dvads-multi-grouptabs";

  const capsule = document.createElement("div");
  capsule.className = "dvads-multi-groupchips";

  const makeArrow = (dir: -1 | 1): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dvads-multi-grouptabs-arrow";
    btn.setAttribute("aria-label", dir < 0 ? "이전" : "다음");
    const path = dir < 0 ? "M10 4 L6 8 L10 12" : "M6 4 L10 8 L6 12";
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      capsule.scrollBy({ left: dir * 140, behavior: "smooth" });
    });
    return btn;
  };
  const leftArrow = makeArrow(-1);
  const rightArrow = makeArrow(1);

  // 드래그 중인 그룹 id — dragstart에서 채우고 dragend에서 비운다. 재정렬 drop 대상(다른 칩)과
  // 휴지통 drop이 공유. dataTransfer.getData가 dragover에서 막히는 브라우저가 있어 클로저로 보관.
  let dragId: string | null = null;
  const clearHints = () => {
    capsule
      .querySelectorAll(".dvads-multi-chip.is-drop-target")
      .forEach((el) => el.classList.remove("is-drop-target"));
  };

  // group이 있으면 실제 그룹 탭 — 드래그로 순서 이동 + 다른 그룹 칩 위로 drop 시 재정렬.
  // group 없으면 "전체"/"미지정" 필터 칩(드래그·drop 대상 아님).
  const addChip = (key: string, label: string, group?: MultiAccountGroup) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dvads-multi-chip" + (activeGroupFilter === key ? " is-active" : "");
    btn.textContent = label;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (activeGroupFilter === key) return;
      activeGroupFilter = key;
      void renderListView(wrap);
    });

    if (group) {
      btn.draggable = true;
      btn.addEventListener("dragstart", (e) => {
        dragId = group.id;
        e.dataTransfer?.setData("text/plain", group.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        row.classList.add("is-dragging");
        // 다음 프레임에 dim — 같은 프레임에 주면 drag image까지 반투명해짐.
        requestAnimationFrame(() => btn.classList.add("is-dragging"));
      });
      btn.addEventListener("dragend", () => {
        dragId = null;
        btn.classList.remove("is-dragging");
        row.classList.remove("is-dragging");
        clearHints();
      });
      // 다른 그룹 칩을 drop 대상으로 — 이 칩 위로 놓으면 그 위치로 재정렬.
      btn.addEventListener("dragover", (e) => {
        if (!dragId || dragId === group.id) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        btn.classList.add("is-drop-target");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("is-drop-target"));
      btn.addEventListener("drop", (e) => {
        if (!dragId || dragId === group.id) return;
        e.preventDefault();
        e.stopPropagation();
        const from = dragId;
        btn.classList.remove("is-drop-target");
        void (async () => {
          const result = await withServerSave(() => reorderGroups(from, group.id));
          if (result === undefined) return;
          if (popoverEl) await renderListView(popoverEl);
        })();
      });
    }

    capsule.appendChild(btn);
  };

  addChip("all", "전체");
  for (const g of groups) addChip(g.id, g.name, g);
  addChip("unassigned", "미지정");

  // 휴지통 — 평소 숨김(CSS display:none), 드래그 시작 시에만 노출(row.is-dragging).
  // 그룹 칩을 여기 놓으면 삭제 + 5초 되돌리기 토스트. 계정 자체는 "내 계정"에 남고 소속만 해제.
  const trash = document.createElement("button");
  trash.type = "button";
  trash.className = "dvads-multi-grouptabs-trash";
  trash.setAttribute("aria-label", "그룹 삭제");
  trash.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M12.5 4l-.7 9a1 1 0 0 1-1 .9H5.2a1 1 0 0 1-1-.9L3.5 4M6.5 6.8v4.4M9.5 6.8v4.4"/></svg>`;
  trash.addEventListener("dragover", (e) => {
    if (!dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    trash.classList.add("is-hot");
  });
  trash.addEventListener("dragleave", () => trash.classList.remove("is-hot"));
  trash.addEventListener("drop", (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragId;
    trash.classList.remove("is-hot");
    const target = groups.find((g) => g.id === id);
    if (!target) return;
    const cnt = target.accountNos.length;
    openDeleteConfirm({
      title: "그룹 삭제",
      message: cnt > 0
        ? `'${target.name}' 그룹과 그 안의 계정 ${cnt}개를 삭제할까요? 계정도 '내 계정'에서 함께 제거됩니다.`
        : `'${target.name}' 그룹을 삭제할까요?`,
      onConfirm: () => deleteGroupAndAccounts(target),
    });
  });

  const add = document.createElement("button");
  add.type = "button";
  add.className = "dvads-multi-chip-add";
  add.textContent = "+ 그룹";
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    openNameDialog({
      title: "새 그룹 만들기",
      initialValue: "",
      confirmLabel: "만들기",
      onSave: async (name) => {
        const list = await withServerSave(() => createGroup(name));
        if (list === undefined) return;
        // 방금 만든 그룹으로 필터 이동 — 바로 계정을 배정하기 편하게.
        const created = list[list.length - 1];
        if (created) activeGroupFilter = created.id;
        if (popoverEl) await renderListView(popoverEl);
      },
    });
  });

  // 탭(캡슐)을 맨 왼쪽에. 화살표는 탭 뒤로 작게 배치, 휴지통은 드래그 중에만 노출, + 그룹은 맨 오른쪽(CSS margin-left:auto).
  row.append(capsule, leftArrow, rightArrow, trash, add);

  // 화살표 노출/활성 상태 갱신 — 넘칠 때만 노출(display). 안 넘칠 땐 자리까지 없애 뒤따르는
  // 휴지통이 캡슐(미지정 탭) 바로 옆에 붙게 한다(visibility로 자리를 남기면 그만큼 떨어져 보임).
  // 캡슐은 화살표 앞이라 이 토글로 탭 위치는 안 밀림. 양끝에선 해당 방향 화살표 dim.
  const updateArrows = () => {
    const maxScroll = capsule.scrollWidth - capsule.clientWidth;
    const scrollable = maxScroll > 1;
    leftArrow.style.display = scrollable ? "" : "none";
    rightArrow.style.display = scrollable ? "" : "none";
    leftArrow.disabled = capsule.scrollLeft <= 0;
    rightArrow.disabled = capsule.scrollLeft >= maxScroll - 1;
  };
  capsule.addEventListener("scroll", updateArrows);
  // DOM 부착 후 측정 — 선택 탭이 화면 밖이면 보이도록 스크롤 + 화살표 상태 초기화.
  requestAnimationFrame(() => {
    const active = capsule.querySelector<HTMLElement>(".dvads-multi-chip.is-active");
    if (active) {
      const aLeft = active.offsetLeft;
      const aRight = aLeft + active.offsetWidth;
      if (aLeft < capsule.scrollLeft) capsule.scrollLeft = aLeft - 4;
      else if (aRight > capsule.scrollLeft + capsule.clientWidth) {
        capsule.scrollLeft = aRight - capsule.clientWidth + 4;
      }
    }
    updateArrows();
  });

  return row;
}

// 섹션 헤더 행 — 접기 토글 + 그룹명/계정수 + 비즈머니/광고비/매출/ROAS 합계(컬럼 정렬) + 그룹 ⋮ 메뉴(미지정 제외).
// "전체" view에서만 렌더 — 특정 그룹 필터 시엔 밴드 없이 그 그룹 리스트만 표시.
function buildSectionHeaderRow(section: Section, wrap: HTMLElement): HTMLTableRowElement {
  const g = section.group;
  const key = g ? g.id : "unassigned";
  const collapsed = collapsedSectionKeys.has(key);
  const sub = computeSectionSubtotal(section.rows);
  const bizStr = sub && sub.bizMoney != null ? formatWon(sub.bizMoney) : "-";
  const costStr = sub && sub.hasYesterday ? formatWon(sub.cost) : "-";
  const revStr = sub && sub.hasYesterday ? formatWon(sub.revenue) : "-";
  const roasStr = sub && sub.hasYesterday ? formatPercent(sub.roas) : "-";

  const tr = document.createElement("tr");
  tr.className = "dvads-multi-group-tr" + (collapsed ? " is-collapsed" : "");
  tr.dataset.groupHeader = "1";
  tr.dataset.sectionKey = key;
  // 데이터 행과 동일하게 열마다 td 하나씩 + 같은 data-k → 작게 보기 모드의 열 숨김(td[data-k])이
  // 헤더에도 똑같이 적용되어 합계 칸이 각 열에 정확히 정렬된다(colspan 방식은 숨김과 어긋남).
  tr.innerHTML = `
    <td class="dvads-multi-td-cb dvads-multi-group-cb">${checkboxHTML(false, `${g ? g.name : "미지정"} 그룹 전체 선택`, "dvads-multi-cb-group")}</td>
    <td class="dvads-multi-td-name dvads-multi-group-head">
      <div class="dvads-multi-group-head-inner">
        <span class="dvads-multi-group-name">${g ? escapeHtml(g.name) : "미지정"}</span>
        <span class="dvads-multi-group-count">${section.rows.length}개</span>
      </div>
    </td>
    <td class="dvads-multi-td-num dvads-multi-group-subtotal" data-k="bizMoney">${bizStr}</td>
    <td class="dvads-multi-td-num" data-k="impressions"></td>
    <td class="dvads-multi-td-num" data-k="clicks"></td>
    <td class="dvads-multi-td-num" data-k="ctr"></td>
    <td class="dvads-multi-td-num" data-k="cpc"></td>
    <td class="dvads-multi-td-num dvads-multi-group-subtotal" data-k="cost">${costStr}</td>
    <td class="dvads-multi-td-num dvads-multi-group-subtotal" data-k="revenue">${revStr}</td>
    <td class="dvads-multi-td-num" data-k="conversions"></td>
    <td class="dvads-multi-td-num dvads-multi-group-subtotal" data-k="roas">${roasStr}</td>
    <td class="dvads-multi-td-act">${
      g ? '<button class="dvads-multi-action-trigger dvads-multi-group-action" type="button" aria-label="그룹 메뉴">⋯</button>' : ""
    }</td>
  `;

  const toggleCollapse = () => {
    const nowCollapsed = tr.classList.toggle("is-collapsed");
    if (nowCollapsed) collapsedSectionKeys.add(key);
    else collapsedSectionKeys.delete(key);
    popoverEl
      ?.querySelectorAll<HTMLElement>(`tr.dvads-multi-tr[data-section-key="${key}"]`)
      .forEach((r) => {
        r.style.display = nowCollapsed ? "none" : "";
      });
    // 펼칠 때 검색어가 있으면 필터 재적용(숨겨야 할 행 다시 숨김).
    if (!nowCollapsed && listSearchQuery) applyListSearchFilter(wrap, listSearchQuery);
    scheduleHeadColSync();
  };
  // 그룹명(밴드) 클릭 = 접기/펼치기. 좌측 체크박스는 아래에서 별도로 그룹 전체 선택을 담당.
  tr.querySelector<HTMLElement>(".dvads-multi-group-head")?.addEventListener("click", () => {
    toggleCollapse();
  });

  // 좌측 체크박스 = 그룹 전 계정 선택/해제. (체크 시 즉시 그룹 전체 선택)
  const groupNos = section.rows.map((r) => r.entry.adAccountNo);
  const groupCb = tr.querySelector<HTMLInputElement>(".dvads-multi-cb-group input");
  if (groupCb) {
    const allSel = groupNos.length > 0 && groupNos.every((no) => selectedAccountNos.has(no));
    groupCb.checked = allSel;
    groupCb.indeterminate = !allSel && groupNos.some((no) => selectedAccountNos.has(no));
    groupCb.addEventListener("click", (e) => e.stopPropagation());
    groupCb.addEventListener("change", () => {
      if (groupCb.checked) groupNos.forEach((no) => selectedAccountNos.add(no));
      else groupNos.forEach((no) => selectedAccountNos.delete(no));
      // 같은 계정이 여러 그룹에 속할 수 있어 화면의 모든 해당 행 체크박스를 함께 동기화.
      groupNos.forEach((no) => {
        popoverEl
          ?.querySelectorAll<HTMLInputElement>(
            `tr.dvads-multi-tr[data-ad-account-no="${no}"] .dvads-multi-cb input`,
          )
          .forEach((el) => {
            el.checked = groupCb.checked;
          });
      });
      if (popoverEl) updateBulkActionUI(popoverEl);
    });
  }

  if (g) {
    const trigger = tr.querySelector<HTMLButtonElement>(".dvads-multi-group-action");
    if (trigger) {
      attachActionMenu({
        trigger,
        ariaLabel: `${g.name} 그룹 메뉴`,
        items: () => groupHeaderMenuItems(g, section.rows),
      });
    }
  }
  return tr;
}

// 그룹 삭제 = 그룹 + 그 안의 계정까지 함께 제거("내 계정" 명단·스냅샷 정리). 되돌리기로 그룹과
// 계정을 복원한다(스냅샷은 복원 대상 아님 — 새로고침 시 다시 불러옴).
async function deleteGroupAndAccounts(group: MultiAccountGroup): Promise<void> {
  const nos = [...group.accountNos];
  const deleted = await withServerSave(() => deleteGroup(group.id));
  if (deleted === undefined) return;
  if (nos.length > 0) {
    const removed = await withServerSave(() => removeAccountsFromList(nos));
    if (removed === undefined) return;
    await clearSnapshots(nos);
  }
  if (activeGroupFilter === group.id) activeGroupFilter = "all";
  collapsedSectionKeys.delete(group.id);
  if (popoverEl) await renderListView(popoverEl);
  showToast({
    message:
      nos.length > 0
        ? `'${group.name}' 그룹과 계정 ${nos.length}개를 삭제했어요`
        : `'${group.name}' 그룹을 삭제했어요`,
    variant: "success",
    keyword: group.name,
    undo: {
      label: "되돌리기",
      onClick: () => {
        void (async () => {
          const restored = await withServerSave(() => restoreGroup(group));
          if (restored === undefined) return;
          if (nos.length > 0) {
            const added = await withServerSave(() => addAccountsToList(nos));
            if (added === undefined) return;
          }
          if (popoverEl) await renderListView(popoverEl);
        })();
      },
    },
  });
}

function groupHeaderMenuItems(g: MultiAccountGroup, rows: SortedRow[]): ActionMenuItem[] {
  const entries = rows.map((r) => r.entry);
  const nos = entries.map((e) => e.adAccountNo);
  return [
    {
      label: "대행권 점검",
      onClick: () => void runAgencyCheck(nos),
    },
    {
      label: "리포트 생성",
      keepOpen: true,
      disabled: nos.length === 0,
      onClick: (anchor) => void openReportForEntries(anchor, entries),
    },
    { separator: true },
    {
      label: "그룹 이름 변경",
      onClick: () =>
        openNameDialog({
          title: "그룹 이름 변경",
          initialValue: g.name,
          onSave: async (name) => {
            const result = await withServerSave(() => renameGroup(g.id, name));
            if (result === undefined) return;
            if (popoverEl) await renderListView(popoverEl);
          },
        }),
    },
    {
      label: "그룹 삭제",
      danger: true,
      onClick: () => {
        // 그룹과 그 안의 계정까지 함께 삭제(확인 후, 되돌리기 제공).
        const cnt = g.accountNos.length;
        openDeleteConfirm({
          title: "그룹 삭제",
          message: cnt > 0
            ? `'${g.name}' 그룹과 그 안의 계정 ${cnt}개를 삭제할까요? 계정도 '내 계정'에서 함께 제거됩니다.`
            : `'${g.name}' 그룹을 삭제할까요?`,
          onConfirm: () => deleteGroupAndAccounts(g),
        });
      },
    },
  ];
}

// 다중 리포트 진입 — 헤더 "설정" 메뉴와 그룹 헤더 메뉴가 공유. anchor 위치는 동적 import 전에
// 동기 캡처(keepOpen 메뉴가 populate로 버튼을 떼어내도 rect 보존).
// await 두 번(메타 로드 + 모듈 로드) 동안은 화면에 아무 변화가 없다 — 그 사이 또 눌러 두 번
// 열리는 걸 막는 게이트. 모듈은 openPopover에서 미리 받아두므로 보통은 즉시 통과한다.
let reportEntryBusy = false;
async function openReportForEntries(
  anchor: HTMLElement,
  entries: MultiAccountDirectoryEntry[],
): Promise<void> {
  if (reportEntryBusy) return;
  reportEntryBusy = true;
  const anchorRect = anchor.getBoundingClientRect();
  try {
    const metaMap = await loadAllUserMeta();
    const { openReportFlowBatch } = await import("@/features/report/report");
    openReportFlowBatch(
      anchor,
      entries.map((e) => ({
        adAccountNo: e.adAccountNo,
        masterCustomerId: e.masterCustomerId,
        name: metaMap[e.adAccountNo]?.displayName?.trim() || e.name,
      })),
      anchorRect,
    );
  } catch (e) {
    // 여기서 던지면 호출부가 `void`로 삼켜 아무 반응 없이 사라진다 — 반드시 알린다.
    console.warn("[dv-ads/report] 리포트 화면을 열지 못함", e);
    showToast({ message: "리포트 화면을 열지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
  } finally {
    reportEntryBusy = false;
  }
}

// 범용 텍스트 입력 다이얼로그 — 그룹 생성/이름 변경용. rename 다이얼로그 CSS(dvads-rename-*) 재사용.
function openNameDialog(opts: {
  title: string;
  initialValue: string;
  confirmLabel?: string;
  onSave: (name: string) => void | Promise<void>;
}): void {
  closeRenameDialog();
  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-rename-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-rename-card";
  card.innerHTML = `
    <div class="dvads-rename-title">${escapeHtml(opts.title)}</div>
    <div class="dvads-rename-input-wrap">
      <input class="dvads-rename-input" type="text" maxlength="24" placeholder="이름 입력" />
      <button class="dvads-rename-clear" type="button" aria-label="입력 지우기">×</button>
    </div>
    <div class="dvads-rename-actions">
      <button class="dvads-rename-cancel" type="button">취소</button>
      <button class="dvads-rename-save" type="button">${escapeHtml(opts.confirmLabel ?? "저장")}</button>
    </div>
  `;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const input = card.querySelector<HTMLInputElement>(".dvads-rename-input")!;
  input.value = opts.initialValue;
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);

  const cleanup = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const save = async () => {
    const v = input.value.trim().slice(0, 24);
    if (!v) return;
    cleanup();
    await opts.onSave(v);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void save(); }
  };
  wireBackdropDismiss(backdrop, cleanup);
  card.addEventListener("click", (e) => e.stopPropagation());
  card.querySelector<HTMLButtonElement>(".dvads-rename-cancel")?.addEventListener("click", cleanup);
  card.querySelector<HTMLButtonElement>(".dvads-rename-save")?.addEventListener("click", () => void save());
  card.querySelector<HTMLButtonElement>(".dvads-rename-clear")?.addEventListener("click", () => {
    input.value = "";
    input.focus();
  });
  document.addEventListener("keydown", onKey, true);
}

// 삭제 확인 다이얼로그 — rename 카드 재사용. 위험 동작(그룹/계정 삭제) 전 한 번 확인.
function openDeleteConfirm(opts: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}): void {
  closeRenameDialog();
  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-rename-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-rename-card dvads-confirmdel-card";
  card.innerHTML = `
    <div class="dvads-rename-title">${escapeHtml(opts.title)}</div>
    <div class="dvads-confirmdel-msg">${escapeHtml(opts.message)}</div>
    <div class="dvads-rename-actions">
      <button class="dvads-rename-cancel" type="button">취소</button>
      <button class="dvads-rename-save dvads-rename-danger" type="button">${escapeHtml(opts.confirmLabel ?? "삭제")}</button>
    </div>
  `;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const cleanup = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const confirm = async () => {
    cleanup();
    await opts.onConfirm();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void confirm(); }
  };
  wireBackdropDismiss(backdrop, cleanup);
  card.addEventListener("click", (e) => e.stopPropagation());
  card.querySelector<HTMLButtonElement>(".dvads-rename-cancel")?.addEventListener("click", cleanup);
  card.querySelector<HTMLButtonElement>(".dvads-rename-save")?.addEventListener("click", () => void confirm());
  document.addEventListener("keydown", onKey, true);
}

// 그룹으로 이동 다이얼로그 — 폴더 이동 스타일(단일 선택). 계정(들)을 그룹 하나로 이동하거나
// "그룹 없음"으로 미지정 처리. "이동" 시 대상 계정을 전 그룹에서 빼고 고른 그룹 하나에만 넣는다
// (건드리지 않은 다른 계정의 소속은 그대로). 참고: 여러 그룹에 걸친 계정은 이동 시 하나로 정리됨.
const FOLDER_ICON =
  '<svg class="dvads-groupmove-icon-svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FOLDER_NONE_ICON =
  '<svg class="dvads-groupmove-icon-svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="9" y1="13" x2="15" y2="13"/></svg>';

async function openGroupAssignDialog(nos: number[]): Promise<void> {
  if (nos.length === 0) return;
  closeRenameDialog();
  const groups = await loadGroups();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-rename-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-rename-card dvads-groupmove-card";
  card.innerHTML = `
    <div class="dvads-groupmove-head">
      <div class="dvads-rename-title">그룹으로 이동</div>
      <button class="dvads-groupmove-close" type="button" aria-label="닫기">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
    </div>
    <div class="dvads-groupmove-list"></div>
    <div class="dvads-rename-actions">
      <button class="dvads-rename-cancel" type="button">취소</button>
      <button class="dvads-rename-save" type="button" disabled>이동</button>
    </div>
  `;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const listEl = card.querySelector<HTMLDivElement>(".dvads-groupmove-list")!;
  const saveBtn = card.querySelector<HTMLButtonElement>(".dvads-rename-save")!;

  // undefined = 아무것도 안 고름(이동 비활성), null = 그룹 없음, string = 그룹 id
  let selectedGid: string | null | undefined = undefined;

  const selectGid = (gid: string | null) => {
    selectedGid = gid;
    const key = gid ?? "__none__";
    listEl.querySelectorAll<HTMLElement>(".dvads-groupmove-row").forEach((el) => {
      el.classList.toggle("is-selected", el.dataset.gid === key);
    });
    saveBtn.disabled = false;
  };

  const addGroupRow = (g: MultiAccountGroup) => {
    const row = document.createElement("div");
    row.className = "dvads-groupmove-row";
    row.dataset.gid = g.id;
    row.innerHTML = `${FOLDER_ICON}<span class="dvads-groupmove-name"></span>`;
    row.querySelector<HTMLSpanElement>(".dvads-groupmove-name")!.textContent = g.name;
    row.addEventListener("click", () => selectGid(g.id));
    listEl.appendChild(row);
  };

  // "그룹 없음" 행 (+ 새 그룹 버튼 동거) — 맨 위 고정.
  const noneRow = document.createElement("div");
  noneRow.className = "dvads-groupmove-row dvads-groupmove-none";
  noneRow.dataset.gid = "__none__";
  noneRow.innerHTML = `${FOLDER_NONE_ICON}<span class="dvads-groupmove-name">그룹 없음</span><button class="dvads-groupmove-newbtn" type="button">+ 그룹</button>`;
  noneRow.addEventListener("click", () => selectGid(null));
  listEl.appendChild(noneRow);

  for (const g of groups) addGroupRow(g);

  // "+ 새 그룹" — 그룹 없음 행 바로 아래에 입력 행을 띄우고, Enter로 생성+선택.
  const openNewGroupInput = () => {
    if (listEl.querySelector(".dvads-groupmove-newrow")) return;
    const editRow = document.createElement("div");
    editRow.className = "dvads-groupmove-row dvads-groupmove-newrow";
    editRow.innerHTML = `${FOLDER_ICON}<input class="dvads-groupmove-newinput" type="text" maxlength="24" placeholder="새 그룹 이름" />`;
    noneRow.after(editRow);
    const inp = editRow.querySelector<HTMLInputElement>("input")!;
    const commit = async () => {
      const name = inp.value.trim().slice(0, 24);
      editRow.remove();
      if (!name) return;
      const list = await withServerSave(() => createGroup(name));
      if (list === undefined) return;
      const created = list[list.length - 1];
      if (created) { addGroupRow(created); selectGid(created.id); }
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editRow.remove(); }
    });
    inp.addEventListener("blur", () => void commit());
    inp.focus();
  };
  noneRow.querySelector<HTMLButtonElement>(".dvads-groupmove-newbtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openNewGroupInput();
  });

  // 초기 선택 — 대상 계정들의 현재 소속이 명확히 하나로 같을 때만 미리 선택(모호하면 미선택).
  const membershipKey = (n: number) => groups.filter((g) => g.accountNos.includes(n)).map((g) => g.id).sort().join(",");
  const keys = nos.map(membershipKey);
  if (keys.every((k) => k === keys[0])) {
    const ids = keys[0] ? keys[0].split(",") : [];
    if (ids.length === 0) selectGid(null);
    else if (ids.length === 1) selectGid(ids[0]);
  }

  const cleanup = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };

  const save = async () => {
    if (selectedGid === undefined) return;
    // 저장 시점에 최신 그룹 목록을 다시 읽어 병합(다이얼로그 여는 사이 다른 변경 대비).
    const fresh = await loadGroups();
    const removeSet = new Set(nos);
    for (const g of fresh) g.accountNos = g.accountNos.filter((n) => !removeSet.has(n)); // 전 그룹에서 제거
    if (selectedGid !== null) {
      const target = fresh.find((g) => g.id === selectedGid);
      if (target) for (const n of nos) if (!target.accountNos.includes(n)) target.accountNos.push(n);
    }
    try {
      await pushAndSaveGroups(fresh);
    } catch (e) {
      console.warn("[multi-account] group assign save failed", e);
      showToast({ message: "저장하지 못했어요. 잠시 후 다시 시도해 주세요", variant: "error" });
      return;
    }
    cleanup();
    if (popoverEl) await renderListView(popoverEl);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); }
  };
  wireBackdropDismiss(backdrop, cleanup);
  card.addEventListener("click", (e) => e.stopPropagation());
  card.querySelector<HTMLButtonElement>(".dvads-groupmove-close")?.addEventListener("click", cleanup);
  card.querySelector<HTMLButtonElement>(".dvads-rename-cancel")?.addEventListener("click", cleanup);
  saveBtn.addEventListener("click", () => void save());
  document.addEventListener("keydown", onKey, true);
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
  // 검색광고(SA) + 디스플레이광고(GFA) 모두 표시 — 네이버 "광고 계정" 탭과 동일한 전체 명단.
  // GFA 태그 계정도 masterCustomerId로 검색광고 데이터가 그대로 나와 메인 리스트에서 정상 표시된다
  // (naver 검색광고-GFA 통합, 2026-05-26 정찰). 삭제된 계정만 제외(운영중지 계정은 정상 표시).
  const all = (dir?.entries ?? [])
    .filter((e) => !e.deleted)
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
  // 키 입력마다 전체 행을 재빌드하면 큰 명단에서 버벅인다 — 140ms 디바운스로 마지막 입력만 반영.
  let searchDebounce = 0;
  input.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => renderList(input.value), 140);
  });
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
    const url = `/manage/ad-accounts/${entry.adAccountNo}/dashboard`;
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
          const next = await withServerSave(() => addAccountToList(entry.adAccountNo));
          if (next === undefined) return;
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
        openDeleteConfirm({
          title: "계정 삭제",
          message: "이 계정을 '내 계정'에서 삭제할까요?",
          onConfirm: async () => {
            const next = await withServerSave(() => removeAccountFromList(entry.adAccountNo));
            if (next === undefined) return;
            const groupsOk = await withServerSave(() => removeAccountsFromAllGroups([entry.adAccountNo]));
            if (groupsOk === undefined) return;
            await clearSnapshots([entry.adAccountNo]);
            await clearChangeWatchStates([entry.adAccountNo]);
            addedSet.clear();
            next.forEach((n) => addedSet.add(n));
            await replaceSearchRow(tr, entry, addedSet);
          },
        });
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
    const result = await withServerSave(() =>
      updateUserMeta(entry.adAccountNo, { displayName: input.value.trim().slice(0, 24) }),
    );
    if (result === undefined) return;
    cleanup();
    await replaceRow();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); }
    if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void save(); }
  };

  // 모달 내부 click이 document로 전파되면 popover의 outside-click 핸들러가 popover를 닫음.
  // 모든 핸들러에서 stopPropagation으로 차단. backdrop 클릭 dismiss는 드래그 오작동 방지 헬퍼로.
  wireBackdropDismiss(backdrop, cleanup);
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

// ─── 대행권 점검 ───
// 헤더 ⋮ 메뉴 "대행권 점검" → 접근 가능한 전 계정의 대행권 이관 상태를 일괄 조회해서
// 우리 담당 관리 계정(설정값)과 일치하는지 판별. 문제 계정(다른 대행사/없음/확인 필요)만 요약.

type AgencyCheckStatus = "ok" | "other_agency" | "none" | "error";

interface AgencyCheckRow {
  adAccountNo: number;
  name: string; // 별칭 우선
  status: AgencyCheckStatus;
  agencyName?: string;
  message?: string;
  bizMoney?: number | null; // 비즈머니 잔액(환급가능+환급불가). 조회 실패 시 null.
  yesterdayCost?: number | null; // 어제 광고비(SA+DA 합산, 원). 조회 실패/customerId 없음 시 null.
  row?: AgencyOperationRow; // 엑셀용 원본 상세(에이전시/대표·담당 관리계정/승인일자/영업타입)
}

const AGENCY_CHECK_CONCURRENCY = 4;

function classifyAgency(outcome: AgencyOperationOutcome, ourIds: number[]): {
  status: AgencyCheckStatus;
  agencyName?: string;
  message?: string;
} {
  if (outcome.kind === "forbidden") return { status: "error", message: "권한이 없어 확인하지 못했어요" };
  if (outcome.kind === "error") return { status: "error", message: "확인 중 문제가 생겼어요" };
  const row = outcome.row;
  if (!row) return { status: "none" };
  const agencyName = row.agencyCompanyName || row.agencyManagerAccountName || "";
  const direct = row.directManagerAccountNo;
  if (direct != null && ourIds.includes(direct)) return { status: "ok", agencyName };
  return { status: "other_agency", agencyName };
}

function closeAgencyModal(): void {
  document.querySelector(".dvads-agency-backdrop")?.remove();
}

/**
 * 대행권 점검 진입점. 우리 담당 관리 계정(설정)이 비어있으면 먼저 입력받고,
 * 있으면 바로 디렉터리 전 계정을 4-worker로 조회해 결과 요약을 띄운다.
 */
async function runAgencyCheck(targetNos?: number[]): Promise<void> {
  const [ourIds, dir, meta] = await Promise.all([
    loadAgencyIdentity(),
    loadDirectory(),
    loadAllUserMeta(),
  ]);
  const all = (dir?.entries ?? []).filter((e) => !e.disabled && !e.deleted);
  // 우선순위: 명시 인자(그룹 단위) > 선택된 계정(체크박스) > 전체 명단.
  let targets: MultiAccountDirectoryEntry[];
  if (targetNos && targetNos.length > 0) {
    const set = new Set(targetNos);
    targets = all.filter((e) => set.has(e.adAccountNo));
  } else if (selectedAccountNos.size > 0) {
    targets = all.filter((e) => selectedAccountNos.has(e.adAccountNo));
  } else {
    targets = all;
  }
  openAgencyModal(targets, ourIds, meta);
}

function openAgencyModal(
  targets: MultiAccountDirectoryEntry[],
  initialIds: number[],
  meta: Record<number, MultiAccountUserMeta>,
): void {
  closeAgencyModal();
  let ourIds = initialIds.slice();
  let cancelled = false;
  let checking = false; // 점검(로딩) 진행 중 — 배경/ESC로 닫히지 않게
  let loaderEl: HTMLElement | null = null; // 점검 중 리포트와 동일한 작은 로더 카드
  let lastResults: AgencyCheckRow[] | null = null; // 직전 점검 결과 — "다시 점검" 화면의 뒤로가기용

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-agency-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-agency-card";
  card.innerHTML = `
    <div class="dvads-agency-head">
      <div class="dvads-agency-title">대행권 점검</div>
      <button class="dvads-agency-close" type="button" aria-label="닫기">×</button>
    </div>
    <div class="dvads-agency-identity"></div>
    <div class="dvads-agency-body"></div>
  `;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const identityEl = card.querySelector<HTMLDivElement>(".dvads-agency-identity")!;
  const bodyEl = card.querySelector<HTMLDivElement>(".dvads-agency-body")!;
  const titleEl = card.querySelector<HTMLDivElement>(".dvads-agency-title")!;

  const cleanup = () => {
    cancelled = true;
    closeAllOpenDropdowns(); // 상태 필터 드롭다운 패널은 body portal이라 별도 정리
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (checking) return; // 점검 중엔 ESC로도 닫지 않음
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); }
  };
  document.addEventListener("keydown", onKey, true);
  // 바깥(backdrop) 클릭으로 닫기. 단 mousedown이 backdrop에서 시작한 "진짜 바깥 클릭"일 때만.
  // 카드 안에서 텍스트를 드래그하다 바깥에서 손을 떼면 click 타겟이 backdrop가 되는데,
  // 그때 닫히면 안 된다(드래그-아웃 닫힘 버그). mousedown 시작 위치로 구분한다.
  let downOnBackdrop = false;
  backdrop.addEventListener("mousedown", (e) => {
    downOnBackdrop = e.target === backdrop;
  });
  backdrop.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!checking && e.target === backdrop && downOnBackdrop) cleanup();
    downOnBackdrop = false;
  });
  card.addEventListener("click", (e) => e.stopPropagation());
  card.querySelector<HTMLButtonElement>(".dvads-agency-close")?.addEventListener("click", cleanup);

  // ─── 담당 관리 계정 입력 (점검 진입 + "다시 점검" 시 재설정) ───
  function showIdentityEditor() {
    backdrop.classList.remove("is-results"); // 입력 화면은 중앙 정렬
    loaderEl?.remove();
    loaderEl = null;
    card.style.display = ""; // 로딩 때 숨겼다면 복원
    bodyEl.innerHTML = ""; // 결과/로딩 잔재 제거 — 입력창만 남긴다
    bodyEl.style.display = "none"; // 입력 화면은 본문 비움 → 아래 빈 공간 제거
    identityEl.style.display = "";
    identityEl.innerHTML = "";
    // 직전 결과가 있으면(=다시 점검으로 들어온 경우) 헤더 제목을 "< 뒤로가기"로 교체 → 점검 없이 이전 결과 복귀.
    if (lastResults) {
      titleEl.innerHTML = `<button class="dvads-agency-title-back" type="button">&lt; 뒤로가기</button>`;
      titleEl.querySelector<HTMLButtonElement>(".dvads-agency-title-back")?.addEventListener("click", () => {
        if (lastResults) renderResults(lastResults);
      });
    } else {
      titleEl.textContent = "대행권 점검";
    }
    const wrap = document.createElement("div");
    wrap.className = "dvads-agency-id-editor";
    wrap.innerHTML = `
      <input class="dvads-agency-id-input" type="text" inputmode="numeric"
        placeholder="예: 28504, 28505" />
      <button class="dvads-agency-id-save dvads-btn dvads-btn-primary" type="button">점검 시작</button>
    `;
    identityEl.appendChild(wrap);

    const input = wrap.querySelector<HTMLInputElement>(".dvads-agency-id-input")!;
    input.value = ourIds.join(", "); // 기존 값 미리 채움 (지울 수 있음)
    input.focus();
    input.select();
    const save = async () => {
      const ids = [...new Set((input.value.match(/\d+/g) ?? []).map(Number).filter((n) => n > 0))];
      ourIds = ids;
      if ((await withServerSave(() => saveAgencyIdentity(ids))) === undefined) return;
      void startCheck();
    };
    wrap.querySelector<HTMLButtonElement>(".dvads-agency-id-save")?.addEventListener("click", () => void save());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void save(); }
    });
  }

  // ─── 점검 실행 ───
  async function startCheck() {
    if (ourIds.length === 0) {
      showIdentityEditor();
      return;
    }
    if (targets.length === 0) {
      bodyEl.style.display = "";
      bodyEl.innerHTML =
        `<div class="dvads-agency-msg">점검할 계정이 없어요. 광고계정 화면을 먼저 열어 계정 명단을 불러와 주세요.</div>`;
      return;
    }

    const total = targets.length;
    let done = 0;
    // 점검 중엔 본 카드를 숨기고 리포트와 동일한 작은 로더 카드(.dvads-auto-overlay-card)를 띄운다.
    backdrop.classList.remove("is-results");
    card.style.display = "none";
    if (!loaderEl) {
      loaderEl = document.createElement("div");
      loaderEl.className = "dvads-auto-overlay-card";
      loaderEl.innerHTML =
        `<button class="dvads-auto-overlay-cancel" type="button" aria-label="취소">×</button>` +
        `<div class="dvads-auto-overlay-spinner"></div><div class="dvads-auto-overlay-text"></div>`;
      loaderEl.querySelector(".dvads-auto-overlay-cancel")?.addEventListener("click", cleanup);
      backdrop.appendChild(loaderEl);
    }
    loaderEl.style.display = "";
    const textEl = loaderEl.querySelector<HTMLElement>(".dvads-auto-overlay-text")!;
    const updateProgress = () => {
      if (backdrop.isConnected) textEl.textContent = `대행권 점검 중... (${done}/${total})`;
    };
    updateProgress();

    checking = true; // 이제부터 배경/ESC 닫기 차단 (× 명시적 취소는 허용)
    const yesterday = yesterdayKST(); // 어제 광고비 조회용 (KST 기준 어제 날짜)
    const results: AgencyCheckRow[] = [];
    const queue = [...targets];
    const workers = Array.from(
      { length: Math.min(AGENCY_CHECK_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length > 0 && !cancelled) {
          const entry = queue.shift();
          if (!entry) break;
          // 대행권 + 비즈머니 + 어제 광고비를 같은 계정에서 병렬 조회 — 서로 다른 endpoint지만
          // 동시에 보내면 대기 시간은 가장 느린 1개 수준. 광고비/비즈머니는 실패해도 null로 흘림.
          // 광고비는 customerId(masterCustomerId)가 있어야 cross-account 호출 가능 — 없으면 null.
          const [outcome, bizMoney, yesterdayCost] = await Promise.all([
            fetchAgencyOperation(entry.adAccountNo).catch(
              (): AgencyOperationOutcome => ({ kind: "error", status: 0, message: "네트워크 오류" }),
            ),
            fetchBizMoney(entry.adAccountNo).catch(() => null),
            entry.masterCustomerId
              ? fetchYesterdayCost(entry.adAccountNo, entry.masterCustomerId, yesterday).catch(() => null)
              : Promise.resolve(null),
          ]);
          const c = classifyAgency(outcome, ourIds);
          results.push({
            adAccountNo: entry.adAccountNo,
            name: meta[entry.adAccountNo]?.displayName?.trim() || entry.name,
            status: c.status,
            agencyName: c.agencyName,
            message: c.message,
            bizMoney,
            yesterdayCost,
            row: outcome.kind === "ok" ? (outcome.row ?? undefined) : undefined,
          });
          done++;
          updateProgress();
        }
      },
    );
    await Promise.all(workers);
    checking = false; // 점검 끝 — 다시 배경/ESC로 닫기 가능
    loaderEl?.remove();
    loaderEl = null;
    card.style.display = "";
    if (cancelled) return;
    renderResults(results);
  }

  // ─── 결과 요약 ───
  const statusLabel = (s: AgencyCheckStatus): string =>
    s === "ok" ? "이관 완료" : s === "other_agency" ? "타대행사" : s === "none" ? "대행권없음" : "확인 필요";

  function renderResults(rows: AgencyCheckRow[]) {
    lastResults = rows; // "다시 점검" 화면에서 뒤로가기로 복귀할 수 있게 보관
    titleEl.textContent = "대행권 점검"; // 입력 화면에서 뒤로가기로 바뀐 제목 복원
    // 정렬 순서: 타대행사 → 없음 → 확인 필요 → 이관 완료(정상은 맨 아래), 동급은 이름순.
    const order: AgencyCheckStatus[] = ["other_agency", "none", "error", "ok"];
    // 상태 헤더 드롭다운으로 고른 상태(null = 전체). 첫 점검 시 전체 계정 표시.
    let statusFilter: AgencyCheckStatus | null = null;

    identityEl.style.display = "none"; // 결과 화면엔 담당 계정 표시줄 없음 (재설정은 "다시 점검")
    backdrop.classList.add("is-results"); // 결과 화면은 넓게 + 고정 높이
    bodyEl.style.display = "";
    bodyEl.innerHTML = "";

    // 검색 + 엑셀 다운로드(아이콘)
    const toolbar = document.createElement("div");
    toolbar.className = "dvads-agency-toolbar";
    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "dvads-agency-search";
    searchInput.placeholder = "계정 검색(이름/번호/대행사명)";
    toolbar.appendChild(searchInput);
    const excelBtn = document.createElement("button");
    excelBtn.type = "button";
    excelBtn.className = "dvads-agency-excel";
    excelBtn.title = "엑셀 다운로드";
    excelBtn.setAttribute("aria-label", "엑셀 다운로드");
    excelBtn.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
      `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    toolbar.appendChild(excelBtn);
    bodyEl.appendChild(toolbar);

    const listWrap = document.createElement("div");
    listWrap.className = "dvads-agency-list";
    bodyEl.appendChild(listWrap);

    const sortRows = (arr: AgencyCheckRow[]) =>
      arr.slice().sort((a, b) => {
        const d = order.indexOf(a.status) - order.indexOf(b.status);
        return d !== 0 ? d : a.name.localeCompare(b.name, "ko");
      });

    const paintList = (q: string) => {
      const ql = q.trim().toLowerCase();
      // 상태 헤더 드롭다운으로 고른 상태만, 아니면 전체.
      const base = statusFilter
        ? rows.filter((r) => r.status === statusFilter)
        : rows;
      const filtered = sortRows(
        !ql
          ? base
          : base.filter(
              (r) =>
                r.name.toLowerCase().includes(ql) ||
                String(r.adAccountNo).includes(ql) ||
                (r.agencyName ?? "").toLowerCase().includes(ql) ||
                (r.row?.directManagerAccountName ?? "").toLowerCase().includes(ql) ||
                String(r.row?.directManagerAccountNo ?? "").includes(ql),
            ),
      );
      // 다계정 표와 동일한 구조 — 상단 헤더 + 아래 행 리스트.
      listWrap.innerHTML = "";
      const table = document.createElement("table");
      table.className = "dvads-agency-table";
      table.innerHTML =
        `<thead><tr>` +
        `<th class="dvads-agency-th-acct">계정</th>` +
        `<th class="dvads-agency-th-agency">대행사</th>` +
        `<th class="dvads-agency-th-dm">담당 관리 계정</th>` +
        `<th class="dvads-agency-th-cost">전일 광고비</th>` +
        `<th class="dvads-agency-th-biz">비즈머니</th>` +
        `<th class="dvads-agency-th-status"></th>` +
        `</tr></thead>`;
      // 상태 헤더 — 클릭하면 드롭다운으로 상태 필터 선택(아래 화살표로 표시). 매 paint마다 재생성.
      const statusTh = table.querySelector<HTMLTableCellElement>(".dvads-agency-th-status");
      if (statusTh) {
        const trig = document.createElement("button");
        trig.type = "button";
        trig.className = "dvads-agency-status-trigger";
        trig.innerHTML =
          `<span>상태</span><span class="dvads-agency-status-chevron" aria-hidden="true">▾</span>`;
        statusTh.appendChild(trig);
        const pick = (s: AgencyCheckStatus | null) => {
          statusFilter = s;
          paintList(searchInput.value);
        };
        attachActionMenu({
          trigger: trig,
          ariaLabel: "상태 필터",
          items: () => [
            { label: "전체", checked: statusFilter === null, onClick: () => pick(null) },
            { label: statusLabel("other_agency"), checked: statusFilter === "other_agency", onClick: () => pick("other_agency") },
            { label: statusLabel("none"), checked: statusFilter === "none", onClick: () => pick("none") },
            { label: statusLabel("error"), checked: statusFilter === "error", onClick: () => pick("error") },
            { label: statusLabel("ok"), checked: statusFilter === "ok", onClick: () => pick("ok") },
          ],
        });
      }
      const tbody = document.createElement("tbody");
      if (filtered.length === 0) {
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 6;
        td.className = "dvads-agency-empty";
        td.textContent = ql
          ? "검색 결과가 없어요."
          : statusFilter
            ? "해당 상태의 계정이 없어요."
            : "점검할 계정이 없어요.";
        tr.appendChild(td);
        tbody.appendChild(tr);
      } else {
        for (const r of filtered) {
          const tr = document.createElement("tr");
          tr.className = "dvads-agency-row";
          const statusCls =
            r.status === "ok" ? "dvads-agency-okb"
            : r.status === "other_agency" ? "dvads-agency-other"
            : r.status === "none" ? "dvads-agency-noneb"
            : "dvads-agency-err";
          // 대행권 있는 경우만 에이전시명, 없음/확인필요는 "-"
          const agencyText =
            (r.status === "other_agency" || r.status === "ok") && r.agencyName
              ? escapeHtml(r.agencyName)
              : "-";
          const dm = r.row;
          const dmName = dm?.directManagerAccountName ? escapeHtml(dm.directManagerAccountName) : "";
          const dmNo = dm?.directManagerAccountNo != null ? String(dm.directManagerAccountNo) : "";
          const dmCell = dmName
            ? `<div class="dvads-agency-name">${dmName}</div>` + (dmNo ? `<div class="dvads-agency-no">${dmNo}</div>` : "")
            : "-";
          const bizText = r.bizMoney != null ? formatWon(r.bizMoney) : "-";
          const costText = r.yesterdayCost != null ? formatWon(r.yesterdayCost) : "-";
          tr.innerHTML =
            `<td class="dvads-agency-td-acct"><div class="dvads-agency-name">${escapeHtml(r.name)}</div><div class="dvads-agency-no">${r.adAccountNo}</div></td>` +
            `<td class="dvads-agency-td-agency">${agencyText}</td>` +
            `<td class="dvads-agency-td-dm">${dmCell}</td>` +
            `<td class="dvads-agency-td-cost">${costText}</td>` +
            `<td class="dvads-agency-td-biz">${bizText}</td>` +
            `<td class="dvads-agency-td-status"><span class="dvads-agency-badge ${statusCls}">${statusLabel(r.status)}</span></td>`;
          // 행 클릭 → 광고 대시보드 메인 새 탭(anchor click; window.open 차단 회피).
          // 드래그(텍스트 선택)면 이동 안 함 — mousedown/up 위치 차로 판별.
          let downX = 0;
          let downY = 0;
          tr.addEventListener("mousedown", (e) => { downX = e.clientX; downY = e.clientY; });
          tr.addEventListener("click", (e) => {
            if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
            const a = document.createElement("a");
            a.href = `/manage/ad-accounts/${r.adAccountNo}/dashboard`;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.click();
          });
          tbody.appendChild(tr);
        }
      }
      table.appendChild(tbody);
      listWrap.appendChild(table);
    };

    // 검색은 키 입력마다 전체 테이블을 재빌드하므로 디바운스 — renderSearchView(140ms)와 동일 패턴.
    let searchDebounce: number | undefined;
    searchInput.addEventListener("input", () => {
      window.clearTimeout(searchDebounce);
      searchDebounce = window.setTimeout(() => paintList(searchInput.value), 140);
    });
    paintList("");

    // 엑셀: 전체 결과(정상 포함) 기록. write-excel-file은 무거워 클릭 시 동적 import.
    excelBtn.addEventListener("click", () => {
      void (async () => {
        excelBtn.disabled = true;
        try {
          const { downloadAgencyCheckExcel } = await import("@/features/multi-account/agency-check-excel");
          await downloadAgencyCheckExcel(
            rows.map((r) => {
              const d = r.row;
              const acceptedAt = d?.acceptedAt ? d.acceptedAt.slice(0, 10).replace(/-/g, ".") : "";
              const salesType = d ? (d.taxInvoiceIncluded ? "대행권 이관 및 세금계산서 위임" : "대행권 이관") : "";
              return {
                name: r.name,
                adAccountNo: r.adAccountNo,
                statusLabel: statusLabel(r.status),
                agency: d?.agencyCompanyName || d?.agencyManagerAccountName || (r.status === "error" ? (r.message ?? "") : ""),
                ownerName: d?.agencyManagerAccountName ?? "",
                ownerNo: d?.agencyManagerAccountNo != null ? String(d.agencyManagerAccountNo) : "",
                directName: d?.directManagerAccountName ?? "",
                directNo: d?.directManagerAccountNo != null ? String(d.directManagerAccountNo) : "",
                acceptedAt,
                salesType,
                yesterdayCost: r.yesterdayCost ?? null,
                bizMoney: r.bizMoney ?? null,
              };
            }),
          );
        } catch (e) {
          console.warn("[content/multi-account] 대행권 점검 엑셀 실패", e);
        } finally {
          excelBtn.disabled = false;
        }
      })();
    });

    const actions = document.createElement("div");
    actions.className = "dvads-agency-actions";
    actions.innerHTML =
      `<button class="dvads-agency-recheck dvads-btn dvads-btn-secondary" type="button">다시 점검</button>` +
      `<button class="dvads-agency-done dvads-btn dvads-btn-primary" type="button">닫기</button>`;
    bodyEl.appendChild(actions);
    actions.querySelector<HTMLButtonElement>(".dvads-agency-recheck")?.addEventListener("click", () => showIdentityEditor());
    actions.querySelector<HTMLButtonElement>(".dvads-agency-done")?.addEventListener("click", cleanup);
  }

  // 점검 진입 시 항상 담당 관리 계정 설정부터 — 입력창 + 점검 버튼만.
  bodyEl.innerHTML = "";
  showIdentityEditor();
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
    // 그룹 다중 소속 — 같은 계정이 다른 섹션에도 있으면 그 체크박스도 같이 반영.
    if (popoverEl) {
      popoverEl
        .querySelectorAll<HTMLInputElement>(
          `tr.dvads-multi-tr[data-ad-account-no="${accountNo}"] .dvads-multi-cb input`,
        )
        .forEach((el) => {
          if (el !== cb) el.checked = cb.checked;
        });
      updateBulkActionUI(popoverEl);
    }
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
  // 그룹 헤더 체크박스 — 각 그룹 전 계정의 선택 상태(전체/일부)를 반영.
  wrap.querySelectorAll<HTMLInputElement>(".dvads-multi-cb-group input").forEach((gcb) => {
    const key = gcb.closest("tr")?.dataset.sectionKey;
    if (!key) return;
    const nos = [...wrap.querySelectorAll<HTMLElement>(`tr.dvads-multi-tr[data-section-key="${key}"]`)]
      .map((r) => Number(r.dataset.adAccountNo))
      .filter(Boolean);
    const all = nos.length > 0 && nos.every((no) => selectedAccountNos.has(no));
    gcb.checked = all;
    gcb.indeterminate = !all && nos.some((no) => selectedAccountNos.has(no));
  });
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
    // 보이는 각 행의 체크박스 동기화 — 그룹 다중 소속으로 같은 계정이 여러 행일 수 있어 모두.
    visible.forEach((no) => {
      wrap
        .querySelectorAll<HTMLInputElement>(
          `tr.dvads-multi-tr[data-ad-account-no="${no}"] .dvads-multi-cb input`,
        )
        .forEach((cb) => {
          cb.checked = selectAll.checked;
        });
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

// 광고 유형 필터 토글 — 메뉴 체크박스 클릭 시. 최소 하나는 켜져 있어야 하므로 마지막 하나는 못 끈다.
// 변경 시 storage 저장 + 어제 데이터 캐시 무효화 + 전체 재수집(collectAccount가 새 필터로 fetch).
// in-flight 가드 — 재수집(clearAll + refreshAllStale, 수십 계정)이 무거우므로 빠른 연속 클릭이
// 동시 fetch storm을 일으키지 않게 한다.
let platformToggleInFlight = false;
async function togglePlatform(
  key: "sa" | "da",
  entries: MultiAccountDirectoryEntry[],
): Promise<void> {
  if (platformToggleInFlight) return;
  const next: PlatformFilter = { ...platformFilter, [key]: !platformFilter[key] };
  if (!next.sa && !next.da) return; // 마지막 하나는 끄기 무시 (체크 유지)
  // platformFilter는 첫 await 이전에 동기 갱신 — populate()가 즉시 새 선택 상태를 그린다.
  platformFilter = next;
  platformToggleInFlight = true;
  // 토글 즉시 전 행을 로딩 스켈레톤으로 덮는다. clearAllSnapshots가 수치를 무효화하므로
  // 재수집이 끝날 때까지 옛 숫자를 그대로 두면 "안 바뀌었네?" 오해를 준다.
  paintAllRowsSkeleton();
  try {
    await savePlatformFilter(next).catch((e) =>
      console.warn("[content/multi-account] platform filter 저장 실패", e),
    );
    await clearAllSnapshots().catch(() => {});
    // 새 필터로 재수집 — 캐시가 비었으니 force 없이도 전부 다시 받음.
    await refreshAllStale(entries);
  } finally {
    platformToggleInFlight = false;
  }
}

// 내 계정(list view) ⋮ kebab 메뉴 — 크게 보기 / 새로고침 / 광고 유형 필터 / 알림 2종 / 삭제.
// 첫 항목은 fullscreen 상태 토글 — 평소 "크게 보기", 진입 후엔 "작게 보기"로 라벨 바뀜.
function listKebabItems(entries: MultiAccountDirectoryEntry[]): ActionMenuItem[] {
  const hasSelection = selectedAccountNos.size > 0;
  return [
    {
      label: popoverFullscreen ? "작게 보기" : "크게 보기",
      onClick: () => setFullscreen(!popoverFullscreen),
    },
    { label: "새로고침", onClick: () => void refreshAllStale(entries) },
    {
      label: "그룹 지정",
      disabled: !hasSelection,
      onClick: () => void openGroupAssignDialog(Array.from(selectedAccountNos)),
    },
    { separator: true },
    {
      label: "리포트 생성",
      disabled: !hasSelection,
      keepOpen: true,
      // 클릭 시점에 meta를 새로 읽어 바뀐 별칭(displayName)을 리포트에 반영. 그룹 헤더 메뉴와
      // openReportForEntries를 공유(anchor 위치 동기 캡처 포함).
      onClick: (anchor) =>
        void openReportForEntries(
          anchor,
          entries.filter((e) => selectedAccountNos.has(e.adAccountNo)),
        ),
    },
    {
      label: "대행권 점검",
      onClick: () => void runAgencyCheck(),
    },
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
    {
      label: "변경이력 알림",
      disabled: !hasSelection,
      onClick: () => void openChangeWatchDialogFor(Array.from(selectedAccountNos)),
    },
    {
      label: "목표 수익률",
      disabled: !hasSelection,
      onClick: () => openTargetRoasDialogFor(Array.from(selectedAccountNos)),
    },
    { separator: true },
    // 광고 유형 필터 — 둘 중 하나만/둘 다 선택. 선택에 따라 어제 데이터가 SA/GFA/합산으로 바뀐다.
    {
      label: "검색광고",
      checked: platformFilter.sa,
      keepOpen: true,
      onClick: () => togglePlatform("sa", entries),
    },
    {
      label: "디스플레이광고",
      checked: platformFilter.da,
      keepOpen: true,
      onClick: () => togglePlatform("da", entries),
    },
    { separator: true },
    {
      label: "삭제",
      danger: true,
      disabled: !hasSelection,
      onClick: () => {
        const nos = Array.from(selectedAccountNos);
        if (nos.length === 0) return;
        openDeleteConfirm({
          title: "계정 삭제",
          message: `선택한 계정 ${nos.length}개를 '내 계정'에서 삭제할까요?`,
          onConfirm: async () => {
            const removed = await withServerSave(() => removeAccountsFromList(nos));
            if (removed === undefined) return;
            const groupsOk = await withServerSave(() => removeAccountsFromAllGroups(nos));
            if (groupsOk === undefined) return;
            await clearSnapshots(nos);
            await clearChangeWatchStates(nos);
            selectedAccountNos.clear();
            if (popoverEl) await renderListView(popoverEl);
          },
        });
      },
    },
  ];
}

// 전체 계정(search view) ⋮ kebab 메뉴 — 사용자 요구대로 단순히 계정 추가 / 삭제만.
function searchKebabItems(): ActionMenuItem[] {
  const hasSelection = selectedAccountNos.size > 0;
  return [
    {
      label: "대행권 점검",
      onClick: () => void runAgencyCheck(),
    },
    { separator: true },
    {
      label: "계정 추가",
      disabled: !hasSelection,
      onClick: () => {
        const nos = Array.from(selectedAccountNos);
        if (nos.length === 0) return;
        void (async () => {
          const added = await withServerSave(() => addAccountsToList(nos));
          if (added === undefined) return;
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
        openDeleteConfirm({
          title: "계정 삭제",
          message: `선택한 계정 ${nos.length}개를 '내 계정'에서 삭제할까요?`,
          onConfirm: async () => {
            const removed = await withServerSave(() => removeAccountsFromList(nos));
            if (removed === undefined) return;
            const groupsOk = await withServerSave(() => removeAccountsFromAllGroups(nos));
            if (groupsOk === undefined) return;
            await clearSnapshots(nos);
            await clearChangeWatchStates(nos);
            selectedAccountNos.clear();
            if (popoverEl) await renderSearchView(popoverEl);
          },
        });
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
    // 좌표는 정수로 반올림 — rect 소수점 좌표를 그대로 쓰면 popover 내부의 1px 선·sticky
    // 헤더가 반올림 경계에 걸려 sub-pixel 어긋남(선 떨림)이 생기기 쉽다.
    if (wouldOverflow) {
      wrap.style.right = `${Math.round(Math.max(margin, window.innerWidth - btnRect.right))}px`;
      wrap.style.left = "";
    } else {
      wrap.style.left = `${Math.round(btnRect.left)}px`;
      wrap.style.right = "";
    }
    wrap.style.top = `${Math.round(btnRect.bottom + margin)}px`;
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
  // 분리형 헤더 구조라 테이블이 2개(헤더/본문) — 둘 다 토글해야 컬럼 숨김이 일치.
  popoverEl.querySelectorAll(".dvads-multi-table").forEach((t) => t.classList.toggle("is-collapsed", !on));
  scheduleHeadColSync();
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
    // 검색광고/디스플레이광고 모두 유지 — 삭제된 계정만 제외(검색 뷰 필터와 동일 기준).
    if (e && !e.deleted) {
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

  const hasAlias = !!meta?.displayName?.trim();
  const displayName = hasAlias ? meta!.displayName!.trim() : entry.name;
  // 이름을 바꾼 계정은 계정번호 옆에 원래 계정명을 같이 표기 — "1890480 (원래계정명)".
  // 별칭이 없으면 계정번호만.
  const subLine = hasAlias
    ? `${entry.adAccountNo} (${escapeHtml(entry.name)})`
    : String(entry.adAccountNo);
  const isActive =
    location.pathname.startsWith(`/manage/ad-accounts/${entry.adAccountNo}/`);
  if (isActive) tr.classList.add("dvads-multi-tr-active");

  tr.innerHTML = `
    <td class="dvads-multi-td-cb">${checkboxHTML(false, `${displayName} 선택`)}</td>
    <td class="dvads-multi-td-name">
      <div class="dvads-multi-name-line">
        <div class="dvads-multi-name" title="${escapeHtml(entry.name)}">${escapeHtml(displayName)}</div>
        <button class="dvads-multi-issue-badge" type="button" style="display:none" aria-label="계정 이슈"></button>
      </div>
      <div class="dvads-multi-no">${subLine}</div>
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
    const url = `/manage/ad-accounts/${entry.adAccountNo}/dashboard`;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  };

  const nameTd = tr.querySelector<HTMLTableCellElement>(".dvads-multi-td-name");
  nameTd?.classList.add("dvads-multi-td-name-clickable");
  nameTd?.addEventListener("click", goTo);

  // 브랜드검색 알림 호버 툴팁 — 이름 셀에만 트리거. alert 토글 여부는 paintRow가 행 클래스로
  // 처리하니 listener는 항상 등록하고 내부에서 부모 행 클래스 확인. delay-hide로
  // 이름 셀→툴팁 사이 마우스 이동 허용.
  nameTd?.addEventListener("mouseenter", () => {
    if (!tr.classList.contains("dvads-multi-tr-brand-alert")) return;
    cancelHideBrandTooltip();
    showBrandTooltip(tr, nameTd);
  });
  nameTd?.addEventListener("mouseleave", () => {
    if (!tr.classList.contains("dvads-multi-tr-brand-alert")) return;
    scheduleHideBrandTooltip();
  });

  // 이슈 카운트 배지 — 이름 셀 안이라 클릭이 계정 이동(goTo)으로 새지 않게 전파를 끊는다.
  const issueBadge = tr.querySelector<HTMLButtonElement>(".dvads-multi-issue-badge");
  issueBadge?.addEventListener("click", (e) => {
    e.stopPropagation();
    void openChangeWatchPanel(entry, issueBadge);
  });

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
          label: "계정 이슈",
          onClick: () => void openChangeWatchPanel(entry, actionTrigger),
        },
        {
          label: "이름 수정",
          onClick: () => openRenameDialog(entry, () => replaceListRow(tr, entry)),
        },
        {
          label: "그룹 지정",
          onClick: () => void openGroupAssignDialog([entry.adAccountNo]),
        },
        { separator: true },
        {
          label: "리포트 생성",
          keepOpen: true,
          onClick: (anchor) => {
            // keepOpen 메뉴라 onClick 직후 populate()가 anchor 버튼을 떼어낸다. 동적 import가
            // resolve되는 시점엔 이미 분리돼 rect가 0이 되므로, 위치를 지금(동기) 캡처해 날짜
            // 선택기에 위치 보존용 프록시 앵커로 넘긴다(openReportFlow는 anchorRect 미지원).
            const rect = anchor.getBoundingClientRect();
            const anchorProxy = {
              getBoundingClientRect: () => rect,
              isConnected: false,
              contains: () => false,
            } as unknown as HTMLElement;
            void import("@/features/report/report")
              .then(({ openReportFlow }) => {
                openReportFlow(anchorProxy, {
                  adAccountNo: entry.adAccountNo,
                  masterCustomerId: entry.masterCustomerId,
                  name: meta?.displayName?.trim() || entry.name,
                });
              })
              .catch((e) => {
                // catch가 없으면 실패가 조용한 rejection으로 사라져 "눌러도 아무 일 없음"이 된다.
                console.warn("[dv-ads/report] 리포트 화면을 열지 못함", e);
                showToast({ message: "리포트 화면을 열지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
              });
          },
        },
        {
          label: "광고 성과 측정",
          keepOpen: true,
          onClick: (anchor) => {
            // "리포트 생성"과 동일 — keepOpen 메뉴라 onClick 직후 populate()가 anchor를 떼어낸다.
            // 동적 import resolve 시점엔 rect가 0이 되므로 지금(동기) 캡처해 프록시로 넘긴다.
            const rect = anchor.getBoundingClientRect();
            const anchorProxy = {
              getBoundingClientRect: () => rect,
              isConnected: false,
              contains: () => false,
            } as unknown as HTMLElement;
            void import("@/features/brief/brief")
              .then(({ openBriefFlow }) => {
                openBriefFlow(anchorProxy, {
                  adAccountNo: entry.adAccountNo,
                  masterCustomerId: entry.masterCustomerId,
                  name: meta?.displayName?.trim() || entry.name,
                });
              })
              .catch((e) => {
                console.warn("[dv-ads/brief] 보고 문구 화면을 열지 못함", e);
                showToast({ message: "광고 성과 측정 화면을 열지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요", variant: "error" });
              });
          },
        },
        {
          label: "세팅안 생성",
          onClick: async () => {
            const { openSetupFlow } = await import("@/features/setup/setup");
            void openSetupFlow({
              adAccountNo: entry.adAccountNo,
              masterCustomerId: entry.masterCustomerId,
              name: meta?.displayName?.trim() || entry.name,
            });
          },
        },
        {
          label: "대행권 점검",
          onClick: () => void runAgencyCheck([entry.adAccountNo]),
        },
        { separator: true },
        {
          label: "비즈머니 알림",
          onClick: () => openBizMoneyDialogFor([entry.adAccountNo]),
        },
        {
          label: "브랜드검색 알림",
          onClick: () => openBrandSearchDialogFor([entry.adAccountNo]),
        },
        {
          label: "변경이력 알림",
          onClick: () => void openChangeWatchDialogFor([entry.adAccountNo]),
        },
        {
          label: "목표 수익률",
          onClick: () => openTargetRoasDialogFor([entry.adAccountNo]),
        },
        { separator: true },
        {
          label: "삭제",
          danger: true,
          onClick: () => {
            // 광고계정 자체가 아니라 "내 계정" 목록에서만 빠짐(재추가는 검색 뷰에서 가능). 확인 후 제거.
            openDeleteConfirm({
              title: "계정 삭제",
              message: "이 계정을 '내 계정'에서 삭제할까요?",
              onConfirm: async () => {
                const removed = await withServerSave(() => removeAccountFromList(entry.adAccountNo));
                if (removed === undefined) return;
                const groupsOk = await withServerSave(() =>
                  removeAccountsFromAllGroups([entry.adAccountNo]),
                );
                if (groupsOk === undefined) return;
                await clearSnapshots([entry.adAccountNo]);
                await clearChangeWatchStates([entry.adAccountNo]);
                if (popoverEl) await renderListView(popoverEl);
              },
            });
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

// 재진입 가드 — 전체 수집(계정당 ~10콜)이 도는 30~60초 사이 kebab "새로고침"을 다시 누르면
// 워커 풀이 이중으로 돌아 같은 호출을 통째로 두 번 발사한다. backgroundRefreshStale과 동일 패턴.
let refreshAllInFlight = false;

async function refreshAllStale(entries: MultiAccountDirectoryEntry[]) {
  if (!popoverEl) return;
  if (refreshAllInFlight) return;
  refreshAllInFlight = true;
  try {
    await refreshAllStaleImpl(entries);
  } finally {
    refreshAllInFlight = false;
  }
}

async function refreshAllStaleImpl(entries: MultiAccountDirectoryEntry[]) {
  if (!popoverEl) return;
  const btn = popoverEl.querySelector<HTMLButtonElement>(".dvads-multi-refresh-all");
  const activeNo = extractActiveAdAccountNo();
  // 필터·별칭 메타는 계정 수만큼 반복 조회할 필요가 없어 시작 시 1회만 읽어 전달.
  // (도중에 필터·별칭이 바뀌는 엣지는 종료 후 renderListView 전체 재렌더가 흡수)
  const platforms = await loadPlatformFilter().catch(
    () => ({ sa: true, da: true }) as PlatformFilter,
  );
  const metaAll = await loadAllUserMeta();
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
        await refreshRow(entry, activeNo, { force: true, platforms, metaAll });
      } catch (e) {
        console.warn("[content/multi-account] refresh 실패", entry.adAccountNo, e);
      }
      done++;
      updateLabel();
    }
  });
  await Promise.all(workers);
  // 그룹 섹션 합계(광고비/매출)는 렌더 시점 스냅샷 기준이라, 전체 새로고침 후 최신 값으로 다시
  // 그려야 합계가 방금 받은 데이터를 반영한다. 접힘/선택/검색 상태는 모듈 전역이라 유지된다.
  if (popoverEl && popoverView === "list") {
    await renderListView(popoverEl);
    return;
  }
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
  opts: {
    force: boolean;
    /** 배치 호출(refreshAllStale 등)이 1회 로드해 주입 — 계정마다 storage 중복 조회 방지 */
    platforms?: PlatformFilter;
    metaAll?: Record<number, MultiAccountUserMeta>;
  } = { force: false },
): Promise<void> {
  if (!opts.force) {
    const cached = await loadSnapshot(entry.adAccountNo);
    if (cached && isSnapshotFresh(cached)) return;
  }
  // GFA 태그 계정도 masterCustomerId로 검색광고 데이터가 나오므로 플랫폼 구분 없이 동일 경로.
  // customerId가 없으면 디렉토리가 덜 받아진 실제 문제 신호 — 에러 표시.
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
      opts.platforms,
    );
    const snap: MultiAccountSnapshot = {
      adAccountNo: entry.adAccountNo,
      bizMoney: payload.bizMoney,
      yesterday: payload.yesterday,
      contracts: payload.contracts,
      issues: payload.issues,
      fetched_at: new Date().toISOString(),
    };
    await saveSnapshot(snap);
    const all = opts.metaAll ?? (await loadAllUserMeta());
    paintRow(entry.adAccountNo, snap, all[entry.adAccountNo]);
    void refreshBadge();
  } catch (e) {
    paintRowError(entry.adAccountNo, friendlyMessage(e));
  }
}

// ─── 변경이력 알림 (F-ChangeWatch) ───────────────────────────────────────
//
// 광고관리자 변경이력을 계정마다 훑어서 두 가지를 잡는다:
//   1. 예산을 다 써서 멈춘 캠페인/광고그룹
//   2. 제외 목록(변경이력 알림 설정)에 없는 사람이 건드린 기록
//
// 조회는 ads.naver.com 탭 안에서만 가능(다른 데이터와 동일 제약)하므로 별도 알람 권한 없이
// 페이지가 열려있는 동안 주기적으로 돈다. 창(window)은 고정 기간이 아니라 "직전 점검 이후"라
// 놓치는 이력도 중복 알림도 없다.

let changeWatchScanPromise: Promise<void> | null = null;
let changeWatchTimer = 0;

/**
 * 한 계정 점검. 직전 점검 시각(scanned_until)이 다음 조회의 since가 된다.
 * 실패 시 scanned_until을 전진시키지 않아 다음 점검이 같은 구간을 다시 훑는다(이력 유실 방지).
 */
async function refreshChangeWatchRow(
  entry: MultiAccountDirectoryEntry,
  actors: string[],
  force: boolean,
): Promise<void> {
  if (!entry.masterCustomerId) return;
  const prev = await loadChangeWatchState(entry.adAccountNo);
  if (!force && isChangeWatchFresh(prev)) return;
  const now = Date.now();
  const since = prev?.scanned_until ?? now - CHANGE_WATCH_BOOTSTRAP_MS;
  try {
    const rows = await fetchChangeHistory(entry.masterCustomerId, since, now);
    const readBudget = readUpToFor(prev, "budget");
    const readExternal = readUpToFor(prev, "external");
    const cutoff = now - CHANGE_WATCH_KEEP_MS;
    // 확인한 알림도 보관 기간(60일) 동안은 남긴다 — 배지 개수만 읽음 기준으로 줄고 목록은 유지.
    const keep = (e: ChangeWatchState["events"][number]) => e.ts >= cutoff;
    // id 기준 병합 — 실패 후 같은 구간을 다시 훑어도 알림이 두 번 쌓이지 않는다.
    const byId = new Map<string, ChangeWatchState["events"][number]>();
    for (const e of prev?.events ?? []) if (keep(e)) byId.set(e.id, e);
    for (const e of classifyHistory(rows, actors)) if (keep(e)) byId.set(e.id, e);
    const next: ChangeWatchState = {
      adAccountNo: entry.adAccountNo,
      events: [...byId.values()].sort((a, b) => b.ts - a.ts),
      scanned_until: now,
      read_budget_up_to: readBudget,
      read_external_up_to: readExternal,
      fetched_at: new Date(now).toISOString(),
    };
    await saveChangeWatchState(next);
    paintChangeWatchRow(entry.adAccountNo, next);
  } catch (e) {
    console.warn("[dv-ads/change-watch] 점검 실패", entry.adAccountNo, e);
    // fetched_at은 갱신해 실패한 endpoint를 30분간 다시 두드리지 않게 한다.
    await saveChangeWatchState({
      adAccountNo: entry.adAccountNo,
      events: prev?.events ?? [],
      scanned_until: prev?.scanned_until ?? since,
      read_budget_up_to: readUpToFor(prev, "budget"),
      read_external_up_to: readUpToFor(prev, "external"),
      fetched_at: new Date(now).toISOString(),
      error: friendlyMessage(e),
    });
  }
}

/**
 * 여러 계정 점검 — 새로고침과 같은 4-worker 풀.
 *
 * 주기/진입 점검(force:false)은 이미 도는 중이면 그냥 건너뛴다. 반면 강제 점검(force:true,
 * 알림을 켜거나 제외 변경자를 바꾼 직후)은 반드시 돌아야 한다 — 그냥 skip하면 방금 비운 상태가 다음 주기(30분)
 * 까지 빈 채로 남아 알림이 사라진 것처럼 보인다. 그래서 앞 점검이 끝나길 기다렸다가 다시 돈다.
 */
async function scanChangeWatchAll(
  entries: MultiAccountDirectoryEntry[],
  force = false,
): Promise<void> {
  // 알림을 켠 계정만 — 광고주가 직접 운영하는 계정은 외부 수정이 정상이라 소음이 된다.
  const metaAll = await loadAllUserMeta();
  const targets = entries.filter(
    (e) => e.masterCustomerId && metaAll[e.adAccountNo]?.changeWatch,
  );
  if (targets.length === 0) return;
  const running = changeWatchScanPromise;
  if (running) {
    if (!force) return;
    await running.catch(() => {});
  }
  const run = (async () => {
    const actors = await loadChangeWatchIdentity();
    const queue = [...targets];
    const workers = Array.from(
      { length: Math.min(REFRESH_ALL_CONCURRENCY, queue.length) },
      async () => {
        while (queue.length > 0) {
          const entry = queue.shift();
          if (!entry) break;
          await refreshChangeWatchRow(entry, actors, force);
        }
      },
    );
    await Promise.all(workers);
    void refreshBadge();
  })();
  changeWatchScanPromise = run;
  try {
    await run;
  } finally {
    if (changeWatchScanPromise === run) changeWatchScanPromise = null;
  }
}

/** 주기 점검 1회분. 광고계정 페이지에 있을 때만 — 다른 페이지에서 괜히 호출하지 않는다. */
async function changeWatchTick(): Promise<void> {
  if (!ADACCT_URL_PATTERN.test(location.pathname)) return;
  const [dir, added] = await Promise.all([loadDirectory(), loadAddedList()]);
  const entries = pickAddedEntries(dir?.entries ?? [], added);
  if (entries.length === 0) return;
  await scanChangeWatchAll(entries, false);
}

function startChangeWatchTimer(): void {
  if (changeWatchTimer) return;
  changeWatchTimer = window.setInterval(() => void changeWatchTick(), CHANGE_WATCH_TTL_MS);
  void changeWatchTick();
}

// 변경이력 unread 개수를 dataset에 남기고 syncIssueChip으로 행 표시(⋯ 개수/배경) 갱신.
function paintChangeWatchRow(adAccountNo: number, state: ChangeWatchState | null): void {
  if (!popoverEl) return;
  const counts = {
    budget: unreadChangeWatchEvents(state, "budget").length,
    external: unreadChangeWatchEvents(state, "external").length,
  };
  const total = counts.budget + counts.external;
  for (const row of findRows(adAccountNo)) {
    row.dataset.statusChangeCount = String(total);
    row.dataset.statusChangeBudget = String(counts.budget);
    syncIssueChip(row);
  }
  scheduleHeadColSync();
}

/** 렌더 직후 일괄 칠하기 — storage.get 1회로 묶는다. */
async function paintChangeWatchRows(adAccountNos: number[]): Promise<void> {
  if (!popoverEl || adAccountNos.length === 0) return;
  const map = await loadChangeWatchStateMany(adAccountNos);
  if (!popoverEl) return;
  for (const no of adAccountNos) paintChangeWatchRow(no, map.get(no) ?? null);
}

function paintRowEmpty(adAccountNo: number) {
  if (!popoverEl) return;
  for (const row of findRows(adAccountNo)) row.classList.add("dvads-multi-tr-empty");
}

function paintRowLoading(adAccountNo: number) {
  if (!popoverEl) return;
  for (const row of findRows(adAccountNo)) paintRowSkeleton(row);
}

// 데이터 셀(data-k)별 스켈레톤 바 폭. 컬럼 성격에 맞춰 살짝씩 다르게 줘 자연스러운 로딩 모양.
const SKEL_CELL_WIDTHS: Record<string, number> = {
  bizMoney: 60,
  impressions: 46,
  clicks: 38,
  ctr: 40,
  cpc: 48,
  cost: 54,
  revenue: 58,
  conversions: 34,
  roas: 44,
};

// 한 행의 데이터 셀(data-k)을 shimmer 스켈레톤으로 덮는다. 로딩 시작 시 호출 -> 이후
// paintRow가 setCell(textContent 대입)로 실제 수치를 넣으면 스켈레톤 span이 자동으로 밀려난다.
function paintRowSkeleton(row: HTMLTableRowElement): void {
  row.classList.add("dvads-multi-tr-loading");
  row.classList.remove("dvads-multi-tr-empty");
  for (const [k, w] of Object.entries(SKEL_CELL_WIDTHS)) {
    const td = row.querySelector<HTMLTableCellElement>(`td[data-k="${k}"]`);
    if (td) td.innerHTML = `<span class="dvads-multi-skel" style="width:${w}px"></span>`;
  }
}

// 광고 유형 필터 토글 시 list view 전 행의 데이터 셀을 shimmer 스켈레톤으로 덮는다.
// 토글은 list view kebab에서만 트리거되므로 search view는 무관.
function paintAllRowsSkeleton(): void {
  if (!popoverEl) return;
  popoverEl
    .querySelectorAll<HTMLTableRowElement>("tr.dvads-multi-tr")
    .forEach((row) => paintRowSkeleton(row));
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
      ? undefined
      : `선택된 ${nos.length}개 계정에 일괄 적용`,
    initialValue: initial,
    suffix: "원",
    placeholder: "100,000",
    onConfirm: async (value) => {
      const result = await withServerSave(() => updateUserMetaMany(nos, { bizMoneyThreshold: value }));
      if (result === undefined) return;
      if (popoverEl) await renderListView(popoverEl);
      void refreshBadge();
    },
    onClear: showClear ? async () => {
      const result = await withServerSave(() =>
        updateUserMetaMany(nos, { bizMoneyThreshold: undefined }),
      );
      if (result === undefined) return;
      if (popoverEl) await renderListView(popoverEl);
      void refreshBadge();
    } : undefined,
  });
}

/**
 * 목표 광고수익률(%) 설정 — F-Brief 보고 문구에서 키워드를 초록/노랑/무색으로 분류하는 기준.
 * 비즈머니 알림과 같은 입력 패턴(단일=prefill, 다중=일괄). 알림이 아니라 설정값이라 배지 갱신은 없다.
 * 빈 값으로 확인하면 updateUserMetaMany가 undefined로 저장 → 미설정(자동 추정 안 함).
 */
async function openTargetRoasDialogFor(nos: number[]) {
  if (nos.length === 0) return;
  const metaMap = await loadAllUserMeta();
  const initial = nos.length === 1 ? (metaMap[nos[0]]?.targetRoas ?? null) : null;
  const anyConfigured = nos.some((no) => metaMap[no]?.targetRoas != null);
  const showClear = nos.length === 1 ? initial != null : anyConfigured;
  openInputDialog({
    title: "목표 수익률 설정",
    description: nos.length === 1
      ? "광고 성과 측정에서 키워드를 목표 대비 초록/노랑/무색으로 분류하는 기준입니다."
      : `선택된 ${nos.length}개 계정에 일괄 적용`,
    initialValue: initial,
    suffix: "%",
    placeholder: "800",
    onConfirm: async (value) => {
      const result = await withServerSave(() => updateUserMetaMany(nos, { targetRoas: value }));
      if (result === undefined) return;
      if (popoverEl) await renderListView(popoverEl);
    },
    onClear: showClear ? async () => {
      const result = await withServerSave(() => updateUserMetaMany(nos, { targetRoas: undefined }));
      if (result === undefined) return;
      if (popoverEl) await renderListView(popoverEl);
    } : undefined,
  });
}

/**
 * 변경이력 알림 켜기/끄기. 비즈머니·브랜드검색 알림과 같은 자리·같은 방식(계정 선택 후 설정)이나
 * 임계값이 없는 on/off라 입력창 대신 [끄기][취소][켜기] 세 버튼.
 * 끌 때는 쌓인 알림 상태도 같이 지운다 — 안 그러면 꺼둔 계정의 칩이 그대로 남는다.
 */
/** 제외 변경자 후보를 긁어올 기간. 최근 이력이 없으면 칩이 안 나오므로 넉넉히. */
const ACTOR_SCAN_DAYS = 14;

/**
 * 변경이력 알림 — 켜기/끄기 + 알림에서 제외할 변경자 선택을 한 화면에서.
 *
 * 버튼 배치는 비즈머니 알림과 동일 — [해제][취소][확인]. 해제는 선택 계정 중 하나라도
 * 켜져 있을 때만 노출(꺼진 계정엔 의미 없는 버튼). 확인 = 제외 목록 저장 + 알림 켜기이고,
 * 목록이 비면 판별이 불가능하므로(우리 것도 남의 것으로 보임) 확인을 막는다.
 *
 * 변경자 표기가 제각각(`dvcompany:naver` / `김아라` / `GW10500` / `SYSTEM`)이라 맨입력은
 * 거의 실패한다. 그래서 열면 **선택한 계정의** 최근 이력에서 실제 등장한 변경자를 긁어와
 * 칩으로 고르게 한다. 제외 목록은 계정별이 아니라 전역 — 누가 우리 사람인지는 계정과 무관.
 * 끌 때는 쌓인 알림 상태도 같이 지운다 (안 그러면 꺼둔 계정의 칩이 그대로 남는다).
 */
async function openChangeWatchDialogFor(nos: number[]): Promise<void> {
  if (nos.length === 0) return;
  closeRenameDialog();
  const [current, dir, metaMap] = await Promise.all([
    loadChangeWatchIdentity(),
    loadDirectory(),
    loadAllUserMeta(),
  ]);
  const chosen = new Set(current);
  // 해제는 이미 켜진 계정이 있을 때만 노출 — 꺼져 있는 계정엔 의미 없는 버튼이다
  // (비즈머니 알림의 해제 노출 규칙과 동일).
  const showClear = nos.some((no) => metaMap[no]?.changeWatch);

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-actor-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-actor-card";
  card.innerHTML = `
    <div class="dvads-actor-head">
      <div class="dvads-actor-title">변경이력 알림</div>
      <button class="dvads-actor-close" type="button" aria-label="닫기">×</button>
    </div>
    <div class="dvads-actor-chips is-loading"><span class="dvads-actor-spinner"></span>불러오는 중...</div>
    <div class="dvads-actor-input-wrap">
      <input class="dvads-actor-input" type="text" placeholder="변경자를 선택해 주세요" />
      <button class="dvads-actor-input-clear" type="button" aria-label="지우기">×</button>
    </div>
    <div class="dvads-actor-actions">
      ${showClear ? `<button class="dvads-cw-off dvads-btn dvads-btn-secondary" type="button">해제</button><div class="dvads-cw-spacer"></div>` : ""}
      <button class="dvads-cw-cancel dvads-btn dvads-btn-secondary" type="button">취소</button>
      <button class="dvads-cw-confirm dvads-btn dvads-btn-primary" type="button">확인</button>
    </div>
  `;
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const chipsEl = card.querySelector<HTMLDivElement>(".dvads-actor-chips")!;
  const input = card.querySelector<HTMLInputElement>(".dvads-actor-input")!;
  const clearBtn = card.querySelector<HTMLButtonElement>(".dvads-actor-input-clear")!;
  const confirmBtn = card.querySelector<HTMLButtonElement>(".dvads-cw-confirm")!;
  input.value = current.join(", ");

  // 제외할 변경자가 하나도 없으면 우리 것까지 전부 남의 것으로 보여 알림이 무의미하다.
  // 그래서 입력이 비면 확인(=켜기)을 막는다. 끄는 건 해제 버튼으로.
  const syncOnEnabled = () => {
    const empty = chosen.size === 0;
    confirmBtn.disabled = empty;
    confirmBtn.classList.toggle("is-disabled", empty);
    clearBtn.style.display = input.value === "" ? "none" : "";
  };
  // 입력창이 값의 원천 — 칩은 그 값을 편하게 넣는 수단일 뿐이다. 손으로 글자를 지웠을 때
  // 칩 선택이 남아있으면 "비운 것 같은데 안 비워진" 상태가 되므로 입력에서 되읽어 맞춘다.
  const syncFromInput = () => {
    chosen.clear();
    for (const t of input.value.split(",").map((s) => s.trim()).filter(Boolean)) chosen.add(t);
    chipsEl.querySelectorAll<HTMLButtonElement>(".dvads-actor-chip").forEach((c) => {
      c.classList.toggle("is-on", chosen.has(c.textContent ?? ""));
    });
    syncOnEnabled();
  };
  input.addEventListener("input", syncFromInput);
  clearBtn.addEventListener("click", () => {
    input.value = "";
    syncFromInput();
    input.focus();
  });
  syncOnEnabled();

  const cleanup = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); }
  };
  wireBackdropDismiss(backdrop, cleanup);
  card.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", onKey, true);
  card.querySelector<HTMLButtonElement>(".dvads-actor-close")?.addEventListener("click", cleanup);

  /**
   * 제외 목록을 저장하고 선택 계정의 알림 on/off를 적용.
   * 목록이 비면 판별 자체가 불가능하므로(우리 것도 남의 것으로 보임) 알림을 끈다 — 별도
   * "끄기" 버튼 없이 입력창을 비우는 것이 곧 끄기다.
   */
  const apply = async (turnOn: boolean) => {
    // 제외 목록도 서버 저장(user_settings) — 실패 시 토스트 후 중단(로컬만 바뀌면 PC마다 달라진다).
    const saved = await withServerSave(() => saveChangeWatchIdentity([...chosen]));
    if (saved === undefined) return;
    const result = await withServerSave(() => updateUserMetaMany(nos, { changeWatch: turnOn }));
    if (result === undefined) return;
    // 제외 목록이 바뀌었을 수 있어 기존 판정은 무효 — 비우고 처음부터 다시 훑는다.
    await clearChangeWatchStates(nos);
    if (popoverEl) await renderListView(popoverEl);
    if (turnOn) {
      // 바로 확인 — 다음 주기(30분)까지 기다리면 켠 티가 안 난다.
      await scanChangeWatchAll(pickAddedEntries(dir?.entries ?? [], nos), true);
      if (popoverEl) await paintChangeWatchRows(nos);
    }
    void refreshBadge();
  };

  // 해제 = 선택 계정 알림 끄기 + 쌓인 알림 정리. 확인 = 제외 목록 저장 + 알림 켜기.
  // 취소는 아무것도 저장하지 않고 닫기만 한다.
  card.querySelector<HTMLButtonElement>(".dvads-cw-off")?.addEventListener("click", () => {
    cleanup();
    void apply(false);
  });
  card.querySelector<HTMLButtonElement>(".dvads-cw-cancel")?.addEventListener("click", cleanup);
  confirmBtn.addEventListener("click", () => {
    if (confirmBtn.disabled) return;
    cleanup();
    void apply(true);
  });

  // ─── 변경자 후보 수집 (선택한 계정의 최근 이력) ───
  // 알림을 켜기 *전에도* 후보가 보여야 한다 — 켠 계정만 훑으면 처음 켤 때 칩이 늘 비어버린다.
  const targets = pickAddedEntries(dir?.entries ?? [], nos).filter((e) => e.masterCustomerId);
  const until = Date.now();
  const since = until - ACTOR_SCAN_DAYS * 24 * 60 * 60 * 1000;
  const found = new Set<string>(current);
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(REFRESH_ALL_CONCURRENCY, queue.length) }, async () => {
    while (queue.length > 0) {
      const e = queue.shift();
      if (!e?.masterCustomerId) break;
      try {
        const rows = await fetchChangeHistory(e.masterCustomerId, since, until);
        for (const a of observedActors(rows)) found.add(a);
      } catch (err) {
        console.warn("[dv-ads/change-watch] 변경자 수집 실패", e.adAccountNo, err);
      }
    }
  });
  await Promise.all(workers);
  if (!backdrop.isConnected) return;

  chipsEl.innerHTML = "";
  chipsEl.classList.remove("is-loading");
  const actors = [...found].sort();
  if (actors.length === 0) {
    chipsEl.textContent = "최근 이력에 변경자가 없어요. 아래에 직접 입력해 주세요";
    return;
  }
  for (const a of actors) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dvads-actor-chip";
    chip.textContent = a;
    chip.classList.toggle("is-on", chosen.has(a));
    chip.addEventListener("click", () => {
      if (chosen.has(a)) chosen.delete(a);
      else chosen.add(a);
      // 칩으로 고른 건 입력창에 쓴 뒤 입력창 기준으로 되읽는다 — 두 경로가 어긋나지 않게.
      input.value = [...chosen].join(", ");
      syncFromInput();
    });
    chipsEl.appendChild(chip);
  }
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
      ? undefined
      : `선택된 ${nos.length}개 계정에 일괄 적용`,
    initialValue: initial,
    suffix: "일",
    placeholder: "7",
    onConfirm: async (value) => {
      const result = await withServerSave(() =>
        updateUserMetaMany(nos, { brandSearchDaysThreshold: value }),
      );
      if (result === undefined) return;
      if (popoverEl) await renderListView(popoverEl);
      void refreshBadge();
    },
    onClear: showClear ? async () => {
      const result = await withServerSave(() =>
        updateUserMetaMany(nos, { brandSearchDaysThreshold: undefined }),
      );
      if (result === undefined) return;
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
 *
 * 스냅샷 저장마다 storage onChanged → refreshBadge 캐스케이드가 일어나므로 250ms 디바운스로
 * 연속 호출을 1회 재계산으로 합친다.
 */
let refreshBadgeTimer = 0;
function refreshBadge(): void {
  clearTimeout(refreshBadgeTimer);
  refreshBadgeTimer = window.setTimeout(() => {
    refreshBadgeTimer = 0;
    void refreshBadgeImpl();
  }, 250);
}

async function refreshBadgeImpl() {
  if (!buttonEl) return;
  const badge = buttonEl.querySelector<HTMLSpanElement>(".dvads-multi-btn-badge");
  if (!badge) return;
  const addedList = await loadAddedList();
  const metaMap = await loadAllUserMeta();
  // 임계값이 설정된 계정만 스냅샷 후보 — 그 계정들의 스냅샷만 한 번에 읽어 저장소 호출을 1회로 묶는다.
  // 변경이력은 임계값과 무관하게 전 계정 대상이라 따로 일괄 로드.
  const candidates = addedList.filter((no) => {
    const meta = metaMap[no];
    return !!meta && (meta.bizMoneyThreshold != null || meta.brandSearchDaysThreshold != null);
  });
  const [snapMap, changeMap] = await Promise.all([
    loadSnapshotMany(candidates),
    loadChangeWatchStateMany(addedList),
  ]);
  let count = 0;
  for (const no of addedList) {
    const meta = metaMap[no];
    const snap = snapMap.get(no);
    let alerted = false;
    if (meta && snap) {
      if (meta.bizMoneyThreshold != null && snap.bizMoney != null && snap.bizMoney <= meta.bizMoneyThreshold) {
        alerted = true;
      }
      if (!alerted && meta.brandSearchDaysThreshold != null) {
        const dday = computeMinDday(snap.contracts);
        if (dday !== null && dday <= meta.brandSearchDaysThreshold) alerted = true;
      }
    }
    if (!alerted && unreadChangeWatchEvents(changeMap.get(no) ?? null).length > 0) alerted = true;
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
        k.startsWith("multi_account_snapshot:") ||
        k.startsWith("change_watch_state:")
      ) {
        void refreshBadge();
        return;
      }
    }
  });
}

// 그룹 다중 소속 대응 — 한 계정의 모든 행을 동일하게 칠한다.
function paintRow(adAccountNo: number, snap: MultiAccountSnapshot, meta?: MultiAccountUserMeta) {
  if (!popoverEl) return;
  for (const row of findRows(adAccountNo)) paintRowEl(row, snap, meta);
}

function paintRowEl(row: HTMLTableRowElement, snap: MultiAccountSnapshot, meta?: MultiAccountUserMeta) {
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

  // 계약 D-day는 캠페인 단위 max → min으로 계산. 후속 계약 마련됐으면 자연 OFF.
  // 데이터가 채워지면 auto layout 컬럼 폭이 바뀔 수 있음 — 분리형 헤더 재동기화 (rAF 디바운스).
  scheduleHeadColSync();

  row.classList.remove("dvads-multi-tr-contract-expired");
  row.removeAttribute("title");
  const dday = computeMinDday(snap.contracts);
  // 만료(≤ 0)는 임계값 무관 항상 회색 cue — 운영 끝난 계정 시각 구분.
  if (dday !== null && dday <= 0) {
    row.classList.add("dvads-multi-tr-contract-expired");
  }

  // ─── 사용자 임계값 알림 cue ───
  // 비즈머니 셀 빨강 — 임계값 설정되어 있고 잔액이 그 이하일 때.
  const bizCell = row.querySelector<HTMLTableCellElement>(`td[data-k="bizMoney"]`);
  const bizAlert = meta?.bizMoneyThreshold != null
    && snap.bizMoney != null
    && snap.bizMoney <= meta.bizMoneyThreshold;
  bizCell?.classList.toggle("dvads-multi-td-biz-alert", bizAlert);

  // 브랜드검색 임계 도달 — 비즈머니처럼 단순 빨강(펄스 없음). 계정명만 색 변경 +
  // 호버 시 커스텀 툴팁(브랜드검색 페이지로 가는 [연장하기] 버튼 포함).
  const brandAlert = meta?.brandSearchDaysThreshold != null
    && dday !== null
    && dday <= meta.brandSearchDaysThreshold;
  row.classList.toggle("dvads-multi-tr-brand-alert", brandAlert);
  // 툴팁 컨텍스트 저장 — 호버 핸들러가 읽어서 N일/계정번호 추출.
  if (brandAlert && dday !== null) {
    row.dataset.brandDday = String(dday);
  } else {
    delete row.dataset.brandDday;
  }

  // 알림 배지 재료 — 광고주센터 알림(프로모션·추천 제외분). 실제 그리기는 syncIssueChip.
  const issues = snap.issues ?? [];
  row.dataset.statusIssueCount = String(issues.length);
  row.dataset.statusIssueTitles = issues.map((i) => i.title).join("\n");
  syncIssueChip(row);
}

/**
 * 계정 이슈 표시는 서로 다른 시점에 도는 두 경로가 칠한다 — 스냅샷 paint(알림 피드)와
 * 변경이력 스캔(예산/수정). 각 경로는 dataset에 자기 판정만 남기고 여기서 합쳐 그린다.
 * 개수 = 변경이력 unread + 광고주센터 알림 이슈. 이슈가 있으면 계정명 왼쪽에 빨간 원형
 * 개수 배지 + 행 배경 연한 빨강 — 확인(패널 [모두 읽음])하면 배지가 사라진다.
 */
function syncIssueChip(row: HTMLTableRowElement) {
  const badge = row.querySelector<HTMLButtonElement>(".dvads-multi-issue-badge");
  if (!badge) return;
  const naver = Number(row.dataset.statusIssueCount ?? "0");
  const change = Number(row.dataset.statusChangeCount ?? "0");
  const budget = Number(row.dataset.statusChangeBudget ?? "0");
  const total = naver + change;
  row.classList.toggle("dvads-multi-tr-issues", total > 0);
  if (total === 0) {
    badge.style.display = "none";
    badge.textContent = "";
    return;
  }
  const text = total > 99 ? "99+" : String(total);
  badge.textContent = text;
  badge.style.display = "";
  badge.classList.toggle("is-two-digit", text.length === 2);
  badge.classList.toggle("is-three-digit", text.length >= 3);
  const lines: string[] = [];
  if (budget > 0) lines.push("예산을 다 써서 멈춘 광고가 있어요");
  if (change - budget > 0) lines.push("우리가 아닌 다른 사람이 광고를 수정했어요");
  if (row.dataset.statusIssueTitles) lines.push(row.dataset.statusIssueTitles);
  badge.title = lines.join("\n");
}

// ─── 변경이력 알림 상세 패널 ─────────────────────────────────────────────
//
// 행의 아이콘 칩 클릭 → "계정 이슈" 패널. 예산/수정을 한 목록으로 합치고
// 탭(전체/예산/수정/기타)으로 거른다. [모두 읽음]을 누르면 그 시점까지를
// 읽음 처리해 다음부터는 새 이력만 알린다.

let changePanelEl: HTMLDivElement | null = null;
let changePanelKey: string | null = null;

function closeChangeWatchPanel(): void {
  changePanelEl?.remove();
  changePanelEl = null;
  changePanelKey = null;
  document.removeEventListener("mousedown", onChangePanelPointer, true);
  document.removeEventListener("keydown", onChangePanelKey, true);
}

function onChangePanelPointer(e: MouseEvent): void {
  if (!changePanelEl) return;
  const t = e.target as HTMLElement | null;
  if (!t || changePanelEl.contains(t)) return;
  // 배지 클릭은 openChangeWatchPanel이 토글로 처리 — 여기서 먼저 닫으면 곧바로 다시 열린다.
  if (t.closest?.(".dvads-multi-issue-badge")) return;
  closeChangeWatchPanel();
}

function onChangePanelKey(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  // capture 단계에서 먼저 삼켜 popover까지 같이 닫히지 않게 한다.
  e.stopPropagation();
  closeChangeWatchPanel();
}

/**
 * 문구는 수집 시점에 저장돼 이미 쌓인 알림은 옛 문장을 그대로 들고 있다. 그리기 직전에
 * 예산 잠금 문장만 현행 표기("... 일 예산 50,000원 초과")로 바꿔 준다.
 */
function displaySummary(summary: string): string {
  const m = /^(.+?) 일예산 (.+?)원을 다 써서 광고가 멈췄어요$/.exec(summary);
  if (m) return `${m[1]} 일 예산 ${m[2]}원 도달`;
  const m2 = /^(.+?) 예산을 다 써서 광고가 멈췄어요$/.exec(summary);
  if (m2) return `${m2[1]} 일 예산 도달`;
  return summary;
}

function formatEventTime(ts: number): string {
  const d = new Date(ts);
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

// 탭 필터 — "기타"는 예산/수정 어느 쪽도 아닌 종류(현재는 없지만 종류가 늘 때를 대비).
const CHANGE_PANEL_TABS = [
  { id: "all", label: "전체" },
  { id: "budget", label: "예산" },
  { id: "external", label: "수정" },
  { id: "etc", label: "기타" },
] as const;
type ChangePanelTab = (typeof CHANGE_PANEL_TABS)[number]["id"];

function filterChangeEvents(events: ChangeWatchEvent[], tab: ChangePanelTab): ChangeWatchEvent[] {
  if (tab === "all") return events;
  if (tab === "budget") return events.filter((e) => e.kind === "budget");
  if (tab === "external") return events.filter((e) => e.kind === "external");
  return events.filter((e) => e.kind !== "budget" && e.kind !== "external");
}

async function openChangeWatchPanel(
  entry: MultiAccountDirectoryEntry,
  anchor: HTMLElement,
): Promise<void> {
  // 같은 칩을 다시 누르면 닫기(토글).
  const key = String(entry.adAccountNo);
  if (changePanelKey === key) {
    closeChangeWatchPanel();
    return;
  }
  closeChangeWatchPanel();
  const [state, snap] = await Promise.all([
    loadChangeWatchState(entry.adAccountNo),
    loadSnapshot(entry.adAccountNo),
  ]);
  // 예산/수정을 한 목록으로 — 최신이 위. 확인한 것도 보관 기간(60일) 동안 계속 보여준다.
  const unread = [...(state?.events ?? [])].sort((a, b) => b.ts - a.ts);
  // 광고주센터 알림 이슈(소재 보류 등) — 읽음 개념 없이 네이버가 내리는 동안 유지.
  const naverIssues = snap?.issues ?? [];
  if (!popoverEl || !anchor.isConnected) return;
  // 이슈가 하나도 없어도 패널은 연다 — 케밥에서 눌렀을 때 아무 반응 없으면 고장으로 보인다.
  const isEmpty = unread.length === 0 && naverIssues.length === 0;

  const panel = document.createElement("div");
  panel.className = "dvads dvads-change-panel";
  panel.innerHTML = `
    <div class="dvads-change-panel-head">
      <span class="dvads-change-panel-title">계정 이슈</span>
      <button class="dvads-change-panel-close" type="button" aria-label="닫기">✕</button>
    </div>
    <div class="dvads-change-panel-tabs">
      <div class="dvads-change-panel-tablist" role="tablist"></div>
      <button class="dvads-change-panel-read" type="button">모두 읽음</button>
    </div>
    <div class="dvads-change-panel-list"></div>
  `;

  const list = panel.querySelector<HTMLDivElement>(".dvads-change-panel-list")!;
  // 아주 많으면 스크롤보다 상한이 낫다 — 읽음을 누르면 어차피 전부 읽음 처리된다.
  const MAX_SHOWN = 50;
  const renderList = (tab: ChangePanelTab) => {
    list.textContent = "";
    const shown = filterChangeEvents(unread, tab);
    // 광고주센터 알림 이슈는 "전체" 탭 맨 위에 — 변경이력과 달리 읽음 처리 대상이 아니다.
    if (tab === "all") {
      for (const iss of naverIssues) {
        const item = document.createElement("div");
        item.className = "dvads-change-item";
        const who = document.createElement("span");
        who.className = "dvads-change-kind";
        who.textContent = "알림";
        const top = document.createElement("div");
        top.className = "dvads-change-item-top";
        top.append(who);
        const summary = document.createElement("div");
        summary.className = "dvads-change-summary";
        summary.textContent = iss.title;
        item.append(top, summary);
        list.appendChild(item);
      }
    }
    if (shown.length === 0 && (tab !== "all" || naverIssues.length === 0)) {
      const empty = document.createElement("div");
      empty.className = "dvads-change-more";
      empty.textContent = "표시할 알림이 없어요";
      list.appendChild(empty);
      return;
    }
    for (const ev of shown.slice(0, MAX_SHOWN)) {
      const item = document.createElement("div");
      item.className = "dvads-change-item";
      const who = document.createElement("span");
      who.className = "dvads-change-kind";
      who.textContent = ev.kind === "budget" ? "예산 소진" : ev.actor;
      const when = document.createElement("span");
      when.className = "dvads-change-when";
      when.textContent = formatEventTime(ev.ts);
      const top = document.createElement("div");
      top.className = "dvads-change-item-top";
      top.append(who, when);
      const target = document.createElement("div");
      target.className = "dvads-change-target";
      target.textContent = ev.target || "-";
      const summary = document.createElement("div");
      summary.className = "dvads-change-summary";
      summary.textContent = displaySummary(ev.summary);
      item.append(top, target, summary);
      list.appendChild(item);
    }
    if (shown.length > MAX_SHOWN) {
      const more = document.createElement("div");
      more.className = "dvads-change-more";
      more.textContent = `외 ${shown.length - MAX_SHOWN}건 더 있어요`;
      list.appendChild(more);
    }
  };

  const tablist = panel.querySelector<HTMLDivElement>(".dvads-change-panel-tablist")!;
  // 이슈 0건이면 탭/읽음 버튼은 의미가 없어 통째로 감추고 안내 한 줄만 보여준다.
  if (isEmpty) {
    panel.classList.add("is-empty");
    panel.querySelector(".dvads-change-panel-tabs")?.remove();
    const empty = document.createElement("div");
    empty.className = "dvads-change-more";
    empty.textContent = "해당 계정에 이슈가 없습니다";
    list.appendChild(empty);
  }
  for (const t of isEmpty ? [] : CHANGE_PANEL_TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dvads-change-panel-tab" + (t.id === "all" ? " is-active" : "");
    btn.textContent = t.label;
    btn.addEventListener("click", () => {
      tablist
        .querySelectorAll(".dvads-change-panel-tab")
        .forEach((el) => el.classList.toggle("is-active", el === btn));
      renderList(t.id);
    });
    tablist.appendChild(btn);
  }
  if (!isEmpty) renderList("all");

  panel.addEventListener("click", (e) => e.stopPropagation());
  panel
    .querySelector<HTMLButtonElement>(".dvads-change-panel-close")
    ?.addEventListener("click", () => closeChangeWatchPanel());
  panel.querySelector<HTMLButtonElement>(".dvads-change-panel-read")?.addEventListener("click", () => {
    void (async () => {
      const cur = await loadChangeWatchState(entry.adAccountNo);
      if (cur) {
        // 두 종류 모두 저장된 전체 중 최신 시각까지 읽음 처리하고 목록을 비운다 (저장소 절약).
        const upTo = (k: ChangeWatchEvent["kind"]) =>
          cur.events
            .filter((e) => e.kind === k)
            .reduce((m, e) => Math.max(m, e.ts), readUpToFor(cur, k));
        // 읽음 기준만 올리고 events는 그대로 — 목록은 보관 기간(60일)까지 남는다.
        const next: ChangeWatchState = {
          ...cur,
          read_budget_up_to: upTo("budget"),
          read_external_up_to: upTo("external"),
        };
        await saveChangeWatchState(next);
        paintChangeWatchRow(entry.adAccountNo, next);
        void refreshBadge();
      }
      closeChangeWatchPanel();
    })();
  });

  document.body.appendChild(panel);
  changePanelEl = panel;
  changePanelKey = key;

  // 위치 — 칩 아래 좌측 정렬. 아래 공간이 모자라면 위로 뒤집는다.
  const a = anchor.getBoundingClientRect();
  const p = panel.getBoundingClientRect();
  const GAP = 8;
  let left = a.left;
  if (left + p.width > window.innerWidth - 8) left = window.innerWidth - 8 - p.width;
  if (left < 8) left = 8;
  let top = a.bottom + GAP;
  if (top + p.height > window.innerHeight - 8) top = Math.max(8, a.top - p.height - GAP);
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;

  document.addEventListener("mousedown", onChangePanelPointer, true);
  document.addEventListener("keydown", onChangePanelKey, true);
}

// ─── 브랜드검색 알림 호버 툴팁 ───────────────────────────────────────────
//
// 임계값 도달한(빨강) 행에 마우스 올리면 "브랜드검색 종료 N일 전" + [연장하기] 버튼.
// 버튼 클릭 시 해당 광고계정의 브랜드검색 페이지를 새 탭에서 연다 (SPA URL은 "BRAND").
//
// 패턴: 모듈 단위 단일 element. 행/툴팁 사이를 마우스가 오갈 때 잠깐 hide 지연(120ms)을 둬
// 끊김 없이 자연스러운 호버 → 클릭 흐름이 되도록 한다.

let brandTooltipEl: HTMLDivElement | null = null;
let brandTooltipRowKey: string | null = null;
let brandTooltipHideTimer: number | null = null;

function showBrandTooltip(row: HTMLTableRowElement, anchor: HTMLElement) {
  const ddayStr = row.dataset.brandDday;
  const adAccountNo = row.dataset.adAccountNo;
  if (!ddayStr || !adAccountNo) return;
  const dday = parseInt(ddayStr, 10);
  if (!Number.isFinite(dday)) return;

  // 같은 행에 이미 떠 있으면 위치/내용 재계산 skip — 깜빡임 방지.
  if (brandTooltipRowKey === adAccountNo && brandTooltipEl?.isConnected) return;
  hideBrandTooltip();

  const tip = document.createElement("div");
  tip.className = "dvads dvads-brand-tooltip";
  tip.dataset.adAccountNo = adAccountNo;

  const msg = document.createElement("span");
  msg.className = "dvads-brand-tooltip-msg";
  msg.textContent = dday <= 0 ? "브랜드검색 계약 만료" : `브랜드검색 종료 ${dday}일 전`;
  tip.appendChild(msg);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dvads-btn dvads-btn-primary dvads-brand-tooltip-btn";
  btn.textContent = "연장하기";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // 새 탭에서 브랜드검색 페이지로 — 다른 행 click 처리(WEB_SITE)와 동일 패턴.
    // SPA URL은 API와 동일한 "BRAND_SEARCH" 풀네임 (단순 "BRAND"는 파워링크로 리다이렉트).
    const url = `/manage/ad-accounts/${adAccountNo}/sa/campaigns-by/BRAND_SEARCH`;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.click();
  });
  tip.appendChild(btn);

  // 툴팁 자체 hover guard — 툴팁 위에 마우스 있는 동안엔 hide 안 함.
  tip.addEventListener("mouseenter", cancelHideBrandTooltip);
  tip.addEventListener("mouseleave", scheduleHideBrandTooltip);

  document.body.appendChild(tip);
  brandTooltipEl = tip;
  brandTooltipRowKey = adAccountNo;

  // 위치 — anchor(계정명 셀) 상단 중앙. 화살표가 아래쪽으로 향함. 위쪽 공간 부족하면
  // anchor 아래로 fallback (꼬리 방향도 자동 반전).
  const anchorRect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const GAP = 10;
  let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
  if (left < 8) left = 8;
  if (left + tipRect.width > window.innerWidth - 8) {
    left = window.innerWidth - 8 - tipRect.width;
  }
  let top = anchorRect.top - tipRect.height - GAP;
  let placement: "top" | "bottom" = "top";
  if (top < 8) {
    top = anchorRect.bottom + GAP;
    placement = "bottom";
  }
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.dataset.placement = placement;
  // 화살표 가로 위치 — anchor 중심 X에서 툴팁 left를 뺀 값. clamp로 양 끝 14px 유지.
  const arrowOffset = Math.max(
    14,
    Math.min(tipRect.width - 14, anchorRect.left + anchorRect.width / 2 - left),
  );
  tip.style.setProperty("--dvads-brand-tooltip-arrow-x", `${arrowOffset}px`);
}

function hideBrandTooltip() {
  cancelHideBrandTooltip();
  brandTooltipEl?.remove();
  brandTooltipEl = null;
  brandTooltipRowKey = null;
}

function scheduleHideBrandTooltip() {
  cancelHideBrandTooltip();
  brandTooltipHideTimer = window.setTimeout(() => {
    hideBrandTooltip();
  }, 120);
}

function cancelHideBrandTooltip() {
  if (brandTooltipHideTimer !== null) {
    clearTimeout(brandTooltipHideTimer);
    brandTooltipHideTimer = null;
  }
}

function paintRowError(adAccountNo: number, message: string) {
  if (!popoverEl) return;
  for (const row of findRows(adAccountNo)) {
    row.classList.remove("dvads-multi-tr-loading");
    // 실패 행에 스켈레톤이 남아 영원히 shimmer 하지 않게 수치 자리를 "-"로 되돌린다.
    row.querySelectorAll<HTMLTableCellElement>("td[data-k]").forEach((td) => {
      if (td.querySelector(".dvads-multi-skel")) td.textContent = "-";
    });
    const nameTd = row.querySelector<HTMLTableCellElement>(".dvads-multi-td-name");
    if (!nameTd) continue;
    let errEl = nameTd.querySelector<HTMLSpanElement>(".dvads-multi-row-error");
    if (!errEl) {
      errEl = document.createElement("span");
      errEl.className = "dvads-multi-row-error";
      nameTd.appendChild(errEl);
    }
    errEl.textContent = message;
  }
}

// 그룹 다중 소속으로 같은 계정이 여러 섹션에 중복 렌더될 수 있어, 한 계정의 모든 행을 반환.
// paint/체크박스 동기화는 이 목록 전체에 적용해야 한다.
function findRows(adAccountNo: number): HTMLTableRowElement[] {
  if (!popoverEl) return [];
  return Array.from(
    popoverEl.querySelectorAll<HTMLTableRowElement>(
      `tr.dvads-multi-tr[data-ad-account-no="${adAccountNo}"]`,
    ),
  );
}

/**
 * 캠페인 단위로 가장 늦은 종료일(current/next 통합)을 보고, 그 max들 중 가장 임박한 것을
 * 계정 D-day로 반환. "후속 계약 마련됨" 시나리오를 자연 처리 — 같은 캠페인에 새 광고그룹/
 * next contract가 있으면 그 종료일이 max로 채택되어 알림 OFF.
 *
 * 예: 캠페인 X = 그룹A(current 5/30) + 그룹B(next 5/31~8/30) → max = 8/30 → D-100
 *     → 임계값 60일이면 알림 OFF (정상, 후속 마련됨).
 *
 * 매핑이 빠진 contract(`nccCampaignId` 빈 값)는 단일 버킷에 모음 — 가능한 한 같은 캠페인
 * 취급해 보수적으로(min) 평가.
 */
function computeMinDday(contracts: MultiAccountSnapshot["contracts"]): number | null {
  if (!contracts || contracts.length === 0) return null;
  const maxMsByCampaign = new Map<string, number>();
  for (const c of contracts) {
    if (!c.endDate) continue;
    const ms = new Date(c.endDate).getTime();
    if (!Number.isFinite(ms)) continue;
    const key = c.nccCampaignId || "_unknown";
    const prev = maxMsByCampaign.get(key);
    if (prev === undefined || ms > prev) maxMsByCampaign.set(key, ms);
  }
  if (maxMsByCampaign.size === 0) return null;
  const now = Date.now();
  let minDays: number | null = null;
  for (const ms of maxMsByCampaign.values()) {
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
