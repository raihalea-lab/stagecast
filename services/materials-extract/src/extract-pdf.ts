/**
 * PDF からページ別テキストを取り出す (ADR 0021 D-2)。
 *
 * **Node では legacy ビルドを使う。** 通常ビルド (`pdfjs-dist/build/pdf.mjs`) は
 * `hashOriginal.toHex is not a function` で読み込みに失敗する (pdf.js 自身が
 * 「Node では legacy を使え」と警告を出す)。スパイク結果は
 * `docs/decisions/0021-translation-reference-materials.md` 参照。
 *
 * canvas は使わない。`getTextContent` はラスタライズを伴わないので `@napi-rs/canvas`
 * (pdfjs-dist の optionalDependency) に依存しない。CMap も同梱しない
 * (ToUnicode を持つ埋め込みフォントなら不要。スパイクで有無が同結果と確認済み)。
 */
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import type { MaterialPage } from "@stagecast/shared";

/**
 * worker を main thread 側に載せる。
 *
 * pdf.js は worker を `await import(GlobalWorkerOptions.workerSrc)` で読む。既定値は
 * `"./pdf.worker.mjs"` という**相対パス**なので、esbuild で 1 ファイルに束ねた後は
 * 解決先が消えて `Setting up fake worker failed` になる (bundle 後にしか起きないので
 * `cdk synth` では気づけない)。
 *
 * `globalThis.pdfjsWorker` は pdf.js が最初に見るフックで、ここに置いてあれば動的 import を
 * せずにそれを使う。worker も静的 import してあるので esbuild が一緒に束ねてくれる
 * (= 追加ファイルの同梱が要らない)。
 */
(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

export async function extractPdfPages(body: Uint8Array): Promise<MaterialPage[]> {
  const loadingTask = getDocument({ data: body });
  const doc = await loadingTask.promise;
  try {
    const pages: MaterialPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => ("str" in item ? item.str : "")).join("");
        pages.push({ text });
      } finally {
        // ページごとに解放する。大きな PDF でメモリが積み上がるのを防ぐ。
        page.cleanup();
      }
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}
