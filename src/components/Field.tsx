/**
 * Field — label + input wrapper + 에러 텍스트 슬롯.
 * Input 컴포넌트와 페어로 사용. 단독 input/select 트리거에도 적용 가능.
 *
 * variants:
 *   default — 옵션 표준 라벨 (text-sm font-medium text-gray-800)
 *   compact — 인증 폼 작은 라벨 (text-xs font-medium text-gray-700)
 */

import type { ReactNode } from "react";

export type FieldVariant = "default" | "compact";

interface FieldProps {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  rightSlot?: ReactNode;
  variant?: FieldVariant;
  children: ReactNode;
}

export function Field({
  label,
  required = false,
  error,
  hint,
  rightSlot,
  variant = "default",
  children,
}: FieldProps) {
  const labelClass =
    variant === "compact"
      ? "text-xs font-medium text-gray-700"
      : "text-sm font-medium text-gray-800";
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between mb-1">
        <label className={labelClass}>
          {label}
          {required && <span className="text-brand ml-0.5">*</span>}
        </label>
        {rightSlot}
      </div>
      {children}
      {error && (
        <p className="mt-1 text-xs text-state-error">{error}</p>
      )}
      {hint && !error && (
        <p className="mt-1 text-xs text-gray-500">{hint}</p>
      )}
    </div>
  );
}
