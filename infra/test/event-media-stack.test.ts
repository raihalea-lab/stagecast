import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  EventMediaStack,
  ecrRepositoryArnFromUri,
  eventMediaStackName,
  isEcrImage,
  liveKitServerConfig,
  serverlessCacheName,
} from "../lib/event-media-stack";

function synth(customApi = false): Template {
  const app = new App();
  const stack = new EventMediaStack(app, eventMediaStackName("evt-a"), {
    env: { account: "111111111111", region: "ap-northeast-1" },
    eventId: "evt-a",
    captionEngine: "transcribe",
    customCaptionApi: customApi,
  });
  return Template.fromStack(stack);
}

/** ADR 0009 D-1: TLS Props を渡したときの synth (NLB + Route53 ARecord あり)。 */
function synthWithTls(): Template {
  const app = new App();
  const stack = new EventMediaStack(app, eventMediaStackName("evt-tls"), {
    env: { account: "111111111111", region: "ap-northeast-1" },
    eventId: "evt-tls",
    captionEngine: "transcribe",
    customCaptionApi: false,
    tlsCertificateArn: "arn:aws:acm:ap-northeast-1:111111111111:certificate/test-cert",
    hostedZoneId: "Z0000TESTZONE",
    hostedZoneName: "aws.example.com",
    mediaDomainName: "media.aws.example.com",
  });
  return Template.fromStack(stack);
}

describe("EventMediaStack (DESIGN.md 7.1/7.3, N-5)", () => {
  const template = synth();

  it("uses a stack name scoped to the event id", () => {
    expect(eventMediaStackName("evt-a")).toBe("StagecastEventMedia-evt-a");
  });

  it("provisions ElastiCache for Valkey Serverless (DESIGN.md 3.2, ADR D-7)", () => {
    // ADR 0010 D-6: Valkey は ServerlessCache から ReplicationGroup (cluster mode disabled) に切替。
    template.resourceCountIs("AWS::ElastiCache::ReplicationGroup", 1);
    template.hasResourceProperties("AWS::ElastiCache::ReplicationGroup", { Engine: "valkey" });
  });

  it("runs SFU(+Egress sidecar)/caption-worker as Fargate services (ADR 0010 D-1)", () => {
    // ADR 0010 で Egress は SFU の sidecar として同一 Task に同居するため、独立 Service は 2 つ。
    template.resourceCountIs("AWS::ECS::Service", 2);
    template.resourceCountIs("AWS::ECS::Cluster", 1);
  });

  it("grants the caption worker Transcribe/Translate/Bedrock access (6.2)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          {
            Action: [
              "transcribe:StartStreamTranscriptionWebSocket",
              "transcribe:StartStreamTranscription",
              "translate:TranslateText",
              "bedrock:InvokeModel",
              "bedrock:InvokeModelWithResponseStream",
            ],
            Effect: "Allow",
            Resource: "*",
          },
        ],
        Version: "2012-10-17",
      },
    });
  });

  it("is ephemeral: has its own VPC so the whole stack can be destroyed (7.1)", () => {
    template.resourceCountIs("AWS::EC2::VPC", 1);
  });

  it("exposes the custom caption API port only when enabled (6.3.2)", () => {
    const withApi = synth(true);
    // ポートマッピングを持つコンテナ定義が増える (SFU + caption-worker)
    const defsWith = withApi.findResources("AWS::ECS::TaskDefinition");
    const portMapped = Object.values(defsWith).filter((d) =>
      JSON.stringify(d).includes('"ContainerPort":8080'),
    );
    expect(portMapped.length).toBe(1);
  });

  it("ADR 0009 D-1: TLS Props 未指定時は NLB を作らない (後方互換、Public IP 直接公開にフォールバック)", () => {
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 0);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::TargetGroup", 0);
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
  });

  it("ADR 0008 D-4: SFU ECS service は Public IP 直接公開 + 固定 service 名", () => {
    template.hasResourceProperties("AWS::ECS::Service", {
      ServiceName: "sfu",
      NetworkConfiguration: {
        AwsvpcConfiguration: { AssignPublicIp: "ENABLED" },
      },
    });
  });

  it("SFU タスク SG が WebRTC ポートをインターネットへ開く (UDP 7882 含む, ADR 0006 D-1)", () => {
    // signaling(7880/TCP)・ICE/TCP(7881)・media(7882/UDP) を 0.0.0.0/0 から許可する。
    // CIDR ピアなので SecurityGroup の SecurityGroupIngress に inline 展開される。
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ IpProtocol: "tcp", FromPort: 7880, ToPort: 7880, CidrIp: "0.0.0.0/0" }),
        Match.objectLike({ IpProtocol: "tcp", FromPort: 7881, ToPort: 7881, CidrIp: "0.0.0.0/0" }),
        Match.objectLike({ IpProtocol: "udp", FromPort: 7882, ToPort: 7882, CidrIp: "0.0.0.0/0" }),
      ]),
    });
  });

  it("SFU に LiveKit config.yaml を注入し Valkey を redis アダプタにする (R1, ADR 0006 D-3)", () => {
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const withConfig = Object.values(taskDefs).filter((d) =>
      JSON.stringify(d).includes('"Name":"LIVEKIT_CONFIG"'),
    );
    expect(withConfig.length).toBe(1);
    const json = JSON.stringify(withConfig[0]);
    // redis(=Valkey) を TLS で参照し、port は NLB リスナと一致する。
    expect(json).toContain("use_tls: true");
    expect(json).toContain("port: 7880");
  });

  it("SFU/Egress は LiveKit 資格情報を Secrets Manager から注入する (ADR 0001 D-10)", () => {
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const withSecret = Object.values(taskDefs).filter((d) =>
      JSON.stringify(d).includes("LIVEKIT_API_KEY"),
    );
    // ADR 0010: Egress は SFU と同 TaskDef の sidecar なので、SFU TaskDef 1 つに両方の Secret が出る。
    expect(withSecret.length).toBe(1);
    const json = JSON.stringify(withSecret[0]);
    // SFU container と Egress container の両方で同じ Secret が参照される (LIVEKIT_KEYS など)。
    expect(json).toContain("LIVEKIT_KEYS");
    // Egress sidecar が同 TaskDef に含まれていること: localhost で SFU に繋ぐ設定を確認。
    expect(json).toContain("ws://localhost:7880");
  });

  it("Egress タスクロールは録画プレフィックスのみに S3 PUT を絞る (R2, ADR 0006 D-4)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:PutObject"]),
            Effect: "Allow",
            Resource: "arn:aws:s3:::stagecast-recordings/recordings/*",
          }),
        ]),
      },
    });
  });

  it("recordingsBucketName を渡すと Egress の録画出力先がそのバケットになる (ADR 0006 D-4)", () => {
    const app = new App();
    const stack = new EventMediaStack(app, eventMediaStackName("evt-b"), {
      env: { account: "111111111111", region: "ap-northeast-1" },
      eventId: "evt-b",
      captionEngine: "transcribe",
      customCaptionApi: false,
      recordingsBucketName: "stagecast-assets-123",
    });
    Template.fromStack(stack).hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["s3:PutObject"]),
            Resource: "arn:aws:s3:::stagecast-assets-123/recordings/*",
          }),
        ]),
      },
    });
  });

  it("CloudWatch アラーム/メトリクスフィルタ/ダッシュボードを定義する (T9, ADR 0003)", () => {
    // タスク異常 2 (SFU+CaptionWorker, Egress は ADR 0010 で SFU の sidecar) + 字幕遅延 1 + RTMP 切断 1 + Sink エラー 2 (youtube/custom-api) + 翻訳失敗 1 = 7
    template.resourceCountIs("AWS::CloudWatch::Alarm", 7);
    template.resourceCountIs("AWS::Logs::MetricFilter", 1);
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    // 字幕 Sink 配信失敗アラーム (D8/N3)。
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "SinkDeliveryErrors",
      Namespace: "Stagecast/CaptionPipeline",
    });
    // 字幕遅延の閾値は 3 秒 (N-2 目標)
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Threshold: 3000,
      Namespace: "Stagecast/CaptionPipeline",
      MetricName: "CaptionLatencyMs",
    });
    // 翻訳失敗アラーム (N-2)。SEARCH はアラームでは使えないので固定ディメンションメトリクス。
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Namespace: "Stagecast/CaptionPipeline",
      MetricName: "TranslateErrors",
    });
  });
});

describe("serverlessCacheName (D5: short hash で衝突回避)", () => {
  it("40 文字以内かつ stagecast- 始まりの命名規約に従う", () => {
    const name = serverlessCacheName("evt-a");
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name.startsWith("stagecast-")).toBe(true);
    // 英小文字・数字・ハイフンのみ (ElastiCache 命名制約)。
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.endsWith("-")).toBe(false);
  });

  it("極端に長い eventId でも 40 文字に収まる", () => {
    const name = serverlessCacheName("e".repeat(200));
    expect(name.length).toBeLessThanOrEqual(40);
  });

  it("先頭が同じで 40 文字クリップ後に衝突しうる eventId を区別する", () => {
    const a = serverlessCacheName(`${"long-event-prefix-".repeat(3)}-a`);
    const b = serverlessCacheName(`${"long-event-prefix-".repeat(3)}-b`);
    // 素朴な slice(0,40) では同一になるが、short hash により区別される。
    expect(a).not.toBe(b);
  });

  it("同じ eventId には決定的に同じ名前を返す", () => {
    expect(serverlessCacheName("evt-a")).toBe(serverlessCacheName("evt-a"));
  });
});

describe("ECR イメージ判定/ARN 導出 (R4)", () => {
  const uri = "111111111111.dkr.ecr.ap-northeast-1.amazonaws.com/stagecast/caption-worker:latest";

  it("ECR URI を判定する", () => {
    expect(isEcrImage(uri)).toBe(true);
    expect(isEcrImage("public.ecr.aws/docker/library/node:24-alpine")).toBe(false);
    expect(isEcrImage("livekit/livekit-server:latest")).toBe(false);
  });

  it("URI からリポジトリ ARN を導出する (タグは除去)", () => {
    expect(ecrRepositoryArnFromUri(uri, "aws")).toBe(
      "arn:aws:ecr:ap-northeast-1:111111111111:repository/stagecast/caption-worker",
    );
  });
});

describe("EventMediaStack ECR pull 権限 (R4)", () => {
  it("caption-worker が ECR イメージのとき実行ロールに pull 権限を付与する", () => {
    const app = new App();
    const uri = "111111111111.dkr.ecr.ap-northeast-1.amazonaws.com/stagecast/caption-worker:latest";
    const stack = new EventMediaStack(app, eventMediaStackName("evt-ecr"), {
      env: { account: "111111111111", region: "ap-northeast-1" },
      eventId: "evt-ecr",
      captionEngine: "transcribe",
      customCaptionApi: false,
      images: { captionWorker: uri },
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "ecr:GetAuthorizationToken", Effect: "Allow" }),
          Match.objectLike({
            Action: Match.arrayWith(["ecr:BatchGetImage"]),
            Effect: "Allow",
          }),
        ]),
      },
    });
  });

  it("既定 (非 ECR) イメージのときは ECR pull 権限を付与しない", () => {
    const t = synth();
    const policies = t.findResources("AWS::IAM::Policy");
    expect(JSON.stringify(policies)).not.toContain("ecr:GetAuthorizationToken");
  });
});

describe("liveKitServerConfig (R1)", () => {
  it("Valkey を TLS つき redis アダプタとして参照する", () => {
    const yaml = liveKitServerConfig("my-valkey.cache.amazonaws.com");
    // ADR 0010 D-6: Valkey は cluster-mode-disabled 単一ノードなので address を使う
    // (livekit/protocol redis/redis.go の redis.NewClient 経路)。
    expect(yaml).toContain("address: my-valkey.cache.amazonaws.com:6379");
    expect(yaml).toContain("use_tls: true");
    // signaling/RTC ポートが NLB リスナと一致する。
    expect(yaml).toContain("port: 7880");
    expect(yaml).toContain("udp_port: 7882");
  });

  it("ADR 0009 D-1: dev_mode は無効 (TLS 終端は NLB が担う)", () => {
    const yaml = liveKitServerConfig("my-valkey.cache.amazonaws.com");
    expect(yaml).not.toContain("dev_mode");
  });

  it("R12-followup-5: Fargate で panic するため use_external_ip は無効", () => {
    // Fargate に EC2 instance metadata 無し → rand.Intn(0) で panic するため削除した。
    // ICE candidate の external IP は LiveKit のデフォルト (STUN) で解決される。
    const yaml = liveKitServerConfig("my-valkey.cache.amazonaws.com");
    expect(yaml).not.toContain("use_external_ip: true");
  });

  it("R12-followup-7: port_range は使わず udp_port 単独 (UDP mux mode)", () => {
    // port_range_start/end と udp_port を同時指定すると LiveKit のログは
    // `rtc.portUDP: {Start: 7882, End: 0}` のまま ICE pair が `failed` になった。
    // 公式に推奨される mux mode 単独 (1 ポートで多重化) に統一する。
    const yaml = liveKitServerConfig("my-valkey.cache.amazonaws.com");
    expect(yaml).not.toContain("port_range_start");
    expect(yaml).not.toContain("port_range_end");
  });

  it("R12-followup-8: NLB self-ping できないので external_ip validation をスキップ", () => {
    // Fargate + NLB は同 Task からの loopback を許さないため、起動時の external_ip 検証が
    // タイムアウトして `--node-ip` のフォールバックも遅延 → ICE 失敗の遠因。
    // v1.13 で公式 config-sample に「NAT 環境で必要」と明記された設定。
    const yaml = liveKitServerConfig("my-valkey.cache.amazonaws.com");
    expect(yaml).toContain("skip_external_ip_validation: true");
  });

  it("R12-followup-8: 169.254/16 (Task Metadata 用 veth) を ICE candidate から除外", () => {
    // Fargate awsvpc コンテナには eth0 (Task Metadata veth, 169.254.x.x) と
    // eth1 (Task ENI, VPC Private IP) の 2 NIC が見える。Pion は全 NIC の全 IP を
    // host candidate にしてしまうので、リンクローカルを除外する。
    const yaml = liveKitServerConfig("my-valkey.cache.amazonaws.com");
    expect(yaml).toContain("ips:");
    expect(yaml).toContain("excludes:");
    expect(yaml).toContain("- 169.254.0.0/16");
  });
});

describe("EventMediaStack with TLS props (ADR 0009)", () => {
  const template = synthWithTls();

  it("ADR 0009 D-1: internet-facing NLB を 1 つ作る", () => {
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Type: "network",
      Scheme: "internet-facing",
    });
  });

  it("ADR 0009 D-1: TLS Listener (port 443) が ACM 証明書を attach する", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Port: 443,
      Protocol: "TLS",
      Certificates: [
        {
          CertificateArn: "arn:aws:acm:ap-northeast-1:111111111111:certificate/test-cert",
        },
      ],
    });
  });

  it("ADR 0009 D-1: TargetGroup は SFU の TCP 7880 を狙う", () => {
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      Port: 7880,
      Protocol: "TCP",
      TargetType: "ip",
    });
  });

  it("ADR 0009 D-4: per-event DNS は event-{eventId.slice(0,8)} prefix で作られる", () => {
    template.hasResourceProperties("AWS::Route53::RecordSet", {
      Type: "A",
      Name: "event-evt-tls.media.aws.example.com.",
    });
  });

  it("ADR 0009 D-1: LivekitDomainName CfnOutput を持つ (reconcile が DescribeStacks で取得する)", () => {
    template.hasOutput(
      "LivekitDomainName",
      Match.objectLike({
        Value: "event-evt-tls.media.aws.example.com",
      }),
    );
  });
});
