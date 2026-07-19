/**
 * 이슈 기준 설정 다이얼로그 — 프리셋 3단계(민감하게/보통/느슨하게) + 직접 설정.
 * 선택 화면의 "이슈 기준" 버튼에서 진입. 저장하면 호출부가 후보를 다시 계산한다.
 */

import { showToast } from "@/shared/toast";
import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { type BriefThresholds } from "./brief-rules";
import { resolveThresholds, SENSITIVITY_LABEL, type BriefSensitivity } from "./brief-thresholds";

const PRESET_DESC: Record<BriefSensitivity, string> = {
  sensitive: "작은 변화도 이슈로 잡아요",
  normal: "광고비 규모에 맞춰 자동 조정돼요",
  loose: "굵직한 이슈만 잡아요",
  custom: "기준값을 직접 정해요",
};

/** 직접 설정 입력 필드 정의 — 라벨은 비개발자 기준. */
const FIELDS: Array<{ key: keyof BriefThresholds; label: string; unit: string; step?: string }> = [
  { key: "costFloor", label: "이슈로 볼 최소 광고비", unit: "원" },
  { key: "skewRatio", label: "격차 기준 (좋은 쪽이 나쁜 쪽의 몇 배)", unit: "배", step: "0.1" },
  { key: "lowCtrPct", label: "낮은 클릭률 기준", unit: "%", step: "0.1" },
  { key: "adImpFloor", label: "소재 판단 최소 노출", unit: "회" },
  { key: "lowRankFloor", label: "낮은 순위 기준", unit: "위" },
  { key: "revenueDropFloor", label: "상품 매출 감소 기준", unit: "원" },
];

export interface BriefThresholdDialogOpts {
  sensitivity: BriefSensitivity;
  custom: Partial<BriefThresholds>;
  /** 자동 보정 재료 — 이 기간 총광고비. */
  totalCost: number;
  onSave: (sensitivity: BriefSensitivity, custom: Partial<BriefThresholds>) => void;
  onClose?: () => void;
}

let dispose: (() => void) | null = null;

export function closeBriefThresholdDialog(): void {
  dispose?.();
  dispose = null;
}

export function openBriefThresholdDialog(opts: BriefThresholdDialogOpts): void {
  closeBriefThresholdDialog();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-brief-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-brief-card";

  const head = document.createElement("div");
  head.className = "dvads-brief-head";
  head.textContent = "이슈 기준";
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "dvads-brief-body";

  let sensitivity: BriefSensitivity = opts.sensitivity;

  // 프리셋 칩 — 하나만 선택.
  const chipRow = document.createElement("div");
  chipRow.className = "dvads-brief-preset-row";
  const desc = document.createElement("div");
  desc.className = "dvads-brief-pick-sub";
  desc.style.margin = "6px 0 0";

  const customWrap = document.createElement("div");
  customWrap.style.marginTop = "12px";

  const chips = (Object.keys(SENSITIVITY_LABEL) as BriefSensitivity[]).map((s) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dvads-brief-preset-chip";
    chip.textContent = SENSITIVITY_LABEL[s];
    chip.addEventListener("click", () => {
      sensitivity = s;
      refresh();
    });
    chipRow.appendChild(chip);
    return { s, chip };
  });

  // 직접 설정 입력 — 현재 해석값을 기본으로 채워 "지금 기준이 얼마인지"를 그대로 보여준다.
  const inputs = new Map<keyof BriefThresholds, HTMLInputElement>();
  for (const f of FIELDS) {
    const row = document.createElement("div");
    row.className = "dvads-brief-custom-row";
    const label = document.createElement("span");
    label.textContent = f.label;
    row.appendChild(label);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    if (f.step) input.step = f.step;
    input.className = "dvads-brief-custom-input";
    row.appendChild(input);
    const unit = document.createElement("span");
    unit.textContent = f.unit;
    unit.className = "dvads-brief-custom-unit";
    row.appendChild(unit);
    customWrap.appendChild(row);
    inputs.set(f.key, input);
  }

  const refresh = () => {
    for (const { s, chip } of chips) chip.classList.toggle("is-on", s === sensitivity);
    desc.textContent = PRESET_DESC[sensitivity];
    customWrap.style.display = sensitivity === "custom" ? "" : "none";
    if (sensitivity === "custom") {
      // 빈 칸은 현재 해석값으로 채운다 — 0에서 시작하면 기준이 뭔지 알 수 없다.
      const resolved = resolveThresholds({ sensitivity: "custom", custom: opts.custom, totalCost: opts.totalCost });
      for (const [key, input] of inputs) {
        if (input.value === "") input.value = String(resolved[key]);
      }
    }
  };

  body.appendChild(chipRow);
  body.appendChild(desc);
  body.appendChild(customWrap);
  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dvads-btn";
  cancel.textContent = "닫기";
  cancel.addEventListener("click", () => { closeBriefThresholdDialog(); opts.onClose?.(); });
  foot.appendChild(cancel);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "dvads-btn dvads-btn-primary";
  save.textContent = "저장";
  save.addEventListener("click", () => {
    let custom: Partial<BriefThresholds> = {};
    if (sensitivity === "custom") {
      for (const [key, input] of inputs) {
        const v = Number(input.value);
        if (Number.isFinite(v) && v > 0) custom[key] = v;
      }
      if (Object.keys(custom).length === 0) {
        showToast({ message: "기준값을 입력해 주세요", variant: "error" });
        return;
      }
    }
    closeBriefThresholdDialog();
    opts.onSave(sensitivity, custom);
  });
  foot.appendChild(save);
  card.appendChild(foot);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  wireBackdropDismiss(backdrop, () => { closeBriefThresholdDialog(); opts.onClose?.(); });

  refresh();
  dispose = () => backdrop.remove();
}
