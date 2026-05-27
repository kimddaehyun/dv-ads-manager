/**
 * Card — dvmkt 패턴 (rounded-2xl + 옅은 shadow).
 * 자세한 가이드: docs/DESIGN.md §Component Catalog · Card.
 */

import type { ReactNode } from "react";

export type CardPadding = "default" | "auth" | "sm" | "none";

interface CardProps {
  padding?: CardPadding;
  className?: string;
  children: ReactNode;
}

const PADDING_CLASS: Record<CardPadding, string> = {
  default: "p-9",                  // 메인 카드 — dvmkt 옵션 표준
  auth:    "px-8 pt-8 pb-7",       // 로그인/회원가입 카드 (max-w-md)
  sm:      "p-3",                  // 팝업 작은 박스
  none:    "p-0",
};

export function Card({ padding = "default", className = "", children }: CardProps) {
  return (
    <div className={`bg-white rounded-2xl shadow-card ${PADDING_CLASS[padding]} ${className}`}>
      {children}
    </div>
  );
}
