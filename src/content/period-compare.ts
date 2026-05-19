/**
 * F-PoP — 전후 비교 (Period-over-Period) 팝오버.
 *
 * 6개 매체 페이지(파워링크 / 쇼핑검색 / 플레이스 / 브랜드검색·신제품검색 /
 * 파워컨텐츠 / GFA 디스플레이)의 우측 상단 날짜 picker 좌측에 "전후 비교"
 * 버튼을 주입한다. 클릭 시 현재 선택된 기간과 동일 길이의 직전 기간을 비교해
 * 노출수·클릭수·CPC·총비용·매출·전환수 6개 집계 지표를 보여준다.
 *
 * 데이터 소스: 페이지가 이미 호출하는 stats fetch를 MAIN-world에서 가로채
 * 학습한 뒤(`fetch-patch-main.ts`), 같은 endpoint를 직전 기간 날짜로 1회 replay.
 * 매체별 endpoint 사전 정찰 불필요 — 페이지 자신이 가르쳐준다.
 *
 * 활성화 조건: location.pathname이 매체 패턴과 매치 + 페이지 헤더의 날짜 picker
 * 발견. SPA 라우팅·재렌더에서도 살아남도록 MutationObserver로 mount 유지.
 */

import type {
  PeriodCompareCapture,
  PeriodCompareMedia,
} from "@/lib/period-compare-adapters";
import {
  detectMedia,
  extractMetricsFromResponse,
  shiftDateParams,
} from "@/lib/period-compare-adapters";
import { friendlyApiError } from "@/lib/friendly-error";

// ─── 캡처 store ───
// 페이지의 stats fetch가 들어올 때마다 lastCapture에 가장 최근 1건을 보존.
// 매체별로 페이지 URL이 다르고 우리가 모든 매체의 pathname을 정확히 못 잡으므로,
// "현재 페이지에서 마지막으로 호출된 stats-like fetch" 한 건만 잡아 그대로 replay.
// SPA 라우팅으로 페이지 이동 시 lastCapture는 비워서 다른 매체 endpoint를 잘못 replay하지 않게 한다.
let lastCapture: PeriodCompareCapture | null = null;
const DEBUG_CAPTURE = true; // 첫 출시까지 켜두고, 안정화 후 false.

declare global {
  interface WindowEventMap {
    "dvads:fetch-capture": CustomEvent<PeriodCompareCapture>;
  }
}

// 진짜 stats endpoint만 lastCapture에 저장 — 캠페인/그룹/사용자 정보 등 false positive 차단.
// 매체별 stats endpoint:
//   파워링크/쇼핑/브랜드/파워컨텐츠: POST /apis/sa/api/stats (확인됨)
//   GFA: 추후 spike에서 확정 (예: /apis/gfa/.../stats)
//   플레이스: 추후 spike (예: /apis/place/.../stats)
const STATS_URL_PATTERNS: RegExp[] = [
  /\/apis\/sa\/api\/stats(\?|$|\/)/i,
  /\/apis\/gfa\/.*\/(stats|report)/i,
  /\/apis\/place\/.*\/(stats|report)/i,
  /\/apis\/da\/.*\/(stats|report)/i,
  // dashboard endpoint는 fallback (캠페인 개수 등 메타정보라 stats가 아닐 가능성 큼 — 1차 후보)
];

function isStatsEndpoint(url: string): boolean {
  return STATS_URL_PATTERNS.some((p) => p.test(url));
}

window.addEventListener("dvads:fetch-capture", (e) => {
  const raw = e.detail;
  if (!raw || typeof raw !== "object") return;
  if (typeof raw.url !== "string") return;

  // MAIN-world 측에서 response를 구조화 클론 안전 위해 string으로 직렬화해 보냄.
  // CustomEvent.detail이 frozen일 수 있으므로 mutate하지 않고 새 객체로 복사.
  let parsedResponse: unknown = raw.response;
  if (typeof parsedResponse === "string") {
    try {
      parsedResponse = JSON.parse(parsedResponse);
    } catch {
      parsedResponse = null;
    }
  }
  const cap: PeriodCompareCapture = {
    url: raw.url,
    method: raw.method ?? "GET",
    headers: raw.headers ?? {},
    body: raw.body ?? null,
    status: raw.status ?? 0,
    response: parsedResponse,
    ts: raw.ts ?? Date.now(),
  };

  const isStats = isStatsEndpoint(cap.url);

  // 응답에 의미있는 stats 데이터가 있는지 판별
  const resp = cap.response as Record<string, unknown> | null;
  const hasSummary =
    resp != null && typeof resp.summary === "object" && resp.summary != null;
  const hasData = resp != null && Array.isArray(resp.data) && resp.data.length > 0;
  const isMeaningful = hasSummary || hasData;

  if (DEBUG_CAPTURE) {
    if (isStats) {
      const summary = hasSummary
        ? Object.keys(resp!.summary as object).slice(0, 24)
        : null;
      const data =
        hasData && typeof (resp!.data as unknown[])[0] === "object"
          ? Object.keys((resp!.data as unknown[])[0] as object).slice(0, 24)
          : null;
      console.log(
        `[dv-ads/PoP] STATS!!${isMeaningful ? "" : "·EMPTY"} ${cap.method} ${cap.url}\n  body=${cap.body}\n  summary keys=`,
        summary,
        "\n  data[0] keys=",
        data,
      );
    } else {
      const media = detectMedia(cap.url, location.pathname);
      console.log(
        `[dv-ads/PoP] cap m=${media ?? "?"} ${cap.method} ${cap.url}`,
      );
    }
  }

  if (!isStats) return;
  // 빈 stats(summary null + data 비어있음)는 무시 — 페이지가 같은 endpoint를 여러 번 호출하는데
  // 그 중 일부만 실제 데이터를 담고 있음. 마지막에 호출된 빈 응답이 lastCapture를 덮어쓰지 않게 한다.
  if (!isMeaningful) return;
  lastCapture = cap;
});

// ─── 날짜 picker 감지 + 현재 기간 추출 ───
//
// 페이지 헤더는 "2026.05.12. → 2026.05.18." 형태. 점 끝 + 공백 + 화살표 + 공백 + 두번째 날짜.
// 화살표는 `→`(U+2192) 또는 `~`/`-` 등 매체별 변형 가능 — 일단 → 우선.

const DATE_TEXT_RE = /(\d{4})\.(\d{2})\.(\d{2})\./g;

function findDateRangeContainer(): {
  container: HTMLElement;
  start: Date;
  end: Date;
} | null {
  // 우측 상단 헤더 안에서 2개의 "YYYY.MM.DD." 텍스트가 인접한 요소를 찾는다.
  // 페이지 본문 본문에 같은 패턴이 우연히 출현할 가능성은 낮지만, 가장 작은 공통 조상으로 좁힌다.
  // 우선 document 전체에서 텍스트 매치 → 부모 element 추출 → 두 매치의 LCA가 컨테이너.
  const matches: { el: HTMLElement; date: Date }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.nodeValue;
    if (!text || !text.match(/\d{4}\.\d{2}\.\d{2}\./)) continue;
    DATE_TEXT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DATE_TEXT_RE.exec(text))) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (Number.isFinite(d.getTime())) {
        const parent = node.parentElement;
        if (parent) matches.push({ el: parent, date: d });
      }
    }
  }
  if (matches.length < 2) return null;

  // 헤더 안의 인접 두 날짜 찾기 — 같은 부모 또는 부모-자식 관계
  for (let i = 0; i < matches.length - 1; i++) {
    const a = matches[i];
    const b = matches[i + 1];
    // 두 매치가 같은 좁은 영역에 있어야 함
    const ancestor = commonAncestor(a.el, b.el);
    if (!ancestor) continue;
    // 너무 큰 컨테이너(body 등)는 제외
    const rect = ancestor.getBoundingClientRect();
    if (rect.height > 200 || rect.width > 800) continue;
    if (a.date.getTime() > b.date.getTime()) continue; // start <= end
    return { container: ancestor, start: a.date, end: b.date };
  }
  return null;
}

function commonAncestor(a: HTMLElement, b: HTMLElement): HTMLElement | null {
  const ancestors = new Set<HTMLElement>();
  let p: HTMLElement | null = a;
  while (p) {
    ancestors.add(p);
    p = p.parentElement;
  }
  let q: HTMLElement | null = b;
  while (q) {
    if (ancestors.has(q)) return q;
    q = q.parentElement;
  }
  return null;
}

// ─── 직전 기간 계산 ───

function previousPeriod(start: Date, end: Date): { start: Date; end: Date } {
  // inclusive 기간 길이 — 5/12 ~ 5/18 = 7일
  const dayMs = 24 * 60 * 60 * 1000;
  const lengthDays = Math.round((end.getTime() - start.getTime()) / dayMs) + 1;
  const prevEnd = new Date(start.getTime() - dayMs);
  const prevStart = new Date(prevEnd.getTime() - (lengthDays - 1) * dayMs);
  return { start: prevStart, end: prevEnd };
}

function formatDateYMD(d: Date, sep: string): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return sep ? `${yyyy}${sep}${mm}${sep}${dd}` : `${yyyy}${mm}${dd}`;
}

function formatRangeLabel(start: Date, end: Date): string {
  return `${formatDateYMD(start, ".")} ~ ${formatDateYMD(end, ".")}`;
}

// ─── 버튼 mount ───

const BTN_MARK = "data-dvads-period-btn";
let lastButton: HTMLButtonElement | null = null;
let lastContainer: HTMLElement | null = null;

function mountButton(): void {
  // 매체 pathname 매칭이 부정확한 페이지가 있어 (파워링크/브랜드/파워컨텐츠 캠페인 리스트 등)
  // 매체 사전 식별은 mount 조건에서 제외. 날짜 picker가 발견되는 모든 광고관리자 페이지에
  // 버튼을 mount하고, 매체 식별은 fetch capture 들어올 때 fetch URL로 판별한다.
  const found = findDateRangeContainer();
  if (!found) {
    unmountButton();
    return;
  }

  // 같은 컨테이너에 이미 버튼 떠있고 살아있으면 skip
  if (
    lastButton &&
    lastButton.isConnected &&
    lastContainer === found.container
  ) {
    return;
  }

  // 이전 mount는 정리 (컨테이너가 새 DOM으로 갈렸을 수 있음)
  unmountButton();

  // 페이지에 이미 우리 버튼이 떠있는지 확인 (재mount race)
  const existing = found.container.querySelector(`button[${BTN_MARK}]`);
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.className = "dvads dvads-period-btn";
  btn.type = "button";
  btn.setAttribute(BTN_MARK, "1");
  btn.textContent = "전후 비교";
  btn.title = "직전 동일 기간과 비교";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void openPopover(btn);
  });

  // 날짜 picker 컨테이너의 첫 자식 앞에 삽입 — 좌측에 배치되도록.
  found.container.insertBefore(btn, found.container.firstChild);

  lastButton = btn;
  lastContainer = found.container;
}

function unmountButton(): void {
  if (lastButton && lastButton.isConnected) lastButton.remove();
  lastButton = null;
  lastContainer = null;
  closePopover();
}

// ─── popover ───

let openPopoverEl: HTMLElement | null = null;
let openPopoverCleanup: (() => void) | null = null;

function closePopover(): void {
  if (!openPopoverEl) return;
  openPopoverCleanup?.();
  openPopoverCleanup = null;
  openPopoverEl.remove();
  openPopoverEl = null;
}

async function openPopover(anchor: HTMLElement): Promise<void> {
  if (openPopoverEl) {
    closePopover();
    return;
  }

  const dateInfo = findDateRangeContainer();
  if (!dateInfo) return;

  // 매체는 캡처된 fetch URL을 기반으로 결정 — pathname보다 신뢰성 높음.
  const cap = lastCapture;
  const media: PeriodCompareMedia | null = cap
    ? detectMedia(cap.url, location.pathname)
    : detectMedia(null, location.pathname);

  const popover = document.createElement("div");
  popover.className = "dvads dvads-popover dvads-period-popover";
  popover.style.position = "fixed";
  popover.style.zIndex = "2147483647";
  document.body.appendChild(popover);
  openPopoverEl = popover;

  // 헤더 + 스켈레톤 즉시 렌더
  renderPopover(popover, {
    media,
    currentRange: { start: dateInfo.start, end: dateInfo.end },
    state: "loading",
  });

  // 배지 아래 anchor 따라가기 (F001 패턴 동일)
  const reposition = () => {
    if (!anchor.isConnected) {
      closePopover();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      closePopover();
      return;
    }
    const pr = popover.getBoundingClientRect();
    let left = Math.max(8, rect.right - pr.width); // 우측 정렬(버튼 우측 끝과 popover 우측 끝 정렬)
    if (left < 8) left = 8;
    if (left + pr.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - pr.width - 8);
    }
    let top = rect.bottom + 6;
    if (top + pr.height > window.innerHeight - 8) {
      const above = rect.top - pr.height - 6;
      if (above >= 8) top = above;
      else top = Math.max(8, window.innerHeight - pr.height - 8);
    }
    popover.style.transform = `translate(${left}px, ${top}px)`;
  };
  popover.style.top = "0";
  popover.style.left = "0";
  reposition();

  let rafLoop: number | null = null;
  const tick = () => {
    reposition();
    rafLoop = requestAnimationFrame(tick);
  };
  rafLoop = requestAnimationFrame(tick);

  const onDocClick = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node) && e.target !== anchor) {
      closePopover();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopover();
  };
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

  // 데이터 로드
  try {
    if (!cap) {
      renderPopover(popover, {
        media,
        currentRange: { start: dateInfo.start, end: dateInfo.end },
        state: "no-capture",
      });
      return;
    }

    // 매체 분류 실패 시에도 어댑터는 generic alias로 동작 — 빈 매체 키로 fallback
    const adapterMedia: PeriodCompareMedia = media ?? "powerlink";
    const currentMetrics = extractMetricsFromResponse(adapterMedia, cap.response);
    const prev = previousPeriod(dateInfo.start, dateInfo.end);

    // 직전 기간 fetch — 캡처된 URL+body의 날짜를 shift
    const shifted = shiftDateParams(cap, dateInfo.start, dateInfo.end, prev.start, prev.end);
    if (DEBUG_CAPTURE) {
      console.log("[dv-ads/PoP] replay shifted body=", shifted.body);
    }
    const prevResp = await replayFetch(shifted);
    if (DEBUG_CAPTURE) {
      const r = prevResp as Record<string, unknown> | null;
      const dataLen = r && Array.isArray(r.data) ? r.data.length : -1;
      const data0 =
        r && Array.isArray(r.data) && r.data.length > 0 && typeof r.data[0] === "object"
          ? r.data[0]
          : null;
      console.log(
        "[dv-ads/PoP] replay resp dataLen=",
        dataLen,
        "data[0]=",
        data0,
        "current resp dataLen=",
        Array.isArray((cap.response as { data?: unknown[] })?.data)
          ? (cap.response as { data: unknown[] }).data.length
          : -1,
        "current metrics=",
        currentMetrics,
      );
    }
    const prevMetrics = extractMetricsFromResponse(adapterMedia, prevResp);
    if (DEBUG_CAPTURE) {
      console.log("[dv-ads/PoP] prev metrics=", prevMetrics);
    }

    renderPopover(popover, {
      media,
      currentRange: { start: dateInfo.start, end: dateInfo.end },
      previousRange: prev,
      current: currentMetrics,
      previous: prevMetrics,
      state: "ok",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[dv-ads/PoP] replay failed", err);
    renderPopover(popover, {
      media,
      currentRange: { start: dateInfo.start, end: dateInfo.end },
      state: "error",
      errorMessage: friendlyApiError(msg, "test"),
    });
  }
}

// ─── replay fetch ───

interface ShiftedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

async function replayFetch(req: ShiftedRequest): Promise<unknown> {
  // 콘텐츠 스크립트는 페이지와 같은 origin(ads.naver.com)이라 쿠키 자동 첨부.
  // x-xsrf-token이 captured headers에 있으면 그대로 사용. 없으면 XSRF-TOKEN 쿠키에서 채움.
  const headers = { ...req.headers };
  if (!hasHeader(headers, "x-xsrf-token")) {
    const xsrf = readCookie("XSRF-TOKEN");
    if (xsrf) headers["x-xsrf-token"] = decodeURIComponent(xsrf);
  }

  const resp = await fetch(req.url, {
    method: req.method,
    headers,
    body: req.body,
    credentials: "include",
  });

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return await resp.json();
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(h).some((k) => k.toLowerCase() === lower);
}

function readCookie(name: string): string | null {
  const all = document.cookie.split(";");
  for (const raw of all) {
    const trimmed = raw.trim();
    if (trimmed.startsWith(name + "=")) {
      return trimmed.slice(name.length + 1);
    }
  }
  return null;
}

// ─── render ───

interface NormalizedMetrics {
  impressions: number | null;
  clicks: number | null;
  cpc: number | null;
  cost: number | null;
  revenue: number | null;
  conversions: number | null;
  roas: number | null;
}

interface PopoverState {
  media: PeriodCompareMedia | null;
  currentRange: { start: Date; end: Date };
  previousRange?: { start: Date; end: Date };
  current?: NormalizedMetrics;
  previous?: NormalizedMetrics;
  state: "loading" | "ok" | "no-capture" | "error";
  errorMessage?: string;
}

function renderPopover(root: HTMLElement, st: PopoverState): void {
  root.replaceChildren();

  const hdr = document.createElement("div");
  hdr.className = "dvads-popover-hdr";
  const title = document.createElement("div");
  title.className = "kw";
  title.textContent = "전후 비교";
  hdr.append(title);
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
  root.append(hdr);

  // 기간 라벨
  const rangeLine = document.createElement("div");
  rangeLine.className = "dvads-period-range";
  if (st.previousRange) {
    rangeLine.textContent = `${formatRangeLabel(st.previousRange.start, st.previousRange.end)}  →  ${formatRangeLabel(st.currentRange.start, st.currentRange.end)}`;
  } else {
    rangeLine.textContent = `${formatRangeLabel(st.currentRange.start, st.currentRange.end)}`;
  }
  root.append(rangeLine);

  if (st.state === "no-capture") {
    const msg = document.createElement("div");
    msg.className = "dvads-period-empty";
    msg.textContent =
      "페이지 데이터를 아직 학습 중입니다. 페이지를 새로고침하거나 날짜를 한 번 변경한 뒤 다시 눌러 주세요.";
    root.append(msg);
    return;
  }
  if (st.state === "error") {
    const msg = document.createElement("div");
    msg.className = "dvads-period-error";
    msg.textContent = st.errorMessage ?? "조회 실패";
    root.append(msg);
    return;
  }

  // 테이블 (loading이면 빈 셀)
  const table = document.createElement("table");
  table.className = "dvads-bid-table dvads-period-table";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  for (const label of ["지표", "이전", "현재", "증감"]) {
    const th = document.createElement("th");
    th.textContent = label;
    trh.appendChild(th);
  }
  thead.append(trh);
  table.append(thead);

  const tbody = document.createElement("tbody");
  type MetricFmt = "int" | "krw" | "krw-int" | "percent";
  // 일부 지표는 증가가 좋고, CPC·총비용은 증가가 나쁨. invertColor=true면 증감 색을 뒤집어 표시.
  const rows: Array<{
    key: keyof NormalizedMetrics;
    label: string;
    fmt: MetricFmt;
    invertColor?: boolean;
  }> = [
    { key: "impressions", label: "노출수", fmt: "int" },
    { key: "clicks", label: "클릭수", fmt: "int" },
    { key: "cpc", label: "CPC", fmt: "krw-int", invertColor: true },
    { key: "cost", label: "총비용", fmt: "krw-int", invertColor: true },
    { key: "revenue", label: "매출", fmt: "krw-int" },
    { key: "conversions", label: "전환수", fmt: "int" },
    { key: "roas", label: "ROAS", fmt: "percent" },
  ];

  let missingAny = false;
  for (const { key, label, fmt, invertColor } of rows) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.textContent = label;
    tr.append(tdLabel);

    const prevVal = st.previous?.[key] ?? null;
    const curVal = st.current?.[key] ?? null;
    // revenue/conversions만 missingAny 트리거 (cpc/roas는 계산 fallback이라 제외)
    if (
      st.state === "ok" &&
      (key === "revenue" || key === "conversions") &&
      (prevVal == null || curVal == null)
    ) {
      missingAny = true;
    }

    tr.append(cell(formatMetric(prevVal, fmt, st.state)));
    tr.append(cell(formatMetric(curVal, fmt, st.state)));
    tr.append(cell(formatDelta(prevVal, curVal, st.state, invertColor === true)));
    tbody.append(tr);
  }
  table.append(tbody);
  root.append(table);

  if (missingAny && st.state === "ok") {
    const note = document.createElement("div");
    note.className = "dvads-disclaimer";
    note.textContent =
      "일부 지표가 비어 있습니다. 페이지 상단 [열 맞춤 설정]에서 매출·전환수 컬럼을 켜면 비교에 표시됩니다.";
    root.append(note);
  }
}

function cell(html: { text: string; cls?: string }): HTMLElement {
  const td = document.createElement("td");
  td.textContent = html.text;
  if (html.cls) td.classList.add(html.cls);
  return td;
}

function formatMetric(
  v: number | null,
  fmt: "int" | "krw" | "krw-int" | "percent",
  state: PopoverState["state"],
): { text: string } {
  if (state === "loading") return { text: "..." };
  if (v == null) return { text: "-" };
  if (fmt === "int") return { text: Math.round(v).toLocaleString() };
  if (fmt === "krw" || fmt === "krw-int") {
    return { text: `${Math.round(v).toLocaleString()}원` };
  }
  if (fmt === "percent") {
    // ROAS — 정수 % 표시. 1자리 소수가 필요하면 toFixed(1) 사용 검토.
    return { text: `${Math.round(v).toLocaleString()}%` };
  }
  return { text: String(v) };
}

/**
 * 증감 셀 — 한국 컨벤션(주식 시세) 색: 증가=빨강 / 감소=파랑.
 * 단 CPC·총비용처럼 "증가가 나쁜 지표"는 invertColor=true로 색을 뒤집어
 * 사용자에게 일관된 의미(빨강=불리, 파랑=유리)를 주려 했으나 — 본 컴포넌트는
 * 사용자 요청대로 한국 컨벤션 그대로(증가=빨강) 유지하기로 함. invertColor는
 * 의미 reverse가 아니라 동일 색 정책 적용. 추후 의미별 색 분리 필요 시
 * 별도 클래스(`.dvads-period-delta-up-bad` 등)로 분기 가능.
 */
function formatDelta(
  prev: number | null,
  cur: number | null,
  state: PopoverState["state"],
  _invertColor: boolean,
): { text: string; cls?: string } {
  if (state === "loading") return { text: "" };
  if (prev == null || cur == null) return { text: "-" };
  if (prev === 0) {
    if (cur === 0) return { text: "0%" };
    return { text: "신규", cls: "dvads-period-delta-up" };
  }
  const pct = ((cur - prev) / Math.abs(prev)) * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  const cls =
    pct > 0
      ? "dvads-period-delta-up"
      : pct < 0
        ? "dvads-period-delta-down"
        : undefined;
  return { text: `${sign}${Math.abs(pct).toFixed(1)}%`, cls };
}

// ─── lifecycle ───

let mountRaf: number | null = null;
function scheduleMount(): void {
  if (mountRaf !== null) return;
  mountRaf = requestAnimationFrame(() => {
    mountRaf = null;
    mountButton();
  });
}

let lastUrl = location.href;

export function initPeriodCompare(): void {
  // DOM 변경 — 날짜 picker가 SPA navigation에서 다시 그려질 수 있음
  new MutationObserver(scheduleMount).observe(document.body, {
    childList: true,
    subtree: true,
  });
  // URL 변경 (F001과 동일 패턴)
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      unmountButton();
      // 페이지 이동 시 캡처 비움 — 다른 매체 endpoint를 잘못 replay하지 않게
      lastCapture = null;
      scheduleMount();
    }
  }).observe(document, { childList: true, subtree: true });

  scheduleMount();
}
