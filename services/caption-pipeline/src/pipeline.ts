/**
 * 字幕パイプラインの配線 (DESIGN.md 6 章)。
 *
 * エンジン → 字幕バス → 出力先(Sink) / 保存 を結線する。エンジンも Sink も共通
 * インターフェース越しにのみ接続するため、自由に差し替え・追加できる (F-8)。
 *
 *   engine.onCaption → bus.publish → bus.subscribe → 各 Sink.deliver / CaptionStore.ingest
 */
import {
  createLogger,
  withRetry,
  withTimeout,
  type AudioChunk,
  type CaptionBus,
  type CaptionEngine,
  type CaptionSink,
  type RetryOptions,
} from "@stagecast/shared";
import type { CaptionStore } from "./store/caption-store.js";
import type { CaptionMetricsCollector } from "./metrics.js";

const log = createLogger({ component: "caption-pipeline" });

export interface CaptionPipelineDeps {
  bus: CaptionBus;
  engine: CaptionEngine;
  sinks: CaptionSink[];
  store?: CaptionStore;
  /** CloudWatch メトリクス送信 (T9, ADR 0003)。省略時は計測なし。 */
  metrics?: CaptionMetricsCollector;
  /**
   * Sink 配信の一過性失敗に対するリトライ設定 (省略時は既定の指数バックオフ)。
   * 全リトライ失敗後も字幕は best-effort としてパイプラインは止めない (DESIGN.md 6, N-2)。
   */
  sinkRetry?: RetryOptions;
  /**
   * 1 回の Sink 配信に対するタイムアウト (ms, 既定 10000)。応答しない Sink が
   * drain() を止めて音声取り込み全体をハングさせるのを防ぐ。0 以下で無効。
   */
  sinkTimeoutMs?: number;
}

/** Sink 配信のタイムアウト既定値。YouTube ingest 等の固まりからパイプラインを守る (N-2)。 */
const DEFAULT_SINK_TIMEOUT_MS = 10_000;

export class CaptionPipeline {
  private pending: Promise<unknown>[] = [];
  private unsubscribe?: () => void;

  constructor(private readonly deps: CaptionPipelineDeps) {}

  async start(): Promise<void> {
    const { bus, engine, sinks, store, metrics } = this.deps;
    await engine.start();
    // エンジンの字幕をバスへ。
    engine.onCaption((caption) => bus.publish(caption));
    // バスを購読し、各 Sink と保存へ配る。配信は非同期なので drain で待ち合わせる。
    this.unsubscribe = bus.subscribe((caption) => {
      metrics?.observeCaption(caption);
      store?.ingest(caption);
      for (const sink of sinks) {
        // 一過性失敗はバックオフ再試行。再試行は計測し、全滅したら計測+ログのみで握る
        // (字幕は best-effort)。caller の onRetry も保持する。
        const retryOpts: RetryOptions = {
          ...this.deps.sinkRetry,
          onRetry: (err, attempt, delayMs) => {
            metrics?.observeSinkRetry(sink.kind);
            this.deps.sinkRetry?.onRetry?.(err, attempt, delayMs);
          },
        };
        // 各試行にタイムアウトを掛ける。固まった配信は TimeoutError になり、リトライ対象になる。
        const timeoutMs = this.deps.sinkTimeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
        const p = withRetry(
          () =>
            withTimeout(() => sink.deliver(caption), {
              timeoutMs,
              message: `sink ${sink.kind} delivery timed out`,
            }),
          retryOpts,
        ).catch((err) => {
          metrics?.observeSinkError(sink.kind);
          log.error("sink delivery failed after retries", { sink: sink.kind, err });
        });
        this.pending.push(p);
      }
    });
    for (const sink of sinks) await sink.start();
  }

  /** 音声を投入し、生成された字幕が全 Sink に配信されるまで待つ。 */
  async pushAudio(chunk: AudioChunk): Promise<void> {
    await this.deps.engine.pushAudio(chunk);
    await this.drain();
  }

  /** 配信中の非同期処理を待ち合わせる。 */
  async drain(): Promise<void> {
    const inflight = this.pending;
    this.pending = [];
    await Promise.all(inflight);
  }

  /** 停止し、保存があれば S3 へ書き出す。書き出したキー一覧を返す。 */
  async stop(): Promise<string[]> {
    await this.drain();
    await this.deps.engine.stop();
    for (const sink of this.deps.sinks) await sink.stop();
    this.unsubscribe?.();
    return this.deps.store ? this.deps.store.flushToStorage() : [];
  }
}
