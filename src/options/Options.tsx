import { useEffect, useState } from "react";
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  fetchVolumes,
  type SearchadCredentials,
} from "@/lib/searchad";
import { clearCache } from "@/lib/volume-cache";
import { friendlyApiError } from "@/lib/friendly-error";
import iconUrl from "@/assets/icon-128.png";
import LicenseUi from "./license-ui";
import DataDisclosure from "./data-disclosure";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "testing" }
  | { kind: "test-ok" }
  | { kind: "test-fail"; message: string };

export default function Options() {
  const [customerId, setCustomerId] = useState("");
  const [accessLicense, setAccessLicense] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    loadCredentials().then((c) => {
      if (c) {
        setCustomerId(c.customerId);
        setAccessLicense(c.accessLicense);
        setSecretKey(c.secretKey);
        setHasExisting(true);
      }
    });
  }, []);

  function makeCred(): SearchadCredentials {
    return {
      customerId: customerId.trim(),
      accessLicense: accessLicense.trim(),
      secretKey: secretKey.trim(),
    };
  }

  function valid(): boolean {
    return Boolean(customerId.trim() && accessLicense.trim() && secretKey.trim());
  }

  async function handleSave() {
    if (!valid()) return;
    setStatus({ kind: "saving" });
    await saveCredentials(makeCred());
    setHasExisting(true);
    setStatus({ kind: "saved" });
    setTimeout(() => setStatus({ kind: "idle" }), 2000);
  }

  async function handleTest() {
    if (!valid()) return;
    setStatus({ kind: "testing" });
    try {
      await fetchVolumes(["사과"], makeCred());
      setStatus({ kind: "test-ok" });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.warn("[options] test failed", e);
      setStatus({ kind: "test-fail", message: friendlyApiError(raw, "test") });
    }
  }

  async function handleClearAll() {
    if (!confirm("저장된 키와 캐시를 모두 삭제할까요?")) return;
    await clearCredentials();
    await clearCache();
    setCustomerId("");
    setAccessLicense("");
    setSecretKey("");
    setHasExisting(false);
    setStatus({ kind: "idle" });
  }

  return (
    <div className="max-w-2xl mx-auto p-8">
      <header className="flex items-center gap-3 pt-6 mb-3">
        <img
          src={iconUrl}
          alt="디브이마케팅"
          className="w-10 h-10 rounded flex-shrink-0"
        />
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            디브이 애드 매니저 v{__APP_VERSION__}
          </h1>
        </div>
      </header>

      <p className="pt-2 mb-4 pl-2 text-sm text-gray-600">
        본 확장 프로그램은{" "}
        <a
          href="https://ads.naver.com/"
          target="_blank"
          rel="noreferrer"
          className="underline"
          style={{ color: "#E6783B" }}
        >
          네이버 광고관리자
        </a>
        에 로그인된 상태에서 동작하며, 쇼핑 순위 조회 시에는{" "}
        <a
          href="https://sell.smartstore.naver.com/"
          target="_blank"
          rel="noreferrer"
          className="underline"
          style={{ color: "#E6783B" }}
        >
          스마트스토어센터
        </a>{" "}
        브랜드 계정 로그인이 추가로 필요합니다.
      </p>

      <LicenseUi />

      <section className="bg-white border rounded-lg p-6 space-y-5">
        <h2 className="text-base font-semibold text-gray-900">API키</h2>
        <Field
          label="CUSTOMER_ID"
          value={customerId}
          onChange={setCustomerId}
          placeholder="1234567"
        />
        <Field
          label="ACCESS_LICENSE"
          value={accessLicense}
          onChange={setAccessLicense}
          placeholder="0100000000abcdef..."
        />
        <Field
          label="SECRET_KEY"
          value={secretKey}
          onChange={setSecretKey}
          placeholder="비밀키"
          type={showSecret ? "text" : "password"}
          rightSlot={
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              {showSecret ? "숨기기" : "보기"}
            </button>
          }
        />

        <div className="flex gap-2 pt-2">
          <button
            onClick={handleSave}
            disabled={!valid() || status.kind === "saving"}
            className="px-4 py-2 text-sm font-medium rounded text-white disabled:bg-gray-300 transition"
            style={{ background: valid() ? "#E6783B" : undefined }}
          >
            {status.kind === "saving" ? "저장 중…" : status.kind === "saved" ? "✓ 저장됨" : "저장"}
          </button>
          <button
            onClick={handleTest}
            disabled={!valid() || status.kind === "testing"}
            className="px-4 py-2 text-sm rounded border border-gray-300 text-gray-700 disabled:opacity-50 hover:bg-gray-50 transition"
          >
            {status.kind === "testing" ? "테스트 중…" : "테스트"}
          </button>
          {hasExisting && (
            <button
              onClick={handleClearAll}
              className="ml-auto px-4 py-2 text-sm rounded border border-red-200 text-red-600 hover:bg-red-50 transition"
            >
              삭제
            </button>
          )}
        </div>

        {status.kind === "test-ok" && (
          <div className="text-sm bg-green-50 text-green-700 border border-green-200 rounded px-3 py-2 flex items-center gap-2">
            <svg
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
              className="flex-shrink-0"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
              />
            </svg>
            <span className="font-medium">연결 성공</span>
          </div>
        )}
        {status.kind === "test-fail" && (
          <div className="text-sm bg-red-50 text-red-700 border border-red-200 rounded px-3 py-2">
            ✗ 연결 실패 - {status.message}
          </div>
        )}

        <div className="pt-5 mt-2 border-t border-gray-200 text-sm text-gray-700 space-y-3">
          <h3 className="font-semibold text-gray-900">API키 발급 방법</h3>
          <ol className="list-decimal pl-5 space-y-1">
            <li>
              <a
                href="https://ads.naver.com/"
                target="_blank"
                rel="noreferrer"
                className="underline"
                style={{ color: "#E6783B" }}
              >
                https://ads.naver.com/
              </a>{" "}
              접속 → 광고관리자 로그인
            </li>
            <li>사이드바 [도구] → "SA API 사용 관리"</li>
            <li>[네이버 검색광고 API 서비스 신청] 클릭</li>
          </ol>
          <p className="text-xs text-gray-500 pt-2">
            요청 한도: 일 1,000회 (1회 요청에 키워드 5개 처리 → 하루 약 5,000개 태그 조회 가능)
            <br />API키는 브라우저에만 저장되며 외부로 전송되지 않습니다.
          </p>
        </div>
      </section>

      <div className="mt-6">
        <DataDisclosure />
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  rightSlot?: React.ReactNode;
}

function Field({ label, hint, value, onChange, placeholder, type = "text", rightSlot }: FieldProps) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <label className="text-sm font-medium text-gray-800">{label}</label>
        {rightSlot}
      </div>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded focus:outline-none focus:border-[#E6783B] font-mono"
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
