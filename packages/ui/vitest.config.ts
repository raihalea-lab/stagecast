import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * packages/ui の vitest 設定。 jsdom 環境で primitive と axe a11y smoke を回す。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
