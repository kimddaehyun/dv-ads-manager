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
    "https://sell.smartstore.naver.com/*",
    "https://*.supabase.co/*",
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
