/**
 * 字幕パイプラインの差し替え可能インターフェース (DESIGN.md 6.2, 6.3)。
 *
 * エンジン (ASR/翻訳) も出力先 (Sink) も同じ「字幕イベント」を介するため、
 * 組み合わせは自由で後からの追加も容易。実装は services/caption-pipeline に置く
 * (フェーズ 5)。ここでは全層が共有する契約のみを定義する。
 */
import type { CaptionEvent, LanguageCode } from './caption.js';

/** エンジンへ入力する音声チャンク (PCM などの生データ + タイムライン基準時刻)。 */
export interface AudioChunk {
  /** 音声データ。 */
  data: Uint8Array;
  /** メディアタイムライン基準の開始時刻 (ミリ秒)。 */
  timestampMs: number;
  /** サンプリングレート (Hz)。 */
  sampleRate: number;
  /** 話者・トラック識別子 (任意)。 */
  speakerId?: string;
}

/**
 * ASR + 翻訳エンジンの共通インターフェース (DESIGN.md 6.2, F-8)。
 *
 * 音声チャンクを受け取り、暫定/確定の字幕イベントを `onCaption` で発行する。
 * Transcribe 経路・LLM 経路・自前 ASR がこれを実装する。
 */
export interface CaptionEngine {
  /** エンジン種別の識別名 (例: "transcribe", "llm")。 */
  readonly kind: string;
  /** 入力音声の言語 (ソース言語)。 */
  readonly sourceLanguage: LanguageCode;
  /** 出力する翻訳先言語の一覧。 */
  readonly targetLanguages: LanguageCode[];
  /** エンジンを開始する (ストリーム確立など)。 */
  start(): Promise<void>;
  /** 音声チャンクを投入する。 */
  pushAudio(chunk: AudioChunk): Promise<void>;
  /** 字幕イベント発行時のハンドラを登録する。 */
  onCaption(handler: (caption: CaptionEvent) => void): void;
  /** エンジンを停止し、リソースを解放する。 */
  stop(): Promise<void>;
}

/**
 * 字幕出力先 (Sink) の共通インターフェース (DESIGN.md 6.3, F-8)。
 *
 * 字幕バスを購読し、特定の宛先へ字幕を送る。YouTubeCaptionSink (1言語・確定) と
 * CustomCaptionApiSink (多言語・任意起動) がこれを実装する。
 */
export interface CaptionSink {
  /** Sink 種別の識別名 (例: "youtube", "custom-api")。 */
  readonly kind: string;
  /** Sink を開始する。 */
  start(): Promise<void>;
  /** 字幕イベントを 1 件配信する。 */
  deliver(caption: CaptionEvent): Promise<void>;
  /** Sink を停止する。 */
  stop(): Promise<void>;
}

/**
 * 字幕バス (DESIGN.md 6 章「字幕バス」)。
 *
 * エンジンが生成した字幕イベントを集約し、購読する各 Sink へ配る内部経路。
 * フェーズ 5 でプロセス内実装を提供し、将来は分散基盤に差し替え可能 (ADR D-8)。
 */
export interface CaptionBus {
  /** 字幕イベントを発行する (エンジン側が呼ぶ)。 */
  publish(caption: CaptionEvent): void;
  /** 字幕イベントを購読する (Sink 側が呼ぶ)。購読解除関数を返す。 */
  subscribe(handler: (caption: CaptionEvent) => void): () => void;
}
