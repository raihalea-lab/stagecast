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
import { CANONICAL_EVENT_ID, hashTemplate } from "./template-version.js";

export interface RenderRequest {
  eventId: string;
  captionEngine: CaptionEngineKind;
  customCaptionApi: boolean;
  rtmpUrl?: string;
  streamKeyRef?: string;
  desiredCount?: number;
  captionDesiredCount?: number;
}

/**
 * テンプレートの版 (ADR 0016 D-4)。**この Lambda 側で計算する。**
 *
 * 版を決めるのはレンダリング処理と env で、それはこの Lambda を入れ替えないと変わらない。
 * reconcile 側でキャッシュすると、**別関数の寿命に紐づいた古い版**を持ち続けることになり、
 * デプロイ直後に検知が効かないばかりか、新旧コンテナが別の版を主張して
 * スタックの破棄と再作成が毎 tick フラップする。
 */
let cachedVersion: string | undefined;
function templateVersion(): string {
  cachedVersion ??= hashTemplate(
    renderEventMediaTemplate({
      eventId: CANONICAL_EVENT_ID,
      captionEngine: "transcribe",
      customCaptionApi: false,
    }),
  );
  return cachedVersion;
}

export async function handler(
  event: RenderRequest & { probeVersion?: boolean },
): Promise<{ template?: string; version: string }> {
  // 版だけ知りたい呼び出し (reconcile の版ズレ判定)。テンプレート本体は返さない。
  if (event.probeVersion) return { version: templateVersion() };
  const template = renderEventMediaTemplate({
    eventId: event.eventId,
    captionEngine: event.captionEngine,
    customCaptionApi: event.customCaptionApi,
    ...(event.rtmpUrl ? { rtmpUrl: event.rtmpUrl } : {}),
    ...(event.streamKeyRef ? { streamKeyRef: event.streamKeyRef } : {}),
    ...(event.desiredCount !== undefined ? { desiredCount: event.desiredCount } : {}),
    ...(event.captionDesiredCount !== undefined
      ? { captionDesiredCount: event.captionDesiredCount }
      : {}),
  });
  return { template, version: templateVersion() };
}
