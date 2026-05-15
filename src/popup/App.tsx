import iconUrl from "@/assets/icon-128.png";
import { Button } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { RefreshIcon, ExternalIcon } from "@/icons";
import { useState } from "react";

const PRIVACY_URL = "https://kimddaehyun.github.io/dv-ads-legal/";

export type PopupState = "ok" | "no-cred";

export default function App() {
  // Phase 2 단계: 더미. Phase 3 Task 011에서 storage 연결.
  const [state] = useState<PopupState>("ok");

  return <PopupView state={state} />;
}

export function PopupView({ state }: { state: PopupState }) {
  return (
    <div className="w-[340px] bg-bg-soft flex flex-col">
      <header className="px-4 py-3.5 bg-white flex items-center gap-2.5 border-b border-card-border">
        <img src={iconUrl} alt="DV" className="w-6 h-6 rounded-md" />
        <span className="text-sm font-medium text-ink">디브이 애드 매니저</span>
      </header>

      <div className="p-4 space-y-3">
        <div className="bg-white rounded-lg px-4 py-3.5 flex items-center justify-between">
          <span className="text-sm text-gray-500">검색광고 API</span>
          {state === "ok" ? (
            <StatusDot variant="success" size="sm">등록됨</StatusDot>
          ) : (
            <StatusDot variant="warning" size="sm">미등록</StatusDot>
          )}
        </div>
      </div>
      <div className="px-4 pb-3 flex items-center gap-2">
        {state === "ok" ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => chrome.runtime.openOptionsPage()}>
              <ExternalIcon className="w-3 h-3" /> 옵션 열기
            </Button>
            <div className="ml-auto">
              <Button variant="default" size="sm" onClick={() => console.log("refresh")}>
                <RefreshIcon className="w-3 h-3" /> 지금 다시 조회
              </Button>
            </div>
          </>
        ) : (
          <Button variant="brand" block onClick={() => chrome.runtime.openOptionsPage()}>
            <ExternalIcon className="w-3.5 h-3.5" /> 옵션 열기
          </Button>
        )}
      </div>

      <footer className="px-4 py-3 flex items-center justify-end">
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="text-[11px] text-gray-500 hover:text-ink hover:underline">
          개인정보처리방침
        </a>
      </footer>
    </div>
  );
}
