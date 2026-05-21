/**
 * F001 — 파워링크 키워드 오버레이.
 *
 * 활성 경로: `ads.naver.com/manage/ad-accounts/*\/sa/adgroups/*` (검색광고 그룹의 키워드 탭)
 *
 * 동작:
 *   1. `td.ad-cms-table-cell-fix-start` 안의 `span.keyword` 노드를 모두 찾음
 *   2. <td>에 absolute 배지 mount (우측 끝 정렬)
 *   3. 같은 행의 입찰가 셀에서 현재 입찰가 파싱 → estimateRank로 추정 순위 산출
 *   4. 배지 상태:
 *      - loading        — 분석 중 스피너
 *      - ok + rank      — "현재 N위 ▾" (brand) / "순위권 밖 ▾" (warn)
 *      - ok + no bid    — "1~10위 ▾" fallback (입찰가 셀 못 찾았을 때)
 *      - warn (no-cred) — "API 키 미등록" 클릭 시 옵션 페이지
 *   5. MutationObserver로 가상화 행 추가·삭제·입찰가 변경 시 자동 재계산
 *   6. 키워드 텍스트 → 250ms debounced batched `GET_BID_ESTIMATE`
 */

import "@/styles/overlay.css";
import type {
  GetBidEstimateRequest,
  GetBidEstimateResponse,
  RefreshActiveTabResponse,
} from "@/types/messages";
import {
  MAX_POSITION_BY_DEVICE,
  type KeywordPerformanceCache,
  type KeywordVolumeCache,
  type RankPosition,
} from "@/types/storage";
import { DEFAULT_DEVICE, type AdDevice } from "@/types/device";
import { estimateRank, type EstimatedRank } from "@/lib/rank";
import { applyBidToRow, describeFailure } from "@/content/dom-bid";
import { openConfirmDialog } from "@/content/confirm-dialog";
import { showToast } from "@/content/toast";
import { invalidateBids } from "@/lib/volume-cache";
import { invalidatePerformance } from "@/lib/performance-cache";
import { initPeriodCompare } from "@/content/period-compare";
import { initAssetBulk } from "@/content/asset-bulk";
import { initMultiAccount } from "@/content/multi-account";
import { attachTooltip } from "@/content/tooltip";

declare const __APP_VERSION__: string;
console.log(`[dv-ads] content script loaded · v${__APP_VERSION__}`);

// F-PoP — 전후 비교 모듈. 6개 매체 페이지에서 우측 상단 날짜 picker 옆에
// 버튼 주입 + 캡처된 stats fetch replay. F001과 독립적으로 동작.
initPeriodCompare();

// F-AssetBulk — 파워링크 확장소재 일괄 등록. ads.naver.com 광고그룹 페이지의
// "+ 새 확장 소재" 드롭다운에 "일괄 등록" 항목 주입. F001과 같은 URL 패턴이라
// 독립 init하면서 자체 MutationObserver로 메뉴 mount를 따라간다.
initAssetBulk();

// F-MultiAccount — 다계정 대시보드. 광고관리자 페이지 우상단에 fixed 버튼 주입.
// 명단/어제 데이터/비즈머니/계약 D-day 표시. F001/F-PoP과 독립적으로 동작.
initMultiAccount();

const KEYWORD_CELL_SELECTOR = "td.ad-cms-table-cell-fix-start";
const KEYWORD_SPAN_SELECTOR = "span.keyword";
const KEYWORD_PAGE_PATTERN = /\/sa\/adgroups\//;
const POLL_DEBOUNCE_MS = 250;

interface BadgeMount {
  badge: HTMLElement;
  keyword: string;
  cell: HTMLElement;
  /** 같은 행의 "현재 입찰가" — 파싱 실패 시 null */
  currentBid: number | null;
  /** 같은 행의 입찰가 td — F001 행 클릭으로 입찰가 변경 시 reference */
  bidCell: HTMLElement | null;
}

// "[기본] 700원", "1,000원", "700 원" 등 다양한 표기를 잡는다.
// HTML 구조가 확정되면 더 특정한 셀렉터로 좁힐 수 있음 (현재는 row 안의 "원" 포함 셀 중 첫 매치).
const BID_TEXT_PATTERN = /([\d,]+)\s*원/;

function parseBidText(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = text.match(BID_TEXT_PATTERN);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

interface BidCellMatch {
  bid: number;
  cell: HTMLElement;
}

function findBidCellAndValue(cell: HTMLElement): BidCellMatch | null {
  const row = cell.closest("tr");
  if (!row) return null;
  // 같은 행의 모든 <td>를 훑어 첫 번째 "N원" 패턴 매치를 채택.
  // 키워드 셀 자신은 제외 (드물게 키워드명에 "원"이 포함될 수 있음).
  for (const td of row.querySelectorAll<HTMLElement>("td")) {
    if (td === cell) continue;
    const bid = parseBidText(td.textContent);
    if (bid != null) return { bid, cell: td };
  }
  return null;
}

const mounts = new Map<HTMLElement, BadgeMount>();
// 키 = `<device>:<keyword>` — 같은 키워드라도 디바이스가 다르면 별도 엔트리
const dataCache = new Map<string, KeywordVolumeCache>();
// 키 = `<device>:<keyword>:<bid>` — 디바이스·bid 모두 키에 포함
const perfCache = new Map<string, KeywordPerformanceCache>();
let credentialState: "unknown" | "ok" | "missing" = "unknown";
let lastError: string | null = null;
let openPopover: HTMLElement | null = null;
// 입찰가 변경 적용 중에는 페이지 측 자동 click(셀/버튼/확정 모달) 버블링이
// 우리 onDocClick에 도달해 팝오버를 닫는 사고가 나기 때문에 잠깐 끈다.
// 토큰 카운터: 변경 → Undo로 작업이 연속될 때 먼저 발행된 setTimeout이
// 더 늦은 작업 중간에 suppress를 풀어버리는 race를 막는다.
let popoverAutoCloseSuppressed = false;
let suppressToken = 0;

function suppressPopoverClose(holdMs: number): void {
  popoverAutoCloseSuppressed = true;
  const myToken = ++suppressToken;
  window.setTimeout(() => {
    // 더 새로운 호출이 있었다면 그쪽 타이머에 양보 — 가장 마지막 token만 해제 권한.
    if (suppressToken === myToken) {
      popoverAutoCloseSuppressed = false;
    }
  }, holdMs);
}
let openPopoverCleanup: (() => void) | null = null;

const dataKey = (keyword: string, device: AdDevice): string =>
  `${device}:${keyword}`;
const perfKey = (keyword: string, bid: number, device: AdDevice): string =>
  `${device}:${keyword}:${bid}`;

function isKeywordPage(): boolean {
  return KEYWORD_PAGE_PATTERN.test(location.pathname);
}

// ─── scan & mount ───

function scan() {
  if (!isKeywordPage()) {
    teardown();
    return;
  }
  const cells = document.querySelectorAll<HTMLElement>(KEYWORD_CELL_SELECTOR);
  cells.forEach(ensureBadge);

  // 가상화 테이블에서 DOM에서 떨어진 셀의 mount는 정리
  for (const cell of Array.from(mounts.keys())) {
    if (!cell.isConnected) {
      mounts.delete(cell);
    }
  }

  schedulePoll();
}

function ensureBadge(cell: HTMLElement) {
  const keywordSpan = cell.querySelector<HTMLElement>(KEYWORD_SPAN_SELECTOR);
  if (!keywordSpan) return;
  const keyword = (keywordSpan.textContent ?? "").trim();
  if (!keyword) return;

  const bidMatch = findBidCellAndValue(cell);
  const currentBid = bidMatch?.bid ?? null;
  const bidCell = bidMatch?.cell ?? null;

  const existing = mounts.get(cell);
  if (existing) {
    if (existing.keyword === keyword && existing.badge.isConnected) {
      // 입찰가가 바뀌었으면 mount의 currentBid도 갱신 (MutationObserver가 셀 변경 감지)
      existing.currentBid = currentBid;
      existing.bidCell = bidCell;
      renderBadge(existing);
      return;
    }
    // 키워드 변경됐거나 배지가 떨어져 나감 — 재mount
    existing.badge.remove();
    mounts.delete(cell);
  }

  // 이미 같은 셀 안에 배지가 있다면(이전 mount 잔재) 제거
  cell.querySelectorAll(".dvads-rank-badge").forEach((el) => el.remove());

  // <td>를 absolute 컨테이너로 만들기 — static이면 relative로 승격.
  // table-cell에 position:relative는 가시 변화 없는 안전 변경.
  if (getComputedStyle(cell).position === "static") {
    cell.style.position = "relative";
  }

  const badge = document.createElement("span");
  badge.classList.add("dvads", "dvads-rank-badge", "cell-anchor");
  cell.appendChild(badge);

  const mount: BadgeMount = { badge, keyword, cell, currentBid, bidCell };
  mounts.set(cell, mount);
  renderBadge(mount);
}

function renderBadge(m: BadgeMount) {
  m.badge.replaceChildren();
  // 상태 모디파이어만 갈아끼우고 cell-anchor(absolute 위치 클래스)는 보존
  m.badge.className = "dvads dvads-rank-badge cell-anchor";
  // 이전 상태의 tooltip 핸들러 초기화 — 분기에서 필요하면 다시 attach
  m.badge.onmouseenter = null;
  m.badge.onmouseleave = null;

  if (credentialState === "missing") {
    m.badge.classList.add("warn");
    m.badge.textContent = "API 키 미등록";
    m.badge.onclick = (e) => {
      e.stopPropagation();
      void chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    };
    return;
  }

  // 배지 자체는 DEFAULT_DEVICE 기준 — 사용자가 popover를 열면 그 안에서 디바이스 토글.
  const data = dataCache.get(dataKey(m.keyword, DEFAULT_DEVICE));
  if (!data) {
    if (lastError) {
      // 에러 상태는 ⚠ 아이콘만 표시 — 풀 문구는 hover 시 custom tooltip으로.
      // native title 속성은 ads.naver.com의 자체 hover 처리에 가려져 안 뜨는 케이스가
      // 확인됨(2026-05-19) — 우리가 직접 floating element로 띄운다.
      m.badge.classList.add("warn", "icon");
      m.badge.textContent = "⚠";
      m.badge.title = lastError; // fallback (a11y/지원 도구)
      attachTooltip(m.badge, lastError, { placement: "bottom" });
      m.badge.onclick = null;
    } else {
      // 로딩 상태는 스피너만 — 텍스트 없음 (CSS ::before가 스피너 렌더)
      m.badge.classList.add("loading");
      m.badge.textContent = "";
      m.badge.onmouseenter = null;
      m.badge.onmouseleave = null;
      m.badge.onclick = null;
    }
    return;
  }

  // 입찰가 알면 추정 순위 계산 → "N위" / "순위권 밖"
  // 모르면 fallback "시세"
  const rank: EstimatedRank | null =
    m.currentBid != null ? estimateRank(m.currentBid, data.rank_to_bid) : null;

  let label: string;
  if (rank === null) {
    label = "시세";
  } else if (rank === "out") {
    label = "10위+";
    m.badge.classList.add("muted");
  } else {
    label = `${rank}위`;
  }
  m.badge.textContent = label;
  m.badge.onclick = (e) => {
    e.stopPropagation();
    togglePopover(m.badge, m);
  };
}

// ─── popover ───

/**
 * popover 인스턴스의 디바이스 상태. 매 popover 오픈 시 DEFAULT_DEVICE(모바일)로 초기화.
 * `selectDevice()` 가 이 값을 변경하고 popover body를 re-render.
 */
let openPopoverDevice: AdDevice = DEFAULT_DEVICE;
/** PC lazy fetch 진행 중 토큰 — 빠른 토글 연타에서 마지막 요청만 반영. */
let inflightDevice: AdDevice | null = null;
/** popover에 표시 중인 mount — 외부 응답이 도착했을 때 re-render 대상 식별용. */
let openPopoverMount: BadgeMount | null = null;
/**
 * popover 오픈 시점에 측정한 PC 기준 높이 — flip(아래→위 뒤집기) 결정을 device 토글
 * 사이에도 일관되게 유지하기 위함. 0이면 아직 측정 전.
 * 매 프레임 reposition은 pr.height로 실제 위치 계산하되, "fit below" 여부는 이 값으로 판단.
 */
let openPopoverFlipHeight = 0;

function togglePopover(anchor: HTMLElement, mount: BadgeMount) {
  if (openPopover) {
    if (openPopoverMount === mount) {
      // 같은 배지 재클릭 — toggle off로 fade-out 후 종료
      closePopover();
      return;
    }
    // 다른 mount로 전환 — fade-out 생략하고 즉시 제거. 새 popover의 entrance가
    // 시각 연결을 받아주므로 사용자에겐 자연스러운 "교체"로 보임.
    // (140ms fade-out 중 새 popover가 mount되면 둘이 겹쳐 보이는 race 회피)
    closePopoverImmediate();
  }
  // default device 캐시가 비어있으면 popover 의미 없음 — 무시 (배지 loading 상태)
  if (!dataCache.get(dataKey(mount.keyword, DEFAULT_DEVICE))) return;

  // 안전망 — 어떤 race로든 DOM에 남은 잔존 popover 즉시 정리. closePopover는
  // setTimeout으로 140ms 후 제거하는 비동기 path라 빠른 연타에서 누락 가능.
  document.querySelectorAll(".dvads-popover").forEach((el) => el.remove());

  openPopoverDevice = DEFAULT_DEVICE;
  openPopoverMount = mount;
  inflightDevice = null;
  openPopoverFlipHeight = 0;

  const popover = document.createElement("div");
  popover.className = "dvads dvads-popover";
  popover.style.position = "fixed";
  popover.style.zIndex = "2147483647";
  const wrap = buildPopoverBody(mount, openPopoverDevice);
  // 첫 mount entrance — wrap에 translateY+opacity keyframe. popover 자체의 transform은
  // 위치 계산용이라 손대지 않고, 내부 wrap에 entrance를 적용해 충돌 회피.
  wrap.classList.add("dvads-popover-content-enter");
  popover.appendChild(wrap);
  document.body.appendChild(popover);

  openPopover = popover;

  // 배지 위치 기준으로 popover 재배치. 매 프레임 rAF 루프로 호출되어 픽셀 단위로 따라붙는다.
  const reposition = () => {
    if (!anchor.isConnected) {
      closePopover();
      return;
    }
    // 매 프레임 안전망 — openPopover 외 다른 .dvads-popover가 DOM에 남아있으면 강제 제거.
    // togglePopover의 closePopoverImmediate + 안전망 이외 경로로 잔존 popover가 생기는
    // race를 마지막 방어선으로 차단 (스크린샷 1300013에서 사용자 보고됨).
    const allPopovers = document.querySelectorAll<HTMLElement>(".dvads-popover");
    if (allPopovers.length > 1) {
      for (const el of Array.from(allPopovers)) {
        if (el !== popover) el.remove();
      }
    }
    const rect = anchor.getBoundingClientRect();
    // 배지가 가상화로 화면에서 사라졌으면 닫기
    if (rect.width === 0 && rect.height === 0) {
      closePopover();
      return;
    }
    const pr = popover.getBoundingClientRect();
    // 첫 측정값(보통 PC 기준)을 flip 결정의 기준 높이로 freeze.
    // 이후 device 토글로 실제 pr.height가 줄어도 flip 방향은 그대로 유지 — 위치 jitter 방지.
    if (openPopoverFlipHeight === 0 && pr.height > 0) {
      openPopoverFlipHeight = pr.height;
    }
    const flipH = openPopoverFlipHeight || pr.height;

    // 좌우: 우측 viewport 밖이면 좌측으로 끌어옴
    let left = Math.max(8, rect.left);
    if (left + pr.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pr.width - 8);
    }
    // 상하: 기본은 배지 아래(rect.bottom + 4). flip 여부는 flipH(고정값)로 판단해
    // device 토글 사이에 결정이 뒤집히지 않게.
    let top = rect.bottom + 4;
    if (top + flipH > window.innerHeight - 8) {
      const above = rect.top - flipH - 4;
      if (above >= 8) {
        // 배지 위로 flip — bottom 엣지 안정성 위해 실제 pr.height로 위치 계산
        top = rect.top - pr.height - 4;
      } else {
        // viewport 하단에 clamp — 고정 높이 기준
        top = Math.max(8, window.innerHeight - flipH - 8);
      }
    }
    // transform으로 통째로 이동 — top/left 변경보다 합성 단계에서 처리돼 더 매끄럽다
    popover.style.transform = `translate(${left}px, ${top}px)`;
  };
  // 초기 위치는 transform 기반이므로 top/left는 0
  popover.style.top = "0";
  popover.style.left = "0";
  reposition();

  // continuous rAF 루프 — popover 열려있는 동안 매 프레임 위치 동기화.
  // 스크롤·리사이즈 이벤트보다 1프레임 빠르고 (paint 직전 갱신), 호스트의 중첩 스크롤
  // 컨테이너에 listener를 달지 않아도 자동으로 따라간다.
  let rafLoop: number | null = null;
  const tick = () => {
    reposition();
    rafLoop = requestAnimationFrame(tick);
  };
  rafLoop = requestAnimationFrame(tick);

  const onDocClick = (e: MouseEvent) => {
    if (popoverAutoCloseSuppressed) return;
    if (!popover.contains(e.target as Node)) closePopover();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopover();
  };
  // 현재 click을 잡지 않도록 다음 tick에 등록
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }, 0);
  openPopoverCleanup = () => {
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    if (rafLoop !== null) cancelAnimationFrame(rafLoop);
    rafLoop = null;
  };
}

function closePopover() {
  if (!openPopover) return;
  const popover = openPopover;
  openPopoverCleanup?.();
  openPopoverCleanup = null;
  openPopover = null;
  openPopoverMount = null;
  inflightDevice = null;
  openPopoverFlipHeight = 0;
  // 종료 페이드 — `.dvads-popover-exit` 클래스가 opacity 1→0 keyframe 트리거.
  // pointer-events: none으로 빠른 재오픈 시 그림자가 클릭 잡지 않게.
  popover.classList.add("dvads-popover-exit");
  window.setTimeout(() => popover.remove(), 140);
}

/**
 * fade-out 없이 popover 즉시 제거. 다른 키워드 배지로 전환할 때 사용 —
 * 새 popover의 entrance가 시각 연결을 받아주므로 fade-out이 오히려 두 popover
 * 겹침 race의 원인이 됨.
 */
function closePopoverImmediate(): void {
  if (!openPopover) return;
  const popover = openPopover;
  openPopoverCleanup?.();
  openPopoverCleanup = null;
  openPopover = null;
  openPopoverMount = null;
  inflightDevice = null;
  openPopoverFlipHeight = 0;
  popover.remove();
}

/**
 * popover 내부 컨텐츠 교체 시 crossfade + height morph.
 *
 * 핵심: 빠른 토글이나 lazy fetch 응답 도착 시 popover에 wrap이 누적될 수 있어
 *   (1) 매 호출마다 popover의 *모든* 기존 children을 swap-out 처리
 *   (2) 토큰 기반 cleanup으로 가장 최신 호출만 popover style/children 정리
 * 가 필수. 안 하면 두 wrap이 popover 안에 동시에 정상 flow로 자리잡아 길이가
 * 부풀어 사용자에겐 "popover 두 개"처럼 보임.
 */
let bodyAnimToken = 0;
function animatePopoverBody(newBody: HTMLElement): void {
  if (!openPopover) return;
  const popover = openPopover;
  const myToken = ++bodyAnimToken;

  // 처음 mount (자식 없음) — 그냥 append
  if (popover.children.length === 0) {
    popover.appendChild(newBody);
    return;
  }

  const oldH = popover.offsetHeight;
  // 기존 모든 wrap을 swap-out 처리 — 누적된 children이 있어도 한꺼번에 fade-out + absolute로
  // flow에서 빠지게 해 새 wrap이 popover 높이를 결정.
  for (const el of Array.from(popover.children) as HTMLElement[]) {
    if (el !== newBody) el.classList.add("dvads-popover-content-swap-out");
  }
  newBody.classList.add("dvads-popover-content-swap-in");
  popover.appendChild(newBody);
  const newH = popover.offsetHeight;

  if (Math.abs(oldH - newH) > 1) {
    popover.style.height = `${oldH}px`;
    void popover.offsetHeight;
    popover.style.transition = "height 200ms cubic-bezier(0.4, 0, 0.2, 1)";
    popover.style.height = `${newH}px`;
  }

  window.setTimeout(() => {
    // 더 새로운 animatePopoverBody 호출이 있었으면 그쪽 cleanup에 양보 — 현재 cleanup이
    // 진행 중인 새 transition을 끊거나 다른 wrap을 잘못 제거하지 않게.
    if (myToken !== bodyAnimToken) return;
    if (openPopover !== popover) return;
    // newBody 외 popover 내 모든 children 제거 (누적된 fading wrap들 정리)
    for (const el of Array.from(popover.children) as HTMLElement[]) {
      if (el !== newBody) el.remove();
    }
    newBody.classList.remove("dvads-popover-content-swap-in");
    popover.style.height = "";
    popover.style.transition = "";
  }, 240);
}

/**
 * popover 디바이스 토글 — 사용자가 [모바일 | PC] segmented control에서 클릭.
 *
 * - cache hit이면 즉시 body re-render.
 * - cache miss(첫 PC 토글 등)면 loading skeleton + GET_BID_ESTIMATE 호출.
 *   응답 도착 시 currentDevice가 그대로면 re-render, 다른 디바이스로 다시 바뀐
 *   상태면 캐시만 저장하고 화면은 건드리지 않음 (race guard).
 */
function selectDevice(target: AdDevice): void {
  if (!openPopover || !openPopoverMount) return;
  if (openPopoverDevice === target) return;
  // 토글 클릭이 popover 닫힘 트리거가 되지 않도록 가드
  suppressPopoverClose(500);
  openPopoverDevice = target;

  const mount = openPopoverMount;
  const cached = dataCache.get(dataKey(mount.keyword, target));
  if (cached) {
    animatePopoverBody(buildPopoverBody(mount,target));
    return;
  }

  // cache miss — loading skeleton + lazy fetch
  inflightDevice = target;
  animatePopoverBody(buildPopoverBody(mount,target));

  const req: GetBidEstimateRequest = {
    type: "GET_BID_ESTIMATE",
    keywords: [{ keyword: mount.keyword, currentBid: mount.currentBid }],
    device: target,
  };
  chrome.runtime
    .sendMessage(req)
    .then((res: GetBidEstimateResponse | undefined) => {
      if (!res) return;
      if (res.has_credential === false) {
        credentialState = "missing";
        return;
      }
      if (!res.ok) {
        console.warn("[dv-ads] lazy device fetch error:", res.error);
        if (inflightDevice === target) inflightDevice = null;
        return;
      }
      const respDevice = res.device ?? target;
      for (const d of res.data ?? []) {
        dataCache.set(dataKey(d.keyword, respDevice), d);
      }
      for (const p of res.performance ?? []) {
        perfCache.set(perfKey(p.keyword, p.bid, respDevice), p);
      }
      // inflightDevice는 re-render 전에 풀어야 함 — buildPopoverBody가 토글의
      // `.is-loading` 클래스 부착 여부를 inflightDevice로 판단하기 때문.
      if (inflightDevice === respDevice) inflightDevice = null;
      // 응답 도착 시 popover가 그대로 같은 mount + 같은 device 상태일 때만 re-render
      if (
        openPopover &&
        openPopoverMount === mount &&
        openPopoverDevice === respDevice
      ) {
        animatePopoverBody(buildPopoverBody(mount,respDevice));
      }
    })
    .catch((e) => {
      console.warn("[dv-ads] lazy device fetch failed", e);
      if (inflightDevice === target) inflightDevice = null;
    });
}

const DEVICE_LABEL: Record<AdDevice, string> = {
  MOBILE: "모바일",
  PC: "PC",
};

// 키워드명 클릭 → 네이버 광고 검색결과 새 탭. device에 따라 분기.
// PC : `ad.search.naver.com` 파워링크 전용 미리보기 페이지
// MOBILE: `m.ad.search.naver.com` 모바일 파워링크 전용 미리보기 페이지
const SEARCH_URL_BY_DEVICE: Record<AdDevice, string> = {
  PC: "https://ad.search.naver.com/search.naver?where=ad&query=",
  MOBILE: "https://m.ad.search.naver.com/search.naver?where=m_expd&query=",
};

function buildPopoverBody(mount: BadgeMount, device: AdDevice): HTMLElement {
  const wrap = document.createElement("div");

  const data = dataCache.get(dataKey(mount.keyword, device));

  const hdr = document.createElement("div");
  hdr.className = "dvads-popover-hdr";

  // 키워드명 클릭 → 네이버 광고 검색결과(파워링크 미리보기) 새 탭으로 열기.
  // device 토글에 따라 PC/모바일 미리보기로 분기 — toggle 클릭 시 selectDevice가
  // buildPopoverBody를 다시 호출하므로 anchor href도 같이 갱신된다.
  const kw = document.createElement("a");
  kw.className = "kw";
  kw.textContent = mount.keyword;
  kw.href = `${SEARCH_URL_BY_DEVICE[device]}${encodeURIComponent(mount.keyword)}`;
  kw.target = "_blank";
  kw.rel = "noopener noreferrer";
  kw.title =
    device === "MOBILE"
      ? "모바일 광고 검색결과로 이동"
      : "PC 광고 검색결과로 이동";
  hdr.append(kw);

  // 디바이스 토글 (PC | 모바일) — segmented control. 헤더 우측(이전 X 버튼 자리)에 배치.
  // popover 닫기는 외부 클릭 / ESC / 배지 재클릭으로 가능하므로 X 버튼은 두지 않음.
  // DV 주황 안 씀(보조 UI) — 트랙 회색 + 흰 카드 선택.
  const toggle = document.createElement("div");
  toggle.className = "dvads-device-toggle";
  toggle.setAttribute("role", "tablist");
  toggle.setAttribute("aria-label", "디바이스 선택");
  for (const d of ["PC", "MOBILE"] as AdDevice[]) {
    const seg = document.createElement("button");
    seg.type = "button";
    seg.className = "dvads-device-seg";
    seg.dataset.device = d;
    seg.textContent = DEVICE_LABEL[d];
    seg.setAttribute("role", "tab");
    seg.setAttribute("aria-selected", d === device ? "true" : "false");
    if (d === device) seg.classList.add("is-active");
    if (inflightDevice === d) seg.classList.add("is-loading");
    seg.addEventListener("click", (e) => {
      e.stopPropagation();
      selectDevice(d);
    });
    toggle.appendChild(seg);
  }
  hdr.append(toggle);

  wrap.appendChild(hdr);

  // body — cache hit이면 ladder, miss면 loading skeleton
  if (!data) {
    const loading = document.createElement("div");
    loading.className = "dvads-popover-loading";
    loading.textContent = `${DEVICE_LABEL[device]} 데이터 가져오는 중...`;
    wrap.appendChild(loading);
    return wrap;
  }

  const currentRank: EstimatedRank | null =
    mount.currentBid != null
      ? estimateRank(mount.currentBid, data.rank_to_bid)
      : null;

  // 통합 테이블: 순위 | 입찰가 | 예상 노출수 | 예상 클릭수 | 예상 광고비 × 10행
  const table = document.createElement("table");
  table.className = "dvads-bid-table";
  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  for (const label of ["순위", "입찰가", "예상 노출수", "예상 클릭수", "예상 광고비"]) {
    trHead.appendChild(createCell("th", label));
  }
  thead.appendChild(trHead);
  table.appendChild(thead);

  // device별 순위 상한 — PC 10 / MOBILE 5. 토글에 따라 표 행 수가 달라지지만 popover
   // 위치는 안정 — togglePopover가 PC 최대 높이를 한 번 측정해 flip 결정을 freeze하기 때문.
  const maxRows = MAX_POSITION_BY_DEVICE[device];
  const tbody = document.createElement("tbody");
  for (let i = 1; i <= maxRows; i++) {
    const tr = document.createElement("tr");
    if (currentRank === i) tr.classList.add("current");
    tr.appendChild(createCell("td", `${i}위`));
    const bid = data.rank_to_bid[i as RankPosition];
    tr.appendChild(createCell("td", bid != null ? bid.toLocaleString() : "—"));

    const perf =
      bid != null ? perfCache.get(perfKey(mount.keyword, bid, device)) : undefined;
    tr.appendChild(createCell("td", perf ? perf.impressions.toLocaleString() : "—"));
    tr.appendChild(createCell("td", perf ? perf.clicks.toLocaleString() : "—"));
    tr.appendChild(
      createCell("td", perf ? `${Math.round(perf.salesAmt).toLocaleString()}원` : "—"),
    );

    // 행 클릭 → 입찰가 변경. 현재 행과 입찰가 없는 행은 비활성.
    // 입찰가 적용 자체는 device-agnostic — 페이지의 현재 입찰가 셀을 그대로 클릭.
    if (bid != null && currentRank !== i) {
      tr.classList.add("dvads-clickable");
      tr.addEventListener("click", () => {
        requestBidChange(mount, bid);
      });
    }

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  // 면책 푸터
  const footer = document.createElement("div");
  footer.className = "dvads-disclaimer";
  footer.textContent =
    "모든 예상 실적은 과거 데이터를 기반으로 예측한 값입니다. (30일 기준 데이터)";
  wrap.appendChild(footer);

  return wrap;
}

// ─── 입찰가 변경 흐름 (다이얼로그 → applyBidToRow → 토스트 + Undo) ───

// mount 단위 락 — relocate로 bidCell이 바뀌어도 같은 키워드 mount에 대한 중복 호출은
// 모두 한 락으로 차단된다. cell 단위 락은 relocate 후 새 cell이 락을 회피할 수 있어 위험.
const inflightMounts = new WeakSet<BadgeMount>();

function requestBidChange(mount: BadgeMount, targetBid: number): void {
  if (!mount.bidCell) {
    showToast({
      message: "입찰가 셀을 찾지 못했습니다",
      variant: "error",
    });
    return;
  }
  const bidCell = mount.bidCell;
  if (inflightMounts.has(mount)) {
    // 이미 적용/되돌리기 진행 중인 키워드는 중복 클릭 무시
    return;
  }

  openConfirmDialog({
    keyword: mount.keyword,
    currentBid: mount.currentBid,
    targetBid,
    onConfirm: async () => {
      // 다이얼로그가 onConfirm 동안 buttons disabled — 결과는 토스트로 표시.
      // 팝오버는 닫지 않고 그대로 유지 — 변경된 입찰가에 맞춰 현재 행 강조만 갱신.
      await performBidApply(mount, bidCell, targetBid);
    },
  });
}

function refreshOpenPopover(mount: BadgeMount): void {
  if (!openPopover) return;
  // popover에 표시 중인 mount가 아니면 무관 (다른 키워드 popover면 건드리지 않음)
  if (openPopoverMount && openPopoverMount !== mount) return;
  animatePopoverBody(buildPopoverBody(mount,openPopoverDevice));
}

async function performBidApply(
  mount: BadgeMount,
  bidCell: HTMLElement,
  targetBid: number,
): Promise<void> {
  inflightMounts.add(mount);
  suppressPopoverClose(2500);
  try {
    // 셀이 가상화로 떨어졌으면 키워드 텍스트로 재탐색
    let liveCell: HTMLElement | null = bidCell;
    if (!liveCell.isConnected) {
      liveCell = relocateBidCell(mount.keyword);
    }
    if (!liveCell) {
      showToast({
        message: `'${mount.keyword}' 키워드 행을 찾지 못했습니다`,
        variant: "error",
      });
      return;
    }

    const result = await applyBidToRow({ bidCell: liveCell, targetBid });
    if (!result.ok) {
      showToast({
        message: `${mount.keyword}: ${describeFailure(result.reason)}`,
        variant: "error",
        keyword: mount.keyword,
      });
      return;
    }

    // 변경 성공 — mount의 입찰가/셀 reference 갱신 + 팝오버 강조 행 이동
    mount.currentBid = targetBid;
    mount.bidCell = liveCell;
    renderBadge(mount);
    refreshOpenPopover(mount);

    const prev = result.previousBid;
    showToast({
      message: `${mount.keyword} 입찰가를 ${targetBid.toLocaleString()}원으로 변경했습니다`,
      variant: "success",
      keyword: mount.keyword,
      undo:
        prev != null && prev !== targetBid
          ? {
              label: "되돌리기",
              ttlMs: 5000,
              onClick: () => {
                void undoBidApply(mount, prev);
              },
            }
          : undefined,
    });
  } finally {
    inflightMounts.delete(mount);
    // suppress 해제는 suppressPopoverClose 헬퍼의 토큰 만료 타이머가 담당.
    // 여기서 직접 false 세팅하지 않음 — 후속 Undo 호출이 토큰을 갱신할 수 있게.
  }
}

async function undoBidApply(mount: BadgeMount, previousBid: number): Promise<void> {
  if (inflightMounts.has(mount)) {
    // 변경 적용이 아직 끝나지 않은 mount는 되돌리기 차단
    return;
  }
  inflightMounts.add(mount);
  suppressPopoverClose(2500);
  try {
    // Undo는 최신 셀 reference로 — 변경 직후 mount.bidCell이 같은 td 그대로일 수 있고,
    // 가상화로 새로 mount된 행이면 키워드 텍스트로 재탐색.
    let cell: HTMLElement | null = mount.bidCell;
    if (!cell || !cell.isConnected) {
      cell = relocateBidCell(mount.keyword);
    }
    if (!cell) {
      showToast({
        message: `'${mount.keyword}' 되돌리기 대상 행을 찾지 못했습니다`,
        variant: "error",
      });
      return;
    }
    const result = await applyBidToRow({ bidCell: cell, targetBid: previousBid });
    if (!result.ok) {
      showToast({
        message: `되돌리기 실패: ${describeFailure(result.reason)}`,
        variant: "error",
      });
      return;
    }
    // Undo 성공 — mount 갱신 + 팝오버 강조 행 복원
    mount.currentBid = previousBid;
    mount.bidCell = cell;
    renderBadge(mount);
    refreshOpenPopover(mount);

    showToast({
      message: `${mount.keyword} 입찰가를 ${previousBid.toLocaleString()}원으로 되돌렸습니다`,
      variant: "success",
      keyword: mount.keyword,
    });
  } finally {
    inflightMounts.delete(mount);
    // suppress 해제는 토큰 타이머가 담당
  }
}

function relocateBidCell(keyword: string): HTMLElement | null {
  for (const m of mounts.values()) {
    if (m.keyword === keyword && m.bidCell && m.bidCell.isConnected) {
      return m.bidCell;
    }
  }
  // mounts에 없으면 페이지에서 키워드 텍스트로 직접 탐색
  const cells = document.querySelectorAll<HTMLElement>(KEYWORD_CELL_SELECTOR);
  for (const cell of Array.from(cells)) {
    const span = cell.querySelector<HTMLElement>(KEYWORD_SPAN_SELECTOR);
    if ((span?.textContent ?? "").trim() === keyword) {
      return findBidCellAndValue(cell)?.cell ?? null;
    }
  }
  return null;
}

function createCell(tag: "th" | "td", text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

// ─── 페이지 확정 모달 등장/소멸 감지 ───
// 입찰가 변경 후 페이지가 띄우는 "입찰가가 변경되었습니다" 모달이 떠 있는 동안
// 우리 팝오버/토스트를 visibility hidden으로 임시 hide. 사용자가 페이지 모달의
// 닫기 버튼에 직접 접근할 수 있도록 길을 비워주는 게 목적.
// autoDismissConfirmModal은 그대로 두되, 자동 닫기가 실패해도 사용자가 직접 닫고
// 그 시점에 우리 UI가 자연스럽게 복원되도록 한다.

const PAGE_MODAL_TEXT = "입찰가가 변경되었습니다";
let pageModalShown = false;

function isPageConfirmModalShown(): boolean {
  // ads.naver.com 모달이 [role="dialog"]를 안 쓸 수도 있어 textContent 기반으로 검출.
  // 평소 페이지에 "입찰가가 변경되었습니다"라는 문구가 노출되지 않는다는 가정.
  // 페이지 전체 textContent는 비싸므로 호출 자체는 rAF로 throttle.
  return (document.body.textContent ?? "").includes(PAGE_MODAL_TEXT);
}

function setOurUiRecede(recede: boolean): void {
  if (openPopover) openPopover.classList.toggle("dvads-recede", recede);
  // 토스트는 hide 대상에서 제외 — 변경 직후 "되돌리기" 버튼이 페이지 모달 뒤에
  // 묻히면 사용자가 페이지 모달을 먼저 닫아야 Undo를 누를 수 있어 UX가 끊긴다.
  // z-index 2147483647이라 자연스럽게 페이지 모달 위에 떠있다.
  // 다이얼로그가 잠깐 떠있는 경우(자동 모달이 다이얼로그 종료 전 등장 시)는 hide.
  const backdrop = document.querySelector<HTMLElement>(".dvads-confirm-backdrop");
  if (backdrop) backdrop.classList.toggle("dvads-recede", recede);
}

let modalCheckRaf: number | null = null;
function scheduleModalCheck(): void {
  if (modalCheckRaf !== null) return;
  modalCheckRaf = requestAnimationFrame(() => {
    modalCheckRaf = null;
    const shown = isPageConfirmModalShown();
    if (shown && !pageModalShown) {
      pageModalShown = true;
      setOurUiRecede(true);
      // 모달 떠있는 동안 우리 onDocClick도 발화하지 않게
      popoverAutoCloseSuppressed = true;
    } else if (!shown && pageModalShown) {
      pageModalShown = false;
      setOurUiRecede(false);
      // 페이지 모달 닫기 클릭의 잔여 이벤트가 우리 onDocClick에 도달하지 않게 잠깐 더 대기
      suppressPopoverClose(300);
    }
  });
}

function watchPageConfirmModal(): void {
  // 단일 옵저버를 모듈 lifetime 동안 유지 — disconnect 안 함.
  new MutationObserver(scheduleModalCheck).observe(document.body, {
    childList: true,
    subtree: true,
  });
}
watchPageConfirmModal();

// ─── batched data fetch ───

let pollTimer: number | null = null;
function schedulePoll() {
  if (pollTimer !== null) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = null;
    void poll();
  }, POLL_DEBOUNCE_MS);
}

async function poll() {
  // 키워드별로 가장 최근 mount의 currentBid를 채택 (동일 키워드가 여러 셀에 mount될 수 있음)
  const byKeyword = new Map<string, number | null>();
  for (const m of mounts.values()) {
    // 한 번이라도 currentBid가 있으면 그 값 우선 채택
    const existing = byKeyword.get(m.keyword);
    if (existing == null && m.currentBid != null) {
      byKeyword.set(m.keyword, m.currentBid);
    } else if (!byKeyword.has(m.keyword)) {
      byKeyword.set(m.keyword, m.currentBid);
    }
  }

  // bid 추정이 아직 없는 키워드 + 성과 추정이 아직 없는 (keyword, bid) 조합.
  // poll은 항상 DEFAULT_DEVICE(모바일) 기준 — PC는 popover 토글 시 lazy 호출.
  const missingBids = Array.from(byKeyword.entries()).filter(
    ([k]) => !dataCache.has(dataKey(k, DEFAULT_DEVICE)),
  );
  const missingPerf = Array.from(byKeyword.entries()).filter(
    ([k, bid]) => bid != null && !perfCache.has(perfKey(k, bid, DEFAULT_DEVICE)),
  );

  // 둘 다 없으면 요청 skip — 단순 재렌더만
  if (missingBids.length === 0 && missingPerf.length === 0) {
    for (const m of mounts.values()) renderBadge(m);
    return;
  }

  // 요청 union — bid 추정은 모든 미스 키워드, 성과는 (k, bid)가 필요한 키워드
  const requestKeywords = new Set<string>();
  for (const [k] of missingBids) requestKeywords.add(k);
  for (const [k] of missingPerf) requestKeywords.add(k);
  const reqList = Array.from(requestKeywords).map((k) => ({
    keyword: k,
    currentBid: byKeyword.get(k) ?? null,
  }));

  const req: GetBidEstimateRequest = {
    type: "GET_BID_ESTIMATE",
    keywords: reqList,
    device: DEFAULT_DEVICE,
  };
  let res: GetBidEstimateResponse | undefined;
  try {
    res = (await chrome.runtime.sendMessage(req)) as GetBidEstimateResponse;
  } catch (e) {
    console.warn("[dv-ads] sendMessage failed", e);
    lastError = "확장 프로그램이 업데이트됐어요. 페이지를 새로고침해 주세요";
  }
  if (res === undefined && !lastError) {
    // background가 sendResponse를 호출하지 않은 채 포트가 닫힌 경우 (MV3 SW 비정상 종료 등)
    console.warn("[dv-ads] GET_BID_ESTIMATE returned undefined — background may have crashed");
    lastError = "잠시 응답이 없어요. 페이지를 새로고침해 주세요";
  } else if (res) {
    if (res.has_credential === false) {
      credentialState = "missing";
      lastError = null;
    } else if (res.ok) {
      credentialState = "ok";
      const respDevice = res.device ?? DEFAULT_DEVICE;
      for (const d of res.data ?? []) dataCache.set(dataKey(d.keyword, respDevice), d);
      for (const p of res.performance ?? [])
        perfCache.set(perfKey(p.keyword, p.bid, respDevice), p);
      // silent-empty 감지: bid 추정을 요청했는데 0개 받으면 schema mismatch
      if (missingBids.length > 0) {
        const stillMissing = missingBids.filter(
          ([k]) => !dataCache.has(dataKey(k, respDevice)),
        );
        if (stillMissing.length === missingBids.length) {
          console.warn(
            "[dv-ads] requested",
            missingBids.length,
            "but got 0 in data — possible schema mismatch or empty estimate. SW 콘솔의 raw 로그 확인 필요",
          );
          lastError = "데이터를 받지 못했어요. 잠시 후 다시 시도해 주세요";
        } else {
          lastError = null;
        }
      } else {
        lastError = null;
      }
    } else {
      console.warn("[dv-ads] GET_BID_ESTIMATE error:", res.error);
      lastError = res.error ?? "조회 실패";
    }
  }

  for (const m of mounts.values()) renderBadge(m);
}

// ─── F012 — 팝업 새로고침 트리거 ───
// 화면에 mount된 키워드의 storage + in-memory 캐시만 무효화. 전체 캐시는 건드리지 않음
// (ROADMAP §"전체 캐시 클리어 X"). 응답 후 즉시 poll로 재조회.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "REFRESH_ACTIVE_TAB") {
    handleRefreshActiveTab()
      .then(sendResponse)
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        console.warn("[dv-ads] REFRESH_ACTIVE_TAB failed", e);
        sendResponse({ ok: false, error: raw });
      });
    return true; // 비동기 응답
  }
  return false;
});

async function handleRefreshActiveTab(): Promise<RefreshActiveTabResponse> {
  // 현재 mount된 키워드들 — 같은 키워드가 여러 셀에 mount될 수 있으므로 dedupe
  const keywords = Array.from(
    new Set(Array.from(mounts.values()).map((m) => m.keyword)),
  );
  if (keywords.length === 0) {
    return { ok: true, count: 0 };
  }

  // storage 캐시 무효화 (volume + performance)
  await Promise.all([invalidateBids(keywords), invalidatePerformance(keywords)]);

  // in-memory 캐시도 비워야 poll이 miss로 판단해 재요청.
  // dataCache 키 = `<device>:<keyword>`, perfCache 키 = `<device>:<keyword>:<bid>`.
  // 키워드 매칭 시 모든 device 변형 일괄 삭제.
  const targetKeywords = new Set(keywords);
  for (const key of Array.from(dataCache.keys())) {
    const firstColon = key.indexOf(":");
    if (firstColon < 0) continue;
    const kw = key.slice(firstColon + 1);
    if (targetKeywords.has(kw)) dataCache.delete(key);
  }
  for (const key of Array.from(perfCache.keys())) {
    const firstColon = key.indexOf(":");
    const lastColon = key.lastIndexOf(":");
    if (firstColon < 0 || lastColon <= firstColon) continue;
    const kw = key.slice(firstColon + 1, lastColon);
    if (targetKeywords.has(kw)) perfCache.delete(key);
  }

  // 이전 에러 표시 초기화 — 재조회로 회복 가능
  lastError = null;

  // 배지를 즉시 loading 상태로 — 사용자가 변화를 본다
  for (const m of mounts.values()) renderBadge(m);

  // pending debounce가 있으면 취소하고 즉시 poll
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  await poll();

  return { ok: true, count: keywords.length };
}

// ─── teardown ───

function teardown() {
  for (const m of mounts.values()) m.badge.remove();
  mounts.clear();
  closePopover();
}

// ─── observe DOM + URL changes ───

let scanRaf: number | null = null;
function schedule() {
  if (scanRaf !== null) return;
  scanRaf = requestAnimationFrame(() => {
    scanRaf = null;
    scan();
  });
}

const observer = new MutationObserver(schedule);
observer.observe(document.body, { childList: true, subtree: true });

let lastUrl = location.href;
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    // SPA navigation — 캐시는 유지, 배지만 새 페이지에서 재mount
    teardown();
    schedule();
  }
}).observe(document, { childList: true, subtree: true });

schedule();
