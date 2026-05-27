/**
 * Tabs — 2개 옵션 토글 (로그인 / 회원가입 식).
 * 회색 컨테이너 + 슬라이딩 흰 pill 인디케이터 + 200ms ease-out 전이.
 * 자세한 가이드: docs/DESIGN.md §Component Catalog · Tabs.
 */

interface TabOption<T extends string> {
  value: T;
  label: string;
}

interface TabsProps<T extends string> {
  value: T;
  options: [TabOption<T>, TabOption<T>];
  onChange: (v: T) => void;
}

export function Tabs<T extends string>({ value, options, onChange }: TabsProps<T>) {
  const activeIndex = options.findIndex((o) => o.value === value);
  return (
    <div className="relative grid grid-cols-2 p-1 bg-input rounded-lg text-sm">
      <span
        aria-hidden
        className={`pointer-events-none absolute top-1 bottom-1 left-1 w-[calc(50%-0.25rem)] bg-white rounded-md shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition-transform duration-200 ease-out ${
          activeIndex === 0 ? "translate-x-0" : "translate-x-full"
        }`}
      />
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`relative z-10 py-1.5 rounded-md transition-colors ${
              active
                ? "text-gray-900 font-medium"
                : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
