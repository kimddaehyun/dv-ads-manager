/**
 * admin-widgets.tsx — admin-ui.tsx에서 쓰는 작은 UI 부품 모음.
 *
 * DV-SEO-Manager(/Users/dh/dvmkt/src/options/admin-panel.tsx)의 ActionMenu/MenuItem/Dropdown
 * 디자인을 이식한 것. 로직은 dv-ads-manager 데이터 모델(profiles: pending/approved/blocked)에 맞게
 * admin-ui.tsx에서 호출한다. 참조 프로젝트의 CheckBox·bulk-action 관련 부품은 이식하지 않았다
 * (이 프로젝트는 사용자 수가 적어 일괄 작업 UI가 필요 없음).
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface DropdownOption {
  value: string;
  label: string;
}

export function Dropdown({
  value,
  options,
  onChange,
  className = "",
  disabled = false,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const handleScroll = () => setOpen(false);
    document.addEventListener("mousedown", handleClick);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open]);

  function toggle() {
    if (disabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left, minWidth: r.width });
    }
    setOpen((v) => !v);
  }

  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        aria-expanded={open}
        className={`inline-flex items-center justify-between gap-2 pl-3.5 pr-3 py-2 text-sm bg-[#f4f5f7] rounded-lg outline-none hover:bg-[#eef0f3] focus:bg-white focus:ring-2 focus:ring-[#E6783B]/30 transition disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-[#f4f5f7] ${className}`}
      >
        <span className={current ? "text-gray-900" : "text-gray-400"}>
          {current?.label ?? "선택"}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
          />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: pos.top, left: pos.left, minWidth: pos.minWidth }}
            className="fixed z-[60] rounded-xl bg-white shadow-[0_4px_16px_rgba(15,23,42,0.08),0_2px_4px_rgba(15,23,42,0.04)] p-1"
          >
            {options.map((o) => {
              const active = o.value === value;
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`block w-full text-left px-3 py-2 text-sm rounded-lg transition ${
                    active
                      ? "bg-[#E6783B]/10 text-[#E6783B] font-medium"
                      : "text-gray-700 hover:bg-[#f4f5f7]"
                  }`}
                >
                  {o.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

export function ActionMenu({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    const handleScroll = () => setOpen(false);
    document.addEventListener("mousedown", handleClick);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    }
    setOpen((v) => !v);
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label="작업"
        aria-expanded={open}
        className="flex items-center justify-center h-8 w-8 rounded-lg text-gray-400 hover:text-[#E6783B] transition"
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="4" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="16" cy="10" r="1.6" />
        </svg>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: pos.top, left: pos.left }}
            className="fixed z-[60] min-w-[140px] rounded-xl bg-white shadow-[0_4px_16px_rgba(15,23,42,0.08),0_2px_4px_rgba(15,23,42,0.04)] p-1"
          >
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </>
  );
}

type MenuTone = "red" | "blue" | "gray";

const TONE_CLASS: Record<MenuTone, string> = {
  red: "text-red-600 hover:bg-red-50",
  blue: "text-blue-700 hover:bg-blue-50",
  gray: "text-gray-700 hover:bg-gray-50",
};

export function MenuItem({
  onClick,
  tone = "gray",
  disabled = false,
  title,
  children,
}: {
  onClick: () => void;
  tone?: MenuTone;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`block w-full text-left px-3 py-2 text-sm rounded-lg transition ${
        disabled ? "text-gray-300 cursor-not-allowed" : TONE_CLASS[tone]
      }`}
    >
      {children}
    </button>
  );
}
