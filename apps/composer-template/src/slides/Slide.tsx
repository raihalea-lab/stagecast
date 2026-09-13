/**
 * Slide - 事前アップロードスライド (PDF) を pdf.js でブラウザ内描画する (F-3, DESIGN.md 5.2)。
 *
 * サーバー側レンダリングは行わない (ADR 0012: composer-template は Egress の Chrome 上で
 * 動く React app)。pdf.js で署名付き GET URL から PDF を取得し、指定ページを canvas に描画する。
 * 総ページ数は pdf.js が返す (stage-web のハードコード `totalPages: 1` を置き換える)。
 */
import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  url: string;
  page: number;
  onTotalPages?: (total: number) => void;
}

export function Slide({ url, page, onTotalPages }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setDoc(null);
    const loadingTask = getDocument({ url });
    loadingTask.promise
      .then((d) => {
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        setDoc(d);
        onTotalPages?.(d.numPages);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    const clamped = Math.min(doc.numPages, Math.max(1, page));
    doc.getPage(clamped).then((pdfPage) => {
      if (cancelled || !canvasRef.current) return;
      const canvas = canvasRef.current;
      const viewport = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(
        canvas.clientWidth / viewport.width,
        canvas.clientHeight / viewport.height,
      );
      const scaled = pdfPage.getViewport({ scale });
      canvas.width = scaled.width;
      canvas.height = scaled.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      pdfPage.render({ canvas, canvasContext: ctx, viewport: scaled }).promise.catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  if (error) {
    return (
      <div className="slide-error">
        <span>スライドを読み込めませんでした: {error}</span>
      </div>
    );
  }

  return <canvas ref={canvasRef} className="slide-canvas" />;
}
