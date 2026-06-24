/**
 * テスト/ローカル用フェイクアダプタ (PROMPT 共通ルール)。
 * 外部接続なしに ASR・翻訳・LLM の挙動を再現する。
 */
import type { AudioChunk, LanguageCode } from "@stagecast/shared";
import type { AsrAdapter, LlmAdapter, Translator, TranscriptSegment } from "./types.js";

/**
 * 投入された音声チャンクごとに、事前に与えた台本の認識結果を返すフェイク ASR。
 * 音声 1 チャンク = 台本 1 セグメント。
 */
export class FakeAsrAdapter implements AsrAdapter {
  private handler?: (segment: TranscriptSegment) => void;
  private index = 0;

  constructor(
    readonly language: LanguageCode,
    private readonly script: TranscriptSegment[],
  ) {}

  onTranscript(handler: (segment: TranscriptSegment) => void): void {
    this.handler = handler;
  }

  async pushAudio(_chunk: AudioChunk): Promise<void> {
    const segment = this.script[this.index++];
    if (segment && this.handler) this.handler(segment);
  }

  async close(): Promise<void> {
    /* no-op */
  }
}

/** 簡易辞書 + フォールバックの疑似翻訳器。決定的でテストしやすい。 */
export class FakeTranslator implements Translator {
  constructor(private readonly dictionary: Record<string, string> = {}) {}

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    if (source === target) return text;
    return this.dictionary[`${target}:${text}`] ?? `[${target}] ${text}`;
  }
}

/** ASR+翻訳/翻訳のみ両対応のフェイク LLM。 */
export class FakeLlmAdapter implements LlmAdapter {
  private index = 0;

  constructor(
    private readonly script: TranscriptSegment[] = [],
    private readonly dictionary: Record<string, string> = {},
  ) {}

  async transcribe(_chunk: AudioChunk, _language: LanguageCode): Promise<TranscriptSegment | null> {
    return this.script[this.index++] ?? null;
  }

  async translate(text: string, source: LanguageCode, target: LanguageCode): Promise<string> {
    if (source === target) return text;
    return this.dictionary[`${target}:${text}`] ?? `<${target}> ${text}`;
  }
}
