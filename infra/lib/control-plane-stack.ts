import * as path from "node:path";
import {
  Stack,
  type StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  SecretValue,
  aws_s3 as s3,
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
} from "aws-cdk-lib";
import type { Construct } from "constructs";

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
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- DynamoDB: メタデータ (オンデマンド課金で非配信時の固定費ゼロ) ---
    const metadataTable = new dynamodb.Table(this, "MetadataTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
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
      removalPolicy: RemovalPolicy.RETAIN,
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
      removalPolicy: RemovalPolicy.RETAIN,
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
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const livekitSecret = new secretsmanager.Secret(this, "LiveKitSecret", {
      secretName: "stagecast/livekit",
      description: "LiveKit URL / API key / API secret (ADR D-10) — 運用者が値を後から更新する",
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({ url: "", apiKey: "", apiSecret: "" }),
      ),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const youtubeSecret = new secretsmanager.Secret(this, "YouTubeSecret", {
      secretName: "stagecast/youtube",
      description: "YouTube API キー / OAuth クライアント (ADR D-10) — 運用者が値を後から更新する",
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({ apiKey: "", oauthClientId: "", oauthClientSecret: "" }),
      ),
      removalPolicy: RemovalPolicy.RETAIN,
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

    // --- 出力 (フロントビルド / 運用) ---
    new CfnOutput(this, "AdminWebUrl", { value: `https://${adminWebDistribution.domainName}` });
    new CfnOutput(this, "StageWebUrl", { value: `https://${stageWebDistribution.domainName}` });
    new CfnOutput(this, "ControlApiId", { value: httpApi.ref });
    new CfnOutput(this, "ControlApiEndpoint", {
      value: `https://${httpApi.ref}.execute-api.${this.region}.amazonaws.com`,
    });
    new CfnOutput(this, "MetadataTableName", { value: metadataTable.tableName });
    new CfnOutput(this, "AssetsBucketName", { value: assetsBucket.bucketName });
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

    // --- 調整ループ Lambda + EventBridge スケジュール (T4, ADR 0003 D-2) ---
    // 60 秒ごとに live イベント集合 (DynamoDB) と CFN スタック集合を照合し、収束させる。
    // CDK synth を伴うため bundle が大きい (CDK 同梱)。常時稼働ではなく 60s tick なので OK。
    const reconcileFn = new lambdaNodejs.NodejsFunction(this, "ReconcileFunction", {
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
      memorySize: 1024, // CDK synth + esbuild ピーク用
      timeout: Duration.minutes(2),
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        CDK_DEFAULT_ACCOUNT: this.account,
        CDK_DEFAULT_REGION: this.region,
      },
    });
    metadataTable.grantReadData(reconcileFn);
    // CFN スタックの作成・削除・参照に必要な権限。本来はスタック ARN で絞りたいが、
    // 動的に作るので * とする。スタック名 prefix `StagecastEventMedia-` で実質スコープされる。
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
    // EventMediaStack はネットワーク/ECS/ElastiCache/IAM を作るため、それらの権限も必要。
    // CDK の bootstrap で作られる cdk-* file asset bucket への書き込みも必要 (synth 結果)。
    reconcileFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ec2:*",
          "ecs:*",
          "elasticache:*",
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:PassRole",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:PutRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:CreateServiceLinkedRole",
          "iam:GetRole",
          "iam:TagRole",
          "iam:UntagRole",
          "logs:*",
          "s3:GetObject",
          "s3:PutObject",
        ],
        resources: ["*"],
      }),
    );

    new events.Rule(this, "ReconcileSchedule", {
      description: "media-orchestrator の reconcile を 60 秒ごとに起動 (ADR 0003 D-2)",
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new eventsTargets.LambdaFunction(reconcileFn)],
    });

    new CfnOutput(this, "ReconcileFunctionName", { value: reconcileFn.functionName });
  }

  /** SPA 用 S3 バケットの共通設定 (private + KMS なしの S3 管理暗号化)。 */
  private buildSpaBucket(id: string): s3.Bucket {
    return new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
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
