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
      <main className="p-4 space-y-3">
        <div className="text-xs text-gray-500">
          광고관리자(ads.naver.com)에 진입하면 파워링크 키워드 옆에 순위·예상 입찰가가 자동 표시됩니다.
          <br />
          라이선스와 광고주별 API 키 설정은 옵션 페이지에서 진행해주세요.
        </div>
        <button
          type="button"
          className="w-full rounded border px-3 py-1.5 text-xs hover:bg-gray-50"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          옵션 열기
        </button>
      </main>
    </div>
  );
}
