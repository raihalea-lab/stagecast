import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "tailwindcss";
import autoprefixer from "autoprefixer";

/**
 * packages/ui の vite 設定 (preview ページ用)。
 * dev: `pnpm --filter @stagecast/ui dev` で preview/ をルートに目視確認ページを起動。
 *
 * テスト設定 (jsdom + axe) は vitest.config.ts に分離している。
 */
export default defineConfig({
  root: "preview",
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss(), autoprefixer()],
    },
  },
});
