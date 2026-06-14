import * as path from "node:path";
import {
  Stack,
  type StackProps,
  RemovalPolicy,
  Duration,
  CfnOutput,
  aws_s3 as s3,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_dynamodb as dynamodb,
  aws_cognito as cognito,
  aws_lambda as lambda,
  aws_apigatewayv2 as apigwv2,
  aws_iam as iam,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

/**
 * 制御層スタック (DESIGN.md 3.1 / 9 章, ADR D-4)。
 *
 * 常時稼働するのはこのスタックのリソースのみ。すべて低コスト・リクエスト/従量課金で、
 * 非配信時はほぼ無料になるよう構成する (N-1, DESIGN.md 7.2)。
 *
 * 含むもの:
 *  - S3 + CloudFront : 管理 SPA の静的ホスティングと CDN 配信
 *  - DynamoDB        : イベント/参加者/招待トークン/発表状態のメタデータ (オンデマンド課金)
 *  - Cognito         : 管理者認証
 *  - API Gateway + Lambda : 制御 API (リクエスト課金)
 *  - S3 (assets)     : QR・スライド・配信録画・確定字幕など成果物
 *
 * メディア層・翻訳層 (SFU/Egress/字幕/Valkey) はここには置かない。それらはイベント単位で
 * 動的に起動・破棄するため別スタック (event-media-stack) として扱う (DESIGN.md 7.1, ADR D-6)。
 */
export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- DynamoDB: メタデータ (オンデマンド課金で非配信時の固定費ゼロ) ---
    // 単一テーブル設計。PK=エンティティ種別+ID, SK=サブエンティティ。
    // events / participants / invite-tokens / presentation-state を格納する。
    const metadataTable = new dynamodb.Table(this, "MetadataTable", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // GSI1: 招待トークン jti からの逆引き (失効確認)・ロール別検索用。
    metadataTable.addGlobalSecondaryIndex({
      indexName: "gsi1",
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
    });

    // --- S3: 成果物バケット (素材・録画・確定字幕) (DESIGN.md 3.1, 6.4, N-4) ---
    const assetsBucket = new s3.Bucket(this, "AssetsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        // 録画など大きな成果物は段階的に低頻度クラスへ移して保管コストを抑える。
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

    // --- S3 + CloudFront: 管理 SPA の静的ホスティング (DESIGN.md 3.1) ---
    const adminWebBucket = new s3.Bucket(this, "AdminWebBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const adminWebDistribution = new cloudfront.Distribution(this, "AdminWebDistribution", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(adminWebBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // SPA ルーティング: 404/403 を index.html にフォールバック。
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
    });

    // --- Cognito: 管理者認証 (DESIGN.md 4 表, F-12) ---
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
    const adminUserPoolClient = adminUserPool.addClient("AdminUserPoolClient", {
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // --- 制御 API: API Gateway (HTTP API) + Lambda (DESIGN.md 3.1, ADR D-5) ---
    // 実ハンドラは @stagecast/control-api の `handler` (index.ts) に実装済み。
    // デプロイ時は aws_lambda_nodejs.NodejsFunction でバンドルして差し替える想定。
    // synth を build 手順から独立させるため、ここでは同等の応答を返す軽量プレースホルダを
    // 資産として置く。リクエスト課金のため非配信時はほぼ無料 (N-1)。
    const controlApiFn = new lambda.Function(this, "ControlApiFunction", {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "control-api-placeholder")),
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        ASSETS_BUCKET_NAME: assetsBucket.bucketName,
        COGNITO_USER_POOL_ID: adminUserPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: adminUserPoolClient.userPoolClientId,
        // 招待トークン署名鍵は実際には Secrets Manager から注入する (ADR D-10)。
      },
    });
    metadataTable.grantReadWriteData(controlApiFn);
    assetsBucket.grantReadWrite(controlApiFn);

    const httpApi = new apigwv2.CfnApi(this, "ControlHttpApi", {
      name: "stagecast-control-api",
      protocolType: "HTTP",
    });
    const integration = new apigwv2.CfnIntegration(this, "ControlApiIntegration", {
      apiId: httpApi.ref,
      integrationType: "AWS_PROXY",
      integrationUri: controlApiFn.functionArn,
      payloadFormatVersion: "2.0",
    });
    new apigwv2.CfnRoute(this, "ControlApiDefaultRoute", {
      apiId: httpApi.ref,
      routeKey: "$default",
      target: `integrations/${integration.ref}`,
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

    // --- 出力 ---
    new CfnOutput(this, "AdminWebUrl", { value: `https://${adminWebDistribution.domainName}` });
    new CfnOutput(this, "ControlApiId", { value: httpApi.ref });
    new CfnOutput(this, "MetadataTableName", { value: metadataTable.tableName });
    new CfnOutput(this, "AssetsBucketName", { value: assetsBucket.bucketName });
    new CfnOutput(this, "AdminUserPoolId", { value: adminUserPool.userPoolId });
    new CfnOutput(this, "AdminUserPoolClientId", { value: adminUserPoolClient.userPoolClientId });
  }
}
