import iconUrl from "@/assets/icon-128.png";
import DataDisclosure from "./data-disclosure";
import { AccountCard } from "./account-ui";
import { CredentialsUi, type CredentialsState, type CredentialsValue } from "./credentials-ui";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { useEffect, useState } from "react";
import { loadCredentials, saveCredentials, clearCredentials } from "@/shared/searchad";
import { clearAllCaches } from "@/shared/cache-prune";
import type { AuthState } from "@/shared/auth-state";

const APP_VERSION = "v" + (chrome?.runtime?.getManifest?.()?.version ?? "0.0.0");
const SUGGEST_MAILTO = "mailto:dvcompany.dev@gmail.com?subject=%5B%EB%94%94%EB%B8%8C%EC%9D%B4%20%EC%95%A0%EB%93%9C%20%EB%A7%A4%EB%8B%88%EC%A0%80%5D%20%EA%B8%B0%EB%8A%A5%20%EC%A0%9C%EC%95%88";

export default function Options() {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const approved = authState === "approved";
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

  // F-Brief 이용 코드 — 사내 발급 코드를 chrome.storage.local(brief_token)에 저장.
  // "토큰"/"API 키" 같은 영문 기술용어는 사용자 노출 텍스트에 쓰지 않는다.
  const [briefCode, setBriefCode] = useState("");
  const [briefCodeSaved, setBriefCodeSaved] = useState(false);

  useEffect(() => {
    chrome.storage.local.get("brief_token").then((r) => {
      if (typeof r.brief_token === "string" && r.brief_token) {
        setBriefCode(r.brief_token);
        setBriefCodeSaved(true);
      }
    });
  }, []);

  async function handleSaveBriefCode() {
    const v = briefCode.trim();
    if (!v) {
      await chrome.storage.local.remove("brief_token");
      setBriefCodeSaved(false);
      return;
    }
    await chrome.storage.local.set({ brief_token: v });
    setBriefCodeSaved(true);
  }

  const [clearingCache, setClearingCache] = useState(false);
  const [cacheCleared, setCacheCleared] = useState<number | null>(null);

  async function handleClearCache() {
    if (
      !confirm(
        "저장된 캐시(키워드 시세, 다계정 데이터 등)를 모두 삭제할까요?\n다음 사용 시 자동으로 다시 받아옵니다. 별칭·추가된 계정 등 사용자 설정은 유지됩니다.",
      )
    ) {
      return;
    }
    setClearingCache(true);
    setCacheCleared(null);
    try {
      const r = await clearAllCaches();
      setCacheCleared(r.removed);
    } catch (e) {
      console.warn("[options] clearAllCaches failed", e);
      alert("캐시 삭제에 실패했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      setClearingCache(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto p-10">
      <header className="flex items-center gap-3 pt-6 mb-3">
        <img
          src={iconUrl}
          alt="디브이 애드 매니저"
          className="w-10 h-10 rounded-lg flex-shrink-0"
        />
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            디브이 애드 매니저 {APP_VERSION}
          </h1>
        </div>
      </header>

      {approved && (
        <p className="pt-2 mb-6 pl-2 text-sm text-gray-600">
          본 확장 프로그램은{" "}
          <a
            href="https://ads.naver.com/"
            target="_blank"
            rel="noreferrer"
            className="underline text-brand"
          >
            네이버 광고관리자
          </a>
          에 로그인된 상태에서만 사용 가능하며, 검색광고 API 키가 등록된 경우에만 입찰가/순위 오버레이가 활성화됩니다.
        </p>
      )}

      <AccountCard onAuthChange={setAuthState} />

      {approved && (
        <>
          <Card className="mb-6">
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
          </Card>

          <Card className="mb-6">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-gray-900">보고 문구 이용 코드</h2>
                <p className="mt-1.5 text-sm text-gray-600 leading-relaxed">
                  사내에서 발급받은 코드를 입력하면 보고 문구를 만들 수 있어요.
                </p>
                <input
                  type="password"
                  value={briefCode}
                  onChange={(e) => {
                    setBriefCode(e.target.value);
                    setBriefCodeSaved(false);
                  }}
                  placeholder="발급받은 코드 붙여넣기"
                  className="mt-3 w-full max-w-md h-9 px-3 rounded-lg border border-gray-300 text-sm focus:outline-none focus:border-brand"
                />
                {briefCodeSaved && (
                  <p className="mt-2 text-sm text-brand font-medium">등록되어 있어요.</p>
                )}
              </div>
              <Button variant="secondary" onClick={handleSaveBriefCode}>
                저장
              </Button>
            </div>
          </Card>

          <Card className="mb-6">
            <div className="flex items-start justify-between gap-6">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-gray-900">캐시 삭제</h2>
                <p className="mt-1.5 text-sm text-gray-600 leading-relaxed">
                  저장된 계정 데이터를 모두 비웁니다.
                </p>
                {cacheCleared !== null && (
                  <p className="mt-2 text-sm text-brand font-medium">
                    {cacheCleared > 0
                      ? `캐시 ${cacheCleared}개 항목 삭제됨.`
                      : "삭제할 캐시가 없어요."}
                  </p>
                )}
              </div>
              <Button
                variant="secondary"
                onClick={handleClearCache}
                disabled={clearingCache}
              >
                {clearingCache ? "삭제 중..." : "캐시 삭제"}
              </Button>
            </div>
          </Card>

          <DataDisclosure />

          <section className="mt-6 px-8 py-[37px] text-center bg-brand">
            <h2 className="text-xl font-bold text-white">
              필요한 기능이 있으신가요?
            </h2>
            <p className="mt-2 text-sm text-white/85">
              원하는 기능, 개선이 필요한 부분 - 무엇이든 알려주세요.
            </p>
            <a
              href={SUGGEST_MAILTO}
              className="mt-5 inline-flex items-center gap-1.5 h-10 px-5 rounded-lg bg-white text-sm font-medium text-brand hover:bg-white/95 transition"
            >
              디브이팀에게 제안하기
              <span aria-hidden="true">→</span>
            </a>
          </section>
        </>
      )}
    </div>
  );
}
