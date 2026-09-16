/**
 * 実 AWS CloudFormation 結線 (DESIGN.md 7.1, ADR 0001/0003)。
 *
 * `CloudFormationLike` を AWS SDK v3 (@aws-sdk/client-cloudformation) で実装し、
 * `CloudFormationMediaStackProvisioner` に渡せるようにする。テンプレートは infra の
 * `renderEventMediaTemplate` を `renderTemplate` として注入する（依存方向を片方向に保つため、
 * infra への import は配線側＝デプロイ用エントリで行い、本モジュールは関数注入で受ける）。
 */
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudFormationMediaStackProvisioner,
  type CfnProvisionerConfig,
  type CloudFormationLike,
  type DeploymentMode,
  type DescribeResult,
} from "./cfn-provisioner.js";
import type { EventMediaSpec } from "./provisioner.js";

/** infra の eventMediaStackName と一致させる規約。 */
export function eventMediaStackName(eventId: string): string {
  return `StagecastEventMedia-${eventId}`;
}

/** AWS SDK 実装の CloudFormationLike。 */
export class AwsCloudFormationClient implements CloudFormationLike {
  constructor(private readonly client: CloudFormationClient = new CloudFormationClient({})) {}

  async createStack(input: {
    StackName: string;
    TemplateBody: string;
    Capabilities?: string[] | undefined;
    RoleARN?: string | undefined;
    DeploymentMode?: DeploymentMode | undefined;
  }): Promise<{ StackId?: string | undefined }> {
    const res = await this.client.send(
      new CreateStackCommand({
        StackName: input.StackName,
        TemplateBody: input.TemplateBody,
        Capabilities: input.Capabilities as never,
        ...(input.RoleARN ? { RoleARN: input.RoleARN } : {}),
        // ADR 0023 D-1: Express モードはリソースが安定するのを待たずに完了するので、
        // EventMediaStack の作成が大幅に速くなる。ロールバックは既定で無効になり、
        // 失敗は CREATE_FAILED のまま残る → reconcile が destroy → 再作成で復旧する。
        ...(input.DeploymentMode ? { DeploymentConfig: { Mode: input.DeploymentMode } } : {}),
      }),
    );
    return { StackId: res.StackId };
  }

  async deleteStack(input: { StackName: string }): Promise<void> {
    await this.client.send(new DeleteStackCommand({ StackName: input.StackName }));
  }

  async describeStacks(input: { StackName: string }): Promise<DescribeResult> {
    const res = await this.client.send(new DescribeStacksCommand({ StackName: input.StackName }));
    return {
      Stacks: res.Stacks?.map((s) => ({
        StackStatus: s.StackStatus,
        // ADR 0023 D-1: 実際に Express が効いたかを観測できるようにする (SDK / リージョンが
        // 未対応ならパラメータは黙って落ちるため、ログで気づけるようにしておく)。
        DeploymentMode: s.DeploymentConfig?.Mode,
        Outputs: s.Outputs?.map((o) => ({ OutputKey: o.OutputKey, OutputValue: o.OutputValue })),
      })),
    };
  }
}

export interface AwsProvisionerConfig {
  /** infra の renderEventMediaTemplate を注入する (別 Lambda 呼び出しで async 可, D1)。 */
  renderTemplate: (spec: EventMediaSpec) => string | Promise<string>;
  /** CloudFormationLike (省略時は AWS SDK 実装)。 */
  cfn?: CloudFormationLike;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** CFN サービスロール ARN (R5)。createStack の RoleARN に渡す。 */
  roleArn?: string | undefined;
  /** CloudFormation Express モードで作成する (ADR 0023 D-1)。 */
  expressMode?: boolean | undefined;
  /** describeStacks の観測結果 (Express が実際に効いたかの確認に使う)。 */
  onObserve?: CfnProvisionerConfig["onObserve"];
}

/**
 * 実 AWS 用の MediaStackProvisioner を組み立てる（配線の合流点）。
 * デプロイ用エントリは `renderTemplate: (spec) => renderEventMediaTemplate(spec)` を渡す。
 */
export function createAwsMediaStackProvisioner(
  config: AwsProvisionerConfig,
): CloudFormationMediaStackProvisioner {
  return new CloudFormationMediaStackProvisioner({
    cfn: config.cfn ?? new AwsCloudFormationClient(),
    renderTemplate: config.renderTemplate,
    stackName: eventMediaStackName,
    pollIntervalMs: config.pollIntervalMs,
    maxPolls: config.maxPolls,
    roleArn: config.roleArn,
    expressMode: config.expressMode,
    onObserve: config.onObserve,
  });
}
