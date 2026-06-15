/**
 * Amazon Translate 実装の Translator (DESIGN.md 6.2 常用・低遅延経路)。
 *
 * Transcribe Streaming で得たソース言語テキストを各言語へ翻訳する。AWS SDK v3 の
 * TranslateClient を注入する (テストでは fake client を渡し外部接続なしに検証)。
 */
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";
import type { LanguageCode } from "@stagecast/shared";
import type { Translator } from "../engines/types.js";
import { tagAwsRetryable } from "./aws-errors.js";

export class AmazonTranslateTranslator implements Translator {
  constructor(private readonly client: TranslateClient = new TranslateClient({})) {}

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    if (source === target) return text;
    try {
      const res = await this.client.send(
        new TranslateTextCommand({
          Text: text,
          SourceLanguageCode: source,
          TargetLanguageCode: target,
        }),
      );
      return res.TranslatedText ?? text;
    } catch (err) {
      // 恒久エラー (非対応言語ペア等) を withRetry が即断念できるよう retryable を付ける (ADR 0007)。
      throw tagAwsRetryable(err);
    }
  }
}
