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
    // control-api + reconcile + render-template lambda の 3 つ (D1 で分離)。
    template.resourceCountIs("AWS::Lambda::Function", 3);
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

  it("字幕ワーカー用 ECR リポジトリを持つ (R4, ADR 0005 D-3)", () => {
    template.resourceCountIs("AWS::ECR::Repository", 1);
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "stagecast/caption-worker",
      ImageScanningConfiguration: { ScanOnPush: true },
      // 直近 10 イメージのみ保持。
      LifecyclePolicy: {
        LifecyclePolicyText: Match.stringLikeRegexp('"countNumber":10'),
      },
    });
  });

  it("reconcile Lambda に caption-worker イメージ URI を env で渡す (R4)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          CAPTION_WORKER_IMAGE: Match.anyValue(),
        }),
      },
    });
  });

  it("EventMediaStack 作成用の CFN サービスロールを持つ (R5, ADR 0005 D-5)", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "sts:AssumeRole",
            Principal: { Service: "cloudformation.amazonaws.com" },
          }),
        ]),
      },
    });
    // 広い実リソース作成権限はこのロール側に集約される (elbv2 含む)。
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ec2:*", "ecs:*", "elasticloadbalancing:*"]),
          }),
        ]),
      },
    });
  });

  it("reconcile Lambda 自身は ec2/ecs を直接持たず PassRole に絞る (R5)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    // reconcile Lambda のロールに紐づくポリシーを特定する。
    const reconcilePolicy = Object.values(policies).find((p) => {
      const stmts = JSON.stringify(
        (p.Properties as { PolicyDocument: { Statement: unknown } }).PolicyDocument.Statement,
      );
      return stmts.includes("cloudformation:CreateStack");
    });
    expect(reconcilePolicy).toBeDefined();
    const text = JSON.stringify(reconcilePolicy);
    // 実リソース作成権限 (ec2:* / ecs:*) は reconcile からは消えている。
    expect(text).not.toContain('"ec2:*"');
    expect(text).not.toContain('"ecs:*"');
    // PassRole は持つ (CFN ロールを渡すため)。
    expect(text).toContain("iam:PassRole");
  });

  it("reconcile Lambda に CFN_EXEC_ROLE_ARN を env で渡す (R5)", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ CFN_EXEC_ROLE_ARN: Match.anyValue() }),
      },
    });
  });

  it("テンプレート生成を別 Lambda に分離し reconcile から invoke する (D1)", () => {
    // reconcile は RenderTemplateFunction 名を env で受け取り invoke する。
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ RENDER_TEMPLATE_FUNCTION_NAME: Match.anyValue() }),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "lambda:InvokeFunction", Effect: "Allow" }),
        ]),
      },
    });
  });
});
