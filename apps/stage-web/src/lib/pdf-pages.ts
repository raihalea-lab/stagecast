/**
 * アップロードするスライド PDF の総ページ数を解決する (F-3, DESIGN.md 5.2)。
 *
 * 総ページ数は「デッキを投入した stage-web」が決める。composer-template は subscribe 専用の
 * token で room に入る (preview-token.ts は canPublishData: false、Egress は recorder token) ため、
 * pdf.js が読んだ numPages を DataChannel で stage-web に返す経路が無い。
 *
 * pdf.js は数百 KB あるので、このモジュールは App から動的 import する
 * (デッキを使わないセッションではバンドルを読み込まない)。
 */
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

/** PDF の総ページ数を返す。読めない PDF は例外を投げる (アップロード前に弾くため)。 */
export async function resolvePdfPageCount(file: Blob): Promise<number> {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = getDocument({ data });
  try {
    const doc = await loadingTask.promise;
    return doc.numPages;
  } finally {
    // ページ数を取るだけなので worker ごと破棄する (デッキ投入のたびに増やさない)。
    void loadingTask.destroy();
  }
}
