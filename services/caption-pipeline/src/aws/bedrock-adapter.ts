/**
 * Amazon Bedrock 実装の LlmAdapter (DESIGN.md 6.2 品質重視経路)。
 *
 * 文脈を考慮した高品質翻訳を行う。ASR(音声→テキスト)は Bedrock では行わず、本アダプタは
 * 翻訳に特化する (transcribe は未提供 = LLMEngine の translate-only / 既存 ASR と組み合わせ)。
 * AWS SDK v3 の BedrockRuntimeClient を注入する。
 */
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { LanguageCode } from "@stagecast/shared";
import type { LlmAdapter } from "../engines/types.js";
import { tagAwsRetryable } from "./aws-errors.js";

const LANGUAGE_NAMES: Record<LanguageCode, string> = { ja: "Japanese", en: "English" };

export interface BedrockAdapterConfig {
  /** モデル ID (例: us.anthropic.claude-sonnet-4-5-...)。 */
  modelId: string;
  maxTokens?: number;
}

export class BedrockLlmAdapter implements LlmAdapter {
  constructor(
    private readonly config: BedrockAdapterConfig,
    private readonly client: BedrockRuntimeClient = new BedrockRuntimeClient({}),
  ) {}

  /** プロンプトを構築する (字幕用途: 余計な説明を付けず訳文のみ返させる)。 */
  buildPrompt(text: string, source: LanguageCode, target: LanguageCode): string {
    return (
      `Translate the following live-caption text from ${LANGUAGE_NAMES[source]} to ` +
      `${LANGUAGE_NAMES[target]}. Output only the translation, no explanations.\n\n${text}`
    );
  }

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    if (source === target) return text;
    let res;
    try {
      res = await this.client.send(
        new InvokeModelCommand({
          modelId: this.config.modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: this.config.maxTokens ?? 512,
            messages: [{ role: "user", content: this.buildPrompt(text, source, target) }],
          }),
        }),
      );
    } catch (err) {
      // 恒久エラー (アクセス拒否・バリデーション等) を withRetry が即断念できるように (ADR 0007)。
      throw tagAwsRetryable(err);
    }
    const decoded = JSON.parse(new TextDecoder().decode(res.body)) as {
      content?: { text?: string }[];
    };
    return decoded.content?.[0]?.text?.trim() ?? text;
  }
}
