import iconUrl from "@/assets/icon-128.png";
import DataDisclosure from "./data-disclosure";
import { CredentialsUi, type CredentialsState, type CredentialsValue } from "./credentials-ui";
import { useEffect, useState } from "react";
import { loadCredentials, saveCredentials, clearCredentials } from "@/lib/searchad";

export default function Options() {
  const [credState, setCredState] = useState<CredentialsState>("empty");
  const [creds, setCreds] = useState<CredentialsValue | undefined>(undefined);
  const [credError, setCredError] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadCredentials()
      .then((stored) => {
        if (cancelled) return;
        if (stored) {
          setCreds(stored);
          setCredState("registered");
        }
      })
      .catch((e) => {
        console.warn("[options] loadCredentials failed", e);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(v: CredentialsValue) {
    try {
      await saveCredentials(v);
      setCreds(v);
      setCredError(undefined);
      setCredState("registered");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setCredError(`저장에 실패했어요: ${msg}`);
      setCredState("error");
    }
  }

  async function handleDelete() {
    if (!confirm("등록 정보를 삭제할까요? 다시 사용하려면 재등록해야 합니다.")) return;
    try {
      await clearCredentials();
      setCreds(undefined);
      setCredError(undefined);
      setCredState("empty");
    } catch (e) {
      console.warn("[options] clearCredentials failed", e);
    }
  }

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
        {loaded && (
          <CredentialsUi
            state={credState}
            initial={creds}
            errorMessage={credError}
            onSubmit={handleSubmit}
            onCancel={() => {
              setCredError(undefined);
              setCredState(creds ? "registered" : "empty");
            }}
            onEdit={() => setCredState("empty")}
            onDelete={handleDelete}
          />
        )}
      </div>

      <div className="mt-8">
        <DataDisclosure />
      </div>
    </div>
  );
}
