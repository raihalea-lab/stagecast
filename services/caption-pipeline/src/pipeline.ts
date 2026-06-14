/**
 * 字幕パイプラインの配線 (DESIGN.md 6 章)。
 *
 * エンジン → 字幕バス → 出力先(Sink) / 保存 を結線する。エンジンも Sink も共通
 * インターフェース越しにのみ接続するため、自由に差し替え・追加できる (F-8)。
 *
 *   engine.onCaption → bus.publish → bus.subscribe → 各 Sink.deliver / CaptionStore.ingest
 */
import type { AudioChunk, CaptionBus, CaptionEngine, CaptionSink } from '@stagecast/shared';
import type { CaptionStore } from './store/caption-store.js';

export interface CaptionPipelineDeps {
  bus: CaptionBus;
  engine: CaptionEngine;
  sinks: CaptionSink[];
  store?: CaptionStore;
}

export class CaptionPipeline {
  private pending: Promise<unknown>[] = [];
  private unsubscribe?: () => void;

  constructor(private readonly deps: CaptionPipelineDeps) {}

  async start(): Promise<void> {
    const { bus, engine, sinks, store } = this.deps;
    await engine.start();
    // エンジンの字幕をバスへ。
    engine.onCaption((caption) => bus.publish(caption));
    // バスを購読し、各 Sink と保存へ配る。配信は非同期なので drain で待ち合わせる。
    this.unsubscribe = bus.subscribe((caption) => {
      store?.ingest(caption);
      for (const sink of sinks) this.pending.push(sink.deliver(caption));
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
