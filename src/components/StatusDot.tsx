/**
 * StatusDot — Vercel "● Ready" 패턴.
 * 작은 색점 + 텍스트. 카드 row의 차분한 상태 표시용.
 * `live`만 펄스 애니메이션 (실시간 조회 indicator, DESIGN.md §4.5).
 */

import type { ReactNode } from "react";

export type DotVariant = "success" | "warning" | "error" | "info" | "neutral" | "live";
export type DotSize = "sm" | "md";

interface StatusDotProps {
  variant?: DotVariant;
  size?: DotSize;
  children: ReactNode;
}

const DOT_BG: Record<DotVariant, string> = {
  success: "bg-state-success",
  warning: "bg-state-warning",
  error:   "bg-state-error",
  info:    "bg-state-info",
  neutral: "bg-state-neutral",
  live:    "bg-brand animate-pulse motion-reduce:animate-none",
};

export function StatusDot({ variant = "neutral", size = "md", children }: StatusDotProps) {
  const dotSize = size === "sm" ? "w-1.5 h-1.5" : "w-2 h-2";
  const textSize = size === "sm" ? "text-xs" : "text-sm";
  return (
    <span className={`inline-flex items-center gap-1.5 font-medium ${textSize}`}>
      <span className={`rounded-full ${dotSize} ${DOT_BG[variant]} shrink-0`} />
      {children}
    </span>
  );
}
