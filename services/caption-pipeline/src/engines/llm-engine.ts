/**
 * 品質重視経路エンジン: LLM (Bedrock 等) 経由の ASR+翻訳 / 翻訳のみ
 * (DESIGN.md 6.2 品質重視経路, F-8)。
 *
 * 文脈を考慮した高品質な翻訳が可能だが遅延は増えやすいため、独自字幕 API の一部言語など
 * 品質を優先したい経路に割り当てる (DESIGN.md 6.2 末尾)。
 *
 * 2 つのモードを持つ:
 *  - 'asr+translate': 音声を LLM で文字起こしし、各言語へ翻訳する。
 *  - 'translate-only': 別の ASR が出した確定テキストを高品質翻訳する用途
 *    (pushText で投入)。
 */
import type { AudioChunk, CaptionEngine, CaptionEvent, LanguageCode } from "@stagecast/shared";
import type { LlmAdapter } from "./types.js";

export interface LlmEngineConfig {
  sourceLanguage: LanguageCode;
  targetLanguages: LanguageCode[];
  mode: "asr+translate" | "translate-only";
  eventId?: string;
}

export class LLMEngine implements CaptionEngine {
  readonly kind = "llm";
  readonly sourceLanguage: LanguageCode;
  readonly targetLanguages: LanguageCode[];
  private readonly handlers: ((c: CaptionEvent) => void)[] = [];

  constructor(
    private readonly llm: LlmAdapter,
    private readonly config: LlmEngineConfig,
  ) {
    this.sourceLanguage = config.sourceLanguage;
    this.targetLanguages = config.targetLanguages;
  }

  async start(): Promise<void> {
    /* LLM 経路はリクエスト単位のため事前確立は不要。 */
  }

  private emit(caption: CaptionEvent): void {
    for (const h of this.handlers) h(caption);
  }

  private async fanOut(
    text: string,
    startMs: number,
    endMs: number,
    isFinal: boolean,
    speakerId?: string,
  ): Promise<void> {
    const base = {
      startMs,
      endMs,
      status: (isFinal ? "final" : "interim") as CaptionEvent["status"],
      speakerId,
      eventId: this.config.eventId,
    };
    this.emit({ ...base, language: this.sourceLanguage, text });
    for (const target of this.targetLanguages) {
      if (target === this.sourceLanguage) continue;
      const translated = await this.llm.translate(text, this.sourceLanguage, target);
      this.emit({ ...base, language: target, text: translated });
    }
  }

  async pushAudio(chunk: AudioChunk): Promise<void> {
    if (this.config.mode !== "asr+translate" || !this.llm.transcribe) return;
    const segment = await this.llm.transcribe(chunk, this.sourceLanguage);
    if (!segment) return;
    await this.fanOut(
      segment.text,
      segment.startMs,
      segment.endMs,
      segment.isFinal,
      segment.speakerId,
    );
  }

  /** 翻訳のみモード: 確定済みのソーステキストを高品質翻訳する。 */
  async pushText(input: {
    text: string;
    startMs: number;
    endMs: number;
    isFinal: boolean;
    speakerId?: string;
  }): Promise<void> {
    await this.fanOut(input.text, input.startMs, input.endMs, input.isFinal, input.speakerId);
  }

  onCaption(handler: (caption: CaptionEvent) => void): void {
    this.handlers.push(handler);
  }

  async stop(): Promise<void> {
    /* no-op */
  }
}
