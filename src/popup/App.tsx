import iconUrl from "@/assets/icon-128.png";
import { Button } from "@/components/Button";
import { StatusDot } from "@/components/StatusDot";
import { RefreshIcon, ExternalIcon } from "@/icons";
import { useEffect, useRef, useState } from "react";
import { loadCredentials } from "@/shared/searchad";
import { fetchAuthContext, type AuthState } from "@/shared/auth-state";
import type { RefreshActiveTabResponse } from "@/types/messages";

const PRIVACY_URL = "https://kimddaehyun.github.io/dv-ads-legal/";
const ADS_URL = "https://ads.naver.com/";

export type PopupState = "ok" | "no-cred";

export default function App() {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [state, setState] = useState<PopupState>("no-cred");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchAuthContext()
      .then(({ state: s }) => {
        if (cancelled) return;
        setAuthState(s);
        if (s !== "approved") {
          setLoading(false);
          return;
        }
        return loadCredentials()
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
      })
      .catch((e) => {
        console.warn("[popup] fetchAuthContext failed", e);
        if (!cancelled) {
          setAuthState("pending");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="w-[320px] p-6 text-center">
        <p className="text-sm text-gray-500">확인 중...</p>
      </div>
    );
  }

  if (authState !== "approved") {
    return (
      <LockedNotice
        text={
          authState === "pending"
            ? "가입 확인 중이에요. 관리자 승인 후 사용할 수 있어요."
            : "로그인이 필요해요. 설정에서 로그인해 주세요."
        }
      />
    );
  }

  return <PopupView state={state} loading={loading} />;
}

function LockedNotice({ text }: { text: string }) {
  function openOptions() {
    chrome.runtime?.openOptionsPage?.();
    window.close();
  }

  return (
    <div className="w-[320px] flex flex-col items-center gap-4 p-6 text-center">
      <img src={iconUrl} alt="DV" className="w-10 h-10 rounded-lg" />
      <p className="text-sm text-gray-700 leading-relaxed break-keep">{text}</p>
      <Button variant="brand" size="md" block onClick={openOptions}>
        설정 열기
      </Button>
    </div>
  );
}

type RefreshStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; count: number }
  | { kind: "error"; text: string };

export function PopupView({
  state,
  loading = false,
}: {
  state: PopupState;
  loading?: boolean;
}) {
  const [refresh, setRefresh] = useState<RefreshStatus>({ kind: "idle" });
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    };
  }, []);

  function scheduleReset(ms: number) {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => {
      setRefresh({ kind: "idle" });
      resetTimer.current = null;
    }, ms);
  }

  async function onRefresh() {
    if (refresh.kind === "loading") return;
    setRefresh({ kind: "loading" });
    try {
      const res = (await chrome.runtime.sendMessage({
        type: "REFRESH_ACTIVE_TAB",
      })) as RefreshActiveTabResponse | undefined;
      if (res?.ok) {
        setRefresh({ kind: "ok", count: res.count ?? 0 });
        scheduleReset(2500);
      } else {
        setRefresh({
          kind: "error",
          text: res?.error ?? "갱신 실패",
        });
        scheduleReset(4000);
      }
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setRefresh({ kind: "error", text: raw });
      scheduleReset(4000);
    }
  }

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
              <>
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
                      onClick={onRefresh}
                      disabled={refresh.kind === "loading"}
                    >
                      <RefreshIcon className="w-3 h-3" />
                      {refresh.kind === "loading" ? "갱신 중…" : "새로고침"}
                    </Button>
                  )}
                </div>
                {state === "ok" && refresh.kind !== "idle" && refresh.kind !== "loading" && (
                  <p
                    className={`mt-2 text-[11px] ${
                      refresh.kind === "ok" ? "text-gray-500" : "text-red-600"
                    }`}
                  >
                    {refresh.kind === "ok"
                      ? refresh.count > 0
                        ? `${refresh.count}개 키워드 재조회 요청됨`
                        : "활성 탭에 표시 중인 키워드가 없습니다"
                      : refresh.text}
                  </p>
                )}
              </>
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
