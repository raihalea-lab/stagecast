/**
 * エンジン層が依存する下位アダプタのインターフェース (DESIGN.md 6.2)。
 *
 * ASR・翻訳・LLM の具体実装 (Amazon Transcribe / Translate / Bedrock 等) はこれらの
 * アダプタとして注入する。テストでは外部接続なしのフェイクを注入する (PROMPT 共通ルール)。
 */
import type { AudioChunk, LanguageCode } from "@stagecast/shared";

/** ASR が出力する 1 区間の認識結果。 */
export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  /** 暫定/確定 (DESIGN.md 6.1)。 */
  isFinal: boolean;
  speakerId?: string;
}

/**
 * ストリーミング ASR アダプタ。音声チャンクを投入すると認識結果を逐次返す。
 * 実体は Amazon Transcribe Streaming など (DESIGN.md 6.2 常用・低遅延経路)。
 */
export interface AsrAdapter {
  readonly language: LanguageCode;
  onTranscript(handler: (segment: TranscriptSegment) => void): void;
  pushAudio(chunk: AudioChunk): Promise<void>;
  close(): Promise<void>;
}

/** テキスト翻訳アダプタ。実体は Amazon Translate など。 */
export interface Translator {
  translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string>;
}

/**
 * LLM アダプタ (DESIGN.md 6.2 品質重視経路)。ASR+翻訳、または翻訳のみを担う。
 * 実体は Amazon Bedrock など。
 */
export interface LlmAdapter {
  /** 音声 → ソース言語テキスト (ASR)。翻訳のみ用途では未使用。 */
  transcribe?(chunk: AudioChunk, language: LanguageCode): Promise<TranscriptSegment | null>;
  /** 文脈を考慮した翻訳。 */
  translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string>;
}
