/**
 * 1 イベント分の翻訳参考資料を抽出し直す (ADR 0021 D-2)。
 *
 * 差分更新はしない。資料は多くて数個で、全部読み直しても 1 秒に満たない
 * (スパイク: 13 ページ PDF で 91ms)。差分を管理する複雑さに見合わない。
 */
import {
  createLogger,
  materialsContextKey,
  materialsPrefix,
  parseMaterialKey,
  type MaterialsContext,
} from "@stagecast/shared";
import { buildMaterialsContext, type ExtractedMaterial } from "./build-context.js";
import type { ObjectStore, TextExtractor } from "./types.js";

const log = createLogger({ component: "materials-extract" });

export interface RebuildDeps {
  store: ObjectStore;
  extractor: TextExtractor;
  now: () => Date;
}

/**
 * イベントの資料をすべて読み直して `_context.json` を書き換える。
 * 資料が 1 件も無くなっていれば `_context.json` を消す。
 */
export async function rebuildEventContext(
  eventId: string,
  deps: RebuildDeps,
): Promise<MaterialsContext | null> {
  const { store, extractor, now } = deps;
  const objects = await store.list(materialsPrefix(eventId));

  // キーの昇順で安定させる (assetId は生成順なので、おおむね登録順になる)。
  const materials = objects
    .map((o) => ({ object: o, parsed: parseMaterialKey(o.key) }))
    .filter(
      (x): x is { object: typeof x.object; parsed: NonNullable<typeof x.parsed> } =>
        x.parsed !== null,
    )
    .sort((a, b) => (a.object.key < b.object.key ? -1 : 1));

  const extracted: ExtractedMaterial[] = [];
  for (const { object, parsed } of materials) {
    try {
      const body = await store.get(object.key);
      const pages = await extractor.extract(parsed.filename, body);
      if (!pages) {
        log.info("unsupported material skipped", { eventId, filename: parsed.filename });
        continue;
      }
      extracted.push({ assetId: parsed.assetId, filename: parsed.filename, pages });
    } catch (err) {
      // 1 件の失敗で他の資料まで落とさない (翻訳の文脈は best-effort)。
      log.error("material extraction failed", { eventId, key: object.key, err });
    }
  }

  const contextKey = materialsContextKey(eventId);
  if (extracted.length === 0) {
    // 資料が無い状態で古い _context.json を残すと、消した資料の用語が効き続ける。
    await store.remove(contextKey);
    log.info("materials context removed", { eventId });
    return null;
  }

  const context = buildMaterialsContext(eventId, extracted, now());
  await store.put(
    contextKey,
    new TextEncoder().encode(JSON.stringify(context)),
    "application/json",
  );
  log.info("materials context updated", {
    eventId,
    materials: context.materials.length,
    chars: context.fullText.length,
  });
  return context;
}
