import { App } from "aws-cdk-lib";
import { EventMediaStack, eventMediaStackName } from "./event-media-stack";
import type { CaptionEngineKind } from "@stagecast/shared";

/**
 * イベント単位メディアスタックの CloudFormation テンプレート(JSON 文字列)を生成する
 * (DESIGN.md 7.1, ADR 0001/0003)。
 *
 * `media-orchestrator` の `CloudFormationMediaStackProvisioner` に `renderTemplate` として
 * 渡し、イベント開始時に実テンプレートを供給する。EventMediaStack を CDK でプログラム的に
 * synth し、生成された CloudFormation テンプレートを返す。
 */
export interface RenderEventMediaSpec {
  eventId: string;
  captionEngine: CaptionEngineKind;
  customCaptionApi: boolean;
}

export function renderEventMediaTemplate(spec: RenderEventMediaSpec): string {
  const app = new App();
  const stackName = eventMediaStackName(spec.eventId);
  new EventMediaStack(app, stackName, {
    eventId: spec.eventId,
    captionEngine: spec.captionEngine,
    customCaptionApi: spec.customCaptionApi,
  });
  const assembly = app.synth();
  const template = assembly.getStackByName(stackName).template as unknown;
  return JSON.stringify(template);
}
