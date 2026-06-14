/**
 * 常用・低遅延経路エンジン: Amazon Transcribe Streaming + Amazon Translate
 * (DESIGN.md 6.2, F-7, F-8, N-2)。
 *
 * ソース言語をストリーミング ASR で認識し、各ターゲット言語へ翻訳して字幕イベントを発行する。
 * ソース言語の字幕もそのまま発行する。暫定/確定フラグは ASR の結果を引き継ぐ。
 */
import type { AudioChunk, CaptionEngine, CaptionEvent, LanguageCode } from "@stagecast/shared";
import type { AsrAdapter, Translator, TranscriptSegment } from "./types.js";

export interface TranscribeEngineConfig {
  sourceLanguage: LanguageCode;
  targetLanguages: LanguageCode[];
  eventId?: string;
}

export class TranscribeStreamingEngine implements CaptionEngine {
  readonly kind = "transcribe";
  readonly sourceLanguage: LanguageCode;
  readonly targetLanguages: LanguageCode[];
  private readonly handlers: ((c: CaptionEvent) => void)[] = [];
  /** ASR コールバックで開始した翻訳処理。pushAudio で待ち合わせて順序と完了を保証する。 */
  private pending: Promise<void>[] = [];

  constructor(
    private readonly asr: AsrAdapter,
    private readonly translator: Translator,
    private readonly config: TranscribeEngineConfig,
  ) {
    this.sourceLanguage = config.sourceLanguage;
    this.targetLanguages = config.targetLanguages;
  }

  async start(): Promise<void> {
    this.asr.onTranscript((segment) => {
      this.pending.push(this.handleSegment(segment));
    });
  }

  private emit(caption: CaptionEvent): void {
    for (const h of this.handlers) h(caption);
  }

  private async handleSegment(segment: TranscriptSegment): Promise<void> {
    const baseEvent: Omit<CaptionEvent, "language" | "text"> = {
      startMs: segment.startMs,
      endMs: segment.endMs,
      status: segment.isFinal ? "final" : "interim",
      speakerId: segment.speakerId,
      eventId: this.config.eventId,
    };

    // ソース言語の字幕。
    this.emit({ ...baseEvent, language: this.sourceLanguage, text: segment.text });

    // ターゲット言語へ翻訳して発行 (ソース言語と同一はスキップ)。
    for (const target of this.targetLanguages) {
      if (target === this.sourceLanguage) continue;
      const text = await this.translator.translate(segment.text, this.sourceLanguage, target);
      this.emit({ ...baseEvent, language: target, text });
    }
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    await this.asr.pushAudio(chunk);
    // ASR コールバックで積まれた翻訳・発行を待ち合わせる (テスト/順序の決定性)。
    const pending = this.pending;
    this.pending = [];
    await Promise.all(pending);
  }

  onCaption(handler: (caption: CaptionEvent) => void): void {
    this.handlers.push(handler);
  }

  async stop(): Promise<void> {
    await this.asr.close();
  }
}
