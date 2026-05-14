/**
 * Card — v5 flat (보더·그림자 X).
 * 페이지 배경(#fafafa) 위 흰 카드(#fff)로 1% 명도차 contrast.
 * 자세한 가이드: docs/DESIGN.md §4.2.
 */

import type { ReactNode } from "react";

export type CardPadding = "default" | "sm" | "none";

interface CardProps {
  padding?: CardPadding;
  className?: string;
  children: ReactNode;
}

const PADDING_CLASS: Record<CardPadding, string> = {
  default: "p-6",
  sm: "py-5 px-6",
  none: "p-0",
};

export function Card({ padding = "default", className = "", children }: CardProps) {
  return (
    <div className={`bg-white rounded-lg ${PADDING_CLASS[padding]} ${className}`}>
      {children}
    </div>
  );
}
