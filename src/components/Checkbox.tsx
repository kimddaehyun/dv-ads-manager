/**
 * Checkbox — peer sr-only + svg 패턴.
 * 라벨과 함께 사용. checked 시 brand 주황.
 * 자세한 가이드: docs/DESIGN.md §Component Catalog · Checkbox.
 */

import type { ReactNode, ChangeEvent } from "react";

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}

export function Checkbox({
  checked,
  onChange,
  children,
  className = "",
  disabled = false,
}: CheckboxProps) {
  return (
    <label
      className={`flex items-center gap-2 cursor-pointer text-xs text-gray-700 select-none ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.12)] peer-checked:bg-brand peer-checked:shadow-none peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 transition"
      >
        <CheckIcon />
      </span>
      <span>{children}</span>
    </label>
  );
}

function CheckIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 20 20"
      fill="none"
      stroke="white"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 11 8 15 16 5" />
    </svg>
  );
}
