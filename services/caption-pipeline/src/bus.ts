/**
 * 字幕バス (DESIGN.md 6 章)。
 *
 * 各エンジンが生成した字幕イベントを共通形式で受け取り、購読する各出力先 (Sink) へ配る
 * 内部メッセージ経路。エンジンと Sink は本バスのみを介するため互いに独立して差し替えられる。
 *
 * ここではプロセス内実装を提供する (ADR D-8)。将来クロスサービス化する場合は、同じ
 * CaptionBus インターフェースのまま Kinesis / Redis Streams 等の実装へ差し替える。
 */
import type { CaptionBus, CaptionEvent } from '@stagecast/shared';

export class InProcessCaptionBus implements CaptionBus {
  private readonly handlers = new Set<(caption: CaptionEvent) => void>();

  publish(caption: CaptionEvent): void {
    // 1 つの Sink で例外が出ても他へ配信が止まらないよう個別に隔離する。
    for (const handler of this.handlers) {
      try {
        handler(caption);
      } catch {
        // Sink 側のエラーはバスを止めない (フェイルソフト)。
      }
    }
  }

  subscribe(handler: (caption: CaptionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  get subscriberCount(): number {
    return this.handlers.size;
  }
}
