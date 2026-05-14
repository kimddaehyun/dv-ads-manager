/**
 * Field — label + input wrapper + 에러 텍스트 슬롯.
 * Input 컴포넌트와 페어로 사용. 단독 input/select 트리거에도 적용 가능.
 */

import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, error, children }: FieldProps) {
  return (
    <label className="flex flex-col gap-1.5 min-w-0">
      <span className="text-xs font-medium text-gray-600 tracking-wide">{label}</span>
      {children}
      {error && <span className="text-xs text-state-error">{error}</span>}
    </label>
  );
}
