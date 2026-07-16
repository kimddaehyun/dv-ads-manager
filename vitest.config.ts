// 테스트 전용 Vite 설정 — 기존 vite.config.ts는 crx() 플러그인이 MV3 확장 번들링을
// 시도해 테스트에서 깨진다. 경로 별칭(@/)만 동일하게 맞추고 나머지는 최소로.
// 대상은 순수 로직(brief-rules/brief-verify)뿐 — DOM·chrome API·네이버 API는 수동 검증.
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
