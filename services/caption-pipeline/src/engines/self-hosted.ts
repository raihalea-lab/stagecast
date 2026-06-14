/**
 * 自前 ASR エンジン (DESIGN.md 6.2 拡張用, 9.1)。
 *
 * GPU 上で任意モデルを実行する将来拡張向け。本フェーズではインターフェースのみ用意し、
 * 実装は任意とする (PROMPT フェーズ5)。GPU を要するため、採用時のみ EC2 GPU を
 * 検討する (ADR D-6)。
 */
import type { AudioChunk, CaptionEngine, CaptionEvent, LanguageCode } from '@stagecast/shared';

export interface SelfHostedAsrConfig {
  sourceLanguage: LanguageCode;
  targetLanguages: LanguageCode[];
  /** 推論エンドポイント (GPU タスク) の参照。 */
  modelEndpoint: string;
  eventId?: string;
}

/**
 * 自前 ASR エンジンの拡張ポイント。共通 CaptionEngine インターフェースを満たすため、
 * 後から他エンジンと差し替え可能 (F-8)。実体は未実装。
 */
export class SelfHostedAsrEngine implements CaptionEngine {
  readonly kind = 'self-hosted-asr';
  readonly sourceLanguage: LanguageCode;
  readonly targetLanguages: LanguageCode[];
  /** 推論エンドポイント (GPU タスク)。実装時に使用する。 */
  readonly modelEndpoint: string;

  constructor(config: SelfHostedAsrConfig) {
    this.sourceLanguage = config.sourceLanguage;
    this.targetLanguages = config.targetLanguages;
    this.modelEndpoint = config.modelEndpoint;
  }

  async start(): Promise<void> {
    throw new Error('SelfHostedAsrEngine is an extension point and not yet implemented');
  }
  async pushAudio(_chunk: AudioChunk): Promise<void> {
    throw new Error('not implemented');
  }
  onCaption(_handler: (caption: CaptionEvent) => void): void {
    /* extension point */
  }
  async stop(): Promise<void> {
    /* no-op */
  }
}
