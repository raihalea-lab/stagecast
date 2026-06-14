/**
 * YouTube Live 字幕送出の実装 (DESIGN.md 6.3.1, F-6)。
 *
 * YouTube Live の字幕取り込み URL へ、タイムスタンプ付きテキストを POST する。
 * 取り込み URL は配信ごとに発行され、シークレットとして扱う (ADR D-10)。
 * fetch は注入可能にし、テストでは外部接続なしに検証する。
 */
import type { CaptionEvent } from '@stagecast/shared';
import type { YouTubeCaptionPublisher } from './youtube-sink.js';

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface HttpYouTubeConfig {
  /** YouTube が発行する字幕取り込み URL。 */
  ingestionUrl: string;
  /** メディアタイムライン 0ms に対応する実時刻 (UNIX ミリ秒)。 */
  baseEpochMs: number;
  fetchFn?: FetchFn;
}

/** ミリ秒 → YouTube が要求する `YYYY-MM-DDTHH:MM:SS.mmm` 形式 (UTC)。 */
export function formatYouTubeTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('Z', '');
}

export class HttpYouTubeCaptionPublisher implements YouTubeCaptionPublisher {
  private seq = 0;
  private readonly fetchFn: FetchFn;

  constructor(private readonly config: HttpYouTubeConfig) {
    this.fetchFn = config.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  }

  /** 送出ボディ (1 行目タイムスタンプ + 本文) を構築する。 */
  buildBody(caption: CaptionEvent): string {
    const ts = formatYouTubeTimestamp(this.config.baseEpochMs + caption.startMs);
    return `${ts}\n${caption.text}\n`;
  }

  async publish(caption: CaptionEvent): Promise<void> {
    this.seq += 1;
    const sep = this.config.ingestionUrl.includes('?') ? '&' : '?';
    const url = `${this.config.ingestionUrl}${sep}seq=${this.seq}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: this.buildBody(caption),
    });
    if (!res.ok) throw new Error(`YouTube caption ingestion failed: ${res.status}`);
  }
}
