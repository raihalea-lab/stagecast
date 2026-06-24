/**
 * 常用・低遅延経路エンジン: Amazon Transcribe Streaming + Amazon Translate
 * (DESIGN.md 6.2, F-7, F-8, N-2)。
 *
 * ソース言語をストリーミング ASR で認識し、各ターゲット言語へ翻訳して字幕イベントを発行する。
 * ソース言語の字幕もそのまま発行する。暫定/確定フラグは ASR の結果を引き継ぐ。
 */
import type { AudioChunk, CaptionEngine, CaptionEvent, LanguageCode } from "@stagecast/shared";
import { createLogger, withRetry, withTimeout, type RetryOptions } from "@stagecast/shared";
import type { AsrAdapter, Translator, TranscriptSegment } from "./types.js";

const log = createLogger({ component: "transcribe-engine" });

/** 翻訳 1 回のタイムアウト既定値 (ms)。固まった翻訳が pushAudio を止めるのを防ぐ (N-2)。 */
const DEFAULT_TRANSLATE_TIMEOUT_MS = 8_000;

export interface TranscribeEngineConfig {
  sourceLanguage: LanguageCode;
  targetLanguages: LanguageCode[];
  eventId?: string;
  /**
   * 翻訳呼び出しの一過性失敗に対するリトライ設定 (省略時は既定の指数バックオフ)。
   * 全リトライ失敗時はその言語をスキップし、ソース字幕と他言語は流す (翻訳は best-effort, N-2)。
   */
  translateRetry?: RetryOptions;
  /** 翻訳 1 回のタイムアウト (ms, 既定 8000)。応答しない翻訳が pushAudio を止めるのを防ぐ。0 以下で無効。 */
  translateTimeoutMs?: number;
  /** 翻訳が全リトライ失敗しその言語を諦めたときの通知 (メトリクス計測用)。 */
  onTranslateError?: (target: LanguageCode, err: unknown) => void;
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
    // 翻訳は一過性失敗をバックオフ再試行し、全滅したらその言語だけ諦める (best-effort, N-2)。
    for (const target of this.targetLanguages) {
      if (target === this.sourceLanguage) continue;
      try {
        const text = await withRetry(
          () =>
            withTimeout(
              () => this.translator.translate(segment.text, this.sourceLanguage, target),
              {
                timeoutMs: this.config.translateTimeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS,
                message: `translate to ${target} timed out`,
              },
            ),
          this.config.translateRetry,
        );
        this.emit({ ...baseEvent, language: target, text });
      } catch (err) {
        log.error("translate failed after retries", {
          target,
          ...(this.config.eventId ? { eventId: this.config.eventId } : {}),
          err,
        });
        this.config.onTranslateError?.(target, err);
      }
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
