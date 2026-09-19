#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { ControlPlaneStack, PRODUCT_SUBDOMAIN } from "../lib/control-plane-stack";
import { WebCertificateStack } from "../lib/web-certificate-stack";
import { EventMediaStack, eventMediaStackName } from "../lib/event-media-stack";
import type { CaptionEngineKind } from "@stagecast/shared";
import type { UserConfig } from "../lib/user-config";

let userConfig: UserConfig = {};
if (existsSync(join(__dirname, "..", "user-config.ts"))) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  userConfig = (require("../user-config") as { default: UserConfig }).default;
}

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "ap-northeast-1",
};

// ビルド済み SPA があれば BucketDeployment で配信する (ビルド前 synth では渡さない)。
// 事前に `vp run -r build` 済みであること (env 焼き込み不要・config.json は CDK が生成)。
const repoRoot = join(__dirname, "..", "..");
const adminWebDir = join(repoRoot, "apps", "admin-web", "dist");
const stageWebDir = join(repoRoot, "apps", "stage-web", "dist");
const composerWebDir = join(repoRoot, "apps", "composer-template", "dist");
const requestWebDir = join(repoRoot, "apps", "request-web", "dist");
const webAssets =
  existsSync(adminWebDir) && existsSync(stageWebDir) && existsSync(composerWebDir)
    ? {
        adminWebDir,
        stageWebDir,
        composerWebDir,
        requestWebDir: existsSync(requestWebDir) ? requestWebDir : undefined,
      }
    : undefined;

// ADR 0028 D-2: CloudFront は us-east-1 の証明書しか受け付けない。制御層は ap-northeast-1
// なので証明書だけ別スタックに分け、crossRegionReferences で ARN を渡す。
// ホストゾーン未設定なら作らない (自前ドメイン無しでもデプロイできる)。
const webCertStack = userConfig.mediaHostedZoneName
  ? new WebCertificateStack(app, "StagecastWebCertificate", {
      env: { account: env.account, region: "us-east-1" },
      crossRegionReferences: true,
      hostedZoneName: userConfig.mediaHostedZoneName,
      appDomainName: `${PRODUCT_SUBDOMAIN}.${userConfig.mediaHostedZoneName}`,
    })
  : undefined;

// 制御層 (常時稼働) は常にデプロイ対象。
new ControlPlaneStack(app, "StagecastControlPlane", {
  env,
  webAssets,
  userConfig,
  crossRegionReferences: true,
  ...(webCertStack ? { webCertificateArn: webCertStack.certificateArn } : {}),
});

// イベント単位メディアスタックは media-orchestrator が動的に起動する (DESIGN.md 7.1)。
// `cdk deploy -c eventId=<id> [-c captionEngine=transcribe] [-c customCaptionApi=true]` で
// 当該イベント専用スタックのみを合成・デプロイできる。
const eventId = app.node.tryGetContext("eventId") as string | undefined;
if (eventId) {
  new EventMediaStack(app, eventMediaStackName(eventId), {
    env,
    eventId,
    captionEngine: (app.node.tryGetContext("captionEngine") as CaptionEngineKind) ?? "transcribe",
    customCaptionApi: app.node.tryGetContext("customCaptionApi") === "true",
  });
}

app.synth();
