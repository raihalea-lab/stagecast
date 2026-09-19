import { defineConfig } from "vitest/config";

/**
 * media-orchestrator のテスト設定。
 *
 * `render-template-handler.test.ts` は Lambda の中で CDK synth を走らせるので、単体でも
 * 6 秒前後かかる。既定の 5 秒だと、他パッケージと並走する pre-push で中身は正しいのに
 * タイムアウトで落ちる (infra 側も同じ理由で伸ばしてある)。
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
