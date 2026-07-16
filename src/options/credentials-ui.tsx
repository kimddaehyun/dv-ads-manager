/**
 * F011 — 검색광고 API 자격증명 등록·관리 UI.
 *
 * 디자인은 자매 프로젝트(디브이 SEO 매니저)의 옵션 패턴 1:1 적용:
 *   - 항상 동일한 폼 (등록/수정 분기 없음). 저장된 값이 있으면 미리 채움.
 *   - 액션: [저장] [테스트] (저장된 값이 있으면) [삭제]
 *   - 하단: API 키 발급 방법 안내 박스 (옅은 주황 배경)
 *
 * 자세한 가이드: docs/DESIGN.md §Component Catalog.
 */

import { useState } from "react";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { fetchVolumes } from "@/shared/searchad";
import { friendlyApiError } from "@/shared/friendly-error";

export type CredentialsState = "empty" | "registered" | "error";

export interface CredentialsValue {
  customerId: string;
  accessLicense: string;
  secretKey: string;
}

interface CredentialsUiProps {
  state: CredentialsState;
  initial?: CredentialsValue;
  errorMessage?: string;
  onSubmit?: (v: CredentialsValue) => void;
  onCancel?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

type SaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "testing" }
  | { kind: "test-ok" }
  | { kind: "test-fail"; message: string };

export function CredentialsUi({
  state,
  initial,
  errorMessage,
  onSubmit,
  onDelete,
}: CredentialsUiProps) {
  const hasExisting = state === "registered";

  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [accessLicense, setAccessLicense] = useState(initial?.accessLicense ?? "");
  const [secretKey, setSecretKey] = useState(initial?.secretKey ?? "");
  const [showSecret, setShowSecret] = useState(false);
  const [errors, setErrors] = useState<{ customerId?: string; accessLicense?: string; secretKey?: string }>({});
  const [status, setStatus] = useState<SaveStatus>({ kind: "idle" });

  function valid(): boolean {
    return Boolean(customerId.trim() && accessLicense.trim() && secretKey.trim());
  }

  function makeCred(): CredentialsValue {
    return {
      customerId: customerId.trim(),
      accessLicense: accessLicense.trim(),
      secretKey: secretKey.trim(),
    };
  }

  function handleSave() {
    const next: typeof errors = {};
    if (!/^\d+$/.test(customerId.trim())) next.customerId = "숫자만 입력해주세요.";
    if (!accessLicense.trim()) next.accessLicense = "필수 입력값이에요.";
    if (!secretKey.trim()) next.secretKey = "필수 입력값이에요.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setStatus({ kind: "saving" });
    try {
      onSubmit?.(makeCred());
      setStatus({ kind: "saved" });
      setTimeout(() => setStatus({ kind: "idle" }), 2000);
    } catch {
      setStatus({ kind: "idle" });
    }
  }

  async function handleTest() {
    if (!valid()) return;
    setStatus({ kind: "testing" });
    try {
      await fetchVolumes(["사과"], makeCred());
      setStatus({ kind: "test-ok" });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      console.warn("[credentials-ui] test failed", e);
      setStatus({ kind: "test-fail", message: friendlyApiError(raw, "test") });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between mb-5">
        <h2 className="text-base font-semibold text-gray-900">API키</h2>
      </div>

      <Field
        label="CUSTOMER_ID"
        error={errors.customerId}
      >
        <Input
placeholder="1234567"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          invalid={!!errors.customerId}
        />
      </Field>

      <Field
        label="ACCESS_LICENSE"
        error={errors.accessLicense}
      >
        <Input
placeholder="0100000000abcdef..."
          value={accessLicense}
          onChange={(e) => setAccessLicense(e.target.value)}
          invalid={!!errors.accessLicense}
        />
      </Field>

      <Field
        label="SECRET_KEY"
        error={errors.secretKey ?? errorMessage}
        rightSlot={
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-700"
          >
            {showSecret ? "숨기기" : "보기"}
          </button>
        }
      >
        <Input
type={showSecret ? "text" : "password"}
          placeholder="비밀키"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          invalid={!!errors.secretKey || !!errorMessage}
        />
      </Field>

      <div className="flex gap-2 pt-2">
        <Button
          variant="brand"
          onClick={handleSave}
          disabled={!valid() || status.kind === "saving"}
        >
          {status.kind === "saving"
            ? "저장 중…"
            : status.kind === "saved"
            ? "✓ 저장됨"
            : "저장"}
        </Button>
        <Button
          variant="secondary"
          onClick={handleTest}
          disabled={!valid() || status.kind === "testing"}
        >
          {status.kind === "testing" ? "테스트 중…" : "테스트"}
        </Button>
        {hasExisting && (
          <Button
            variant="destructive"
            onClick={onDelete}
            className="ml-auto"
          >
            삭제
          </Button>
        )}
      </div>

      {status.kind === "test-ok" && (
        <div className="text-sm bg-green-50 text-green-700 rounded-lg px-3 py-2 flex items-center gap-2">
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
        <div className="text-sm bg-red-50 text-red-700 rounded-lg px-3 py-2 whitespace-pre-line break-keep">
          ✗ 연결 실패 - {status.message}
        </div>
      )}

      <div className="mt-2 p-4 rounded-xl bg-[#fdf6f2] text-sm text-gray-700 space-y-3">
        <h3 className="font-semibold text-gray-900">API키 발급 방법</h3>
        <ol className="list-decimal pl-5 space-y-1">
          <li>
            <a
              href="https://ads.naver.com/"
              target="_blank"
              rel="noreferrer"
              className="underline text-brand"
            >
              https://ads.naver.com/
            </a>{" "}
            접속 → 광고관리자 로그인
          </li>
          <li>사이드바 [도구] → "API 사용 관리"</li>
          <li>[네이버 검색광고 API 서비스 신청] 클릭</li>
        </ol>
        <p className="text-xs text-gray-500 pt-1">
          API키는 브라우저에만 저장되며 외부로 전송되지 않습니다.
        </p>
      </div>
    </div>
  );
}
