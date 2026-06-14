/**
 * 字幕ワーカープロセスのエントリ (EventMediaStack の caption-worker コンテナ)。
 * 環境変数から CaptionService を起動し、SIGTERM/SIGINT でグレースフルに停止する。
 */
import { runFromEnv, type CaptionService } from './bootstrap.js';

async function main(): Promise<void> {
  const service: CaptionService = await runFromEnv();
  // eslint-disable-next-line no-console
  console.log(`caption worker started (ws port: ${service.wsPort ?? 'n/a'})`);

  const shutdown = async (signal: string): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down...`);
    const keys = await service.stop();
    // eslint-disable-next-line no-console
    console.log(`saved caption artifacts: ${keys.join(', ') || '(none)'}`);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('caption worker failed to start:', err);
  process.exit(1);
});
