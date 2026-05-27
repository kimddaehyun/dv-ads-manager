/**
 * Button — dvmkt 패턴.
 * - sizes: sm h-7 / md h-8 / lg h-10 (전체 폭은 block prop)
 * - variants:
 *     brand      = 주황 fill (primary 1차 액션 — 화면당 1~2개)
 *     secondary  = bg-gray-100 (보조 액션 · 취소 · 테스트)
 *     destructive= bg-red-50 (삭제 등 파괴적 액션)
 *     ghost      = transparent (text-only, 모달 닫기 등)
 * - radius rounded-lg (8px), weight 500
 * - disabled: opacity-50 + cursor-not-allowed (배경색 변경 X)
 * - 자세한 가이드: docs/DESIGN.md §Component Catalog · Buttons
 *
 * NOTE: 이전 default(검정 ink-warm) variant는 폐기. 자매 프로젝트(디브이 SEO 매니저)와
 *       디자인 시스템 통일 결과 primary는 주황 단일.
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "brand" | "secondary" | "destructive" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  children: ReactNode;
}

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[13px] gap-1",
  md: "h-8 px-3 text-sm gap-1.5",
  lg: "h-10 px-4 text-sm gap-2",
};

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  brand:       "bg-brand text-white hover:enabled:brightness-95",
  secondary:   "bg-gray-100 text-gray-700 hover:bg-gray-200/70",
  destructive: "bg-red-50 text-red-600 hover:bg-red-100/70",
  ghost:       "bg-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-100/60",
};

export function Button({
  variant = "brand",
  size = "md",
  block = false,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center font-medium leading-none cursor-pointer transition-colors rounded-lg disabled:opacity-50 disabled:cursor-not-allowed ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]} ${block ? "w-full" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
