import * as path from "node:path";
import {
  Stack,
  type StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  CustomResource,
  SecretValue,
  custom_resources as cr,
  aws_s3 as s3,
  aws_ecr as ecr,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_cognito as cognito,
  aws_lambda as lambda,
  aws_lambda_nodejs as lambdaNodejs,
  aws_apigatewayv2 as apigwv2,
  aws_iam as iam,
  aws_secretsmanager as secretsmanager,
  aws_events as events,
  aws_events_targets as eventsTargets,
  aws_logs as logs,
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as cwActions,
  aws_sns as sns,
  aws_s3_deployment as s3deploy,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

/** 制御層スタックの props。webAssets を渡すと SPA を BucketDeployment で配信する。 */
export interface ControlPlaneStackProps extends StackProps {
  /**
   * ビルド済み SPA の dist ディレクトリ。指定時のみ S3 配信 + config.json 生成 + CloudFront
   * invalidation を行う (bin/app.ts が dist 存在時に渡す)。未指定ならビルド前 synth でも壊れない。
   */
  webAssets?: { adminWebDir: string; stageWebDir: string };
}

/**
 * 制御層スタック (DESIGN.md 3.1 / 9 章, ADR D-4)。
 *
 * 常時稼働するのはこのスタックのリソースのみ。すべて低コスト・リクエスト/従量課金で、
 * 非配信時はほぼ無料になるよう構成する (N-1, DESIGN.md 7.2)。
 *
 * 含むもの:
 *  - S3 + CloudFront : 管理 SPA / 登壇者 SPA の静的ホスティングと CDN 配信
 *  - DynamoDB        : イベント/参加者/招待トークン/発表状態のメタデータ (オンデマンド課金)
 *  - Cognito         : 管理者認証 (Hosted UI / OAuth2 Authorization Code + PKCE)
 *  - API Gateway + Lambda : 制御 API (リクエスト課金)
 *  - S3 (assets)     : QR・スライド・配信録画・確定字幕など成果物
 *  - Secrets Manager : 招待トークン署名鍵 / LiveKit / YouTube (ADR D-10, T7)
 *
 * メディア層・翻訳層 (SFU/Egress/字幕/Valkey) はここには置かない。それらはイベント単位で
 * 動的に起動・破棄するため別スタック (event-media-stack) として扱う (DESIGN.md 7.1, ADR D-6)。
 */
export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: ControlPlaneStackProps) {
    super(scope, id, props);

    // --- DynamoDB: メタデータ (オンデマンド課金で非配信時の固定費ゼロ) ---
    const metadataTable = new dynamodb.Table(this, "MetadataTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // 開発環境では stack 削除でテーブルも消す。本番に移すときは RETAIN に戻すこと。
      removalPolicy: RemovalPolicy.DESTROY,
    });
    metadataTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
    });

    // イベント live 集合の管理用 GSI (T4 reconcile が live イベント一覧を引くために使う)。
    metadataTable.addGlobalSecondaryIndex({
      indexName: "gsi-live",
      partitionKey: { name: "liveStatus", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
    });

    // --- S3: 成果物バケット (素材・録画・確定字幕) (DESIGN.md 3.1, 6.4, N-4) ---
    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      // 開発環境では stack 削除でバケットも消す。autoDeleteObjects で中身を空にしてから削除。
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: "archive-recordings",
          prefix: "recordings/",
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(90) },
          ],
        },
      ],
    });

    // --- ECR: 字幕ワーカーのコンテナイメージ置き場 (R4, ADR 0005 D-3) ---
    // EventMediaStack の caption-worker が pull する。常時稼働ではないが、レジストリ自体は
    // 制御層に常設して GHA build/push の宛先を固定する (イメージ実体はイベント時のみ pull)。
    const captionWorkerRepo = new ecr.Repository(this, "CaptionWorkerRepo", {
      repositoryName: "stagecast/caption-worker",
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE, // `latest` を上書きするため
      // スタック削除時にレジストリも消す。emptyOnDelete でイメージが残っていても削除可能にする。
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      lifecycleRules: [
        // 直近 10 イメージのみ保持してストレージ費を抑える。
        { description: "keep last 10 images", maxImageCount: 10 },
      ],
    });

    // --- S3 + CloudFront: 管理 SPA / 登壇者 SPA の静的ホスティング (DESIGN.md 3.1, T6) ---
    const adminWebBucket = this.buildSpaBucket("AdminWebBucket");
    const adminWebDistribution = this.buildSpaDistribution("AdminWebDistribution", adminWebBucket);
    const stageWebBucket = this.buildSpaBucket("StageWebBucket");
    const stageWebDistribution = this.buildSpaDistribution("StageWebDistribution", stageWebBucket);

    // --- Cognito: 管理者認証 (DESIGN.md 4 表, F-12, T6) ---
    const adminUserPool = new cognito.UserPool(this, "AdminUserPool", {
      selfSignUpEnabled: false, // 管理者は招待制。自己サインアップ不可。
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      // 開発環境では stack 削除で UserPool も消す (initialAdmins は再 deploy で復元される)。
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Hosted UI 用ドメイン (Cognito ドメイン)。
    // domainPrefix はリージョン内で一意に。account を含めて衝突を回避。
    const adminAuthDomain = adminUserPool.addDomain("AdminAuthDomain", {
      cognitoDomain: { domainPrefix: `stagecast-admin-${this.account}` },
    });

    const adminCallbackUrls = [
      `https://${adminWebDistribution.domainName}/auth/callback`,
      "http://localhost:5173/auth/callback",
    ];
    const adminLogoutUrls = [
      `https://${adminWebDistribution.domainName}/`,
      "http://localhost:5173/",
    ];
    const adminUserPoolClient = adminUserPool.addClient("AdminUserPoolClient", {
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: adminCallbackUrls,
        logoutUrls: adminLogoutUrls,
      },
      // PKCE 必須 (公開クライアントなので client secret を持たない)。
      generateSecret: false,
      preventUserExistenceErrors: true,
    });

    // --- 初期管理者の自動投入 Custom Resource (R6, ADR 0005 D-4 案 A) ---
    // `-c initialAdmins=a@x.com,b@y.com` を渡したときだけ作成する。未指定なら従来どおり
    // 手動 admin-create-user (O4) を使う。冪等なのでスタック更新で再実行されても安全。
    const initialAdmins = (this.node.tryGetContext("initialAdmins") as string | undefined)
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (initialAdmins && initialAdmins.length > 0) {
      const adminBootstrapFn = new lambdaNodejs.NodejsFunction(this, "AdminBootstrapFunction", {
        entry: path.join(
          __dirname,
          "..",
          "..",
          "services",
          "control-api",
          "src",
          "admin-bootstrap-handler.ts",
        ),
        handler: "handler",
        runtime: lambda.Runtime.NODEJS_24_X,
        bundling: {
          target: "node24",
          minify: true,
          format: lambdaNodejs.OutputFormat.ESM,
          externalModules: ["@aws-sdk/*"],
          banner:
            "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
        },
        timeout: Duration.minutes(2),
      });
      adminUserPool.grant(adminBootstrapFn, "cognito-idp:AdminCreateUser");
      const adminBootstrapProvider = new cr.Provider(this, "AdminBootstrapProvider", {
        onEventHandler: adminBootstrapFn,
      });
      new CustomResource(this, "AdminBootstrap", {
        serviceToken: adminBootstrapProvider.serviceToken,
        properties: {
          UserPoolId: adminUserPool.userPoolId,
          InitialAdmins: initialAdmins,
        },
      });
    }

    // --- Secrets Manager: 招待トークン署名鍵 / LiveKit / YouTube (ADR D-10, T7) ---
    // 招待トークン秘密は CDK 生成のランダム値。LiveKit / YouTube は運用者が後から値を更新する
    // 前提でダミー初期値を入れておく (実値を CDK テンプレートに残さないため)。
    const inviteTokenSecret = new secretsmanager.Secret(this, "InviteTokenSecret", {
      secretName: "stagecast/invite-token-secret",
      description: "招待トークン署名用 HMAC シークレット (ADR D-10)",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: "secret",
        excludePunctuation: true,
        passwordLength: 64,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const livekitSecret = new secretsmanager.Secret(this, "LiveKitSecret", {
      secretName: "stagecast/livekit",
      description: "LiveKit URL / API key / API secret (ADR D-10) — 運用者が値を後から更新する",
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({ url: "", apiKey: "", apiSecret: "" }),
      ),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const youtubeSecret = new secretsmanager.Secret(this, "YouTubeSecret", {
      secretName: "stagecast/youtube",
      description: "YouTube API キー / OAuth クライアント (ADR D-10) — 運用者が値を後から更新する",
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({ apiKey: "", oauthClientId: "", oauthClientSecret: "" }),
      ),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- 制御 API: API Gateway (HTTP API) + Lambda (DESIGN.md 3.1, T5) ---
    // @stagecast/control-api の handler を NodejsFunction で esbuild バンドル。
    // @aws-sdk/* は Lambda Node.js 24 ランタイム提供分を external 化してサイズを抑える。
    const controlApiFn = new lambdaNodejs.NodejsFunction(this, "ControlApiFunction", {
      entry: path.join(__dirname, "..", "..", "services", "control-api", "src", "index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: {
        target: "node24",
        minify: true,
        sourceMap: true,
        format: lambdaNodejs.OutputFormat.ESM,
        // Lambda ランタイム同梱の AWS SDK v3 を再利用する (cold start とサイズを抑える)。
        externalModules: ["@aws-sdk/*"],
        // ESM 出力時の cjs 互換のため、Node.js 24 のネイティブ require を解決可能にする。
        banner:
          "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
      },
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        ASSETS_BUCKET_NAME: assetsBucket.bucketName,
        COGNITO_USER_POOL_ID: adminUserPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: adminUserPoolClient.userPoolClientId,
        INVITE_TOKEN_SECRET_ARN: inviteTokenSecret.secretArn,
        LIVEKIT_SECRET_ARN: livekitSecret.secretArn,
      },
    });
    metadataTable.grantReadWriteData(controlApiFn);
    assetsBucket.grantReadWrite(controlApiFn);
    inviteTokenSecret.grantRead(controlApiFn);
    livekitSecret.grantRead(controlApiFn);

    // --- API Gateway HTTP API + Cognito JWT Authorizer (T5, F-12) ---
    // 防御層: API Gateway で JWT を一次検証し、Lambda 側 (cognitoAdminAuthVerifier) で
    // 二次検証する (sub の取り出し・将来の email allowlist 用)。
    const httpApi = new apigwv2.CfnApi(this, "ControlHttpApi", {
      name: "stagecast-control-api",
      protocolType: "HTTP",
      corsConfiguration: {
        allowOrigins: [
          `https://${adminWebDistribution.domainName}`,
          `https://${stageWebDistribution.domainName}`,
          "http://localhost:5173",
          "http://localhost:5174",
        ],
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["authorization", "content-type"],
        allowCredentials: false,
      },
    });
    const integration = new apigwv2.CfnIntegration(this, "ControlApiIntegration", {
      apiId: httpApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: controlApiFn.functionArn,
      payloadFormatVersion: "2.0",
    });

    const jwtAuthorizer = new apigwv2.CfnAuthorizer(this, "AdminJwtAuthorizer", {
      apiId: httpApi.ref,
      name: "AdminJwtAuthorizer",
      authorizerType: "JWT",
      identitySource: ["$request.header.Authorization"],
      jwtConfiguration: {
        audience: [adminUserPoolClient.userPoolClientId],
        issuer: `https://cognito-idp.${this.region}.amazonaws.com/${adminUserPool.userPoolId}`,
      },
    });

    // 公開ルート (招待トークン検証 / 入室) — 招待 URL でアクセスするモデレーター/登壇者用 (4.1)。
    // API Gateway の JWT を通さず、control-api 内で招待トークンを検証する。
    for (const route of ["POST /invites/verify", "POST /join", "OPTIONS /{proxy+}"]) {
      new apigwv2.CfnRoute(this, `PublicRoute${route.replace(/[^A-Za-z0-9]/g, "_")}`, {
        apiId: httpApi.ref,
        routeKey: route,
        target: `integrations/${integration.ref}`,
        authorizationType: "NONE",
      });
    }

    // 既定ルート: 管理者専用。API Gateway 側で JWT を検証してから Lambda へ。
    new apigwv2.CfnRoute(this, "ControlApiDefaultRoute", {
      apiId: httpApi.ref,
      routeKey: "$default",
      target: `integrations/${integration.ref}`,
      authorizationType: "JWT",
      authorizerId: jwtAuthorizer.ref,
    });

    new apigwv2.CfnStage(this, "ControlApiStage", {
      apiId: httpApi.ref,
      stageName: "$default",
      autoDeploy: true,
    });
    controlApiFn.addPermission("ApiInvoke", {
      principal: new iam.ServicePrincipal("apigateway.amazonaws.com"),
      sourceArn: `arn:aws:execute-api:${this.region}:${this.account}:${httpApi.ref}/*/*`,
    });

    // --- SPA 配信 (DESIGN.md 3.1): ビルド済み dist + ランタイム config.json を S3 へ置き invalidate ---
    // SPA はビルド時に API URL/Cognito を焼き込まず、起動時に /config.json を読む。スタックの
    // 実値 (API/Cognito) を Source.jsonData でここから注入するので `cdk deploy` だけで配信が完結する。
    // webAssets はビルド済み dist がある時だけ渡される (ビルド前 synth では skip → synth は壊れない)。
    if (props?.webAssets) {
      const controlApiUrl = `https://${httpApi.ref}.execute-api.${this.region}.amazonaws.com`;
      new s3deploy.BucketDeployment(this, "AdminWebDeployment", {
        destinationBucket: adminWebBucket,
        distribution: adminWebDistribution,
        distributionPaths: ["/*"],
        sources: [
          s3deploy.Source.asset(props.webAssets.adminWebDir),
          s3deploy.Source.jsonData("config.json", {
            controlApiUrl,
            cognito: {
              domain: `${adminAuthDomain.domainName}.auth.${this.region}.amazoncognito.com`,
              clientId: adminUserPoolClient.userPoolClientId,
            },
          }),
        ],
      });
      new s3deploy.BucketDeployment(this, "StageWebDeployment", {
        destinationBucket: stageWebBucket,
        distribution: stageWebDistribution,
        distributionPaths: ["/*"],
        sources: [
          s3deploy.Source.asset(props.webAssets.stageWebDir),
          s3deploy.Source.jsonData("config.json", { controlApiUrl }),
        ],
      });
    }

    // --- 出力 (フロントビルド / 運用) ---
    new CfnOutput(this, "AdminWebUrl", { value: `https://${adminWebDistribution.domainName}` });
    new CfnOutput(this, "StageWebUrl", { value: `https://${stageWebDistribution.domainName}` });
    new CfnOutput(this, "ControlApiId", { value: httpApi.ref });
    new CfnOutput(this, "ControlApiEndpoint", {
      value: `https://${httpApi.ref}.execute-api.${this.region}.amazonaws.com`,
    });
    new CfnOutput(this, "MetadataTableName", { value: metadataTable.tableName });
    new CfnOutput(this, "AssetsBucketName", { value: assetsBucket.bucketName });
    new CfnOutput(this, "CaptionWorkerRepoUri", {
      value: captionWorkerRepo.repositoryUri,
      description: "字幕ワーカーイメージの ECR リポジトリ URI (GHA build/push の宛先)",
    });
    new CfnOutput(this, "AdminWebBucketName", { value: adminWebBucket.bucketName });
    new CfnOutput(this, "StageWebBucketName", { value: stageWebBucket.bucketName });
    new CfnOutput(this, "AdminWebDistributionId", { value: adminWebDistribution.distributionId });
    new CfnOutput(this, "StageWebDistributionId", { value: stageWebDistribution.distributionId });
    new CfnOutput(this, "AdminUserPoolId", { value: adminUserPool.userPoolId });
    new CfnOutput(this, "AdminUserPoolClientId", { value: adminUserPoolClient.userPoolClientId });
    new CfnOutput(this, "AdminAuthDomain", {
      value: `${adminAuthDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description:
        "Cognito Hosted UI ドメイン (admin-web の OAuth Authorization Code + PKCE で使用)",
    });
    new CfnOutput(this, "InviteTokenSecretArn", { value: inviteTokenSecret.secretArn });
    new CfnOutput(this, "LiveKitSecretArn", { value: livekitSecret.secretArn });
    new CfnOutput(this, "YouTubeSecretArn", { value: youtubeSecret.secretArn });

    // --- EventMediaStack 作成用 CloudFormation サービスロール (R5, ADR 0005 D-5) ---
    // 広い権限 (ec2/ecs/elasticache/elbv2/iam/logs/cw/sns) はこのロールに集約し、
    // cloudformation.amazonaws.com からのみ assume 可能にする。reconcile Lambda 自身は
    // これらを直接持たず、CFN にロールを渡す (iam:PassRole) だけにして攻撃面を絞る。
    const eventMediaCfnRole = new iam.Role(this, "EventMediaCfnExecRole", {
      assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
      description: "CloudFormation execution role for EventMediaStack (ADR 0005 D-5)",
    });
    eventMediaCfnRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:*",
          "ecs:*",
          "elasticache:*",
          "elasticloadbalancing:*", // R1 で追加した NLB の作成に必要。
          "logs:*",
          "cloudwatch:*",
          "sns:*",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:PassRole",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:CreateServiceLinkedRole",
          "iam:GetRole",
          "iam:GetRolePolicy",
          "iam:ListRolePolicies",
          "iam:ListAttachedRolePolicies",
          "iam:TagRole",
          "iam:UntagRole",
        ],
        resources: ["*"],
      }),
    );

    // --- テンプレート生成 Lambda (D1) ---
    // CDK synth (= aws-cdk-lib 同梱で ~34MB) は **この Lambda にのみ**閉じ込め、60s tick の
    // reconcile 本体のバンドルを小さく保つ。reconcile からは invoke されるだけ。
    const renderTemplateFn = new lambdaNodejs.NodejsFunction(this, "RenderTemplateFunction", {
      entry: path.join(
        __dirname,
        "..",
        "..",
        "services",
        "media-orchestrator",
        "src",
        "render-template-handler.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: {
        target: "node24",
        minify: true,
        format: lambdaNodejs.OutputFormat.ESM,
        externalModules: ["@aws-sdk/*"],
        banner:
          "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
      },
      memorySize: 1024, // CDK synth ピーク用
      timeout: Duration.minutes(1),
      environment: {
        CDK_DEFAULT_ACCOUNT: this.account,
        CDK_DEFAULT_REGION: this.region,
        // EventMediaStack の caption-worker イメージに使う (R4)。`latest` を参照。
        CAPTION_WORKER_IMAGE: `${captionWorkerRepo.repositoryUri}:latest`,
        // Egress 録画の出力先 (制御層の成果物バケットを共用)。未設定だと EventMediaStack 既定の
        // ハードコード名にフォールバックし、実在しないバケットを参照してしまう (ADR 0006 D-4)。
        RECORDINGS_BUCKET_NAME: assetsBucket.bucketName,
      },
    });

    // --- 調整ループ Lambda + EventBridge スケジュール (T4, ADR 0003 D-2) ---
    // 60 秒ごとに live イベント集合 (DynamoDB) と CFN スタック集合を照合し、収束させる。
    // テンプレート生成は RenderTemplateFunction に分離したため本体は軽量 (D1)。
    // 明示の LogGroup を与える (デフォルトの LogRetention カスタムリソース Lambda を増やさないため)。
    // メトリクスフィルタ (下の stale 検知) もこの LogGroup に張る。
    const reconcileLogGroup = new logs.LogGroup(this, "ReconcileLogs", {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const reconcileFn = new lambdaNodejs.NodejsFunction(this, "ReconcileFunction", {
      logGroup: reconcileLogGroup,
      entry: path.join(
        __dirname,
        "..",
        "..",
        "services",
        "media-orchestrator",
        "src",
        "reconcile-handler.ts",
      ),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_24_X,
      bundling: {
        target: "node24",
        minify: true,
        format: lambdaNodejs.OutputFormat.ESM,
        externalModules: ["@aws-sdk/*"],
        banner:
          "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
      },
      memorySize: 256,
      timeout: Duration.minutes(2),
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        // CFN に渡す実行ロール ARN (R5)。reconcile は CreateStack 時に RoleARN として渡す。
        CFN_EXEC_ROLE_ARN: eventMediaCfnRole.roleArn,
        // テンプレート生成 Lambda を invoke する (D1)。
        RENDER_TEMPLATE_FUNCTION_NAME: renderTemplateFn.functionName,
      },
    });
    // reconcile は RenderTemplateFunction を invoke できる。
    renderTemplateFn.grantInvoke(reconcileFn);
    metadataTable.grantReadData(reconcileFn);
    // reconcile 自身は「スタック操作」と「CFN ロールを渡す」権限のみ持つ (R5, ADR 0005 D-5)。
    // 実リソース作成権限は eventMediaCfnRole に集約し、Lambda には付与しない。
    reconcileFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:ListStacks",
          "cloudformation:DescribeStacks",
          "cloudformation:CreateStack",
          "cloudformation:DeleteStack",
          "cloudformation:UpdateStack",
        ],
        resources: ["*"],
      }),
    );
    // CFN サービスロールを CloudFormation にのみ渡せるよう PassRole を限定する。
    reconcileFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [eventMediaCfnRole.roleArn],
        conditions: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
      }),
    );
    new CfnOutput(this, "EventMediaCfnExecRoleArn", { value: eventMediaCfnRole.roleArn });

    new events.Rule(this, "ReconcileSchedule", {
      description: "media-orchestrator の reconcile を 60 秒ごとに起動 (ADR 0003 D-2)",
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(reconcileFn)],
    });

    // reconcile が出す「stale event-media stack」警告 (24h 超残存) をメトリクス化してアラート
    // する。終了し忘れた live イベントの課金暴走を早期検知する (L3, N-1)。通知先 (Slack/メール)
    // は EventMediaStack のアラームトピックと同様、デプロイ後に subscribe する想定。
    const orchestratorAlarmTopic = new sns.Topic(this, "OrchestratorAlarmTopic", {
      displayName: "Stagecast orchestrator alarms",
    });
    new logs.MetricFilter(this, "StaleStackFilter", {
      logGroup: reconcileLogGroup,
      metricNamespace: "Stagecast/Orchestrator",
      metricName: "StaleEventMediaStacks",
      // 構造化ログ (createLogger) の JSON から msg で絞り込む。
      filterPattern: logs.FilterPattern.literal('{ $.msg = "stale event-media stack" }'),
      metricValue: "1",
    });
    const staleStackAlarm = new cloudwatch.Alarm(this, "StaleStackAlarm", {
      alarmName: "stagecast-stale-event-media-stack",
      alarmDescription: "24h を超えて残存するイベントスタックを検知 (コスト暴走の疑い, L3)",
      metric: new cloudwatch.Metric({
        namespace: "Stagecast/Orchestrator",
        metricName: "StaleEventMediaStacks",
        statistic: "Sum",
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    staleStackAlarm.addAlarmAction(new cwActions.SnsAction(orchestratorAlarmTopic));

    new CfnOutput(this, "ReconcileFunctionName", { value: reconcileFn.functionName });
    new CfnOutput(this, "OrchestratorAlarmTopicArn", { value: orchestratorAlarmTopic.topicArn });
  }

  /** SPA 用 S3 バケットの共通設定 (private + KMS なしの S3 管理暗号化)。 */
  private buildSpaBucket(id: string): s3.Bucket {
    return new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // 開発環境では stack 削除でバケットも消す。中身は BucketDeployment 生成物なので失っても再生成可能。
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
  }

  /** SPA 用 CloudFront ディストリビューションの共通設定 (OAC + SPA ルーティング)。 */
  private buildSpaDistribution(id: string, bucket: s3.Bucket): cloudfront.Distribution {
    return new cloudfront.Distribution(this, id, {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });
  }
}
