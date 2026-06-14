/**
 * YouTube 字幕トラック Sink (DESIGN.md 6.3.1, 2.3)。
 *
 * YouTube Live はリアルタイム字幕として 1 トラックのみ受け付けるため、確定字幕を
 * 1 言語だけ送出する。暫定字幕や他言語は送らない。
 */
import type { CaptionEvent, CaptionSink, LanguageCode } from "@stagecast/shared";
import { isFinalCaption } from "@stagecast/shared";

/** YouTube の字幕取り込みエンドポイントへ POST する下位アダプタ。 */
export interface YouTubeCaptionPublisher {
  /** 確定字幕 1 件を送出する。 */
  publish(caption: CaptionEvent): Promise<void>;
}

export class YouTubeCaptionSink implements CaptionSink {
  readonly kind = "youtube";

  constructor(
    private readonly publisher: YouTubeCaptionPublisher,
    /** YouTube へ送出する 1 言語 (DESIGN.md 6.3.1)。 */
    private readonly language: LanguageCode,
  ) {}

  async start(): Promise<void> {
    /* no-op */
  }

  async deliver(caption: CaptionEvent): Promise<void> {
    // 確定字幕かつ送出言語のみを通す。
    if (!isFinalCaption(caption)) return;
    if (caption.language !== this.language) return;
    await this.publisher.publish(caption);
  }

  async stop(): Promise<void> {
    /* no-op */
  }
}

/** テスト/ローカル用フェイク。送出した確定字幕を記録する。 */
export class FakeYouTubeCaptionPublisher implements YouTubeCaptionPublisher {
  readonly published: CaptionEvent[] = [];
  async publish(caption: CaptionEvent): Promise<void> {
    this.published.push(caption);
  }
}
