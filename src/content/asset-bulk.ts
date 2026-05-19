/**
 * F-AssetBulk — 파워링크 확장소재 일괄 등록 진입점.
 *
 * 활성 페이지: ads.naver.com `/sa/adgroups/*` (키워드/제외검색어/소재/확장소재
 * 4개 탭이 같은 URL 공유). "+ 새 확장 소재 ▾" 드롭다운이 DOM에 등장하면 우리가
 * 마지막에 "일괄 등록" li를 주입하고, 클릭 시 native DOM 팝업을 띄워 3종
 * (파워링크 이미지·추가제목·추가설명)을 한 번에 받아 페이지 UI를 자동화한다.
 *
 * 드롭다운 메뉴는 rc-menu 라이브러리가 portal로 떠다니게 그리므로 항상 신선한
 * li가 mount된다. 중복 주입 방지는 li에 `data-dvads-bulk="1"` 마크로 처리.
 */

import {
  openAssetBulkPopup,
  type AssetBulkInput,
  type ImageSlotInput,
} from "@/content/asset-bulk-popup";
import {
  closeOpenMenu,
  describeAssetFailure,
  registerAssetItem,
  scanExistingAssets,
  type AssetItemSource,
  type AssetResult,
} from "@/content/dom-asset";
import { showToast } from "@/content/toast";

const MENU_ITEM_SELECTOR = "li.ad-cms-dropdown-menu-item";
const MENU_ITEM_LABEL_SELECTOR = "span.ad-cms-dropdown-menu-title-content";
const PAGE_PATTERN = /\/sa\/adgroups\//;
const BULK_MARK = "data-dvads-bulk";
const BULK_LABEL = "일괄 등록";

/**
 * F-AssetBulk 초기화. content/index.ts에서 한 번 호출. SPA 라우팅·드롭다운 재mount에도
 * 살아남도록 MutationObserver를 모듈 lifetime 동안 유지.
 */
export function initAssetBulk(): void {
  new MutationObserver(scheduleScan).observe(document.body, {
    childList: true,
    subtree: true,
  });
  scheduleScan();
}

let scanRaf: number | null = null;
function scheduleScan(): void {
  if (scanRaf !== null) return;
  scanRaf = requestAnimationFrame(() => {
    scanRaf = null;
    scan();
  });
}

function scan(): void {
  if (!PAGE_PATTERN.test(location.pathname)) return;

  // 떠있는 모든 메뉴를 훑되, "+ 새 확장 소재" 메뉴인지 라벨 기반으로 확인.
  // 메뉴 컨테이너는 rc-menu portal로 body에 떠다님 — li의 공통 부모로 식별.
  const seenContainers = new Set<HTMLElement>();
  for (const li of document.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)) {
    const container = li.parentElement;
    if (!container) continue;
    if (seenContainers.has(container)) continue;
    seenContainers.add(container);
    if (!isExtensionMenu(container)) continue;
    ensureBulkItem(container);
  }
}

/**
 * 메뉴 컨테이너가 "+ 새 확장 소재" 메뉴인지 식별. 정찰 데이터로 확인된 항목
 * (추가제목/추가설명/파워링크 이미지) 중 하나 이상이 들어있으면 우리 메뉴로 본다.
 */
function isExtensionMenu(container: HTMLElement): boolean {
  const labels = Array.from(
    container.querySelectorAll<HTMLElement>(MENU_ITEM_LABEL_SELECTOR),
  ).map((el) => (el.textContent ?? "").trim());
  // 정찰에서 확인한 13개 항목 중 핵심 식별자. 한 가지라도 들어 있으면 우리 메뉴.
  const SIGNATURE = ["추가제목", "추가설명", "파워링크 이미지", "쇼핑정보", "서브링크"];
  return SIGNATURE.some((s) => labels.includes(s));
}

function ensureBulkItem(container: HTMLElement): void {
  // 이미 우리 항목이 들어 있으면 skip
  if (container.querySelector(`li[${BULK_MARK}="1"]`)) return;

  const sample = container.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
  if (!sample) return;

  // 페이지 li 클래스를 그대로 복사해 시각 통일. only-child 클래스는 단일 항목 그룹
  // 표시라 제거하고 일반 menu-item 클래스만 유지 — 우리 항목이 위에서 분리되어 보이도록.
  const li = document.createElement("li");
  li.className = "ad-cms-dropdown-menu-item dvads-asset-bulk-menu-item";
  li.setAttribute("role", "menuitem");
  li.setAttribute("tabindex", "-1");
  li.setAttribute(BULK_MARK, "1");

  const label = document.createElement("span");
  label.className = "ad-cms-dropdown-menu-title-content";
  label.textContent = BULK_LABEL;
  li.appendChild(label);

  li.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // 페이지 드롭다운은 자체 click 리스너로 자동 닫힘. 우리 팝업은 setTimeout으로
    // 다음 tick에 열어 메뉴 unmount와 race하지 않게 한다.
    setTimeout(() => openBulkPopup(), 0);
  });

  container.appendChild(li);
}

function openBulkPopup(): void {
  // popup 열기 직전에 페이지 등록 목록 스캔 — 슬롯에 실시간 중복 경고 표시용.
  // 페이지 테이블이 가상화·페이지네이션을 쓸 수 있어 1페이지 분만 잡힐 수 있다는
  // 한계는 있지만 같은 광고그룹 한 페이지 안에서는 충분히 유효한 사전 안내.
  const existing = scanExistingAssets();
  openAssetBulkPopup({
    onSubmit: async (data) => {
      await runBulkRegistration(data, existing);
    },
    existingHeadlines: existing.headlines,
    existingDescriptions: existing.descriptions,
  });
}

// ─── 자동화 실행 ───

async function runBulkRegistration(
  data: AssetBulkInput,
  existing: { headlines: Set<string>; descriptions: Set<string> },
): Promise<void> {
  // 입력을 작업 큐로 평탄화. 빈 슬롯은 skip — orchestrator 차원에서.
  // 이미지는 모든 파일을 한 큐 항목에 합쳐 한 모달에서 multiple upload 한 번에 처리.
  const items: AssetItemSource[] = [];
  let skippedDuplicates = 0;

  const imageFiles = await resolveImageFiles(data.images);
  if (imageFiles.files.length > 0) {
    items.push({ kind: "image", files: imageFiles.files });
  }

  for (const h of data.headlines) {
    const t = h.text.trim();
    if (!t) continue;
    if (existing.headlines.has(t)) {
      skippedDuplicates += 1;
      continue;
    }
    items.push({ kind: "headline", text: t, position: h.position });
  }
  for (const d of data.descriptions) {
    const t = d.trim();
    if (!t) continue;
    if (existing.descriptions.has(t)) {
      skippedDuplicates += 1;
      continue;
    }
    items.push({ kind: "description", text: t });
  }

  if (items.length === 0 && imageFiles.failedUrls.length === 0) {
    showToast({
      message:
        skippedDuplicates > 0
          ? `등록할 항목이 없습니다 (중복 ${skippedDuplicates}건은 자동 skip)`
          : "입력된 항목이 없어 등록을 건너뛰었습니다",
      variant: "error",
    });
    return;
  }

  const headlineCount = data.headlines.filter(
    (h) => h.text.trim().length > 0 && !existing.headlines.has(h.text.trim()),
  ).length;
  const descriptionCount = data.descriptions.filter(
    (d) => d.trim().length > 0 && !existing.descriptions.has(d.trim()),
  ).length;
  const dupSuffix = skippedDuplicates > 0 ? `, 중복 ${skippedDuplicates}건 skip` : "";
  showToast({
    message: `일괄 등록 시작 (이미지 ${imageFiles.files.length > 0 ? "1세트" : "0"}, 추가제목 ${headlineCount}건, 추가설명 ${descriptionCount}건${dupSuffix})`,
    variant: "success",
    ttlMs: 2500,
  });

  const results: AssetResult[] = [];
  // 이미지 URL fetch에서 실패한 항목을 미리 결과에 추가 (사용자 결과 토스트에 표시).
  for (const failed of imageFiles.failedUrls) {
    results.push({
      kind: "image",
      ok: false,
      label: `이미지 URL ${failed.url}`,
      reason: "unknown",
    });
    console.warn(
      "[dv-ads/asset-bulk] image url fetch failed:",
      failed.url,
      failed.error,
    );
  }

  for (const item of items) {
    const r = await registerAssetItem(item);
    results.push(r);
    // 자동화 1건당 보통 1초 안팎. 페이지가 다음 모달 mount하는 동안 짧은 여백.
    await sleep(120);
  }

  // 페이지 측 비동기 동작(모달 unmount 애니메이션 → 트리거 focus 등)이 끝난 후
  // 메뉴가 다시 열리는 race가 있어 마지막에 명시적으로 닫는다. registerAssetItem의 finally는
  // 사이클 사이용이라 페이지 비동기가 그 후에 메뉴를 열어버리면 못 잡음.
  await sleep(300);
  await closeOpenMenu();

  // 결과 토스트 — 성공/실패 카운트와 실패 사유. variant는 실패 1건이라도 있으면 error.
  const successCount = results.filter((r) => r.ok).length;
  const failCount = results.length - successCount;
  if (failCount === 0) {
    showToast({
      message: `일괄 등록 완료 (${successCount}건 성공)`,
      variant: "success",
      ttlMs: 4000,
    });
    return;
  }

  // 실패한 것들 모아 첫 2건만 사유 표기 — 너무 길면 토스트 줄바꿈 망가짐.
  const failures = results.filter((r) => !r.ok);
  const sampleMsg = failures
    .slice(0, 2)
    .map((f) => `${f.label}: ${describeAssetFailure(f.reason)}`)
    .join(" / ");
  const more = failures.length > 2 ? ` 외 ${failures.length - 2}건` : "";
  showToast({
    message: `일괄 등록 부분 실패 — 성공 ${successCount}, 실패 ${failCount}. ${sampleMsg}${more}`,
    variant: "error",
    ttlMs: 8000,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 이미지 URL → File ───

interface ResolvedImages {
  files: File[];
  failedUrls: Array<{ url: string; error: string }>;
}

async function resolveImageFiles(slots: ImageSlotInput[]): Promise<ResolvedImages> {
  const files: File[] = [];
  const failedUrls: Array<{ url: string; error: string }> = [];

  for (const slot of slots) {
    if (slot.mode === "file" && slot.file) {
      files.push(slot.file);
      continue;
    }
    if (slot.mode === "url" && slot.url) {
      try {
        const file = await fetchUrlAsFile(slot.url);
        files.push(file);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failedUrls.push({ url: slot.url, error: msg });
      }
    }
  }

  return { files, failedUrls };
}

/**
 * 이미지 URL을 content script 컨텍스트에서 fetch해 File로 변환. content는 ads.naver.com
 * origin이라 외부 호스트의 CORS 정책이 응답 헤더에 없으면 실패 — 그 경우 사용자에게
 * 결과 토스트로 노출하고 사용자가 직접 파일로 첨부하도록 안내한다 (V1 정책).
 * V2에서 background fetch fallback 검토.
 */
async function fetchUrlAsFile(url: string): Promise<File> {
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  const name = guessFileName(url, blob.type);
  return new File([blob], name, { type: blob.type || "image/jpeg" });
}

function guessFileName(url: string, mime: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    if (last && /\.[a-z0-9]+$/i.test(last)) return last;
    const ext = mimeToExt(mime);
    return last ? `${last}.${ext}` : `image.${ext}`;
  } catch {
    return `image.${mimeToExt(mime)}`;
  }
}

function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("bmp")) return "bmp";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  return "jpg";
}
