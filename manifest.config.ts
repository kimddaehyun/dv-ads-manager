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
  permissions: ["storage", "tabs"],
  host_permissions: [
    "https://ads.naver.com/*",
    "https://api.searchad.naver.com/*",
    // F-AssetBulk V2 — 상품 페이지에서 메인 이미지 후보 추출. background hidden tab으로 페이지를
    // 열고 그 안의 콘텐츠 스크립트(product-page-scrape.ts)가 DOM에서 갤러리 이미지를 수집.
    "https://smartstore.naver.com/*",
    "https://brand.naver.com/*",
    // F-AssetBulk V2 — 사용자가 선택한 상품 이미지를 광고 모달에 업로드하기 위해 binary를
    // background에서 fetch. 네이버 쇼핑 이미지 CDN.
    "https://shop-phinf.pstatic.net/*",
    // F-Setup — 쇼핑검색 소재(상품)의 이미지를 세팅안 엑셀에 삽입하기 위해 background에서
    // binary fetch. 쇼핑 상품 이미지 CDN (content script는 CORS로 차단됨).
    "https://shopping-phinf.pstatic.net/*",
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
    {
      // F-AssetBulk V2 — 스마트스토어/브랜드스토어 상품 페이지에 inject되는 가벼운 스크레이퍼.
      // background가 hidden tab으로 이 페이지를 열면 SCRAPE_PRODUCT_IMAGES 메시지를 받아
      // DOM에서 갤러리 이미지 URL을 수집해 응답한다. SPA hydration 후 추출하므로 SSR fetch보다
      // 정확하다.
      matches: [
        "https://smartstore.naver.com/*/products/*",
        "https://brand.naver.com/*/products/*",
      ],
      js: ["src/content/product-page-scrape.ts"],
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
