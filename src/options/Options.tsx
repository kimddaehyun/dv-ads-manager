import iconUrl from "@/assets/icon-128.png";
import LicenseUi from "./license-ui";
import DataDisclosure from "./data-disclosure";
import { CredentialsUi, type CredentialsState, type CredentialsValue } from "./credentials-ui";
import { useState } from "react";

export default function Options() {
  // Phase 2 단계: 더미 상태. Phase 3 Task 008에서 storage 연결.
  const [credState, setCredState] = useState<CredentialsState>("empty");
  const [creds, setCreds] = useState<CredentialsValue | undefined>(undefined);

  return (
    <div className="max-w-2xl mx-auto p-8">
      <header className="flex items-center gap-3 pt-6 mb-2">
        <img src={iconUrl} alt="디브이 애드 매니저" className="w-10 h-10 rounded-lg flex-shrink-0" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">디브이 애드 매니저</h1>
          <p className="text-sm text-gray-500 mt-0.5">네이버 광고 대시보드 보조</p>
        </div>
      </header>

      <p className="pt-3 mb-6 pl-1 text-sm text-gray-500 leading-relaxed">
        본 확장 프로그램은 <a href="https://ads.naver.com/" target="_blank" rel="noreferrer" className="underline text-brand">네이버 광고관리자</a>에 로그인된 상태에서 동작하며, 검색광고 API 키가 등록된 경우에만 입찰가/순위 오버레이가 활성화됩니다.
      </p>

      <div className="space-y-5">
        <LicenseUi />

        <CredentialsUi
          state={credState}
          initial={creds}
          onSubmit={(v) => {
            setCreds(v);
            setCredState("registered");
          }}
          onCancel={() => setCredState("empty")}
          onEdit={() => setCredState("empty")}
          onDelete={() => {
            if (confirm("등록 정보를 삭제할까요? 다시 사용하려면 재등록해야 합니다.")) {
              setCreds(undefined);
              setCredState("empty");
            }
          }}
        />
      </div>

      <div className="mt-8">
        <DataDisclosure />
      </div>
    </div>
  );
}
