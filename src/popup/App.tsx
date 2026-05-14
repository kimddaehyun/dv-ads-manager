const PRIVACY_URL = "https://kimddaehyun.github.io/dv-tag-legal/";

export default function App() {
  return (
    <div className="w-full flex flex-col">
      <header className="px-4 py-3 border-b bg-white flex items-center justify-between">
        <h1 className="text-sm font-semibold">디브이 애드 매니저</h1>
        <a
          href={PRIVACY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-gray-500 hover:text-gray-800 hover:underline"
        >
          개인정보처리방침
        </a>
      </header>
      <main className="p-4">
        <div className="text-xs text-gray-500">
          광고 대시보드(ads.naver.com)에서 키워드 옆 입찰가·순위가 자동으로 표시됩니다.
          <br />
          API 키 설정은 옵션 페이지에서 진행해주세요.
        </div>
        <button
          type="button"
          className="mt-3 w-full rounded border px-3 py-1.5 text-xs hover:bg-gray-50"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          옵션 열기
        </button>
      </main>
    </div>
  );
}
