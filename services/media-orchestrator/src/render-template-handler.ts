/**
 * EventMediaStack テンプレート生成 Lambda (D1, ADR 0003 D-2)。
 *
 * `renderEventMediaTemplate` は CDK synth を伴い aws-cdk-lib 全体をバンドルするため、
 * 60s tick の reconcile Lambda に同梱すると cold start が重くなる (旧: 約 34MB)。
 * 本ハンドラを **専用 Lambda** に切り出し、reconcile はこれを invoke するだけにすることで
 * reconcile 本体のバンドルを小さく保つ (`docs/NEXT_WORK.md` D1)。
 *
 * 入力: { eventId, captionEngine, customCaptionApi }
 * 出力: { template }  // CloudFormation テンプレート JSON 文字列
 */
import { renderEventMediaTemplate } from "@stagecast/infra/render-template";
import type { CaptionEngineKind } from "@stagecast/shared";

export interface RenderRequest {
  eventId: string;
  captionEngine: CaptionEngineKind;
  customCaptionApi: boolean;
  rtmpUrl?: string;
  streamKeyRef?: string;
  desiredCount?: number;
}

export async function handler(event: RenderRequest): Promise<{ template: string }> {
  const template = renderEventMediaTemplate({
    eventId: event.eventId,
    captionEngine: event.captionEngine,
    customCaptionApi: event.customCaptionApi,
    ...(event.rtmpUrl ? { rtmpUrl: event.rtmpUrl } : {}),
    ...(event.streamKeyRef ? { streamKeyRef: event.streamKeyRef } : {}),
    ...(event.desiredCount !== undefined ? { desiredCount: event.desiredCount } : {}),
  });
  return { template };
}
