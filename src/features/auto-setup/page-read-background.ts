/**
 * F-AutoSetup — 링크 읽기의 background 쪽 처리기. **현재 어디서도 import하지 않는다(보류).**
 *
 * 기능이 보류라 `background/index.ts`에서 떼어냈다 — 부르는 데가 없는데 임의 탭을 여는 처리기를
 * 배포본에 남길 이유가 없다. import되지 않으므로 번들에도 안 들어간다.
 *
 * **재개 방법**: `background/index.ts`에서
 *   `import { handleAutoSetupMessage } from "@/features/auto-setup/page-read-background";`
 * 후 메시지 라우터 맨 앞에 한 줄:
 *   `if (handleAutoSetupMessage(msg, sendResponse)) return true;`
 * `manifest.config.ts`의 `<all_urls>`도 같이 되살려야 한다 — 없으면 추출 주입이 조용히 실패한다.
 *
 * `waitForTabComplete`/`sleep`은 background/index.ts에도 같은 게 있지만 여기 따로 뒀다.
 * 잠자는 모듈 하나 때문에 돌아가는 배경 스크립트의 구조를 건드리지 않기 위해서다.
 */

import { extractPageInfo } from "./page-extract";
import type { AutoSetupReadPageResponse } from "@/types/messages";

/**
 * 라우터에서 한 줄로 쓰기 위한 진입점. 처리했으면 true(= 비동기 응답 예정).
 */
export function handleAutoSetupMessage(
  msg: { type?: string; url?: string; tabId?: number } | undefined,
  sendResponse: (r: unknown) => void,
): boolean {
  if (msg?.type === "AUTO_SETUP_READ_PAGE" && typeof msg.url === "string") {
    readPage(msg.url)
      .then(sendResponse)
      .catch((e) => {
        console.warn("[bg/auto-setup] 읽기 실패", e);
        sendResponse({ ok: false, error: "링크를 읽지 못했어요. 잠시 후 다시 시도해 주세요" });
      });
    return true;
  }
  if (msg?.type === "AUTO_SETUP_RETRY_READ" && typeof msg.tabId === "number") {
    retryRead(msg.tabId)
      .then(sendResponse)
      .catch((e) => {
        console.warn("[bg/auto-setup] 재시도 실패", e);
        sendResponse({ ok: false, error: "링크를 읽지 못했어요. 잠시 후 다시 시도해 주세요" });
      });
    return true;
  }
  if (msg?.type === "AUTO_SETUP_CLOSE_TAB" && typeof msg.tabId === "number") {
    chrome.tabs
      .remove(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
}

// 네이버는 background 직접 fetch를 490으로 막지만 탭으로 여는 것(navigation)은 별개 경로라
// 막지 않는다(형제 프로젝트 실측). 대상이 임의 사이트라 붙박이 콘텐츠 스크립트를 쓸 수 없어
// executeScript로 추출 함수를 그때그때 주입한다.

async function readPage(url: string): Promise<AutoSetupReadPageResponse> {
  let tab: chrome.tabs.Tab | null = null;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    console.warn("[bg/auto-setup] tabs.create 실패", e);
    return { ok: false, error: "링크를 열지 못했어요. 주소가 맞는지 확인해 주세요" };
  }
  const tabId = tab.id;
  if (!tabId) return { ok: false, error: "링크를 열지 못했어요" };

  await waitForTabComplete(tabId, 20000);
  // SPA는 로드 완료 후에 본문을 그린다. 짧은 여유.
  await sleep(1200);

  const info = await runExtract(tabId);
  if (info) {
    await chrome.tabs.remove(tabId).catch(() => {});
    return { ok: true, info };
  }

  // 캡챠인지 로그인인지 구조 변경인지 **판별하지 않는다** — 그 코드는 계속 깨진다.
  // 탭을 앞으로 꺼내 사람이 보게 한다. 3초면 안다.
  if (!(await bringToFront(tabId))) {
    // 탭이 이미 사라졌다면 재시도할 대상이 없다 — needsUser로 돌려보내면 호출부가 죽은
    // 탭 번호로 무한히 재시도하게 된다.
    return { ok: false, error: "링크에서 상품 정보를 찾지 못했어요" };
  }
  return {
    ok: false,
    needsUser: true,
    tabId,
    error: "이 페이지는 확인이 필요해요. 열린 창에서 처리한 뒤 다시 시도해 주세요",
  };
}

async function retryRead(tabId: number): Promise<AutoSetupReadPageResponse> {
  // 사용자가 확인 창을 닫았을 수 있다. 없는 탭에 계속 재시도시키지 않는다.
  if (!(await tabExists(tabId))) {
    return { ok: false, error: "확인 창이 닫혔어요. 링크를 다시 넣어 주세요" };
  }
  const info = await runExtract(tabId);
  if (!info) {
    return {
      ok: false,
      needsUser: true,
      tabId,
      error: "아직 상품 정보를 못 찾았어요. 상품 페이지가 보이는 상태인지 확인해 주세요",
    };
  }
  await chrome.tabs.remove(tabId).catch(() => {});
  return { ok: true, info };
}

/** MAIN world — `__PRELOADED_STATE__`는 페이지 컨텍스트에만 있다. */
async function runExtract(tabId: number) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: extractPageInfo,
    });
    return result?.result ?? null;
  } catch (e) {
    console.warn("[bg/auto-setup] 추출 주입 실패", e);
    return null;
  }
}

/** 탭이 살아 있어 앞으로 꺼냈으면 true. 탭이 이미 없으면 false. */
async function bringToFront(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch (e) {
    console.warn("[bg/auto-setup] 탭을 앞으로 꺼내지 못함", e);
    return false;
  }
}

async function tabExists(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
