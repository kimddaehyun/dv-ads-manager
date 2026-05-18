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
} from "@/types/messages";
import {
  MAX_POSITION,
  type KeywordPerformanceCache,
  type KeywordVolumeCache,
  type RankPosition,
} from "@/types/storage";
import { estimateRank, type EstimatedRank } from "@/lib/rank";
import { applyBidToRow, describeFailure } from "@/content/dom-bid";
import { openConfirmDialog } from "@/content/confirm-dialog";
import { showToast } from "@/content/toast";

declare const __APP_VERSION__: string;
console.log(`[dv-ads] content script loaded · v${__APP_VERSION__}`);

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
const dataCache = new Map<string, KeywordVolumeCache>();
// 키 = `<keyword>:<bid>` — 같은 키워드라도 bid 다르면 별도 엔트리
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

const perfKey = (keyword: string, bid: number): string => `${keyword}:${bid}`;

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

  if (credentialState === "missing") {
    m.badge.classList.add("warn");
    m.badge.textContent = "API 키 미등록";
    m.badge.onclick = (e) => {
      e.stopPropagation();
      void chrome.runtime.sendMessage({ type: "OPEN_OPTIONS" });
    };
    return;
  }

  const data = dataCache.get(m.keyword);
  if (!data) {
    if (lastError) {
      m.badge.classList.add("warn");
      m.badge.textContent = lastError;
      m.badge.title = "콘솔 로그(서비스 워커)를 확인해 주세요";
      m.badge.onclick = null;
    } else {
      // 로딩 상태는 스피너만 — 텍스트 없음 (CSS ::before가 스피너 렌더)
      m.badge.classList.add("loading");
      m.badge.textContent = "";
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
    label = "순위권 밖";
    m.badge.classList.add("warn");
  } else {
    label = `${rank}위`;
  }
  m.badge.textContent = label;
  m.badge.onclick = (e) => {
    e.stopPropagation();
    togglePopover(m.badge, data, m, rank);
  };
}

// ─── popover ───

function togglePopover(
  anchor: HTMLElement,
  data: KeywordVolumeCache,
  mount: BadgeMount,
  currentRank: EstimatedRank | null,
) {
  if (openPopover) {
    closePopover();
    return;
  }
  const popover = document.createElement("div");
  popover.className = "dvads dvads-popover";
  popover.style.position = "fixed";
  popover.style.zIndex = "2147483647";
  popover.appendChild(buildBidTable(data, mount, currentRank));
  document.body.appendChild(popover);

  openPopover = popover;

  // 배지 위치 기준으로 popover 재배치. 매 프레임 rAF 루프로 호출되어 픽셀 단위로 따라붙는다.
  const reposition = () => {
    if (!anchor.isConnected) {
      closePopover();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    // 배지가 가상화로 화면에서 사라졌으면 닫기
    if (rect.width === 0 && rect.height === 0) {
      closePopover();
      return;
    }
    const pr = popover.getBoundingClientRect();
    // 좌우: 우측 viewport 밖이면 좌측으로 끌어옴
    let left = Math.max(8, rect.left);
    if (left + pr.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pr.width - 8);
    }
    // 상하: 기본은 배지 아래(rect.bottom + 4). 하단 공간 부족 시 배지 위로 flip.
    // 위도 안 맞는 극단적 viewport는 viewport 하단에 clamp (절대 잘리지 않게).
    let top = rect.bottom + 4;
    if (top + pr.height > window.innerHeight - 8) {
      const above = rect.top - pr.height - 4;
      if (above >= 8) {
        top = above;
      } else {
        top = Math.max(8, window.innerHeight - pr.height - 8);
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
  openPopoverCleanup?.();
  openPopoverCleanup = null;
  openPopover.remove();
  openPopover = null;
}

function buildBidTable(
  data: KeywordVolumeCache,
  mount: BadgeMount,
  currentRank: EstimatedRank | null,
): HTMLElement {
  const wrap = document.createElement("div");

  const hdr = document.createElement("div");
  hdr.className = "dvads-popover-hdr";
  // 키워드명 클릭 → 네이버 광고 검색결과(파워링크 미리보기) 새 탭으로 열기
  const kw = document.createElement("a");
  kw.className = "kw";
  kw.textContent = data.keyword;
  kw.href = `https://ad.search.naver.com/search.naver?where=ad&query=${encodeURIComponent(data.keyword)}`;
  kw.target = "_blank";
  kw.rel = "noopener noreferrer";
  kw.title = "네이버 광고 검색결과로 이동";
  hdr.append(kw);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dvads-popover-close";
  closeBtn.setAttribute("aria-label", "닫기");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closePopover();
  });
  hdr.append(closeBtn);

  wrap.appendChild(hdr);

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

  const tbody = document.createElement("tbody");
  for (let i = 1; i <= MAX_POSITION; i++) {
    const tr = document.createElement("tr");
    if (currentRank === i) tr.classList.add("current");
    tr.appendChild(createCell("td", `${i}위`));
    const bid = data.rank_to_bid[i as RankPosition];
    tr.appendChild(createCell("td", bid != null ? bid.toLocaleString() : "—"));

    const perf = bid != null ? perfCache.get(perfKey(mount.keyword, bid)) : undefined;
    tr.appendChild(createCell("td", perf ? perf.impressions.toLocaleString() : "—"));
    tr.appendChild(createCell("td", perf ? perf.clicks.toLocaleString() : "—"));
    tr.appendChild(
      createCell("td", perf ? `${Math.round(perf.salesAmt).toLocaleString()}원` : "—"),
    );

    // 행 클릭 → 입찰가 변경. 현재 행과 입찰가 없는 행은 비활성.
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
  const data = dataCache.get(mount.keyword);
  if (!data) return;
  const newRank: EstimatedRank | null =
    mount.currentBid != null ? estimateRank(mount.currentBid, data.rank_to_bid) : null;
  openPopover.replaceChildren(buildBidTable(data, mount, newRank));
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

  // bid 추정이 아직 없는 키워드 + 성과 추정이 아직 없는 (keyword, bid) 조합
  const missingBids = Array.from(byKeyword.entries()).filter(
    ([k]) => !dataCache.has(k),
  );
  const missingPerf = Array.from(byKeyword.entries()).filter(
    ([k, bid]) => bid != null && !perfCache.has(perfKey(k, bid)),
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
  };
  let res: GetBidEstimateResponse | undefined;
  try {
    res = (await chrome.runtime.sendMessage(req)) as GetBidEstimateResponse;
  } catch (e) {
    console.warn("[dv-ads] sendMessage failed", e);
    lastError = "확장 응답 없음 (reload 후 페이지 새로고침 필요)";
  }
  if (res === undefined && !lastError) {
    // background가 sendResponse를 호출하지 않은 채 포트가 닫힌 경우 (MV3 SW 비정상 종료 등)
    console.warn("[dv-ads] GET_BID_ESTIMATE returned undefined — background may have crashed");
    lastError = "백그라운드 응답 없음";
  } else if (res) {
    if (res.has_credential === false) {
      credentialState = "missing";
      lastError = null;
    } else if (res.ok) {
      credentialState = "ok";
      for (const d of res.data ?? []) dataCache.set(d.keyword, d);
      for (const p of res.performance ?? []) perfCache.set(perfKey(p.keyword, p.bid), p);
      // silent-empty 감지: bid 추정을 요청했는데 0개 받으면 schema mismatch
      if (missingBids.length > 0) {
        const stillMissing = missingBids.filter(([k]) => !dataCache.has(k));
        if (stillMissing.length === missingBids.length) {
          console.warn(
            "[dv-ads] requested",
            missingBids.length,
            "but got 0 in data — possible schema mismatch or empty estimate. SW 콘솔의 raw 로그 확인 필요",
          );
          lastError = "응답없음";
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
