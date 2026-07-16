/**
 * F-Setup — 세팅안 생성 UI 오케스트레이터 (콘텐츠 스크립트).
 *
 * F-MultiAccount popover의 행 메뉴 "세팅안 생성"에서 진입. 캠페인 선택 모달 → 선택 캠페인의
 * 계층 수집(setup-data) → 예상순위 보강(background GET_BID_ESTIMATE) → 엑셀 생성/다운로드
 * (setup-excel) → 토스트.
 *
 * 모든 internal API 수집은 콘텐츠 스크립트 컨텍스트, 엑셀 생성은 전부 클라이언트 사이드 —
 * 사용자 데이터 외부 전송 0건.
 */

import { showToast } from "@/shared/toast";
import { closeAllOpenDropdowns, createDropdown } from "@/shared/ui-dropdown";
import { friendlyApiError } from "@/shared/friendly-error";
import { estimateRank } from "@/shared/rank";
import { normalizeKeyword } from "@/shared/storage-keys";
import {
  collectKeywordBidPairs,
  collectSetupData,
  fetchSetupCampaignChoices,
} from "@/features/setup/setup-data";
import { generateSetupWorkbook } from "@/features/setup/setup-excel";
import { CAMPAIGN_TYPE_LABELS } from "@/features/setup/setup-adapters";
import type { CampaignTypeCode, SetupCampaign, SetupCampaignChoice } from "@/types/setup";
import type { RankPosition } from "@/types/storage";
import type {
  FetchImageBinaryResponse,
  GetBidEstimateRequest,
  GetBidEstimateResponse,
} from "@/types/messages";

export interface SetupTarget {
  adAccountNo: number;
  masterCustomerId?: number;
  name: string;
}

let modalEl: HTMLElement | null = null;
let running = false;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function checkboxHTML(checked: boolean): string {
  return `<label class="dvads-multi-cb"><input type="checkbox" ${
    checked ? "checked" : ""
  } /><span class="dvads-multi-cb-box" aria-hidden="true"></span></label>`;
}

function formatBudget(v: number | null): string {
  return v === null ? "제한없음" : `${v.toLocaleString("ko-KR")}원`;
}

function closeModal(): void {
  closeAllOpenDropdowns();
  if (keyHandler) {
    document.removeEventListener("keydown", keyHandler, true);
    keyHandler = null;
  }
  modalEl?.remove();
  modalEl = null;
}

export async function openSetupFlow(target: SetupTarget): Promise<void> {
  if (modalEl || running) return;
  if (target.masterCustomerId == null) {
    showToast({
      message: "이 계정 정보를 불러올 수 없어요. 페이지를 새로고침한 뒤 다시 시도해 주세요",
      variant: "error",
    });
    return;
  }
  const customerId = target.masterCustomerId;

  // 모달 + backdrop 골격 (로딩 표시).
  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-setup-backdrop";
  const modal = document.createElement("div");
  modal.className = "dvads-setup-modal";
  modal.innerHTML = `
    <div class="dvads-setup-head">
      <div class="dvads-setup-title">세팅안 생성</div>
      <div class="dvads-setup-sub">${escapeHtml(target.name)}</div>
      <button class="dvads-setup-close" type="button" aria-label="닫기">×</button>
    </div>
    <div class="dvads-setup-body"><div class="dvads-setup-loading">캠페인을 불러오는 중...</div></div>
  `;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  modalEl = backdrop;

  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closeModal();
  });
  modal.querySelector(".dvads-setup-close")?.addEventListener("click", closeModal);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && modalEl) {
      e.preventDefault();
      closeModal();
    }
  };
  keyHandler = onKey;
  document.addEventListener("keydown", onKey, true);

  // 캠페인 목록 로드.
  let choices: SetupCampaignChoice[];
  try {
    choices = await fetchSetupCampaignChoices(customerId);
  } catch (e) {
    if (!modalEl) return;
    const body = modal.querySelector(".dvads-setup-body");
    if (body)
      body.innerHTML = `<div class="dvads-setup-loading">${escapeHtml(
        friendlyApiError(String(e), "test"),
      )}</div>`;
    return;
  }
  if (!modalEl) return; // 로딩 중 닫힘

  if (choices.length === 0) {
    const body = modal.querySelector(".dvads-setup-body");
    if (body)
      body.innerHTML = `<div class="dvads-setup-loading">이 계정에 캠페인이 없어요</div>`;
    return;
  }

  renderChooser(modal, target, customerId, choices);
}

function renderChooser(
  modal: HTMLElement,
  target: SetupTarget,
  customerId: number,
  choices: SetupCampaignChoice[],
): void {
  const selected = new Set<string>(choices.map((c) => c.id)); // 기본 전체 선택
  let typeFilter: CampaignTypeCode | "ALL" = "ALL";

  // 존재하는 유형만 필터 옵션으로.
  const presentTypes = Array.from(new Set(choices.map((c) => c.typeCode)));
  const filterOptions = [
    { value: "ALL" as const, label: "전체 유형" },
    ...presentTypes.map((t) => ({ value: t, label: CAMPAIGN_TYPE_LABELS[t] ?? t })),
  ];

  const body = modal.querySelector(".dvads-setup-body");
  if (!body) return;
  body.innerHTML = `
    <div class="dvads-setup-toolbar">
      <div class="dvads-setup-filter"></div>
      <label class="dvads-setup-selectall">${checkboxHTML(true)}<span>전체 선택</span></label>
      <span class="dvads-setup-count"></span>
    </div>
    <div class="dvads-setup-list"></div>
    <div class="dvads-setup-foot">
      <button class="dvads-btn dvads-btn-secondary dvads-setup-cancel" type="button">취소</button>
      <button class="dvads-btn dvads-btn-primary dvads-setup-go" type="button"></button>
    </div>
  `;

  const listEl = body.querySelector<HTMLElement>(".dvads-setup-list")!;
  const countEl = body.querySelector<HTMLElement>(".dvads-setup-count")!;
  const goBtn = body.querySelector<HTMLButtonElement>(".dvads-setup-go")!;
  const selectAllCb = body.querySelector<HTMLInputElement>(".dvads-setup-selectall input")!;

  // 캠페인 행 렌더.
  for (const c of choices) {
    const row = document.createElement("div");
    row.className = "dvads-setup-row";
    row.dataset.id = c.id;
    row.dataset.type = c.typeCode;
    row.innerHTML = `
      ${checkboxHTML(true)}
      <span class="dvads-setup-row-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
      <span class="dvads-setup-badge">${escapeHtml(c.typeLabel)}</span>
      <span class="dvads-setup-row-budget">${formatBudget(c.dailyBudget)}</span>
    `;
    const cb = row.querySelector<HTMLInputElement>(".dvads-multi-cb input")!;
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(c.id);
      else selected.delete(c.id);
      syncUI();
    });
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".dvads-multi-cb")) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event("change"));
    });
    listEl.appendChild(row);
  }

  // 유형 필터 dropdown.
  const filterMount = body.querySelector<HTMLElement>(".dvads-setup-filter")!;
  const dd = createDropdown<CampaignTypeCode | "ALL">({
    value: "ALL",
    options: filterOptions,
    ariaLabel: "캠페인 유형 필터",
    width: 130,
    onChange: (v) => {
      typeFilter = v;
      applyFilter();
      syncUI();
    },
  });
  filterMount.appendChild(dd.root);

  function applyFilter(): void {
    listEl.querySelectorAll<HTMLElement>(".dvads-setup-row").forEach((r) => {
      const show = typeFilter === "ALL" || r.dataset.type === typeFilter;
      r.style.display = show ? "" : "none";
    });
  }

  function visibleRows(): HTMLElement[] {
    return Array.from(listEl.querySelectorAll<HTMLElement>(".dvads-setup-row")).filter(
      (r) => r.style.display !== "none",
    );
  }

  function syncUI(): void {
    countEl.textContent = `${selected.size}개 선택`;
    goBtn.textContent = `세팅안 생성 (${selected.size})`;
    goBtn.disabled = selected.size === 0;
    // 전체선택 체크박스 = 보이는 행 기준.
    const vis = visibleRows();
    const allSel = vis.length > 0 && vis.every((r) => selected.has(r.dataset.id!));
    const someSel = vis.some((r) => selected.has(r.dataset.id!));
    selectAllCb.checked = allSel;
    selectAllCb.indeterminate = !allSel && someSel;
  }

  selectAllCb.addEventListener("change", () => {
    const vis = visibleRows();
    for (const r of vis) {
      const id = r.dataset.id!;
      const cb = r.querySelector<HTMLInputElement>(".dvads-multi-cb input")!;
      cb.checked = selectAllCb.checked;
      if (selectAllCb.checked) selected.add(id);
      else selected.delete(id);
    }
    syncUI();
  });

  body.querySelector(".dvads-setup-cancel")?.addEventListener("click", closeModal);
  goBtn.addEventListener("click", () => {
    const picked = choices.filter((c) => selected.has(c.id));
    if (picked.length === 0) return;
    void runGenerate(target, customerId, picked);
  });

  applyFilter();
  syncUI();
}

// ─── 진행 오버레이 ───

let overlayEl: HTMLElement | null = null;
function showProgress(text: string): void {
  if (!overlayEl) {
    const el = document.createElement("div");
    el.className = "dvads dvads-auto-overlay";
    const card = document.createElement("div");
    card.className = "dvads-auto-overlay-card";
    const spinner = document.createElement("div");
    spinner.className = "dvads-auto-overlay-spinner";
    const t = document.createElement("div");
    t.className = "dvads-auto-overlay-text";
    card.append(spinner, t);
    el.appendChild(card);
    document.body.appendChild(el);
    overlayEl = el;
  }
  overlayEl.style.display = "";
  const t = overlayEl.querySelector<HTMLElement>(".dvads-auto-overlay-text");
  if (t) t.textContent = text;
}
function updateProgress(label: string, done: number, total: number): void {
  const t = overlayEl?.querySelector<HTMLElement>(".dvads-auto-overlay-text");
  if (t) t.textContent = total > 0 ? `${label} (${done}/${total})` : `${label}...`;
}
function hideProgress(): void {
  if (overlayEl) overlayEl.style.display = "none";
}

async function runGenerate(
  target: SetupTarget,
  customerId: number,
  picked: SetupCampaignChoice[],
): Promise<void> {
  if (running) return;
  running = true;
  closeAllOpenDropdowns();
  showProgress("세팅안을 만드는 중...");
  try {
    const campaigns = await collectSetupData(customerId, picked, (done, total, label) =>
      updateProgress(label, done, total),
    );
    await enrichRanks(campaigns);
    const imageMap = await fetchAdImages(campaigns);
    showProgress("엑셀 파일을 만드는 중...");
    const filename = await generateSetupWorkbook(target.name, campaigns, imageMap);
    hideProgress();
    closeModal();
    showToast({ message: `세팅안을 내려받았어요`, variant: "success", keyword: filename });
  } catch (e) {
    hideProgress();
    console.warn("[dv-ads/setup] 세팅안 생성 실패", e);
    showToast({ message: friendlyApiError(String(e), "test"), variant: "error" });
  } finally {
    running = false;
  }
}

/**
 * 키워드 예상순위 보강 — background GET_BID_ESTIMATE로 1~10위 시장가를 받아 estimateRank.
 * 자격증명 없으면 rank=null 유지(엑셀에 "-"). 100개 chunk로 분할.
 */
async function enrichRanks(campaigns: SetupCampaign[]): Promise<void> {
  const pairs = collectKeywordBidPairs(campaigns);
  if (pairs.length === 0) return;

  const uniqueKeywords = Array.from(new Set(pairs.map((p) => p.keyword)));
  const rankByKeyword = new Map<string, Partial<Record<RankPosition, number>>>();
  const CHUNK = 100;
  let noCred = false;

  for (let i = 0; i < uniqueKeywords.length; i += CHUNK) {
    const chunk = uniqueKeywords.slice(i, i + CHUNK);
    const req: GetBidEstimateRequest = {
      type: "GET_BID_ESTIMATE",
      keywords: chunk.map((k) => ({ keyword: k, currentBid: null })),
      device: "PC",
      // 여기선 rank_to_bid만 쓰므로 성과 추정(2단계)은 생략 — 호출량·소요시간 절감.
      skipPerformance: true,
    };
    let resp: GetBidEstimateResponse | undefined;
    try {
      resp = (await chrome.runtime.sendMessage(req)) as GetBidEstimateResponse;
    } catch {
      resp = undefined;
    }
    updateProgress(
      "예상 순위를 계산하는 중",
      Math.min(i + CHUNK, uniqueKeywords.length),
      uniqueKeywords.length,
    );
    if (!resp) continue;
    if (resp.has_credential === false) {
      noCred = true;
      break;
    }
    if (resp.ok && Array.isArray(resp.data)) {
      for (const vc of resp.data)
        rankByKeyword.set(normalizeKeyword(vc.keyword), vc.rank_to_bid);
    }
  }

  for (const c of campaigns) {
    for (const g of c.adgroups) {
      for (const k of g.keywords) {
        const rtb = rankByKeyword.get(normalizeKeyword(k.keyword));
        k.rank = rtb ? estimateRank(k.bidAmt, rtb) : null;
      }
    }
  }

  if (noCred) {
    showToast({
      message: "검색광고 API 키가 없어 예상 순위는 비워졌어요. 옵션에서 키를 입력하면 채워집니다",
      variant: "error",
    });
  }
}

/**
 * 쇼핑 소재 등 imageUrl이 있는 소재의 이미지를 background로 fetch (CORS 회피). url→ArrayBuffer 맵.
 * 실패한 이미지는 맵에서 빠지고 엑셀에서 텍스트로 폴백.
 */
async function fetchAdImages(campaigns: SetupCampaign[]): Promise<Map<string, ArrayBuffer>> {
  const urls = new Set<string>();
  for (const c of campaigns) {
    for (const g of c.adgroups) {
      for (const ad of g.ads) {
        if (ad.imageUrl) urls.add(ad.imageUrl);
      }
    }
  }
  const map = new Map<string, ArrayBuffer>();
  const list = Array.from(urls);
  if (list.length === 0) return map;

  showProgress("상품 이미지를 불러오는 중...");
  let done = 0;
  await runPool(list, 4, async (url) => {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: "FETCH_IMAGE_BINARY",
        url,
      })) as FetchImageBinaryResponse;
      if (resp?.ok && resp.base64) map.set(url, base64ToArrayBuffer(resp.base64));
    } catch {
      /* 이미지 실패는 무시 — 텍스트 폴백 */
    }
    done++;
    updateProgress("상품 이미지를 불러오는 중", done, list.length);
  });
  return map;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** 동시 실행 수 제한 worker pool. */
async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: n }, () => worker()));
}
