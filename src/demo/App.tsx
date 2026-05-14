import logoUrl from "@/assets/icon-128.png";

export default function App() {
  return (
    <div className="max-w-4xl mx-auto py-12 px-6 space-y-10">
      <header className="flex items-center gap-3">
        <img src={logoUrl} alt="DV" className="w-10 h-10 rounded-lg" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            디브이 애드 매니저 — 데모
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Phase 2 시안 모음. 빌드 시 dist/에 포함되지 않습니다.
          </p>
        </div>
      </header>

      <div className="space-y-12">
        {/* 시안 섹션들은 후속 Task에서 추가 */}
        <p className="text-sm text-gray-500 italic">
          시안은 다음 Task에서 추가됩니다.
        </p>
      </div>
    </div>
  );
}
