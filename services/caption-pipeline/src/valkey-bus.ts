/**
 * 字幕バスの分散実装 (ADR 0002)。
 *
 * Valkey/Redis Streams をバックエンドに、`CaptionBus` インターフェースをそのまま実装する。
 * ストリーム名はイベント単位で名前空間化し (stagecast:{eventId}:captions)、イベント間の
 * 干渉を防ぐ (N-5)。クロスプロセス/クロスタスクで字幕を配るときに InProcessCaptionBus と
 * 差し替えて使う。プロセス内完結なら InProcessCaptionBus のままでよい。
 *
 * Valkey クライアントには直接依存せず、最小操作を CaptionStreamClient として抽象化する
 * (テストでは fake を注入)。実運用では redis/ioredis の薄いラッパを渡す。
 */
import { isValidCaptionEvent, type CaptionBus, type CaptionEvent } from '@stagecast/shared';

/** Valkey Streams の最小操作。実装は XADD / XREAD を薄くラップする。 */
export interface CaptionStreamClient {
  /** ストリームへ 1 メッセージ追記し、採番された ID を返す。 */
  xadd(stream: string, payload: string): Promise<string>;
  /**
   * `lastId` より後のメッセージを購読する (ブロッキング読み取り)。
   * メッセージごとに { id, payload } を返す。停止は signal で行う。
   */
  read(
    stream: string,
    lastId: string,
    signal: { aborted: boolean },
  ): AsyncIterable<{ id: string; payload: string }>;
}

export interface ValkeyStreamsCaptionBusOptions {
  eventId: string;
  client: CaptionStreamClient;
  /** ストリーム名 (既定: stagecast:{eventId}:captions)。 */
  streamName?: string;
}

export class ValkeyStreamsCaptionBus implements CaptionBus {
  private readonly stream: string;
  private readonly client: CaptionStreamClient;
  private readonly loops = new Map<(c: CaptionEvent) => void, { aborted: boolean }>();

  constructor(options: ValkeyStreamsCaptionBusOptions) {
    this.client = options.client;
    this.stream = options.streamName ?? `stagecast:${options.eventId}:captions`;
  }

  /** 字幕イベントをストリームへ追記する (fire-and-forget, 失敗はバスを止めない)。 */
  publish(caption: CaptionEvent): void {
    void this.client.xadd(this.stream, JSON.stringify(caption)).catch(() => {
      /* フェイルソフト: 送出失敗で配信全体を止めない */
    });
  }

  /** ストリームを購読し、各メッセージを handler に渡す。購読解除関数を返す。 */
  subscribe(handler: (caption: CaptionEvent) => void): () => void {
    const signal = { aborted: false };
    this.loops.set(handler, signal);
    void this.consume(handler, signal);
    return () => {
      signal.aborted = true;
      this.loops.delete(handler);
    };
  }

  private async consume(
    handler: (caption: CaptionEvent) => void,
    signal: { aborted: boolean },
  ): Promise<void> {
    // '$' = 接続以降の新着のみ。再接続で追いつきが要る場合は呼び出し側が ID を管理する。
    for await (const msg of this.client.read(this.stream, '$', signal)) {
      if (signal.aborted) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(msg.payload);
      } catch {
        continue;
      }
      if (isValidCaptionEvent(parsed)) {
        try {
          handler(parsed);
        } catch {
          /* Sink の例外はバスを止めない */
        }
      }
    }
  }
}
