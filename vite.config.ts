import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { crx } from "@crxjs/vite-plugin";
import path from "node:path";
import manifest from "./manifest.config";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // 콘텐츠 스크립트의 동적 import(리포트 등 지연 로딩) 시 Vite의 modulepreload 힌트가 청크를
  // 페이지 주소(ads.naver.com) 기준 상대경로로 풀어 404(net::ERR_ABORTED)를 찍는다. 실제 모듈은
  // 확장 주소에서 정상 로드되지만 콘솔이 지저분해진다(production 빌드도 동일). 힌트 자체를 꺼서 제거 -
  // 클릭 트리거 지연 로딩이라 preload 최적화 손실은 무시 가능.
  build: { modulePreload: false },
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
