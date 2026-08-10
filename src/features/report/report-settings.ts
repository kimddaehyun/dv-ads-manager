/**
 * F-Report 리포트 설정 flyout — 행 메뉴 "리포트 설정" 클릭 시 메뉴 옆으로 펼쳐진다.
 *
 * 기타 키워드 분류 기준(% 직접 입력)/직간접 표기/캠페인 선택 3종을 계정별로 관리
 * (MultiAccountUserMeta). 취소/확인 모델 — 화면에서 고친 값은 "확인"을 눌러야 한 번에
 * 저장되고, 취소나 바깥 클릭은 버린다.
 * 저장/조회/캠페인 목록은 호출원(report.ts)이 훅으로 주입한다
 * (이 모듈이 report-build를 import하지 않게 — F-Brief 번들 오염 방지).
 * 전부 native DOM (React 미사용). 패널 골격 CSS는 날짜 선택기(dvads-rdp)를 재사용.
 */

import { registerMenuSibling, closeAllOpenDropdowns } from "@/shared/ui-dropdown";
import { showToast } from "@/shared/toast";
import { attachTooltip } from "@/shared/tooltip";

export interface ReportCampaignChoice {
  id: string;
  name: string;
  typeLabel: string; // 파워링크/웹사이트전환 등
}
export interface ReportPickerSettings {
  /** 기타 키워드 분류 기준(캠페인 광고비 대비 비율). 0 = 분류하지 않음. */
  minorRatio: number;
  /** 직접/간접 전환수 열 표기. */
  showConvSplit: boolean;
  /** 포함할 캠페인. null = 전체(신규 캠페인 자동 포함). */
  saCampaignIds: string[] | null;
  gfaCampaignIds: string[] | null;
}
export interface ReportSettingsHooks {
  load: () => Promise<ReportPickerSettings>;
  /** "확인" 시 변경분 저장(fire-and-forget — 실패해도 다음 기회에 다시 저장하면 된다). */
  save: (patch: Partial<ReportPickerSettings>) => void;
  loadCampaigns: () => Promise<{ sa: ReportCampaignChoice[]; gfa: ReportCampaignChoice[] }>;
}

const DEFAULT_MINOR_RATIO = 0.005; // 0.5%

export interface OpenReportSettingsOpts {
  /** 옆으로 펼칠 기준 element (클릭된 메뉴 항목). */
  anchor: HTMLElement;
  /** anchor의 위치를 미리 캡처한 rect (호출원이 await 후 열어 anchor가 떨어진 경우 사용). */
  anchorRect?: DOMRect;
  /** 상단 컨텍스트 한 줄 (광고주명). */
  subText: string;
  hooks: ReportSettingsHooks;
}

let openEl: HTMLElement | null = null;
let openAnchor: HTMLElement | null = null;
let dispose: (() => void) | null = null;

export function closeReportSettings(): void {
  dispose?.();
}

// 비율 → % 표시 문자열 (0.005 → "0.5"). 부동소수 꼬리는 4자리 반올림으로 정리.
function ratioToPercentText(ratio: number): string {
  return String(Math.round(ratio * 100 * 10000) / 10000);
}

export function openReportSettings(opts: OpenReportSettingsOpts): void {
  // 같은 앵커로 다시 열면 토글로 닫는다 (openReportDatePicker와 동일 규칙).
  if (openEl && openAnchor === opts.anchor) {
    closeReportSettings();
    return;
  }
  closeReportSettings();

  const el = document.createElement("div");
  el.className = "dvads dvads-rdp dvads-rdp-setfly";
  el.innerHTML = `
    <div class="dvads-rdp-sub"><span class="dvads-rdp-sub-text"></span></div>
    <div class="dvads-rdp-set">
      <div class="dvads-rdp-set-row">
        <span class="dvads-rdp-set-label">기타 키워드 분류 기준</span>
        <button type="button" class="dvads-brief-info-icon dvads-rdp-set-ratio-info" aria-label="분류 기준 설명">i</button>
        <span class="dvads-rdp-set-ratio-wrap">
          <input type="text" class="dvads-rdp-set-ratio" inputmode="decimal" aria-label="기타 키워드 분류 기준" />
          <span class="dvads-rdp-set-ratio-suffix" aria-hidden="true">%</span>
        </span>
      </div>
      <div class="dvads-rdp-set-row">
        <span class="dvads-rdp-set-label">직접/간접 전환수 표기</span>
        <button type="button" class="dvads-brief-info-icon dvads-rdp-set-conv-info" aria-label="직접/간접 전환수 설명">i</button>
        <input type="checkbox" class="dvads-asset-bulk-switch dvads-rdp-set-conv" aria-label="직접/간접 전환수 표기" />
      </div>
      <div class="dvads-rdp-set-camp-list"></div>
    </div>
    <div class="dvads-rdp-foot">
      <div class="dvads-rdp-foot-btns">
        <button type="button" class="dvads-rdp-cancel">취소</button>
        <button type="button" class="dvads-rdp-confirm">확인</button>
      </div>
    </div>
  `;
  (el.querySelector(".dvads-rdp-sub-text") as HTMLElement).textContent = opts.subText;

  const ratioInput = el.querySelector<HTMLInputElement>(".dvads-rdp-set-ratio")!;
  const convToggle = el.querySelector<HTMLInputElement>(".dvads-rdp-set-conv")!;
  const campListEl = el.querySelector<HTMLElement>(".dvads-rdp-set-camp-list")!;

  attachTooltip(
    el.querySelector<HTMLElement>(".dvads-rdp-set-ratio-info")!,
    "설정한 비율을 기준으로 광고비 비중이 낮은 키워드와 지면을 기타 항목으로 분류해요",
    { placement: "top" },
  );
  attachTooltip(
    el.querySelector<HTMLElement>(".dvads-rdp-set-conv-info")!,
    "끄면 엑셀에서 직접/간접 전환수 열을 숨겨요",
    { placement: "top" },
  );

  // 화면 상태 — 확인 시에만 hooks.save로 내보낸다.
  let loaded: ReportPickerSettings | null = null; // 열 때 읽어 온 저장값 (변경 비교 기준)
  // 캠페인 체크박스: media별로 모아 "전부 체크 = null(전체)" / 최소 1개(SA) 판정에 쓴다.
  const saBoxes: HTMLInputElement[] = [];
  const gfaBoxes: HTMLInputElement[] = [];
  let campaignsLoaded = false; // 목록 조회 실패 시 캠페인 선택은 저장 patch에서 제외

  async function build(): Promise<void> {
    try {
      loaded = await opts.hooks.load();
    } catch (e) {
      console.warn("[dv-ads/report] 리포트 설정 불러오기 실패 → 기본값", e);
    }
    const s: ReportPickerSettings = loaded
      ?? { minorRatio: DEFAULT_MINOR_RATIO, showConvSplit: true, saCampaignIds: null, gfaCampaignIds: null };
    loaded = s;
    ratioInput.value = ratioToPercentText(s.minorRatio);
    convToggle.checked = s.showConvSplit;
    void buildCampaignList(s);
  }

  async function buildCampaignList(s: ReportPickerSettings): Promise<void> {
    campListEl.textContent = "캠페인 목록을 불러오는 중...";
    let lists: { sa: ReportCampaignChoice[]; gfa: ReportCampaignChoice[] };
    try {
      lists = await opts.hooks.loadCampaigns();
    } catch (e) {
      console.warn("[dv-ads/report] 캠페인 목록 조회 실패", e);
      campListEl.textContent = "캠페인 목록을 불러오지 못했어요. 잠시 후 다시 열어 주세요";
      return;
    }
    campaignsLoaded = true;
    campListEl.textContent = "";

    // 유형별 섹션 — F-Brief 선택 화면의 캠페인 유형 띠 디자인 재사용(파랑 유지).
    // 띠 클릭 = 유형 전체 선택/해제, 오른쪽 위/아래 화살표 = 이전/다음 유형 띠로 이동.
    // 디스플레이는 유형 라벨(웹사이트전환 등)만으로는 매체가 안 보여 "디스플레이 · " 접두. 등장 순서 유지.
    const typeBands: Array<{
      band: HTMLElement; anchor: HTMLElement;
      up: HTMLButtonElement; down: HTMLButtonElement;
    }> = [];
    const makeSections = (
      items: ReportCampaignChoice[], selected: string[] | null,
      boxes: HTMLInputElement[], titlePrefix: string,
    ) => {
      const byType = new Map<string, ReportCampaignChoice[]>();
      for (const item of items) {
        const arr = byType.get(item.typeLabel) ?? [];
        arr.push(item);
        byType.set(item.typeLabel, arr);
      }
      for (const [type, group] of byType) {
        // anchor(높이 0) = 띠 이동 목적지 기준 — sticky로 떠 있는 띠의 rect는 원위치가 아니다.
        const anchor = document.createElement("div");
        campListEl.appendChild(anchor);
        const band = document.createElement("div");
        band.className = "dvads-rdp-set-typeband";
        const title = document.createElement("span");
        title.textContent = `${titlePrefix}${type} (${group.length}개)`;
        const nav = document.createElement("span");
        nav.className = "dvads-rdp-set-typeband-nav";
        const mkNavBtn = (dir: -1 | 1): HTMLButtonElement => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "dvads-rdp-set-typeband-btn";
          btn.setAttribute("aria-label", dir < 0 ? "이전 캠페인 유형으로" : "다음 캠페인 유형으로");
          btn.innerHTML = dir < 0
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
          btn.addEventListener("click", (e) => {
            e.stopPropagation(); // 띠 클릭(전체 선택)과 분리
            const deltaTo = (t: { band: HTMLElement; anchor: HTMLElement }): number => {
              const margin = parseFloat(getComputedStyle(t.band).marginTop) || 0;
              return t.anchor.getBoundingClientRect().top - campListEl.getBoundingClientRect().top + margin;
            };
            // ↑는 2단계: 유형 중간까지 내려온 상태면 먼저 이 유형의 시작으로 (F-Brief와 동일).
            if (dir < 0) {
              const selfDelta = deltaTo({ band, anchor });
              if (selfDelta < -1) {
                campListEl.scrollTo({ top: campListEl.scrollTop + selfDelta, behavior: "smooth" });
                return;
              }
            }
            const i = typeBands.findIndex((t) => t.band === band);
            const target = typeBands[i + dir];
            if (!target) return;
            campListEl.scrollTo({ top: campListEl.scrollTop + deltaTo(target), behavior: "smooth" });
          });
          nav.appendChild(btn);
          return btn;
        };
        const up = mkNavBtn(-1);
        const down = mkNavBtn(1);
        band.append(title, nav);
        campListEl.appendChild(band);
        typeBands.push({ band, anchor, up, down });

        const groupBoxes: HTMLInputElement[] = [];
        band.addEventListener("click", () => {
          const turnOn = !groupBoxes.every((b) => b.checked);
          for (const b of groupBoxes) b.checked = turnOn;
        });
        for (const item of group) {
          const row = document.createElement("label");
          row.className = "dvads-rdp-set-camp";
          const box = document.createElement("input");
          box.type = "checkbox";
          box.dataset.id = item.id;
          box.checked = selected == null || selected.includes(item.id);
          const name = document.createElement("span");
          name.className = "dvads-rdp-set-camp-name";
          name.textContent = item.name;
          name.title = item.name;
          row.append(box, name);
          campListEl.appendChild(row);
          boxes.push(box);
          groupBoxes.push(box);
        }
      }
    };
    makeSections(lists.sa, s.saCampaignIds, saBoxes, "");
    makeSections(lists.gfa, s.gfaCampaignIds, gfaBoxes, "디스플레이 · ");
    // 끝 띠에서는 그 방향 화살표 비활성 (첫 띠 ↑는 유형 시작 복귀용으로 살려 둔다).
    if (typeBands.length > 0) typeBands[typeBands.length - 1].down.disabled = true;
    if (!campListEl.hasChildNodes()) campListEl.textContent = "캠페인이 없어요";
    requestAnimationFrame(() => position());
  }

  function finish(): void {
    closeAllOpenDropdowns();
    dispose?.();
  }

  // "확인" — 화면 값을 검증해 변경분만 한 번에 저장하고 닫는다.
  function confirmSettings(): void {
    if (!loaded) { finish(); return; } // 저장값 로드 전(순간)의 확인은 그냥 닫기
    const patch: Partial<ReportPickerSettings> = {};
    // 분류 기준 % — 숫자만 취하고, 빈 값/0 = 분류하지 않음. 무효 입력은 기존 값 유지.
    const pctText = ratioInput.value.replace(/[^\d.]/g, "");
    const pct = pctText === "" ? 0 : Number(pctText);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      const ratio = pct / 100;
      if (ratio !== loaded.minorRatio) patch.minorRatio = ratio;
    }
    if (convToggle.checked !== loaded.showConvSplit) patch.showConvSplit = convToggle.checked;
    if (campaignsLoaded) {
      // 검색광고는 최소 1개 — 0개면 저장하지 않고 화면 유지.
      const saChecked = saBoxes.filter((b) => b.checked).map((b) => b.dataset.id!);
      if (saBoxes.length > 0 && saChecked.length === 0) {
        showToast({ message: "검색광고 캠페인은 최소 1개는 선택해야 해요", variant: "error" });
        return;
      }
      // 전부 체크 = null(전체 — 신규 캠페인 자동 포함). 디스플레이 전부 해제 = [](매체 제외).
      // 저장돼 있던 ID가 이번 목록 조회에 안 잡힌 경우(예: 최근 30일 밖 디스플레이 캠페인)는
      // 화면에 체크박스가 없다 — 사용자가 해제한 게 아니므로 보존해서 합친다 (codex P2, 2026-08-10).
      const resolveIds = (boxes: HTMLInputElement[], savedIds: string[] | null): string[] | null => {
        const checked = boxes.filter((b) => b.checked).map((b) => b.dataset.id!);
        if (checked.length === boxes.length) return null; // 보이는 전부 체크 = 전체(숨은 ID도 포함)
        const rendered = new Set(boxes.map((b) => b.dataset.id!));
        const hidden = (savedIds ?? []).filter((id) => !rendered.has(id));
        return [...checked, ...hidden];
      };
      const saIds = resolveIds(saBoxes, loaded.saCampaignIds);
      const gfaIds = resolveIds(gfaBoxes, loaded.gfaCampaignIds);
      const sameIds = (a: string[] | null, b: string[] | null) =>
        a === null ? b === null : b !== null && a.length === b.length && a.every((v, i) => v === b[i]);
      if (saBoxes.length > 0 && !sameIds(saIds, loaded.saCampaignIds)) patch.saCampaignIds = saIds;
      if (gfaBoxes.length > 0 && !sameIds(gfaIds, loaded.gfaCampaignIds)) patch.gfaCampaignIds = gfaIds;
    }
    if (Object.keys(patch).length > 0) opts.hooks.save(patch);
    finish();
  }
  el.querySelector(".dvads-rdp-cancel")?.addEventListener("click", finish);
  el.querySelector(".dvads-rdp-confirm")?.addEventListener("click", confirmSettings);

  // ── mount + 위치 + 리스너 (openReportDatePicker와 동일 패턴) ──
  // anchor 위치는 지금(동기) 캡처 — keepOpen 메뉴가 onClick 직후 anchor를 떼어낼 수 있다.
  let anchorRect = opts.anchorRect ?? opts.anchor.getBoundingClientRect();
  document.body.appendChild(el);
  openEl = el;
  openAnchor = opts.anchor;
  const unregister = registerMenuSibling(el);

  function position(): void {
    if (opts.anchor.isConnected) anchorRect = opts.anchor.getBoundingClientRect();
    const r = anchorRect;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    // 우선 메뉴 왼쪽으로, 공간 없으면 오른쪽.
    let left = r.left - 8 - w;
    if (left < 8) left = r.right + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - w);
    let top = r.top;
    if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - 8 - h);
    if (top < 8) top = 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }
  requestAnimationFrame(() => position());
  void build();

  // 바깥 클릭/ESC 닫기 (= 취소).
  const onDocPointer = (e: MouseEvent | PointerEvent): void => {
    const t = e.target as Node;
    if (el.contains(t) || opts.anchor.contains(t)) return;
    // 옆에 떠 있는 메뉴 안을 누른 경우 — 다른 항목으로 갈아타는 중. 메뉴는 살려 클릭이 진행되게.
    if (t instanceof Element && t.closest(".dvads-dropdown-panel")) {
      dispose?.();
      return;
    }
    finish();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
  };
  const onWinScroll = (e: Event): void => {
    // 페이지 스크롤이면 닫고, flyout 내부 스크롤은 유지.
    if (e.target instanceof Node && el.contains(e.target)) return;
    finish();
  };
  const onResize = (): void => position();
  setTimeout(() => {
    document.addEventListener("pointerdown", onDocPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onWinScroll, true);
    window.addEventListener("resize", onResize);
  }, 0);

  dispose = () => {
    document.removeEventListener("pointerdown", onDocPointer, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("scroll", onWinScroll, true);
    window.removeEventListener("resize", onResize);
    unregister();
    el.remove();
    if (openEl === el) {
      openEl = null;
      openAnchor = null;
    }
    dispose = null;
  };
}
