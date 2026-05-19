import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

export default defineManifest({
  manifest_version: 3,
  name: "디브이 애드 매니저",
  short_name: "디브이 애드 매니저",
  version: pkg.version,
  description: pkg.description,
  action: {
    default_popup: "src/popup/index.html",
    default_title: "디브이 애드 매니저",
  },
  icons: {
    "16": "src/assets/icon-128.png",
    "48": "src/assets/icon-128.png",
    "128": "src/assets/icon-128.png",
  },
  permissions: ["storage"],
  host_permissions: [
    "https://ads.naver.com/*",
    "https://api.searchad.naver.com/*",
  ],
  options_ui: {
    page: "src/options/index.html",
    open_in_tab: true,
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  content_scripts: [
    {
      matches: ["https://ads.naver.com/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      // 광고관리자는 본문 영역을 same-origin iframe으로 렌더할 가능성 — period-compare
      // 모듈의 fetch 캡처 listener가 iframe 안에서도 동작해야 한다. F001 키워드 배지는
      // 키워드 셀이 있는 frame에만 mount되므로 noop이라 부작용 없음.
      all_frames: true,
    },
    {
      // F-PoP — MAIN world 에서 페이지의 fetch를 패치해 stats 요청을 캡처.
      // document_start로 페이지의 React 부트 전에 패치 적용 — 첫 요청부터 잡힘.
      // ISOLATED 콘텐츠 스크립트(src/content/index.ts)와는 CustomEvent로 통신.
      // all_frames: true — iframe 내부 React app의 fetch도 패치 (필수).
      matches: ["https://ads.naver.com/*"],
      js: ["src/content/fetch-patch-main.ts"],
      run_at: "document_start",
      world: "MAIN",
      all_frames: true,
    },
  ],
  web_accessible_resources: [
    {
      resources: [
        "src/assets/icon-128.png",
        "src/assets/fonts/PretendardVariable.woff2",
      ],
      matches: ["https://ads.naver.com/*"],
    },
  ],
});
