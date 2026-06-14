import {
  Stack,
  type StackProps,
  RemovalPolicy,
  CfnOutput,
  Tags,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticache as elasticache,
  aws_logs as logs,
  aws_iam as iam,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { CaptionEngineKind } from '@stagecast/shared';

export interface EventMediaStackProps extends StackProps {
  /** このスタックが対応する配信イベント ID。 */
  eventId: string;
  /** 字幕エンジン経路 (DESIGN.md 6.2)。 */
  captionEngine: CaptionEngineKind;
  /** 独自字幕配信 API を起動するか (DESIGN.md 6.3.2)。 */
  customCaptionApi: boolean;
  /** コンテナイメージ (省略時は既定の参照)。 */
  images?: { sfu?: string; egress?: string; captionWorker?: string };
}

/**
 * イベント単位メディアスタック (DESIGN.md 3.2 / 7.1 / 7.3, N-5, ADR D-6/D-7)。
 *
 * 配信イベントごとに 1 つ起動し、終了で丸ごと破棄する ephemeral なスタック。最大 3 つの
 * イベントが同時並行する場合は本スタックが 3 つ並列で存在し、相互に干渉しない。
 * 常時稼働する制御層 (ControlPlaneStack) には一切含めない (N-1)。
 *
 * 含むもの:
 *  - SFU (LiveKit) / Egress / 字幕ワーカー の ECS/Fargate サービス
 *  - ElastiCache for Valkey (Serverless): ルーム状態・発表者切替の低レイテンシ共有
 *  - 専用 VPC・ロググループ (破棄時に消える)
 */
export class EventMediaStack extends Stack {
  constructor(scope: Construct, id: string, props: EventMediaStackProps) {
    super(scope, id, props);

    // イベント識別タグ。破棄・コスト按分・隔離の追跡に使う (7.3)。
    Tags.of(this).add('stagecast:eventId', props.eventId);
    Tags.of(this).add('stagecast:ephemeral', 'true');

    // --- ネットワーク (このイベント専用。破棄で消える) ---
    // NAT は 1 つに絞りコストを抑える。イベント時のみ存在するため常時費用にはならない。
    const vpc = new ec2.Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // --- 共有状態: ElastiCache for Valkey (Serverless) (DESIGN.md 3.2, 7.2) ---
    const valkeySg = new ec2.SecurityGroup(this, 'ValkeySg', { vpc, allowAllOutbound: true });
    valkeySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      'Valkey from within VPC',
    );
    const valkey = new elasticache.CfnServerlessCache(this, 'Valkey', {
      engine: 'valkey',
      serverlessCacheName: `stagecast-${props.eventId}`.toLowerCase().slice(0, 40),
      securityGroupIds: [valkeySg.securityGroupId],
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });

    // --- メディア/字幕の Fargate サービス群 ---
    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 字幕ワーカーは Transcribe/Translate/Bedrock を呼ぶため最小権限を付与 (DESIGN.md 6.2)。
    const captionTaskRole = new iam.Role(this, 'CaptionTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    captionTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'transcribe:StartStreamTranscriptionWebSocket',
          'transcribe:StartStreamTranscription',
          'translate:TranslateText',
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
        ],
        resources: ['*'],
      }),
    );

    const images = props.images ?? {};
    const addService = (
      name: string,
      image: string,
      port: number | undefined,
      taskRole?: iam.IRole,
    ): ecs.FargateService => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${name}TaskDef`, {
        cpu: 1024,
        memoryLimitMiB: 2048,
        taskRole,
      });
      const container = taskDef.addContainer(`${name}Container`, {
        image: ecs.ContainerImage.fromRegistry(image),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup }),
        environment: {
          STAGECAST_EVENT_ID: props.eventId,
          VALKEY_ENDPOINT: valkey.attrEndpointAddress,
          CAPTION_ENGINE: props.captionEngine,
          CUSTOM_CAPTION_API: String(props.customCaptionApi),
        },
      });
      if (port !== undefined) {
        container.addPortMappings({ containerPort: port });
      }
      return new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        // ephemeral: 破棄を速くするため最小構成。
        minHealthyPercent: 0,
        circuitBreaker: { rollback: false },
      });
    };

    // SFU(LiveKit) と Egress、字幕ワーカー。イメージは差し替え可能。
    const sfu = addService('Sfu', images.sfu ?? 'livekit/livekit-server:latest', 7880);
    addService('Egress', images.egress ?? 'livekit/egress:latest', undefined);
    addService(
      'CaptionWorker',
      images.captionWorker ?? 'public.ecr.aws/docker/library/node:22-alpine',
      props.customCaptionApi ? 8080 : undefined,
      captionTaskRole,
    );

    // SFU は VPC 内から到達可能に (Egress が購読)。
    sfu.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(7880),
      'SFU signaling within VPC',
    );

    new CfnOutput(this, 'EventId', { value: props.eventId });
    new CfnOutput(this, 'ValkeyEndpoint', { value: valkey.attrEndpointAddress });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
  }
}

/** イベント ID から決定的なスタック名を作る (orchestrator と共有する規約)。 */
export function eventMediaStackName(eventId: string): string {
  return `StagecastEventMedia-${eventId}`;
}
