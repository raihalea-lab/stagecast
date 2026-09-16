/**
 * 抽出結果から MaterialsContext を組み立てる純粋ロジック (ADR 0021 D-2)。
 * 外部依存を持たないのでユニットテストで閉じる。
 */
import {
  MATERIAL_CHAR_LIMIT,
  MATERIALS_CONTEXT_CHAR_LIMIT,
  type MaterialEntry,
  type MaterialPage,
  type MaterialsContext,
} from "@stagecast/shared";

/** 抽出直後の 1 資料。ページは未トリム。 */
export interface ExtractedMaterial {
  assetId: string;
  filename: string;
  pages: MaterialPage[];
}

/** 連続する空白を 1 つに潰す。PDF の抽出はレイアウト由来の空白が多く、そのままだと嵩む。 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * ページ配列を合計 limit 文字に収める。ページ境界は保ったまま、超えたページは
 * 途中で切り、以降のページは落とす (先頭ほど概要が載っていることが多いため)。
 */
function capPages(pages: MaterialPage[], limit: number): MaterialPage[] {
  const out: MaterialPage[] = [];
  let used = 0;
  for (const page of pages) {
    if (used >= limit) break;
    const text = normalizeText(page.text);
    if (!text) {
      out.push({ text: "" });
      continue;
    }
    const room = limit - used;
    const clipped = text.length <= room ? text : text.slice(0, room);
    out.push({ text: clipped });
    used += clipped.length;
  }
  return out;
}

function entryText(entry: MaterialEntry): string {
  // ファイル名を見出しに付ける。複数資料があるとき、どの資料の記述かを翻訳側が区別できる。
  const body = entry.pages
    .map((p, i) => (p.text ? `[p${i + 1}] ${p.text}` : ""))
    .filter(Boolean)
    .join("\n");
  return body ? `## ${entry.filename}\n${body}` : "";
}

/**
 * 抽出結果を MaterialsContext にまとめる。
 *
 * 資料ごとに MATERIAL_CHAR_LIMIT、全体で MATERIALS_CONTEXT_CHAR_LIMIT まで。
 * 資料の順序は呼び出し側 (キーの昇順) に従う。
 */
export function buildMaterialsContext(
  eventId: string,
  extracted: ExtractedMaterial[],
  updatedAt: Date,
): MaterialsContext {
  const materials: MaterialEntry[] = [];
  const texts: string[] = [];
  let total = 0;

  for (const item of extracted) {
    const pages = capPages(item.pages, MATERIAL_CHAR_LIMIT);
    const entry: MaterialEntry = {
      assetId: item.assetId,
      filename: item.filename,
      pages,
    };
    const text = entryText(entry);
    if (!text) {
      // 本文が取れなかった資料 (画像だけの PDF 等) も、存在は残して一覧に出せるようにする。
      materials.push(entry);
      continue;
    }
    if (total + text.length > MATERIALS_CONTEXT_CHAR_LIMIT) {
      // 全体上限を超えたらこの資料以降は載せない。中途半端に切ると文が壊れるため。
      break;
    }
    materials.push(entry);
    texts.push(text);
    total += text.length;
  }

  return {
    version: 1,
    eventId,
    updatedAt: updatedAt.toISOString(),
    materials,
    fullText: texts.join("\n\n"),
  };
}
