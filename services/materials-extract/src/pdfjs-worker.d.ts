/**
 * pdf.js の worker ビルドには型定義が無い。中身は使わず globalThis に載せるだけなので
 * (extract-pdf.ts 参照)、モジュールの存在だけ宣言する。
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
