import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { liveKitEgressConfig } from "../lib/event-media-stack";
import {
  EventMediaStack,
  ecrRepositoryArnFromUri,
  eventMediaStackName,
  isEcrImage,
  liveKitServerConfig,
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

/** ADR 0016 D-6: caddySidecarImage を渡したときの synth (Caddy ACME サイドカーあり)。 */
function synthWithTls(): Template {
  const app = new App();
  const stack = new EventMediaStack(app, eventMediaStackName("evt-tls"), {
    env: { account: "111111111111", region: "ap-northeast-1" },
    eventId: "evt-tls",
    captionEngine: "transcribe",
    customCaptionApi: false,
    caddySidecarImage:
      "111111111111.dkr.ecr.ap-northeast-1.amazonaws.com/stagecast/caddy-sidecar:latest",
    mediaDomainName: "media.aws.example.com",
    mediaHostedZoneId: "Z1234567890",
    certBucketName: "stagecast-assets-123",
  });
  return Template.fromStack(stack);
}

describe("EventMediaStack (DESIGN.md 7.1/7.3, N-5)", () => {
  const template = synth();

  it("uses a stack name scoped to the event id", () => {
    expect(eventMediaStackName("evt-a")).toBe("StagecastEventMedia-evt-a");
  });

  it("ADR 0015: Valkey を Fargate コンテナで起動する (ElastiCache 廃止)", () => {
    template.resourceCountIs("AWS::ElastiCache::ReplicationGroup", 0);
    // Valkey + SFU + CaptionWorker = 3 サービス
    template.resourceCountIs("AWS::ECS::Service", 3);
  });

  it("ADR 0015: CloudMap PrivateDnsNamespace でサービスディスカバリする", () => {
    template.resourceCountIs("AWS::ServiceDiscovery::PrivateDnsNamespace", 1);
    template.resourceCountIs("AWS::ServiceDiscovery::Service", 1);
  });

  it("runs SFU(+Egress sidecar)/caption-worker/Valkey as Fargate services", () => {
    template.resourceCountIs("AWS::ECS::Service", 3);
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

  it("ADR 0016 D-6: caddySidecarImage 未指定時は NLB も Caddy も作らない (後方互換)", () => {
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

  it("SFU に LiveKit config.yaml を注入し Valkey (Fargate) を redis アダプタにする (R1, ADR 0015)", () => {
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const withConfig = Object.values(taskDefs).filter((d) =>
      JSON.stringify(d).includes('"Name":"LIVEKIT_CONFIG"'),
    );
    expect(withConfig.length).toBe(1);
    const json = JSON.stringify(withConfig[0]);
    // ADR 0015: VPC 内部通信のため TLS 不要。
    expect(json).toContain("use_tls: false");
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
  it("ADR 0015: Valkey (Fargate) を TLS なし redis アダプタとして参照する", () => {
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    expect(yaml).toContain("address: valkey.stagecast-evt.local:6379");
    // ADR 0015: VPC 内部通信なので TLS 不要。
    expect(yaml).toContain("use_tls: false");
    expect(yaml).toContain("port: 7880");
    expect(yaml).toContain("udp_port: 7882");
  });

  it("ADR 0009 D-1: dev_mode は無効 (TLS 終端は NLB が担う)", () => {
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    expect(yaml).not.toContain("dev_mode");
  });

  it("R12-followup-5: Fargate で panic するため use_external_ip は無効", () => {
    // Fargate に EC2 instance metadata 無し → rand.Intn(0) で panic するため削除した。
    // ICE candidate の external IP は LiveKit のデフォルト (STUN) で解決される。
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    expect(yaml).not.toContain("use_external_ip: true");
  });

  it("R12-followup-7: port_range は使わず udp_port 単独 (UDP mux mode)", () => {
    // port_range_start/end と udp_port を同時指定すると LiveKit のログは
    // `rtc.portUDP: {Start: 7882, End: 0}` のまま ICE pair が `failed` になった。
    // 公式に推奨される mux mode 単独 (1 ポートで多重化) に統一する。
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    expect(yaml).not.toContain("port_range_start");
    expect(yaml).not.toContain("port_range_end");
  });

  it("R12-followup-8: NLB self-ping できないので external_ip validation をスキップ", () => {
    // Fargate + NLB は同 Task からの loopback を許さないため、起動時の external_ip 検証が
    // タイムアウトして `--node-ip` のフォールバックも遅延 → ICE 失敗の遠因。
    // v1.13 で公式 config-sample に「NAT 環境で必要」と明記された設定。
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    expect(yaml).toContain("skip_external_ip_validation: true");
  });

  it("R12-followup-8: 169.254/16 (Task Metadata 用 veth) を ICE candidate から除外", () => {
    // Fargate awsvpc コンテナには eth0 (Task Metadata veth, 169.254.x.x) と
    // eth1 (Task ENI, VPC Private IP) の 2 NIC が見える。Pion は全 NIC の全 IP を
    // host candidate にしてしまうので、リンクローカルを除外する。
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    expect(yaml).toContain("ips:");
    expect(yaml).toContain("excludes:");
    expect(yaml).toContain("- 169.254.0.0/16");
  });

  it("R12-followup-22: VPC CIDR は excludes に含めない (NAT1To1 のための host candidate を残す)", () => {
    // R12-followup-9 で「Private IP はブラウザから到達不可」として VPC CIDR を excludes に追加したが、
    // `--node-ip` の NAT1To1 は host candidate の IP を書き換える仕様なので、 host candidate が 0 個だと
    // candidate gather が空になり trickle ICE が機能しない。 VPC Private IP を host candidate に残す。
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    // link-local だけ除外
    expect(yaml).toContain("- 169.254.0.0/16");
    // VPC CIDR は出ない (excludes に追加しない)
    expect(yaml).not.toContain("- 10.0.0.0/16");
  });

  it("R12-followup-19 (ADR 0011 案 E): TURN を KVS WebRTC に外出し → LiveKit 側に turn セクションは無い", () => {
    // R12-followup-10〜18 (内蔵 TURN / coturn sidecar) を撤回。 TURN は AWS KVS WebRTC が提供し、
    // stage-web が rtcConfig.iceServers として直接受け取る (server response を bypass)。
    // → liveKitServerConfig は turn / turn_servers セクションを含まない。
    const yaml = liveKitServerConfig("valkey.stagecast-evt.local");
    expect(yaml).not.toContain("turn:");
    expect(yaml).not.toContain("turn_servers:");
    expect(yaml).not.toContain("__TURN_CREDENTIAL__");
    expect(yaml).not.toContain("__NODE_IP__");
  });
});

describe("EventMediaStack with TLS (Caddy ACME sidecar, ADR 0016 D-6)", () => {
  const template = synthWithTls();

  it("ADR 0016 D-1: NLB は作らない (Caddy サイドカーで TLS 終端)", () => {
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 0);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 0);
    template.resourceCountIs("AWS::ElasticLoadBalancingV2::TargetGroup", 0);
  });

  it("ADR 0016 D-1: SFU TaskDef に Caddy サイドカーが含まれる", () => {
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const withCaddy = Object.values(taskDefs).filter((d) =>
      JSON.stringify(d).includes("CaddyContainer"),
    );
    expect(withCaddy.length).toBe(1);
    const json = JSON.stringify(withCaddy[0]);
    expect(json).toContain("stagecast/caddy-sidecar");
    expect(json).toContain('"Essential":true');
  });

  it("ADR 0016 D-1: Caddy は 443/TCP をポートマッピングする", () => {
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const withCaddy = Object.values(taskDefs).filter((d) =>
      JSON.stringify(d).includes("CaddyContainer"),
    );
    expect(withCaddy.length).toBe(1);
    const json = JSON.stringify(withCaddy[0]);
    expect(json).toContain('"ContainerPort":443');
  });

  it("ADR 0016 D-1: SFU SG が 443/TCP をインターネットへ開く", () => {
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupIngress: Match.arrayWith([
        Match.objectLike({ IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" }),
      ]),
    });
  });

  it("ADR 0016 D-3: LivekitDomainName CfnOutput を持つ (reconcile が Route53 A レコードを管理する)", () => {
    template.hasOutput(
      "LivekitDomainName",
      Match.objectLike({
        Value: "event-evt-tls.media.aws.example.com",
      }),
    );
  });
});

describe("liveKitEgressConfig (R12, ADR 0010 D-7, ADR 0012 D-3)", () => {
  it("R12-followup-23: insecure: true を出力する (Chrome LNA 回避)", () => {
    const yaml = liveKitEgressConfig("valkey.stagecast-evt.local");
    expect(yaml).toContain("insecure: true");
  });

  it("ADR 0015: redis は Fargate Valkey の CloudMap DNS を使う (TLS なし)", () => {
    const yaml = liveKitEgressConfig("valkey.stagecast-evt.local");
    expect(yaml).toContain("address: valkey.stagecast-evt.local:6379");
    expect(yaml).toContain("use_tls: false");
  });

  it("ADR 0012 D-3: composerTemplateUrl 未指定なら template_base 行を出さない (デフォルトテンプレ fallback)", () => {
    const yaml = liveKitEgressConfig("valkey.stagecast-evt.local");
    expect(yaml).not.toContain("template_base");
  });

  it("ADR 0012 D-3: composerTemplateUrl 指定時は template_base 行を出力する", () => {
    const yaml = liveKitEgressConfig(
      "valkey.stagecast-evt.local",
      "https://d123abc.cloudfront.net",
    );
    expect(yaml).toContain("template_base: https://d123abc.cloudfront.net");
  });
});
