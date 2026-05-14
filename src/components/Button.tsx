/**
 * Button — Vercel Geist strict.
 * - sizes: sm 28h / md 32h / lg 40h
 * - variants: default(검정 95% 케이스) / brand(주황 화면당 1개) / secondary(연회색)
 * - radius 6px, weight 500, NO box-shadow
 * - 자세한 가이드: docs/DESIGN.md §4.1
 */

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "default" | "brand" | "secondary";
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
  default: "bg-ink-warm text-white hover:bg-ink-warm-hover",
  brand: "bg-brand text-white hover:bg-brand-hover",
  secondary: "bg-button-light text-ink-warm hover:bg-button-light-hover",
};

export function Button({
  variant = "default",
  size = "md",
  block = false,
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center font-medium leading-none cursor-pointer transition-colors rounded-md disabled:opacity-40 disabled:cursor-not-allowed ${SIZE_CLASS[size]} ${VARIANT_CLASS[variant]} ${block ? "w-full" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
