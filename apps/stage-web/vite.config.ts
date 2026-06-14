import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // livekit-client は WebRTC SDK で必然的に大きい (gzip 後 168KB)。
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
