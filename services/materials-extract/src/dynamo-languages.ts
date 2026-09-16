/** イベントの字幕言語設定を DynamoDB から引く (ADR 0021 D-3)。 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { LanguageCode } from "@stagecast/shared";
import type { CaptionLanguages, EventLanguageLookup } from "./types.js";

export class DynamoEventLanguageLookup implements EventLanguageLookup {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async get(eventId: string): Promise<CaptionLanguages | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { pk: `EVENT#${eventId}`, sk: "META" } }),
    );
    const caption = res.Item?.caption as
      | { sourceLanguage?: LanguageCode; languages?: LanguageCode[] }
      | undefined;
    if (!caption?.languages?.length) return undefined;
    // sourceLanguage は省略可 (既定 ja)。CaptionSettings と同じ扱いにする。
    const source = caption.sourceLanguage ?? ("ja" as LanguageCode);
    return { source, targets: caption.languages.filter((l) => l !== source) };
  }
}
