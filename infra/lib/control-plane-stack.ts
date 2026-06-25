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
  aws_certificatemanager as acm,
  aws_route53 as route53,
  aws_budgets as budgets,
  aws_sns_subscriptions as snsSubscriptions,
  aws_ec2 as ec2,
  aws_kinesisvideo as kinesisvideo,
} from "aws-cdk-lib";
import type { Construct } from "constructs";

/** 制御層スタックの props。webAssets を渡すと SPA を BucketDeployment で配信する。 */
export interface ControlPlaneStackProps extends StackProps {
  /**
   * ビルド済み SPA の dist ディレクトリ。指定時のみ S3 配信 + config.json 生成 + CloudFront
   * invalidation を行う (bin/app.ts が dist 存在時に渡す)。未指定ならビルド前 synth でも壊れない。
   */
  webAssets?: {
    adminWebDir: string;
    stageWebDir: string;
    composerWebDir: string;
    requestWebDir?: string;
  };
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

    // --- 共有 VPC (R12-followup, N-1: 無料リソースの事前作成でイベント起動時間を短縮) ---
    // EventMediaStack で per-event VPC を作っていた経緯 (ADR 0008) だが、VPC + subnet 自体は無料で
    // 隔離は SG で十分なので、共有することで起動時間 2-3 分の短縮 + リソース数削減のメリットが大きい。
    // NAT Gateway は使わず Public Subnet のみ (Egress / SFU / CaptionWorker は assignPublicIp で
    // インターネットに出る)。EventMediaStack が sharedVpc props に値が来ればこれを使う。
    const sharedMediaVpc = new ec2.Vpc(this, "SharedMediaVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    });

    // --- LiveKit シグナリング用ドメイン / ACM 証明書 (ADR 0009 D-3) ---
    // EventMediaStack の NLB に attach するワイルドカード証明書を 1 つだけ作成し、全イベントで共有。
    // DNS validation で HostedZone に自動で CNAME を追加して検証する。
    // 親 HostedZone は Route53 で運用者が事前作成し、CDK context で名前を渡す:
    //   cdk deploy -c mediaHostedZoneName=example.com
    // 未指定なら ADR 0008 D-4 の Public IP 直接公開にフォールバック (TLS スタックを構築しない)。
    const mediaHostedZoneName = this.node.tryGetContext("mediaHostedZoneName") as
      | string
      | undefined;
    const tlsConfig = mediaHostedZoneName
      ? (() => {
          const mediaDomainName = `media.${mediaHostedZoneName}`;
          const mediaHostedZone = route53.HostedZone.fromLookup(this, "MediaHostedZone", {
            domainName: mediaHostedZoneName,
          });
          const mediaCertificate = new acm.Certificate(this, "MediaCertificate", {
            domainName: `*.${mediaDomainName}`,
            validation: acm.CertificateValidation.fromDns(mediaHostedZone),
          });
          return { mediaDomainName, mediaHostedZone, mediaCertificate };
        })()
      : undefined;

    // --- S3 + CloudFront: 管理 SPA / 登壇者 SPA の静的ホスティング (DESIGN.md 3.1, T6) ---
    const adminWebBucket = this.buildSpaBucket("AdminWebBucket");
    const adminWebDistribution = this.buildSpaDistribution("AdminWebDistribution", adminWebBucket);
    const stageWebBucket = this.buildSpaBucket("StageWebBucket");
    const stageWebDistribution = this.buildSpaDistribution("StageWebDistribution", stageWebBucket);
    // ADR 0012 D-2: カスタム Egress テンプレート (composer-template) を独立 Distribution で配信。
    // 当初は admin-web Distribution に /composer/ path で追加する案だったが、 CloudFront の
    // cache behavior 切替と admin-web の SPA routing (BrowserRouter) の衝突懸念があり、
    // 既存パターン (buildSpaBucket + buildSpaDistribution) に合わせて独立 Distribution に変更。
    // ホスティング URL は Egress config の template_base にこの Distribution の URL を渡す
    // (R15 で event-media-stack.ts の liveKitEgressConfig に組み込む)。
    const composerWebBucket = this.buildSpaBucket("ComposerWebBucket");
    const composerWebDistribution = this.buildSpaDistribution(
      "ComposerWebDistribution",
      composerWebBucket,
    );
    const requestWebBucket = this.buildSpaBucket("RequestWebBucket");
    const requestWebDistribution = this.buildSpaDistribution(
      "RequestWebDistribution",
      requestWebBucket,
    );

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
    // セッション長 (2026-06-20): 1 イベント運営で 1〜2 時間のオペレーションが続くため、
    // ID/Access Token を 6 時間に延長し、その間トークン再取得不要にする (UX 改善要望)。
    // Cognito の上限: id/access は 1分〜24時間、refresh は 60分〜10年。
    const adminUserPoolClient = adminUserPool.addClient("AdminUserPoolClient", {
      authFlows: { userSrp: true },
      accessTokenValidity: Duration.hours(6),
      idTokenValidity: Duration.hours(6),
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
        // N3: 管理者投入の Custom Resource 経路を可視化。
        tracing: lambda.Tracing.ACTIVE,
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
      // ADR 0008 D-7: URL は per-event 化されたため Secret から削除。apiKey/apiSecret のみ。
      description:
        "LiveKit API key / API secret (ADR D-10, ADR 0008 D-5) — Secrets Manager が自動生成、SettingsPage でローテーション可",
      // CREATE 時に Secrets Manager が apiSecret をランダム生成し、apiKey は account 末尾から
      // 導出した識別子を埋め込む (apiKey 自体は機密でない、LiveKit 公式慣習どおり API prefix
      // を持つ識別子の役割)。UPDATE では再生成されないため、SettingsPage の「鍵を生成」で
      // 手動上書きした値は保持される。
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ apiKey: `APIstagecast${this.account.slice(-6)}` }),
        generateStringKey: "apiSecret",
        // base64url ライクな文字集合に揃える (LiveKit Server の HMAC 署名で利用)。
        excludePunctuation: true,
        passwordLength: 43, // 約 256 bit のエントロピー
      },
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

    // --- KVS WebRTC Signaling Channel (R12-followup-19 / ADR 0011 案 E) ---
    // Amazon Kinesis Video Streams WebRTC が提供する TURN/STUN サーバを利用する。
    // - Signaling Channel を 1 つ作って全イベント共有 (リソースは月額 $0.03 + TURN 使用分のみ)。
    // - control-api の /join handler が `GetSignalingChannelEndpoint` → `GetIceServerConfig` で
    //   短期 credential 付きの iceServers を取得し、 stage-web に渡す。
    // - クライアント (Chrome) が `rtcConfig.iceServers` として直接使う → LiveKit Server の
    //   内蔵 TURN / rtc.turn_servers は使わない (R12-followup-10〜18 を撤回)。
    const kvsSignalingChannel = new kinesisvideo.CfnSignalingChannel(
      this,
      "WebRtcSignalingChannel",
      {
        name: "stagecast-turn",
        type: "SINGLE_MASTER",
        // MessageTtlSeconds は signaling 用 (今回 TURN だけ使うので最小値で OK)。
        messageTtlSeconds: 60,
      },
    );

    // --- 制御 API: API Gateway (HTTP API) + Lambda (DESIGN.md 3.1, T5) ---
    // @stagecast/control-api の handler を NodejsFunction で esbuild バンドル。
    // @aws-sdk/* は Lambda Node.js 24 ランタイム提供分を external 化してサイズを抑える。
    // R12-followup-19: ただし `client-kinesis-video` / `client-kinesis-video-signaling` は
    // Lambda runtime SDK に含まれていないので bundle に含める (R12-followup-19 で curl 結果が
    // 「iceServers field missing」で logger output も無かった原因がこれ)。
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
        // ただし client-kinesis-video 系は含まれていないので bundle に入れる。
        externalModules: [
          "@aws-sdk/client-cognito-identity-provider",
          "@aws-sdk/client-dynamodb",
          "@aws-sdk/client-s3",
          "@aws-sdk/client-secrets-manager",
          "@aws-sdk/lib-dynamodb",
          "@aws-sdk/s3-request-presigner",
        ],
        // ESM 出力時の cjs 互換のため、Node.js 24 のネイティブ require を解決可能にする。
        banner:
          "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
      },
      memorySize: 512,
      // R12: LiveKit Egress 起動 (HTTP リクエスト) のため 30s に延長 (cold start + LiveKit API)。
      timeout: Duration.seconds(30),
      // N3: X-Ray でリクエストフローを可視化 (Lambda → DynamoDB → Secrets Manager 等)。
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        ASSETS_BUCKET_NAME: assetsBucket.bucketName,
        COGNITO_USER_POOL_ID: adminUserPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: adminUserPoolClient.userPoolClientId,
        INVITE_TOKEN_SECRET_ARN: inviteTokenSecret.secretArn,
        INVITE_BASE_URL: `https://${stageWebDistribution.domainName}/join`,
        LIVEKIT_SECRET_ARN: livekitSecret.secretArn,
        // 運用設定 (LiveKit / YouTube) を管理画面から更新できるようにする。
        YOUTUBE_SECRET_ARN: youtubeSecret.secretArn,
        // R12-followup-19: KVS WebRTC TURN を取得するために Channel ARN を渡す。
        KVS_SIGNALING_CHANNEL_ARN: kvsSignalingChannel.attrArn,
        // P-14 / R14: Egress 起動時に file output (S3 録画) を指定するための bucket 名。
        // 配信終了で `recordings/{eventId}/{egress_id}.mp4` が S3 にアップロードされる。
        // SFU TaskRole 側に既存の S3 PutObject 権限あり (ADR 0010 D-5)。
        RECORDINGS_BUCKET_NAME: assetsBucket.bucketName,
      },
    });
    metadataTable.grantReadWriteData(controlApiFn);
    assetsBucket.grantReadWrite(controlApiFn);
    inviteTokenSecret.grantRead(controlApiFn);
    livekitSecret.grantRead(controlApiFn);
    youtubeSecret.grantRead(controlApiFn);
    // R12-followup-19: control-api が /join で KVS から TURN credential を取得するための権限。
    // - GetSignalingChannelEndpoint: HTTPS endpoint を取得 (リージョン毎、 1 回呼べばキャッシュ可)
    // - GetIceServerConfig: 上記 endpoint に対して呼ぶ。 iceServers (URL + username + credential) を返す
    controlApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kinesisvideo:GetSignalingChannelEndpoint", "kinesisvideo:GetIceServerConfig"],
        resources: [kvsSignalingChannel.attrArn],
      }),
    );
    // 管理画面からの設定更新 (PUT /settings/*) 用に、対象 2 Secret に限定して
    // PutSecretValue だけを許可する (ADR D-10)。grantWrite は UpdateSecret も付くため
    // 使わず、値書き込み専用の PolicyStatement で最小権限にする。
    controlApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:PutSecretValue"],
        resources: [livekitSecret.secretArn, youtubeSecret.secretArn],
      }),
    );

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
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

    // 公開ルート (招待トークン検証 / 入室 / プレビュー token) — 招待 URL でアクセスする
    // モデレーター/登壇者用 (4.1, R17-Phase3 / ADR 0012 D-6)。
    // API Gateway の JWT を通さず、control-api 内で招待トークンを検証する。
    // OPTIONS (preflight) は $default (JWT) ルートに吸い込まれて 401 になるため、
    // 明示的に NONE で登録して Lambda に流す。Lambda 側は OPTIONS を即 204 返却する。
    // API Gateway の corsConfiguration が CORS ヘッダ (Allow-Origin 等) を自動付与する。
    // POST /preview-token は stage-web の PreviewWindow が招待トークンで叩く (R17-Phase3)。
    for (const route of [
      "POST /invites/verify",
      "POST /join",
      "POST /preview-token",
      "POST /event-requests",
      "GET /events/public",
      "OPTIONS /{proxy+}",
    ]) {
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
            // R17 / ADR 0012 D-6: admin-web の LivePreview iframe が開く composer-template の URL。
            composerTemplateUrl: `https://${composerWebDistribution.domainName}`,
            requestWebUrl: `https://${requestWebDistribution.domainName}`,
          }),
        ],
      });
      new s3deploy.BucketDeployment(this, "StageWebDeployment", {
        destinationBucket: stageWebBucket,
        distribution: stageWebDistribution,
        distributionPaths: ["/*"],
        sources: [
          s3deploy.Source.asset(props.webAssets.stageWebDir),
          s3deploy.Source.jsonData("config.json", {
            controlApiUrl,
            // R17-Phase3 / ADR 0012 D-6: stage-web の登壇者ビュー右下小窓プレビューが
            // composer-template を iframe で開くための URL。
            composerTemplateUrl: `https://${composerWebDistribution.domainName}`,
          }),
        ],
      });
      // ADR 0012 D-2: composer-template は config.json を持たない (URL パラメータで token/url を受け取る)。
      // Egress の Chrome ヘッドレスからのみアクセスされる想定だが、 R17 で admin-web/stage-web からの
      // iframe プレビューも開く。 認証は LiveKit token に依存 (CloudFront 自体は public)。
      new s3deploy.BucketDeployment(this, "ComposerWebDeployment", {
        destinationBucket: composerWebBucket,
        distribution: composerWebDistribution,
        distributionPaths: ["/*"],
        sources: [s3deploy.Source.asset(props.webAssets.composerWebDir)],
      });
      if (props.webAssets.requestWebDir) {
        new s3deploy.BucketDeployment(this, "RequestWebDeployment", {
          destinationBucket: requestWebBucket,
          distribution: requestWebDistribution,
          distributionPaths: ["/*"],
          sources: [
            s3deploy.Source.asset(props.webAssets.requestWebDir),
            s3deploy.Source.jsonData("config.json", { controlApiUrl }),
          ],
        });
      }
    }

    // --- 出力 (フロントビルド / 運用) ---
    new CfnOutput(this, "AdminWebUrl", { value: `https://${adminWebDistribution.domainName}` });
    new CfnOutput(this, "StageWebUrl", { value: `https://${stageWebDistribution.domainName}` });
    // ADR 0012 D-3: ComposerWebUrl は Egress config の template_base に渡される (event-media-stack.ts)。
    new CfnOutput(this, "ComposerWebUrl", {
      value: `https://${composerWebDistribution.domainName}`,
    });
    new CfnOutput(this, "RequestWebUrl", { value: `https://${requestWebDistribution.domainName}` });
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
    new CfnOutput(this, "ComposerWebBucketName", { value: composerWebBucket.bucketName });
    new CfnOutput(this, "AdminWebDistributionId", { value: adminWebDistribution.distributionId });
    new CfnOutput(this, "StageWebDistributionId", { value: stageWebDistribution.distributionId });
    new CfnOutput(this, "ComposerWebDistributionId", {
      value: composerWebDistribution.distributionId,
    });
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
    // LiveKit シグナリング TLS 用のドメイン / 証明書 (ADR 0009 D-3)。EventMediaStack の NLB が attach する。
    // context `mediaHostedZoneName` 未指定時は CfnOutput も作らない (TLS スタック構築をスキップ)。
    if (tlsConfig) {
      new CfnOutput(this, "MediaCertificateArn", {
        value: tlsConfig.mediaCertificate.certificateArn,
      });
      new CfnOutput(this, "MediaHostedZoneId", { value: tlsConfig.mediaHostedZone.hostedZoneId });
      new CfnOutput(this, "MediaHostedZoneName", { value: mediaHostedZoneName! });
      new CfnOutput(this, "MediaDomainName", { value: tlsConfig.mediaDomainName });
    }

    // --- EventMediaStack 作成用 CloudFormation サービスロール (R5, ADR 0005 D-5) ---
    // 広い権限 (ec2/ecs/elasticache/iam/logs/cw/sns) はこのロールに集約し、
    // cloudformation.amazonaws.com からのみ assume 可能にする。reconcile Lambda 自身は
    // これらを直接持たず、CFN にロールを渡す (iam:PassRole) だけにして攻撃面を絞る。
    // ADR 0009 で NLB をシグナリング用に復活させたため elasticloadbalancing と route53 権限を追加。
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
          "logs:*",
          "cloudwatch:*",
          "sns:*",
          // ADR 0009 D-1: NLB + TLS Listener + TargetGroup の作成・削除に必要。
          "elasticloadbalancing:*",
          // CDK テンプレートは CFN deploy 時に bootstrap バージョン (/cdk-bootstrap/hnb659fds/version)
          // を SSM Parameter Store から読み取る。この権限が無いと CreateStack が AccessDenied で失敗する。
          "ssm:GetParameter",
          "ssm:GetParameters",
          // EventMediaStack 内の Secrets Manager 参照 (LiveKit 鍵の ECS Secret 注入) に必要。
          "secretsmanager:GetSecretValue",
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
    // ADR 0009 D-4: Route53 ARecord (per-event DNS) の作成・削除に必要。
    // 親 HostedZone を ARN で絞り込み、他ゾーンへの誤書き込みを防ぐ。
    // tlsConfig 未指定時 (mediaHostedZoneName が context に無い) はこのポリシーも付与しない。
    if (tlsConfig) {
      eventMediaCfnRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            "route53:ChangeResourceRecordSets",
            "route53:GetHostedZone",
            "route53:ListResourceRecordSets",
          ],
          resources: [`arn:aws:route53:::hostedzone/${tlsConfig.mediaHostedZone.hostedZoneId}`],
        }),
      );
    }
    // CFN が ChangeResourceRecordSets のステータスをポーリングするのに必要。
    eventMediaCfnRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["route53:GetChange"],
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
      // N3: X-Ray でテンプレ生成にかかる時間を可視化。
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        CDK_DEFAULT_ACCOUNT: this.account,
        CDK_DEFAULT_REGION: this.region,
        // EventMediaStack の caption-worker イメージに使う (R4)。
        CAPTION_WORKER_IMAGE: `${captionWorkerRepo.repositoryUri}:latest`,
        // Egress 録画の出力先 (制御層の成果物バケットを共用)。未設定だと EventMediaStack 既定の
        // ハードコード名にフォールバックし、実在しないバケットを参照してしまう (ADR 0006 D-4)。
        RECORDINGS_BUCKET_NAME: assetsBucket.bucketName,
        // ADR 0009: LiveKit シグナリングを NLB + ACM で TLS 終端する。EventMediaStack が
        // これらを使って NLB の TLS Listener と Route53 ARecord を作成する。
        // tlsConfig 未指定なら env を渡さず、EventMediaStack は ADR 0008 D-4 の Public IP 直接公開にフォールバック。
        ...(tlsConfig
          ? {
              MEDIA_CERTIFICATE_ARN: tlsConfig.mediaCertificate.certificateArn,
              MEDIA_HOSTED_ZONE_ID: tlsConfig.mediaHostedZone.hostedZoneId,
              MEDIA_HOSTED_ZONE_NAME: mediaHostedZoneName!,
              MEDIA_DOMAIN_NAME: tlsConfig.mediaDomainName,
            }
          : {}),
        // 共有 VPC を EventMediaStack に渡す (起動時間短縮)。
        SHARED_VPC_ID: sharedMediaVpc.vpcId,
        SHARED_VPC_CIDR: sharedMediaVpc.vpcCidrBlock,
        SHARED_SUBNET_IDS: sharedMediaVpc.publicSubnets.map((s) => s.subnetId).join(","),
        SHARED_SUBNET_AZS: sharedMediaVpc.publicSubnets.map((s) => s.availabilityZone).join(","),
        // ADR 0012 D-3: カスタム Egress テンプレート (composer-template) の URL を
        // EventMediaStack に渡す。 render-template.ts が process.env から読んで Egress config
        // の template_base に注入する。
        COMPOSER_TEMPLATE_URL: `https://${composerWebDistribution.domainName}`,
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
      // N3: X-Ray で reconcile → CFN → ECS の trace を繋ぐ。
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        METADATA_TABLE_NAME: metadataTable.tableName,
        // CFN に渡す実行ロール ARN (R5)。reconcile は CreateStack 時に RoleARN として渡す。
        CFN_EXEC_ROLE_ARN: eventMediaCfnRole.roleArn,
        // テンプレート生成 Lambda を invoke する (D1)。
        RENDER_TEMPLATE_FUNCTION_NAME: renderTemplateFn.functionName,
        // ADR 0008 D-6: 並列イベント数の soft cap (コスト暴走防止)。
        MAX_PARALLEL_EVENTS: "10",
      },
    });
    // reconcile は RenderTemplateFunction を invoke できる。
    renderTemplateFn.grantInvoke(reconcileFn);
    // ADR 0008 D-2: events 行の media フィールドを書き戻すため Read だけでなく Write も必要。
    metadataTable.grantReadWriteData(reconcileFn);
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
    // ADR 0008 D-2: ECS task の Public IP を引いて events.media.livekitUrl を埋めるため、
    // 読み取り系 API を許可する。Resource は EventMediaStack のクラスタ・タスク全般。
    reconcileFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:ListTasks", "ecs:DescribeTasks", "ec2:DescribeNetworkInterfaces"],
        resources: ["*"],
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

    // --- AWS Budgets: 月額コスト監視アラート (O1, L3) ---
    // 暴走したリソースや想定外コストを早期検知。AWS Budgets 自体は無料 (アカウントあたり 2 つまで)。
    // context で閾値とメール通知先を指定:
    //   cdk deploy -c budgetMonthlyUsd=50 -c budgetEmail=ops@example.com
    // メール未指定なら OrchestratorAlarmTopic に通知する (運用者が事前に subscribe しておく前提)。
    const budgetMonthlyUsdRaw = this.node.tryGetContext("budgetMonthlyUsd") as string | undefined;
    const budgetMonthlyUsd = budgetMonthlyUsdRaw ? Number(budgetMonthlyUsdRaw) : 50;
    const budgetEmail = this.node.tryGetContext("budgetEmail") as string | undefined;

    // Budgets 専用の SNS Topic (Cost アラート)。OrchestratorAlarmTopic と分けることで
    // 受信者が Cost と Ops を別々に subscribe できるようにする。
    const costAlarmTopic = new sns.Topic(this, "CostAlarmTopic", {
      displayName: "Stagecast cost alarms",
    });
    if (budgetEmail) {
      costAlarmTopic.addSubscription(new snsSubscriptions.EmailSubscription(budgetEmail));
    }
    // Budgets サービスから SNS:Publish を許可 (公式推奨ポリシー)。
    costAlarmTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ["SNS:Publish"],
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        resources: [costAlarmTopic.topicArn],
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: { "aws:SourceArn": `arn:aws:budgets::${this.account}:*` },
        },
      }),
    );

    new budgets.CfnBudget(this, "MonthlyCostBudget", {
      budget: {
        budgetName: "stagecast-monthly-cost",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: budgetMonthlyUsd, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          // 実績が予算の 80% を超えたら WARN。
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "SNS", address: costAlarmTopic.topicArn }],
        },
        {
          // 月末予測が予算の 100% を超えたら CRITICAL (早期検知)。
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "SNS", address: costAlarmTopic.topicArn }],
        },
      ],
    });
    new CfnOutput(this, "CostAlarmTopicArn", { value: costAlarmTopic.topicArn });
    new CfnOutput(this, "BudgetMonthlyUsd", { value: String(budgetMonthlyUsd) });
    new CfnOutput(this, "SharedMediaVpcId", { value: sharedMediaVpc.vpcId });
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
