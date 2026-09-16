/**
 * RenderTemplateFunction の**バンドル成果物を実際に実行する**テスト (NEXT_WORK D15)。
 *
 * この Lambda は中で `app.synth()` する (ADR 0023 D-1)。esbuild の ESM 出力には CJS の
 * グローバルが無いので、aws-cdk-lib が `require` や `__dirname` を使うたびに壊れる。
 *
 * 2026-09-16 に実際に壊れた: aws-cdk-lib 2.260 → 2.269 で `CloudFormationValidatePlugin` が
 * 既定で走るようになり、`__dirname` 相対の WASM が読めず **全イベントの配信開始が停止**した (PR #236)。
 *
 * 痛かったのは、`cdk synth` も `vp run -r test` も**バンドルを実行しない**ので、
 * 本番でイベントを開始するまで誰も気づけなかったこと。ここで実行して塞ぐ。
 *
 * **CDK に実際にバンドルさせた成果物**を使う。テスト側で esbuild を呼び直すと、
 * banner や `afterBundling` の WASM コピーがスタック側とズレても気づけない。
 * 実行は子プロセスの素の Node で行う (vitest 経由で import すると module runner が
 * 8MB のバンドルを変換しようとして落ちるうえ、Lambda の実行環境から遠ざかる)。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ControlPlaneStack } from "../lib/control-plane-stack";

const RUNNER = `
import { handler } from "./index.mjs";
const out = await handler({
  eventId: "bundle-smoke-test",
  captionEngine: "transcribe",
  customCaptionApi: false,
});
const template = JSON.parse(out.template);
process.stdout.write(JSON.stringify(Object.values(template.Resources).map((r) => r.Type)));
`;

/** CDK に本番と同じ条件でバンドルさせ、成果物のディレクトリを返す。 */
function bundleViaCdk(): string {
  const outdir = mkdtempSync(join(tmpdir(), "stagecast-cdkout-"));
  const app = new App({
    outdir,
    context: {
      "hosted-zone:account=111111111111:domainName=example.com:region=ap-northeast-1": {
        Id: "/hostedzone/ZTESTEXAMPLE",
        Name: "example.com.",
      },
    },
  });
  const stack = new ControlPlaneStack(app, "BundleTestControlPlane", {
    env: { account: "111111111111", region: "ap-northeast-1" },
    userConfig: { mediaHostedZoneName: "example.com" },
  });
  Template.fromStack(stack); // ここで esbuild と afterBundling が走る。

  // RenderTemplateFunction のアセットは「index.mjs と WASM が同居している」唯一のもの。
  const assets = readdirSync(outdir)
    .filter((d) => d.startsWith("asset."))
    .map((d) => join(outdir, d))
    .filter((d) => existsSync(join(d, "bindings_wasm_bg.wasm")));
  expect(assets).toHaveLength(1);
  return assets[0] as string;
}

describe("RenderTemplateFunction のバンドル成果物 (D15)", () => {
  // esbuild + synth が走るので他のテストより遅い。本番障害 1 回分より遥かに安い。
  it("CDK がバンドルした handler が CloudFormation テンプレートを返す", () => {
    const dir = bundleViaCdk();
    expect(existsSync(join(dir, "index.mjs"))).toBe(true);

    writeFileSync(join(dir, "run.mjs"), RUNNER);
    const stdout = execFileSync(process.execPath, [join(dir, "run.mjs")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const types = JSON.parse(stdout) as string[];
    expect(types).toContain("AWS::ECS::Cluster");
    expect(types.filter((t) => t === "AWS::ECS::Service")).toHaveLength(2);
  }, 300_000);
});
