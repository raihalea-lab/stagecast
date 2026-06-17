import { createHash } from "node:crypto";
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
  aws_secretsmanager as secretsmanager,
  aws_cloudwatch as cloudwatch,
  aws_sns as sns,
  aws_cloudwatch_actions as cwActions,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import type { CaptionEngineKind, CaptionSinkKind } from "@stagecast/shared";

/** LiveKit / WebRTC が使うポート (config.yaml と Security Group で共有する)。 */
export const LIVEKIT_PORTS = {
  /** signaling (HTTP/WS)。 */
  signaling: 7880,
  /** WebRTC over TCP (ICE/TCP fallback, ADR 0006 D-2)。 */
  rtcTcp: 7881,
  /** WebRTC over UDP (主たる media 経路, ADR 0006 D-2)。 */
  rtcUdp: 7882,
} as const;

/**
 * SFU (LiveKit Server) の ECS サービス名 (ADR 0008 D-2)。reconcile Lambda が
 * `ecs:ListTasks` で参照するため、予測可能な固定名にする。
 */
export const SFU_SERVICE_NAME = "sfu";

/** ECS Cluster の予測可能命名 (reconcile が `ecs:ListTasks` で使う)。 */
export function eventMediaClusterName(eventId: string): string {
  return `stagecast-event-${eventId}`;
}

/** ControlPlaneStack が作る LiveKit 資格情報シークレット名 (control-plane-stack.ts と共有)。 */
const LIVEKIT_SECRET_NAME = "stagecast/livekit";

export interface EventMediaStackProps extends StackProps {
  /** このスタックが対応する配信イベント ID。 */
  eventId: string;
  /** 字幕エンジン経路 (DESIGN.md 6.2)。 */
  captionEngine: CaptionEngineKind;
  /** 独自字幕配信 API を起動するか (DESIGN.md 6.3.2)。 */
  customCaptionApi: boolean;
  /** コンテナイメージ (省略時は既定の参照)。 */
  images?: { sfu?: string; egress?: string; captionWorker?: string };
  /**
   * Egress の録画出力先 S3 バケット名 (ControlPlaneStack の AssetsBucket)。
   * orchestrator/reconcile が制御層 Output から渡す。未指定時は既定名でポリシーだけ整える
   * (実バケットは deploy 時に解決、ADR 0006 D-4)。
   */
  recordingsBucketName?: string;
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
      // reconcile Lambda が `ecs:ListTasks` で参照するため固定名 (ADR 0008 D-2)。
      clusterName: eventMediaClusterName(props.eventId),
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
      // eventId が長い/似ている場合の 40 文字クリップ衝突を short hash で回避 (D5)。
      serverlessCacheName: serverlessCacheName(props.eventId),
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

    // LiveKit 資格情報 (api key/secret) は ControlPlaneStack の Secrets Manager から注入する
    // (コードに置かない, ADR 0001 D-10 / 0006 D-3)。実値投入は deploy 時 (スコープ外)。
    const livekitSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "LiveKitSecret",
      LIVEKIT_SECRET_NAME,
    );
    const livekitSecrets = {
      LIVEKIT_API_KEY: ecs.Secret.fromSecretsManager(livekitSecret, "apiKey"),
      LIVEKIT_API_SECRET: ecs.Secret.fromSecretsManager(livekitSecret, "apiSecret"),
    };

    // Egress は録画を S3 に直接 PUT する。出力先プレフィックスのみに絞る (R2, ADR 0006 D-4)。
    const egressTaskRole = new iam.Role(this, "EgressTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    const recordingsBucketName = props.recordingsBucketName ?? "stagecast-recordings";
    egressTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
        resources: [`arn:aws:s3:::${recordingsBucketName}/recordings/*`],
      }),
    );

    const images = props.images ?? {};
    interface ServiceOptions {
      ports?: { containerPort: number; protocol?: ecs.Protocol }[];
      taskRole?: iam.IRole;
      environment?: Record<string, string>;
      secrets?: Record<string, ecs.Secret>;
      /** 予測可能な ECS service 名 (reconcile が `ecs:ListTasks` で参照, ADR 0008 D-2)。 */
      serviceName?: string;
      /** Public IP 直接公開 (ADR 0008 D-4)。SFU のみ true。 */
      assignPublicIp?: boolean;
    }
    const addService = (
      name: string,
      image: string,
      opts: ServiceOptions = {},
    ): ecs.FargateService => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${name}TaskDef`, {
        cpu: 1024,
        memoryLimitMiB: 2048,
        taskRole: opts.taskRole,
      });
      // ECR プライベートイメージ (R4) は実行ロールに pull 権限が要る。
      // fromRegistry は自動付与しないため、ECR URI のときだけ最小権限を足す。
      if (isEcrImage(image)) {
        taskDef.addToExecutionRolePolicy(
          new iam.PolicyStatement({
            actions: ["ecr:GetAuthorizationToken"],
            resources: ["*"], // GetAuthorizationToken はリソース指定不可。
          }),
        );
        taskDef.addToExecutionRolePolicy(
          new iam.PolicyStatement({
            actions: [
              "ecr:BatchCheckLayerAvailability",
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
            ],
            resources: [ecrRepositoryArnFromUri(image, this.partition)],
          }),
        );
      }
      const container = taskDef.addContainer(`${name}Container`, {
        image: ecs.ContainerImage.fromRegistry(image),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup }),
        environment: {
          STAGECAST_EVENT_ID: props.eventId,
          VALKEY_ENDPOINT: valkey.attrEndpointAddress,
          CAPTION_ENGINE: props.captionEngine,
          CUSTOM_CAPTION_API: String(props.customCaptionApi),
          ...opts.environment,
        },
        ...(opts.secrets ? { secrets: opts.secrets } : {}),
      });
      for (const p of opts.ports ?? []) {
        container.addPortMappings({
          containerPort: p.containerPort,
          ...(p.protocol ? { protocol: p.protocol } : {}),
        });
      }
      return new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        // ephemeral: 破棄を速くするため最小構成。
        minHealthyPercent: 0,
        circuitBreaker: { rollback: false },
        // ADR 0008 D-4: SFU は Public IP 直接公開 (NLB 廃止)。それ以外も同経路で揃える。
        assignPublicIp: opts.assignPublicIp ?? false,
        ...(opts.serviceName ? { serviceName: opts.serviceName } : {}),
        // VPC のパブリックサブネットに置かないと assignPublicIp が効かない。
        ...(opts.assignPublicIp
          ? { vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC } }
          : {}),
      });
    };

    // SFU(LiveKit): signaling(TCP) + WebRTC(TCP fallback / UDP)。config と Valkey を注入 (R1)。
    // ADR 0008 D-4: Public IP を直接公開し、NLB を廃止。reconcile Lambda が ECS から
    // task の Public IP を引いて events.media.livekitUrl に書き戻す (ADR 0008 D-2)。
    const sfu = addService("Sfu", images.sfu ?? "livekit/livekit-server:latest", {
      serviceName: SFU_SERVICE_NAME,
      assignPublicIp: true,
      ports: [
        { containerPort: LIVEKIT_PORTS.signaling, protocol: ecs.Protocol.TCP },
        { containerPort: LIVEKIT_PORTS.rtcTcp, protocol: ecs.Protocol.TCP },
        { containerPort: LIVEKIT_PORTS.rtcUdp, protocol: ecs.Protocol.UDP },
      ],
      environment: { LIVEKIT_CONFIG_BODY: liveKitServerConfig(valkey.attrEndpointAddress) },
      secrets: livekitSecrets,
    });

    // Egress: Chrome ヘッドレスで合成 → RTMP/S3。Valkey で SFU とジョブ共有 (R2, ADR 0006 D-4)。
    const egress = addService("Egress", images.egress ?? "livekit/egress:latest", {
      taskRole: egressTaskRole,
      environment: { EGRESS_CONFIG_BODY: liveKitEgressConfig(valkey.attrEndpointAddress) },
      secrets: livekitSecrets,
    });

    const captionWorker = addService(
      "CaptionWorker",
      images.captionWorker ?? "public.ecr.aws/docker/library/node:24-alpine",
      {
        taskRole: captionTaskRole,
        ...(props.customCaptionApi ? { ports: [{ containerPort: 8080 }] } : {}),
      },
    );

    // --- 外部到達性: Fargate task の Public IP 直接公開 (ADR 0008 D-4) ---
    // NLB は ADR 0008 で廃止。task の ENI に Public IP を付与し、SG で 7880/7881/7882 のみ
    // 開放する。reconcile Lambda が task の Public IP を取得して
    // events.media.livekitUrl に書き戻す (ADR 0008 D-2)。
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.tcp(LIVEKIT_PORTS.signaling),
      "LiveKit signaling (public, ADR 0008 D-4)",
    );
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.tcp(LIVEKIT_PORTS.rtcTcp),
      "WebRTC ICE/TCP fallback (public, ADR 0008 D-4)",
    );
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.udp(LIVEKIT_PORTS.rtcUdp),
      "WebRTC media/UDP (public, ADR 0008 D-4)",
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

    // 字幕 Sink 配信失敗アラーム (D8/N3)。全リトライ失敗 (SinkDeliveryErrors) が継続する Sink を検知。
    // Sink 種別は caption-pipeline の sink.kind と一致させる ("youtube" / "custom-api")。
    // 種別文字列は @stagecast/shared の CaptionSinkKind 型に束縛し、リネーム時にコンパイルで検知する
    // (infra は bin/app.ts を tsx 直実行するため shared の値 import は避け、型のみ参照する)。
    const captionSinkKinds: { kind: CaptionSinkKind; id: string }[] = [
      { kind: "youtube", id: "Youtube" },
      { kind: "custom-api", id: "CustomApi" },
    ];
    for (const { kind, id } of captionSinkKinds) {
      const sinkAlarm = new cloudwatch.Alarm(this, `SinkErrorAlarm${id}`, {
        alarmName: `stagecast-${props.eventId}-sink-${kind}-errors`,
        alarmDescription: `字幕 Sink (${kind}) の配信失敗が直近 5 分で継続 (D8/N3)`,
        metric: new cloudwatch.Metric({
          namespace: "Stagecast/CaptionPipeline",
          metricName: "SinkDeliveryErrors",
          dimensionsMap: { EventId: props.eventId, Sink: kind },
          statistic: "Sum",
          period: Duration.minutes(5),
        }),
        threshold: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      sinkAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
    }

    // 翻訳失敗アラーム (N-2)。
    // SEARCH 関数は CloudWatch Alarm では使えないため (ダッシュボード専用)、
    // EventId ディメンションのみの固定メトリクスを使う。
    // アプリケーション側 (caption-pipeline) が言語横断の集約メトリクスを別途 put する想定。
    const translateErrorAlarmMetric = new cloudwatch.Metric({
      namespace: "Stagecast/CaptionPipeline",
      metricName: "TranslateErrors",
      dimensionsMap: { EventId: props.eventId },
      statistic: "Sum",
      period: Duration.minutes(5),
    });
    const translateAlarm = new cloudwatch.Alarm(this, "TranslateErrorAlarm", {
      alarmName: `stagecast-${props.eventId}-translate-errors`,
      alarmDescription: "翻訳の全リトライ失敗が直近 5 分で継続 (N-2 品質劣化)",
      metric: translateErrorAlarmMetric,
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    translateAlarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));

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
      new cloudwatch.GraphWidget({
        title: "字幕 Sink 配信エラー / 再試行",
        left: captionSinkKinds.flatMap(({ kind }) => [
          new cloudwatch.Metric({
            namespace: "Stagecast/CaptionPipeline",
            metricName: "SinkDeliveryErrors",
            dimensionsMap: { EventId: props.eventId, Sink: kind },
            statistic: "Sum",
            period: Duration.minutes(5),
            label: `${kind} errors/5min`,
          }),
          new cloudwatch.Metric({
            namespace: "Stagecast/CaptionPipeline",
            metricName: "SinkDeliveryRetries",
            dimensionsMap: { EventId: props.eventId, Sink: kind },
            statistic: "Sum",
            period: Duration.minutes(5),
            label: `${kind} retries/5min`,
          }),
        ]),
      }),
      new cloudwatch.GraphWidget({
        title: "翻訳失敗 (全言語合算)",
        // SEARCH はダッシュボードでは使えるので、ここでは動的に全言語を合算する。
        left: [
          new cloudwatch.MathExpression({
            expression: `SUM(SEARCH('{Stagecast/CaptionPipeline,EventId,Language} MetricName="TranslateErrors" EventId="${props.eventId}"', 'Sum', 300))`,
            label: "TranslateErrors (all languages)",
            period: Duration.minutes(5),
            usingMetrics: {},
          }),
        ],
      }),
    );

    new CfnOutput(this, "EventId", { value: props.eventId });
    new CfnOutput(this, "ValkeyEndpoint", { value: valkey.attrEndpointAddress });
    // ADR 0008 D-4: NLB を廃止。stage-web は events.media.livekitUrl (reconcile が書き戻す
    // Public IP ベース URL) で接続する。
    new CfnOutput(this, "ClusterName", { value: cluster.clusterName });
    new CfnOutput(this, "SfuServiceName", {
      value: SFU_SERVICE_NAME,
      description: "reconcile Lambda が ecs:ListTasks で参照する SFU service 名 (ADR 0008 D-2)",
    });
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

/** イメージ参照が ECR プライベートレジストリの URI かどうか (R4)。 */
export function isEcrImage(image: string): boolean {
  return /\.dkr\.ecr\.[^/]+\.amazonaws\.com\//.test(image);
}

/**
 * ECR イメージ URI からリポジトリ ARN を導出する (R4)。
 * URI: `<account>.dkr.ecr.<region>.amazonaws.com/<repo>[:tag]`
 * ARN: `arn:<partition>:ecr:<region>:<account>:repository/<repo>`
 */
export function ecrRepositoryArnFromUri(image: string, partition: string): string {
  const slash = image.indexOf("/");
  const host = image.slice(0, slash);
  const pathWithTag = image.slice(slash + 1);
  const repo = pathWithTag.split(":")[0]!; // タグ部分を除去 (repo 名にコロンは入らない)。
  const [account, , , region] = host.split(".");
  return `arn:${partition}:ecr:${region}:${account}:repository/${repo}`;
}

/**
 * Valkey serverless cache 名を生成する (D5)。
 *
 * ElastiCache の `ServerlessCacheName` は 40 文字上限・英数とハイフンのみ。eventId を素朴に
 * 40 文字でクリップすると、長く似た eventId 同士で衝突しうる。eventId の sha256 short hash を
 * 末尾に付けることで、prefix が衝突しても全体としては一意になるようにする。
 */
export function serverlessCacheName(eventId: string): string {
  const hash = createHash("sha256").update(eventId).digest("hex").slice(0, 8);
  const prefix = "stagecast-";
  const suffix = `-${hash}`;
  // 残り枠 = 40 - prefix(10) - suffix(9) = 21 文字を eventId に割り当てる。
  const room = 40 - prefix.length - suffix.length;
  const body = eventId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, room)
    .replace(/-+$/, ""); // 末尾ハイフンは suffix と二重化するので落とす。
  return `${prefix}${body}${suffix}`;
}

/**
 * LiveKit Server の config.yaml 本文を生成する (R1, ADR 0006 D-3)。
 *
 * Valkey を redis アダプタとして接続し、複数ノード/Egress と状態を共有する。ポートは
 * NLB リスナ (LIVEKIT_PORTS) と一致させる。api key/secret は config に直書きせず
 * LIVEKIT_API_KEY/SECRET (Secrets Manager 由来) を image entrypoint 経由で与える。
 */
export function liveKitServerConfig(valkeyEndpoint: string): string {
  return [
    `port: ${LIVEKIT_PORTS.signaling}`,
    "rtc:",
    `  tcp_port: ${LIVEKIT_PORTS.rtcTcp}`,
    `  udp_port: ${LIVEKIT_PORTS.rtcUdp}`,
    `  port_range_start: ${LIVEKIT_PORTS.rtcUdp}`,
    `  port_range_end: ${LIVEKIT_PORTS.rtcUdp}`,
    // ENI 越しの ICE candidate を正しく広告するため外部 IP を使う。
    "  use_external_ip: true",
    "redis:",
    // ElastiCache serverless は in-transit 暗号化必須なので TLS を有効化。
    `  address: ${valkeyEndpoint}:6379`,
    "  use_tls: true",
    "logging:",
    "  level: info",
    "  json: true",
  ].join("\n");
}

/**
 * LiveKit Egress の config.yaml 本文を生成する (R2, ADR 0006 D-4)。
 *
 * Server と同じ Valkey を共有してジョブを受け取り、Chrome ヘッドレスで RoomComposite を
 * 合成する。`ws_url` は SFU の VPC 内エンドポイント (signaling ポート) を指す。
 */
export function liveKitEgressConfig(valkeyEndpoint: string): string {
  return [
    "redis:",
    `  address: ${valkeyEndpoint}:6379`,
    "  use_tls: true",
    `ws_url: ws://localhost:${LIVEKIT_PORTS.signaling}`,
    "logging:",
    "  level: info",
    "  json: true",
  ].join("\n");
}
