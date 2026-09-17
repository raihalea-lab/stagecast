import { defineConfig } from "vitest/config";

/**
 * infra の vitest 設定。テストは test/ 配下だけを探索する。
 * cdk synth (pre-push フック) が cdk.out/asset.* に DockerImageAsset の staging として
 * monorepo 全体をコピーするため (ADR 0019)、既定の探索だとその中の *.test.ts まで拾ってしまう。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // CDK の synth と esbuild バンドルは単体でも数秒かかり、pre-push で他パッケージの
    // テストと並走すると既定の 5 秒を超えて落ちる (中身は正しいのにフレークになる)。
    testTimeout: 30_000,
  },
});
