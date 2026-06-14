import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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

  it("Cognito Hosted UI ドメインと OAuth クライアントが設定されている (T6, F-12)", () => {
    template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      AllowedOAuthFlows: Match.arrayWith(["code"]),
      AllowedOAuthScopes: Match.arrayWith(["openid", "email", "profile"]),
      AllowedOAuthFlowsUserPoolClient: true,
    });
  });

  it("admin-web / stage-web の CloudFront ディストリビューションがある (T6)", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 2);
  });

  it("制御 API の Lambda + HTTP API がある (T5)", () => {
    // control-api + reconcile lambda の 2 つ。
    template.resourceCountIs("AWS::Lambda::Function", 2);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  });

  it("EventBridge スケジュール + reconcile Lambda が 60s 毎に起動する (T4, ADR 0003 D-2)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
    });
    template.resourceCountIs("AWS::Events::Rule", 1);
  });

  it("API Gateway に Cognito JWT オーソライザが定義されている (T5, F-12)", () => {
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
    template.hasResourceProperties("AWS::ApiGatewayV2::Authorizer", {
      AuthorizerType: "JWT",
      IdentitySource: ["$request.header.Authorization"],
    });
    // $default ルートには JWT、公開ルートは NONE。
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "$default",
      AuthorizationType: "JWT",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /invites/verify",
      AuthorizationType: "NONE",
    });
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /join",
      AuthorizationType: "NONE",
    });
  });

  it("Secrets Manager に invite-token / livekit / youtube の 3 シークレット (T7, ADR D-10)", () => {
    template.resourceCountIs("AWS::SecretsManager::Secret", 3);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "stagecast/invite-token-secret",
    });
    template.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "stagecast/livekit" });
    template.hasResourceProperties("AWS::SecretsManager::Secret", { Name: "stagecast/youtube" });
  });

  it("招待トークン秘密は CDK 生成で平文を持たない (T7, ADR D-10)", () => {
    // generateSecretString を使う = SecretString プロパティに平文が無い。
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "stagecast/invite-token-secret",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "secret",
        PasswordLength: 64,
      }),
    });
  });

  it("LiveKit / YouTube の初期値は空 (運用者が後から値を入れる)", () => {
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "stagecast/livekit",
      SecretString: JSON.stringify({ url: "", apiKey: "", apiSecret: "" }),
    });
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "stagecast/youtube",
      SecretString: JSON.stringify({ apiKey: "", oauthClientId: "", oauthClientSecret: "" }),
    });
  });

  it("成果物 S3 と SPA バケットはパブリックアクセス全ブロック (N-4)", () => {
    const buckets = template.findResources("AWS::S3::Bucket");
    const bucketList = Object.values(buckets);
    expect(bucketList.length).toBeGreaterThanOrEqual(3);
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
