/**
 * Badge — 알약 모양 라벨.
 * h-5 / text-xs / rounded-full / px-2.
 * bg-{X}-subtle + text-{X} 패턴 (DESIGN.md §4.5).
 */

import type { ReactNode } from "react";

export type BadgeVariant =
  | "success"
  | "warning"
  | "error"
  | "info"
  | "neutral"
  | "brand";

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
}

const CLASS: Record<BadgeVariant, string> = {
  success: "bg-state-success/10 text-state-success",
  warning: "bg-state-warning/10 text-state-warning",
  error:   "bg-state-error/10 text-state-error",
  info:    "bg-state-info/10 text-state-info",
  neutral: "bg-state-neutral/10 text-state-neutral",
  brand:   "bg-brand/10 text-brand",
};

export function Badge({ variant = "neutral", children }: BadgeProps) {
  return (
    <span className={`inline-flex items-center h-5 px-2 text-xs font-medium rounded-full leading-none ${CLASS[variant]}`}>
      {children}
    </span>
  );
}
