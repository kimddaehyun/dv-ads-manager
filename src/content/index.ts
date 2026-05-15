/**
 * F001 — 파워링크 키워드 오버레이.
 *
 * 활성 경로: `ads.naver.com/manage/ad-accounts/*\/sa/adgroups/*` (검색광고 그룹의 키워드 탭)
 *
 * 동작:
 *   1. `td.ad-cms-table-cell-fix-start` 안의 `span.keyword` 노드를 모두 찾음
 *   2. 각 셀의 `span.label-wrap` 안에 배지 mount (없으면 keyword span 옆)
 *   3. 배지 상태:
 *      - loading       — 분석 중 스피너
 *      - ok            — "1~10위 ▾" 클릭 시 floating popover (가상화 테이블이라 row 삽입 X)
 *      - warn (no-cred) — "API 키 미등록" 클릭 시 옵션 페이지
 *   4. MutationObserver로 가상화 행 추가·삭제·스크롤 시 자동 재마운트
 *   5. 키워드 텍스트 → 250ms debounced batched `GET_BID_ESTIMATE`
 *
 * TODO (Spike C 후속):
 *   - 응답 schema 보정: service worker 콘솔의 "Spike C 1회 보정용" raw log 확인
 *   - 현재 입찰가 컬럼 셀렉터 확보 시 — 추정 순위 계산 + 배지 "현재 N위 ▾" 표시
 */

import "@/styles/overlay.css";
import type {
  GetBidEstimateRequest,
  GetBidEstimateResponse,
} from "@/types/messages";
import { MAX_POSITION, type KeywordVolumeCache, type RankPosition } from "@/types/storage";

declare const __APP_VERSION__: string;
console.log(`[dv-ads] content script loaded · v${__APP_VERSION__}`);

const KEYWORD_CELL_SELECTOR = "td.ad-cms-table-cell-fix-start";
const KEYWORD_SPAN_SELECTOR = "span.keyword";
const LABEL_WRAP_SELECTOR = "span.label-wrap";
const KEYWORD_PAGE_PATTERN = /\/sa\/adgroups\//;
const POLL_DEBOUNCE_MS = 250;

interface BadgeMount {
  badge: HTMLElement;
  keyword: string;
  cell: HTMLElement;
}

const mounts = new Map<HTMLElement, BadgeMount>();
const dataCache = new Map<string, KeywordVolumeCache>();
let credentialState: "unknown" | "ok" | "missing" = "unknown";
let lastError: string | null = null;
let openPopover: HTMLElement | null = null;
let openPopoverCleanup: (() => void) | null = null;

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

  const existing = mounts.get(cell);
  if (existing) {
    if (existing.keyword === keyword && existing.badge.isConnected) {
      renderBadge(existing);
      return;
    }
    // 키워드 변경됐거나 배지가 떨어져 나감 — 재mount
    existing.badge.remove();
    mounts.delete(cell);
  }

  // 이미 같은 셀 안에 배지가 있다면(이전 mount 잔재) 제거
  cell.querySelectorAll(".dvads-rank-badge").forEach((el) => el.remove());

  const anchor =
    cell.querySelector<HTMLElement>(LABEL_WRAP_SELECTOR) ??
    keywordSpan.parentElement;
  if (!anchor) return;

  const badge = document.createElement("span");
  badge.classList.add("dvads", "dvads-rank-badge");
  badge.style.marginLeft = "6px";
  badge.style.verticalAlign = "middle";
  anchor.appendChild(badge);

  const mount: BadgeMount = { badge, keyword, cell };
  mounts.set(cell, mount);
  renderBadge(mount);
}

function renderBadge(m: BadgeMount) {
  m.badge.replaceChildren();
  m.badge.className = "dvads dvads-rank-badge";
  m.badge.style.marginLeft = "6px";
  m.badge.style.verticalAlign = "middle";

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
      m.badge.classList.add("loading");
      m.badge.textContent = "분석 중…";
      m.badge.onclick = null;
    }
    return;
  }

  // ok — "1~10위 ▾"
  m.badge.append(`1~${MAX_POSITION}위 `);
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.textContent = "▾";
  m.badge.appendChild(chev);
  m.badge.onclick = (e) => {
    e.stopPropagation();
    togglePopover(m.badge, data);
  };
}

// ─── popover ───

function togglePopover(anchor: HTMLElement, data: KeywordVolumeCache) {
  if (openPopover) {
    closePopover();
    return;
  }
  const rect = anchor.getBoundingClientRect();
  const popover = document.createElement("div");
  popover.className = "dvads dvads-popover";
  popover.style.position = "fixed";
  popover.style.zIndex = "2147483647";
  popover.style.top = `${rect.bottom + 4}px`;
  popover.style.left = `${Math.max(8, rect.left)}px`;
  popover.appendChild(buildBidTable(data));
  document.body.appendChild(popover);

  // 화면 우측 밖으로 넘어가면 좌측 정렬 보정
  requestAnimationFrame(() => {
    const pr = popover.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8) {
      popover.style.left = `${Math.max(8, window.innerWidth - pr.width - 8)}px`;
    }
  });

  openPopover = popover;

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
  };
}

function closePopover() {
  if (!openPopover) return;
  openPopoverCleanup?.();
  openPopoverCleanup = null;
  openPopover.remove();
  openPopover = null;
}

function buildBidTable(data: KeywordVolumeCache): HTMLElement {
  const wrap = document.createElement("div");

  const hdr = document.createElement("div");
  hdr.className = "dvads-popover-hdr";
  const kw = document.createElement("span");
  kw.className = "kw";
  kw.textContent = data.keyword;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `1~${MAX_POSITION}위 예상 입찰가 · 시장 단위 추정`;
  hdr.append(kw, meta);
  wrap.appendChild(hdr);

  const table = document.createElement("table");
  table.className = "dvads-bid-table";
  const thead = document.createElement("thead");
  const trHead = document.createElement("tr");
  trHead.appendChild(createCell("th", "순위"));
  for (let i = 1; i <= MAX_POSITION; i++) trHead.appendChild(createCell("th", String(i)));
  thead.appendChild(trHead);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const trBody = document.createElement("tr");
  trBody.appendChild(createCell("td", "예상가 (원)"));
  for (let i = 1; i <= MAX_POSITION; i++) {
    const bid = data.rank_to_bid[i as RankPosition];
    trBody.appendChild(createCell("td", bid != null ? bid.toLocaleString() : "—"));
  }
  tbody.appendChild(trBody);
  table.appendChild(tbody);
  wrap.appendChild(table);

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
  const want = Array.from(
    new Set(Array.from(mounts.values()).map((m) => m.keyword)),
  );
  const missing = want.filter((k) => !dataCache.has(k));

  if (missing.length > 0) {
    const req: GetBidEstimateRequest = {
      type: "GET_BID_ESTIMATE",
      keywords: missing,
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
        lastError = null;
        for (const d of res.data ?? []) dataCache.set(d.keyword, d);
      } else {
        console.warn("[dv-ads] GET_BID_ESTIMATE error:", res.error);
        lastError = res.error ?? "조회 실패";
      }
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
