import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ControlPlaneStack } from "../lib/control-plane-stack";

function synth(): Template {
  const app = new App();
  const stack = new ControlPlaneStack(app, "TestControlPlane", {
    env: { account: "111111111111", region: "ap-northeast-1" },
  });
  return Template.fromStack(stack);
}

describe("ControlPlaneStack", () => {
  const template = synth();

  it("DynamoDB はオンデマンド課金 (非配信時の固定費ゼロ, N-1)", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("管理者用 Cognito ユーザープールがあり自己サインアップ不可 (F-12)", () => {
    template.resourceCountIs("AWS::Cognito::UserPool", 1);
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });

  it("管理 SPA 配信用の CloudFront がある (DESIGN.md 3.1)", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
  });

  it("制御 API の Lambda + HTTP API がある (ADR D-5)", () => {
    template.resourceCountIs("AWS::Lambda::Function", 1);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  });

  it("成果物 S3 と 管理Web S3 はパブリックアクセス全ブロック (N-4)", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    const bucketList = Object.values(buckets);
    expect(bucketList.length).toBeGreaterThanOrEqual(2);
    for (const b of bucketList) {
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it("常時稼働スタックにメディア層リソース (ECS/ElastiCache) を含めない (N-1, 7.2)", () => {
    template.resourceCountIs("AWS::ECS::Service", 0);
    template.resourceCountIs("AWS::ECS::Cluster", 0);
    template.resourceCountIs("AWS::ElastiCache::ServerlessCache", 0);
  });
});
