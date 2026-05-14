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
  server: { port: 5173, strictPort: true, hmr: { port: 5173 } },
});
