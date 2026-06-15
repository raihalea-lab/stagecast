/**
 * CloudFormation 実装の MediaStackProvisioner (DESIGN.md 7.1, ADR D-6)。
 *
 * イベント開始で EventMediaStack (infra) を CloudFormation スタックとして作成し、終了で削除する。
 * AWS SDK には直接依存せず、最小操作を CloudFormationLike として抽象化する (テストで fake を注入)。
 * 実運用では `@aws-sdk/client-cloudformation` を薄くラップした実装を渡す。
 *
 * テンプレートは EventMediaStack を `cdk synth` で生成したものを renderTemplate で供給する
 * (eventId 等をパラメータ化)。
 */
import type { EventMediaSpec, MediaStackHandle, MediaStackProvisioner } from "./provisioner.js";

export interface StackOutput {
  OutputKey?: string | undefined;
  OutputValue?: string | undefined;
}
export interface DescribeResult {
  Stacks?: { StackStatus?: string | undefined; Outputs?: StackOutput[] | undefined }[] | undefined;
}

/** CloudFormation の最小サブセット。 */
export interface CloudFormationLike {
  createStack(input: {
    StackName: string;
    TemplateBody: string;
    Capabilities?: string[] | undefined;
    /** CFN サービスロール ARN (R5)。指定時 CFN はこのロールでリソースを作成する。 */
    RoleARN?: string | undefined;
  }): Promise<{ StackId?: string | undefined }>;
  deleteStack(input: { StackName: string }): Promise<void>;
  describeStacks(input: { StackName: string }): Promise<DescribeResult>;
}

export interface CfnProvisionerConfig {
  cfn: CloudFormationLike;
  /** イベント仕様 → CloudFormation テンプレート (JSON 文字列)。 */
  renderTemplate: (spec: EventMediaSpec) => string;
  /** イベント ID → スタック名 (infra の eventMediaStackName と一致させる)。 */
  stackName: (eventId: string) => string;
  /** CFN サービスロール ARN (R5)。createStack の RoleARN に渡す。 */
  roleArn?: string | undefined;
  /** 完了待ちのポーリング間隔・最大回数 (テストでは 0/1)。 */
  pollIntervalMs?: number | undefined;
  maxPolls?: number | undefined;
  /** 待機関数 (テストで差し替え可能)。 */
  delay?: ((ms: number) => Promise<void>) | undefined;
}

const COMPLETE = /COMPLETE$/;
const FAILED = /(FAILED|ROLLBACK)/;

export class CloudFormationMediaStackProvisioner implements MediaStackProvisioner {
  constructor(private readonly config: CfnProvisionerConfig) {}

  private outputs(result: DescribeResult): Record<string, string> {
    const out: Record<string, string> = {};
    for (const o of result.Stacks?.[0]?.Outputs ?? []) {
      if (o.OutputKey && o.OutputValue) out[o.OutputKey] = o.OutputValue;
    }
    return out;
  }

  private async waitForComplete(stackName: string): Promise<Record<string, string>> {
    const delay = this.config.delay ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const maxPolls = this.config.maxPolls ?? 60;
    const interval = this.config.pollIntervalMs ?? 5000;
    for (let i = 0; i < maxPolls; i++) {
      const res = await this.config.cfn.describeStacks({ StackName: stackName });
      const status = res.Stacks?.[0]?.StackStatus ?? "";
      if (FAILED.test(status)) throw new Error(`stack ${stackName} failed: ${status}`);
      if (COMPLETE.test(status)) return this.outputs(res);
      await delay(interval);
    }
    throw new Error(`stack ${stackName} did not complete in time`);
  }

  async provision(spec: EventMediaSpec): Promise<MediaStackHandle> {
    const stackName = this.config.stackName(spec.eventId);
    const created = await this.config.cfn.createStack({
      StackName: stackName,
      TemplateBody: this.config.renderTemplate(spec),
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
      ...(this.config.roleArn ? { RoleARN: this.config.roleArn } : {}),
    });
    const outputs = await this.waitForComplete(stackName);
    return {
      eventId: spec.eventId,
      stackId: created.StackId ?? stackName,
      status: "running",
      // 出力があれば使い、無ければ規約ベースで補完する。
      sfuUrl: outputs.SfuUrl ?? `wss://sfu-${spec.eventId}.media.internal`,
      captionPipelineId: outputs.CaptionPipelineId ?? `caption-${spec.eventId}`,
      valkeyNamespace: spec.eventId,
      customCaptionApiUrl: spec.customCaptionApi
        ? (outputs.CustomCaptionApiUrl ?? `wss://captions-${spec.eventId}.media.internal`)
        : undefined,
    };
  }

  async destroy(handle: MediaStackHandle): Promise<void> {
    await this.config.cfn.deleteStack({ StackName: this.config.stackName(handle.eventId) });
  }
}
