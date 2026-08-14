/**
 * F-AutoSetup — 진입 + 오케스트레이션.
 *
 * 현재 범위: 링크 입력 → 페이지 읽기 → AI 상품 이해 → **확인 게이트**까지.
 * 초안 생성(`draft.ts`)·검토 화면·실제 세팅은 아직이다. 확인 화면에서 거기까지만 안내한다.
 *
 * 확인 게이트를 먼저 만든 이유는 설계 §5.2 그대로다 — AI가 상품을 잘못 이해하면 그 뒤가
 * 통째로 틀린 채 초안이 나온다. 그 위에 초안·검토 화면을 다 쌓은 뒤에 발견하면 늦다.
 *
 * 다이얼로그 스타일은 `.dvads-input-*`(input-dialog)을 재사용한다 — 새 카드 스타일을 만들면
 * 같은 모양이 두 벌 생긴다. 이 기능 고유 부분만 `dvads-autosetup-*`.
 */

import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { showToast } from "@/shared/toast";
import {
  cancelPageRead,
  readProductPage,
  retryReadProductPage,
  type PageReadOutcome,
} from "./page-read";
import { understandProduct, warmUnderstand } from "./product-understand";
import type { ProductPageInfo, ProductUnderstanding } from "@/types/auto-setup";

export interface AutoSetupTarget {
  adAccountNo: number;
  masterCustomerId?: number;
  name: string;
}

let closeCurrent: (() => void) | null = null;

export function openAutoSetupFlow(target: AutoSetupTarget): void {
  closeCurrent?.();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-input-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-input-card dvads-autosetup-card";
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  // 사람 확인용으로 열어둔 탭이 있으면 닫고 나간다 — 안 그러면 남의 탭이 떠돈다.
  let pendingTabId: number | null = null;
  let busy = false;
  // 이 창이 닫혔는가. 읽는 중엔 사용자가 못 닫지만, **다른 계정에서 이 메뉴를 다시 누르면**
  // 앞 창이 강제로 닫힌다. 그때 앞 창의 요청이 뒤늦게 돌아와 사라진 화면에 그리는 걸 막는다.
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    if (pendingTabId != null) void cancelPageRead(pendingTabId);
    backdrop.remove();
    if (closeCurrent === teardown) closeCurrent = null;
  };
  const onKey = (e: KeyboardEvent) => {
    if (busy) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      teardown();
    }
  };
  wireBackdropDismiss(backdrop, teardown, () => busy);
  card.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", onKey);
  closeCurrent = teardown;

  // 확인 화면이 떠 있는 동안 서버를 데워둔다 — 첫 호출의 대기를 사용자 입력 시간에 흡수.
  warmUnderstand();
  renderLinkStep();

  // ── 화면 1. 링크 입력 ──
  function renderLinkStep(prefill = "") {
    const frag = document.createDocumentFragment();
    frag.appendChild(title("링크로 광고 만들기"));
    frag.appendChild(
      desc(`${target.name} 계정에 세팅합니다. 광고할 상품 페이지나 사이트 주소를 넣어 주세요.`),
    );

    const input = document.createElement("input");
    input.type = "text";
    input.className = "dvads-input-input dvads-autosetup-url";
    input.placeholder = "https://smartstore.naver.com/...";
    input.autocomplete = "off";
    input.value = prefill;
    frag.appendChild(input);

    const start = primary("읽어오기");
    const cancel = secondary("취소");
    frag.appendChild(actions(cancel, start));

    const go = () => {
      const url = input.value.trim();
      if (!url) return;
      void runRead(url);
    };
    start.addEventListener("click", go);
    cancel.addEventListener("click", teardown);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.stopPropagation();
        go();
      }
    });

    card.replaceChildren(frag);
    setTimeout(() => input.focus(), 0);
  }

  // ── 화면 2. 진행 중 ──
  function renderBusy(message: string) {
    busy = true;
    const frag = document.createDocumentFragment();
    frag.appendChild(title("링크로 광고 만들기"));
    const line = document.createElement("div");
    line.className = "dvads-autosetup-busy";
    line.textContent = message;
    frag.appendChild(line);
    card.replaceChildren(frag);
  }

  // ── 화면 3. 사람 확인 필요 ──
  function renderNeedsUser(message: string, tabId: number) {
    busy = false;
    pendingTabId = tabId;
    const frag = document.createDocumentFragment();
    frag.appendChild(title("확인이 필요해요"));
    frag.appendChild(desc(`${message} 방금 열린 창을 확인한 뒤 아래 버튼을 눌러 주세요.`));
    const again = primary("다시 시도");
    const cancel = secondary("그만두기");
    frag.appendChild(actions(cancel, again));
    again.addEventListener("click", () => void runRetry(tabId));
    cancel.addEventListener("click", teardown);
    card.replaceChildren(frag);
  }

  // ── 화면 4. 상품 이해 확인 게이트 ──
  function renderUnderstanding(page: ProductPageInfo, u: ProductUnderstanding) {
    busy = false;
    const frag = document.createDocumentFragment();
    frag.appendChild(title("이 상품이 맞나요?"));
    frag.appendChild(
      desc("읽어온 내용을 이렇게 이해했어요. 틀린 부분이 있으면 아래에 알려주세요."),
    );

    const list = document.createElement("dl");
    list.className = "dvads-autosetup-facts";
    const row = (label: string, value: string) => {
      if (!value) return;
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      list.append(dt, dd);
    };
    row("업종", u.business);
    row("판매 상품", u.product);
    row("가격대", u.priceRange ?? "");
    row("주요 고객", u.targets.join(", "));
    row("강점", u.strengths.join(", "));
    row("지역 기반", u.isLocal ? "매장 방문형" : "온라인 판매");
    row("검색할 키워드", u.seedKeywords.join(", "));
    frag.appendChild(list);

    // 읽기 경로를 보여준다 — 본문 텍스트로만 읽었으면 정확도가 낮으니 더 꼼꼼히 보라는 신호.
    if (page.source === "text" || page.source === "meta") {
      const warn = document.createElement("div");
      warn.className = "dvads-autosetup-warn";
      warn.textContent =
        "이 페이지에서는 상품 정보를 자세히 읽지 못해서 본문을 훑어 정리했어요. 내용을 한 번 더 확인해 주세요.";
      frag.appendChild(warn);
    }

    const fix = document.createElement("textarea");
    fix.className = "dvads-autosetup-fix";
    fix.rows = 2;
    fix.placeholder = "예) 남성용이 아니라 여성용이에요";
    frag.appendChild(fix);

    const again = secondary("다시 정리");
    const ok = primary("맞아요");
    const cancel = secondary("그만두기");
    frag.appendChild(actions(cancel, again, ok));

    again.addEventListener("click", () => {
      const correction = fix.value.trim();
      if (!correction) {
        showToast({ message: "무엇이 틀렸는지 한 줄만 적어 주세요", variant: "error" });
        return;
      }
      void runUnderstand(page, correction);
    });
    ok.addEventListener("click", () => renderNextComingSoon());
    cancel.addEventListener("click", teardown);

    card.replaceChildren(frag);
  }

  // ── 화면 5. 여기까지 (다음 단계 미구현) ──
  function renderNextComingSoon() {
    const frag = document.createDocumentFragment();
    frag.appendChild(title("여기까지 확인했어요"));
    frag.appendChild(
      desc(
        "다음은 이 상품에 맞는 키워드를 네이버에서 찾아 광고 초안을 만드는 단계인데, 아직 만드는 중이에요. 지금은 상품을 제대로 읽는지까지만 확인할 수 있어요.",
      ),
    );
    const close = primary("닫기");
    frag.appendChild(actions(close));
    close.addEventListener("click", teardown);
    card.replaceChildren(frag);
  }

  // ── 동작 ──
  async function runRead(url: string) {
    renderBusy("페이지를 읽고 있어요...");
    let outcome: PageReadOutcome;
    try {
      outcome = await readProductPage(url);
    } catch (e) {
      console.warn("[dv-ads/auto-setup] 페이지 읽기 실패", e);
      outcome = { status: "failed", message: "링크를 읽지 못했어요" };
    }
    handleRead(outcome, url);
  }

  async function runRetry(tabId: number) {
    renderBusy("다시 읽고 있어요...");
    const outcome = await retryReadProductPage(tabId);
    handleRead(outcome, "");
  }

  function handleRead(outcome: PageReadOutcome, url: string) {
    if (closed) {
      // 창이 닫힌 뒤 늦게 도착. 사람 확인용 탭이 열렸다면 여기서 닫아야 영영 안 남는다.
      if (outcome.status === "needsUser") void cancelPageRead(outcome.tabId);
      return;
    }
    if (outcome.status === "ok") {
      pendingTabId = null;
      void runUnderstand(outcome.info, "");
      return;
    }
    if (outcome.status === "needsUser") {
      renderNeedsUser(outcome.message, outcome.tabId);
      return;
    }
    pendingTabId = null;
    busy = false;
    showToast({ message: outcome.message, variant: "error" });
    renderLinkStep(url);
  }

  async function runUnderstand(page: ProductPageInfo, correction: string) {
    renderBusy(correction ? "다시 정리하고 있어요..." : "무엇을 파는 곳인지 보고 있어요...");
    try {
      const u = await understandProduct(page, correction);
      if (closed) return;
      renderUnderstanding(page, u);
    } catch (e) {
      if (closed) return;
      busy = false;
      const message = e instanceof Error ? e.message : "상품 정보를 정리하지 못했어요";
      showToast({ message, variant: "error" });
      renderLinkStep(page.url);
    }
  }
}

// ── 작은 조립 도구 — 사용자 문자열은 전부 textContent로만 넣는다 ──

function title(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "dvads-input-title";
  el.textContent = text;
  return el;
}

function desc(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "dvads-input-desc";
  el.textContent = text;
  return el;
}

function primary(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "dvads-btn dvads-btn-primary";
  b.textContent = label;
  return b;
}

function secondary(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "dvads-btn dvads-btn-secondary";
  b.textContent = label;
  return b;
}

function actions(...buttons: HTMLButtonElement[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "dvads-input-actions";
  const spacer = document.createElement("div");
  spacer.className = "dvads-input-actions-spacer";
  wrap.appendChild(spacer);
  for (const b of buttons) wrap.appendChild(b);
  return wrap;
}
