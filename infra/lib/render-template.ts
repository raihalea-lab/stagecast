import { App } from "aws-cdk-lib";
import { EventMediaStack, eventMediaStackName } from "./event-media-stack";
import type { CaptionEngineKind } from "@stagecast/shared";

/**
 * イベント単位メディアスタックの CloudFormation テンプレート(JSON 文字列)を生成する
 * (DESIGN.md 7.1, ADR 0001/0003)。
 *
 * `media-orchestrator` の `CloudFormationMediaStackProvisioner` に `renderTemplate` として
 * 渡し、イベント開始時に実テンプレートを供給する。EventMediaStack を CDK でプログラム的に
 * synth し、生成された CloudFormation テンプレートを返す。
 */
export interface RenderEventMediaSpec {
  eventId: string;
  captionEngine: CaptionEngineKind;
  customCaptionApi: boolean;
  /** YouTube RTMP 取り込み URL。Egress が RTMP 送出する宛先 (R12, ADR 0006 D-4)。 */
  rtmpUrl?: string;
  /** YouTube ストリームキーを格納した Secrets Manager の参照名 (例: stagecast/youtube-stream-key)。 */
  streamKeyRef?: string;
}

export function renderEventMediaTemplate(spec: RenderEventMediaSpec): string {
  const app = new App();
  const stackName = eventMediaStackName(spec.eventId);
  // reconcile Lambda が ECR の caption-worker イメージ URI を env で渡す (R4)。未設定なら
  // EventMediaStack 既定の node:24-alpine プレースホルダにフォールバックする。
  const captionWorkerImage = process.env.CAPTION_WORKER_IMAGE;
  // Egress 録画の出力先バケット。制御層が成果物バケット名を env で渡す (ADR 0006 D-4)。
  const recordingsBucketName = process.env.RECORDINGS_BUCKET_NAME;
  // ADR 0012 D-3: カスタム Egress テンプレート (composer-template) の URL。
  // ControlPlane の ComposerWebDistribution から reconcile Lambda の env に注入される。
  // 未指定なら LiveKit Egress のデフォルトテンプレート (`http://localhost:7980/`) にフォールバック。
  const composerTemplateUrl = process.env.COMPOSER_TEMPLATE_URL;
  // ADR 0009: LiveKit シグナリングを NLB + ACM で TLS 終端する。4 つ全てが揃っているときのみ
  // NLB / Route53 ARecord を作る (揃っていなければ ADR 0008 D-4 の Public IP 直接公開にフォールバック)。
  const tlsCertificateArn = process.env.MEDIA_CERTIFICATE_ARN;
  const hostedZoneId = process.env.MEDIA_HOSTED_ZONE_ID;
  const hostedZoneName = process.env.MEDIA_HOSTED_ZONE_NAME;
  const mediaDomainName = process.env.MEDIA_DOMAIN_NAME;
  const tlsProps =
    tlsCertificateArn && hostedZoneId && hostedZoneName && mediaDomainName
      ? { tlsCertificateArn, hostedZoneId, hostedZoneName, mediaDomainName }
      : {};
  // 共有 VPC (ControlPlaneStack の SharedMediaVpc) を ControlPlaneStack から env 経由で受け取る。
  // 揃っていなければ EventMediaStack は per-event VPC を作成 (後方互換)。
  const sharedVpcId = process.env.SHARED_VPC_ID;
  const sharedVpcCidr = process.env.SHARED_VPC_CIDR;
  const sharedSubnetIds = process.env.SHARED_SUBNET_IDS?.split(",").filter(Boolean) ?? [];
  const sharedSubnetAzs = process.env.SHARED_SUBNET_AZS?.split(",").filter(Boolean) ?? [];
  const sharedVpcProps =
    sharedVpcId && sharedVpcCidr && sharedSubnetIds.length > 0 && sharedSubnetAzs.length > 0
      ? {
          sharedVpc: {
            vpcId: sharedVpcId,
            vpcCidr: sharedVpcCidr,
            availabilityZones: sharedSubnetAzs,
            publicSubnetIds: sharedSubnetIds,
          },
        }
      : {};
  // ADR 0015 Phase 3: 共有 ECS Cluster + IAM Roles を ControlPlaneStack から受け取る。
  const sharedClusterName = process.env.SHARED_CLUSTER_NAME;
  const sharedSfuTaskRoleArn = process.env.SHARED_SFU_TASK_ROLE_ARN;
  const sharedCaptionTaskRoleArn = process.env.SHARED_CAPTION_TASK_ROLE_ARN;
  new EventMediaStack(app, stackName, {
    eventId: spec.eventId,
    captionEngine: spec.captionEngine,
    customCaptionApi: spec.customCaptionApi,
    ...(captionWorkerImage ? { images: { captionWorker: captionWorkerImage } } : {}),
    ...(recordingsBucketName ? { recordingsBucketName } : {}),
    ...tlsProps,
    ...sharedVpcProps,
    ...(spec.rtmpUrl ? { rtmpUrl: spec.rtmpUrl } : {}),
    ...(spec.streamKeyRef ? { streamKeyRef: spec.streamKeyRef } : {}),
    ...(composerTemplateUrl ? { composerTemplateUrl } : {}),
    ...(sharedClusterName ? { sharedClusterName } : {}),
    ...(sharedSfuTaskRoleArn ? { sharedSfuTaskRoleArn } : {}),
    ...(sharedCaptionTaskRoleArn ? { sharedCaptionTaskRoleArn } : {}),
  });
  const assembly = app.synth();
  const template = assembly.getStackByName(stackName).template as unknown;
  return JSON.stringify(template);
}
