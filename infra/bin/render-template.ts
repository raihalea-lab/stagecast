#!/usr/bin/env node
/**
 * イベント単位メディアスタックの CloudFormation テンプレートを標準出力に書き出す CLI。
 *
 * 使い方:
 *   STAGECAST_EVENT_ID=evt-1 CAPTION_ENGINE=transcribe CUSTOM_CAPTION_API=false \
 *     npx ts-node bin/render-template.ts > /tmp/evt-1.template.json
 *
 * media-orchestrator はこの出力 (または renderEventMediaTemplate の直接呼び出し) を
 * CloudFormationMediaStackProvisioner.renderTemplate に供給する。
 */
import { renderEventMediaTemplate } from "../lib/render-template";
import type { CaptionEngineKind } from "@stagecast/shared";

const eventId = process.env.STAGECAST_EVENT_ID;
if (!eventId) {
  process.stderr.write("STAGECAST_EVENT_ID is required\n");
  process.exit(1);
}

const template = renderEventMediaTemplate({
  eventId,
  captionEngine: (process.env.CAPTION_ENGINE as CaptionEngineKind) ?? "transcribe",
  customCaptionApi: process.env.CUSTOM_CAPTION_API === "true",
});

process.stdout.write(template);
