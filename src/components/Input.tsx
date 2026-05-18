/**
 * Input — dvmkt 패턴.
 * 디폴트 bg-input(#f4f5f7) + 보더 없음 + focus 시 bg-white + ring-2 brand/30.
 * 폰트는 전체 Pretendard 정책으로 통일 — mono 옵션 없음.
 * 자세한 가이드: docs/DESIGN.md §Component Catalog · Input.
 */

import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({
  invalid = false,
  className = "",
  ...rest
}: InputProps) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={`w-full box-border h-10 px-3.5 py-2.5 text-sm bg-input rounded-lg outline-none ring-0 transition text-ink placeholder:text-gray-400 placeholder:font-sans focus:bg-white focus:ring-2 focus:ring-brand/30 ${
        invalid ? "ring-2 ring-state-error/40 bg-white" : ""
      } ${className}`}
    />
  );
}
