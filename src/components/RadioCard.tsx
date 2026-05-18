/**
 * RadioCard — 파트너사 / 일반 사용자 식 큰 라디오 카드 (회색 fill + checked 시 brand tint).
 * 자세한 가이드: docs/DESIGN.md §Component Catalog · Radio Card.
 */

import type { ReactNode } from "react";

interface RadioCardProps {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
}

export function RadioCard({
  name,
  checked,
  onChange,
  title,
  description,
}: RadioCardProps) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-xl bg-input px-[18px] py-[18px] cursor-pointer hover:bg-input-hover has-[:checked]:bg-brand/10 transition">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="peer sr-only"
      />
      <div className="grid gap-1 font-normal min-w-0">
        <p className="text-sm leading-none font-medium text-gray-900">{title}</p>
        {description && <p className="text-xs text-gray-500">{description}</p>}
      </div>
      <span className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm bg-white shadow-[inset_0_0_0_1px_rgba(15,23,42,0.12)] peer-checked:bg-brand peer-checked:shadow-none peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40 transition">
        <CheckIcon />
      </span>
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
