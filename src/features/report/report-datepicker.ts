/**
 * F-Report 날짜 선택기 — 네이버 광고 날짜 선택기를 그대로 옮긴 flyout (컬러만 DV 주황).
 *
 * 설정 드롭다운/행 메뉴의 "리포트 생성" 클릭 시, 메뉴를 닫고 어두운 모달을 띄우는 대신
 * 메뉴 옆으로 펼쳐진다(`registerMenuSibling`로 메뉴가 함께 닫히지 않게 등록).
 *
 * 레이아웃: [좌] 기간 프리셋 세로 리스트  [우] from/to 입력 + 연/월 네비 + 요일헤더 +
 * 스크롤되는 월별 달력. 하단에 담당자 입력 + 취소/확인. 미래 날짜는 비활성.
 * 전부 native DOM (React 미사용).
 */

import { rangeForPreset, PRESET_LABELS, type ReportPreset, type DateRange } from "@/features/report/report-period";
import { registerMenuSibling, closeAllOpenDropdowns } from "@/shared/ui-dropdown";
import { showToast } from "@/shared/toast";
import { attachTooltip } from "@/shared/tooltip";
// 담당자명은 사용자 설정 묶음(user_settings)의 일부 — 저장/조회는 multi-account-storage가 담당.
import {
  loadReportAuthor, saveReportAuthor, loadReportWithMessage, saveReportWithMessage,
} from "@/features/multi-account/multi-account-storage";

const PRESETS = Object.keys(PRESET_LABELS) as ReportPreset[];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// 달력에 보여줄 월 범위: 오늘 기준 과거 18개월 ~ 미래 2개월.
const MONTHS_BACK = 18;
const MONTHS_FWD = 2;

let openEl: HTMLElement | null = null;
let openAnchor: HTMLElement | null = null;
let dispose: (() => void) | null = null;

function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseIso(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmtDot(d: Date): string {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}.`;
}
function monthKey(y: number, m: number): string {
  return `${y}-${m}`;
}

// ── 리포트 설정 (톱니 아이콘 → 화면 전환) ──
// 값은 계정별 저장(MultiAccountUserMeta) — 저장/조회/캠페인 목록은 호출원(report.ts)이 주입한다.
// datepicker가 report-build를 import하지 않게 하기 위함(F-Brief 번들 오염 방지).
export interface ReportCampaignChoice {
  id: string;
  name: string;
  typeLabel: string; // 파워링크/웹사이트전환 등
}
export interface ReportPickerSettings {
  /** 기타 행 접기 기준(캠페인 광고비 대비 비율). 0 = 접지 않음. */
  minorRatio: number;
  /** 직접/간접 전환수 열 표기. */
  showConvSplit: boolean;
  /** 포함할 캠페인. null = 전체(신규 캠페인 자동 포함). */
  saCampaignIds: string[] | null;
  gfaCampaignIds: string[] | null;
}
export interface ReportSettingsHooks {
  load: () => Promise<ReportPickerSettings>;
  /** 변경 즉시 저장(fire-and-forget — 실패해도 이번 생성에는 화면의 값이 쓰인다). */
  save: (patch: Partial<ReportPickerSettings>) => void;
  loadCampaigns: () => Promise<{ sa: ReportCampaignChoice[]; gfa: ReportCampaignChoice[] }>;
}

// 접기 기준 프리셋. 저장값이 목록에 없으면(예: 예전 버전 값) 그 값을 임시 항목으로 추가한다.
const RATIO_PRESETS: Array<{ value: number; label: string }> = [
  { value: 0, label: "접지 않음" },
  { value: 0.0025, label: "0.25%" },
  { value: 0.005, label: "0.5% (기본)" },
  { value: 0.01, label: "1%" },
  { value: 0.02, label: "2%" },
];

export interface OpenDatePickerOpts {
  /** 옆으로 펼칠 기준 element (클릭된 메뉴 항목). */
  anchor: HTMLElement;
  /** anchor의 위치를 미리 캡처한 rect (호출원이 await 후 열어 anchor가 떨어진 경우 사용). */
  anchorRect?: DOMRect;
  /** 상단 컨텍스트 한 줄 (예: 광고주명 / "N개 광고주"). */
  subText: string;
  /** 담당자 입력란 표시 여부. 기본 true. F-Brief는 문구에 담당자명이 안 들어가 false. */
  showAuthor?: boolean;
  /** 목표 ROAS 입력란 표시(F-Brief). 값은 초기값(미설정이면 null). */
  roasInitial?: number | null;
  showRoas?: boolean;
  /** "문구 포함 생성" 토글 표시(F-Report). 켜면 onConfirm의 withMessage가 true. */
  showMessageToggle?: boolean;
  /** 열릴 때 선택돼 있을 프리셋. 기본 "lastWeek"(지난주). */
  initialPreset?: ReportPreset;
  /** 열릴 때 선택돼 있을 임의 기간 — 주어지면 initialPreset보다 우선(프리셋 비활성으로 시작). */
  initialRange?: DateRange;
  /** 리포트 설정(접기 기준/캠페인 선택/직간접 표기) 훅. 주면 톱니 아이콘이 나타난다(F-Report 단일). */
  settings?: ReportSettingsHooks;
  onConfirm: (
    range: DateRange, author: string, targetRoas: number | null, withMessage: boolean,
    settings?: ReportPickerSettings,
  ) => void;
}

export function closeReportDatePicker(): void {
  dispose?.();
}

export function openReportDatePicker(opts: OpenDatePickerOpts): void {
  // 같은 앵커(트리거 버튼)로 다시 열면 토글로 닫는다 — 트리거 클릭은 flyout의
  // 바깥클릭 판정에서 예외라, 이 처리가 없으면 "닫힘 -> 곧바로 재오픈"이 돼
  // 버튼을 아무리 눌러도 안 꺼지는 버그가 된다 (createDropdown 트리거 토글과 동일 규칙).
  if (openEl && openAnchor === opts.anchor) {
    closeReportDatePicker();
    return;
  }
  // 이미 열려 있으면 닫고 새로 (중복 flyout 방지).
  closeReportDatePicker();

  const today = dayStart(new Date());
  const initPreset = opts.initialPreset ?? "lastWeek";
  const init = opts.initialRange ?? rangeForPreset(initPreset, today);
  let start = parseIso(init.since);
  let end = parseIso(init.until);
  let activePreset: ReportPreset | null = opts.initialRange ? null : initPreset;
  let activeField: "start" | "end" = "start";

  // ── 패널 골격 ──
  const el = document.createElement("div");
  el.className = "dvads dvads-rdp";
  el.innerHTML = `
    <div class="dvads-rdp-sub">
      <span class="dvads-rdp-sub-text"></span>
      <button type="button" class="dvads-rdp-settings-btn" aria-label="리포트 설정">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
      </button>
    </div>
    <div class="dvads-rdp-set" style="display: none;">
      <div class="dvads-rdp-set-row">
        <span class="dvads-rdp-set-label">기타 행 접기 기준</span>
        <button type="button" class="dvads-brief-info-icon dvads-rdp-set-ratio-info" aria-label="접기 기준 설명">i</button>
        <select class="dvads-rdp-set-ratio" aria-label="기타 행 접기 기준"></select>
      </div>
      <div class="dvads-rdp-set-row">
        <span class="dvads-rdp-set-label">직접/간접 전환수 표기</span>
        <button type="button" class="dvads-brief-info-icon dvads-rdp-set-conv-info" aria-label="직접/간접 전환수 설명">i</button>
        <input type="checkbox" class="dvads-asset-bulk-switch dvads-rdp-set-conv" aria-label="직접/간접 전환수 표기" />
      </div>
      <div class="dvads-rdp-set-row dvads-rdp-set-camp-title">
        <span class="dvads-rdp-set-label">포함할 캠페인</span>
        <button type="button" class="dvads-brief-info-icon dvads-rdp-set-camp-info" aria-label="캠페인 선택 설명">i</button>
      </div>
      <div class="dvads-rdp-set-camp-list"></div>
      <div class="dvads-rdp-foot">
        <div class="dvads-rdp-foot-btns">
          <button type="button" class="dvads-rdp-cancel dvads-rdp-set-back">돌아가기</button>
        </div>
      </div>
    </div>
    <div class="dvads-rdp-main">
      <div class="dvads-rdp-presets"></div>
      <div class="dvads-rdp-cal">
        <div class="dvads-rdp-fields">
          <input type="text" class="dvads-rdp-field" data-field="start" inputmode="numeric" aria-label="시작일" />
          <span class="dvads-rdp-arrow" aria-hidden="true">→</span>
          <input type="text" class="dvads-rdp-field" data-field="end" inputmode="numeric" aria-label="종료일" />
        </div>
        <div class="dvads-rdp-navhead">
          <button type="button" class="dvads-rdp-nav" data-nav="py" aria-label="이전 해">&laquo;</button>
          <button type="button" class="dvads-rdp-nav" data-nav="pm" aria-label="이전 달">&lsaquo;</button>
          <span class="dvads-rdp-navlabel"></span>
          <button type="button" class="dvads-rdp-nav" data-nav="nm" aria-label="다음 달">&rsaquo;</button>
          <button type="button" class="dvads-rdp-nav" data-nav="ny" aria-label="다음 해">&raquo;</button>
        </div>
        <div class="dvads-rdp-weekhead">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
        <div class="dvads-rdp-scroll"></div>
      </div>
    </div>
    <div class="dvads-rdp-msgrow">
      <span class="dvads-rdp-msg-group">
        <span class="dvads-rdp-msg-label">문구 생성</span>
        <button type="button" class="dvads-brief-info-icon dvads-rdp-msg-info" aria-label="문구 생성 설명">i</button>
        <input type="checkbox" class="dvads-asset-bulk-switch dvads-rdp-msg-toggle" aria-label="문구 생성" />
      </span>
      <input type="text" class="dvads-rdp-author" placeholder="담당자명" />
      <span class="dvads-rdp-roas-wrap">
        <input type="text" class="dvads-rdp-roas" placeholder="목표 ROAS" inputmode="numeric" />
        <span class="dvads-rdp-roas-suffix" aria-hidden="true">%</span>
      </span>
    </div>
    <div class="dvads-rdp-foot">
      <div class="dvads-rdp-foot-btns">
        <button type="button" class="dvads-rdp-cancel">취소</button>
        <button type="button" class="dvads-rdp-confirm">확인</button>
      </div>
    </div>
  `;
  (el.querySelector(".dvads-rdp-sub-text") as HTMLElement).textContent = opts.subText;

  const presetsBox = el.querySelector<HTMLElement>(".dvads-rdp-presets")!;
  const scrollBox = el.querySelector<HTMLElement>(".dvads-rdp-scroll")!;
  const navLabel = el.querySelector<HTMLElement>(".dvads-rdp-navlabel")!;
  const fieldStart = el.querySelector<HTMLInputElement>('.dvads-rdp-field[data-field="start"]')!;
  const fieldEnd = el.querySelector<HTMLInputElement>('.dvads-rdp-field[data-field="end"]')!;
  const authorInput = el.querySelector<HTMLInputElement>(".dvads-rdp-author")!;
  const msgToggle = el.querySelector<HTMLInputElement>(".dvads-rdp-msg-toggle")!;
  const roasWrap = el.querySelector<HTMLElement>(".dvads-rdp-roas-wrap")!;
  const roasInput = el.querySelector<HTMLInputElement>(".dvads-rdp-roas")!;

  // 토글 저장 경합 방지 상태 — 복원 완료 전 확인을 누르면 저장을 건너뛰어
  // 기본값(꺼짐)이 서버의 켜짐 설정을 덮지 않게 한다.
  let msgToggleTouched = false;
  let msgToggleRestored = false;
  let msgRestorePromise: Promise<void> = Promise.resolve();

  if (opts.showMessageToggle) {
    const info = el.querySelector<HTMLElement>(".dvads-rdp-msg-info")!;
    attachTooltip(info, "엑셀과 함께 보고 문구도 만들어요", { placement: "top" });
    // 마지막에 선택한 상태 복원 — 복원 전에 사용자가 이미 만졌으면 그대로 둔다.
    msgToggleTouched = false;
    msgToggleRestored = false;
    msgToggle.addEventListener("change", () => { msgToggleTouched = true; });
    msgRestorePromise = loadReportWithMessage().then((on) => {
      msgToggleRestored = true;
      if (!msgToggleTouched) msgToggle.checked = on;
    }).catch(() => { msgToggleRestored = true; });
  } else {
    // 토글 묶음만 제거 — msgrow는 담당자/목표 ROAS 입력이 함께 살아 유지된다.
    // (msgToggle 참조는 위에서 이미 잡아둬 detached여도 checked=false로 안전)
    el.querySelector(".dvads-rdp-msg-group")?.remove();
  }

  if (opts.showRoas) {
    if (opts.roasInitial != null) roasInput.value = String(opts.roasInitial);
  } else {
    roasWrap.style.display = "none";
  }

  if (opts.showAuthor === false) {
    // 담당자 미사용(F-Brief) — 입력란만 숨기고 onConfirm의 author는 빈 문자열로 나간다.
    authorInput.style.display = "none";
  } else {
    // 마지막에 입력한 담당자명 복원 — 다음 리포트 생성 때 자동으로 채워둔다.
    void loadReportAuthor().then((saved) => {
      if (saved && document.activeElement !== authorInput && !authorInput.value) {
        authorInput.value = saved;
      }
    });
  }

  // ── 리포트 설정 화면 (톱니 → 화면 전환, 값은 계정별 저장) ──
  const settingsBtn = el.querySelector<HTMLButtonElement>(".dvads-rdp-settings-btn")!;
  const setView = el.querySelector<HTMLElement>(".dvads-rdp-set")!;
  const mainView = el.querySelector<HTMLElement>(".dvads-rdp-main")!;
  const msgRowEl = el.querySelector<HTMLElement>(".dvads-rdp-msgrow");
  const mainFoot = el.querySelector<HTMLElement>(".dvads-rdp-msgrow + .dvads-rdp-foot");
  const ratioSel = el.querySelector<HTMLSelectElement>(".dvads-rdp-set-ratio")!;
  const convToggle = el.querySelector<HTMLInputElement>(".dvads-rdp-set-conv")!;
  const campListEl = el.querySelector<HTMLElement>(".dvads-rdp-set-camp-list")!;

  // 열릴 때 미리 조회해 두면 톱니를 누르든 바로 확인을 누르든 기다림이 짧다.
  let curSettings: ReportPickerSettings | null = null;
  const settingsP: Promise<void> = opts.settings
    ? opts.settings.load().then((s) => { curSettings = s; }).catch((e) => {
      console.warn("[dv-ads/report] 리포트 설정 불러오기 실패 → 기본값", e);
    })
    : Promise.resolve();
  if (!opts.settings) settingsBtn.style.display = "none";

  function showSettings(on: boolean): void {
    setView.style.display = on ? "" : "none";
    mainView.style.display = on ? "none" : "";
    if (msgRowEl) msgRowEl.style.display = on ? "none" : "";
    if (mainFoot) mainFoot.style.display = on ? "none" : "";
    settingsBtn.classList.toggle("is-active", on);
    requestAnimationFrame(() => position()); // 높이가 달라지므로 재배치
  }

  let setBuilt = false;
  async function openSettings(): Promise<void> {
    if (setView.style.display !== "none") { showSettings(false); return; } // 톱니 재클릭 = 닫기
    showSettings(true);
    if (setBuilt) return;
    setBuilt = true;
    attachTooltip(
      el.querySelector<HTMLElement>(".dvads-rdp-set-ratio-info")!,
      "총비용이 캠페인 광고비의 이 비율에 못 미치는 키워드와 지면을 '기타' 한 줄로 접어요",
      { placement: "top" },
    );
    attachTooltip(
      el.querySelector<HTMLElement>(".dvads-rdp-set-conv-info")!,
      "끄면 엑셀에서 직접/간접 전환수 열을 숨겨요",
      { placement: "top" },
    );
    attachTooltip(
      el.querySelector<HTMLElement>(".dvads-rdp-set-camp-info")!,
      "체크한 캠페인만 리포트에 넣어요. 전부 체크해 두면 새로 만든 캠페인도 자동으로 포함되고, 디스플레이를 전부 해제하면 리포트에서 빠져요",
      { placement: "top" },
    );
    await settingsP;
    const s: ReportPickerSettings = curSettings
      ?? { minorRatio: 0.005, showConvSplit: true, saCampaignIds: null, gfaCampaignIds: null };
    curSettings = s;
    // 접기 기준 select — 저장값이 프리셋에 없으면 임시 항목으로 추가해 표시가 어긋나지 않게.
    const presets = RATIO_PRESETS.some((p) => p.value === s.minorRatio)
      ? RATIO_PRESETS
      : [...RATIO_PRESETS, { value: s.minorRatio, label: `${s.minorRatio * 100}%` }]
        .sort((a, b) => a.value - b.value);
    for (const p of presets) {
      const o = document.createElement("option");
      o.value = String(p.value);
      o.textContent = p.label;
      ratioSel.appendChild(o);
    }
    ratioSel.value = String(s.minorRatio);
    ratioSel.addEventListener("change", () => {
      const v = Number(ratioSel.value);
      if (!Number.isFinite(v) || !curSettings) return;
      curSettings.minorRatio = v;
      opts.settings?.save({ minorRatio: v });
    });
    convToggle.checked = s.showConvSplit;
    convToggle.addEventListener("change", () => {
      if (!curSettings) return;
      curSettings.showConvSplit = convToggle.checked;
      opts.settings?.save({ showConvSplit: convToggle.checked });
    });
    void buildCampaignList(s);
  }

  async function buildCampaignList(s: ReportPickerSettings): Promise<void> {
    campListEl.textContent = "캠페인 목록을 불러오는 중...";
    let lists: { sa: ReportCampaignChoice[]; gfa: ReportCampaignChoice[] };
    try {
      lists = await opts.settings!.loadCampaigns();
    } catch (e) {
      console.warn("[dv-ads/report] 캠페인 목록 조회 실패", e);
      campListEl.textContent = "캠페인 목록을 불러오지 못했어요. 잠시 후 다시 열어 주세요";
      return;
    }
    campListEl.textContent = "";
    // minOne: 전부 해제 금지(검색광고 — 검색광고가 빠진 리포트는 만들 수 없다).
    // 디스플레이는 전부 해제 허용 — 빈 목록([])으로 저장돼 디스플레이가 통째로 빠진다.
    const makeGroup = (
      title: string, items: ReportCampaignChoice[],
      selected: string[] | null, key: "saCampaignIds" | "gfaCampaignIds", minOne: boolean,
    ) => {
      if (items.length === 0) return;
      const wrap = document.createElement("div");
      wrap.className = "dvads-rdp-set-group";
      const head = document.createElement("label");
      head.className = "dvads-rdp-set-group-head";
      const master = document.createElement("input");
      master.type = "checkbox";
      const headText = document.createElement("span");
      headText.textContent = `${title} (${items.length}개)`;
      head.append(master, headText);
      wrap.appendChild(head);
      const boxes: HTMLInputElement[] = [];
      const syncMaster = () => {
        const n = boxes.filter((b) => b.checked).length;
        master.checked = n === boxes.length;
        master.indeterminate = n > 0 && n < boxes.length;
      };
      // 전부 체크는 "전체"로 저장(null) — 신규 캠페인 자동 포함. 전부 해제는 매체별로 다르다:
      // 검색광고는 최소 1개 강제(되돌림), 디스플레이는 []로 저장해 매체 제외.
      const commit = (revert?: () => void) => {
        const checked = boxes.filter((b) => b.checked).map((b) => b.dataset.id!);
        if (minOne && checked.length === 0) {
          revert?.();
          showToast({ message: "검색광고 캠페인은 최소 1개는 선택해야 해요", variant: "error" });
          syncMaster();
          return;
        }
        const ids = checked.length === boxes.length ? null : checked;
        if (curSettings) curSettings[key] = ids;
        opts.settings?.save({ [key]: ids });
        syncMaster();
      };
      master.addEventListener("change", () => {
        const before = boxes.map((b) => b.checked);
        for (const b of boxes) b.checked = master.checked;
        commit(() => boxes.forEach((b, i) => { b.checked = before[i]; }));
      });
      for (const item of items) {
        const row = document.createElement("label");
        row.className = "dvads-rdp-set-camp";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.id = item.id;
        box.checked = selected == null || selected.includes(item.id);
        box.addEventListener("change", () => commit(() => { box.checked = true; }));
        boxes.push(box);
        const name = document.createElement("span");
        name.className = "dvads-rdp-set-camp-name";
        name.textContent = item.name;
        const type = document.createElement("span");
        type.className = "dvads-rdp-set-camp-type";
        type.textContent = item.typeLabel;
        row.append(box, name, type);
        wrap.appendChild(row);
      }
      syncMaster();
      campListEl.appendChild(wrap);
    };
    makeGroup("검색광고", lists.sa, s.saCampaignIds, "saCampaignIds", true);
    makeGroup("디스플레이", lists.gfa, s.gfaCampaignIds, "gfaCampaignIds", false);
    if (!campListEl.hasChildNodes()) campListEl.textContent = "캠페인이 없어요";
    requestAnimationFrame(() => position());
  }

  settingsBtn.addEventListener("click", () => void openSettings());
  el.querySelector(".dvads-rdp-set-back")?.addEventListener("click", () => showSettings(false));

  // ── 프리셋 버튼 ──
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dvads-rdp-preset";
    b.dataset.preset = p;
    b.textContent = PRESET_LABELS[p];
    b.addEventListener("click", () => {
      const r = rangeForPreset(p, today);
      start = parseIso(r.since);
      end = parseIso(r.until);
      activePreset = p;
      activeField = "start";
      paint();
      scrollToMonth(end.getFullYear(), end.getMonth());
    });
    presetsBox.appendChild(b);
  }
  // 문구 생성 토글은 프리셋 열 하단으로 이동 — 네이버 달력의 "기간 비교" 자리.
  if (opts.showMessageToggle) {
    const group = el.querySelector(".dvads-rdp-msg-group");
    if (group) presetsBox.appendChild(group);
  }

  // ── 월별 달력 빌드 ──
  const months: Array<{ y: number; m: number }> = [];
  {
    let cur = new Date(today.getFullYear(), today.getMonth() - MONTHS_BACK, 1);
    const last = new Date(today.getFullYear(), today.getMonth() + MONTHS_FWD, 1);
    while (cur <= last) {
      months.push({ y: cur.getFullYear(), m: cur.getMonth() });
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
  }
  const monthEls = new Map<string, HTMLElement>();
  for (const { y, m } of months) {
    const sec = document.createElement("div");
    sec.className = "dvads-rdp-month";
    sec.dataset.ym = monthKey(y, m);

    const label = document.createElement("div");
    label.className = "dvads-rdp-mlabel";
    label.textContent = `${y}년 ${String(m + 1).padStart(2, "0")}월`;
    sec.appendChild(label);

    const grid = document.createElement("div");
    grid.className = "dvads-rdp-grid";
    const lead = new Date(y, m, 1).getDay(); // 0=일
    for (let i = 0; i < lead; i++) {
      const blank = document.createElement("span");
      blank.className = "dvads-rdp-blank";
      grid.appendChild(blank);
    }
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "dvads-rdp-day";
      cell.dataset.date = iso(new Date(y, m, d));
      cell.textContent = String(d);
      const isFuture = new Date(y, m, d).getTime() > today.getTime();
      if (isFuture) {
        cell.classList.add("is-disabled");
        cell.disabled = true;
      } else {
        cell.addEventListener("click", () => onDayClick(new Date(y, m, d)));
      }
      grid.appendChild(cell);
    }
    sec.appendChild(grid);
    scrollBox.appendChild(sec);
    monthEls.set(monthKey(y, m), sec);
  }

  function onDayClick(d: Date): void {
    activePreset = null;
    if (activeField === "start") {
      start = d;
      if (end.getTime() < start.getTime()) end = d;
      activeField = "end";
    } else {
      end = d;
      if (end.getTime() < start.getTime()) {
        // 끝이 시작보다 앞이면 시작/끝 교체.
        const tmp = start;
        start = end;
        end = tmp;
      }
      activeField = "start";
    }
    paint();
  }

  // ── 칠하기: 프리셋 활성, from/to, 날짜 셀 범위 강조 ──
  function paint(): void {
    presetsBox.querySelectorAll<HTMLElement>(".dvads-rdp-preset").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.preset === activePreset);
    });
    // 편집 중(focus)인 칸의 값은 덮어쓰지 않는다 — 사용자가 타이핑하던 내용 보존.
    if (document.activeElement !== fieldStart) fieldStart.value = fmtDot(start);
    if (document.activeElement !== fieldEnd) fieldEnd.value = fmtDot(end);
    fieldStart.classList.toggle("is-active", activeField === "start");
    fieldEnd.classList.toggle("is-active", activeField === "end");

    const s = start.getTime();
    const e = end.getTime();
    scrollBox.querySelectorAll<HTMLElement>(".dvads-rdp-day").forEach((cell) => {
      const t = parseIso(cell.dataset.date!).getTime();
      cell.classList.toggle("is-start", t === s);
      cell.classList.toggle("is-end", t === e);
      cell.classList.toggle("is-in-range", t > s && t < e);
      cell.classList.toggle("is-single", s === e && t === s);
    });
  }

  function scrollToMonth(y: number, m: number): void {
    const sec = monthEls.get(monthKey(y, m));
    if (!sec) return;
    // 컨테이너 scrollTop 직접 조정 — scrollIntoView는 호스트 페이지까지 스크롤시킬 수 있어 회피.
    const target = sec.offsetTop - Math.max(0, (scrollBox.clientHeight - sec.offsetHeight) / 2);
    scrollBox.scrollTop = Math.max(0, target);
  }

  // 네비게이션 버튼 — 현재 라벨 기준 월 이동 후 스크롤.
  let navY = end.getFullYear();
  let navM = end.getMonth();
  function clampNav(): void {
    const min = new Date(today.getFullYear(), today.getMonth() - MONTHS_BACK, 1);
    const max = new Date(today.getFullYear(), today.getMonth() + MONTHS_FWD, 1);
    let cur = new Date(navY, navM, 1);
    if (cur < min) cur = min;
    if (cur > max) cur = max;
    navY = cur.getFullYear();
    navM = cur.getMonth();
  }
  function applyNav(): void {
    clampNav();
    navLabel.textContent = `${navY}년 ${String(navM + 1).padStart(2, "0")}월`;
    scrollToMonth(navY, navM);
  }
  el.querySelectorAll<HTMLButtonElement>(".dvads-rdp-nav").forEach((btn) => {
    btn.addEventListener("click", () => {
      const k = btn.dataset.nav;
      if (k === "py") navY -= 1;
      else if (k === "ny") navY += 1;
      else if (k === "pm") navM -= 1;
      else if (k === "nm") navM += 1;
      applyNav();
    });
  });

  // 스크롤 시 상단에 보이는 월로 네비 라벨 동기화.
  // 각 월 섹션 offsetTop은 한 번만 측정해 캐시(레이아웃 확정 후 lazy) + rAF throttle로
  // 매 tick 레이아웃 읽기·맵 조회 제거. 달력 내용은 고정폭이라 mount 후 offsetTop 불변.
  let monthOffsets: Array<{ y: number; m: number; top: number }> | null = null;
  let scrollRaf = 0;
  scrollBox.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!monthOffsets) {
        monthOffsets = months.map(({ y, m }) => ({
          y,
          m,
          top: monthEls.get(monthKey(y, m))!.offsetTop,
        }));
      }
      const top = scrollBox.scrollTop;
      let best: { y: number; m: number } | null = null;
      for (const o of monthOffsets) {
        if (o.top <= top + 8) best = { y: o.y, m: o.m };
        else break;
      }
      if (best) {
        navY = best.y;
        navM = best.m;
        navLabel.textContent = `${navY}년 ${String(navM + 1).padStart(2, "0")}월`;
      }
    });
  });

  // from/to 입력칸 키보드 편집 — 지우고 숫자 입력해 날짜 지정. (네이버 방식)
  // "YYYY.MM.DD" / "YYYY-M-D" / "YYYYMMDD" 등 허용. 커밋(Enter·포커스 해제) 시 파싱·반영.
  const earliest = new Date(today.getFullYear(), today.getMonth() - MONTHS_BACK, 1);
  function parseTyped(s: string): Date | null {
    let y: number, m: number, d: number;
    const parts = s.split(/[^\d]+/).filter(Boolean);
    if (parts.length >= 3) {
      [y, m, d] = parts.map(Number);
    } else {
      const digits = s.replace(/\D/g, "");
      if (digits.length !== 8) return null;
      y = +digits.slice(0, 4); m = +digits.slice(4, 6); d = +digits.slice(6, 8);
    }
    if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, m - 1, d);
    // 02.30 같은 무효 날짜 거르기 (롤오버 검출).
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
    return dt;
  }
  function commitField(field: "start" | "end", input: HTMLInputElement): void {
    let dt = parseTyped(input.value);
    if (!dt) { paint(); return; } // 파싱 실패 → 원래 값 복원
    // 허용 범위로 clamp: 미래 불가(상한 today), 달력 표시 하한.
    if (dt.getTime() > today.getTime()) dt = new Date(today);
    if (dt.getTime() < earliest.getTime()) dt = new Date(earliest);
    activePreset = null;
    if (field === "start") {
      start = dt;
      if (end.getTime() < start.getTime()) end = new Date(start);
    } else {
      end = dt;
      if (end.getTime() < start.getTime()) start = new Date(end);
    }
    paint();
    input.value = fmtDot(field === "start" ? start : end); // focus 중이라 paint가 건너뛴 값 직접 갱신
    scrollToMonth(dt.getFullYear(), dt.getMonth());
  }
  for (const [field, input] of [["start", fieldStart], ["end", fieldEnd]] as const) {
    input.addEventListener("focus", () => { activeField = field; paint(); input.select(); });
    input.addEventListener("blur", () => commitField(field, input));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commitField(field, input); input.select(); }
    });
  }

  // ── 닫기/확정 ──
  // 옆에 함께 떠 있던 설정/행 메뉴(action menu)도 같이 닫는다 (확인·취소 버튼 경로).
  function finish(): void {
    closeAllOpenDropdowns();
    dispose?.();
  }
  async function confirmReport(): Promise<void> {
    // 저장된 토글 상태가 아직 복원 전이면 잠깐 기다린다 — 복원 전에 확인을 누르면
    // 저장은 켜짐인데 기본값(꺼짐)으로 생성되는 경합 방지 (codex P2, 2026-07-22).
    if (opts.showMessageToggle && !msgToggleRestored && !msgToggleTouched) {
      await msgRestorePromise;
    }
    // 리포트 설정도 복원 완료를 기다린다 — 설정 화면을 안 열어도 저장값이 생성에 반영돼야 한다.
    if (opts.settings) await settingsP;
    const author = authorInput.value.trim();
    // 목표 ROAS — 숫자만 취하고 0 이하/무효는 미설정(null) 취급.
    const roasNum = Number(roasInput.value.replace(/[^\d.]/g, ""));
    const targetRoas = Number.isFinite(roasNum) && roasNum > 0 ? roasNum : null;
    const range: DateRange = { since: iso(start), until: iso(end) };
    // 서버(user_settings)에도 반영 — 다른 PC에서도 담당자명이 채워지게. 실패해도 리포트 생성은 진행.
    if (author) {
      void saveReportAuthor(author).catch((e) =>
        console.warn("[dv-ads/report] 담당자명 저장 실패", e),
      );
    }
    // 토글 마지막 상태 저장 — 실패해도 리포트 생성은 진행.
    // 복원 전(restored=false)이고 사용자가 안 만졌으면(touched=false) 저장 생략 —
    // 아직 기본값인 꺼짐이 저장된 켜짐을 덮는 경합 방지 (codex P2, 2026-07-22).
    if (opts.showMessageToggle && (msgToggleTouched || msgToggleRestored)) {
      void saveReportWithMessage(msgToggle.checked).catch((e) =>
        console.warn("[dv-ads/report] 문구 생성 토글 저장 실패", e),
      );
    }
    finish();
    opts.onConfirm(range, author, targetRoas, msgToggle.checked, curSettings ?? undefined);
  }
  // 취소는 반드시 :not(.dvads-rdp-set-back)으로 — 설정 화면의 "돌아가기"도 같은 클래스를 쓰는데
  // DOM상 더 앞에 있어, 그냥 querySelector로 잡으면 핸들러가 그쪽에 붙어 취소가 죽는다(2026-08-07 실사고).
  el.querySelector(".dvads-rdp-cancel:not(.dvads-rdp-set-back)")?.addEventListener("click", finish);
  el.querySelector(".dvads-rdp-confirm")?.addEventListener("click", () => void confirmReport());
  // 담당자명 칸에서 Enter -> 확인과 동일. 핸들러가 없으면 Enter가 호스트 페이지로
  // 전파돼 엉뚱한 동작을 부른다(`e.stopPropagation`). 한글 조합 중 Enter는 무시.
  for (const input of [authorInput, roasInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        e.stopPropagation();
        void confirmReport();
      }
    });
  }

  // ── mount + 위치 + 리스너 ──
  // ★ anchor 위치는 지금(동기) 캡처한다. 호출원이 keepOpen 메뉴라 onClick 직후 메뉴가
  //   재렌더(populate)되며 클릭된 anchor 버튼이 DOM에서 떨어져 나가, 이후 rAF 시점엔
  //   getBoundingClientRect가 0을 반환하기 때문.
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

  paint();
  applyNav();
  // 위치 계산은 layout 확정 후 (rAF).
  requestAnimationFrame(() => {
    position();
    // 초기 스크롤 — 선택 끝 월이 가운데 오게.
    scrollToMonth(end.getFullYear(), end.getMonth());
  });

  // 바깥 클릭/ESC 닫기 (flyout 내부 스크롤은 제외).
  const onDocPointer = (e: MouseEvent | PointerEvent): void => {
    const t = e.target as Node;
    if (el.contains(t) || opts.anchor.contains(t)) return;
    // 옆에 떠 있는 메뉴(행 메뉴/설정 드롭다운) 안을 누른 경우 — 다른 항목으로 갈아타는 중.
    // finish()로 메뉴까지 닫으면 click이 완료되기 전에 버튼이 DOM에서 떨어져 그 항목의
    // onClick이 실행되지 않아 "전부 꺼짐"이 된다. 선택기만 접고 메뉴는 살려 클릭이 진행되게.
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
