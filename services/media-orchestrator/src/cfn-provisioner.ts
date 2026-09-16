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
import { withRetry, type RetryOptions } from "@stagecast/shared";
import type { EventMediaSpec, MediaStackHandle, MediaStackProvisioner } from "./provisioner.js";

export interface StackOutput {
  OutputKey?: string | undefined;
  OutputValue?: string | undefined;
}
export interface DescribeResult {
  Stacks?:
    | {
        StackStatus?: string | undefined;
        /** 実際に適用されたデプロイモード (ADR 0023 D-1 の効き目確認用)。 */
        DeploymentMode?: string | undefined;
        Outputs?: StackOutput[] | undefined;
      }[]
    | undefined;
}

/** CloudFormation のデプロイモード (ADR 0023 D-1)。 */
export type DeploymentMode = "EXPRESS" | "STANDARD";

/** CloudFormation の最小サブセット。 */
export interface CloudFormationLike {
  createStack(input: {
    StackName: string;
    TemplateBody: string;
    Capabilities?: string[] | undefined;
    /** CFN サービスロール ARN (R5)。指定時 CFN はこのロールでリソースを作成する。 */
    RoleARN?: string | undefined;
    /** Express モード (ADR 0023 D-1)。未指定は CFN 既定の STANDARD。 */
    DeploymentMode?: DeploymentMode | undefined;
  }): Promise<{ StackId?: string | undefined }>;
  deleteStack(input: { StackName: string }): Promise<void>;
  describeStacks(input: { StackName: string }): Promise<DescribeResult>;
}

export interface CfnProvisionerConfig {
  cfn: CloudFormationLike;
  /** イベント仕様 → CloudFormation テンプレート (JSON 文字列)。別 Lambda 呼び出しで async 可 (D1)。 */
  renderTemplate: (spec: EventMediaSpec) => string | Promise<string>;
  /** イベント ID → スタック名 (infra の eventMediaStackName と一致させる)。 */
  stackName: (eventId: string) => string;
  /** CFN サービスロール ARN (R5)。createStack の RoleARN に渡す。 */
  roleArn?: string | undefined;
  /**
   * CloudFormation Express モードでスタックを作成する (ADR 0023 D-1)。
   * リソースが「設定適用済み」になった時点で完了扱いになり、作成が大幅に速くなる。
   * 代わりに CREATE_COMPLETE は「タスクが動いている」ことを保証しないので、
   * 実際の起動完了は ECS の running 数で別途観測する (ADR 0023 D-3)。
   */
  expressMode?: boolean | undefined;
  /** 完了待ちのポーリング間隔・最大回数 (テストでは 0/1)。 */
  pollIntervalMs?: number | undefined;
  maxPolls?: number | undefined;
  /** 待機関数 (テストで差し替え可能)。 */
  delay?: ((ms: number) => Promise<void>) | undefined;
  /**
   * describeStacks で観測したスタックの状態を通知する (ADR 0023 D-1)。
   * Express を要求したのに DeploymentMode が STANDARD のままなら、SDK / リージョンが
   * 未対応でパラメータが黙って落ちている。ログで気づけるようにここから流す。
   */
  onObserve?:
    | ((o: { stackName: string; status: string; deploymentMode?: string | undefined }) => void)
    | undefined;
  /**
   * describeStacks の一過性失敗 (CFN スロットリング等) に対するリトライ設定。
   * 既定では provisioner の `delay` を sleep に使い、テストは実時間を待たない。
   */
  describeRetry?: RetryOptions | undefined;
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
    // describeStacks の一過性失敗は 1 tick を諦めず短く再試行する (sleep は delay を流用)。
    const describeRetry: RetryOptions = { sleep: delay, ...this.config.describeRetry };
    for (let i = 0; i < maxPolls; i++) {
      const res = await withRetry(
        () => this.config.cfn.describeStacks({ StackName: stackName }),
        describeRetry,
      );
      const status = res.Stacks?.[0]?.StackStatus ?? "";
      this.config.onObserve?.({
        stackName,
        status,
        deploymentMode: res.Stacks?.[0]?.DeploymentMode,
      });
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
      TemplateBody: await this.config.renderTemplate(spec),
      Capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
      ...(this.config.roleArn ? { RoleARN: this.config.roleArn } : {}),
      // 破棄側 (deleteStack) は Express にしない: 削除完了の報告が実際の破棄より先行すると、
      // 直後の作り直しが「まだ消えていない ECS サービス」と名前衝突する (ADR 0023 D-1)。
      ...(this.config.expressMode ? { DeploymentMode: "EXPRESS" as const } : {}),
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
