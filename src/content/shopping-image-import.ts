/**
 * F-ShoppingImage — 쇼핑검색 소재 수정 모달에 "상세페이지 대표 이미지 불러오기" 주입.
 *
 * 활성 화면: ads.naver.com 쇼핑검색 광고그룹의 소재 상세보기(수정) 모달
 *   (`div.AdShoppingEditModal`, 헤더 "소재 수정하기"). 우측 네이티브 이미지 업로드칸
 *   (`.ImageLibraryUploadNew` 안의 `input[type=file]`) 하단에 우리 후보 그리드를 in-place 주입.
 *
 * 동작:
 *   1. 모달이 mount되면 그 소재의 상품 링크(referenceData.mallProductUrl)를 자동 해석.
 *      - URL에서 adAccountNo/adgroupId 파싱 → masterCustomerId 조회(ad-account v2)
 *      - `/apis/sa/api/ncc/ads`로 광고그룹 소재 목록을 받아 모달의 소재 이미지(ad.imagePath)와
 *        매칭해 현재 소재의 mallProductUrl 확보
 *   2. mallProductUrl을 background hidden tab으로 열어 갤러리 이미지를 스크레이프
 *      (F-AssetBulk의 product-page-extract 재사용 — 파워링크와 동일 메커니즘).
 *   3. 후보를 그리드로 렌더. 클릭하면 그 이미지를 background로 binary fetch → File로 만들어
 *      네이티브 file input에 주입(DataTransfer + input/change) → 페이지가 "노출용 이미지"로 처리.
 *
 * 페이지 자체 동작에는 손대지 않음 — 우리 strip만 추가하고, 사용자가 직접 [저장]을 누른다.
 * 모든 internal API 호출은 콘텐츠 스크립트 컨텍스트(background는 CORS로 차단).
 */

import { authFetch } from "@/lib/multi-account-data";
import { fetchUrlAsFile } from "@/lib/image-file";
import {
  resolveAndExtract,
  clearProductPageCache,
} from "@/lib/product-page-extract";

// ─── 셀렉터 (ads.naver.com 쇼핑 소재 수정 모달) ───
// 클래스가 갈리면 이 상수들만 고치면 됨. 출처: 2026-06-17 사용자 정찰 (모달 DOM 덤프).
const MODAL_SELECTOR = ".AdShoppingEditModal";
const UPLOAD_BOX_SELECTOR = ".ImageLibraryUploadNew";
// 상세보기(상품 정보)와 수정 팝업이 같은 AdShoppingEditModal DOM을 공유 — 제목으로 구분.
// "수정" 버튼을 눌러 뜨는 편집 팝업의 헤더 텍스트. 상세보기 헤더는 "상품 정보"라 제외됨.
const EDIT_MODAL_TITLE = "소재 수정하기";
// 제목 탐색 범위 — AdShoppingEditModal을 감싸는 모달 컨테이너 (제목은 그 바깥 sibling에 있음).
const MODAL_CONTAINER_SELECTOR = ".ad-cms-modal-container";
const FILE_INPUT_SELECTOR = 'input[type="file"]';
// 좌측 "소재 이미지" 미리보기 — background-image로 현재 소재 이미지(ad.imagePath) 표시.
const PREVIEW_IMAGE_SELECTOR = ".preview-image";
// 우리가 주입한 strip — 중복 주입 가드 + React 재렌더로 제거됐는지 판정에 사용.
const STRIP_SELECTOR = ".dvads-shopping-img";

// 소재 수정은 소재 detail URL(`/sa/ads/{nccAdId}`)에서 열림 — 소재 ID가 URL에 있어 단건 조회로 해석.
const ADS_URL_PATTERN = /\/ad-accounts\/(\d+)\/sa\/ads\/([^/?#]+)/;
// 폴백 — 광고그룹 URL(`/sa/adgroups/{id}`)에서 열리는 경우 소재 목록 + 이미지 매칭.
const ADGROUPS_URL_PATTERN = /\/ad-accounts\/(\d+)\/sa\/adgroups\/([^/?#]+)/;
// 쇼핑 소재 수정 모달은 소재 detail(`/sa/ads/...`) 또는 광고그룹 상세(`/sa/adgroups/...`)
// 에서만 열림 — 그 외 페이지에선 scan을 조기 종료해 헛도는 DOM 조회를 막는다.
const PAGE_PATTERN = /\/sa\/(ads|adgroups)\//;

interface RawShoppingAd {
  type?: string;
  ad?: { imagePath?: string };
  referenceData?: {
    mallProductUrl?: string;
    mallProdMblUrl?: string;
    productTitle?: string;
  };
}

// masterCustomerId 계정당 1회 캐시 (모달 재오픈 시 중복 조회 방지).
const customerIdCache = new Map<string, number | null>();

// 모달별 해석된 후보 URL 캐시. React 재렌더로 strip이 제거돼 재주입할 때 네트워크
// 재조회 없이 즉시 그리드를 복원하기 위함 (같은 모달 element 기준).
const candidatesCache = new WeakMap<HTMLElement, string[]>();

export function initShoppingImageImport(): void {
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      scan();
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scan();
}

function scan(): void {
  if (!PAGE_PATTERN.test(location.pathname)) return;
  const modals = document.querySelectorAll<HTMLElement>(MODAL_SELECTOR);
  for (const modal of Array.from(modals)) {
    // strip이 이미 들어 있으면 skip. (strip을 동기로 먼저 append하므로 다음 scan의 중복 가드
    // 역할도 함. React 재렌더로 strip이 제거되면 여기서 다시 잡혀 재주입된다.)
    if (modal.querySelector(STRIP_SELECTOR)) continue;
    // "수정" 팝업에서만 동작 — 상세보기(상품 정보) 화면은 제외. 둘이 같은 DOM 클래스를
    // 공유하므로 모달 제목이 "소재 수정하기"일 때만 주입.
    if (!isEditModal(modal)) continue;
    // "이미지" 섹션이 아직 mount되지 않았으면 다음 mutation에서 재시도.
    // 업로드칸(.ImageLibraryUploadNew)이 아니라 "이미지" 라벨 행 기준 — 노출용 이미지가
    // 이미 등록된 상태(업로드칸 대신 미리보기+× 표시)에서도 앵커가 잡히게.
    const anchor = findImageAnchor(modal);
    if (!anchor) continue;
    inject(modal, anchor);
  }
}

/** 현재 모달이 "수정" 편집 팝업인지 — 상세보기(상품 정보)와 구분. 제목 텍스트로 판정. */
function isEditModal(modal: HTMLElement): boolean {
  const container = modal.closest<HTMLElement>(MODAL_CONTAINER_SELECTOR) ?? modal;
  return (container.textContent ?? "").includes(EDIT_MODAL_TITLE);
}

interface ImageAnchor {
  /** "이미지" 섹션 콘텐츠 col — strip을 이 안에 넣는다. */
  contentCol: HTMLElement;
  /** 이미지(소재|노출용) 행 — strip을 이 바로 뒤(가이드 텍스트 위)에 둔다. 없으면 col 끝에. */
  afterRow: HTMLElement | null;
}

/**
 * "이미지" 섹션 앵커 찾기 — 라벨 col 텍스트가 "이미지"인 행 기준.
 * 업로드칸 유무와 무관하므로 노출용 이미지가 이미 등록된 상태에서도 동작.
 */
function findImageAnchor(modal: HTMLElement): ImageAnchor | null {
  for (const row of Array.from(modal.querySelectorAll<HTMLElement>(".ad-cms-row"))) {
    const labelCol = row.querySelector<HTMLElement>(":scope > .ad-cms-col");
    if (!labelCol) continue;
    if ((labelCol.textContent ?? "").trim() !== "이미지") continue;
    const cols = Array.from(row.querySelectorAll<HTMLElement>(":scope > .ad-cms-col"));
    const contentCol =
      cols.find((c) => c !== labelCol && c.classList.contains("ad-cms-col-sm-20")) ??
      cols.find((c) => c !== labelCol) ??
      null;
    if (!contentCol) continue;
    const afterRow = contentCol.querySelector<HTMLElement>(":scope > .ad-cms-row");
    return { contentCol, afterRow };
  }
  return null;
}

function inject(modal: HTMLElement, anchor: ImageAnchor): void {
  const strip = document.createElement("div");
  strip.className = "dvads dvads-shopping-img";

  const head = document.createElement("div");
  head.className = "dvads-shopping-img-head";
  head.textContent = "상세페이지 대표 이미지";
  strip.appendChild(head);

  // 에러만 노출 — 로딩/성공 안내 문구는 두지 않음(클릭하면 업로드칸 이미지가 바로 바뀌므로).
  const error = document.createElement("div");
  error.className = "dvads-shopping-img-status dvads-shopping-img-status-error";
  error.hidden = true;
  strip.appendChild(error);

  // 초기 후보 로딩 스피너 — 상품 페이지 스크레이프 동안 표시(보통 1-3초).
  const spinner = document.createElement("div");
  spinner.className = "dvads-shopping-img-spinner";
  spinner.hidden = true;
  strip.appendChild(spinner);

  const grid = document.createElement("div");
  grid.className = "dvads-shopping-img-grid";
  grid.hidden = true;
  strip.appendChild(grid);

  placeStrip(strip, anchor);

  const setError = (msg: string): void => {
    error.textContent = msg;
    error.hidden = !msg;
  };

  const showCandidates = (urls: string[]): void => {
    spinner.hidden = true;
    if (urls.length === 0) {
      setError("이 상품에서 대표 이미지를 찾지 못했어요.");
      return;
    }
    setError("");
    renderGrid(grid, urls, modal, setError);
    grid.hidden = false;
  };

  // 같은 모달의 재주입(React 재렌더로 strip 제거 후)이면 캐시된 후보로 즉시 복원 — 재조회·스피너 X.
  const cached = candidatesCache.get(modal);
  if (cached) {
    showCandidates(cached);
    return;
  }

  // 새 모달 사이클 — 이전 상품 페이지 추출 캐시 폐기 후 해석.
  clearProductPageCache();
  spinner.hidden = false;
  void resolveCandidates(modal)
    .then((urls) => {
      candidatesCache.set(modal, urls);
      if (!modal.isConnected) return;
      showCandidates(urls);
    })
    .catch((e) => {
      spinner.hidden = true;
      if (!modal.isConnected) return;
      const msg = e instanceof Error && e.message ? e.message : "대표 이미지를 불러오지 못했어요";
      setError(msg);
    });
}

/** strip을 "이미지" 섹션 콘텐츠 col 안, 이미지 행 바로 아래에 배치. */
function placeStrip(strip: HTMLElement, anchor: ImageAnchor): void {
  if (anchor.afterRow && anchor.afterRow.parentElement === anchor.contentCol) {
    anchor.afterRow.after(strip);
  } else {
    anchor.contentCol.appendChild(strip);
  }
}

// ─── 후보 해석 (mallProductUrl → 갤러리) ───

async function resolveCandidates(modal: HTMLElement): Promise<string[]> {
  const mallProductUrl = await resolveMallProductUrl(modal);
  if (!mallProductUrl) {
    throw new Error("이 소재의 상품 링크를 찾지 못했어요.");
  }
  const result = await resolveAndExtract(mallProductUrl);
  return result.candidates;
}

/**
 * 현재 모달이 편집 중인 소재의 mallProductUrl 확보.
 *   1순위: 소재 detail URL(`/sa/ads/{nccAdId}`) — URL의 소재 ID로 단건 조회(매칭 불필요).
 *   폴백:  광고그룹 URL(`/sa/adgroups/{id}`) — 소재 목록 + 모달 소재 이미지 매칭.
 */
async function resolveMallProductUrl(modal: HTMLElement): Promise<string | null> {
  const path = location.pathname;

  // 1순위 — 소재 ID가 URL에 있으니 단건 조회로 바로 referenceData.mallProductUrl 확보.
  const adsM = ADS_URL_PATTERN.exec(path);
  if (adsM) {
    const adAccountNo = adsM[1];
    const nccAdId = adsM[2];
    const customerId = await resolveCustomerId(adAccountNo);
    let ad: RawShoppingAd;
    try {
      ad = await authFetch<RawShoppingAd>(
        `/apis/sa/api/ncc/ads/${encodeURIComponent(nccAdId)}`,
        undefined,
        customerId ?? undefined,
      );
    } catch (e) {
      console.warn("[dv-ads/shopping-img] ncc/ads 단건 조회 실패", e);
      throw new Error("상품 정보를 불러오지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요");
    }
    return urlOf(ad) || null;
  }

  // 폴백 — 광고그룹 URL이면 소재 목록 + 이미지 매칭.
  const grpM = ADGROUPS_URL_PATTERN.exec(path);
  if (!grpM) {
    console.warn("[dv-ads/shopping-img] 지원하지 않는 URL이라 소재 정보를 조회할 수 없음:", path);
    return null;
  }
  const adAccountNo = grpM[1];
  const adgroupId = grpM[2];

  const customerId = await resolveCustomerId(adAccountNo);
  let ads: RawShoppingAd[];
  try {
    ads = await authFetch<RawShoppingAd[]>(
      `/apis/sa/api/ncc/ads?nccAdgroupId=${encodeURIComponent(adgroupId)}&recordSize=1001`,
      undefined,
      customerId ?? undefined,
    );
  } catch (e) {
    console.warn("[dv-ads/shopping-img] ncc/ads 조회 실패", e);
    throw new Error("상품 정보를 불러오지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요");
  }
  const raw = Array.isArray(ads) ? ads : [];
  const shoppingTyped = raw.filter((a) => a?.type === "SHOPPING_PRODUCT_AD");
  const shoppingAds = shoppingTyped.filter((a) => a.referenceData?.mallProductUrl);
  if (shoppingAds.length === 0) return null;

  // 소재가 1개뿐이면 매칭 불필요.
  if (shoppingAds.length === 1) {
    return urlOf(shoppingAds[0]);
  }

  // 모달의 소재 이미지로 어느 소재인지 매칭.
  const modalKey = imageKey(readPreviewImageUrl(modal));
  if (modalKey) {
    const matched = shoppingAds.find(
      (a) => imageKey(a.ad?.imagePath ?? "") === modalKey,
    );
    if (matched) return urlOf(matched);
    console.warn(
      "[dv-ads/shopping-img] 소재 이미지 매칭 실패 — modalKey:",
      modalKey,
      "imagePaths:",
      shoppingAds.map((a) => a.ad?.imagePath),
    );
  }
  // 매칭 실패 — 첫 소재로 폴백하지 않고 명시적으로 알림(잘못된 상품 이미지 주입 방지).
  throw new Error("이 소재의 상품을 특정하지 못했어요. (광고그룹에 소재가 여러 개)");
}

function urlOf(ad: RawShoppingAd): string {
  return (ad.referenceData?.mallProductUrl || ad.referenceData?.mallProdMblUrl || "").trim();
}

/** `.preview-image`의 background-image에서 URL 추출. */
function readPreviewImageUrl(modal: HTMLElement): string {
  const el = modal.querySelector<HTMLElement>(PREVIEW_IMAGE_SELECTOR);
  if (!el) return "";
  const bg = el.style.backgroundImage || getComputedStyle(el).backgroundImage || "";
  const m = bg.match(/url\((['"]?)(.*?)\1\)/);
  return m?.[2] ?? "";
}

/** 사이즈 variant/쿼리를 무시하고 URL의 고유 파일명 세그먼트로 비교 키 생성. */
function imageKey(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url, location.origin);
    const seg = u.pathname.split("/").filter(Boolean).pop() ?? u.pathname;
    return seg.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

async function resolveCustomerId(adAccountNo: string): Promise<number | null> {
  if (customerIdCache.has(adAccountNo)) return customerIdCache.get(adAccountNo) ?? null;
  let out: number | null = null;
  try {
    const j = await authFetch<{ adAccount?: { masterCustomerId?: number } }>(
      `/apis/ad-account/v2/adAccounts/${adAccountNo}`,
    );
    if (j?.adAccount?.masterCustomerId != null) out = j.adAccount.masterCustomerId;
  } catch (e) {
    // 조회 실패 — null로 두면 세션 활성 계정(현재 보고 있는 계정) 기준으로 graceful degrade.
    console.warn("[dv-ads/shopping-img] masterCustomerId 조회 실패", e);
  }
  customerIdCache.set(adAccountNo, out);
  return out;
}

// ─── 후보 그리드 ───

function renderGrid(
  grid: HTMLElement,
  urls: string[],
  modal: HTMLElement,
  setError: (msg: string) => void,
): void {
  grid.replaceChildren();
  for (const url of urls) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dvads-shopping-img-thumb";
    const img = document.createElement("img");
    img.src = url;
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    btn.append(img);

    btn.addEventListener("click", async () => {
      if (btn.dataset.busy === "1") return;
      // 이미 적용된 이미지 재클릭은 무시.
      if (btn.classList.contains("dvads-shopping-img-thumb-selected")) return;
      btn.dataset.busy = "1";
      setError("");
      try {
        await applyCandidate(modal, url);
        // 현재 적용된 썸네일 표시 이동 (한 번에 1장).
        grid
          .querySelectorAll(".dvads-shopping-img-thumb-selected")
          .forEach((el) => el.classList.remove("dvads-shopping-img-thumb-selected"));
        btn.classList.add("dvads-shopping-img-thumb-selected");
      } catch (e) {
        console.warn("[dv-ads/shopping-img] 이미지 적용 실패", url, e);
        setError("이미지를 적용하지 못했어요. 다시 시도해 주세요");
      } finally {
        btn.dataset.busy = "";
      }
    });

    grid.appendChild(btn);
  }
}

/** 모달 안 업로드칸 file input — 업로드칸 우선, 없으면 모달 전역에서. */
function findFileInput(modal: HTMLElement): HTMLInputElement | null {
  return (
    modal.querySelector<HTMLInputElement>(`${UPLOAD_BOX_SELECTOR} ${FILE_INPUT_SELECTOR}`) ??
    modal.querySelector<HTMLInputElement>(FILE_INPUT_SELECTOR)
  );
}

/**
 * 후보 이미지를 업로드칸에 적용. 노출용 이미지가 이미 등록돼 업로드칸(file input)이 없으면
 * 기존 이미지를 제거(×)해 업로드칸을 복귀시킨 뒤 주입 — 클릭만으로 바로 교체되도록.
 */
async function applyCandidate(modal: HTMLElement, url: string): Promise<void> {
  const file = await fetchUrlAsFile(url);
  let input = findFileInput(modal);
  if (!input) {
    await removeExistingExposure(modal);
    input = await waitForFileInput(modal, 3000);
  }
  if (!input) throw new Error("업로드칸을 찾지 못했어요");
  await injectFileToInput(input, file);
}

/**
 * 이미 등록된 노출용 이미지를 제거해 업로드칸(dropzone)을 되돌린다.
 * 모달 자체 닫기(.ad-cms-modal-close)는 절대 제외하고, 노출용 이미지의 제거(×) 버튼만 클릭.
 */
async function removeExistingExposure(modal: HTMLElement): Promise<void> {
  const removeBtn = findRemoveButton(modal);
  if (removeBtn) {
    removeBtn.click();
    await sleep(150);
    return;
  }
  // 못 찾았으면 모달 내 버튼 HTML을 덤프해 정확한 타깃을 보정할 수 있게.
  const container = modal.closest<HTMLElement>(MODAL_CONTAINER_SELECTOR) ?? modal;
  const buttons = Array.from(container.querySelectorAll<HTMLElement>("button")).filter(
    (b) => !b.closest(".ad-cms-modal-close"),
  );
  console.warn(
    "[dv-ads/shopping-img] 제거(×) 버튼 못 찾음 — 모달 내 button 목록:",
    buttons.map((b) => b.outerHTML.slice(0, 140)),
  );
  throw new Error("기존 노출용 이미지를 비우지 못했어요");
}

/**
 * 노출용 이미지 제거(×) 버튼 탐지.
 *   1) FontAwesome times 아이콘 버튼 — `<button class="ad-cms-btn ..."><i class="fa fa-times"></i></button>`
 *      (2026-06-17 사용자 정찰). 모달 자체 닫기는 antd anticon이라 안 걸림.
 *   2) 폴백 — antd close 아이콘 / ×·삭제·제거 텍스트·aria 버튼 (모달 닫기·업로드 제외).
 */
function findRemoveButton(modal: HTMLElement): HTMLElement | null {
  const anchor = findImageAnchor(modal);
  const container = modal.closest<HTMLElement>(MODAL_CONTAINER_SELECTOR) ?? modal;

  // 1) fa-times 아이콘을 가진 버튼 — "이미지" 섹션 우선, 없으면 모달 전체.
  for (const root of [anchor?.contentCol, container]) {
    if (!root) continue;
    const fa = root.querySelector<HTMLElement>("button .fa-times");
    const btn = fa?.closest<HTMLElement>("button");
    if (btn && !btn.closest(".ad-cms-modal-close")) return btn;
  }

  // 2-a) antd close 아이콘 — 모달 닫기(.ad-cms-modal-close) 안에 있는 건 제외.
  for (const icon of Array.from(
    container.querySelectorAll<HTMLElement>('[data-icon="close"], .anticon-close'),
  )) {
    if (icon.closest(".ad-cms-modal-close")) continue;
    return icon.closest<HTMLElement>('button, [role="button"]') ?? icon;
  }
  // 2-b) ×·삭제·제거 텍스트/aria 버튼 — "이미지" 섹션 안에서 (업로드 버튼 제외).
  const scope = anchor?.contentCol ?? container;
  for (const b of Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    if (b.closest(".ad-cms-modal-close")) continue;
    const t = (b.textContent ?? "").trim();
    const aria = (b.getAttribute("aria-label") ?? "").trim();
    if (t.includes("업로드")) continue;
    if (
      /[×✕✖]|삭제|제거|remove|delete|close/i.test(t) ||
      /삭제|제거|remove|delete|close/i.test(aria)
    ) {
      return b;
    }
  }
  return null;
}

/** 업로드칸 file input이 다시 mount될 때까지 대기. */
async function waitForFileInput(modal: HTMLElement, timeoutMs: number): Promise<HTMLInputElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const input = findFileInput(modal);
    if (input) return input;
    await sleep(80);
  }
  return null;
}

/**
 * 네이티브 file input에 File 주입 — F-AssetBulk(dom-asset.ts)와 동일 시퀀스.
 * input.value 직접 대입은 React state를 우회하므로 DataTransfer + input/change/blur로
 * 페이지가 정상 처리하게 한다. canvas 미리보기 mount race 회피 위해 input/change 사이 rAF.
 */
async function injectFileToInput(input: HTMLInputElement, file: File): Promise<void> {
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await raf();
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(50);
  input.dispatchEvent(new Event("blur", { bubbles: true }));
}

function raf(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
