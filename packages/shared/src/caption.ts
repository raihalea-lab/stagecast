/**
 * 字幕イベントの共通形式 (DESIGN.md 6.1)
 *
 * 字幕パイプラインの最小単位。ASR / 翻訳エンジンが生成し、字幕バスを介して
 * 各出力先 (Sink) へ配られる。エンジンと出力先の双方を差し替え可能にするための
 * 共通スキーマであり、この型に依存する限り両者は互いに独立できる。
 */

/** 対応言語コード。最低限 ja / en をサポートする (DESIGN.md F-7)。 */
export const SUPPORTED_LANGUAGES = ['ja', 'en'] as const;
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * 確定フラグ (DESIGN.md 6.1「暫定 / 確定」)。
 * - `interim`: 暫定字幕。後続の認識で書き換わる可能性がある。
 * - `final`: 確定字幕。YouTube 字幕トラックへの送出や S3 保存の対象 (6.3.1, 6.4)。
 */
export type CaptionStatus = 'interim' | 'final';

/**
 * 字幕イベント (DESIGN.md 6.1)。
 * 時刻はメディアタイムライン基準のミリ秒。
 */
export interface CaptionEvent {
  /** 開始時刻 (メディアタイムライン基準, ミリ秒)。 */
  startMs: number;
  /** 終了時刻 (メディアタイムライン基準, ミリ秒)。 */
  endMs: number;
  /** 言語コード (例: ja, en)。 */
  language: LanguageCode;
  /** 字幕テキスト。 */
  text: string;
  /** 確定フラグ (暫定 / 確定)。 */
  status: CaptionStatus;
  /** 話者・トラック識別子 (任意)。 */
  speakerId?: string;
  /** 由来するイベント (配信) の ID (任意・トレース用)。 */
  eventId?: string;
}

/** 確定済みかどうかの型ガード。確定字幕のみを扱う Sink で使用する。 */
export function isFinalCaption(c: CaptionEvent): boolean {
  return c.status === 'final';
}

/** 渡された値が対応言語コードかを判定する。 */
export function isSupportedLanguage(value: string): value is LanguageCode {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** 妥当な字幕イベントかを検証する (時刻の整合・言語・テキスト)。 */
export function isValidCaptionEvent(value: unknown): value is CaptionEvent {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.startMs === 'number' &&
    typeof c.endMs === 'number' &&
    c.endMs >= c.startMs &&
    typeof c.text === 'string' &&
    (c.status === 'interim' || c.status === 'final') &&
    typeof c.language === 'string' &&
    isSupportedLanguage(c.language)
  );
}
