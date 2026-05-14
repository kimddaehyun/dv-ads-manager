/**
 * Input — 보더 transparent + bg-white + focus 시 brand ring.
 * 자세한 가이드: docs/DESIGN.md §4.3.
 */

import type { InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  mono?: boolean;
  invalid?: boolean;
}

export function Input({
  mono = false,
  invalid = false,
  className = "",
  ...rest
}: InputProps) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || undefined}
      className={`w-full box-border h-8 px-2.5 text-sm bg-white border border-transparent rounded-lg transition-colors text-ink placeholder:text-gray-400 hover:bg-bg-soft focus-visible:outline-none focus-visible:border-brand focus-visible:ring-[3px] focus-visible:ring-brand/50 focus-visible:bg-white ${
        mono ? "font-mono" : ""
      } ${invalid ? "border-state-error ring-[3px] ring-state-error/10" : ""} ${className}`}
    />
  );
}
