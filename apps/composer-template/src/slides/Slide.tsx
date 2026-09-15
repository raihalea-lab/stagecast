/**
 * Slide - 事前アップロードスライド (PDF) を pdf.js でブラウザ内描画する (F-3, DESIGN.md 5.2)。
 *
 * サーバー側レンダリングは行わない (ADR 0012: composer-template は Egress の Chrome 上で
 * 動く React app)。pdf.js で署名付き GET URL から PDF を取得し、指定ページを canvas に描画する。
 *
 * 総ページ数は stage-web 側がアップロード時に解決して StageController に入れる。
 * composer が接続するのは subscribe 専用の token (preview-token.ts は canPublishData: false、
 * Egress は recorder token) なので、composer から DataChannel で返送する経路は使えない。
 * ここでは受信ページを doc.numPages でクランプするだけ。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  url: string;
  page: number;
}

interface CanvasSize {
  width: number;
  height: number;
}

export function Slide({ url, page }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | undefined>();
  // 描画倍率は canvas のレイアウトサイズ基準。tile の有無で .slide-main の幅が
  // 100% ↔ 75% に変わるため、ResizeObserver で追従して再描画する。
  const [size, setSize] = useState<CanvasSize>({ width: 0, height: 0 });

  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    canvasRef.current = el;
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    observerRef.current = observer;
    setSize({ width: el.clientWidth, height: el.clientHeight });
  }, []);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    setDoc(null);
    // disableRange/disableStream: 署名付き GET URL は 15 分で失効するので、遅延 range 取得に
    // しておくと後半ページの描画時に 403 になる。読み込み時に 1 回で全部取り切る。
    const loadingTask = getDocument({ url, disableRange: true, disableStream: true });
    loadingTask.promise
      .then((d) => {
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        setDoc(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [url]);

  useEffect(() => {
    if (!doc) return;
    // レイアウト確定前 (幅 0) は描画しない。ResizeObserver が実サイズを通知したら再実行される。
    if (size.width <= 0 || size.height <= 0) return;
    let cancelled = false;
    const clamped = Math.min(doc.numPages, Math.max(1, page));
    void doc.getPage(clamped).then((pdfPage) => {
      const canvas = canvasRef.current;
      if (cancelled || !canvas) return;
      const viewport = pdfPage.getViewport({ scale: 1 });
      const scale = Math.min(size.width / viewport.width, size.height / viewport.height);
      const scaled = pdfPage.getViewport({ scale });
      canvas.width = scaled.width;
      canvas.height = scaled.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      // 同じ canvas への二重 render は pdf.js が例外にする (#canvasInUse)。ページを速く
      // 送ったときに前ページのまま固まるので、走っている render は必ず cancel してから始める。
      renderTaskRef.current?.cancel();
      const task = pdfPage.render({ canvas, canvasContext: ctx, viewport: scaled });
      renderTaskRef.current = task;
      // cancel 時は RenderingCancelledException で reject するため握り潰す。
      task.promise
        .catch(() => {})
        .finally(() => {
          if (renderTaskRef.current === task) renderTaskRef.current = null;
        });
    });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
    };
  }, [doc, page, size.width, size.height]);

  if (error) {
    return (
      <div className="slide-error">
        <span>スライドを読み込めませんでした: {error}</span>
      </div>
    );
  }

  return <canvas ref={attachCanvas} className="slide-canvas" />;
}
