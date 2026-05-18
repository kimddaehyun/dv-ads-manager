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

function findCurrentBid(cell: HTMLElement): number | null {
  const row = cell.closest("tr");
  if (!row) return null;
  // 같은 행의 모든 <td>를 훑어 첫 번째 "N원" 패턴 매치를 채택.
  // 키워드 셀 자신은 제외 (드물게 키워드명에 "원"이 포함될 수 있음).
  for (const td of row.querySelectorAll<HTMLElement>("td")) {
    if (td === cell) continue;
    const bid = parseBidText(td.textContent);
    if (bid != null) return bid;
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

  const currentBid = findCurrentBid(cell);

  const existing = mounts.get(cell);
  if (existing) {
    if (existing.keyword === keyword && existing.badge.isConnected) {
      // 입찰가가 바뀌었으면 mount의 currentBid도 갱신 (MutationObserver가 셀 변경 감지)
      existing.currentBid = currentBid;
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

  const mount: BadgeMount = { badge, keyword, cell, currentBid };
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
    togglePopover(m.badge, data, m.keyword, rank);
  };
}

// ─── popover ───

function togglePopover(
  anchor: HTMLElement,
  data: KeywordVolumeCache,
  keyword: string,
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
  popover.appendChild(buildBidTable(data, keyword, currentRank));
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
    const top = rect.bottom + 4;
    let left = Math.max(8, rect.left);
    // 우측 viewport 밖이면 좌측으로 끌어옴
    const pr = popover.getBoundingClientRect();
    if (left + pr.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pr.width - 8);
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
  keyword: string,
  currentRank: EstimatedRank | null,
): HTMLElement {
  const wrap = document.createElement("div");

  const hdr = document.createElement("div");
  hdr.className = "dvads-popover-hdr";
  const kw = document.createElement("span");
  kw.className = "kw";
  kw.textContent = data.keyword;
  hdr.append(kw);
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

    const perf = bid != null ? perfCache.get(perfKey(keyword, bid)) : undefined;
    tr.appendChild(createCell("td", perf ? perf.impressions.toLocaleString() : "—"));
    tr.appendChild(createCell("td", perf ? perf.clicks.toLocaleString() : "—"));
    tr.appendChild(
      createCell("td", perf ? `${Math.round(perf.salesAmt).toLocaleString()}원` : "—"),
    );
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

function createCell(tag: "th" | "td", text: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

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
