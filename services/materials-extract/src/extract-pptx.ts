/**
 * PPTX からスライド別テキストを取り出す (ADR 0021 D-2)。
 *
 * PPTX は ZIP で、スライド 1 枚が `ppt/slides/slide{N}.xml`。本文は `<a:t>` 要素に入る。
 * XML パーサは使わない: 取り出したいのがテキストノードだけで、`<a:t>` の抽出に構造解析が
 * 要らないため。
 */
import type { MaterialPage } from "@stagecast/shared";
import { readZipEntries } from "./zip.js";

const SLIDE_PATTERN = /^ppt\/slides\/slide(\d+)\.xml$/;
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

export function extractPptxPages(body: Uint8Array): MaterialPage[] {
  const slides: { index: number; text: string }[] = [];

  for (const entry of readZipEntries(body)) {
    const match = SLIDE_PATTERN.exec(entry.name);
    if (!match?.[1]) continue;
    let xml: string;
    try {
      xml = new TextDecoder("utf-8", { fatal: false }).decode(entry.read());
    } catch {
      // 壊れたエントリはそのスライドだけ飛ばす。
      continue;
    }
    const parts: string[] = [];
    for (const m of xml.matchAll(TEXT_NODE)) {
      if (m[1]) parts.push(unescapeXml(m[1]));
    }
    slides.push({ index: Number(match[1]), text: parts.join(" ") });
  }

  // ZIP の格納順はスライド順とは限らないので番号で並べ直す。
  slides.sort((a, b) => a.index - b.index);
  return slides.map((s) => ({ text: s.text }));
}
