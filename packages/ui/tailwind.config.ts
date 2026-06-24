import preset from "./src/tailwind-preset.js";

/**
 * preview ページ用の Tailwind 設定。 各 app は自分の tailwind.config.ts で preset を継承する。
 */
export default {
  presets: [preset],
  content: ["./preview/index.html", "./preview/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
};
