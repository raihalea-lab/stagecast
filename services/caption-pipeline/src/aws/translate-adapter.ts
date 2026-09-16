/**
 * Amazon Translate 実装の Translator (DESIGN.md 6.2 常用・低遅延経路)。
 *
 * Transcribe Streaming で得たソース言語テキストを各言語へ翻訳する。AWS SDK v3 の
 * TranslateClient を注入する (テストでは fake client を渡し外部接続なしに検証)。
 */
import { TranslateClient, TranslateTextCommand } from "@aws-sdk/client-translate";
import { terminologyName, type LanguageCode } from "@stagecast/shared";
import type { Translator } from "../engines/types.js";
import { tagAwsRetryable } from "./aws-errors.js";

/** 用語集がまだ登録されていないときに Translate が返す例外名。 */
function isMissingTerminology(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === "ResourceNotFoundException";
}

export class AmazonTranslateTranslator implements Translator {
  constructor(
    private readonly client: TranslateClient = new TranslateClient({}),
    /**
     * 登壇資料から用語集を生成したイベントの ID (ADR 0021 D-3)。指定すると固有名詞・
     * 技術用語の訳語が揃う。Amazon Translate は文脈を渡せないので、低遅延経路で資料を
     * 効かせる手段はこれだけ。資料が無いイベントでは undefined。
     */
    private readonly glossaryEventId?: string,
  ) {}

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    if (source === target) return text;
    const name = this.glossaryEventId ? terminologyName(this.glossaryEventId, target) : undefined;
    try {
      return await this.send(text, source, target, name);
    } catch (err) {
      // 抽出 Lambda は `_context.json` を書いた後に用語集を登録する。その隙に起動すると
      // 用語集がまだ無く、その言語の翻訳が全滅する。用語集なしで 1 回だけやり直す。
      if (name && isMissingTerminology(err)) {
        return await this.send(text, source, target, undefined).catch((e) => {
          throw tagAwsRetryable(e);
        });
      }
      // 恒久エラー (非対応言語ペア等) を withRetry が即断念できるよう retryable を付ける (ADR 0007)。
      throw tagAwsRetryable(err);
    }
  }

  private async send(
    text: string,
    source: LanguageCode,
    target: LanguageCode,
    name: string | undefined,
  ): Promise<string> {
    const res = await this.client.send(
      new TranslateTextCommand({
        Text: text,
        SourceLanguageCode: source,
        TargetLanguageCode: target,
        ...(name ? { TerminologyNames: [name] } : {}),
      }),
    );
    return res.TranslatedText ?? text;
  }
}
