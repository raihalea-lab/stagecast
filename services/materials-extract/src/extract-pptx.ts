/**
 * PPTX からスライド別テキストを取り出す (ADR 0021 D-2)。
 *
 * PPTX は ZIP で、スライド 1 枚が `ppt/slides/slide{N}.xml`。本文は `<a:t>` 要素に入る。
 * XML パーサは使わない: 取り出したいのがテキストノードだけで、`<a:t>` の抽出に構造解析が
 * 要らないため。
 *
 * 話者ノート (`ppt/notesSlides/notesSlide{N}.xml`) も同じ構造で、投影されない分だけ
 * 発表の意図が書かれていることが多い。ADR 0021 D-1 の「投影しない資料こそ文脈として
 * 価値が高い」に沿って、対応するスライドの本文に続けて取り込む。
 */
import type { MaterialPage } from "@stagecast/shared";
import { readZipEntries } from "./zip.js";

const SLIDE_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_PATTERN = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;
const TEXT_NODE = /<a:t>([\s\S]*?)<\/a:t>/g;

/** XML の実体参照を戻す。`<a:t>` に入りうるのはこの 5 つ。 */
function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** エントリの `<a:t>` を連結する。読めないエントリは空文字 (そのスライドだけ諦める)。 */
function textOf(read: () => Uint8Array): string {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: false }).decode(read());
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const m of xml.matchAll(TEXT_NODE)) {
    if (m[1]) parts.push(unescapeXml(m[1]));
  }
  return parts.join(" ");
}

export function extractPptxPages(body: Uint8Array): MaterialPage[] {
  const slides = new Map<number, string>();
  const notes = new Map<number, string>();

  for (const entry of readZipEntries(body)) {
    const slide = SLIDE_PATTERN.exec(entry.name);
    if (slide?.[1]) {
      slides.set(
        Number(slide[1]),
        textOf(() => entry.read()),
      );
      continue;
    }
    const note = NOTES_PATTERN.exec(entry.name);
    if (note?.[1]) {
      notes.set(
        Number(note[1]),
        textOf(() => entry.read()),
      );
    }
  }

  // ZIP の格納順はスライド順とは限らないので番号で並べ直す。
  return [...slides.keys()]
    .sort((a, b) => a - b)
    .map((index) => {
      const body = slides.get(index) ?? "";
      const note = notes.get(index);
      // ノートは本文と区別できる形で付ける (翻訳側が「話者の補足」と読めるように)。
      return { text: note ? `${body}\n(ノート) ${note}` : body };
    });
}
