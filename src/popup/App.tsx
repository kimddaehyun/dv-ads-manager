import iconUrl from "@/assets/icon-128.png";
import { Button } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { RefreshIcon, ExternalIcon } from "@/icons";
import { useEffect, useState } from "react";
import { loadCredentials } from "@/lib/searchad";

const PRIVACY_URL = "https://kimddaehyun.github.io/dv-ads-legal/";
const ADS_URL = "https://ads.naver.com/";

export type PopupState = "ok" | "no-cred";

export default function App() {
  const [state, setState] = useState<PopupState>("no-cred");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadCredentials()
      .then((c) => {
        if (cancelled) return;
        setState(c ? "ok" : "no-cred");
      })
      .catch((e) => {
        console.warn("[popup] loadCredentials failed", e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <PopupView state={state} loading={loading} />;
}

export function PopupView({
  state,
  loading = false,
}: {
  state: PopupState;
  loading?: boolean;
}) {
  function openOptions() {
    chrome.runtime?.openOptionsPage?.();
    window.close();
  }

  function openAds() {
    void chrome.tabs?.create?.({ url: ADS_URL });
    window.close();
  }

  return (
    <div className="w-[340px] flex flex-col">
      <header className="px-4 py-3 border-b border-card-border bg-white flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <img src={iconUrl} alt="DV" className="w-6 h-6 rounded-md" />
          <span className="text-sm font-semibold text-gray-900">디브이 애드 매니저</span>
        </div>
        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-gray-500 hover:text-gray-800 hover:underline"
        >
          개인정보처리방침
        </a>
      </header>

      <main className="p-4 space-y-4">
        <section>
          <h2 className="text-xs font-medium text-gray-600 mb-2">검색광고 API</h2>
          <div className="bg-white rounded-xl shadow-card px-4 py-3.5">
            {loading ? (
              <p className="text-sm text-gray-500">확인 중…</p>
            ) : (
              <div className="flex items-center justify-between">
                <Row
                  label="상태"
                  value={
                    state === "ok" ? (
                      <StatusDot variant="success" size="sm">등록됨</StatusDot>
                    ) : (
                      <StatusDot variant="warning" size="sm">미등록</StatusDot>
                    )
                  }
                />
                {state === "ok" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => console.log("refresh")}
                  >
                    <RefreshIcon className="w-3 h-3" /> 새로고침
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>

        <div className="space-y-2">
          <Button variant="brand" size="lg" block onClick={openOptions}>
            <ExternalIcon className="w-3.5 h-3.5" /> 설정 페이지 열기
          </Button>
          <Button variant="secondary" size="lg" block onClick={openAds}>
            네이버 광고관리자 열기
          </Button>
        </div>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-gray-500 w-12">{label}</span>
      <span className="text-gray-800">{value}</span>
    </div>
  );
}
