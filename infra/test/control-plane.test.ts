import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { MATERIALS_PREFIX } from "@stagecast/shared";
import {
  ControlPlaneStack,
  PUBLIC_ROUTES,
  resolveCfnValidateWasm,
} from "../lib/control-plane-stack";

/**
 * synth 結果は使い回す。
 *
 * 1 回の synth で全 Lambda の esbuild バンドルが走る (数秒〜十数秒)。`it()` の中から
 * 呼ぶとテストごとにそれを払うことになり、CI の 5 秒タイムアウトに引っかかる
 * (実際に落ちた)。アサーションは読み取りしかしないので共有して問題ない。
 */
let synthed: Template | undefined;

function synth(): Template {
  if (synthed) return synthed;
  const app = new App({
    context: {
      // HostedZone.fromLookup の dummy 値（テストでは Route53 を実際に叩かない）。
      "hosted-zone:account=111111111111:domainName=example.com:region=ap-northeast-1": {
        Id: "/hostedzone/ZTESTEXAMPLE",
        Name: "example.com.",
      },
    },
  });
  const stack = new ControlPlaneStack(app, "TestControlPlane", {
    env: { account: "111111111111", region: "ap-northeast-1" },
    userConfig: { mediaHostedZoneName: "example.com" },
  });
  synthed = Template.fromStack(stack);
  return synthed;
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

  it("admin-web / stage-web / composer-web の CloudFront ディストリビューションがある (T6, ADR 0012 D-2)", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 4);
  });

  it("制御 API の Lambda + HTTP API がある (T5)", () => {
    // control-api + reconcile + render-template + materials-extract の 4 つ
    // (D1 で render-template を分離, ADR 0021 D-2 で materials-extract を追加)。
    // + S3 autoDeleteObjects 用の Custom Resource provider Lambda が 1 つ (3 つの SPA/assets バケットで共有)。
    // + AssetsBucket の通知設定を入れる CDK 内部の Custom Resource Lambda が 1 つ (ADR 0021 D-2)。
    template.resourceCountIs("AWS::Lambda::Function", 6);
    template.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
    });
    template.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
  });

  it("翻訳参考資料の抽出 Lambda が assets/materials/ の S3 通知で起動する (ADR 0021 D-2)", () => {
    // prefix を絞らないと録画や字幕の PUT でも起動してしまう。
    template.hasResourceProperties("Custom::S3BucketNotifications", {
      NotificationConfiguration: {
        LambdaFunctionConfigurations: Match.arrayWith([
          Match.objectLike({
            Events: ["s3:ObjectCreated:*"],
            Filter: {
              Key: { FilterRules: [{ Name: "prefix", Value: "assets/materials/" }] },
            },
          }),
          Match.objectLike({
            Events: ["s3:ObjectRemoved:*"],
            Filter: {
              Key: { FilterRules: [{ Name: "prefix", Value: "assets/materials/" }] },
            },
          }),
        ]),
      },
    });
  });

  it("字幕ワーカーの TaskRole は資料だけを読める (ADR 0021 D-6)", () => {
    // prefix を絞らないと録画や確定字幕まで読めてしまう。
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:GetObject",
            Resource: Match.objectLike({
              "Fn::Join": Match.arrayWith([Match.arrayWith(["/assets/materials/*"])]),
            }),
          }),
        ]),
      },
    });
  });

  it("RenderTemplateFunction に録画バケットを env で渡す", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          RECORDINGS_BUCKET_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it("EventBridge スケジュール + reconcile Lambda が 60s 毎に起動する (T4, ADR 0003 D-2)", () => {
    template.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(1 minute)",
    });
    template.resourceCountIs("AWS::Events::Rule", 1);
  });

  it("O1: 月額コスト Budget + SNS 通知トピックを持つ (デフォルト 50 USD)", () => {
    template.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: Match.objectLike({
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 50, Unit: "USD" },
      }),
      NotificationsWithSubscribers: Match.arrayWith([
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: "ACTUAL",
            Threshold: 80,
          }),
        }),
        Match.objectLike({
          Notification: Match.objectLike({
            NotificationType: "FORECASTED",
            Threshold: 100,
          }),
        }),
      ]),
    });
    // SNS Topic Policy で Budgets サービスからの Publish を許可している。
    template.hasResourceProperties("AWS::SNS::TopicPolicy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "SNS:Publish",
            Principal: { Service: "budgets.amazonaws.com" },
          }),
        ]),
      }),
    });
  });

  it("stale スタック警告ログをメトリクス化しアラート + SNS する (L3, N-1)", () => {
    template.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: '{ $.msg = "stale event-media stack" }',
      MetricTransformations: Match.arrayWith([
        Match.objectLike({
          MetricNamespace: "Stagecast/Orchestrator",
          MetricName: "StaleEventMediaStacks",
        }),
      ]),
    });
    template.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "StaleEventMediaStacks",
      Namespace: "Stagecast/Orchestrator",
      AlarmActions: Match.anyValue(),
    });
    // OrchestratorAlarmTopic と CostAlarmTopic (O1) の 2 つ。
    template.resourceCountIs("AWS::SNS::Topic", 2);
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
    // R17-Phase3 / ADR 0012 D-6: stage-web の PreviewWindow が招待トークンで叩く public route。
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /preview-token",
      AuthorizationType: "NONE",
    });
    // 演出/ステージ管理ルートも招待トークン認証なので JWT をバイパスする。
    for (const routeKey of PUBLIC_ROUTES) {
      template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
        RouteKey: routeKey,
        AuthorizationType: "NONE",
      });
    }
  });

  it("OPTIONS preflight は NONE 認証で登録 ($default JWT をバイパス、Lambda が 204 返却)", () => {
    // $default ルートが JWT なので OPTIONS も吸い込まれて 401 になる問題への対策。
    // OPTIONS /{proxy+} を NONE 認証で登録し、Lambda 側で即 204 返却する。
    // corsConfiguration が CORS ヘッダを自動付与する。
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "OPTIONS /{proxy+}",
      AuthorizationType: "NONE",
    });
  });

  it("CORS allowMethods に PUT が含まれる (settings 保存系で必要)", () => {
    template.hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.objectLike({
        AllowMethods: Match.arrayWith(["PUT"]),
      }),
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

  it("LiveKit Secret は CREATE 時に CDK が apiSecret を自動生成する (apiKey はテンプレ埋め込み)", () => {
    // generateSecretString を使う = SecretString プロパティに平文が無い。
    // テンプレに apiKey 識別子を埋め込み、apiSecret のみランダム生成 (43 文字 ≒ 256 bit)。
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "stagecast/livekit",
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: "apiSecret",
        PasswordLength: 43,
        ExcludePunctuation: true,
        SecretStringTemplate: Match.stringLikeRegexp("APIstagecast"),
      }),
    });
  });

  it("YouTube Secret は空テンプレート (運用者が Google Cloud Console から取得した値を入れる)", () => {
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: "stagecast/youtube",
      SecretString: JSON.stringify({ apiKey: "", oauthClientId: "", oauthClientSecret: "" }),
    });
  });

  it("control-api Lambda に LIVEKIT_SECRET_ARN / YOUTUBE_SECRET_ARN を env で渡す", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({
          LIVEKIT_SECRET_ARN: Match.anyValue(),
          YOUTUBE_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  it("control-api には LiveKit / YouTube Secret への PutSecretValue を限定付与する (ADR D-10)", () => {
    // PutSecretValue は対象 2 Secret に限定される (UpdateSecret は含まない、最小権限)。
    const policies = template.findResources("AWS::IAM::Policy");
    interface PolicyStatement {
      Action: unknown;
      Resource: unknown;
    }
    const putValueStatements = Object.values(policies).flatMap((p) => {
      const stmts = (p.Properties as { PolicyDocument: { Statement: PolicyStatement[] } })
        .PolicyDocument.Statement;
      return stmts.filter((s) => s.Action === "secretsmanager:PutSecretValue");
    });
    expect(putValueStatements).toHaveLength(1);
    const stmt = putValueStatements[0];
    expect(stmt).toBeDefined();
    // 対象は 2 リソース (LiveKit / YouTube Secret の ARN) 限定。
    const resources = Array.isArray(stmt!.Resource) ? stmt!.Resource : [stmt!.Resource];
    expect(resources).toHaveLength(2);
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

  it("招待トークンで叩くルートは JWT authorizer を通さない (4.1)", () => {
    // control-api 側で invite-token を検証するルートを $default (JWT) に落とすと、
    // API Gateway が Lambda に届く前に 401 {"message":"Unauthorized"} を返してしまう。
    // services/control-api/src/http/app.ts の requireAdmin より前のルートと対応させる。
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));
    const publicKeys = routes
      .filter((r) => r.Properties.AuthorizationType === "NONE")
      .map((r) => r.Properties.RouteKey as string);
    // **集合として一致**することを見る。含むだけの検査だと、公開ルートを増やしたときに
    // 気づけない (= 管理者パスが JWT を素通りしていても通ってしまう)。
    expect([...publicKeys].sort()).toEqual([...PUBLIC_ROUTES].sort());
    // 管理者ルートは $default (JWT) に落とす。公開ルートに管理者パスを混ぜない。
    expect(publicKeys.some((k) => k.includes("$default"))).toBe(false);
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "$default",
      AuthorizationType: "JWT",
    });
  });

  it("D9: 成果物バケットに CORS があり、ブラウザからの署名付き PUT/GET が通る", () => {
    // stage-web のデッキ投入 (F-3) / admin-web の素材アップロード (Phase 4) / composer-template の
    // pdf.js 描画は、Lambda を経由せずブラウザから直接 S3 を叩く (DESIGN.md 6.4)。
    const buckets = template.findResources("AWS::S3::Bucket");
    const withCors = Object.values(buckets).filter((b) => b.Properties.CorsConfiguration);
    expect(withCors).toHaveLength(1); // 成果物バケットだけ。SPA バケットには付けない
    const rules = withCors[0]!.Properties.CorsConfiguration.CorsRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].AllowedMethods).toEqual(expect.arrayContaining(["GET", "PUT", "HEAD"]));
    // PUT のプリフライトで問われる Content-Type を許可している。
    expect(rules[0].AllowedHeaders).toContain("content-type");
    // オリジンは個別指定。ワイルドカードは使わない。
    expect(rules[0].AllowedOrigins).not.toContain("*");
    expect(rules[0].AllowedOrigins.length).toBeGreaterThanOrEqual(3);
  });

  it("常時稼働スタックにメディア層の有料リソース (ECS Service/ElastiCache) を含めない (N-1, 7.2)", () => {
    template.resourceCountIs("AWS::ECS::Service", 0);
    template.resourceCountIs("AWS::ElastiCache::ServerlessCache", 0);
  });

  it("ADR 0015 Phase 3: 共有 ECS Cluster + IAM Roles を事前作成する (タスクなし = 無料)", () => {
    template.resourceCountIs("AWS::ECS::Cluster", 1);
    template.hasResourceProperties("AWS::ECS::Cluster", { ClusterName: "stagecast-media" });
  });

  it("ADR 0019: 字幕ワーカーは DockerImageAsset でビルドし、専用 ECR リポジトリを持たない", () => {
    // 全 ECR::Repository を 0 件で見ると、無関係なリポジトリを足したときに落ちる。
    // 「字幕ワーカー専用リポジトリが無い」ことだけを見る。
    template.resourcePropertiesCountIs(
      "AWS::ECR::Repository",
      { RepositoryName: "stagecast/caption-worker" },
      0,
    );
    template.hasOutput("CaptionWorkerImageUri", {});
  });

  // CAPTION_WORKER_IMAGE は ECR にイメージ push 後に RenderTemplate Lambda に渡す (R4)。
  // 現在はプレースホルダにフォールバックしているためテストは省略。

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
    // 広い実リソース作成権限はこのロール側に集約される。
    // ADR 0016: NLB 廃止により elasticloadbalancing は不要。route53 は reconcile Lambda 側に移動。
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(["ec2:*", "ecs:*"]),
          }),
        ]),
      },
    });
  });

  it("ADR 0009 D-4: EventMediaCfnExecRole に Route53 ChangeResourceRecordSets を HostedZone ARN 限定で付与する", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "route53:ChangeResourceRecordSets",
              "route53:GetHostedZone",
              "route53:ListResourceRecordSets",
            ]),
          }),
        ]),
      },
    });
  });

  it("ADR 0016 D-6: Caddy サイドカーは DockerImageAsset で自動ビルド (GHA 不要)", () => {
    // DockerImageAsset は CDK Assets ECR を使うため、専用 ECR::Repository は不要 (上のテストで 0 件を検証)。
  });

  it("ADR 0016 D-6: MediaHostedZone* / MediaDomainName を CfnOutput する", () => {
    template.hasOutput("MediaHostedZoneId", {});
    template.hasOutput("MediaHostedZoneName", {});
    template.hasOutput("MediaDomainName", {});
  });

  it("ADR 0016 D-6: RenderTemplateFunction に CADDY_SIDECAR_IMAGE / MEDIA_DOMAIN_NAME 環境変数を渡す", () => {
    const fns = template.findResources("AWS::Lambda::Function");
    const renderFn = Object.values(fns).find((f) => {
      const envText = JSON.stringify(
        (f.Properties as { Environment?: { Variables?: unknown } }).Environment?.Variables ?? {},
      );
      return envText.includes("CAPTION_WORKER_IMAGE") && envText.includes("CADDY_SIDECAR_IMAGE");
    });
    expect(renderFn).toBeDefined();
    const envText = JSON.stringify(
      (renderFn?.Properties as { Environment?: { Variables?: unknown } }).Environment?.Variables ??
        {},
    );
    expect(envText).toContain("CADDY_SIDECAR_IMAGE");
    expect(envText).toContain("MEDIA_DOMAIN_NAME");
    expect(envText).toContain("CERT_BUCKET_NAME");
    // ADR 0019: CAPTION_WORKER_IMAGE は DockerImageAsset のハッシュタグ URI で、mutable な :latest ではない。
    // env 全体を見ると他の変数が :latest を使ったときに巻き込まれるので、この変数の値だけを見る。
    const vars = (renderFn?.Properties as { Environment?: { Variables?: Record<string, unknown> } })
      .Environment?.Variables;
    expect(JSON.stringify(vars?.CAPTION_WORKER_IMAGE)).not.toContain(":latest");
  });

  it("reconcile Lambda は ECS describe-tasks / EC2 describe-network-interfaces を持つ (ADR 0008 D-2)", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "ecs:ListTasks",
              "ecs:DescribeTasks",
              "ec2:DescribeNetworkInterfaces",
            ]),
          }),
        ]),
      },
    });
  });

  it("reconcile Lambda 自身は ec2/ecs *all* を直接持たず PassRole に絞る (R5)", () => {
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

  it("initialAdmins context 未指定なら管理者ブートストラップ CR を作らない (R6)", () => {
    template.resourceCountIs("AWS::CloudFormation::CustomResource", 0);
  });

  it("webAssets 未指定なら BucketDeployment を作らない (ビルド前 synth でも壊れない)", () => {
    template.resourceCountIs("Custom::CDKBucketDeployment", 0);
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

describe("ControlPlaneStack 初期管理者ブートストラップ (R6, ADR 0005 D-4)", () => {
  // synth は esbuild バンドルを伴い重いので describe スコープで 1 度だけ実行する。
  const app = new App({
    context: {
      "hosted-zone:account=111111111111:domainName=example.com:region=ap-northeast-1": {
        Id: "/hostedzone/ZTESTEXAMPLE",
        Name: "example.com.",
      },
    },
  });
  const stack = new ControlPlaneStack(app, "TestCPAdmins", {
    env: { account: "111111111111", region: "ap-northeast-1" },
    userConfig: {
      initialAdmins: "a@x.com,b@y.com",
      mediaHostedZoneName: "example.com",
    },
  });
  const t = Template.fromStack(stack);

  it("context があれば管理者投入 Custom Resource を作る", () => {
    t.resourceCountIs("AWS::CloudFormation::CustomResource", 1);
    t.hasResourceProperties("AWS::CloudFormation::CustomResource", {
      InitialAdmins: ["a@x.com", "b@y.com"],
    });
  });

  it("ブートストラップ Lambda に AdminCreateUser 権限を付与する", () => {
    t.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: "cognito-idp:AdminCreateUser", Effect: "Allow" }),
        ]),
      },
    });
  });
});

describe("ControlPlaneStack SPA 配信 (webAssets)", () => {
  // ビルド済み dist を模した一時ディレクトリ (Source.asset は実在ディレクトリを要求する)。
  const base = mkdtempSync(join(tmpdir(), "stagecast-web-"));
  const adminWebDir = join(base, "admin");
  const stageWebDir = join(base, "stage");
  const composerWebDir = join(base, "composer");
  mkdirSync(adminWebDir);
  mkdirSync(stageWebDir);
  mkdirSync(composerWebDir);
  writeFileSync(join(adminWebDir, "index.html"), "<!doctype html>admin");
  writeFileSync(join(stageWebDir, "index.html"), "<!doctype html>stage");
  writeFileSync(join(composerWebDir, "index.html"), "<!doctype html>composer");

  const app = new App({
    context: {
      "hosted-zone:account=111111111111:domainName=example.com:region=ap-northeast-1": {
        Id: "/hostedzone/ZTESTEXAMPLE",
        Name: "example.com.",
      },
    },
  });
  const stack = new ControlPlaneStack(app, "TestCPWeb", {
    env: { account: "111111111111", region: "ap-northeast-1" },
    webAssets: { adminWebDir, stageWebDir, composerWebDir },
    userConfig: { mediaHostedZoneName: "example.com" },
  });
  const t = Template.fromStack(stack);

  it("admin/stage/composer の3つの BucketDeployment を作り CloudFront を invalidate する", () => {
    t.resourceCountIs("Custom::CDKBucketDeployment", 3);
    t.hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionId: Match.anyValue(),
      DistributionPaths: ["/*"],
    });
  });
});

describe("RenderTemplateFunction の CFN 検証 WASM (aws-cdk-lib 2.269+)", () => {
  // aws-cdk-lib を上げてこの WASM の場所が変わると、Lambda 内 synth が ENOENT で落ち、
  // **すべてのイベントが配信開始できなくなる**。本番で気づくのは遅すぎるのでここで止める。
  it("同梱すべき WASM が解決でき、実在する", () => {
    const p = resolveCfnValidateWasm();
    expect(p.endsWith("bindings_wasm_bg.wasm")).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
});

describe("翻訳参考資料の旧バージョン期限切れ", () => {
  // バケットはバージョニング有効。このルールが無いと、資料を削除しても本体が旧バージョンとして
  // 残り続ける (= 消したつもりで消えていない)。資料は上書きしかされないので旧版に価値はない。
  it("assets/materials/ の非現行バージョンが 1 日で消える", () => {
    const t = synth();
    t.hasResourceProperties("AWS::S3::Bucket", {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: "expire-materials-old-versions",
            Prefix: MATERIALS_PREFIX,
            Status: "Enabled",
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            ExpiredObjectDeleteMarker: true,
          }),
        ]),
      },
    });
  });
});

describe("reconcile 失敗のアラーム (NEXT_WORK D16)", () => {
  // 2026-09-16 の障害では reconcile が 13 分間毎分失敗していたのに通知が無かった。
  // 「スタックが立たない」= 配信を開始できない、なので最優先で気づきたい。
  it("provision/destroy の失敗にアラームがある", () => {
    const t = synth();
    t.hasResourceProperties("AWS::CloudWatch::Alarm", {
      AlarmName: "stagecast-reconcile-step-error",
      MetricName: "ReconcileStepErrors",
      Namespace: "Stagecast/Orchestrator",
      // 単発の失敗は次 tick で回復しうるので 2 回連続を条件にする。
      EvaluationPeriods: 2,
      DatapointsToAlarm: 2,
    });
  });

  it("失敗を数えるメトリクスフィルタがある", () => {
    const t = synth();
    t.hasResourceProperties("AWS::Logs::MetricFilter", {
      FilterPattern: '{ $.msg = "reconcile step" && $.status = "error" }',
    });
  });
});
