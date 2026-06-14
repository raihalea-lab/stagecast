#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ControlPlaneStack } from '../lib/control-plane-stack';

const app = new App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1',
};

// 制御層 (常時稼働) のみをデプロイ対象に置く。
// メディア層/字幕層はイベント単位で media-orchestrator が動的に起動する (DESIGN.md 7.1)。
new ControlPlaneStack(app, 'StagecastControlPlane', { env });

app.synth();
