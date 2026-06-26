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
  isStatsLikeCapture,
  shiftDateParams,
} from "@/lib/period-compare-adapters";
import { friendlyApiError } from "@/lib/friendly-error";

// ─── 캡처 store ───
// 페이지가 같은 endpoint를 여러 번 호출하거나(필터/페이지네이션) 동시에 여러 endpoint를 호출
// (account-level overview + paginated list + lifetime range fetch 등)하기 때문에, 최근 N건을
// 모두 보관한다. 팝오버 열 때 사용자 선택 날짜가 URL/body에 포함된 capture만 후보로 추려서
// impressions이 가장 많은 것을 선택 (lifetime range나 wrong-date capture 자동 배제).
// SPA 라우팅 시 모두 비움.
const recentCaptures: PeriodCompareCapture[] = [];
const MAX_RECENT_CAPTURES = 20;
const DEBUG_CAPTURE = false; // 매체별 응답 schema 분석/별칭 추가 시 true로 일시 전환.

declare global {
  interface WindowEventMap {
    "dvads:fetch-capture": CustomEvent<PeriodCompareCapture>;
  }
}

// 매체별 stats endpoint는 너무 다양하다 — `/apis/sa/api/stats`(파워링크 캠페인 리스트)
// 외에도 전체 캠페인 대시보드, 검색광고 대시보드, 디스플레이(GFA), 플레이스 등 각각
// 다른 경로를 쓰며 path 패턴 추정으로는 모든 매체를 cover하기 어렵다.
// 대신 응답 shape 기반(`isStatsLikeCapture` — 응답 안에 `impCnt`/`clkCnt`/`cost`/`cpc`
// 같은 stats hint key가 2개 이상)으로 stats 응답을 인식한다. 매체별 endpoint 정찰 없이
// 동작하고, 캠페인 리스트처럼 row별 stats가 담긴 응답도 자동 cover된다.

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

  const isStats = isStatsLikeCapture(cap);
  if (!isStats) {
    if (DEBUG_CAPTURE) {
      const media = detectMedia(cap.url, location.pathname);
      console.log(`[dv-ads/PoP] skip non-stats m=${media ?? "?"} ${cap.method} ${cap.url}`);
    }
    return;
  }

  // 페이지가 같은 endpoint를 여러 번 호출(필터/페이지네이션 등)하면 빈 응답이 마지막에 와서
  // 실제 데이터 응답을 덮어쓸 수 있다. 캡처 즉시 metrics 추출해서 유의미한 값(impressions/
  // clicks/cost 중 하나라도 null 아닌 실수)이 있을 때만 recentCaptures에 채택.
  // 매체는 capture URL로 추정 — 매체 미식별 페이지(전체 캠페인/대시보드)는 powerlink 키 fallback.
  const guessMedia = detectMedia(cap.url, location.pathname) ?? "powerlink";
  const m = extractMetricsFromResponse(guessMedia, cap.response);
  const isReal =
    m.impressions != null ||
    m.clicks != null ||
    m.cost != null ||
    m.conversions != null ||
    m.revenue != null;

  if (DEBUG_CAPTURE) {
    const resp = cap.response as Record<string, unknown> | null;
    const topKeys = resp ? Object.keys(resp).slice(0, 30) : null;
    if (isReal) {
      // KEEP 케이스도 응답 sample 같이 — 단위 이상(예: cost in 1/100,000원)
      // 진단/패턴 별칭 추가 시 활용.
      let sample = "";
      try {
        sample = JSON.stringify(resp).slice(0, 1500);
      } catch {
        sample = "(stringify failed)";
      }
      console.log(
        `[dv-ads/PoP] STATS KEEP ${cap.method} ${cap.url}`,
        "\n  body=", cap.body,
        "\n  metrics=", m,
        "\n  top-level keys=", topKeys,
        "\n  response sample=", sample,
      );
    } else {
      // 빈 추출은 응답 sample을 함께 찍어 사용자가 구조 파악 가능하도록 (구글 검색용)
      let sample = "";
      try {
        sample = JSON.stringify(resp).slice(0, 1500);
      } catch {
        sample = "(stringify failed)";
      }
      console.log(
        `[dv-ads/PoP] STATS skip-empty ${cap.method} ${cap.url}`,
        "\n  body=", cap.body,
        "\n  top-level keys=", topKeys,
        "\n  response sample=", sample,
      );
    }
  }

  if (!isReal) return;

  // 모든 의미있는 capture 보관. 선택은 팝오버 열 때 pickBestCapture가 사용자 선택 날짜 기준으로.
  recentCaptures.push(cap);
  if (recentCaptures.length > MAX_RECENT_CAPTURES) recentCaptures.shift();
});

/**
 * 사용자가 현재 선택한 날짜 범위(curStart~curEnd)와 일치하는 capture 중 impressions이 가장 큰
 * 것을 선택. 날짜가 URL/body 어디에도 안 들어있는 capture(예: lifetime range fetch)는 자동 배제.
 * 매칭 capture 없으면 가장 최근 것 fallback.
 */
function pickBestCapture(
  candidates: PeriodCompareCapture[],
  curStart: Date,
  curEnd: Date,
): PeriodCompareCapture | null {
  if (candidates.length === 0) return null;

  // YYYY-MM-DD, YYYY.MM.DD, YYYY/MM/DD, YYYYMMDD 4가지 포맷
  const seps = ["-", ".", "/", ""];
  const startStrs = seps.map((s) => formatDateYMD(curStart, s));
  const endStrs = seps.map((s) => formatDateYMD(curEnd, s));

  const matched: Array<{ cap: PeriodCompareCapture; combined: number; richness: number; imps: number }> = [];
  for (const c of candidates) {
    const blob = c.url + " " + (c.body ?? "");
    const hasStart = startStrs.some((s) => blob.includes(s));
    const hasEnd = endStrs.some((s) => blob.includes(s));
    if (!hasStart || !hasEnd) continue;
    const media = detectMedia(c.url, location.pathname) ?? "powerlink";
    const m = extractMetricsFromResponse(media, c.response);
    // 완성도(richness) — 비용·매출·전환 필드가 응답에 있는지. 추세 그래프용 부분
    // 응답(impCnt/clkCnt만)은 0점이라 비용·전환을 갖춘 표용 응답에 밀린다.
    // 같은 endpoint를 여러 번 호출할 때 부분 응답이 뽑혀 "0원/0전환"이 되던 문제 방지.
    const richness =
      (m.cost != null ? 1 : 0) +
      (m.revenue != null ? 1 : 0) +
      (m.conversions != null ? 1 : 0);
    // combined 보너스 — dashboard/GFA URL은 SA+DA 양쪽을 합산할 수 있어 SA-only stats보다 우선.
    // 전체 캠페인/대시보드 페이지는 SA stats도 잡히지만 dashboard capture가 있으면 그쪽을 선택해
    // GFA 데이터까지 포함. SA 전용 페이지(파워링크 등)는 SA stats만 잡혀서 영향 없음.
    const combined = /\/apis\/(dashboard\/v1|gfa\/v1)\/adAccounts\/\d+\//.test(c.url) ? 1 : 0;
    matched.push({ cap: c, combined, richness, imps: m.impressions ?? 0 });
  }

  if (matched.length > 0) {
    // 1순위 combined(SA+GFA 통합 가능 여부), 2순위 완성도, 3순위 노출수.
    matched.sort((a, b) => b.combined - a.combined || b.richness - a.richness || b.imps - a.imps);
    if (DEBUG_CAPTURE) {
      console.log(
        `[dv-ads/PoP] picked best ${matched[0].cap.method} ${matched[0].cap.url} (richness=${matched[0].richness}, imps=${matched[0].imps}, ${matched.length} date-matched candidates)`,
      );
    }
    return matched[0].cap;
  }

  // 날짜 매칭 capture 없음 → 가장 최근 fallback (잘못된 데이터일 수 있지만 일단 표시)
  if (DEBUG_CAPTURE) {
    console.log(
      `[dv-ads/PoP] no date-matched capture, fallback to latest (${candidates.length} total)`,
    );
  }
  return candidates[candidates.length - 1];
}

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
  // 인접한 두 날짜 매치를 만나는 즉시 검사하고, 유효하면 바로 반환한다.
  // 날짜 picker는 보통 헤더(문서 앞부분)에 있으므로 전체 body를 끝까지 훑지 않고 조기 종료 →
  // 캠페인/행 많은 큰 페이지에서 TreeWalker 비용을 크게 줄인다. (DOM 변경마다 호출되므로 중요.)
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let prev: { el: HTMLElement; date: Date } | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.nodeValue;
    if (!text || !text.match(/\d{4}\.\d{2}\.\d{2}\./)) continue;
    DATE_TEXT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DATE_TEXT_RE.exec(text))) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (!Number.isFinite(d.getTime())) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      const cur = { el: parent, date: d };
      if (prev) {
        // 두 매치가 같은 좁은 영역(헤더 날짜 picker)에 있고 start <= end면 그게 컨테이너.
        const ancestor = commonAncestor(prev.el, cur.el);
        if (ancestor) {
          const rect = ancestor.getBoundingClientRect();
          if (
            rect.height <= 200 &&
            rect.width <= 800 &&
            prev.date.getTime() <= cur.date.getTime()
          ) {
            return { container: ancestor, start: prev.date, end: cur.date };
          }
        }
      }
      prev = cur;
    }
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

function daysBetweenInclusive(start: Date, end: Date): number {
  // inclusive 일수 (start·end 양끝 포함). 음수 방어를 위해 abs.
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(1, Math.round(Math.abs(end.getTime() - start.getTime()) / dayMs) + 1);
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

// 보고서 메뉴 하위 페이지(매체별/다차원/캠페인 보고서 등)는 데이터를 비동기 큐 API
// (Master Reports)로 처리해 page 자체 fetch로는 의미 있는 stats를 캡처할 수 없다.
// 버튼이 떠도 popover가 0/0으로만 채워져 혼란만 주므로 mount 자체를 skip.
// 매체 캠페인 리스트(/sa/campaigns-by/*)·광고그룹 페이지(/sa/adgroups/*)에서만 표시.
const REPORT_PATH_RE = /\/reports?(\/|$)/i;

function mountButton(): void {
  if (REPORT_PATH_RE.test(location.pathname)) {
    unmountButton();
    return;
  }
  // 버튼이 이미 살아있고 컨테이너도 연결돼 있으면 전체 DOM 스캔(findDateRangeContainer) 생략.
  // MutationObserver가 DOM 변경마다 mountButton을 부르는데, 매번 전체 body TreeWalker를 돌면
  // 콘텐츠 많은 페이지에서 메인 스레드 부담이 커진다. 컨테이너가 SPA 재렌더로 detach되면
  // isConnected=false가 되어 아래 스캔/재mount 경로로 자연히 떨어진다.
  if (lastButton && lastButton.isConnected && lastContainer && lastContainer.isConnected) {
    return;
  }
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
  btn.setAttribute("aria-label", "데이터 비교");
  btn.title = "데이터 비교 (직전 동일 기간과 비교)";
  btn.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2.5" y="7" width="3.5" height="6" rx="0.6"/>' +
    '<rect x="10" y="3" width="3.5" height="10" rx="0.6"/>' +
    "</svg>";
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

  // 사용자가 선택한 날짜 범위와 매치되는 capture 중 impressions이 가장 큰 것을 선택.
  // lifetime range fetch나 sub-period chart fetch처럼 사용자 picker와 다른 날짜의 capture는 배제.
  const cap = pickBestCapture(recentCaptures, dateInfo.start, dateInfo.end);
  const media: PeriodCompareMedia | null = cap
    ? detectMedia(cap.url, location.pathname)
    : detectMedia(null, location.pathname);

  const popover = document.createElement("div");
  popover.className = "dvads dvads-popover dvads-period-popover";
  popover.style.position = "fixed";
  popover.style.zIndex = "2147483647";
  document.body.appendChild(popover);
  openPopoverEl = popover;

  // 직전 기간은 fetch 결과와 무관하게 즉시 계산 가능 — 로딩 중에도 기간 줄 완성된 상태로 표시.
  const initialPrev = previousPeriod(dateInfo.start, dateInfo.end);

  // 헤더 + 스켈레톤 즉시 렌더
  renderPopover(popover, {
    media,
    currentRange: { start: dateInfo.start, end: dateInfo.end },
    previousRange: initialPrev,
    state: "loading",
  });

  // reposition이 매 프레임 같은 좌표를 다시 쓰지 않도록 직전 프레임 값 추적 (#5).
  let lastLeft = NaN;
  let lastTop = NaN;
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
    // 좌표가 직전 프레임과 같으면 재기록 skip (불필요한 style write 제거).
    if (left !== lastLeft || top !== lastTop) {
      lastLeft = left;
      lastTop = top;
      popover.style.transform = `translate(${left}px, ${top}px)`;
    }
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

  // popover 안에서 시작한 mousedown 추적 — 드래그하다가 밖에서 release하면 click이
  // 외부에서 발화해서 popover를 닫아버리는 사고 방지. mousedown 시작점이 popover/anchor
  // 내부면 그 다음 click 1번은 outside-close에서 면제한다.
  let mousedownInsidePopover = false;
  const onDocMouseDown = (e: MouseEvent) => {
    const t = e.target as Node;
    mousedownInsidePopover = popover.contains(t) || anchor.contains(t);
  };
  const onDocClick = (e: MouseEvent) => {
    if (mousedownInsidePopover) {
      mousedownInsidePopover = false;
      return;
    }
    if (!popover.contains(e.target as Node) && e.target !== anchor) {
      closePopover();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closePopover();
  };
  document.addEventListener("mousedown", onDocMouseDown, true);
  setTimeout(() => {
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKey);
  }, 0);
  openPopoverCleanup = () => {
    document.removeEventListener("mousedown", onDocMouseDown, true);
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
    if (rafLoop !== null) cancelAnimationFrame(rafLoop);
    rafLoop = null;
  };

  // 데이터 로드
  try {
    // 현재 보고 있는 페이지로 무엇을 합산할지 결정 (cap.url 아닌 location.pathname 기반).
    const scope = detectPageScope(location.pathname);
    const acct = accountNoFromPath(location.pathname);
    const accountScoped = !!acct && scope.kind !== "other";

    if (!cap && !accountScoped) {
      // 캡처 못한 페이지(아직 stats fetch 미발생 등)는 "학습 중" 안내 대신
      // 빈 metrics(전부 null → 0/0원/0.0%) 그대로 표 렌더. 사용자에게는 자연스럽게 "0건"으로 보임.
      renderPopover(popover, {
        media,
        currentRange: { start: dateInfo.start, end: dateInfo.end },
        previousRange: initialPrev,
        state: "ok",
      });
      return;
    }

    // 매체 분류 실패 시에도 어댑터는 generic alias로 동작 — 빈 매체 키로 fallback
    const adapterMedia: PeriodCompareMedia = media ?? "powerlink";
    const prev = previousPeriod(dateInfo.start, dateInfo.end);

    let currentMetrics: NormalizedMetrics;
    let prevMetrics: NormalizedMetrics;

    if (accountScoped && acct) {
      // dashboard/전체캠페인 → 계정 전체(SA,DA). GFA 목적/단일 캠페인 페이지 → DA + 스코프 필터.
      // 어느 경우든 노출>0 캠페인의 구매완료만 2차 호출로 합산 (multi-account-data.ts와 동일 기준).
      const platformFilter: "SA,DA" | "DA" = scope.kind === "account" ? "SA,DA" : "DA";
      const scopeOpts: DashboardScopeOpts =
        scope.kind === "gfa-objective" ? { objectiveType: `GFA_${scope.objective}` }
        : scope.kind === "gfa-campaign" ? { campaignId: scope.campaignId }
        : {};
      // 인증 헤더는 아무 최근 캡처에서 빌려온다 (dashboard/gfa는 URL-aware라 활성 계정 세션으로 동작).
      const headerCap = cap ?? recentCaptures[recentCaptures.length - 1] ?? null;
      // SA 구매완료 합산용 masterCustomerId 확보 (캡처 헤더 우선 → ad-account v2 조회). 계정당 1회 캐시.
      const customerId = await resolveCustomerId(acct, headerCap?.headers ?? {});
      if (DEBUG_CAPTURE) {
        console.log(`[dv-ads/PoP] scope=${scope.kind} acct=${acct} platform=${platformFilter} customerId=${customerId} opts=`, scopeOpts);
      }
      const [cur, prv] = await Promise.all([
        fetchDashboardPurchaseMetrics(headerCap, dateInfo.start, dateInfo.end, acct, platformFilter, scopeOpts, customerId),
        fetchDashboardPurchaseMetrics(headerCap, prev.start, prev.end, acct, platformFilter, scopeOpts, customerId),
      ]);
      currentMetrics = cur;
      prevMetrics = prv;
    } else if (cap && isSaStatsCapture(cap)) {
      // SA 검색광고 stats — 페이지가 요청한 필드(전체전환만 있거나 전환 컬럼 누락 등)에
      // 의존하지 않고, 구매완료 기준 표준 필드로 현재·직전 기간을 직접 재호출.
      // 캡처에서는 ids(캠페인 ID)만 빌려온다. 페이지 열 맞춤 설정과 무관하게 항상 구매완료로 일관.
      const curReq = buildSaStatsRequest(cap, dateInfo.start, dateInfo.end);
      const prevReq = buildSaStatsRequest(cap, prev.start, prev.end);
      if (DEBUG_CAPTURE) {
        console.log("[dv-ads/PoP] SA stats canonical replay cur=", curReq.body, "prev=", prevReq.body);
      }
      const [curResp, prevResp] = await Promise.all([
        replayFetch(curReq),
        replayFetch(prevReq),
      ]);
      currentMetrics = extractMetricsFromResponse(adapterMedia, curResp);
      prevMetrics = extractMetricsFromResponse(adapterMedia, prevResp);
    } else if (cap && extractDashboardAccountNo(cap.url)) {
      // fallback — pathname으로 스코프를 못 잡은 계정 스코프 캡처 (비표준 페이지 등).
      // cap.url 기반으로 dashboard/GFA 합산 (구 동작 유지).
      const accountNo = extractDashboardAccountNo(cap.url)!;
      const platformFilter: "SA,DA" | "DA" = /\/apis\/gfa\/v1\//.test(cap.url) ? "DA" : "SA,DA";
      const customerId = await resolveCustomerId(accountNo, cap.headers ?? {});
      const [cur, prv] = await Promise.all([
        fetchDashboardPurchaseMetrics(cap, dateInfo.start, dateInfo.end, accountNo, platformFilter, {}, customerId),
        fetchDashboardPurchaseMetrics(cap, prev.start, prev.end, accountNo, platformFilter, {}, customerId),
      ]);
      currentMetrics = cur;
      prevMetrics = prv;
    } else if (cap) {
      // 그 외 매체(플레이스 등) — 페이지가 요청한 그대로 replay (날짜만 shift).
      currentMetrics = extractMetricsFromResponse(adapterMedia, cap.response);
      const shifted = shiftDateParams(cap, dateInfo.start, dateInfo.end, prev.start, prev.end);
      const prevResp = await replayFetch(shifted);
      prevMetrics = extractMetricsFromResponse(adapterMedia, prevResp);
    } else {
      // accountScoped인데 acct 없음 등 — 안전하게 빈 표.
      renderPopover(popover, {
        media,
        currentRange: { start: dateInfo.start, end: dateInfo.end },
        previousRange: prev,
        state: "ok",
      });
      return;
    }
    if (DEBUG_CAPTURE) {
      console.log("[dv-ads/PoP] current metrics=", currentMetrics, "prev metrics=", prevMetrics);
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

// ─── SA 검색광고 stats 표준 재호출 ───
//
// `/apis/sa/api/stats`는 powerlink/shopping/브랜드/파워컨텐츠/전체캠페인이 공유하는 endpoint.
// 페이지가 요청하는 `fields`는 사용자 열 맞춤 설정에 따라 달라져(전체전환만 / 전환 누락 등)
// 캡처 응답에서 구매완료를 못 뽑는 경우가 생긴다. 이를 피하려 페이지 필드를 무시하고
// 다계정 대시보드(`multi-account-data.ts`)에서 검증된 구매완료 표준 필드로 직접 재호출한다.
// 캡처에서는 ids(캠페인/광고그룹 ID)만 빌려온다.
const SA_STATS_CANONICAL_FIELDS = [
  "impCnt",
  "clkCnt",
  "cpc",
  "salesAmtMicros",
  "purchaseConvAmtMicros",
  "purchaseCcnt",
] as const;

function isSaStatsCapture(cap: PeriodCompareCapture): boolean {
  return (
    cap.method.toUpperCase() === "POST" &&
    /\/apis\/sa\/api\/stats(\?|$)/.test(cap.url) &&
    !!cap.body
  );
}

function buildSaStatsRequest(
  cap: PeriodCompareCapture,
  since: Date,
  until: Date,
): ShiftedRequest {
  let ids = "";
  try {
    const parsed = JSON.parse(cap.body ?? "{}") as { ids?: unknown };
    if (typeof parsed.ids === "string") ids = parsed.ids;
    else if (Array.isArray(parsed.ids)) ids = parsed.ids.map(String).join(",");
  } catch {
    /* body가 JSON 아니면 ids 빈 채로 — 사실상 발생 안 함 */
  }
  const body = JSON.stringify({
    fields: SA_STATS_CANONICAL_FIELDS,
    timeIncrement: "allDays",
    timeRange: {
      since: formatDateYMD(since, "-"),
      until: formatDateYMD(until, "-"),
    },
    ids,
  });
  return { url: cap.url, method: cap.method, headers: cap.headers, body };
}

// ─── 대시보드(전체 캠페인) stats 전체 합산 재호출 ───
//
// `/apis/dashboard/v1/adAccounts/{no}/campaigns/search`는 계정 홈 대시보드가 쓰는
// 캠페인 리스트 endpoint. body의 `pageSize`가 작아(기본 10) 페이지가 보여주는 첫 페이지만
// 합산되면 F-PoP 합계가 실제 계정 총합보다 적게 나온다. pageSize를 크게 잡아 전체 캠페인을
// 한 번에 받아 합산한다.
const DASHBOARD_PAGE_SIZE = 1000;

// dashboard / GFA 어떤 캡처가 잡혔든 항상 campaigns/search(filter:SA,DA, pageSize 큼)로 재호출한다.
function buildDashboardCampaignsRequest(
  accountNo: string,
  capturedHeaders: Record<string, string>,
  since: Date,
  until: Date,
  platformFilter: "SA,DA" | "DA" = "SA,DA",
): ShiftedRequest {
  const body = JSON.stringify({
    startDate: formatDateYMD(since, "-"),
    endDate: formatDateYMD(until, "-"),
    filter: `campaign.adPlatform:in:${platformFilter}`,
    orderBy: "campaign.status:asc",
    pageNumber: 1,
    pageSize: DASHBOARD_PAGE_SIZE,
  });
  // XHR 캡처는 setRequestHeader 원본 케이스 보존 (Axios: "Content-Type", "Accept" 등 대문자).
  // 전체 캡처 헤더를 그대로 스프레드하면 "Content-Type" + "content-type" 두 키가 공존해
  // fetch()가 동일 헤더를 두 번 append → 중복 Content-Type → 서버 415.
  // authFetch 패턴처럼 clean 헤더만 구성하고, 인증 헤더만 캡처에서 추출.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "accept": "application/json, text/plain, */*",
  };
  for (const [k, v] of Object.entries(capturedHeaders)) {
    const lower = k.toLowerCase();
    if (lower === "x-xsrf-token" || lower === "x-ad-customer-id") {
      headers[lower] = v;
    }
  }
  return {
    url: `${location.origin}/apis/dashboard/v1/adAccounts/${accountNo}/campaigns/search`,
    method: "POST",
    headers,
    body,
  };
}

// ─── 대시보드 구매완료 지표 (전환수까지 구매완료로 보강) ───
//
// 대시보드 campaigns/search 응답엔 노출/클릭/비용/구매완료매출(purchasedConversionsValueMicros)은
// 있으나 "구매완료 전환수" 필드가 없다(전체전환 conversions만 있음). 사용자는 전체전환을 안 쓰므로,
// 캠페인 ID를 플랫폼별로 분리해 구매완료 전환수를 2차 호출로 합산한다:
//   SA → /apis/sa/api/stats purchaseCcnt,  DA(GFA) → gfa campaignStats purchaseConvCount
// 매출/노출/클릭/비용은 대시보드 응답 그대로 사용.
interface DashboardSearchResp {
  results?: Array<{
    campaign?: { campaignId?: string; adPlatform?: string; type?: string };
    metrics?: {
      impressions?: number;
      clicks?: number;
      grossCostMicros?: number;
    };
  }>;
}
// 매출은 campaignStats.purchaseConvSalesKRW (원 단위)로 가져온다 — multi-account-data.ts와 동일.
type GfaStatsResp = Record<
  string,
  { conversion?: { purchaseConvCount?: number; purchaseConvSalesKRW?: number } } | null
>;
interface SaPurchaseStatsResp {
  data?: Array<{ purchaseCcnt?: number; purchaseConvAmtMicros?: number }>;
}

const SA_CONV_CHUNK = 80;
const GFA_CONV_CHUNK = 100;

// dashboard URL(/apis/dashboard/v1/adAccounts/{id}/) 또는 GFA URL(/apis/gfa/v1/adAccounts/{id}/)에서
// adAccountNo 추출. SA stats(/apis/sa/api/stats)는 URL-aware 아닌 session 기반이라 여기서 안 잡음.
function extractDashboardAccountNo(url: string): string | null {
  const m = url.match(/\/apis\/(dashboard\/v1|gfa\/v1)\/adAccounts\/(\d+)\//);
  return m ? m[2] : null;
}

// ─── masterCustomerId 확보 (SA stats cross-account 헤더용) ───
//
// `/apis/sa/api/stats`는 URL-aware가 아니라 `x-ad-customer-id`(masterCustomerId) 헤더로
// 대상 계정을 지정한다. 헤더가 없으면 서버가 세션 활성 계정 기준으로 응답하는데, dashboard를
// 보고 있어도 SA 컨텍스트가 안 잡힌 계정에서는 200 + 빈 data(silent-empty)가 되어 SA 구매완료가
// 0으로 빠진다 (2026-05-27 라이브 확정 — 헤더 추가 시 reports ground truth와 매출 정확히 일치).
// 광고관리자 URL의 accountNo(예: 2116317)와 masterCustomerId(예: 1125327)는 별개 ID space.
//
// 우선순위: 페이지 캡처 헤더의 x-ad-customer-id(페이지 axios가 이미 실어 보냄) → ad-account v2 조회.
// 계정당 1회 캐시 (cur/prev 2회 호출 + 팝오버 재오픈에서 중복 fetch 방지).
const customerIdCache = new Map<string, string | null>();

function customerIdFromHeaders(headers: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "x-ad-customer-id" && v) return v;
  }
  return null;
}

async function resolveCustomerId(
  accountNo: string,
  capturedHeaders: Record<string, string>,
): Promise<string | null> {
  const fromCap = customerIdFromHeaders(capturedHeaders);
  if (fromCap) return fromCap;
  if (customerIdCache.has(accountNo)) return customerIdCache.get(accountNo) ?? null;
  let out: string | null = null;
  try {
    const headers: Record<string, string> = { accept: "application/json, text/plain, */*" };
    const xsrf = readCookie("XSRF-TOKEN");
    if (xsrf) headers["x-xsrf-token"] = decodeURIComponent(xsrf);
    const resp = await fetch(`${location.origin}/apis/ad-account/v2/adAccounts/${accountNo}`, {
      method: "GET",
      headers,
      credentials: "include",
    });
    if (resp.ok) {
      const j = (await resp.json()) as { adAccount?: { masterCustomerId?: number } };
      const id = j?.adAccount?.masterCustomerId;
      if (id != null) out = String(id);
    }
  } catch {
    /* 조회 실패 — null로 두면 SA 합산은 캡처 헤더(있으면)/세션 기준으로 graceful degrade */
  }
  customerIdCache.set(accountNo, out);
  return out;
}

// ─── 페이지 스코프 판정 (location.pathname 기반) ───
//
// 어떤 capture가 잡혔는지(cap.url)가 아니라 *현재 보고 있는 페이지*로 무엇을 합산할지 결정한다.
// dashboard/전체캠페인은 계정 전체(SA+DA), GFA 목적 페이지는 그 목적의 DA 캠페인만 합산해야
// 페이지가 화면에 보여주는 범위와 일치한다. (cap.url 기반이면 GFA 페이지에서도 dashboard
// 캡처가 잡혀 전체 DA를 합산하는 등 페이지 스코프와 어긋남 — 2026-05-27 라이브 정찰로 확인.)
//
// URL 패턴:
//   /manage/ad-accounts/{no}/dashboard            → 계정 대시보드 (SA+DA 전체)
//   /manage/ad-accounts/{no}/all-campaigns        → 전체 캠페인 (SA+DA 전체)
//   /manage/ad-accounts/{no}/da/campaigns-by/{OBJ}→ GFA 목적별 (DA + type GFA_{OBJ})
//   /manage/ad-accounts/{no}/da/dashboard/campaign/{id} → GFA 단일 캠페인
type PageScope =
  | { kind: "account" }
  | { kind: "gfa-objective"; objective: string }
  | { kind: "gfa-campaign"; campaignId: string }
  | { kind: "other" };

function detectPageScope(pathname: string): PageScope {
  if (/\/manage\/ad-accounts\/\d+\/(dashboard|all-campaigns)(\/|$|\?)/.test(pathname)) {
    return { kind: "account" };
  }
  let m = pathname.match(/\/manage\/ad-accounts\/\d+\/da\/dashboard\/campaign\/(\d+)/);
  if (m) return { kind: "gfa-campaign", campaignId: m[1] };
  m = pathname.match(/\/manage\/ad-accounts\/\d+\/da\/campaigns-by\/([A-Z_]+)/);
  if (m) return { kind: "gfa-objective", objective: m[1] };
  return { kind: "other" };
}

function accountNoFromPath(pathname: string): string | null {
  const m = pathname.match(/\/manage\/ad-accounts\/(\d+)/);
  return m ? m[1] : null;
}

// 페이지 스코프 필터 — GFA 목적 페이지는 그 type만, 단일 캠페인 페이지는 그 캠페인만 합산.
interface DashboardScopeOpts {
  objectiveType?: string; // 예: "GFA_CONVERSION" — campaign.type 일치만
  campaignId?: string;    // 단일 캠페인만
}

async function fetchDashboardPurchaseMetrics(
  cap: PeriodCompareCapture | null,
  since: Date,
  until: Date,
  accountNo: string | null,
  platformFilter: "SA,DA" | "DA" = "SA,DA",
  scope: DashboardScopeOpts = {},
  customerId: string | null = null,
): Promise<NormalizedMetrics> {
  const empty: NormalizedMetrics = {
    impressions: 0, clicks: 0, ctr: null, cpc: null,
    cost: 0, revenue: 0, conversions: 0, roas: null,
  };
  if (!accountNo) return empty;
  // SA stats(`/apis/sa/api/stats`)는 x-ad-customer-id(masterCustomerId)가 없으면 silent-empty.
  // 캡처 헤더에 이미 있으면 그대로, 없으면 resolve된 customerId를 보강해 모든 하위 호출(campaigns/search,
  // SA stats)에 함께 싣는다. GFA campaignStats는 URL-aware라 이 헤더와 무관.
  const headers: Record<string, string> = { ...(cap?.headers ?? {}) };
  if (customerId && !customerIdFromHeaders(headers)) {
    headers["x-ad-customer-id"] = customerId;
  }
  // 페이지의 캡처 body(pageSize 10·필터 없음·다른 날짜)는 신뢰 못 하므로 항상 통제된 body로 재호출.
  const resp = await replayFetch(
    buildDashboardCampaignsRequest(accountNo, headers, since, until, platformFilter),
  ) as DashboardSearchResp;

  let impressions = 0;
  let clicks = 0;
  let costMicros = 0;
  const saIds: string[] = [];
  const daIds: string[] = [];
  for (const row of resp.results ?? []) {
    const c = row.campaign ?? {};
    // 페이지 스코프 필터 — 화면에 보이는 캠페인 범위와 일치시킨다.
    if (scope.campaignId && c.campaignId !== scope.campaignId) continue;
    if (scope.objectiveType && c.type !== scope.objectiveType) continue;
    const m = row.metrics ?? {};
    const imp = Number(m.impressions ?? 0);
    const clk = Number(m.clicks ?? 0);
    const cost = Number(m.grossCostMicros ?? 0);
    impressions += imp;
    clicks += clk;
    costMicros += cost;
    const id = c.campaignId;
    if (!id) continue;
    // 노출·클릭·비용이 모두 0이면 전환도 0 — 구매완료 2차 호출 대상에서 제외(호출 수↓ → 속도↑).
    if (imp <= 0 && clk <= 0 && cost <= 0) continue;
    if (c.adPlatform === "DA") daIds.push(id);
    else saIds.push(id);
  }

  const sinceStr = formatDateYMD(since, "-");
  const untilStr = formatDateYMD(until, "-");
  // 매출·전환수는 각 플랫폼 2차 호출로 구매완료만 합산 — multi-account-data.ts와 동일 방식.
  // GFA 전용 페이지(platformFilter=DA)는 SA 2차 호출 skip — SA 전환수가 합산되면 DA-only 수치가 오염됨.
  const [saResult, daResult] = await Promise.all([
    platformFilter === "DA"
      ? Promise.resolve({ conv: 0, revenueMicros: 0 })
      : sumSaPurchaseConversions(headers, saIds, sinceStr, untilStr),
    sumGfaPurchaseConversions(headers, accountNo, daIds, sinceStr, untilStr),
  ]);

  const cost = costMicros / 1_000_000;
  const revenue = saResult.revenueMicros / 1_000_000 + daResult.revenue;
  const conversions = saResult.conv + daResult.conv;
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const cpc = clicks > 0 ? cost / clicks : null;
  const roas = cost > 0 ? (revenue / cost) * 100 : null;
  return { impressions, clicks, ctr, cpc, cost, revenue, conversions, roas };
}

// SA 캠페인 구매완료 전환수 + 매출 — /apis/sa/api/stats purchaseCcnt + purchaseConvAmtMicros 합산.
async function sumSaPurchaseConversions(
  headers: Record<string, string>,
  ids: string[],
  since: string,
  until: string,
): Promise<{ conv: number; revenueMicros: number }> {
  if (ids.length === 0) return { conv: 0, revenueMicros: 0 };
  const url = `${location.origin}/apis/sa/api/stats`;
  const chunks: Promise<SaPurchaseStatsResp>[] = [];
  for (let i = 0; i < ids.length; i += SA_CONV_CHUNK) {
    const body = JSON.stringify({
      fields: ["purchaseCcnt", "purchaseConvAmtMicros"],
      timeIncrement: "allDays",
      timeRange: { since, until },
      ids: ids.slice(i, i + SA_CONV_CHUNK).join(","),
    });
    chunks.push(
      replayFetch({ url, method: "POST", headers, body })
        .then((r) => r as SaPurchaseStatsResp)
        .catch(() => ({}) as SaPurchaseStatsResp),
    );
  }
  let conv = 0;
  let revenueMicros = 0;
  for (const r of await Promise.all(chunks)) {
    for (const row of r.data ?? []) {
      conv += Number(row.purchaseCcnt ?? 0);
      revenueMicros += Number(row.purchaseConvAmtMicros ?? 0);
    }
  }
  return { conv, revenueMicros };
}

// GFA(DA) 캠페인 구매완료 전환수 + 매출 — gfa campaignStats purchaseConvCount + purchaseConvSalesKRW 합산.
// purchaseConvSalesKRW는 원 단위 (Micros 아님) — multi-account-data.ts와 동일.
async function sumGfaPurchaseConversions(
  headers: Record<string, string>,
  accountNo: string | null,
  ids: string[],
  since: string,
  until: string,
): Promise<{ conv: number; revenue: number }> {
  if (!accountNo || ids.length === 0) return { conv: 0, revenue: 0 };
  const chunks: Promise<GfaStatsResp>[] = [];
  for (let i = 0; i < ids.length; i += GFA_CONV_CHUNK) {
    const list = encodeURIComponent(ids.slice(i, i + GFA_CONV_CHUNK).join(","));
    const url =
      `${location.origin}/apis/gfa/v1/adAccounts/${accountNo}/stats/campaignStats` +
      `?campaignNoList=${list}&startDate=${since}&endDate=${until}`;
    chunks.push(
      replayFetch({ url, method: "GET", headers, body: null })
        .then((r) => r as GfaStatsResp)
        .catch(() => ({}) as GfaStatsResp),
    );
  }
  let conv = 0;
  let revenue = 0;
  for (const r of await Promise.all(chunks)) {
    for (const v of Object.values(r)) {
      conv += Number(v?.conversion?.purchaseConvCount ?? 0);
      revenue += Number(v?.conversion?.purchaseConvSalesKRW ?? 0);
    }
  }
  return { conv, revenue };
}

async function replayFetch(req: ShiftedRequest): Promise<unknown> {
  // 콘텐츠 스크립트는 페이지와 같은 origin(ads.naver.com)이라 쿠키 자동 첨부.
  // x-xsrf-token이 captured headers에 있으면 그대로 사용. 없으면 XSRF-TOKEN 쿠키에서 채움.
  // 헤더 키를 소문자로 정규화 — XHR 캡처는 setRequestHeader 원본 케이스 보존("Content-Type", "Accept" 등).
  // 그대로 fetch()에 넘기면 Headers.append가 같은 헤더를 두 번 추가해 중복 Content-Type 등이 생길 수 있음.
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k.toLowerCase()] = v;
  }
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
  ctr: number | null;
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
  state: "loading" | "ok" | "error";
  errorMessage?: string;
}

function renderPopover(root: HTMLElement, st: PopoverState): void {
  root.replaceChildren();

  const hdr = document.createElement("div");
  hdr.className = "dvads-popover-hdr";
  const title = document.createElement("div");
  title.className = "kw";
  title.textContent = "데이터 비교";
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

  // 기간 라벨 — 끝에 "(N일)" 일수 뱃지 추가해 비교 단위 명시
  const rangeLine = document.createElement("div");
  rangeLine.className = "dvads-period-range";
  const dayCount = daysBetweenInclusive(st.currentRange.start, st.currentRange.end);
  if (st.previousRange) {
    rangeLine.textContent = `${formatRangeLabel(st.previousRange.start, st.previousRange.end)}  →  ${formatRangeLabel(st.currentRange.start, st.currentRange.end)}`;
  } else {
    rangeLine.textContent = `${formatRangeLabel(st.currentRange.start, st.currentRange.end)}`;
  }
  const daysBadge = document.createElement("span");
  daysBadge.className = "dvads-period-days";
  daysBadge.textContent = ` (${dayCount}일)`;
  rangeLine.append(daysBadge);
  root.append(rangeLine);

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
  for (const label of ["지표", "이전 기간", "선택 기간", "증감"]) {
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
    { key: "ctr", label: "클릭률", fmt: "percent" },
    { key: "cpc", label: "CPC", fmt: "krw-int", invertColor: true },
    { key: "cost", label: "총비용", fmt: "krw-int", invertColor: true },
    { key: "revenue", label: "구매 매출", fmt: "krw-int" },
    { key: "conversions", label: "구매수", fmt: "int" },
    { key: "roas", label: "구매ROAS", fmt: "percent" },
  ];

  for (const { key, label, fmt, invertColor } of rows) {
    const tr = document.createElement("tr");
    const tdLabel = document.createElement("td");
    tdLabel.textContent = label;
    tr.append(tdLabel);

    if (st.state === "loading") {
      // shimmer 스켈레톤 — 셀당 1개 bar. 너비는 fmt별로 자연스럽게 다르게.
      const skelW: Record<MetricFmt, string> = {
        int: "44px",
        krw: "56px",
        "krw-int": "56px",
        percent: "44px",
      };
      tr.append(skelCell(skelW[fmt]));
      tr.append(skelCell(skelW[fmt]));
      tr.append(skelCell("48px"));
      tbody.append(tr);
      continue;
    }

    const prevVal = st.previous?.[key] ?? null;
    const curVal = st.current?.[key] ?? null;

    tr.append(cell(formatMetric(prevVal, fmt, st.state)));
    tr.append(cell(formatMetric(curVal, fmt, st.state)));
    tr.append(cell(formatDelta(prevVal, curVal, st.state, invertColor === true)));
    tbody.append(tr);
  }
  table.append(tbody);
  root.append(table);
}

function cell(html: { text: string; cls?: string }): HTMLElement {
  const td = document.createElement("td");
  td.textContent = html.text;
  if (html.cls) td.classList.add(html.cls);
  return td;
}

function skelCell(width: string): HTMLElement {
  const td = document.createElement("td");
  const bar = document.createElement("span");
  bar.className = "dvads-period-skel";
  bar.style.width = width;
  td.append(bar);
  return td;
}

function formatMetric(
  v: number | null,
  fmt: "int" | "krw" | "krw-int" | "percent",
  state: PopoverState["state"],
): { text: string } {
  if (state === "loading") return { text: "..." };
  // 빈 값(null)은 대시 대신 0으로 통일 — "0과 - 혼재" 노이즈 제거.
  const n = v ?? 0;
  if (fmt === "int") return { text: Math.round(n).toLocaleString() };
  if (fmt === "krw" || fmt === "krw-int") {
    return { text: `${Math.round(n).toLocaleString()}원` };
  }
  if (fmt === "percent") {
    return { text: `${n.toFixed(1)}%` };
  }
  return { text: String(n) };
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
  // null도 0으로 처리 — 값 셀과 증감 셀 모두 같은 컨벤션.
  const p = prev ?? 0;
  const c = cur ?? 0;
  if (p === 0) {
    if (c === 0) return { text: "0.0%" };
    // 이전 0 → 선택 N(>0): 증감률이 ∞라 계산 불가. 결측 표기와 통일해서 "-".
    return { text: "-" };
  }
  const pct = ((c - p) / Math.abs(p)) * 100;
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
      recentCaptures.length = 0;
      scheduleMount();
    }
  }).observe(document, { childList: true, subtree: true });

  scheduleMount();
}
