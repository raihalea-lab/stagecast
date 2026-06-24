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
