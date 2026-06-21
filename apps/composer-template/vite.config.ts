import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * LiveKit Egress の Chrome ヘッドレスから読み込まれる単一ページ React app。
 * `https://<cloudfront>/composer/` で配信される想定で、`base: "./"` で相対パス化する
 * (CloudFront cache behavior のパス前置きが変わっても壊れないようにする)。
 */
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    // livekit-client は WebRTC SDK で必然的に大きい (gzip 後 ~170KB)。
    // 別チャンクへ切り出してキャッシュ効率を上げつつ、警告閾値も実態に合わせる。
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        manualChunks: (id: string) => {
          if (id.includes("livekit-client")) return "livekit";
        },
      },
    },
  },
});
