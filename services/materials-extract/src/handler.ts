/**
 * 翻訳参考資料の抽出 Lambda (ADR 0021 D-2)。
 *
 * AssetsBucket の `assets/materials/` prefix に S3 イベント通知で起動し、
 * 変化があったイベントの `_context.json` を作り直す。
 *
 * 自分が書いた `_context.json` の PUT でも起動するので、`parseMaterialKey` が
 * null を返すキー (= 資料本体でないもの) は必ず無視する。これを外すと無限ループになる。
 */
import type { S3Event } from "aws-lambda";
import { createLogger, parseMaterialKey } from "@stagecast/shared";
import { BedrockGlossaryGenerator, TranslateTerminologyStore } from "./aws-glossary.js";
import { DynamoEventLanguageLookup } from "./dynamo-languages.js";
import { createExtractor } from "./extractor.js";
import { rebuildEventContext, type RebuildDeps } from "./rebuild.js";
import { S3ObjectStore } from "./s3-store.js";
import type { EventLanguageLookup } from "./types.js";

const log = createLogger({ component: "materials-extract" });

/** S3 のオブジェクトキーは URL エンコードされて届く (スペースが `+` になる)。 */
function decodeKey(key: string): string {
  return decodeURIComponent(key.replace(/\+/g, " "));
}

/** イベント内の重複を潰して、作り直すべき eventId を返す。 */
export function eventIdsToRebuild(event: S3Event): string[] {
  const ids = new Set<string>();
  for (const record of event.Records) {
    const key = decodeKey(record.s3?.object?.key ?? "");
    const parsed = parseMaterialKey(key);
    if (parsed) ids.add(parsed.eventId);
  }
  return [...ids];
}

interface DefaultDeps {
  base: Omit<RebuildDeps, "glossary">;
  /** 用語集の生成に必要な依存。テーブル名やモデル ID が無い環境では undefined。 */
  glossary?: Omit<NonNullable<RebuildDeps["glossary"]>, "languages">;
  languages?: EventLanguageLookup;
}

let cached: DefaultDeps | undefined;

function defaultDeps(): DefaultDeps {
  if (!cached) {
    const bucket = process.env.ASSETS_BUCKET;
    if (!bucket) throw new Error("ASSETS_BUCKET is not set");
    const table = process.env.EVENTS_TABLE;
    const modelId = process.env.BEDROCK_MODEL_ID;
    cached = {
      base: {
        store: new S3ObjectStore(bucket),
        extractor: createExtractor(),
        now: () => new Date(),
      },
      // 用語集は低遅延経路向けの補助。設定が無ければ作らずに抽出だけ続ける。
      ...(table && modelId
        ? {
            glossary: {
              generator: new BedrockGlossaryGenerator(modelId),
              terminology: new TranslateTerminologyStore(),
            },
            languages: new DynamoEventLanguageLookup(table),
          }
        : {}),
    };
  }
  return cached;
}

export async function handleS3Event(event: S3Event, deps: RebuildDeps): Promise<void> {
  const eventIds = eventIdsToRebuild(event);
  if (eventIds.length === 0) {
    // `_context.json` 自身の PUT 等。ここで止めないと無限ループになる。
    return;
  }
  for (const eventId of eventIds) {
    try {
      await rebuildEventContext(eventId, deps);
    } catch (err) {
      // 1 イベントの失敗で他のイベントの作り直しまで諦めない。
      log.error("rebuild failed", { eventId, err });
    }
  }
}

export async function handler(event: S3Event): Promise<void> {
  const deps = defaultDeps();
  const eventIds = eventIdsToRebuild(event);
  for (const eventId of eventIds) {
    // 用語集の言語ペアはイベントごとに違うので、ここで引いてから rebuild に渡す。
    // 引けなくても抽出は続ける (品質重視経路の文脈は言語設定に依らない)。
    const languages = await deps.languages?.get(eventId).catch(() => undefined);
    await handleS3Event(
      { Records: event.Records.filter((r) => matchesEvent(r, eventId)) } as S3Event,
      {
        ...deps.base,
        ...(deps.glossary && languages ? { glossary: { ...deps.glossary, languages } } : {}),
      },
    );
  }
}

/** そのレコードが対象イベントのものか。 */
function matchesEvent(record: S3Event["Records"][number], eventId: string): boolean {
  const parsed = parseMaterialKey(decodeKey(record.s3?.object?.key ?? ""));
  return parsed?.eventId === eventId;
}
