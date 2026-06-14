#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { ControlPlaneStack } from "../lib/control-plane-stack";
import { EventMediaStack, eventMediaStackName } from "../lib/event-media-stack";
import type { CaptionEngineKind } from "@stagecast/shared";

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "ap-northeast-1",
};

// 制御層 (常時稼働) は常にデプロイ対象。
new ControlPlaneStack(app, "StagecastControlPlane", { env });

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
