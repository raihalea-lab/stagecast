/**
 * 独自字幕配信 API Sink (DESIGN.md 6.3.2, 2.3, F-11)。
 *
 * 複数言語を同時に提供するための独自プロトコル。確定・暫定の字幕イベントを全対応言語ぶん
 * 配信する。提供範囲はプロトコル (配信エンドポイントの仕様) のみで、視聴ページや埋め込み
 * 部品は利用側が実装する。普段の YouTube 配信では使わず、イベント設定で有効化したときのみ
 * 起動する (任意起動・ゼロスケール)。
 *
 * 想定トランスポートは WebSocket / SSE。本モジュールはトランスポート非依存の
 * CaptionBroadcaster 抽象を介して配信し、メッセージスキーマ (CaptionStreamMessage) を定義する。
 */
import type { CaptionEvent, CaptionSink, LanguageCode } from '@stagecast/shared';

/**
 * 独自字幕配信プロトコルのメッセージスキーマ (v1)。
 * 利用側はこのスキーマに従って視聴ページを実装する。
 */
export interface CaptionStreamMessage {
  /** プロトコルバージョン。 */
  v: 1;
  type: 'caption';
  eventId?: string;
  language: LanguageCode;
  text: string;
  startMs: number;
  endMs: number;
  /** 確定/暫定。 */
  final: boolean;
  speakerId?: string;
}

/**
 * 接続中クライアントへメッセージをブロードキャストするトランスポート抽象。
 * 実体は WebSocket サーバ / SSE ハブ。
 */
export interface CaptionBroadcaster {
  broadcast(message: CaptionStreamMessage): Promise<void>;
}

export interface CustomCaptionApiSinkConfig {
  /** 配信対象の言語 (イベントの対応言語)。 */
  languages: LanguageCode[];
  eventId?: string;
}

export class CustomCaptionApiSink implements CaptionSink {
  readonly kind = 'custom-api';

  constructor(
    private readonly broadcaster: CaptionBroadcaster,
    private readonly config: CustomCaptionApiSinkConfig,
  ) {}

  async start(): Promise<void> {
    /* トランスポート (WS/SSE サーバ) の起動は注入側の責務。 */
  }

  async deliver(caption: CaptionEvent): Promise<void> {
    // 対応言語のみ。確定・暫定の双方を配信する (DESIGN.md 6.3.2)。
    if (!this.config.languages.includes(caption.language)) return;
    await this.broadcaster.broadcast({
      v: 1,
      type: 'caption',
      eventId: caption.eventId ?? this.config.eventId,
      language: caption.language,
      text: caption.text,
      startMs: caption.startMs,
      endMs: caption.endMs,
      final: caption.status === 'final',
      speakerId: caption.speakerId,
    });
  }

  async stop(): Promise<void> {
    /* no-op */
  }
}

/** テスト/ローカル用フェイク。配信メッセージを記録する。 */
export class FakeCaptionBroadcaster implements CaptionBroadcaster {
  readonly messages: CaptionStreamMessage[] = [];
  async broadcast(message: CaptionStreamMessage): Promise<void> {
    this.messages.push(message);
  }
}
