import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { EventMediaStack, eventMediaStackName } from "../lib/event-media-stack";

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

describe("EventMediaStack (DESIGN.md 7.1/7.3, N-5)", () => {
  const template = synth();

  it("uses a stack name scoped to the event id", () => {
    expect(eventMediaStackName("evt-a")).toBe("StagecastEventMedia-evt-a");
  });

  it("provisions ElastiCache for Valkey Serverless (DESIGN.md 3.2, ADR D-7)", () => {
    template.resourceCountIs("AWS::ElastiCache::ServerlessCache", 1);
    template.hasResourceProperties("AWS::ElastiCache::ServerlessCache", { Engine: "valkey" });
  });

  it("runs SFU/Egress/caption-worker as Fargate services (ADR D-6)", () => {
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

  it("CloudWatch アラーム/メトリクスフィルタ/ダッシュボードを定義する (T9, ADR 0003)", () => {
    // タスク異常 3 + 字幕遅延 1 + RTMP 切断 1 = 5 アラーム
    template.resourceCountIs("AWS::CloudWatch::Alarm", 5);
    template.resourceCountIs("AWS::Logs::MetricFilter", 1);
    template.resourceCountIs("AWS::CloudWatch::Dashboard", 1);
    template.resourceCountIs("AWS::SNS::Topic", 1);
    // 字幕遅延の閾値は 3 秒 (N-2 目標)
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      Threshold: 3000,
      Namespace: "Stagecast/CaptionPipeline",
      MetricName: "CaptionLatencyMs",
    });
  });
});
