/**
 * スパイク: pdfjs-dist の getTextContent が Node (canvas 無し) で動くか (ADR 0021 D-2)。
 * 日本語 (CID フォント) が正しく取れるかが焦点。
 *
 * 実行:
 *   node docs/spikes/pdf-text-extract.mjs \
 *     apps/composer-template/node_modules/pdfjs-dist/legacy/build/pdf.mjs \
 *     path/to/deck.pdf [cmap]
 *
 * 注意: Node では legacy ビルドを使うこと。通常ビルドは
 * `hashOriginal.toHex is not a function` で落ちる。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const PDFJS = process.argv[2];
const PDF = process.argv[3];
const useCMap = process.argv[4] === "cmap";

const pdfjs = await import(pathToFileURL(PDFJS).href);
const { getDocument } = pdfjs;

const cmapDir = path.join(path.dirname(path.dirname(PDFJS)), "cmaps") + path.sep;

const t0 = Date.now();
const data = new Uint8Array(readFileSync(PDF));
const opts = { data, isEvalSupported: false };
if (useCMap) {
  opts.cMapUrl = pathToFileURL(cmapDir).href;
  opts.cMapPacked = true;
}
const doc = await getDocument(opts).promise;
const tLoad = Date.now() - t0;

const pages = [];
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  const text = tc.items.map((it) => (it.str ?? "")).join("").replace(/\s+/g, " ").trim();
  pages.push(text);
  page.cleanup();
}
const tAll = Date.now() - t0;

const total = pages.reduce((n, p) => n + p.length, 0);
const mem = process.memoryUsage().rss / 1024 / 1024;

console.log(JSON.stringify({
  cmap: useCMap,
  numPages: doc.numPages,
  loadMs: tLoad,
  totalMs: tAll,
  totalChars: total,
  rssMB: Math.round(mem),
}, null, 2));
console.log("--- page 1 ---");
console.log(pages[0]?.slice(0, 180));
console.log("--- page 4 ---");
console.log(pages[3]?.slice(0, 180));

