import iconUrl from "@/assets/icon-128.png";
import LicenseUi from "./license-ui";
import DataDisclosure from "./data-disclosure";

const ORANGE = "#E6783B";

export default function Options() {
  return (
    <div className="max-w-2xl mx-auto p-8">
      <header className="flex items-center gap-3 pt-6 mb-3">
        <img
          src={iconUrl}
          alt="디브이 애드 매니저"
          className="w-10 h-10 rounded flex-shrink-0"
        />
        <div>
          <h1 className="text-xl font-bold text-gray-900">
            디브이 애드 매니저 v{__APP_VERSION__}
          </h1>
        </div>
      </header>

      <p className="pt-2 mb-4 pl-2 text-sm text-gray-600">
        본 확장 프로그램은{" "}
        <a
          href="https://ads.naver.com/"
          target="_blank"
          rel="noreferrer"
          className="underline"
          style={{ color: ORANGE }}
        >
          네이버 광고관리자
        </a>
        에 로그인된 상태에서 동작하며, 광고주별 검색광고 API 자격증명이 등록된 계정에서만 입찰가/순위 오버레이가 활성화됩니다.
      </p>

      <LicenseUi />

      <section className="bg-white border rounded-lg p-6 mb-6 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            검색광고 API 자격증명
          </h2>
          <span className="text-[11px] text-gray-400">F011 · 구현 예정</span>
        </div>
        <p className="text-sm text-gray-600">
          대행사 AE가 운영하는 여러 광고주(<code className="font-mono text-xs">customerId</code>)별로 <code className="font-mono text-xs">accessLicense</code>·<code className="font-mono text-xs">secretKey</code>·별칭을 N개 등록·수정·삭제하는 화면이 이 위치에 추가됩니다.
        </p>
        <p className="text-xs text-gray-500">
          자격증명은 <code className="font-mono">chrome.storage.local</code>에만 저장되며 외부로 전송되지 않습니다. 광고주 ID와 매칭되지 않는 계정에서는 파워링크 오버레이가 자동으로 비활성화되며, 매칭된 계정에서만 동작합니다.
        </p>
      </section>

      <DataDisclosure />
    </div>
  );
}
