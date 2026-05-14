/**
 * F011 — 검색광고 API 자격증명 등록·관리 UI.
 *
 * 4가지 상태:
 *   - empty       : 미등록 → 폼 렌더
 *   - registered  : 등록됨 → 마스킹 요약 + 수정·삭제 액션 리스트
 *   - error       : 등록 실패 → 폼 + 에러 메시지 (재시도 의도)
 *   - locked      : 라이선스 미설정 → 폼 비활성 + lock banner
 *
 * Phase 2 단계에서는 props로 상태/콜백 받음 — Phase 3 Task 008에서 부모가 storage 연결.
 */

import { useState } from "react";
import { Button } from "@/components/Button";
import { Card } from "@/components/Card";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { ActionRow } from "@/components/ActionRow";
import { Badge } from "@/components/Badge";
import { PlusIcon, XIcon, EyeIcon, EyeOffIcon, EditIcon, TrashIcon, LockIcon } from "@/icons";

export type CredentialsState = "empty" | "registered" | "error" | "locked";

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

export function CredentialsUi({
  state,
  initial,
  errorMessage,
  onSubmit,
  onCancel,
  onEdit,
  onDelete,
}: CredentialsUiProps) {
  if (state === "locked") {
    return (
      <div>
        <SectionLabel>검색광고 API</SectionLabel>
        <Card>
          <div className="flex items-center gap-2.5 px-4 py-3.5 rounded-lg bg-state-warning/10 text-state-warning text-sm">
            <LockIcon className="w-4 h-4 shrink-0" />
            <span>먼저 라이선스 키를 등록해주세요.</span>
          </div>
        </Card>
      </div>
    );
  }

  if (state === "registered" && initial) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-3 px-1">
          <SectionLabel className="!mb-0 !px-0">검색광고 API</SectionLabel>
          <Badge variant="success">등록됨</Badge>
        </div>
        <Card padding="none">
          <div className="p-6">
            <div className="space-y-3.5">
              <SummaryRow label="customerId" value={initial.customerId} />
              <SummaryRow label="accessLicense" value={maskTail(initial.accessLicense, 4)} />
              <SummaryRow label="secretKey" value="••••••••••••" />
            </div>
          </div>
          <div className="border-t border-card-border p-2">
            <ActionRow icon={<EditIcon />} label="수정" onClick={onEdit} />
            <ActionRow icon={<TrashIcon />} label="삭제" variant="danger" onClick={onDelete} />
          </div>
        </Card>
      </div>
    );
  }

  // empty | error
  return (
    <div>
      <div className="flex items-center gap-2 mb-3 px-1">
        <SectionLabel className="!mb-0 !px-0">검색광고 API</SectionLabel>
        {state === "error" && <Badge variant="error">등록 실패</Badge>}
      </div>
      <Card>
        <CredentialsForm
          initial={initial}
          errorMessage={errorMessage}
          showCancel={state === "error"}
          onSubmit={onSubmit}
          onCancel={onCancel}
        />
      </Card>
    </div>
  );
}

function CredentialsForm({
  initial,
  errorMessage,
  showCancel,
  onSubmit,
  onCancel,
}: {
  initial?: CredentialsValue;
  errorMessage?: string;
  showCancel?: boolean;
  onSubmit?: (v: CredentialsValue) => void;
  onCancel?: () => void;
}) {
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [accessLicense, setAccessLicense] = useState(initial?.accessLicense ?? "");
  const [secretKey, setSecretKey] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [errors, setErrors] = useState<{ customerId?: string; accessLicense?: string; secretKey?: string }>({});

  function submit() {
    const next: typeof errors = {};
    if (!/^\d+$/.test(customerId.trim())) next.customerId = "숫자만 입력해주세요.";
    if (!accessLicense.trim()) next.accessLicense = "필수 입력값이에요.";
    if (!secretKey.trim()) next.secretKey = "필수 입력값이에요.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    onSubmit?.({ customerId: customerId.trim(), accessLicense: accessLicense.trim(), secretKey: secretKey.trim() });
  }

  return (
    <div className="space-y-3.5">
      <div className="grid grid-cols-2 gap-3.5">
        <Field label="customerId" error={errors.customerId}>
          <Input mono placeholder="12345" value={customerId} onChange={(e) => setCustomerId(e.target.value)} invalid={!!errors.customerId} />
        </Field>
        <Field label="accessLicense" error={errors.accessLicense}>
          <Input mono placeholder="0100000000abcdef..." value={accessLicense} onChange={(e) => setAccessLicense(e.target.value)} invalid={!!errors.accessLicense} />
        </Field>
      </div>
      <Field label="secretKey" error={errors.secretKey ?? errorMessage}>
        <div className="flex gap-2 items-stretch">
          <Input
            mono
            type={showSecret ? "text" : "password"}
            placeholder="••••••••"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            invalid={!!errors.secretKey || !!errorMessage}
            className="flex-1"
          />
          <button
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            className="h-8 px-3 text-xs font-medium bg-button-light text-gray-600 rounded-lg cursor-pointer transition-colors hover:bg-button-light-hover inline-flex items-center gap-1.5 border-0"
            aria-label={showSecret ? "비밀값 숨기기" : "비밀값 보기"}
          >
            {showSecret ? <EyeOffIcon className="w-3 h-3" /> : <EyeIcon className="w-3 h-3" />}
            {showSecret ? "숨김" : "표시"}
          </button>
        </div>
      </Field>
      <div className="flex justify-end gap-2 pt-1">
        {showCancel && (
          <Button variant="secondary" onClick={onCancel}>
            <XIcon className="w-3.5 h-3.5" /> 취소
          </Button>
        )}
        <Button variant="brand" onClick={submit}>
          <PlusIcon className="w-3.5 h-3.5" /> 등록
        </Button>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="text-xs text-gray-500 w-28 shrink-0">{label}</span>
      <span className="text-sm font-mono text-ink break-all">{value}</span>
    </div>
  );
}

function SectionLabel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={`text-xs font-medium text-gray-500 mb-3 px-1 ${className}`}>
      {children}
    </h3>
  );
}

function maskTail(s: string, keepLast: number): string {
  if (s.length <= keepLast) return "•".repeat(s.length);
  const visible = s.slice(0, s.length - keepLast);
  return visible + "•".repeat(keepLast);
}
