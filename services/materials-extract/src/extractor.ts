/**
 * 形式ごとの抽出を束ねる TextExtractor (ADR 0021 D-2)。
 *
 * 対応しない形式は null を返し、エラーにしない。対応外の資料が 1 つ混ざっていても
 * 他の資料の抽出は続ける。
 */
import type { MaterialPage } from "@stagecast/shared";
import { extractPdfPages } from "./extract-pdf.js";
import { extractPptxPages } from "./extract-pptx.js";
import type { TextExtractor } from "./types.js";

function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i < 0 ? "" : filename.slice(i + 1).toLowerCase();
}

/** md / txt はそのまま 1 ページとして扱う。 */
function extractPlainText(body: Uint8Array): MaterialPage[] {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(body);
  return [{ text }];
}

export function createExtractor(): TextExtractor {
  return {
    async extract(filename: string, body: Uint8Array): Promise<MaterialPage[] | null> {
      switch (extensionOf(filename)) {
        case "pdf":
          return extractPdfPages(body);
        case "pptx":
          return extractPptxPages(body);
        case "md":
        case "markdown":
        case "txt":
        case "text":
          return extractPlainText(body);
        default:
          return null;
      }
    },
  };
}
