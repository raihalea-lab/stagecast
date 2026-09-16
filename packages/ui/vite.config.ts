import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/postcss";

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
    // Tailwind v4: プラグインは @tailwindcss/postcss。autoprefixer は内蔵されたので不要。
    postcss: {
      plugins: [tailwindcss()],
    },
  },
});
