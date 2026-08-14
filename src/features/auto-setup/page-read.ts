/**
 * F-AutoSetup — [1단계] 링크 → 상품 정보 (콘텐츠 스크립트 쪽).
 *
 * 실제로 페이지를 여는 것은 background다(`AUTO_SETUP_READ_PAGE`). 여기서는 주소를 다듬고
 * 결과를 세 갈래로 정리한다 — 읽음 / 사람 확인 필요 / 실패.
 *
 * "사람 확인 필요"는 원인을 따지지 않는다. 캡챠·로그인·구조 변경을 구분하려 들면 그 코드가
 * 계속 깨진다. 탭을 앞으로 꺼내주면 사람이 3초면 판단한다(설계 §5.1).
 */

import type { ProductPageInfo } from "@/types/auto-setup";
import type {
  AutoSetupReadPageResponse,
  AutoSetupCloseTabResponse,
} from "@/types/messages";

export type PageReadOutcome =
  | { status: "ok"; info: ProductPageInfo }
  /** 열어둔 탭에서 사용자가 처리한 뒤 `retryReadProductPage(tabId)`로 이어간다. */
  | { status: "needsUser"; tabId: number; message: string }
  | { status: "failed"; message: string };

/** 사용자가 넣은 주소를 다듬는다. 프로토콜을 빼먹는 경우가 흔하다. */
export function normalizeLink(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProtocol);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export async function readProductPage(rawUrl: string): Promise<PageReadOutcome> {
  const url = normalizeLink(rawUrl);
  if (!url) return { status: "failed", message: "주소 형식이 올바르지 않아요" };
  return send({ type: "AUTO_SETUP_READ_PAGE", url });
}

export async function retryReadProductPage(tabId: number): Promise<PageReadOutcome> {
  return send({ type: "AUTO_SETUP_RETRY_READ", tabId });
}

/** 사용자가 그만두면 열어둔 탭을 닫는다. 실패해도 조용히 넘어간다 — 정리 작업일 뿐이다. */
export async function cancelPageRead(tabId: number): Promise<void> {
  try {
    await chrome.runtime.sendMessage<unknown, AutoSetupCloseTabResponse>({
      type: "AUTO_SETUP_CLOSE_TAB",
      tabId,
    });
  } catch {
    /* 탭이 이미 닫혔거나 background가 잠들었다 — 어느 쪽이든 할 일 없음 */
  }
}

async function send(message: unknown): Promise<PageReadOutcome> {
  let resp: AutoSetupReadPageResponse | undefined;
  try {
    resp = await chrome.runtime.sendMessage<unknown, AutoSetupReadPageResponse>(message);
  } catch (e) {
    console.warn("[dv-ads/auto-setup] 페이지 읽기 요청 실패", e);
    return { status: "failed", message: "링크를 읽지 못했어요. 잠시 후 다시 시도해 주세요" };
  }
  if (resp?.ok && resp.info) return { status: "ok", info: resp.info };
  if (resp?.needsUser && resp.tabId != null) {
    return {
      status: "needsUser",
      tabId: resp.tabId,
      message: resp.error ?? "이 페이지는 확인이 필요해요",
    };
  }
  return { status: "failed", message: resp?.error ?? "링크에서 상품 정보를 찾지 못했어요" };
}
