/**
 * 내 말투 설정 다이얼로그 (T5.5) — 채팅 이력 붙여넣기 → AI 말투 프롬프트 생성 → 확인/수정 → 저장.
 * 선택 화면의 "내 말투 설정" 버튼에서 진입. 저장 후에는 서버가 compose 때 자동으로 쓴다.
 */

import { showToast } from "@/shared/toast";
import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { distillTone } from "./brief-compose";
import { loadBriefTone, saveBriefTone } from "./brief-tone";

let dispose: (() => void) | null = null;

export function closeBriefToneDialog(): void {
  dispose?.();
  dispose = null;
}

export function openBriefToneDialog(onClose?: () => void): void {
  closeBriefToneDialog();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-brief-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-brief-card";

  const head = document.createElement("div");
  head.className = "dvads-brief-head";
  head.textContent = "대화 스타일 설정";
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "dvads-brief-body";

  const hint1 = document.createElement("div");
  hint1.className = "dvads-brief-tone-hint";
  hint1.textContent = "실제로 보냈던 보고 채팅을 붙여넣어 주세요";
  body.appendChild(hint1);

  const samplesTa = document.createElement("textarea");
  samplesTa.className = "dvads-brief-tone-ta";
  samplesTa.rows = 8;
  samplesTa.placeholder = "예) 안녕하세요:) 지난 30일 동안 ...";
  body.appendChild(samplesTa);

  // 문구 버튼 대신 아래 화살표 하나 — 누르면 위 채팅으로 말투 규칙을 생성해 아래 칸에 채운다.
  const makeBtn = document.createElement("button");
  makeBtn.type = "button";
  makeBtn.className = "dvads-brief-tone-make";
  makeBtn.setAttribute("aria-label", "말투 규칙 생성");
  makeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>';
  body.appendChild(makeBtn);

  const promptTa = document.createElement("textarea");
  promptTa.className = "dvads-brief-tone-ta";
  promptTa.rows = 8;
  promptTa.placeholder = "화살표를 누르면 여기에 말투 규칙이 생겨요. 직접 고칠 수도 있어요";
  body.appendChild(promptTa);

  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "dvads-btn";
  cancel.textContent = "닫기";
  cancel.addEventListener("click", () => { closeBriefToneDialog(); onClose?.(); });
  foot.appendChild(cancel);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "dvads-btn dvads-btn-primary";
  save.textContent = "저장";
  foot.appendChild(save);
  card.appendChild(foot);

  makeBtn.addEventListener("click", () => {
    const samples = samplesTa.value.trim();
    if (samples.length < 50) {
      showToast({ message: "채팅 이력을 조금 더 붙여넣어 주세요 (최소 두세 문장)", variant: "error" });
      return;
    }
    makeBtn.disabled = true;
    makeBtn.classList.add("is-busy");
    void distillTone(samples)
      .then((prompt) => { promptTa.value = prompt; })
      .catch((e) => showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" }))
      .finally(() => {
        makeBtn.disabled = false;
        makeBtn.classList.remove("is-busy");
      });
  });

  save.addEventListener("click", () => {
    const tonePrompt = promptTa.value.trim();
    if (!tonePrompt) {
      showToast({ message: "먼저 화살표 버튼으로 말투 규칙을 만들어 주세요", variant: "error" });
      return;
    }
    save.disabled = true;
    void saveBriefTone({ samples: samplesTa.value.trim(), tonePrompt })
      .then(() => {
        showToast({ message: "말투를 저장했어요. 다음 보고부터 내 말투로 만들어져요", variant: "success" });
        closeBriefToneDialog();
        onClose?.();
      })
      .catch((e) => showToast({ message: String(e instanceof Error ? e.message : e), variant: "error" }))
      .finally(() => { save.disabled = false; });
  });

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  wireBackdropDismiss(backdrop, () => { closeBriefToneDialog(); onClose?.(); });

  // 기존 설정 불러오기 — 있으면 재생성/수정 가능.
  void loadBriefTone().then((rec) => {
    if (!rec) return;
    if (samplesTa.value === "") samplesTa.value = rec.samples;
    if (promptTa.value === "") promptTa.value = rec.tonePrompt;
  });

  dispose = () => backdrop.remove();
}
