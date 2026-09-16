/**
 * 翻訳参考資料 (ADR 0021)。
 *
 * イベントに紐づく登壇資料 (PDF・PPTX・原稿) からテキストを抽出し、字幕翻訳の文脈として使う。
 * 投影するデッキとは別概念で、投影しない資料 (発表原稿・話者ノート) も対象になる。
 *
 * S3 のレイアウト:
 *   assets/materials/{eventId}/{assetId}/{filename}   ← 資料の実体
 *   assets/materials/{eventId}/_context.json          ← 抽出結果 (MaterialsContext)
 */
import type { LanguageCode } from "./caption.js";

/** 資料 1 ページ分の抽出テキスト。PDF 以外 (md 等) は 1 ページに収める。 */
export interface MaterialPage {
  text: string;
}

/** 資料 1 件の抽出結果。 */
export interface MaterialEntry {
  assetId: string;
  filename: string;
  pages: MaterialPage[];
}

/** 1 イベント分の抽出結果。字幕ワーカーはこれを読んで翻訳の文脈に使う。 */
export interface MaterialsContext {
  /** 形式のバージョン。読み手は未知の version を無視する。 */
  version: 1;
  eventId: string;
  /** 生成時刻 (ISO 8601)。 */
  updatedAt: string;
  materials: MaterialEntry[];
  /** 全資料を連結した本文。翻訳プロンプトの固定プレフィックスに使う。 */
  fullText: string;
}

/** 資料 1 件あたりの文字数上限。これを超える分は捨てる (ADR 0021 D-2)。 */
export const MATERIAL_CHAR_LIMIT = 30_000;

/** 1 イベントの合計文字数上限。プロンプト長を抑える (ADR 0021 D-2)。 */
export const MATERIALS_CONTEXT_CHAR_LIMIT = 60_000;

/** 資料の S3 prefix。 */
export const MATERIALS_PREFIX = "assets/materials/";

/** 抽出結果のファイル名。資料本体と同じ prefix に置くので、走査時は必ず除外する。 */
export const MATERIALS_CONTEXT_FILENAME = "_context.json";

/** イベントの資料 prefix (`assets/materials/{eventId}/`)。 */
export function materialsPrefix(eventId: string): string {
  return `${MATERIALS_PREFIX}${eventId}/`;
}

/** イベントの抽出結果のキー。 */
export function materialsContextKey(eventId: string): string {
  return `${materialsPrefix(eventId)}${MATERIALS_CONTEXT_FILENAME}`;
}

/** 資料本体のキー。 */
export function materialKey(eventId: string, assetId: string, filename: string): string {
  return `${materialsPrefix(eventId)}${assetId}/${filename}`;
}

/**
 * 資料本体のキーを分解する。`_context.json` や prefix 外のキーは null を返す。
 *
 * 抽出 Lambda は自分が書いた `_context.json` の PUT でも起動するので、ここで弾かないと
 * 無限ループになる。
 */
export function parseMaterialKey(
  key: string,
): { eventId: string; assetId: string; filename: string } | null {
  if (!key.startsWith(MATERIALS_PREFIX)) return null;
  const rest = key.slice(MATERIALS_PREFIX.length);
  const parts = rest.split("/");
  // {eventId}/{assetId}/{filename} の 3 段ちょうど。`_context.json` は 2 段なので弾かれる。
  if (parts.length !== 3) return null;
  const [eventId, assetId, filename] = parts;
  if (!eventId || !assetId || !filename) return null;
  return { eventId, assetId, filename };
}

/**
 * Amazon Translate の用語集名 (ADR 0021 D-3)。
 *
 * Translate の CSV は **2 列 (source, target 1 つ)** しか受け付けないので、ターゲット
 * 言語ごとに用語集を分ける。抽出 Lambda が登録し、字幕ワーカーが引くので shared に置く。
 */
export function terminologyName(eventId: string, target: LanguageCode): string {
  // 用語集名に使えるのは英数と - _ のみ。
  return `stagecast-${eventId}-${target}`.replace(/[^\w-]/g, "-");
}
