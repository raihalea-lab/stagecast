/**
 * イベント設定から字幕パイプラインを組み立てるランタイム結線 (DESIGN.md 6 章, 8 章)。
 *
 * イベントの字幕設定 (エンジン経路・対応言語・YouTube 送出言語・独自 API 有効化) を受け取り、
 * 適切なエンジンと出力先 (Sink) を選んで CaptionPipeline を構築する。各アダプタは provider
 * として注入するため、本番は実 AWS 実装、テストはフェイクを渡せる。
 */
import type {
  CaptionEngine,
  CaptionEngineKind,
  CaptionSink,
  LanguageCode,
} from '@stagecast/shared';
import { InProcessCaptionBus } from './bus.js';
import { CaptionPipeline } from './pipeline.js';
import { TranscribeStreamingEngine } from './engines/transcribe-engine.js';
import { LLMEngine } from './engines/llm-engine.js';
import { SelfHostedAsrEngine } from './engines/self-hosted.js';
import type { AsrAdapter, LlmAdapter, Translator } from './engines/types.js';
import { YouTubeCaptionSink, type YouTubeCaptionPublisher } from './sinks/youtube-sink.js';
import { CustomCaptionApiSink, type CaptionBroadcaster } from './sinks/custom-api-sink.js';
import { CaptionStore, type ObjectStorage } from './store/caption-store.js';
import { CaptionConnectionHub, HubCaptionBroadcaster } from './sinks/caption-hub.js';
import type { AudioChunk } from '@stagecast/shared';

export interface CaptionRuntimeConfig {
  eventId: string;
  /** 話者音声のソース言語。 */
  sourceLanguage: LanguageCode;
  /** 対応言語 (翻訳先・独自 API 配信対象)。 */
  languages: LanguageCode[];
  engine: CaptionEngineKind;
  /** YouTube 字幕トラックへ送出する 1 言語 (未指定なら YouTube Sink 無し)。 */
  youtubeLanguage?: LanguageCode;
  /** 独自字幕配信 API を有効化するか。 */
  customApiEnabled: boolean;
}

export interface CaptionRuntimeProviders {
  asr?: AsrAdapter;
  translator?: Translator;
  llm?: LlmAdapter;
  youtubePublisher?: YouTubeCaptionPublisher;
  broadcaster?: CaptionBroadcaster;
  storage?: ObjectStorage;
  selfHostedEndpoint?: string;
}

/** 設定とプロバイダからエンジンを選択する (F-8, 6.2)。 */
export function selectEngine(
  config: CaptionRuntimeConfig,
  providers: CaptionRuntimeProviders,
): CaptionEngine {
  const common = {
    sourceLanguage: config.sourceLanguage,
    targetLanguages: config.languages,
    eventId: config.eventId,
  };
  switch (config.engine) {
    case 'transcribe':
      if (!providers.asr || !providers.translator) {
        throw new Error('transcribe engine requires asr + translator providers');
      }
      return new TranscribeStreamingEngine(providers.asr, providers.translator, common);
    case 'llm':
      if (!providers.llm) throw new Error('llm engine requires an llm provider');
      return new LLMEngine(providers.llm, { ...common, mode: 'asr+translate' });
    case 'self-hosted-asr':
      return new SelfHostedAsrEngine({
        ...common,
        modelEndpoint: providers.selfHostedEndpoint ?? '',
      });
  }
}

/** 設定とプロバイダから出力先 (Sink) を選択する (6.3)。 */
export function selectSinks(
  config: CaptionRuntimeConfig,
  providers: CaptionRuntimeProviders,
): CaptionSink[] {
  const sinks: CaptionSink[] = [];
  if (config.youtubeLanguage && providers.youtubePublisher) {
    sinks.push(new YouTubeCaptionSink(providers.youtubePublisher, config.youtubeLanguage));
  }
  if (config.customApiEnabled && providers.broadcaster) {
    sinks.push(
      new CustomCaptionApiSink(providers.broadcaster, {
        languages: config.languages,
        eventId: config.eventId,
      }),
    );
  }
  return sinks;
}

/** イベント設定から CaptionPipeline を組み立てる。 */
export function assembleCaptionPipeline(
  config: CaptionRuntimeConfig,
  providers: CaptionRuntimeProviders,
): CaptionPipeline {
  const engine = selectEngine(config, providers);
  const sinks = selectSinks(config, providers);
  const store = providers.storage
    ? new CaptionStore(providers.storage, { eventId: config.eventId })
    : undefined;
  return new CaptionPipeline({ bus: new InProcessCaptionBus(), engine, sinks, store });
}

/**
 * 字幕ワーカー (DESIGN.md 3.3, 7.1)。EventMediaStack の字幕ワーカータスクに相当する。
 *
 * 独自字幕配信 API が有効なら CaptionConnectionHub を用意し、その HubCaptionBroadcaster を
 * 出力先に注入してパイプラインと接続する。これにより 音声→エンジン→バス→Sink→ハブ→
 * WebSocket クライアント が一気通貫で繋がる。WebSocket サーバ (ws-server) はこの hub を載せる。
 */
export interface CaptionWorker {
  /** 独自字幕配信 API のハブ (有効時のみ)。WebSocketCaptionServer に渡す。 */
  readonly hub?: CaptionConnectionHub;
  readonly pipeline: CaptionPipeline;
  start(): Promise<void>;
  pushAudio(chunk: AudioChunk): Promise<void>;
  stop(): Promise<string[]>;
}

export function createCaptionWorker(
  config: CaptionRuntimeConfig,
  providers: CaptionRuntimeProviders,
  opts: { hub?: CaptionConnectionHub } = {},
): CaptionWorker {
  const hub = config.customApiEnabled
    ? (opts.hub ?? new CaptionConnectionHub({ supportedLanguages: config.languages }))
    : undefined;
  // ハブがあればそれを broadcaster に。無ければ与えられた broadcaster を使う。
  const broadcaster: CaptionBroadcaster | undefined = hub
    ? new HubCaptionBroadcaster(hub)
    : providers.broadcaster;
  const pipeline = assembleCaptionPipeline(config, { ...providers, broadcaster });

  return {
    hub,
    pipeline,
    start: () => pipeline.start(),
    pushAudio: (chunk) => pipeline.pushAudio(chunk),
    stop: () => pipeline.stop(),
  };
}
