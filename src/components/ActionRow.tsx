/**
 * ActionRow — 카드 내부 리스트 아이템 (수정·삭제 등).
 * icon + label + chevron 패턴. hover 시 bg-button-light.
 * 부모는 padding-2의 컨테이너 div로 묶음 (별도 ActionList 컴포넌트 불필요 — div로 충분).
 */

import type { ReactNode, MouseEvent } from "react";

interface ActionRowProps {
  icon?: ReactNode;
  label: string;
  variant?: "default" | "danger";
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
}

export function ActionRow({
  icon,
  label,
  variant = "default",
  onClick,
}: ActionRowProps) {
  const labelColor = variant === "danger" ? "text-state-error" : "text-ink";
  const iconColor = variant === "danger" ? "text-state-error" : "text-gray-500";
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer transition-colors hover:bg-button-light text-sm border-0 bg-transparent text-left"
    >
      {icon && <span className={`inline-flex w-4 h-4 shrink-0 ${iconColor}`}>{icon}</span>}
      <span className={`flex-1 font-medium ${labelColor}`}>{label}</span>
      <span className="text-gray-300 text-base leading-none">›</span>
    </button>
  );
}
