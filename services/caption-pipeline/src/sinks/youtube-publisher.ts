/**
 * YouTube Live 字幕送出の実装 (DESIGN.md 6.3.1, F-6)。
 *
 * YouTube Live の字幕取り込み URL へ、タイムスタンプ付きテキストを POST する。
 * 取り込み URL は配信ごとに発行され、シークレットとして扱う (ADR D-10)。
 * fetch は注入可能にし、テストでは外部接続なしに検証する。
 */
import type { CaptionEvent, RetryableError } from "@stagecast/shared";
import type { YouTubeCaptionPublisher } from "./youtube-sink.js";

/**
 * YouTube 字幕取り込みの HTTP 失敗。`retryable` で再試行可否を表す (ADR 0007 D-2)。
 * 5xx / 408 / 429 は一過性とみなし再試行、その他 4xx (400/401/403 等) は恒久的とみなし即断念。
 */
export class CaptionIngestionError extends Error implements RetryableError {
  readonly retryable: boolean;
  constructor(readonly status: number) {
    super(`YouTube caption ingestion failed: ${status}`);
    this.name = "CaptionIngestionError";
    this.retryable = status >= 500 || status === 408 || status === 429;
  }
}

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
  return new Date(epochMs).toISOString().replace("Z", "");
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
    const sep = this.config.ingestionUrl.includes("?") ? "&" : "?";
    const url = `${this.config.ingestionUrl}${sep}seq=${this.seq}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: this.buildBody(caption),
    });
    if (!res.ok) throw new CaptionIngestionError(res.status);
  }
}
