/**
 * 지난 보고 목록/상세 (설계 §7 "AE 화면" 갈래) — 저장된 원본 구조를 그때그때 렌더.
 *
 * 기존 brief 패널 스타일(dvads-brief-*) 재사용. 제목 클릭으로 문구 전문을 펼친다.
 */

import { wireBackdropDismiss } from "@/shared/dialog-dismiss";
import { fetchBriefHistory, type BriefHistoryRecord } from "./brief-history";

let dispose: (() => void) | null = null;

export function closeBriefHistoryPanel(): void {
  dispose?.();
  dispose = null;
}

const ACTION_LABEL: Record<string, string> = {
  raise: "상향", hold: "유지 관찰", lower: "하향", exclude: "제외", ask: "문의", custom: "조정",
};

function actionSummary(rec: BriefHistoryRecord): string {
  if (rec.actions.length === 0) return "조치 없음";
  return rec.actions
    .map((a) => `${String(a.facts["기준"] ?? a.kind)}${a.action ? ` - ${ACTION_LABEL[a.action] ?? "조정"}` : ""}`)
    .join(" · ");
}

export function openBriefHistoryPanel(adAccountNo: number, advertiserName: string, onBack: () => void): void {
  closeBriefHistoryPanel();

  const backdrop = document.createElement("div");
  backdrop.className = "dvads dvads-brief-backdrop";
  const card = document.createElement("div");
  card.className = "dvads-brief-card";

  const head = document.createElement("div");
  head.className = "dvads-brief-head";
  head.textContent = `지난 보고 - ${advertiserName}`;
  card.appendChild(head);

  const body = document.createElement("div");
  body.className = "dvads-brief-body";
  body.textContent = "불러오는 중...";
  card.appendChild(body);

  const foot = document.createElement("div");
  foot.className = "dvads-brief-foot";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "dvads-btn dvads-btn-primary";
  back.textContent = "돌아가기";
  back.addEventListener("click", () => {
    closeBriefHistoryPanel();
    onBack();
  });
  foot.appendChild(back);
  card.appendChild(foot);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  wireBackdropDismiss(backdrop, () => closeBriefHistoryPanel());
  dispose = () => backdrop.remove();

  void fetchBriefHistory(adAccountNo, 20)
    .then((list) => {
      if (!backdrop.isConnected) return; // 이미 닫힘 — 늦게 도착한 렌더 무시
      body.textContent = "";
      if (list.length === 0) {
        body.textContent = "저장된 보고가 아직 없어요. 문구를 복사하면 자동으로 기록됩니다";
        return;
      }
      for (const rec of list) {
        const item = document.createElement("div");
        item.className = "dvads-brief-hist-item";
        const title = document.createElement("div");
        title.className = "dvads-brief-hist-title";
        title.textContent = `${rec.createdAt.slice(0, 10)} 보고 (기간 ${rec.periodSince} ~ ${rec.periodUntil})`;
        item.appendChild(title);
        const sum = document.createElement("div");
        sum.className = "dvads-brief-hist-sum";
        sum.textContent = actionSummary(rec);
        item.appendChild(sum);
        const msg = document.createElement("pre");
        msg.className = "dvads-brief-hist-msg";
        msg.textContent = rec.message;
        msg.hidden = true;
        item.appendChild(msg);
        title.addEventListener("click", () => {
          msg.hidden = !msg.hidden;
        });
        body.appendChild(item);
      }
    })
    .catch((e) => {
      console.warn("[dv-ads/brief] 지난 보고 조회 실패", e);
      if (backdrop.isConnected) body.textContent = "지난 보고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요";
    });
}
