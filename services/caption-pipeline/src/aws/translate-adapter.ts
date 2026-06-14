/**
 * Amazon Translate 実装の Translator (DESIGN.md 6.2 常用・低遅延経路)。
 *
 * Transcribe Streaming で得たソース言語テキストを各言語へ翻訳する。AWS SDK v3 の
 * TranslateClient を注入する (テストでは fake client を渡し外部接続なしに検証)。
 */
import { TranslateClient, TranslateTextCommand } from '@aws-sdk/client-translate';
import type { LanguageCode } from '@stagecast/shared';
import type { Translator } from '../engines/types.js';

export class AmazonTranslateTranslator implements Translator {
  constructor(private readonly client: TranslateClient = new TranslateClient({})) {}

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    if (source === target) return text;
    const res = await this.client.send(
      new TranslateTextCommand({
        Text: text,
        SourceLanguageCode: source,
        TargetLanguageCode: target,
      }),
    );
    return res.TranslatedText ?? text;
  }
}
