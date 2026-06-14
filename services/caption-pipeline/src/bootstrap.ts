/**
 * 字幕ワーカーの起動 bootstrap (DESIGN.md 3.3, 7.1, ADR 0001/0003)。
 *
 * EventMediaStack の字幕ワーカータスクのエントリ。イベント設定とプロバイダから CaptionWorker を
 * 組み立て、独自字幕配信 API が有効なら WebSocket サーバを実ポートで起動する。音声入力は
 * AudioSource 抽象から供給する（本番は SFU/LiveKit から、テストはフェイクから）。
 *
 * 外部依存（Transcribe/Translate/Bedrock/S3/YouTube）は USE_FAKE_ADAPTERS で実/フェイクを
 * 切り替える。実ポート起動・グレースフルシャットダウンまでを担う。
 */
import type { AudioChunk, LanguageCode } from "@stagecast/shared";
import {
  createCaptionWorker,
  type CaptionRuntimeConfig,
  type CaptionRuntimeProviders,
} from "./runtime.js";
import { WebSocketCaptionServer } from "./sinks/ws-server.js";

/** 音声入力源 (DESIGN.md 6: 登壇者音声の分岐)。実体は SFU/LiveKit トラック。 */
export interface AudioSource {
  /** チャンク受信ハンドラを登録して取り込みを開始する。 */
  start(onChunk: (chunk: AudioChunk) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
}

/** テスト/ローカル用フェイク音声源。start で台本チャンクを順に流す。 */
export class FakeAudioSource implements AudioSource {
  constructor(private readonly chunks: AudioChunk[] = []) {}
  async start(onChunk: (chunk: AudioChunk) => Promise<void> | void): Promise<void> {
    for (const c of this.chunks) await onChunk(c);
  }
  async stop(): Promise<void> {
    /* no-op */
  }
}

export interface CaptionServiceConfig extends CaptionRuntimeConfig {
  /** 独自字幕配信 API の待受ポート (0 でエフェメラル)。customApiEnabled 時のみ使用。 */
  wsPort?: number;
}

/**
 * 字幕ワーカー + WebSocket サーバ + 音声入力を束ねるサービス。
 * start でワーカー・サーバを起動し、音声を pushAudio に流す。stop で逆順に停止する。
 */
export class CaptionService {
  private readonly worker: ReturnType<typeof createCaptionWorker>;
  private server?: WebSocketCaptionServer;

  constructor(
    private readonly config: CaptionServiceConfig,
    providers: CaptionRuntimeProviders,
    private readonly audioSource?: AudioSource,
  ) {
    this.worker = createCaptionWorker(config, providers);
  }

  /** 起動した WebSocket サーバの実ポート。 */
  get wsPort(): number | undefined {
    return this.server?.port;
  }

  async start(): Promise<void> {
    // 独自字幕 API: ハブがあれば WebSocket サーバを実ポートで起動する。
    if (this.worker.hub) {
      this.server = new WebSocketCaptionServer(this.worker.hub, {
        port: this.config.wsPort ?? 8080,
      });
      await this.server.start();
    }
    await this.worker.start();
    // 音声入力を pushAudio に接続 (バックグラウンドで取り込み)。
    if (this.audioSource) {
      void this.audioSource.start((chunk) => this.worker.pushAudio(chunk));
    }
  }

  /** 音声チャンクを直接投入する (AudioSource を使わない駆動・テスト用)。 */
  async pushAudio(chunk: AudioChunk): Promise<void> {
    await this.worker.pushAudio(chunk);
  }

  /** 停止する。確定字幕の S3 書き出しキー一覧を返す。 */
  async stop(): Promise<string[]> {
    await this.audioSource?.stop();
    const keys = await this.worker.stop();
    await this.server?.stop();
    return keys;
  }
}

// ---------------------------------------------------------------------------
// 環境変数からの起動 (実 AWS アダプタの選択)
// ---------------------------------------------------------------------------

function parseLanguages(value: string | undefined, fallback: LanguageCode[]): LanguageCode[] {
  if (!value) return fallback;
  return value.split(",").map((s) => s.trim()) as LanguageCode[];
}

/** 環境変数から CaptionServiceConfig を組み立てる。 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CaptionServiceConfig {
  const languages = parseLanguages(env.CAPTION_LANGUAGES, ["ja", "en"]);
  return {
    eventId: env.STAGECAST_EVENT_ID ?? "unknown",
    sourceLanguage: (env.CAPTION_SOURCE_LANGUAGE as LanguageCode) ?? "ja",
    languages,
    engine: (env.CAPTION_ENGINE as CaptionServiceConfig["engine"]) ?? "transcribe",
    youtubeLanguage: env.YOUTUBE_CAPTION_LANGUAGE as LanguageCode | undefined,
    customApiEnabled: env.CUSTOM_CAPTION_API === "true",
    wsPort: env.CAPTION_WS_PORT ? Number(env.CAPTION_WS_PORT) : undefined,
  };
}

/**
 * 実プロバイダを動的に構築する (USE_FAKE_ADAPTERS=true なら呼ばない)。
 * 実 AWS SDK アダプタは遅延 import し、テスト/ローカルでは読み込まない。
 */
export async function realProvidersFromEnv(
  config: CaptionServiceConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptionRuntimeProviders> {
  const [{ TranscribeStreamingAsrAdapter }, { AmazonTranslateTranslator }, { BedrockLlmAdapter }] =
    await Promise.all([
      import("./aws/transcribe-adapter.js"),
      import("./aws/translate-adapter.js"),
      import("./aws/bedrock-adapter.js"),
    ]);
  const { S3ObjectStorage } = await import("./aws/s3-storage.js");
  const { HttpYouTubeCaptionPublisher } = await import("./sinks/youtube-publisher.js");

  const providers: CaptionRuntimeProviders = {};
  if (config.engine === "transcribe") {
    providers.asr = new TranscribeStreamingAsrAdapter(config.sourceLanguage);
    providers.translator = new AmazonTranslateTranslator();
  } else if (config.engine === "llm") {
    providers.llm = new BedrockLlmAdapter({
      modelId: env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-5-sonnet-20241022-v2:0",
    });
  }
  if (env.CAPTIONS_BUCKET_NAME) {
    providers.storage = new S3ObjectStorage(env.CAPTIONS_BUCKET_NAME);
  }
  if (config.youtubeLanguage && env.YOUTUBE_INGESTION_URL) {
    providers.youtubePublisher = new HttpYouTubeCaptionPublisher({
      ingestionUrl: env.YOUTUBE_INGESTION_URL,
      baseEpochMs: Date.now(),
    });
  }
  return providers;
}

/** USE_FAKE_ADAPTERS 用の最小フェイクプロバイダ (ローカルスモーク)。 */
async function fakeProvidersFromConfig(
  config: CaptionServiceConfig,
): Promise<CaptionRuntimeProviders> {
  const { FakeAsrAdapter, FakeTranslator, FakeLlmAdapter } = await import("./engines/fakes.js");
  if (config.engine === "llm") return { llm: new FakeLlmAdapter() };
  return { asr: new FakeAsrAdapter(config.sourceLanguage, []), translator: new FakeTranslator() };
}

/**
 * 環境変数から CaptionService を構築・起動する。字幕ワーカープロセスのエントリ。
 * 音声入力 (SFU/LiveKit) の取り込みは実結線時に AudioSource として注入する。
 */
export async function runFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  audioSource?: AudioSource,
): Promise<CaptionService> {
  const config = configFromEnv(env);
  const providers =
    env.USE_FAKE_ADAPTERS === "true"
      ? await fakeProvidersFromConfig(config)
      : await realProvidersFromEnv(config, env);
  const service = new CaptionService(config, providers, audioSource);
  await service.start();
  return service;
}
