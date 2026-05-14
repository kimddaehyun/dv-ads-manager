import type { ReactNode } from "react";

interface DemoSectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function DemoSection({ title, description, children }: DemoSectionProps) {
  return (
    <section>
      <header className="mb-3 px-1">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500">
          {title}
        </h2>
        {description && (
          <p className="text-xs text-gray-500 mt-1">{description}</p>
        )}
      </header>
      <div className="bg-white rounded-lg p-6">{children}</div>
    </section>
  );
}
