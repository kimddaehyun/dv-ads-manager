import iconUrl from "@/assets/icon-128.png";
import { Button } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { RefreshIcon, ExternalIcon, KeyIcon } from "@/icons";
import { useState } from "react";

const PRIVACY_URL = "https://kimddaehyun.github.io/dv-tag-legal/";

type PopupState = "ok" | "no-cred" | "no-license";

export default function App() {
  // Phase 2 단계: 더미. Phase 3 Task 009에서 license.ts / Task 011에서 storage 연결.
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

      {state === "no-license" ? <NoLicenseView /> : <ActiveView state={state} />}

      <footer className="px-4 py-3 flex items-center justify-end">
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer" className="text-[11px] text-gray-500 hover:text-ink hover:underline">
          개인정보처리방침
        </a>
      </footer>
    </div>
  );
}

function ActiveView({ state }: { state: "ok" | "no-cred" }) {
  return (
    <>
      <div className="p-4 space-y-3">
        <div className="bg-white rounded-lg px-5 py-5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">라이선스</div>
          <div className="mt-2 text-xl font-semibold text-ink leading-tight">
            <StatusDot variant="success">활성</StatusDot>
          </div>
          {state === "ok" && (
            <div className="mt-3 flex flex-wrap gap-x-4 text-xs text-gray-500">
              <span>등급 <b className="text-ink font-mono font-medium">basic</b></span>
              <span>만료 <b className="text-ink font-mono font-medium">2026-12-31</b></span>
              <span>검증 <b className="text-ink font-medium">3분 전</b></span>
            </div>
          )}
        </div>
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
    </>
  );
}

function NoLicenseView() {
  return (
    <div className="m-4 bg-white rounded-lg px-6 py-8 text-center">
      <div className="w-11 h-11 mx-auto mb-3.5 rounded-lg bg-button-light text-gray-500 flex items-center justify-center">
        <KeyIcon className="w-5 h-5" />
      </div>
      <h4 className="text-base font-semibold text-ink mb-1 tracking-tight">라이선스 미설정</h4>
      <p className="text-xs text-gray-500 leading-relaxed mb-5">
        디브이 애드 매니저를 사용하려면<br />라이선스 키 등록이 필요합니다.
      </p>
      <Button variant="brand" block onClick={() => chrome.runtime.openOptionsPage()}>
        <ExternalIcon className="w-3.5 h-3.5" /> 옵션 열기
      </Button>
    </div>
  );
}
