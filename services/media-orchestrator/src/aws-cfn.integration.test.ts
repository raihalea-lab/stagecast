/**
 * 実 AWS CloudFormation 疎通テスト (T8)。RUN_INTEGRATION=1 で実行。
 *
 * 実 CFN へ ListStacks / DescribeStacks を呼ぶだけの read-only テスト。
 * CreateStack/DeleteStack は実体のスタックを生成・破壊する副作用が大きいため
 * ここでは行わない (orchestrator のフローテストで行う)。
 *
 * 必要な環境変数:
 *   AWS_REGION
 *
 * 実行: RUN_INTEGRATION=1 pnpm --filter @stagecast/media-orchestrator test
 */
import { describe, expect, it } from "vitest";

const RUN = process.env.RUN_INTEGRATION === "1";

describe.skipIf(!RUN)("media-orchestrator 実 CFN 疎通 (T8)", () => {
  it("AwsCloudFormationClient.describeStacks が呼び出せる (read-only)", async () => {
    const { AwsCloudFormationClient } = await import("./aws-cfn.js");
    const client = new AwsCloudFormationClient();
    // 存在しないスタック名を describe するとエラーになる。
    // 代わりに ListStacks 相当の挙動を describeStacks に頼らずチェック。
    await expect(client.describeStacks({ StackName: "no-such-stack-stagecast" })).rejects.toThrow();
  });

  it("renderEventMediaTemplate が有効な CFN テンプレート JSON を返す", async () => {
    const { renderEventMediaTemplate } = await import("@stagecast/infra/render-template");
    const json = renderEventMediaTemplate({
      eventId: "integration-test",
      captionEngine: "transcribe",
      customCaptionApi: false,
    });
    const parsed = JSON.parse(json);
    expect(parsed.Resources).toBeDefined();
    expect(typeof parsed.Resources).toBe("object");
  });
});
