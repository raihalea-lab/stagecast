import {
  Stack,
  type StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  Tags,
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticache as elasticache,
  aws_logs as logs,
  aws_iam as iam,
  aws_cloudwatch as cloudwatch,
  aws_sns as sns,
  aws_cloudwatch_actions as cwActions,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CaptionEngineKind } from "@stagecast/shared";

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
    Tags.of(this).add("stagecast:eventId", props.eventId);
    Tags.of(this).add("stagecast:ephemeral", "true");

    // --- ネットワーク (このイベント専用。破棄で消える) ---
    // NAT は 1 つに絞りコストを抑える。イベント時のみ存在するため常時費用にはならない。
    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 1 });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // --- 共有状態: ElastiCache for Valkey (Serverless) (DESIGN.md 3.2, 7.2) ---
    const valkeySg = new ec2.SecurityGroup(this, "ValkeySg", { vpc, allowAllOutbound: true });
    valkeySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      "Valkey from within VPC",
    );
    const valkey = new elasticache.CfnServerlessCache(this, "Valkey", {
      engine: "valkey",
      serverlessCacheName: `stagecast-${props.eventId}`.toLowerCase().slice(0, 40),
      securityGroupIds: [valkeySg.securityGroupId],
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds,
    });

    // --- メディア/字幕の Fargate サービス群 ---
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 字幕ワーカーは Transcribe/Translate/Bedrock を呼ぶため最小権限を付与 (DESIGN.md 6.2)。
    const captionTaskRole = new iam.Role(this, "CaptionTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    captionTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "transcribe:StartStreamTranscriptionWebSocket",
          "transcribe:StartStreamTranscription",
          "translate:TranslateText",
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
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
    const sfu = addService("Sfu", images.sfu ?? "livekit/livekit-server:latest", 7880);
    const egress = addService("Egress", images.egress ?? "livekit/egress:latest", undefined);
    const captionWorker = addService(
      "CaptionWorker",
      images.captionWorker ?? "public.ecr.aws/docker/library/node:24-alpine",
      props.customCaptionApi ? 8080 : undefined,
      captionTaskRole,
    );

    // SFU は VPC 内から到達可能に (Egress が購読)。
    sfu.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(7880),
      "SFU signaling within VPC",
    );

    // --- オブザーバビリティ (T9, ADR 0003 監視・検知) ---
    // 通知 SNS Topic (運用者が後で email/Slack を購読する想定)。
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `Stagecast Event ${props.eventId} Alarms`,
    });

    // タスク異常: ECS RunningCount が desiredCount を下回る (= タスク落ち) アラーム。
    const services: { name: string; service: ecs.FargateService }[] = [
      { name: "Sfu", service: sfu },
      { name: "Egress", service: egress },
      { name: "CaptionWorker", service: captionWorker },
    ];
    const taskAlarms: cloudwatch.Alarm[] = [];
    for (const { name, service } of services) {
      const alarm = new cloudwatch.Alarm(this, `${name}TaskHealthAlarm`, {
        alarmName: `stagecast-${props.eventId}-${name.toLowerCase()}-task-down`,
        alarmDescription: `${name} task running count dropped below desired (ADR 0003 D-3)`,
        metric: service.metric("RunningTaskCount", { statistic: "Minimum" }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
      taskAlarms.push(alarm);
    }

    // 字幕遅延アラーム: caption-pipeline が EMF で書き出す CaptionLatencyMs を見る。
    const latencyMetric = new cloudwatch.Metric({
      namespace: "Stagecast/CaptionPipeline",
      metricName: "CaptionLatencyMs",
      dimensionsMap: { EventId: props.eventId, Status: "final" },
      statistic: "p95",
      period: Duration.minutes(1),
    });
    const latencyAlarm = new cloudwatch.Alarm(this, "CaptionLatencyAlarm", {
      alarmName: `stagecast-${props.eventId}-caption-latency`,
      alarmDescription: "字幕遅延 (確定) p95 が 3 秒を超えた (DESIGN.md N-2)",
      metric: latencyMetric,
      threshold: 3000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    latencyAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // ログメトリクスフィルタ: 「RTMP disconnect」「reconnect failed」などをカウント。
    const rtmpDisconnectFilter = new logs.MetricFilter(this, "RtmpDisconnectFilter", {
      logGroup,
      metricNamespace: "Stagecast/MediaLayer",
      metricName: "RtmpDisconnects",
      filterPattern: logs.FilterPattern.anyTerm(
        "rtmp disconnect",
        "RTMP disconnect",
        "stream disconnected",
      ),
      metricValue: "1",
      dimensions: { EventId: props.eventId },
    });
    void rtmpDisconnectFilter;

    const rtmpAlarm = new cloudwatch.Alarm(this, "RtmpDisconnectAlarm", {
      alarmName: `stagecast-${props.eventId}-rtmp-disconnect`,
      alarmDescription: "RTMP 切断ログが直近 5 分で複数発生 (ADR 0003 D-3)",
      metric: new cloudwatch.Metric({
        namespace: "Stagecast/MediaLayer",
        metricName: "RtmpDisconnects",
        dimensionsMap: { EventId: props.eventId },
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    rtmpAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    // 統合ダッシュボード。
    const dashboard = new cloudwatch.Dashboard(this, "EventDashboard", {
      dashboardName: `stagecast-${props.eventId}`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: "ECS タスク Running Count",
        left: services.map(({ name, service }) =>
          service.metric("RunningTaskCount", { label: name, statistic: "Minimum" }),
        ),
      }),
      new cloudwatch.GraphWidget({
        title: "字幕遅延 (p50 / p95) ms",
        left: [
          latencyMetric.with({ statistic: "p50", label: "p50" }),
          latencyMetric.with({ statistic: "p95", label: "p95" }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: "字幕発行件数 / RTMP 切断",
        left: [
          new cloudwatch.Metric({
            namespace: "Stagecast/CaptionPipeline",
            metricName: "CaptionsPublished",
            dimensionsMap: { EventId: props.eventId, Status: "final" },
            statistic: "Sum",
            period: Duration.minutes(1),
            label: "Captions/min (final)",
          }),
          new cloudwatch.Metric({
            namespace: "Stagecast/MediaLayer",
            metricName: "RtmpDisconnects",
            dimensionsMap: { EventId: props.eventId },
            statistic: "Sum",
            period: Duration.minutes(5),
            label: "RTMP disconnects/5min",
          }),
        ],
      }),
    );

    new CfnOutput(this, "EventId", { value: props.eventId });
    new CfnOutput(this, "ValkeyEndpoint", { value: valkey.attrEndpointAddress });
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "AlarmTopicArn", { value: alarmTopic.topicArn });
    new CfnOutput(this, "DashboardName", {
      value: dashboard.dashboardName,
      description: "CloudWatch Dashboard 名 (運用者が確認用に開く)",
    });
  }
}

/** イベント ID から決定的なスタック名を作る (orchestrator と共有する規約)。 */
export function eventMediaStackName(eventId: string): string {
  return `StagecastEventMedia-${eventId}`;
}
