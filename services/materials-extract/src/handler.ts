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
import { createExtractor } from "./extractor.js";
import { rebuildEventContext, type RebuildDeps } from "./rebuild.js";
import { S3ObjectStore } from "./s3-store.js";

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

let cachedDeps: RebuildDeps | undefined;

function defaultDeps(): RebuildDeps {
  if (!cachedDeps) {
    const bucket = process.env.ASSETS_BUCKET;
    if (!bucket) throw new Error("ASSETS_BUCKET is not set");
    cachedDeps = {
      store: new S3ObjectStore(bucket),
      extractor: createExtractor(),
      now: () => new Date(),
    };
  }
  return cachedDeps;
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
  await handleS3Event(event, defaultDeps());
}
