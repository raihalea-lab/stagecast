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
import { createLogger, withRetry, withTimeout, type RetryOptions } from "@stagecast/shared";
import type { TranslationContextProvider } from "../materials-context.js";
import { buildTranslationContext, RecentUtterances } from "../translation-prompt.js";
import type { LlmAdapter } from "./types.js";

const log = createLogger({ component: "llm-engine" });

/** 翻訳 1 回のタイムアウト既定値 (ms)。品質重視の LLM 経路は遅めなので余裕をとる (N-2)。 */
const DEFAULT_TRANSLATE_TIMEOUT_MS = 20_000;

export interface LlmEngineConfig {
  sourceLanguage: LanguageCode;
  targetLanguages: LanguageCode[];
  mode: "asr+translate" | "translate-only";
  eventId?: string;
  /**
   * 翻訳呼び出しの一過性失敗に対するリトライ設定 (省略時は既定の指数バックオフ)。
   * 全リトライ失敗時はその言語をスキップし、ソース字幕と他言語は流す (翻訳は best-effort, N-2)。
   */
  translateRetry?: RetryOptions;
  /** 翻訳 1 回のタイムアウト (ms, 既定 20000)。応答しない翻訳が pushAudio を止めるのを防ぐ。0 以下で無効。 */
  translateTimeoutMs?: number;
  /** 翻訳が全リトライ失敗しその言語を諦めたときの通知 (メトリクス計測用)。 */
  onTranslateError?: (target: LanguageCode, err: unknown) => void;
  /**
   * 登壇資料の本文を返す供給源 (ADR 0021 D-3)。未指定なら文脈なしで訳す。
   * 資料は配信中に追加されうるので、発話のたびに読み直す。
   */
  materials?: TranslationContextProvider;
}

export class LLMEngine implements CaptionEngine {
  readonly kind = "llm";
  readonly sourceLanguage: LanguageCode;
  readonly targetLanguages: LanguageCode[];
  private readonly handlers: ((c: CaptionEvent) => void)[] = [];
  /** 直前の発話 (ADR 0021 D-4)。確定した発話だけを積む。 */
  private readonly recent = new RecentUtterances();

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
    // 文脈は全言語で同じものを使う (ADR 0021 D-3)。プロンプトの固定部分が言語ごとに
    // 変わると prompt caching が効かない。
    const context = buildTranslationContext(
      this.config.materials?.current(),
      this.recent.snapshot(),
    );
    // 翻訳は一過性失敗をバックオフ再試行し、全滅したらその言語だけ諦める (best-effort, N-2)。
    for (const target of this.targetLanguages) {
      if (target === this.sourceLanguage) continue;
      try {
        const translated = await withRetry(
          () =>
            withTimeout(() => this.llm.translate(text, this.sourceLanguage, target, context), {
              timeoutMs: this.config.translateTimeoutMs ?? DEFAULT_TRANSLATE_TIMEOUT_MS,
              message: `llm translate to ${target} timed out`,
            }),
          this.config.translateRetry,
        );
        this.emit({ ...base, language: target, text: translated });
      } catch (err) {
        log.error("llm translate failed after retries", {
          target,
          ...(this.config.eventId ? { eventId: this.config.eventId } : {}),
          err,
        });
        this.config.onTranslateError?.(target, err);
      }
    }
    // 確定した発話だけを履歴に積む (interim は言い直しで揺れるため)。
    if (isFinal) this.recent.push(text);
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
