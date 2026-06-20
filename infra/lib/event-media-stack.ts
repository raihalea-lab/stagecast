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
  aws_elasticloadbalancingv2 as elbv2,
  aws_route53 as route53,
  aws_route53_targets as route53Targets,
  aws_certificatemanager as acm,
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
  /**
   * R12-followup-10 / ADR 0011 案 B: LiveKit 内蔵 TURN server。
   * シンメトリック NAT 越しのクライアント (実機検証で 14.8.39.x の Mac で確認) を救済する。
   */
  turnUdp: 3478,
  /** TURN relay UDP range の開始 (実際の relay ポートはこの範囲から動的割当)。 */
  turnRelayStart: 50300,
  /** TURN relay UDP range の終端。100 ポート分。同時接続 ~50 まで耐える。 */
  turnRelayEnd: 50400,
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
  /**
   * LiveKit シグナリング TLS 用 ACM 証明書 ARN (ADR 0009 D-1, D-3)。
   * 指定時のみ NLB + TLS Listener + Route53 ARecord を作成する。
   * 未指定時は ADR 0008 D-4 の Public IP 直接公開にフォールバック (後方互換)。
   */
  tlsCertificateArn?: string;
  /** LiveKit per-event DNS 用 Route53 HostedZone ID (ADR 0009 D-4)。tlsCertificateArn と同時に指定する。 */
  hostedZoneId?: string;
  /** LiveKit per-event DNS 用 Route53 HostedZone 名 (例: `example.com`)。 */
  hostedZoneName?: string;
  /** LiveKit シグナリング用ドメイン (例: `media.example.com`)。`event-XXXXXXXX.${mediaDomainName}` で per-event 名を組み立てる。 */
  mediaDomainName?: string;
  /**
   * ControlPlaneStack で事前作成した共有 VPC の情報 (R12-followup, N-1)。
   * 指定時はこの VPC を参照し per-event VPC を作らない (イベント起動時間 2-3 分短縮)。
   * 未指定時は従来通り per-event VPC を作成 (後方互換)。
   */
  sharedVpc?: {
    vpcId: string;
    vpcCidr: string;
    availabilityZones: string[];
    publicSubnetIds: string[];
  };
  /**
   * YouTube RTMP 取り込み URL (R12, ADR 0006 D-4)。
   * 例: `rtmp://a.rtmp.youtube.com/live2`。control-api の Egress 起動 API が参照し、
   * `startRoomCompositeEgress` の `streamOutputs.urls = [${rtmpUrl}/${streamKey}]` を組み立てる。
   * 現状の EventMediaStack 内では参照されない (将来 Egress 自動起動時の予約フィールド)。
   */
  rtmpUrl?: string;
  /**
   * YouTube ストリームキーを格納した Secret のフィールド名 (R12)。
   * 既存の `stagecast/youtube` Secret 内のキーを指す (例: `defaultStreamKey`)。
   * control-api の Egress 起動 API が Secret 値を取得して使う。
   */
  streamKeyRef?: string;
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

    // --- ネットワーク ---
    // 共有 VPC (ControlPlaneStack で事前作成) があればそれを参照、なければ per-event VPC を作成。
    // 共有 VPC を使うとイベント起動時間が約 2-3 分短縮できる (VPC + subnet + route table 作成省略)。
    // NAT Gateway は使わず、全サービスをパブリックサブネットに配置し assignPublicIp で直接インターネットに出る。
    // Egress/CaptionWorker の SG はインバウンドルールが無いのでパブリック IP があっても外部からアクセスされない。
    const vpc: ec2.IVpc = props.sharedVpc
      ? ec2.Vpc.fromVpcAttributes(this, "SharedVpcRef", {
          vpcId: props.sharedVpc.vpcId,
          vpcCidrBlock: props.sharedVpc.vpcCidr,
          availabilityZones: props.sharedVpc.availabilityZones,
          publicSubnetIds: props.sharedVpc.publicSubnetIds,
        })
      : new ec2.Vpc(this, "Vpc", {
          maxAzs: 2,
          natGateways: 0,
          subnetConfiguration: [
            { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
          ],
        });

    const cluster = new ecs.Cluster(this, "Cluster", {
      vpc,
      // reconcile Lambda が `ecs:ListTasks` で参照するため固定名 (ADR 0008 D-2)。
      clusterName: eventMediaClusterName(props.eventId),
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // --- 共有状態: ElastiCache for Valkey (cluster mode disabled, ADR 0010 D-6) ---
    // R12-followup-3 (ADR 0010 D-6): Serverless (cluster mode 強制) では LiveKit psrpc の
    // service registration が SUBSCRIBE/PUBLISH の cluster shard 制約で機能しない (sidecar 同居でも不可)。
    // cluster-mode-disabled の単一ノード ReplicationGroup に切替えて LiveKit が想定する標準 Redis モードで動かす。
    // コスト: cache.t4g.micro ~$0.020/h × イベント起動時間 (1〜3h なら $0.02〜0.06 / イベント)。
    const valkeySg = new ec2.SecurityGroup(this, "ValkeySg", { vpc, allowAllOutbound: true });
    valkeySg.addIngressRule(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(6379),
      "Valkey port from within VPC",
    );
    const valkeySubnetGroup = new elasticache.CfnSubnetGroup(this, "ValkeySubnetGroup", {
      description: `Valkey subnet group for event ${props.eventId}`,
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds,
    });
    const valkey = new elasticache.CfnReplicationGroup(this, "Valkey", {
      replicationGroupDescription: `Valkey for event ${props.eventId}`,
      engine: "valkey",
      cacheNodeType: "cache.t4g.micro",
      numCacheClusters: 1,
      automaticFailoverEnabled: false,
      multiAzEnabled: false,
      transitEncryptionEnabled: true,
      atRestEncryptionEnabled: true,
      port: 6379,
      cacheSubnetGroupName: valkeySubnetGroup.ref,
      securityGroupIds: [valkeySg.securityGroupId],
      // ephemeral: 破棄を速くするため自動バックアップは行わない。
      snapshotRetentionLimit: 0,
    });
    valkey.addDependency(valkeySubnetGroup);
    // 単一ノード (cluster mode disabled) なので primary endpoint を使う (Serverless 時とは異なる属性名)。
    const valkeyEndpoint = valkey.attrPrimaryEndPointAddress;

    // --- メディア/字幕の Fargate サービス群 ---
    const logGroup = new logs.LogGroup(this, "Logs", {
      retention: logs.RetentionDays.ONE_WEEK,
      // スタックがロールバック/削除されてもログを残す (デバッグに必要)。
      // 1 週間で自動失効するので手動クリーンアップは不要。
      removalPolicy: RemovalPolicy.RETAIN,
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
    // LiveKit Server は LIVEKIT_KEYS env ("key: secret" 形式) で API キーを読む。
    // Secrets Manager の livekitKeys フィールドに "apiKey: apiSecret" 形式で格納し、
    // ECS Secret で LIVEKIT_KEYS に直接注入する (シェル不要、Docker イメージの sh 依存なし)。
    // livekitKeys は SettingsService の regenerateLiveKit / putLiveKit が自動生成する。
    // Egress も同じ形式で api_key / api_secret を受け取る。
    const livekitSecrets = {
      LIVEKIT_KEYS: ecs.Secret.fromSecretsManager(livekitSecret, "livekitKeys"),
      LIVEKIT_API_KEY: ecs.Secret.fromSecretsManager(livekitSecret, "apiKey"),
      LIVEKIT_API_SECRET: ecs.Secret.fromSecretsManager(livekitSecret, "apiSecret"),
    };

    // ADR 0010: SFU と Egress を同一 Task に sidecar 同居させるため、SFU の TaskRole に
    // Egress 用 S3 書き込み権限を統合する。Egress 単独の TaskRole は廃止 (ADR 0010 D-3, D-5)。
    const sfuTaskRole = new iam.Role(this, "SfuTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    const recordingsBucketName = props.recordingsBucketName ?? "stagecast-recordings";
    // Egress は録画を S3 に直接 PUT する。出力先プレフィックスのみに絞る (ADR 0006 D-4)。
    sfuTaskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
        resources: [`arn:aws:s3:::${recordingsBucketName}/recordings/*`],
      }),
    );

    const images = props.images ?? {};
    interface SidecarOptions {
      /** sidecar container 名 (`${name}Container` で TaskDef に追加) */
      name: string;
      image: string;
      environment?: Record<string, string>;
      secrets?: Record<string, ecs.Secret>;
      /** essential=false で sidecar クラッシュが Task 再起動を起こさないよう保護 (ADR 0010 D-1) */
      essential?: boolean;
      /** R12-followup-14: coturn は entryPoint で external-ip を解決する必要があるため上書き可能に */
      entryPoint?: string[];
    }
    interface ServiceOptions {
      ports?: { containerPort: number; protocol?: ecs.Protocol }[];
      taskRole?: iam.IRole;
      environment?: Record<string, string>;
      secrets?: Record<string, ecs.Secret>;
      /** 予測可能な ECS service 名 (reconcile が `ecs:ListTasks` で参照, ADR 0008 D-2)。 */
      serviceName?: string;
      /** コンテナの command を上書きする (プレースホルダイメージの即終了防止用)。 */
      command?: string[];
      /**
       * コンテナの entryPoint を上書きする (SFU の Public IP 注入用)。
       * `["sh", "-c", "..."]` 等を渡し、内部でランタイム IP を解決してから真の binary を exec する。
       */
      entryPoint?: string[];
      /** TaskDef の vCPU。指定なしは 1024 (1 vCPU)。 */
      cpu?: number;
      /** TaskDef のメモリ MiB。指定なしは 2048。 */
      memoryLimitMiB?: number;
      /** sidecar コンテナ群 (ADR 0010: SFU TaskDef に Egress を同居)。 */
      sidecars?: SidecarOptions[];
    }
    const addService = (
      name: string,
      image: string,
      opts: ServiceOptions = {},
    ): ecs.FargateService => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${name}TaskDef`, {
        cpu: opts.cpu ?? 1024,
        memoryLimitMiB: opts.memoryLimitMiB ?? 2048,
        taskRole: opts.taskRole,
        // caption-worker の ECR イメージは arm64 でビルドするため全サービスを arm64 で統一。
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });
      const grantEcrPull = (image: string): void => {
        if (!isEcrImage(image)) return;
        // ECR プライベートイメージ (R4) は実行ロールに pull 権限が要る。
        // fromRegistry は自動付与しないため、ECR URI のときだけ最小権限を足す。
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
      };
      grantEcrPull(image);
      const container = taskDef.addContainer(`${name}Container`, {
        image: ecs.ContainerImage.fromRegistry(image),
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: name, logGroup }),
        environment: {
          STAGECAST_EVENT_ID: props.eventId,
          VALKEY_ENDPOINT: valkeyEndpoint,
          CAPTION_ENGINE: props.captionEngine,
          CUSTOM_CAPTION_API: String(props.customCaptionApi),
          ...opts.environment,
        },
        ...(opts.secrets ? { secrets: opts.secrets } : {}),
        ...(opts.command ? { command: opts.command } : {}),
        ...(opts.entryPoint ? { entryPoint: opts.entryPoint } : {}),
      });
      for (const p of opts.ports ?? []) {
        container.addPortMappings({
          containerPort: p.containerPort,
          ...(p.protocol ? { protocol: p.protocol } : {}),
        });
      }
      // sidecar コンテナを追加 (ADR 0010: SFU TaskDef に Egress を同居)。
      for (const sidecar of opts.sidecars ?? []) {
        grantEcrPull(sidecar.image);
        taskDef.addContainer(`${sidecar.name}Container`, {
          image: ecs.ContainerImage.fromRegistry(sidecar.image),
          logging: ecs.LogDrivers.awsLogs({ streamPrefix: sidecar.name, logGroup }),
          essential: sidecar.essential ?? false,
          environment: {
            STAGECAST_EVENT_ID: props.eventId,
            VALKEY_ENDPOINT: valkeyEndpoint,
            ...sidecar.environment,
          },
          ...(sidecar.secrets ? { secrets: sidecar.secrets } : {}),
          ...(sidecar.entryPoint ? { entryPoint: sidecar.entryPoint } : {}),
        });
      }
      return new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        // ephemeral: 破棄を速くするため最小構成。
        minHealthyPercent: 0,
        circuitBreaker: { rollback: false },
        // NAT Gateway 廃止: 全サービスをパブリックサブネットに配置して直接インターネットへ出る。
        assignPublicIp: true,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        ...(opts.serviceName ? { serviceName: opts.serviceName } : {}),
      });
    };

    // SFU(LiveKit): signaling(TCP) + WebRTC(TCP fallback / UDP)。config と Valkey を注入 (R1)。
    // ADR 0008 D-4: Public IP を直接公開し、NLB を廃止。reconcile Lambda が ECS から
    // task の Public IP を引いて events.media.livekitUrl に書き戻す (ADR 0008 D-2)。
    // LIVEKIT_KEYS は Secret の livekitKeys フィールドから ECS Secret で直接注入 (シェル不要)。
    // 4 つのプロパティが全て揃っているときのみ NLB + TLS 構成。揃っていなければ ADR 0008 D-4 の
    // Public IP 直接公開にフォールバックする (後方互換)。tlsProps は Egress の LIVEKIT_WS_URL
    // 解決にも使うので、SFU 作成より前に宣言する。
    const tlsProps =
      props.tlsCertificateArn && props.hostedZoneId && props.hostedZoneName && props.mediaDomainName
        ? {
            certificateArn: props.tlsCertificateArn,
            hostedZoneId: props.hostedZoneId,
            hostedZoneName: props.hostedZoneName,
            mediaDomainName: props.mediaDomainName,
          }
        : undefined;

    // ADR 0010: SFU と Egress を同一 Task に sidecar 同居。Egress は localhost で SFU と疎通し
    // (LIVEKIT_WS_URL=ws://localhost:7880)、psrpc は Valkey 経由で共有する。
    // Task は SFU (1 vCPU) + Egress (Chrome ヘッドレス, 1 vCPU) で合計 2 vCPU / 4 GiB に増強。
    const sfu = addService("Sfu", images.sfu ?? "livekit/livekit-server:latest", {
      serviceName: SFU_SERVICE_NAME,
      cpu: 2048,
      memoryLimitMiB: 4096,
      taskRole: sfuTaskRole,
      ports: [
        { containerPort: LIVEKIT_PORTS.signaling, protocol: ecs.Protocol.TCP },
        { containerPort: LIVEKIT_PORTS.rtcTcp, protocol: ecs.Protocol.TCP },
        { containerPort: LIVEKIT_PORTS.rtcUdp, protocol: ecs.Protocol.UDP },
        // R12-followup-10 / ADR 0011 案 B: LiveKit 内蔵 TURN server (UDP 3478)。
        // awsvpc mode では SG が支配的なので relay range (50300-50400) は SG で開放するだけで動く。
        { containerPort: LIVEKIT_PORTS.turnUdp, protocol: ecs.Protocol.UDP },
      ],
      // R12-followup-4: LiveKit Server は config-body 用の env 名が `LIVEKIT_CONFIG` (cmd/server/main.go)。
      // 過去 `LIVEKIT_CONFIG_BODY` を渡していたため config が読まれず single-node routing で起動し、
      // redis が認識されず Egress と通信できなかった。正しい名前 `LIVEKIT_CONFIG` に修正。
      // R12-followup-9: 第 2 引数で VPC CIDR を渡し、Pion の host candidate から VPC Private IP を除外する。
      environment: { LIVEKIT_CONFIG: liveKitServerConfig(valkeyEndpoint, vpc.vpcCidrBlock) },
      secrets: livekitSecrets,
      // R12-followup-6: Fargate Task の Public IP を ICE candidate に広告するため起動時に解決する。
      // ECS Container metadata V4 ($ECS_CONTAINER_METADATA_URI_V4/task) → Networks[0].IPv4Addresses[0] は
      // private IP のみ返すため、外部 echo service (ifconfig.io) で Public IP を取得する。
      // 取得した IP を `--node-ip` フラグで LiveKit Server に渡す (cmd/server/main.go の NODE_IP env / --node-ip flag)。
      // `wget -qO-` を使うのは livekit/livekit-server image が alpine ベースで wget が同梱されているため。
      //
      // R12-followup-11: LIVEKIT_KEYS env だけでは TURN credential 生成時の keys map に反映されないため、
      // LIVEKIT_CONFIG yaml に `keys:` セクションを動的注入する。 実機検証 (PR #101 後) で
      // JoinResponse の iceServers に username/credential が空のまま配信され TURN authentication 失敗を確認。
      // /tmp は tmpfs (Fargate ephemeral storage) なので Secret は永続化されない。
      entryPoint: [
        "sh",
        "-c",
        // R12-followup-14: yaml 内の `__NODE_IP__` / `__TURN_CREDENTIAL__` を sed で実値に置換。
        // - NODE_IP: ifconfig.io で取得した Task の Public IP (coturn の host にもなる)
        // - TURN_CREDENTIAL: LIVEKIT_API_SECRET を流用 (coturn sidecar の static-auth password と同じ値)
        'NODE_IP=$(wget -qO- --timeout=5 https://ifconfig.io || wget -qO- --timeout=5 https://api.ipify.org) && echo "Resolved NODE_IP=$NODE_IP" && printf "%s\\nkeys:\\n  %s\\n" "$LIVEKIT_CONFIG" "$LIVEKIT_KEYS" > /tmp/livekit.yaml && sed -i "s|__NODE_IP__|$NODE_IP|g; s|__TURN_CREDENTIAL__|$LIVEKIT_API_SECRET|g" /tmp/livekit.yaml && exec /livekit-server --config /tmp/livekit.yaml --keys "$LIVEKIT_KEYS" --node-ip "$NODE_IP"',
      ],
      sidecars: [
        {
          name: "Egress",
          image: images.egress ?? "livekit/egress:latest",
          essential: false,
          environment: {
            EGRESS_CONFIG_BODY: liveKitEgressConfig(valkeyEndpoint),
            // ADR 0010 D-2: 同一 Task 内なので localhost で素 WebSocket で繋ぐ (TLS 不要)。
            LIVEKIT_WS_URL: `ws://localhost:${LIVEKIT_PORTS.signaling}`,
          },
          secrets: livekitSecrets,
        },
        // R12-followup-14 / ADR 0011 案 C: coturn TURN server を SFU と同一 Task に sidecar 同居。
        // LiveKit 内蔵 TURN (v1.13.1) は iceServers の username/credential が wire 上に乗らない不具合 (R12-followup-10〜13 で確認) があり、
        // 代替として coturn を立てる。同 Task なので SFU と Public IP を共有、 SG は既存の TURN ポート (3478) + relay range (50300-50400) を流用。
        // 認証: static-auth (username=stagecast, password=LIVEKIT_API_SECRET)。
        //   - LIVEKIT_API_SECRET を流用するのは Secret 数を減らすため (本来別 Secret が筋だが MVP 簡略化)。
        //   - LiveKit yaml の rtc.turn_servers にも同じ credential を入れる (sed 置換)。
        {
          name: "Coturn",
          // R12-followup-15: 公式 `coturn/coturn:latest` は debian-slim で wget が無く external-ip 解決に失敗。
          // alpine + wget 同梱の `instrumentisto/coturn:latest` に変更 (信頼できる maintainer)。
          image: "instrumentisto/coturn:latest",
          essential: false,
          environment: {},
          secrets: {
            TURN_SECRET: livekitSecrets.LIVEKIT_API_SECRET,
          },
          entryPoint: [
            "sh",
            "-c",
            // entrypoint で external-ip を解決して turnserver を起動。
            // - --no-tls / --no-dtls / --no-cli: 余計なポート (5349 / 5766) を開かない (今回は UDP TURN のみ)。
            // - --lt-cred-mech: long-term credential。 username=stagecast, password=$TURN_SECRET で認証。
            // - relay-ip は明示せず listen-ip 0.0.0.0 + external-ip で十分。
            'EXT_IP=$(wget -qO- --timeout=5 https://ifconfig.io || wget -qO- --timeout=5 https://api.ipify.org) && echo "coturn external-ip=$EXT_IP" && exec turnserver --listening-port=3478 --listening-ip=0.0.0.0 --external-ip="$EXT_IP" --min-port=50300 --max-port=50400 --realm=stagecast.local --lt-cred-mech --user="stagecast:$TURN_SECRET" --no-tls --no-dtls --no-cli --log-file=stdout --no-stdout-log=false',
          ],
        },
      ],
    });

    const captionWorker = addService(
      "CaptionWorker",
      images.captionWorker ?? "public.ecr.aws/docker/library/node:24-alpine",
      {
        taskRole: captionTaskRole,
        ...(props.customCaptionApi ? { ports: [{ containerPort: 8080 }] } : {}),
        // プレースホルダイメージ (node:24-alpine) は引数なしで即終了する。
        // 実 caption-worker イメージが ECR に push されるまで sleep で生かしておく。
        ...(!images.captionWorker ? { command: ["sleep", "infinity"] } : {}),
        // CAPTION_BUS=valkey で Valkey Streams への常時接続を確立し、
        // LIVEKIT_URL 未設定時もイベントループを維持してプロセスが即終了しないようにする。
        // 字幕を Valkey Streams 経由で配信するのは本来の設計でもある (T3, ADR 0002)。
        ...(images.captionWorker
          ? {
              environment: { CAPTION_BUS: "valkey" },
              secrets: livekitSecrets,
            }
          : {}),
      },
    );

    // --- 外部到達性: Fargate task の Public IP 直接公開 (ADR 0008 D-4) ---
    // task の ENI に Public IP を付与し、SG で 7880/7881/7882 を開放する。
    // ADR 0009 D-2: メディア (7881/7882) は引き続き Public IP 直接。
    // ADR 0009 D-1: シグナリング (7880) は NLB 経由が推奨。後方互換のため 0.0.0.0/0 → 7880 も維持する。
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.tcp(LIVEKIT_PORTS.signaling),
      "LiveKit signaling (public, fallback - ADR 0009 D-1)",
    );
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.tcp(LIVEKIT_PORTS.rtcTcp),
      "WebRTC ICE/TCP fallback (public, ADR 0008 D-4 / ADR 0009 D-2)",
    );
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.udp(LIVEKIT_PORTS.rtcUdp),
      "WebRTC media/UDP (public, ADR 0008 D-4 / ADR 0009 D-2)",
    );
    // R12-followup-10 / ADR 0011 案 B: LiveKit 内蔵 TURN server (UDP 3478 + relay range)。
    // シンメトリック NAT 越しのクライアントが SFU 直接 UDP では NAT を抜けられない場合の救済経路。
    // 実機検証 (2026-06-20) で publisherCandidates の srflx の related-port と STUN port が異なり
    // (例: srflx 14.8.39.x:46547 related 192.168.1.39:57015) シンメトリック NAT を確認済み。
    // R12-followup-10 / ADR 0011 plan B: EC2 SG description は ASCII 限定 (日本語 NG)。
    // 詳細な経緯コメントはコード本体に書き、description は短く英語のみ。
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.udp(LIVEKIT_PORTS.turnUdp),
      "LiveKit TURN/UDP for NAT traversal (R12-followup-10)",
    );
    sfu.connections.allowFromAnyIpv4(
      ec2.Port.udpRange(LIVEKIT_PORTS.turnRelayStart, LIVEKIT_PORTS.turnRelayEnd),
      "LiveKit TURN relay UDP range (R12-followup-10)",
    );

    // --- NLB + TLS + Route53 でシグナリングを wss:// 化 (ADR 0009 D-1, D-3, D-4) ---
    if (tlsProps) {
      // internet-facing NLB。NLB は無料の cross-zone load balancing を有効化して
      // SFU タスクの配置 AZ に依存せず到達できるようにする。
      const nlb = new elbv2.NetworkLoadBalancer(this, "SfuNlb", {
        vpc,
        internetFacing: true,
        crossZoneEnabled: true,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      });
      // SFU の SG が NLB の listener からのトラフィックを受け取るための許可。
      // NLB はクライアント IP をそのまま転送する (preserve client IP) ため、SG ルールは
      // 0.0.0.0/0 ベース。既存の allowFromAnyIpv4(7880) で既にカバーされている。

      const certificate = acm.Certificate.fromCertificateArn(
        this,
        "SfuTlsCertificate",
        tlsProps.certificateArn,
      );
      const tgGroup = new elbv2.NetworkTargetGroup(this, "SfuSignalingTargetGroup", {
        vpc,
        port: LIVEKIT_PORTS.signaling,
        protocol: elbv2.Protocol.TCP,
        targetType: elbv2.TargetType.IP,
        targets: [
          sfu.loadBalancerTarget({
            containerName: "SfuContainer",
            containerPort: LIVEKIT_PORTS.signaling,
          }),
        ],
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
          interval: Duration.seconds(10),
        },
        // ephemeral スタックなので速い deregister で破棄時間を短縮。
        deregistrationDelay: Duration.seconds(10),
      });
      nlb.addListener("SfuTlsListener", {
        port: 443,
        protocol: elbv2.Protocol.TLS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.TLS13_RES,
        defaultAction: elbv2.NetworkListenerAction.forward([tgGroup]),
      });

      // per-event DNS: event-{eventId.slice(0,8)}.{mediaDomainName} (ADR 0009 D-4)。
      const livekitDomainName = `event-${props.eventId.slice(0, 8)}.${tlsProps.mediaDomainName}`;
      const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "MediaHostedZoneRef", {
        hostedZoneId: tlsProps.hostedZoneId,
        zoneName: tlsProps.hostedZoneName,
      });
      new route53.ARecord(this, "SfuAliasRecord", {
        zone: hostedZone,
        recordName: livekitDomainName,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(nlb)),
      });

      // CfnOutput: reconcile Lambda が DescribeStacks で取得し events.media.livekitUrl に書き戻す。
      new CfnOutput(this, "LivekitDomainName", {
        value: livekitDomainName,
        description:
          "LiveKit シグナリング用ドメイン (NLB + ACM + Route53, ADR 0009)。reconcile が wss:// に変換して events.media に書き戻す",
      });
      new CfnOutput(this, "SfuNlbDnsName", {
        value: nlb.loadBalancerDnsName,
        description: "NLB の AWS-managed DNS (alias 解決確認用)",
      });
    }

    // --- オブザーバビリティ (T9, ADR 0003 監視・検知) ---
    // 通知 SNS Topic (運用者が後で email/Slack を購読する想定)。
    const alarmTopic = new sns.Topic(this, "AlarmTopic", {
      displayName: `Stagecast Event ${props.eventId} Alarms`,
    });

    // タスク異常: ECS RunningCount が desiredCount を下回る (= タスク落ち) アラーム。
    // ADR 0010: Egress は SFU の sidecar として同 Task に同居するので独立サービスとしては監視しない
    // (essential: false で Egress 単独クラッシュは Task 再起動を起こさず、SFU の RunningTaskCount 経由で間接的に検知される)。
    const services: { name: string; service: ecs.FargateService }[] = [
      { name: "Sfu", service: sfu },
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
    // dimensions は CloudWatch Logs MetricFilter の filterPattern 構文 (anyTerm 等) と
    // 組み合わせられない制約があるため使用しない。ロググループ自体が per-event なので
    // EventId ディメンションは不要 (アラーム側で直接 metricName を参照する)。
    const rtmpDisconnectFilter = new logs.MetricFilter(this, "RtmpDisconnectFilter", {
      logGroup,
      metricNamespace: "Stagecast/MediaLayer",
      metricName: `RtmpDisconnects-${props.eventId}`,
      filterPattern: logs.FilterPattern.anyTerm(
        "rtmp disconnect",
        "RTMP disconnect",
        "stream disconnected",
      ),
      metricValue: "1",
    });
    void rtmpDisconnectFilter;

    const rtmpAlarm = new cloudwatch.Alarm(this, "RtmpDisconnectAlarm", {
      alarmName: `stagecast-${props.eventId}-rtmp-disconnect`,
      alarmDescription: "RTMP 切断ログが直近 5 分で複数発生 (ADR 0003 D-3)",
      // MetricFilter が per-event メトリクス名で publish するのでディメンション無しで引く。
      metric: new cloudwatch.Metric({
        namespace: "Stagecast/MediaLayer",
        metricName: `RtmpDisconnects-${props.eventId}`,
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
            metricName: `RtmpDisconnects-${props.eventId}`,
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
    new CfnOutput(this, "ValkeyEndpoint", { value: valkeyEndpoint });
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
 *
 * @param vpcCidr R12-followup-9: 渡すと VPC Private IP も ICE host candidate から除外する
 *                (ブラウザはインターネット経由で接続するので VPC 内 IP には到達不可)。
 *                CDK で `vpc.vpcCidrBlock` を渡す想定。テストでは固定値を渡す。
 */
export function liveKitServerConfig(valkeyEndpoint: string, vpcCidr?: string): string {
  return [
    `port: ${LIVEKIT_PORTS.signaling}`,
    // ADR 0009 D-1: TLS 終端は NLB が行う (LiveKit 自身は plain HTTP/WS のまま)。
    // クライアントは wss://event-XXXXXXXX.{mediaDomainName} で接続する。
    "rtc:",
    `  tcp_port: ${LIVEKIT_PORTS.rtcTcp}`,
    // R12-followup-7: `udp_port` 単独で UDP mux mode を有効化する。
    // LiveKit は `port_range_start/end` と `udp_port` を同時指定すると挙動が混在し
    // (ログ上は `rtc.portUDP: {Start: 7882, End: 0}` のまま ICE pair が失敗した)、
    // 公式には mux mode 単独 か port_range のどちらか択一が推奨されている。
    // Fargate は NLB UDP リスナを単一ポートに絞っているので mux mode (1 ポートで多重化) を採用。
    `  udp_port: ${LIVEKIT_PORTS.rtcUdp}`,
    // R12-followup-5: Fargate には EC2 instance metadata service が無いので、
    // `use_external_ip: true` を有効にすると livekit/mediatransportutil の
    // getNAT1to1IPsForConf が空配列に対し rand.Intn(0) で panic する (実機確認済み)。
    // 代わりに LiveKit のデフォルト (STUN 経由で external IP を解決) に任せる。
    // ADR 0009 D-2 で想定していた「ENI Public IP を ICE candidate に広告」は STUN で代替される。
    //
    // R12-followup-8: 以下 2 行は ICE 確立の信頼性を上げる調整 (LiveKit Issue #4049/#3508 参考)。
    //   - skip_external_ip_validation: 起動時の self-ping による external_ip 検証をスキップ。
    //     Fargate + NLB は NAT 越しで loopback できない (NLB は同 Task からの戻り通信を許さない) ため、
    //     STUN 検証がタイムアウトして `--node-ip` のフォールバックも遅延 → ICE 失敗の遠因になりうる。
    //     v1.13 で公式 config-sample に「NAT 環境で必要」と明記された設定。
    //   - ips.excludes: Fargate awsvpc コンテナには eth0 (Task Metadata 用 veth, 169.254.0.0/16) と
    //     eth1 (Task ENI, VPC Private IP) の 2 NIC が見える。Pion (LiveKit 内 ICE) は全 NIC の全 IP を
    //     host candidate として列挙するため、169.254 系がブラウザ側に流れ ICE 候補を汚染する。
    //     ECS Task Metadata Endpoint v4 は 169.254.170.2 で固定なので、リンクローカル全体を除外する。
    "  skip_external_ip_validation: true",
    "  ips:",
    "    excludes:",
    "      - 169.254.0.0/16",
    // R12-followup-9: VPC Private IP もブラウザからは到達不可なので除外する。
    // SharedMediaVpc の CIDR (例: 10.0.0.0/16) を CDK で `vpc.vpcCidrBlock` から動的に渡す。
    // vpcCidr 未指定 (テスト等) のときは link-local だけ除外し、当該行はスキップする。
    ...(vpcCidr ? [`      - ${vpcCidr}`] : []),
    // R12-followup-14 / ADR 0011 案 C: LiveKit 内蔵 TURN を廃止し coturn sidecar に切替。
    // 内蔵 TURN は v1.13.1 で iceServers の username/credential が wire 上に乗らない問題があり、
    // クライアントが TURN authentication できずメディア未確立 (R12-followup-10〜13 で確認)。
    // 代わりに coturn を SFU TaskDef に sidecar 同居させ、 LiveKit は `rtc.turn_servers` で
    // 静的 username/credential を JoinResponse に含めて配信する (proto3 空文字 omit 問題回避)。
    // 内蔵 TURN は `enabled: false` で完全停止 (port 3478 を coturn に明け渡す)。
    // host と credential は entryPoint の sed で `__NODE_IP__` / `__TURN_CREDENTIAL__` を置換。
    "  turn_servers:",
    "    - host: __NODE_IP__",
    `      port: ${LIVEKIT_PORTS.turnUdp}`,
    "      protocol: udp",
    "      username: stagecast",
    "      credential: __TURN_CREDENTIAL__",
    "turn:",
    "  enabled: false",
    "redis:",
    // ADR 0010 D-6: Valkey は cluster-mode-disabled の単一ノードに切替えた。
    // 単一クライアントモード (redis.NewClient) で接続するため `address` を使う。
    // psrpc の SUBSCRIBE/PUBLISH は標準 Redis pub/sub で動作する。
    `  address: ${valkeyEndpoint}:6379`,
    // ElastiCache transit encryption を有効化しているので TLS で接続する。
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
    // ADR 0010 D-6: SFU と同じく単一ノードに合わせて address を使う。
    `  address: ${valkeyEndpoint}:6379`,
    "  use_tls: true",
    `ws_url: ws://localhost:${LIVEKIT_PORTS.signaling}`,
    // R12: Fargate の 2 vCPU で RoomComposite Egress を許可する (デフォルト 4 を 1 に緩和)。
    // LiveKit 公式推奨は 4 vCPU だが、検証/小規模配信向けに緩める。
    // 品質劣化や Chrome がフリーズする可能性があるため、本番では cpu/memory を増やす方が安全。
    "cpu_cost:",
    "  room_composite_cpu_cost: 1",
    "  audio_room_composite_cpu_cost: 1",
    "  web_cpu_cost: 1",
    "logging:",
    "  level: info",
    "  json: true",
  ].join("\n");
}
