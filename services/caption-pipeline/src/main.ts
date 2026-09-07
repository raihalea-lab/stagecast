/**
 * 字幕ワーカープロセスのエントリ (EventMediaStack の caption-worker コンテナ)。
 * 環境変数から CaptionService を起動し、SIGTERM/SIGINT でグレースフルに停止する。
 */
import { createLogger } from "@stagecast/shared";
import { runFromEnv, type CaptionService } from "./bootstrap.js";

const log = createLogger({
  component: "caption-worker",
  ...(process.env.STAGECAST_EVENT_ID ? { eventId: process.env.STAGECAST_EVENT_ID } : {}),
});

async function main(): Promise<void> {
  const service: CaptionService = await runFromEnv();
  log.info("caption worker started", { wsPort: service.wsPort ?? null });

  // ADR 0017 D-3 で CAPTION_BUS=valkey (常時接続) を外したため、LIVEKIT_URL 未設定かつ独自字幕 API
  // 無効のときはイベントループを保持するハンドルが無く main() 完了後に exit 0 してしまう。
  // essential コンテナが終了すると ECS が Task を再起動し続けるので、明示的に保持する。
  // ponytail: LIVEKIT_URL/TOKEN/ROOM 注入 (D-3 の SFU 接続) が実装されたら AudioSource が代わりに保持する。
  setInterval(() => {}, 60_000);

  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutting down", { signal });
    const keys = await service.stop();
    log.info("saved caption artifacts", { keys });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("caption worker failed to start", { err });
  process.exit(1);
});
